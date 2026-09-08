'use client'

import { useMemo, useRef, useState, useTransition } from 'react'
import { withBase } from '@/lib/base-path'
import { proxiedStorageUrl } from '@/lib/storage-url'
import { mutate } from '@/lib/mutate'
import { usePasteImage } from '@/app/_paste_image'
import { partRef } from '@/lib/data'
import {
  drawingKind,
  drawingsByPart,
  formatFileSize,
  type DrawingFile,
} from '@/lib/drawing'
import {
  programLine,
  programsByPart,
  sortPrograms,
  type NcProgram,
} from '@/lib/nc-program'

// 编程 — 编程员打开一张工单要看的一整页。
//
// 在这之前他能读到的只有工序格子和一张缩略图, 于是做程序前那半小时全花在
// "去问": 材料是什么、留多少、图纸在谁手上、这件以前编过没有。这一页就是把
// 那半小时收掉:
//
//   上半段  这个件是什么 —— 材质 · 数量 · 加工方式 · 表面处理 · 备注 · 交期
//   中间    图纸 —— 三维和二维都能传能下, 全厂可下 (编程是生产账号)
//   下半段  程序单 —— 程序号 · 机床 · 装夹 · 刀具 · 单件分钟, 出给操机看
//
// 刀路仍然在 UG 里做, 这里不生成 G 代码 —— 系统接的是刀路前后那两截。

export type ProgrammingPart = {
  componentId: string
  seq: string
  name: string
  qty: number
  partNo?: string
  material?: string
  process?: string
  surfaceTreatment?: string
  notes?: string
  imageUrl?: string
}

export function ProgrammingTab({
  jobId,
  dueDate,
  parts,
  initialDrawings,
  initialPrograms,
  reuse,
  canUpload,
  canWrite,
}: {
  jobId: string
  dueDate?: string
  parts: ProgrammingPart[]
  initialDrawings: DrawingFile[]
  initialPrograms: NcProgram[]
  /** 这个件以前在别的工单上编过的那一套 —— 一键带入, 不用重编。 */
  reuse: Record<string, NcProgram[]>
  canUpload: boolean
  canWrite: boolean
}) {
  const [drawings, setDrawings] = useState(initialDrawings)
  const [programs, setPrograms] = useState(initialPrograms)

  const dByPart = useMemo(() => drawingsByPart(drawings), [drawings])
  const pByPart = useMemo(() => programsByPart(programs), [programs])
  const refOf = (componentId: string) => partRef(jobId, componentId)

  const noDrawing = parts.filter(
    (p) => (dByPart.get(refOf(p.componentId)) ?? []).length === 0,
  )
  const noProgram = parts.filter(
    (p) => (pByPart.get(refOf(p.componentId)) ?? []).length === 0,
  )

  return (
    <div>
      {/* 一句话说清这张工单在编程这一环缺什么 —— 缺图的件是编不动的。 */}
      <div className="mb-6 flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <h2 className="text-[15px] font-medium tracking-tight text-[var(--color-ink)]">
          编程
        </h2>
        {/* 出一张纸交到机台边 —— 程序单存在屏幕上只解决了"存下来", 没解决
            "送到手上"。机台前未必有电脑, 厂里认的是纸。 */}
        <a
          href={withBase(`/jobs/${jobId}/programs/print`)}
          target="_blank"
          rel="noopener"
          className="order-last ml-auto rounded-[2px] border border-[var(--color-border-strong)] px-3 py-1.5 text-[12px] tracking-wider text-[var(--color-ink-2)] transition-colors hover:text-[var(--color-ink)]"
        >
          打印程序单
        </a>
        <p className="text-[12px] text-[var(--color-ink-2)]">
          {parts.length} 个零件
          <span className="mx-1.5 text-[var(--color-ink-4)]">·</span>
          {noDrawing.length > 0 ? (
            <span className="text-[var(--color-overdue)]">
              {noDrawing.length} 个还没有图纸
            </span>
          ) : (
            <span className="text-[var(--color-success)]">图纸齐了</span>
          )}
          <span className="mx-1.5 text-[var(--color-ink-4)]">·</span>
          {noProgram.length > 0 ? (
            <span>{noProgram.length} 个还没出程序</span>
          ) : (
            <span className="text-[var(--color-success)]">程序都出了</span>
          )}
          {dueDate && (
            <>
              <span className="mx-1.5 text-[var(--color-ink-4)]">·</span>
              交期 <span className="mono">{dueDate}</span>
            </>
          )}
        </p>
      </div>

      <div className="border-t border-[var(--color-border)]">
        {parts.map((p) => (
          <PartBlock
            key={p.componentId}
            jobId={jobId}
            part={p}
            drawings={dByPart.get(refOf(p.componentId)) ?? []}
            programs={pByPart.get(refOf(p.componentId)) ?? []}
            reusable={reuse[p.componentId] ?? []}
            canUpload={canUpload}
            canWrite={canWrite}
            onDrawingAdded={(d) => setDrawings((prev) => [d, ...prev])}
            onDrawingRemoved={(id) =>
              setDrawings((prev) => prev.filter((x) => x.id !== id))
            }
            onProgramAdded={(row) => setPrograms((prev) => [...prev, row])}
            onProgramRemoved={(id) =>
              setPrograms((prev) => prev.filter((x) => x.id !== id))
            }
          />
        ))}
      </div>
    </div>
  )
}

