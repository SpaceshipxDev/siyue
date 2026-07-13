import type { Metadata } from 'next'
import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import { stageLabel, TRACKING_STAGES, type Stage } from '@/lib/data'
import {
  listPendingReports,
  packetPageSignedUrl,
} from '@/lib/packets'
import { BRAND } from '@/lib/brand'
import { applyPendingReport, dismissPendingReport } from './_actions'

// 待归档 — the PMC's desk view of the no-match valve. Every card is a worker
// photo that matched nothing (usually a packet 编程 hasn't ingested yet),
// carrying the claimed stage + count. She searches the part, picks the
// stage, one tap attaches — the pieces land exactly like a scan 报工. The
// worker was never blocked; she never walked.

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: `待归档 · ${BRAND.shortName}`,
}

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const m = Math.floor(ms / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}

type PartHit = {
  id: string
  jobId: string
  jobNo: string
  name: string
  partNo?: string
  qty: number
  dueDate?: string
  openStages: Stage[]
}

// Open parts matching q — by 名称/货号/图纸号/工单号. Two narrow queries
// merged, then the open-stage list per hit for the attach <select>.
async function searchOpenParts(q: string): Promise<PartHit[]> {
  const needle = `%${q}%`
  const { data: jobRows } = await supabase
    .from('jobs')
    .select('id, job_no, customer, due_date, status')
    .in('status', ['draft', 'ready'])
  const openJobs = new Map((jobRows ?? []).map((j) => [String(j.id), j]))
  if (openJobs.size === 0) return []

  const [byPart, byJobNo] = await Promise.all([
    supabase
      .from('parts')
      .select('id, job_id, name, part_no, drawing_no, qty')
      .or(`name.ilike.${needle},part_no.ilike.${needle},drawing_no.ilike.${needle}`)
      .limit(40),
    Promise.resolve({
      data: (jobRows ?? [])
        .filter((j) => String(j.job_no ?? '').toLowerCase().includes(q.toLowerCase()))
        .slice(0, 10),
    }),
  ])

  const partRows = [...(byPart.data ?? [])]
  const jobHitIds = new Set((byJobNo.data ?? []).map((j) => String(j.id)))
  if (jobHitIds.size > 0) {
    const { data: jobParts } = await supabase
      .from('parts')
      .select('id, job_id, name, part_no, drawing_no, qty')
      .in('job_id', [...jobHitIds])
      .limit(40)
    partRows.push(...(jobParts ?? []))
  }

  const seen = new Set<string>()
  const hits = partRows
    .filter((p) => openJobs.has(String(p.job_id)))
    .filter((p) => (seen.has(String(p.id)) ? false : (seen.add(String(p.id)), true)))
    .slice(0, 8)
  if (hits.length === 0) return []

  const { data: stageRows } = await supabase
    .from('part_stages')
    .select('part_id, stage, status')
    .in('part_id', hits.map((p) => String(p.id)))
  const openByPart = new Map<string, Stage[]>()
  for (const r of stageRows ?? []) {
    if (r.status === 'done') continue
    const s = r.stage as Stage
    if (!(TRACKING_STAGES as string[]).includes(s)) continue
    const arr = openByPart.get(String(r.part_id)) ?? []
    arr.push(s)
    openByPart.set(String(r.part_id), arr)
  }
  const order = new Map(TRACKING_STAGES.map((s, i) => [s, i]))

  return hits.map((p) => {
    const job = openJobs.get(String(p.job_id))!
    return {
      id: String(p.id),
      jobId: String(p.job_id),
      jobNo: String(job.job_no ?? ''),
      name: String(p.name ?? ''),
      partNo: (p.part_no as string | null) ?? undefined,
      qty: Number(p.qty ?? 0),
      dueDate: (job.due_date as string | null) ?? undefined,
      openStages: (openByPart.get(String(p.id)) ?? []).sort(
        (a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99),
      ),
    }
  })
}

