import 'server-only'
import sharp from 'sharp'
import { supabase, STORAGE_BUCKET } from './supabase'
import { createJob, setPartRoute, ensurePartQrToken, setStageDoneQty } from './db'
import { fallbackDueDate } from './gemini'
import { TRACKING_STAGES, stageLabel, type Stage, type StageStatus } from './data'
import type { PacketExtract } from './packet-extract'
import { proxiedKeyUrl } from './storage-url'

// Packet ingestion + 报工 event data layer. All NEW tables (0083) are owned
// here; writes to the EXISTING job/part/stage tables go through lib/db.ts's
// exported functions only (createJob / setPartRoute / ensurePartQrToken) so
// the fork's invariants — 检验+出货 always in route, cascade machine, board
// rollup triggers — keep holding without this file knowing about them.

// The six OP-capable stage keys, in route order. DB keys stay the parent
// vocabulary (编程/操机/…) and render as OP1..OP6 via stageLabel — a packet
// with 加工次数 n seeds the first n keys. 丝印 renders as optional 铣床;
// 检验 and 出货 ride along via resolvePartStages inside setPartRoute.
const OP_KEYS: Stage[] = TRACKING_STAGES.filter(
  (s) => s !== '丝印' && s !== '检验',
)

function rid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
}

function missingJobPhotosTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  return (
    error.code === '42P01' ||
    error.code === 'PGRST205' ||
    Boolean(error.message?.includes('job_photos'))
  )
}

function componentIdOf(jobId: string, partId: string): string {
  return partId.startsWith(`${jobId}:`) ? partId.slice(jobId.length + 1) : partId
}

// ---------- storage ----------

export function packetPageKey(packetId: string, idx: number, ext = 'jpg'): string {
  return `packets/${packetId}/p${idx}.${ext}`
}

function safeStorageSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_')
}

export function jobPhotoKey(jobId: string, photoId: string): string {
  return `${safeStorageSegment(jobId)}/match-photos/${safeStorageSegment(photoId)}.jpg`
}

export async function uploadPacketPageImage(
  key: string,
  bytes: Uint8Array | ArrayBuffer,
  contentType: string,
): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(key, bytes, { contentType, upsert: true })
  if (error) throw error
}

export async function packetPageSignedUrl(key: string, expiresIn = 600): Promise<string | undefined> {
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(key, expiresIn)
  if (error) return undefined
  return data?.signedUrl
}

export async function downloadPacketPage(key: string): Promise<Blob | undefined> {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(key)
  if (error) return undefined
  return data ?? undefined
}

export type JobPhotoRow = {
  id: string
  jobId: string
  partId: string
  storageKey: string
  uploadedBy?: string
  registered: boolean
  createdAt?: string
}

function toJobPhoto(r: Record<string, unknown>): JobPhotoRow {
  return {
    id: String(r.id),
    jobId: String(r.job_id),
    partId: String(r.part_id),
    storageKey: String(r.storage_key),
    uploadedBy: (r.uploaded_by as string | null) ?? undefined,
    registered: Boolean(r.registered),
    createdAt: (r.created_at as string | null) ?? undefined,
  }
}

/**
 * Add an editor-supplied photo to an existing job. The caller supplies the
 * selected part so matcher hits keep resolving to the same /s token and job.
 */
export async function createJobPhoto(input: {
  jobId: string
  partId: string
  bytes: Uint8Array
  contentType: string
  uploadedBy: string
}): Promise<JobPhotoRow> {
  const { data: part, error: partError } = await supabase
    .from('parts')
    .select('id, job_id')
    .eq('id', input.partId)
    .eq('job_id', input.jobId)
    .maybeSingle()
  if (partError) throw partError
  if (!part) throw new Error('工单或零件不存在')

  const id = rid('jph')
  const storageKey = jobPhotoKey(input.jobId, id)
  await uploadPacketPageImage(storageKey, input.bytes, input.contentType)

  const row = {
    id,
    job_id: input.jobId,
    part_id: input.partId,
    storage_key: storageKey,
    uploaded_by: input.uploadedBy,
    registered: false,
  }
  const { data, error } = await supabase.from('job_photos').insert(row).select('*').single()
  if (error) {
    await supabase.storage.from(STORAGE_BUCKET).remove([storageKey])
    throw error
  }
  return toJobPhoto(data as Record<string, unknown>)
}

// Remove a user-added 匹配照片. Storage object first (best-effort — an orphaned
// object is harmless), then the row. Packet pages have no delete path: they are
// the immutable intake record. Returns the owning job/part for revalidation.
export async function deleteJobPhoto(
  photoId: string,
): Promise<{ jobId: string; partId: string } | null> {
  const { data, error } = await supabase
    .from('job_photos')
    .select('id, job_id, part_id, storage_key')
    .eq('id', photoId)
    .maybeSingle()
  if (error) throw error
  if (!data) return null

  await supabase.storage.from(STORAGE_BUCKET).remove([String(data.storage_key)])
  const { error: deleteError } = await supabase
    .from('job_photos')
    .delete()
    .eq('id', photoId)
  if (deleteError) throw deleteError
  return { jobId: String(data.job_id), partId: String(data.part_id) }
}