// ── 一个零件 ───────────────────────────────────────────────────────────────
//
// 导出给编程台复用 —— 工单页和编程台看到的必须是同一块东西, 各写一份迟早会
// 长歪成两个样子。

export function PartBlock({
  jobId,
  part,
  drawings,
  programs,
  reusable,
  canUpload,
  canWrite,
  onDrawingAdded,
  onDrawingRemoved,
  onProgramAdded,
  onProgramRemoved,
}: {
  jobId: string
  part: ProgrammingPart
  drawings: DrawingFile[]
  programs: NcProgram[]
  reusable: NcProgram[]
  canUpload: boolean
  canWrite: boolean
  onDrawingAdded: (d: DrawingFile) => void
  onDrawingRemoved: (id: string) => void
  onProgramAdded: (p: NcProgram) => void
  onProgramRemoved: (id: string) => void
}) {
  const facts = [
    part.material && `材质 ${part.material}`,
    `数量 ${part.qty}`,
    part.process && `加工 ${part.process}`,
    part.surfaceTreatment && `表面 ${part.surfaceTreatment}`,
  ].filter(Boolean) as string[]

  return (
    <section className="flex gap-5 border-b border-[var(--color-border)] py-5">
      {/* 缩略图 — 认件用, 不是图纸。 */}
      <div className="w-[76px] shrink-0">
        {part.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={proxiedStorageUrl(part.imageUrl)}
            alt={part.name}
            className="h-[76px] w-[76px] rounded-[2px] border border-[var(--color-border)] bg-white object-contain"
          />
        ) : (
          <div className="flex h-[76px] w-[76px] items-center justify-center rounded-[2px] border border-dashed border-[var(--color-border)] text-[11px] text-[var(--color-ink-4)]">
            无图
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1">
        {/* 这个件是什么 */}
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="mono text-[11px] text-[var(--color-ink-4)]">
            {part.seq}
          </span>
          <span className="text-[15px] font-medium text-[var(--color-ink)]">
            {part.name}
          </span>
          {part.partNo && (
            <span className="mono text-[12px] text-[var(--color-ink-3)]">
              {part.partNo}
            </span>
          )}
        </div>
        <p className="mt-1 text-[12.5px] text-[var(--color-ink-2)]">
          {facts.join(' · ')}
        </p>
        {part.notes && (
          <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-[var(--color-ink-2)]">
            {part.notes}
          </p>
        )}

        {/* 图纸 */}
        <Row label="图纸">
          {drawings.length === 0 && !canUpload && (
            <span className="text-[13px] text-[var(--color-overdue)]">
              还没有图纸
            </span>
          )}
          <div className="flex flex-col gap-1">
            {drawings.map((d) => (
              <DrawingRow
                key={d.id}
                jobId={jobId}
                file={d}
                canDelete={canUpload}
                onRemoved={() => onDrawingRemoved(d.id)}
              />
            ))}
          </div>
          {canUpload && (
            <DrawingDrop
              jobId={jobId}
              componentId={part.componentId}
              onAdded={onDrawingAdded}
              empty={drawings.length === 0}
            />
          )}
        </Row>

        {/* 程序单 */}
        <Row label="程序">
          <div className="flex flex-col gap-1">
            {programs.map((p) => (
              <ProgramRow
                key={p.id}
                jobId={jobId}
                program={p}
                canWrite={canWrite}
                onRemoved={() => onProgramRemoved(p.id)}
              />
            ))}
          </div>
          {programs.length === 0 && !canWrite && (
            <span className="text-[13px] text-[var(--color-ink-3)]">
              还没出程序
            </span>
          )}
          {canWrite && (
            <ProgramComposer
              jobId={jobId}
              componentId={part.componentId}
              partName={part.name}
              partNo={part.partNo}
              reusable={programs.length === 0 ? reusable : []}
              onAdded={onProgramAdded}
            />
          )}
        </Row>
      </div>
    </section>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-3 flex gap-4">
      <span className="label w-[36px] shrink-0 pt-[3px]">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

// ── 图纸 ───────────────────────────────────────────────────────────────────

function DrawingRow({
  jobId,
  file,
  canDelete,
  onRemoved,
}: {
  jobId: string
  file: DrawingFile
  canDelete: boolean
  onRemoved: () => void
}) {
  const [pending, start] = useTransition()
  const kind = drawingKind(file.filename)
  const size = formatFileSize(file.filesize)
  return (
    <div className="flex items-start gap-2.5">
      <a
        href={proxiedStorageUrl(file.url)}
        download={file.filename}
        className="min-w-0 break-all text-[13.5px] leading-snug text-[var(--color-ink)] underline decoration-[var(--color-border-strong)] underline-offset-2 hover:decoration-[var(--color-ink)]"
        title={`下载 ${file.filename}`}
      >
        {file.filename}
      </a>
      {kind && (
        <span className="shrink-0 rounded-[2px] border border-[var(--color-border-strong)] px-1 text-[10px] leading-[15px] text-[var(--color-ink-3)]">
          {kind}
        </span>
      )}
      <span className="shrink-0 text-[11px] text-[var(--color-ink-4)]">
        {[size, file.uploadedBy, file.createdAt.slice(5, 10)]
          .filter(Boolean)
          .join(' · ')}
      </span>
      {canDelete && (
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            if (!confirm(`删掉 ${file.filename}?`)) return
            start(async () => {
              await mutate({ kind: 'deleteDrawing', jobId, drawingId: file.id })
              onRemoved()
            })
          }}
          className="shrink-0 text-[11px] text-[var(--color-ink-3)] transition-colors hover:text-[var(--color-overdue)] disabled:opacity-40"
        >
          {pending ? '删除中…' : '删'}
        </button>
      )}
    </div>
  )
}

function DrawingDrop({
  jobId,
  componentId,
  onAdded,
  empty,
}: {
  jobId: string
  componentId: string
  onAdded: (d: DrawingFile) => void
  empty: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const zoneRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState(false)
  // 正在传谁、传到几成 —— 一个三十兆的模型在厂里的网上要走十几秒, 期间屏幕
  // 上一个字都不动的话, 人只会以为系统死了, 然后再点一次。
  const [job, setJob] = useState<{ name: string; pct: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const busy = job !== null

  // 一份文件走一趟 XHR —— fetch 拿不到上传进度。
  const putOne = (file: File) =>
    new Promise<DrawingFile>((resolve, reject) => {
      const form = new FormData()
      form.append('file', file)
      form.append('jobId', jobId)
      form.append('componentId', componentId)

      const xhr = new XMLHttpRequest()
      xhr.open('POST', withBase('/api/upload-drawing'))
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return
        setJob({ name: file.name, pct: Math.round((e.loaded / e.total) * 100) })
      }
      xhr.onerror = () => reject(new Error('网络断了 — 重传一次'))
      xhr.ontimeout = () => reject(new Error('传太久了 — 重传一次'))
      xhr.onload = () => {
        // 服务端 502 / 反代拦截时回的是一页 HTML, 不是 JSON。硬解会抛一句没人
        // 看得懂的英文, 所以这里自己判断, 换成人话。
        let json: { ok?: boolean; error?: string; drawing?: DrawingFile } | null =
          null
        try {
          json = JSON.parse(xhr.responseText)
        } catch {
          json = null
        }
        if (!json) {
          reject(
            new Error(
              xhr.status === 413
                ? '文件过大 — 压成压缩包再传'
                : `传不上去 (${xhr.status || '连不上'}) — 重传一次`,
            ),
          )
          return
        }
        if (!json.ok || !json.drawing) {
          reject(new Error(json.error || '上传失败'))
          return
        }
        resolve(json.drawing)
      }
      xhr.send(form)
    })

  const send = async (files: FileList | File[] | null) => {
    if (busy || !files || files.length === 0) return
    setError(null)
    const list = Array.from(files)
    const failed: string[] = []
    for (const file of list) {
      setJob({ name: file.name, pct: 0 })
      try {
        onAdded(await putOne(file))
      } catch (e) {
        // 一份失败不该把后面几份也拖住 —— 传得上去的先进去, 失败的单独报。
        failed.push(`${file.name}: ${e instanceof Error ? e.message : '上传失败'}`)
      }
    }
    setJob(null)
    setError(failed.length > 0 ? failed.join(' · ') : null)
    if (inputRef.current) inputRef.current.value = ''
  }

  // 客户在微信上发来的图纸截图, 鼠标停在这块上 Ctrl+V 直接进来。三维模型仍
  // 然只能选文件 —— 剪贴板里放不下一个 step。
  usePasteImage(zoneRef, (f) => void send([f]))

  return (
    <div ref={zoneRef} className={empty ? '' : 'mt-1.5'}>
      <div
        onDragOver={(e) => {
          if (busy) return
          e.preventDefault()
          setDrag(true)
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDrag(false)
          void send(e.dataTransfer.files)
        }}
        // 传的时候不接受第二次点击 —— 再点一下只会开出第二条上传, 两份一起挤
        // 那条本来就不宽的线, 更慢。
        onClick={() => {
          if (!busy) inputRef.current?.click()
        }}
        className={`relative overflow-hidden rounded-[2px] border border-dashed px-2.5 py-1.5 text-[12px] transition-colors ${
          busy
            ? 'cursor-progress border-[var(--color-border-strong)] text-[var(--color-ink-2)]'
            : drag
              ? 'cursor-pointer border-[var(--color-ink)] text-[var(--color-ink)]'
              : 'cursor-pointer border-[var(--color-border-strong)] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
        }`}
      >
        {/* 进度条就是这一格自己在填色 —— 不另摆一根细蓝条。 */}
        {job && (
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 bg-[var(--color-active-bg)] transition-[width] duration-200"
            style={{ width: `${job.pct}%` }}
          />
        )}
        <span className="relative flex items-baseline gap-2">
          {job ? (
            <>
              <span className="min-w-0 flex-1 truncate">{job.name}</span>
              <span className="mono shrink-0 tabular-nums">
                {job.pct < 100 ? `${job.pct}%` : '存盘中…'}
              </span>
            </>
          ) : empty ? (
            <span>把图纸拖进来 — 三维 / 二维都行</span>
          ) : (
            <span>＋ 再传一份</span>
          )}
        </span>
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => void send(e.target.files)}
      />
      {error && (
        <p className="mt-1 text-[12px] text-[var(--color-overdue)]">{error}</p>
      )}
    </div>
  )
}

// ── 程序单 ─────────────────────────────────────────────────────────────────

function ProgramRow({
  jobId,
  program,
  canWrite,
  onRemoved,
}: {
  jobId: string
  program: NcProgram
  canWrite: boolean
  onRemoved: () => void
}) {
  const [pending, start] = useTransition()
  return (
    <div className="flex items-start gap-2.5">
      <span className="min-w-0 flex-1 break-words text-[13.5px] leading-snug text-[var(--color-ink)]">
        {programLine(program)}
      </span>
      {program.note && (
        <span className="shrink-0 text-[11.5px] text-[var(--color-ink-3)]">
          {program.note}
        </span>
      )}
      <span className="shrink-0 text-[11px] text-[var(--color-ink-4)]">
        {[program.by, program.createdAt.slice(5, 10)].filter(Boolean).join(' · ')}
      </span>
      {canWrite && (
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            if (!confirm(`删掉程序 ${program.no}?`)) return
            start(async () => {
              await mutate({
                kind: 'deleteNcProgram',
                programId: program.id,
                jobId,
              })
              onRemoved()
            })
          }}
          className="shrink-0 text-[11px] text-[var(--color-ink-3)] transition-colors hover:text-[var(--color-overdue)] disabled:opacity-40"
        >
          {pending ? '删除中…' : '删'}
        </button>
      )}
    </div>
  )
}