export default async function ReviewPage(props: PageProps<'/review'>) {
  await requireUser()
  const sp = await props.searchParams
  const activeId = typeof sp.pr === 'string' ? sp.pr : undefined
  const q = typeof sp.q === 'string' ? sp.q.trim().slice(0, 40) : ''
  const done = sp.done === '1'

  const pending = await listPendingReports()
  const urls = new Map<string, string>()
  await Promise.all(
    pending.map(async (p) => {
      const u = await packetPageSignedUrl(p.photoKey, 1800)
      if (u) urls.set(p.id, u)
    }),
  )
  const hits = activeId && q ? await searchOpenParts(q) : []

  return (
    <main className="min-h-dvh bg-[var(--color-bg)]">
      <header className="h-12 px-4 bg-[var(--color-surface)] border-b border-[var(--color-border)] flex items-center justify-between">
        <span className="text-[13px] font-semibold">待归档 · 没认出来的报工</span>
        <Link href="/" className="text-[12px] text-[var(--color-ink-2)]">
          ← 返回工单
        </Link>
      </header>

      <div className="max-w-2xl mx-auto px-4 py-5 space-y-4">
        {done ? (
          <div className="bg-[var(--color-success-soft)] border border-[var(--color-success)] rounded-[3px] px-4 py-3">
            <p className="text-[13px] font-semibold text-[var(--color-success)]">
              ✓ 已归档，件数已计入
            </p>
          </div>
        ) : null}

        {pending.length === 0 ? (
          <section className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[3px] p-10 text-center">
            <p className="text-[15px] font-semibold">没有待归档的报工</p>
            <p className="text-[12px] text-[var(--color-ink-2)] mt-1">
              工人拍照没认出来的单子会出现在这里。
            </p>
          </section>
        ) : (
          pending.map((p) => {
            const isActive = p.id === activeId
            return (
              <section
                key={p.id}
                className="bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-[3px] p-4 space-y-3"
              >
                <div className="flex gap-3">
                  {urls.get(p.id) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <a href={urls.get(p.id)} target="_blank" rel="noreferrer" className="shrink-0">
                      <img
                        src={urls.get(p.id)}
                        alt="工人拍的单子"
                        className="w-24 h-24 object-cover rounded-[3px] border border-[var(--color-border)]"
                      />
                    </a>
                  ) : (
                    <div className="w-24 h-24 shrink-0 rounded-[3px] border border-[var(--color-border)] flex items-center justify-center text-[11px] text-[var(--color-ink-3)]">
                      无图
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="text-[15px] font-semibold">
                      {p.actor ?? '未留名'}
                      <span className="font-normal text-[var(--color-ink-2)]">
                        {' '}
                        报了 <span className="font-semibold font-mono">{p.qty ?? '?'}</span> 件
                      </span>
                    </p>
                    <p className="text-[12px] text-[var(--color-ink-2)] mt-0.5">
                      工序：{p.claimedStage ?? '未选'} · {relTime(p.createdAt)}
                    </p>
                    <p className="text-[11px] text-[var(--color-ink-3)] mt-1 leading-snug">
                      点开大图对一下图纸，搜零件归档。
                    </p>
                  </div>
                </div>

                <div className="flex gap-2">
                  <form method="GET" action="/review" className="flex-1 flex gap-2">
                    <input type="hidden" name="pr" value={p.id} />
                    <input
                      name="q"
                      defaultValue={isActive ? q : ''}
                      placeholder="搜零件名 / 货号 / 图纸号"
                      className="flex-1 h-11 px-3 text-[14px] border border-[var(--color-border-strong)] rounded-[3px] bg-[var(--color-surface)] outline-none focus:border-[var(--color-ink)]"
                    />
                    <button
                      type="submit"
                      className="h-11 px-4 text-[13px] font-semibold bg-[var(--color-ink)] text-[var(--color-surface)] rounded-[3px]"
                    >
                      搜索
                    </button>
                  </form>
                  <form action={dismissPendingReport}>
                    <input type="hidden" name="pr" value={p.id} />
                    <button
                      type="submit"
                      className="h-11 px-3 text-[12px] text-[var(--color-ink-3)] border border-[var(--color-border)] rounded-[3px]"
                    >
                      忽略
                    </button>
                  </form>
                </div>

                {isActive && q ? (
                  hits.length === 0 ? (
                    <p className="text-[12px] text-[var(--color-ink-2)]">
                      没找到「{q}」— 可能这单还没录入，先让编程拍照录入，再回来归档。
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {hits.map((h) => (
                        <form
                          key={h.id}
                          action={applyPendingReport}
                          className="flex items-center gap-2 border border-[var(--color-border)] rounded-[3px] p-2.5"
                        >
                          <input type="hidden" name="pr" value={p.id} />
                          <input type="hidden" name="part" value={h.id} />
                          <div className="flex-1 min-w-0">
                            <p className="text-[14px] font-semibold truncate">
                              {h.name}
                              <span className="font-mono font-normal text-[11px] text-[var(--color-ink-2)] ml-2">
                                {h.jobNo}
                              </span>
                            </p>
                            <p className="text-[11px] text-[var(--color-ink-2)]">
                              {h.qty} 件{h.dueDate ? ` · 交期 ${h.dueDate.slice(5).replace('-', '/')}` : ''}
                            </p>
                          </div>
                          {h.openStages.length > 0 ? (
                            <>
                              <select
                                name="stage"
                                defaultValue={h.openStages[0]}
                                className="h-10 px-2 text-[13px] border border-[var(--color-border-strong)] rounded-[3px] bg-[var(--color-surface)]"
                              >
                                {h.openStages.map((s) => (
                                  <option key={s} value={s}>
                                    {stageLabel(s)}
                                  </option>
                                ))}
                              </select>
                              <button
                                type="submit"
                                className="h-10 px-3 shrink-0 text-[13px] font-semibold bg-[var(--color-success)] text-white rounded-[3px]"
                              >
                                归档
                              </button>
                            </>
                          ) : (
                            <span className="text-[11px] text-[var(--color-ink-3)]">无开放工序</span>
                          )}
                        </form>
                      ))}
                    </div>
                  )
                ) : null}
              </section>
            )
          })
        )}
      </div>
    </main>
  )
}