// Rotate a 匹配照片 by a quarter turn (positive = clockwise) and re-encode it in
// place. Bumps updated_at so proxiedKeyUrl's ?v= moves off the immutable cache.
// Returns the fresh bytes so the caller can re-enroll the matcher on the
// corrected orientation.
export async function rotateJobPhoto(
  photoId: string,
  quarterTurns: number,
): Promise<{
  jobId: string
  partId: string
  bytes: Uint8Array
  contentType: string
} | null> {
  const { data, error } = await supabase
    .from('job_photos')
    .select('id, job_id, part_id, storage_key')
    .eq('id', photoId)
    .maybeSingle()
  if (error) throw error
  if (!data) return null

  const storageKey = String(data.storage_key)
  const blob = await downloadPacketPage(storageKey)
  if (!blob) throw new Error('照片文件不存在')

  const angle = ((((quarterTurns % 4) + 4) % 4) * 90)
  const input = Buffer.from(await blob.arrayBuffer())
  const rotated = await sharp(input).rotate(angle).jpeg({ quality: 88 }).toBuffer()
  const bytes = new Uint8Array(rotated)

  await uploadPacketPageImage(storageKey, bytes, 'image/jpeg')
  const { error: updateError } = await supabase
    .from('job_photos')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', photoId)
  if (updateError) throw updateError

  return {
    jobId: String(data.job_id),
    partId: String(data.part_id),
    bytes,
    contentType: 'image/jpeg',
  }
}

// ---------- packet → component ----------

export type PacketComponentResult = {
  jobId: string
  partId: string
  componentId: string
  jobNo: string
  packetId: string
  pageIds: string[]
  token?: string
  /** true when the packet attached to a pre-existing part (order-entry girl
   *  imported the customer Excel first) instead of creating a new one. */
  attached: boolean
}