const FIELD =
  'border-b border-[var(--color-border-strong)] bg-transparent py-1 text-[13px] text-[var(--color-ink)] placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-ink)] focus:outline-none'

function ProgramComposer({
  jobId,
  componentId,
  partName,
  partNo,
  reusable,
  onAdded,
}: {
  jobId: string
  componentId: string
  partName: string
  partNo?: string
  reusable: NcProgram[]
  onAdded: (p: NcProgram) => void
}) {
  const [open, setOpen] = useState(false)
  const [no, setNo] = useState('')
  const [machine, setMachine] = useState('')
  const [fixture, setFixture] = useState('')
  const [tools, setTools] = useState('')
  const [minutes, setMinutes] = useState('')
  const [note, setNote] = useState('')
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const add = (input: {
    no: string
    machine?: string
    fixture?: string
    tools?: string
    minutes?: number
    note?: string
  }) =>
    mutate<NcProgram>({
      kind: 'addNcProgram',
      input: { jobId, componentId, partName, partNo, ...input },
    }).then((res) => {
      if (res.data) onAdded(res.data)
    })

  const submit = () => {
    setError(null)
    if (!no.trim()) {
      setError('先填程序号')
      return
    }
    start(async () => {
      try {
        await add({
          no: no.trim(),
          machine: machine.trim() || undefined,
          fixture: fixture.trim() || undefined,
          tools: tools.trim() || undefined,
          minutes: minutes.trim() ? Number(minutes) : undefined,
          note: note.trim() || undefined,
        })
        setNo('')
        setMachine('')
        setFixture('')
        setTools('')
        setMinutes('')
        setNote('')
        setOpen(false)
      } catch (e) {
        setError(e instanceof Error ? e.message : '保存失败')
      }
    })
  }

  const bringIn = () => {
    setError(null)
    start(async () => {
      try {
        for (const p of sortPrograms(reusable)) {
          await add({
            no: p.no,
            machine: p.machine,
            fixture: p.fixture,
            tools: p.tools,
            minutes: p.minutes,
            note: p.note,
          })
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : '带入失败')
      }
    })
  }

  return (
    <div className={open ? 'mt-1.5' : ''}>
      {/* 这个件以前编过 —— 这一行是这张单最值钱的地方: 省掉重编的那两个钟头。 */}
      {!open && reusable.length > 0 && (
        <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-[12.5px]">
          <span className="text-[var(--color-ink-3)]">这个件以前编过 ·</span>
          <span className="min-w-0 break-all text-[var(--color-ink-2)]">
            {reusable.map((p) => p.no).join(' · ')}
          </span>
          <button
            type="button"
            onClick={bringIn}
            disabled={pending}
            className="text-[var(--color-ink)] underline underline-offset-2 hover:opacity-70 disabled:opacity-40"
          >
            {pending ? '带入中…' : '带过来'}
          </button>
        </div>
      )}

      {open ? (
        <div className="rounded-[2px] border border-[var(--color-border-strong)] px-3 py-2.5">
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 md:grid-cols-4">
            <input
              autoFocus
              value={no}
              onChange={(e) => setNo(e.target.value)}
              placeholder="程序号 O1001"
              className={`${FIELD} mono`}
            />
            <input
              value={machine}
              onChange={(e) => setMachine(e.target.value)}
              placeholder="机床 850"
              className={FIELD}
            />
            <input
              value={fixture}
              onChange={(e) => setFixture(e.target.value)}
              placeholder="装夹 平口钳"
              className={FIELD}
            />
            <input
              value={minutes}
              onChange={(e) => setMinutes(e.target.value.replace(/[^\d]/g, ''))}
              placeholder="单件分钟"
              inputMode="numeric"
              className={`${FIELD} mono`}
            />
            <input
              value={tools}
              onChange={(e) => setTools(e.target.value)}
              placeholder="刀具 D8R1 · D6 · T3钻"
              className={`${FIELD} col-span-2`}
            />
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="备注"
              className={`${FIELD} col-span-2`}
            />
          </div>
          <div className="mt-2.5 flex items-center gap-2">
            <button
              type="button"
              onClick={submit}
              disabled={pending}
              className="rounded-[2px] bg-[var(--color-ink)] px-3 py-1.5 text-[12px] tracking-wider text-[var(--color-surface)] hover:opacity-80 disabled:opacity-40"
            >
              {pending ? '保存中…' : '保存'}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={pending}
              className="px-2 py-1.5 text-[12px] tracking-wider text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
            >
              取消
            </button>
            {error && (
              <span className="text-[12px] text-[var(--color-overdue)]">
                {error}
              </span>
            )}
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-[12.5px] text-[var(--color-ink-3)] underline underline-offset-2 hover:text-[var(--color-ink)]"
        >
          ＋ 加程序
        </button>
      )}
      {!open && error && (
        <p className="mt-1 text-[12px] text-[var(--color-overdue)]">{error}</p>
      )}
    </div>
  )
}