// One photographed packet = one component. If an active part with the same
// 货号 already exists and has no packet yet, the packet ATTACHES to it (the
// clerk-import flow created it first); otherwise a fresh single-part job is
// minted. Either way the part ends with: OP route sized to the packet's
// 加工次数, drawing_no recorded, a QR token, and the pages indexed for the
// matcher.
export async function createComponentFromPacket(input: {
  extract: PacketExtract
  pageKeys: string[]
  packetId: string
  createdBy: string
  completedStage?: Stage
}): Promise<PacketComponentResult> {
  const { extract, pageKeys, packetId, createdBy, completedStage } = input

  let jobId: string | undefined
  let partId: string | undefined
  let jobNo = ''
  let attached = false

  if (extract.partNo) {
    // Attach path: same 货号, job still open, no packet claimed yet.
    const { data: candidates, error } = await supabase
      .from('parts')
      .select('id, job_id, name, drawing_no')
      .eq('part_no', extract.partNo)
    if (error) throw error
    if (candidates && candidates.length > 0) {
      const jobIds = [...new Set(candidates.map((c) => c.job_id as string))]
      const { data: jobRows, error: jerr } = await supabase
        .from('jobs')
        .select('id, job_no, status')
        .in('id', jobIds)
        .in('status', ['draft', 'ready'])
      if (jerr) throw jerr
      const openJobs = new Map((jobRows ?? []).map((j) => [j.id as string, j]))
      const openParts = candidates.filter((c) => openJobs.has(c.job_id as string))
      if (openParts.length > 0) {
        const { data: claimed, error: perr } = await supabase
          .from('packets')
          .select('part_id')
          .in('part_id', openParts.map((c) => c.id as string))
        if (perr) throw perr
        const claimedSet = new Set((claimed ?? []).map((r) => r.part_id as string))
        const free = openParts.find((c) => !claimedSet.has(c.id as string))
        if (free) {
          partId = free.id as string
          jobId = free.job_id as string
          jobNo = String(openJobs.get(jobId)?.job_no ?? '')
          attached = true
        }
      }
    }
  }

  if (!jobId || !partId) {
    // No invented work ids — the part's own identity (货号, else 图纸号) IS
    // the reference everyone already uses on paper and in the customer Excel.
    jobNo = extract.partNo ?? extract.drawingNo ?? extract.name
    // Repeat orders overlap: the same 货号/图纸 can be in production twice at
    // once (two physical packets, two batches). The matcher tells the SHEETS
    // apart, but the humans need the CARDS told apart too — the second
    // concurrent batch gets a -B/-C suffix on the board identity.
    const [dupEq, dupLike] = await Promise.all([
      supabase.from('jobs').select('id').eq('job_no', jobNo).in('status', ['draft', 'ready']),
      supabase.from('jobs').select('id').like('job_no', `${jobNo}-_`).in('status', ['draft', 'ready']),
    ])
    const concurrent = (dupEq.data?.length ?? 0) + (dupLike.data?.length ?? 0)
    if (concurrent > 0) {
      jobNo = `${jobNo}-${String.fromCharCode(65 + Math.min(concurrent, 24))}` // -B, -C, …
    }
    const job = await createJob({
      jobNo,
      customer: extract.customer ?? '禾牧',
      product: extract.name,
      // jobs.due_date is a NOT NULL date column — '' is a Postgres error
      // (22007), which used to kill the whole 录入 whenever the stamp had no
      // legible 交货期. Same today+15 estimate as the xlsx path; the PMC
      // corrects it on the editable card.
      dueDate: extract.dueDate ?? fallbackDueDate(),
      notes: extract.notes,
      sourceFile: '拍照录入',
      components: [
        {
          name: extract.name,
          qty: extract.qty,
          material: extract.material,
          partNo: extract.partNo,
        },
      ],
    })
    jobId = job.id
    partId = `${jobId}:p1`
  }

  const componentId = componentIdOf(jobId, partId)

  // Route sized to the packet's 加工次数. Mobile review explicitly decides
  // whether optional 铣床 is present; resolvePartStages force-adds 检验+出货.
  const ops = OP_KEYS.slice(0, Math.max(1, Math.min(OP_KEYS.length, extract.opCount)))
  const route = extract.includeMilling === false ? ops : [...ops, '丝印' as Stage]
  await setPartRoute(jobId, componentId, route, { force: true })

  // The review screen is the user's final word. Persist every editable part
  // field even on the attach path, where an earlier Excel import may already
  // have created the part before the physical packet reaches programming.
  const { error: partErr } = await supabase
    .from('parts')
    .update({
      name: extract.name,
      qty: extract.qty,
      material: extract.material ?? null,
      part_no: extract.partNo ?? null,
      drawing_no: extract.drawingNo ?? null,
    })
    .eq('id', partId)
  if (partErr) throw partErr

  if (attached) {
    const jobUpdate: Record<string, unknown> = {
      due_date: extract.dueDate ?? fallbackDueDate(),
    }
    if (extract.customer) jobUpdate.customer = extract.customer
    if (extract.notes) jobUpdate.notes = extract.notes
    const { error } = await supabase.from('jobs').update(jobUpdate).eq('id', jobId)
    if (error) throw error
  }

  // Photo-created jobs go straight onto the board — there is no draft-review
  // step in the programmer's flow (he shoots and walks away).
  if (!attached) {
    const { error } = await supabase
      .from('jobs')
      .update({ status: 'ready' })
      .eq('id', jobId)
    if (error) throw error
  }

  // Intake can happen after work has already moved through the shop. Marking
  // the latest checked stage complete uses the normal cascade, so every routed
  // stage before it is stamped done and the next stage is immediately live.
  if (completedStage) {
    await setStageDoneQty(
      jobId,
      componentId,
      completedStage,
      Number.MAX_SAFE_INTEGER,
      createdBy,
    )
  }

  const { error: pkErr } = await supabase.from('packets').insert({
    id: packetId,
    part_id: partId,
    created_by: createdBy,
    op_count: extract.opCount,
    extract: extract as unknown as Record<string, unknown>,
  })
  if (pkErr) throw pkErr

  const pageIds: string[] = []
  const pageRows = pageKeys.map((key, i) => {
    const info = extract.pages.find((p) => p.index === i)
    const id = rid('pg')
    pageIds.push(id)
    return {
      id,
      packet_id: packetId,
      part_id: partId,
      idx: i,
      kind: info?.kind ?? 'other',
      op_no: info?.opNo ?? null,
      storage_key: key,
      registered: false,
    }
  })
  if (pageRows.length > 0) {
    const { error } = await supabase.from('packet_pages').insert(pageRows)
    if (error) throw error
  }

  const token = await ensurePartQrToken(jobId, componentId)
  return { jobId, partId, componentId, jobNo, packetId, pageIds, token, attached }
}

// ---------- part ↔ token ----------

export async function tokenForPartId(partId: string): Promise<string | undefined> {
  const { data, error } = await supabase
    .from('parts')
    .select('id, job_id, qr_token')
    .eq('id', partId)
    .limit(1)
  if (error || !data || data.length === 0) return undefined
  const row = data[0]
  const existing = (row.qr_token as string | null) ?? undefined
  if (existing) return existing
  const jobId = row.job_id as string
  return ensurePartQrToken(jobId, componentIdOf(jobId, partId))
}

export type PartFacts = {
  partId: string
  jobId: string
  name: string
  partNo?: string
  drawingNo?: string
  qty: number
  dueDate?: string
  customer?: string
}

export async function partFacts(partIds: string[]): Promise<PartFacts[]> {
  if (partIds.length === 0) return []
  const { data, error } = await supabase
    .from('parts')
    .select('id, job_id, name, qty, part_no, drawing_no')
    .in('id', partIds)
  if (error) throw error
  const jobIds = [...new Set((data ?? []).map((r) => r.job_id as string))]
  const { data: jobs, error: jerr } = await supabase
    .from('jobs')
    .select('id, customer, due_date')
    .in('id', jobIds)
  if (jerr) throw jerr
  const jobById = new Map((jobs ?? []).map((j) => [j.id as string, j]))
  return (data ?? []).map((r) => {
    const j = jobById.get(r.job_id as string)
    return {
      partId: r.id as string,
      jobId: r.job_id as string,
      name: (r.name as string | null) ?? '',
      partNo: (r.part_no as string | null) ?? undefined,
      drawingNo: (r.drawing_no as string | null) ?? undefined,
      qty: Number(r.qty ?? 0),
      dueDate: (j?.due_date as string | null) ?? undefined,
      customer: (j?.customer as string | null) ?? undefined,
    }
  })
}

// Look active parts up by identity fields (OCR fallback path). OCR of a
// phone photo routinely drops a digit group or a dot from a long drawing
// number ("…04.01.09.021" for "…04.01.01.09.021"), so exact/prefix matching
// is not enough: normalize both sides to bare alphanumerics and allow a
// small edit distance. The live bank is a few hundred open parts — fetching
// them all and scoring in-process is cheaper than being clever in SQL.

function normalizeId(s: string): string {
  return s.replace(/[^0-9a-z]/gi, '').toUpperCase()
}

function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1
  const prev = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]
    prev[0] = i
    let rowMin = prev[0]
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      diag = tmp
      if (prev[j] < rowMin) rowMin = prev[j]
    }
    if (rowMin > cap) return cap + 1
  }
  return prev[b.length]
}

export async function findActivePartsByIdentity(read: {
  partNo?: string
  drawingNo?: string
}): Promise<PartFacts[]> {
  const { data: jobs } = await supabase
    .from('jobs')
    .select('id')
    .in('status', ['ready', 'draft'])
  const openJobs = (jobs ?? []).map((j) => j.id as string)
  if (openJobs.length === 0) return []
  const { data: parts } = await supabase
    .from('parts')
    .select('id, job_id, part_no, drawing_no')
    .in('job_id', openJobs)

  // Generic part labels ("A板" → "A" after normalization) carry no identity;
  // a 1–2 char query would ride the prefix rule onto unrelated numbers.
  const usable = (s: string) => (s.length >= 3 ? s : '')
  const qPart = usable(read.partNo ? normalizeId(read.partNo) : '')
  // Version suffix (-VA.1) is often cropped/misread — compare without it.
  const qDraw = usable(
    read.drawingNo ? normalizeId(read.drawingNo.replace(/-?VA\.?\d*$/i, '')) : '',
  )

  const scored: { id: string; score: number }[] = []
  for (const p of parts ?? []) {
    const pn = p.part_no ? normalizeId(p.part_no as string) : ''
    const dn = p.drawing_no
      ? normalizeId((p.drawing_no as string).replace(/-?VA\.?\d*$/i, ''))
      : ''
    let score = 0
    if (qPart && pn) {
      if (pn === qPart) score = 100
      else if (editDistance(pn, qPart, 1) <= 1) score = 80
    }
    if (score < 100 && qDraw && dn) {
      if (dn === qDraw) score = Math.max(score, 95)
      else {
        // Tolerance scales with length: long BSZ numbers absorb a dropped
        // digit-group; short ids stay strict.
        const cap = Math.max(1, Math.floor(Math.max(dn.length, qDraw.length) / 8))
        const d = editDistance(dn, qDraw, cap + 2)
        if (d <= cap) score = Math.max(score, 90 - d * 5)
        else if (dn.startsWith(qDraw) || qDraw.startsWith(dn)) score = Math.max(score, 70)
      }
    }
    // Cross-field, exact only: a 程序单's 模具编号 (read as partNo) is often
    // what 录入 stored as drawing_no (e.g. 10092658), and vice versa.
    if (score < 95 && qPart && dn && dn === qPart) score = Math.max(score, 95)
    if (score < 95 && qDraw && pn && pn === qDraw) score = Math.max(score, 95)
    if (score > 0) scored.push({ id: p.id as string, score })
  }
  if (scored.length === 0) return []
  scored.sort((a, b) => b.score - a.score)
  // Keep everything within one tier of the best — repeat orders of the same
  // drawing all tie at the top and surface as an ambiguous picker. But an
  // exact identity hit outranks fuzzy near-misses entirely: sibling drawings
  // legitimately differ by one digit (BSZ4550.07.003 vs .023), so a fuzzy
  // candidate next to an exact one is a different part, not an OCR variant.
  const best = scored[0].score
  const band = best >= 95 ? 0 : 10
  const keep = scored.filter((s) => best - s.score <= band).slice(0, 4)
  const facts = await partFacts(keep.map((s) => s.id))
  const rank = new Map(keep.map((s, i) => [s.id, i]))
  return facts.sort(
    (a, b) => (rank.get(a.partId) ?? keep.length) - (rank.get(b.partId) ?? keep.length),
  )
}

// ---------- packet pages (registration sweep) ----------

export type PacketPageRow = {
  id: string
  packetId: string
  partId: string
  idx: number
  kind?: string
  opNo?: number
  storageKey: string
  registered: boolean
  source: 'packet' | 'job_photo'
  createdAt?: string
}

function toPage(r: Record<string, unknown>): PacketPageRow {
  return {
    id: r.id as string,
    packetId: r.packet_id as string,
    partId: r.part_id as string,
    idx: Number(r.idx ?? 0),
    kind: (r.kind as string | null) ?? undefined,
    opNo: r.op_no != null ? Number(r.op_no) : undefined,
    storageKey: r.storage_key as string,
    registered: Boolean(r.registered),
    source: 'packet',
    createdAt: (r.created_at as string | null) ?? undefined,
  }
}

export async function listUnregisteredPages(limit = 50): Promise<PacketPageRow[]> {
  const [packetResult, photoResult] = await Promise.all([
    supabase
      .from('packet_pages')
      .select('*')
      .eq('registered', false)
      .order('created_at', { ascending: true })
      .limit(limit),
    supabase
      .from('job_photos')
      .select('*')
      .eq('registered', false)
      .order('created_at', { ascending: true })
      .limit(limit),
  ])
  if (packetResult.error) throw packetResult.error
  if (photoResult.error && !missingJobPhotosTable(photoResult.error)) {
    throw photoResult.error
  }
  const packetPages = (packetResult.data ?? []).map(toPage)
  const jobPhotos: PacketPageRow[] = (photoResult.data ?? []).map((row) => ({
    id: String(row.id),
    packetId: '',
    partId: String(row.part_id),
    idx: 0,
    kind: 'other',
    storageKey: String(row.storage_key),
    registered: Boolean(row.registered),
    source: 'job_photo',
    createdAt: (row.created_at as string | null) ?? undefined,
  }))
  return [...packetPages, ...jobPhotos]
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
    .slice(0, limit)
}

export async function markPageRegistered(
  pageId: string,
  source: PacketPageRow['source'] = 'packet',
): Promise<void> {
  const { error } = await supabase
    .from(source === 'job_photo' ? 'job_photos' : 'packet_pages')
    .update({ registered: true })
    .eq('id', pageId)
  if (error) throw error
}

export async function listPagesForPart(partId: string): Promise<PacketPageRow[]> {
  const { data, error } = await supabase
    .from('packet_pages')
    .select('*')
    .eq('part_id', partId)
    .order('idx', { ascending: true })
  if (error) throw error
  return (data ?? []).map(toPage)
}

// ---------- 报工 events ----------

export type ReportEvent = {
  id: number
  partId: string
  jobId: string
  stage: Stage
  stageLabel: string
  actor: string
  qty: number
  cumulative: number
  source: string
  createdAt: string
}

function toEvent(r: Record<string, unknown>): ReportEvent {
  const stage = r.stage as Stage
  return {
    id: Number(r.id),
    partId: r.part_id as string,
    jobId: r.job_id as string,
    stage,
    stageLabel: stageLabel(stage),
    actor: r.actor as string,
    qty: Number(r.qty ?? 0),
    cumulative: Number(r.cumulative ?? 0),
    source: (r.source as string | null) ?? 'scan',
    createdAt: r.created_at as string,
  }
}

export async function logReportEvent(ev: {
  partId: string
  jobId: string
  stage: Stage
  actor: string
  qty: number
  cumulative: number
  source?: string
}): Promise<void> {
  const { error } = await supabase.from('report_events').insert({
    part_id: ev.partId,
    job_id: ev.jobId,
    stage: ev.stage,
    actor: ev.actor,
    qty: ev.qty,
    cumulative: ev.cumulative,
    source: ev.source ?? 'scan',
  })
  // Best-effort: the stage write already succeeded; a missing history row
  // must never bounce the worker's report.
  if (error) console.error('[report_events] insert failed:', error.message)
}

// Factory day boundary — the plant runs on Asia/Shanghai regardless of where
// the server happens to be.
function shanghaiDayStartISO(): string {
  const now = new Date()
  const sh = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }))
  const dayStart = new Date(sh.getFullYear(), sh.getMonth(), sh.getDate())
  const offsetMs = sh.getTime() - now.getTime()
  return new Date(dayStart.getTime() - offsetMs).toISOString()
}

export async function workerToday(actor: string): Promise<{ pieces: number; reports: number }> {
  const { data, error } = await supabase
    .from('report_events')
    .select('qty')
    .eq('actor', actor)
    .gte('created_at', shanghaiDayStartISO())
  if (error) return { pieces: 0, reports: 0 }
  const rows = data ?? []
  return {
    pieces: rows.reduce((s, r) => s + Number(r.qty ?? 0), 0),
    reports: rows.length,
  }
}

export async function todaySummary(): Promise<{
  pieces: number
  reports: number
  workers: { actor: string; pieces: number; reports: number }[]
}> {
  const { data, error } = await supabase
    .from('report_events')
    .select('actor, qty')
    .gte('created_at', shanghaiDayStartISO())
  if (error) return { pieces: 0, reports: 0, workers: [] }
  const byActor = new Map<string, { pieces: number; reports: number }>()
  let pieces = 0
  for (const r of data ?? []) {
    const a = r.actor as string
    const q = Number(r.qty ?? 0)
    pieces += q
    const cur = byActor.get(a) ?? { pieces: 0, reports: 0 }
    cur.pieces += q
    cur.reports += 1
    byActor.set(a, cur)
  }
  const workers = [...byActor.entries()]
    .map(([actor, v]) => ({ actor, ...v }))
    .sort((a, b) => b.pieces - a.pieces)
  return { pieces, reports: (data ?? []).length, workers }
}

export async function listJobReportEvents(jobId: string, limit = 200): Promise<ReportEvent[]> {
  const { data, error } = await supabase
    .from('report_events')
    .select('*')
    .eq('job_id', jobId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data ?? []).map(toEvent)
}

// ---------- component board ----------

export type BoardStageChip = {
  stage: Stage
  label: string
  status: StageStatus
  doneQty: number
  by?: string
}

export type BoardSourceImage = {
  url: string
  label: string
  /** Present only for user-added 匹配照片 (job_photos). Immutable packet pages
   *  and the imported 零件图 leave it undefined — they can't be rotated/deleted. */
  photoId?: string
}

// A rotated job photo overwrites the same storage_key, so the ?v= must move or
// the immutable /api/img cache keeps serving the old orientation. updated_at is
// the version source; falls back to a constant when the column predates 0090.
function jobPhotoVersion(updatedAt: unknown): string {
  const parsed = updatedAt ? Date.parse(String(updatedAt)) : NaN
  return Number.isFinite(parsed) ? parsed.toString(36) : 'jobphoto'
}

export type JobSourceImageGroup = {
  componentId: string
  name: string
  partNo?: string
  images: BoardSourceImage[]
}

/**
 * Original uploaded material for a job detail page. Packet photos are the
 * actual camera-uploaded source sheets; image_url is the reference image
 * extracted from an imported workbook or uploaded by an editor.
 */
export async function jobSourceImageGroups(
  jobId: string,
): Promise<JobSourceImageGroup[]> {
  const { data: parts, error: partError } = await supabase
    .from('parts')
    .select('id, name, part_no, image_url, position')
    .eq('job_id', jobId)
    .order('position')
  if (partError) throw partError
  const partIds = (parts ?? []).map((part) => part.id as string)
  if (partIds.length === 0) return []

  const [pageResult, photoResult] = await Promise.all([
    supabase
      .from('packet_pages')
      .select('part_id, idx, kind, op_no, storage_key')
      .in('part_id', partIds),
    supabase
      .from('job_photos')
      .select('id, part_id, storage_key, created_at, updated_at')
      .in('part_id', partIds)
      .order('created_at', { ascending: true }),
  ])
  const { data: pages, error: pageError } = pageResult
  if (pageError) throw pageError
  if (photoResult.error && !missingJobPhotosTable(photoResult.error)) {
    throw photoResult.error
  }

  const pagesByPart = new Map<string, Record<string, unknown>[]>()
  for (const page of pages ?? []) {
    const partId = page.part_id as string
    const list = pagesByPart.get(partId) ?? []
    list.push(page)
    pagesByPart.set(partId, list)
  }
  for (const list of pagesByPart.values()) {
    list.sort((a, b) => Number(a.idx ?? 0) - Number(b.idx ?? 0))
  }

  return (parts ?? []).flatMap((part) => {
    const partId = part.id as string
    const images: BoardSourceImage[] = (pagesByPart.get(partId) ?? []).map(
      (page) => {
        const kind = page.kind as string | null
        const opNo = page.op_no as number | null
        return {
          url: proxiedKeyUrl(String(page.storage_key), 'source'),
          label:
            kind === 'drawing'
              ? '图纸'
              : kind === 'program'
                ? `程序单${opNo ? ` OP${opNo}` : ''}`
                : '资料',
        }
      },
    )
    const referenceUrl = (part.image_url as string | null) ?? undefined
    if (referenceUrl) images.push({ url: referenceUrl, label: '零件图' })
    for (const photo of photoResult.data ?? []) {
      if (photo.part_id !== partId) continue
      images.push({
        url: proxiedKeyUrl(
          String(photo.storage_key),
          jobPhotoVersion(photo.updated_at),
        ),
        label: '匹配照片',
        photoId: String(photo.id),
      })
    }
    if (images.length === 0) return []
    return [
      {
        componentId: componentIdOf(jobId, partId),
        name: String(part.name ?? ''),
        partNo: (part.part_no as string | null) ?? undefined,
        images,
      },
    ]
  })
}

export type ComponentBoardRow = {
  jobId: string
  partId: string
  componentId: string
  jobNo: string
  customer: string
  partNo?: string
  drawingNo?: string
  name: string
  qty: number
  dueDate?: string
  /** 编程 = the packet has been photographed in. */
  programmed: boolean
  programmedBy?: string
  programmedAt?: string
  ops: BoardStageChip[]
  post?: BoardStageChip
  inspection?: BoardStageChip
  ship?: BoardStageChip
  /** First unfinished visible stage — where the part IS right now. */
  current?: BoardStageChip
  lastReport?: { actor: string; qty: number; stage: string; at: string }
  /** Original packet photos, plus the imported reference image when present. */
  sourceImages: BoardSourceImage[]
  shipped: boolean
}

export async function componentBoardRows(): Promise<ComponentBoardRow[]> {
  const [{ data: jobs, error: jerr }, { data: parts, error: perr }] = await Promise.all([
    supabase
      .from('jobs')
      .select('id, job_no, customer, due_date, status, position')
      .in('status', ['ready', 'draft']),
    supabase
      .from('parts')
      .select('id, job_id, name, qty, part_no, drawing_no, image_url, position'),
  ])
  if (jerr) throw jerr
  if (perr) throw perr
  const jobById = new Map((jobs ?? []).map((j) => [j.id as string, j]))
  const liveParts = (parts ?? []).filter((p) => jobById.has(p.job_id as string))
  const partIds = liveParts.map((p) => p.id as string)
  if (partIds.length === 0) return []

  const chunk = <T,>(arr: T[], n: number): T[][] => {
    const out: T[][] = []
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
    return out
  }

  const stageRows: Record<string, unknown>[] = []
  const packetRows: Record<string, unknown>[] = []
  const pageRows: Record<string, unknown>[] = []
  const jobPhotoRows: Record<string, unknown>[] = []
  for (const ids of chunk(partIds, 200)) {
    const [
      { data: st, error: serr },
      { data: pk, error: pkerr },
      { data: pg, error: pgerr },
      { data: jp, error: jperr },
    ] = await Promise.all([
      supabase
        .from('part_stages')
        .select('part_id, stage, status, done_qty, by_actor, completed_at, finished_at, started_at, started_by_actor')
        .in('part_id', ids),
      supabase.from('packets').select('part_id, created_by, created_at').in('part_id', ids),
      supabase
        .from('packet_pages')
        .select('part_id, idx, kind, op_no, storage_key')
        .in('part_id', ids),
      supabase
        .from('job_photos')
        .select('part_id, storage_key, created_at')
        .in('part_id', ids),
    ])
    if (serr) throw serr
    if (pkerr) throw pkerr
    if (pgerr) throw pgerr
    if (jperr && !missingJobPhotosTable(jperr)) throw jperr
    stageRows.push(...(st ?? []))
    packetRows.push(...(pk ?? []))
    pageRows.push(...(pg ?? []))
    jobPhotoRows.push(...(jp ?? []))
  }

  // Latest 报工 per part in one sweep (bounded window — the board only needs
  // "who touched it last", not deep history).
  const { data: recentEvents } = await supabase
    .from('report_events')
    .select('part_id, actor, qty, stage, created_at')
    .order('created_at', { ascending: false })
    .limit(1000)
  const lastByPart = new Map<string, { actor: string; qty: number; stage: string; at: string }>()
  for (const ev of recentEvents ?? []) {
    const pid = ev.part_id as string
    if (!lastByPart.has(pid)) {
      lastByPart.set(pid, {
        actor: ev.actor as string,
        qty: Number(ev.qty ?? 0),
        stage: stageLabel(ev.stage as Stage),
        at: ev.created_at as string,
      })
    }
  }

  const stagesByPart = new Map<string, Map<Stage, Record<string, unknown>>>()
  for (const r of stageRows) {
    const pid = r.part_id as string
    if (!stagesByPart.has(pid)) stagesByPart.set(pid, new Map())
    stagesByPart.get(pid)!.set(r.stage as Stage, r)
  }
  const packetByPart = new Map<string, Record<string, unknown>>()
  for (const r of packetRows) {
    if (!packetByPart.has(r.part_id as string)) packetByPart.set(r.part_id as string, r)
  }
  const pagesByPart = new Map<string, Record<string, unknown>[]>()
  for (const r of pageRows) {
    const pid = r.part_id as string
    const list = pagesByPart.get(pid) ?? []
    list.push(r)
    pagesByPart.set(pid, list)
  }
  for (const list of pagesByPart.values()) {
    list.sort((a, b) => Number(a.idx ?? 0) - Number(b.idx ?? 0))
  }
  const jobPhotosByPart = new Map<string, Record<string, unknown>[]>()
  for (const r of jobPhotoRows) {
    const pid = r.part_id as string
    const list = jobPhotosByPart.get(pid) ?? []
    list.push(r)
    jobPhotosByPart.set(pid, list)
  }
  for (const list of jobPhotosByPart.values()) {
    list.sort((a, b) =>
      String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')),
    )
  }

  const chipOf = (partQty: number, stage: Stage, r?: Record<string, unknown>): BoardStageChip | undefined => {
    if (!r) return undefined
    const status = (r.status as StageStatus) ?? 'pending'
    return {
      stage,
      label: stageLabel(stage),
      status,
      doneQty:
        status === 'done'
          ? partQty
          : Math.min(partQty, Math.max(0, Number(r.done_qty ?? 0))),
      by: ((r.by_actor as string | null) ?? (r.started_by_actor as string | null)) ?? undefined,
    }
  }

  const rows: ComponentBoardRow[] = liveParts.map((p) => {
    const pid = p.id as string
    const jobId = p.job_id as string
    const job = jobById.get(jobId)!
    const qty = Number(p.qty ?? 0)
    const stageMap = stagesByPart.get(pid) ?? new Map<Stage, Record<string, unknown>>()
    const ops = OP_KEYS.filter((s) => stageMap.has(s))
      .map((s) => chipOf(qty, s, stageMap.get(s))!)
    const post = chipOf(qty, '丝印', stageMap.get('丝印'))
    const inspection = chipOf(qty, '检验', stageMap.get('检验'))
    const ship = chipOf(qty, '出货', stageMap.get('出货'))
    const visible = [
      ...ops,
      ...(post ? [post] : []),
      ...(inspection ? [inspection] : []),
    ]
    const current = visible.find((c) => c.status !== 'done')
    const packet = packetByPart.get(pid)
    const sourceImages: BoardSourceImage[] = (pagesByPart.get(pid) ?? []).map(
      (page) => {
        const kind = page.kind as string | null
        const opNo = page.op_no as number | null
        const label =
          kind === 'drawing'
            ? '图纸'
            : kind === 'program'
              ? `程序单${opNo ? ` OP${opNo}` : ''}`
              : '资料'
        return {
          url: proxiedKeyUrl(String(page.storage_key), 'source'),
          label,
        }
      },
    )
    const referenceImageUrl = (p.image_url as string | null) ?? undefined
    if (referenceImageUrl) {
      sourceImages.push({ url: referenceImageUrl, label: '零件图' })
    }
    for (const photo of jobPhotosByPart.get(pid) ?? []) {
      sourceImages.push({
        url: proxiedKeyUrl(String(photo.storage_key), 'source'),
        label: '匹配照片',
      })
    }
    return {
      jobId,
      partId: pid,
      componentId: componentIdOf(jobId, pid),
      jobNo: String(job.job_no ?? ''),
      customer: String(job.customer ?? ''),
      partNo: (p.part_no as string | null) ?? undefined,
      drawingNo: (p.drawing_no as string | null) ?? undefined,
      name: (p.name as string | null) ?? '',
      qty,
      dueDate: (job.due_date as string | null) ?? undefined,
      programmed: Boolean(packet),
      programmedBy: (packet?.created_by as string | null) ?? undefined,
      programmedAt: (packet?.created_at as string | null) ?? undefined,
      ops,
      post,
      inspection,
      ship,
      current,
      lastReport: lastByPart.get(pid),
      sourceImages,
      shipped: ship?.status === 'done',
    }
  })

  // Undelivered first, nearest 交期 first; shipped rows sink to the bottom.
  rows.sort((a, b) => {
    if (a.shipped !== b.shipped) return a.shipped ? 1 : -1
    const da = a.dueDate ?? '9999-12-31'
    const db = b.dueDate ?? '9999-12-31'
    if (da !== db) return da < db ? -1 : 1
    return a.jobNo < b.jobNo ? -1 : 1
  })
  return rows
}

// ---------- worker roster (0084) ----------

// The floor roster. Names are added lazily the first time someone reports —
// no admin screen, no accounts. The grid on /s reads this so 20 workers pick
// instead of type (typo-split identities would wreck the per-worker tallies
// the boss reads).
export async function listWorkers(): Promise<string[]> {
  const { data, error } = await supabase
    .from('workers')
    .select('name')
    .order('created_at', { ascending: true })
    .limit(60)
  if (error) return []
  return (data ?? []).map((r) => String(r.name))
}

export async function upsertWorker(name: string): Promise<void> {
  const n = name.trim().slice(0, 20)
  if (!n) return
  await supabase.from('workers').upsert({ name: n }, { onConflict: 'name' })
}

// ---------- no-match valve (0084) ----------

export type PendingReport = {
  id: string
  photoKey: string
  claimedStage?: string
  qty?: number
  actor?: string
  createdAt: string
}

export function pendingPhotoKey(id: string): string {
  return `unmatched/${id}.jpg`
}

export async function createPendingReport(input: {
  photoKey: string
  claimedStage?: string
  qty?: number
  actor?: string
}): Promise<string> {
  const id = rid('pr')
  const { error } = await supabase.from('pending_reports').insert({
    id,
    photo_key: input.photoKey,
    claimed_stage: input.claimedStage ?? null,
    qty: input.qty ?? null,
    actor: input.actor ?? null,
  })
  if (error) throw error
  return id
}

export async function listPendingReports(): Promise<PendingReport[]> {
  const { data, error } = await supabase
    .from('pending_reports')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) throw error
  return (data ?? []).map((r) => ({
    id: String(r.id),
    photoKey: String(r.photo_key),
    claimedStage: (r.claimed_stage as string | null) ?? undefined,
    qty: r.qty == null ? undefined : Number(r.qty),
    actor: (r.actor as string | null) ?? undefined,
    createdAt: String(r.created_at),
  }))
}

export async function pendingReportCount(): Promise<number> {
  const { count, error } = await supabase
    .from('pending_reports')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending')
  if (error) return 0
  return count ?? 0
}

export async function resolvePendingReport(input: {
  id: string
  status: 'attached' | 'dismissed'
  partId?: string
  appliedStage?: Stage
  resolvedBy: string
}): Promise<PendingReport | undefined> {
  const { data, error } = await supabase
    .from('pending_reports')
    .update({
      status: input.status,
      part_id: input.partId ?? null,
      applied_stage: input.appliedStage ?? null,
      resolved_at: new Date().toISOString(),
      resolved_by: input.resolvedBy,
    })
    .eq('id', input.id)
    .eq('status', 'pending')
    .select('*')
  if (error) throw error
  const r = data?.[0]
  if (!r) return undefined
  return {
    id: String(r.id),
    photoKey: String(r.photo_key),
    claimedStage: (r.claimed_stage as string | null) ?? undefined,
    qty: r.qty == null ? undefined : Number(r.qty),
    actor: (r.actor as string | null) ?? undefined,
    createdAt: String(r.created_at),
  }
}
