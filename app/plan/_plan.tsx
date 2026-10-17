'use client'

import { useEffect, useId, useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'
import { EditableText, EditableTextArea } from '@/app/_editable'
import type { PlanRow, PlanStage, PlanWorker } from '@/lib/plan'

// 计划 — 一个工段一张表, 每一格手填。
//
// 编程: 日期 · 工单号 · 序列号 · 操作人员 · 完成时间 · 备注说明 · 未完成原因
// 操机 / 车铣 / 手工 / 打磨: 序列号换成机台号, 人员后面能标 正面 / 反面 / 别的。
//
// 完成情况: 手填了完成时间就算完成; 没填的看报工 —— 工单在这一道上报完了, 自
// 动算完成, 带上报工的时间和人 (服务端算好的 auto)。顶上按日期、人员、完成情况筛。

/** 报工那一头的完成情况 —— 服务端对着看板 / 零件算好的。 */
export type PlanAuto = {
  state: 'done' | 'partial' | 'none'
  done: number
  total: number
  at?: string
  by?: string
}

type StatusFilter = 'all' | 'open' | 'done'

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

function addDays(iso: string, delta: number): string {
  const [y, m, d] = iso.split('-').map((s) => parseInt(s, 10))
  const dt = new Date(y, m - 1, d + delta)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`
}

function dayLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map((s) => parseInt(s, 10))
  return `${m}月${d}日 ${WEEKDAY[new Date(y, m - 1, d).getDay()]}`
}

export function PlanBoard({
  stage,
  stages,
  rows,
  auto,
  engPlan,
  jobIds,
  names,
  jobNos,
  todayStr,
}: {
  stage: PlanStage
  stages: PlanStage[]
  rows: PlanRow[]
  auto: Record<string, PlanAuto>
  /** 工程在工单上排的那一道的计划交期 (行 id → 'YYYY-MM-DD' 或带时间)。 */
  engPlan: Record<string, string>
  /** 工单号 (去空格、小写) → 工单 id —— 认得出的工单号点得进去。 */
  jobIds: Record<string, string>
  names: string[]
  jobNos: string[]
  todayStr: string
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const isProg = stage === '编程'

  // 筛选
  const [day, setDay] = useState<string>(todayStr) // '' = 全部日期
  const [person, setPerson] = useState('')
  // 默认只看没做完的 —— 做完的 (手填了完成时间, 或者报工报完了) 自己收进「已完成」。
  const [status, setStatus] = useState<StatusFilter>('open')
  const [armDelete, setArmDelete] = useState<string | null>(null)

  // 记一行
  const [date, setDate] = useState(todayStr)
  const [jobNo, setJobNo] = useState('')
  const [extra, setExtra] = useState('') // 序列号 / 机台号
  const [workers, setWorkers] = useState<PlanWorker[]>([])
  const [workerDraft, setWorkerDraft] = useState('') // 打了还没回车的名字
  const [due, setDue] = useState('') // 需求完成 HH:mm

  // 现在几点 —— 过了需求完成时间还没做完的标红。装上之后才算, 每分钟走一次
  // (服务端和浏览器的钟不一样, 先算会对不上)。
  const [nowKey, setNowKey] = useState('')
  useEffect(() => {
    const tick = () => {
      const d = new Date()
      const p = (n: number) => String(n).padStart(2, '0')
      setNowKey(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`)
    }
    tick()
    const t = window.setInterval(tick, 60_000)
    return () => window.clearInterval(t)
  }, [])
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  const isDone = (r: PlanRow) => !!r.doneAt || auto[r.id]?.state === 'done'

  const people = useMemo(
    () => [...new Set(rows.flatMap((r) => r.workers.map((w) => w.name)))].sort((a, b) => a.localeCompare(b, 'zh')),
    [rows],
  )

  // 先按日期、人员筛, 再分没做完 / 做完。
  const base = useMemo(
    () =>
      rows.filter(
        (r) => (!day || r.date === day) && (!person || r.workers.some((w) => w.name === person)),
      ),
    [rows, day, person],
  )
  const doneCount = base.filter(isDone).length
  const openCount = base.length - doneCount
  const shown = status === 'all' ? base : base.filter((r) => (status === 'done') === isDone(r))

  function add() {
    if (!jobNo.trim()) return setError('先填工单号')
    setError(null)
    start(async () => {
      try {
        await mutate({
          kind: 'addPlanRow',
          input: {
            stage,
            date,
            jobNo: jobNo.trim(),
            ...(isProg ? { seq: extra.trim() } : { machine: extra.trim() }),
            // 打了还没回车的名字也算上。
            workers: [
              ...workers,
              ...splitNames(workerDraft)
                .filter((n) => !workers.some((w) => w.name === n))
                .map((name) => ({ name })),
            ],
            due,
            note: note.trim(),
          },
        })
        setJobNo('')
        setExtra('')
        setWorkers([])
        setWorkerDraft('')
        setDue('')
        setNote('')
        if (day) setDay(date)
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : '记不上')
      }
    })
  }

  // 工程排的那一行还没存过 —— 第一次改一格才存成一行 (带着它的 engKey 认回去)。
  const materialize = (r: PlanRow, p: Record<string, unknown>) =>
    mutate({
      kind: 'addPlanRow',
      input: {
        stage,
        date: r.date,
        jobNo: r.jobNo,
        engKey: r.engKey,
        ...('date' in p ? { engFollow: false } : null),
        ...p,
      },
    })

  async function patch(id: string, p: Record<string, unknown>) {
    const r = rows.find((x) => x.id === id)
    if (r?.virtual) await materialize(r, p)
    else await mutate({ kind: 'updatePlanRow', rowId: id, patch: p })
    router.refresh()
  }

  function remove(id: string) {
    const r = rows.find((x) => x.id === id)
    start(async () => {
      try {
        if (r?.virtual) await mutate({ kind: 'addPlanRow', input: { stage, date: r.date, jobNo: r.jobNo, engKey: r.engKey, dismiss: true } })
        else await mutate({ kind: 'deletePlanRow', rowId: id })
        setArmDelete(null)
        router.refresh()
      } catch (e) {
        showToast(e instanceof Error ? e.message : '删不掉', 'warning')
      }
    })
  }

  const inp =
    'h-9 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]'
  const COLS = 'grid-cols-[104px_120px_76px_minmax(0,1.3fr)_76px_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_28px]'
  const extraLabel = isProg ? '序列号' : '机台号'

  return (
    <div>
      {/* 五张表 */}
      <div className="mb-6 flex flex-wrap items-baseline gap-x-6 gap-y-2">
        {stages.map((s) => (
          <Link
            key={s}
            href={s === '编程' ? '/plan' : `/plan?s=${encodeURIComponent(s)}`}
            className={`pb-1 text-[14px] ${
              s === stage
                ? 'border-b-2 border-[var(--color-ink)] font-medium text-[var(--color-ink)]'
                : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
            }`}
          >
            {s}
          </Link>
        ))}
        <Link href="/daily" className="ml-auto text-[12px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]">
          今日重点 →
        </Link>
      </div>

      {/* 记一行 */}
      <div className="mb-5 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-4 md:px-5">
        <div className="flex flex-wrap items-center gap-2.5">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value || todayStr)}
            className={`mono ${inp}`}
          />
          <input
            value={jobNo}
            onChange={(e) => setJobNo(e.target.value)}
            placeholder="工单号"
            list="plan-jobnos"
            className={`mono ${inp} w-[140px]`}
          />
          <datalist id="plan-jobnos">
            {jobNos.map((j) => (
              <option key={j} value={j} />
            ))}
          </datalist>
          <input
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
            placeholder={extraLabel}
            className={`mono ${inp} w-[84px]`}
          />
          <div className="min-h-9 min-w-[200px] flex-1 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5">
            <Workers
              value={workers}
              names={names}
              sides={!isProg}
              onChange={async (w) => setWorkers(w)}
              draft={workerDraft}
              onDraft={setWorkerDraft}
            />
          </div>
          <label className={`${inp} flex items-center gap-1.5`} title="几点前要做完 · 可不填">
            <span className="text-[12px] text-[var(--color-ink-4)]">需求完成</span>
            <input
              type="time"
              value={due}
              onChange={(e) => setDue(e.target.value)}
              className="mono bg-transparent text-[13px] text-[var(--color-ink)] outline-none"
            />
          </label>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="备注说明"
            onKeyDown={(e) => e.key === 'Enter' && add()}
            className={`${inp} min-w-[140px] flex-1`}
          />
          <button
            type="button"
            onClick={add}
            disabled={pending}
            className="h-9 shrink-0 rounded-[2px] bg-[var(--color-ink)] px-4 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-50"
          >
            记下
          </button>
        </div>
        {error && <p className="mt-2 text-[12px] text-[var(--color-overdue)]">{error}</p>}
      </div>

      {/* 筛选 */}
      <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-3">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setDay(addDays(day || todayStr, -1))}
            className="h-8 w-8 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
          >
            ‹
          </button>
          <span className="min-w-[104px] text-center text-[13px] font-medium text-[var(--color-ink)]">
            {day ? dayLabel(day) : '全部日期'}
          </span>
          <button
            type="button"
            onClick={() => setDay(addDays(day || todayStr, 1))}
            className="h-8 w-8 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
          >
            ›
          </button>
          <input
            type="date"
            value={day}
            onChange={(e) => setDay(e.target.value)}
            className="mono ml-1 h-8 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[12.5px] text-[var(--color-ink-2)] outline-none"
          />
          {day !== todayStr && (
            <button type="button" onClick={() => setDay(todayStr)} className="ml-1 text-[12px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]">
              今天
            </button>
          )}
          {day && (
            <button type="button" onClick={() => setDay('')} className="ml-1 text-[12px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]">
              全部日期
            </button>
          )}
        </div>
        <select
          value={person}
          onChange={(e) => setPerson(e.target.value)}
          className="h-8 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[12.5px] text-[var(--color-ink-2)] outline-none"
        >
          <option value="">全部人员</option>
          {people.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <div className="flex overflow-hidden rounded-[2px] border border-[var(--color-border)]">
          {(
            [
              ['open', `未完成 ${openCount}`],
              ['done', `已完成 ${doneCount}`],
              ['all', '全部'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setStatus(k)}
              className={`h-8 px-3 text-[12.5px] ${
                status === k
                  ? 'bg-[var(--color-ink)] text-[var(--color-surface)]'
                  : 'bg-[var(--color-surface)] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* 表 */}
      <div className="overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className={`hidden ${COLS} items-center gap-3 border-b border-[var(--color-border)] bg-[#f5f3ed] px-5 py-2 md:grid`}>
          <span className="label">日期</span>
          <span className="label">工单号</span>
          <span className="label">{extraLabel}</span>
          <span className="label">操作人员</span>
          <span className="label">需求完成</span>
          <span className="label">完成时间</span>
          <span className="label">备注说明</span>
          <span className="label">未完成原因</span>
          <span />
        </div>
        {shown.length === 0 ? (
          <p className="px-5 py-12 text-center text-[13px] text-[var(--color-ink-3)]">
            {rows.length === 0
              ? `${stage}还没有计划`
              : status === 'open' && doneCount > 0
                ? '都做完了，在「已完成」里'
                : '没有符合的计划'}
          </p>
        ) : (
          shown.map((r) => {
            const a = auto[r.id]
            const done = isDone(r)
            return (
              <div
                key={r.id}
                className={`grid ${COLS} items-start gap-3 border-b border-[var(--color-border)] px-4 py-2.5 last:border-b-0 hover:bg-[#faf8f2] md:px-5 ${
                  done ? 'bg-[color-mix(in_srgb,var(--color-success)_5%,transparent)]' : ''
                }`}
              >
                <input
                  type="date"
                  value={r.date}
                  onChange={(e) => {
                    const v = e.target.value
                    if (v && v !== r.date)
                      patch(r.id, { date: v }).catch((err) => showToast(err instanceof Error ? err.message : '改不了', 'warning'))
                  }}
                  className="mono -ml-1 w-full bg-transparent text-[12.5px] tabular-nums text-[var(--color-ink-2)] outline-none"
                />
                <div className="flex min-w-0 flex-col gap-0.5">
                  {/* 认得出的工单号点进工单; 认不出的 (打错了) 还是能改的一格。 */}
                  {jobIds[r.jobNo.trim().toLowerCase()] ? (
                    <Link
                      href={`/jobs/${jobIds[r.jobNo.trim().toLowerCase()]}`}
                      className="mono truncate py-0.5 text-[12.5px] font-medium text-[var(--color-ink)] underline-offset-4 hover:underline"
                    >
                      {r.jobNo}
                    </Link>
                  ) : (
                    <EditableText
                      mono
                      value={r.jobNo}
                      className="text-[12.5px] font-medium text-[var(--color-ink)]"
                      onSave={(v) => patch(r.id, { jobNo: v })}
                    />
                  )}
                  {engPlan[r.id] && (
                    <span
                      className="text-[11px] text-[var(--color-ink-3)]"
                      title="工程在工单上给这一道排的计划交期，自动带进来的"
                    >
                      工程排 {engPlan[r.id].slice(5, 10)}
                      {engPlan[r.id].length > 10 ? ` ${engPlan[r.id].slice(11, 16)}` : ''}
                    </span>
                  )}
                </div>
                <EditableText
                  mono
                  value={isProg ? r.seq : r.machine}
                  className="text-[12.5px] text-[var(--color-ink-2)]"
                  onSave={(v) => patch(r.id, isProg ? { seq: v } : { machine: v })}
                />
                <Workers value={r.workers} names={names} sides={!isProg} onChange={(w) => patch(r.id, { workers: w })} />
                <input
                  key={r.due ?? ''}
                  type="time"
                  defaultValue={r.due ?? ''}
                  title={!done && r.due && nowKey > `${r.date}T${r.due}` ? '过了需求完成时间还没做完' : '几点前要做完'}
                  onBlur={(e) => {
                    const v = e.target.value
                    if (v !== (r.due ?? ''))
                      patch(r.id, { due: v }).catch((err) => showToast(err instanceof Error ? err.message : '改不了', 'warning'))
                  }}
                  className={`mono -ml-1 w-full bg-transparent text-[12.5px] tabular-nums outline-none ${
                    !done && r.due && nowKey && nowKey > `${r.date}T${r.due}`
                      ? 'font-semibold text-[var(--color-overdue)]'
                      : 'text-[var(--color-ink-2)]'
                  }`}
                />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <EditableText
                    value={r.doneAt}
                    placeholder={a?.state === 'done' ? '' : '填完成时间…'}
                    className={`text-[12.5px] ${r.doneAt ? 'font-medium text-[var(--color-success)]' : 'text-[var(--color-ink-2)]'}`}
                    onSave={async (v) => {
                      await patch(r.id, { doneAt: v })
                      if (v.trim() && status === 'open') showToast('做完了，收进「已完成」里')
                    }}
                  />
                  {!r.doneAt && a && <AutoLine a={a} />}
                </div>
                <EditableTextArea
                  value={r.note}
                  placeholder="—"
                  className="text-[12.5px] text-[var(--color-ink-2)]"
                  onSave={(v) => patch(r.id, { note: v })}
                />
                <EditableTextArea
                  value={r.reason}
                  placeholder={done ? '—' : '没做完写原因…'}
                  className="text-[12.5px] text-[var(--color-overdue)]"
                  onSave={(v) => patch(r.id, { reason: v })}
                />
                <span className="text-right">
                  {armDelete === r.id ? (
                    <button
                      type="button"
                      onClick={() => remove(r.id)}
                      disabled={pending}
                      className="text-[11.5px] font-medium text-[var(--color-overdue)] hover:underline disabled:opacity-50"
                    >
                      确认
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setArmDelete(r.id)}
                      className="text-[11.5px] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)]"
                    >
                      删
                    </button>
                  )}
                </span>
              </div>
            )
          })
        )}
      </div>

      <p className="mt-4 text-[12px] text-[var(--color-ink-3)]">
        工程在工单上给这一道排了计划交期的，自动带进来，标着「工程排」。每一格点一下就能改。完成时间手填了就算完成；没填的看报工——这张单在这一道上报完了也算完成。做完的自动收进「已完成」，点上面「已完成」能看到。
        {isProg ? '填了序列号的只看那一个零件。' : '人员点一下可以标正面、反面或者写别的。'}
      </p>
    </div>
  )
}

function AutoLine({ a }: { a: PlanAuto }) {
  if (a.state === 'done') {
    return (
      <span className="text-[11.5px] text-[var(--color-success)]">
        ✓ 报工完成{a.at ? ` ${a.at}` : ''}
        {a.by ? ` · ${a.by}` : ''}
      </span>
    )
  }
  if (a.state === 'partial') {
    return (
      <span className="text-[11.5px] tabular-nums text-[var(--color-warning)]">
        报工 {a.done}/{a.total}
      </span>
    )
  }
  return <span className="text-[11.5px] text-[var(--color-ink-4)]">报工未开始</span>
}

// 一次打好几个人: 逗号、顿号、空格、分号都算分隔。
function splitNames(t: string): string[] {
  return [...new Set(t.split(/[,，、;；\s]+/).map((x) => x.trim()).filter(Boolean))]
}

// 操作人员 —— 多选; 操机那几张表每个人后面能标 正面 / 反面 / 别的。
//
// 直接打字: 一个名字回车, 或者逗号 / 空格隔开一次打几个; 下拉里有厂里的人名
// 可以点, 点一个加一个 (以前点了不算数, 再点第二个就把第一个顶掉, 一行只剩一
// 个人); 名单上没有的照样能打 (临时工、外来帮忙的)。
// 录入那一行的输入框是外面管着的 (draft / onDraft), 点「记下」时还没回车的
// 那几个名字也一起带上。
function Workers({
  value,
  names,
  sides,
  onChange,
  draft: outerDraft,
  onDraft,
}: {
  value: PlanWorker[]
  names: string[]
  sides: boolean
  onChange: (next: PlanWorker[]) => Promise<void>
  draft?: string
  onDraft?: (v: string) => void
}) {
  const [innerDraft, setInnerDraft] = useState('')
  const draft = outerDraft ?? innerDraft
  const setDraft = onDraft ?? setInnerDraft
  const [open, setOpen] = useState<string | null>(null)
  const [other, setOther] = useState('')
  const listId = `plan-names-${useId()}`

  const save = (next: PlanWorker[]) =>
    onChange(next).catch((e) => showToast(e instanceof Error ? e.message : '改不了', 'warning'))

  const commit = (text: string) => {
    setDraft('')
    const add = splitNames(text).filter((n) => !value.some((w) => w.name === n))
    if (add.length > 0) void save([...value, ...add.map((name) => ({ name }))])
  }
  const setSide = (name: string, side: string) => {
    setOpen(null)
    setOther('')
    void save(value.map((w) => (w.name === name ? (side ? { name, side } : { name }) : w)))
  }
  const removeName = (name: string) => {
    setOpen(null)
    void save(value.filter((w) => w.name !== name))
  }

  return (
    <span className="flex flex-wrap items-center gap-1">
      {value.map((w) => (
        <span key={w.name} className="relative">
          <button
            type="button"
            onClick={() => (sides ? setOpen(open === w.name ? null : w.name) : removeName(w.name))}
            title={sides ? '点一下标正面 / 反面 / 别的' : '点一下去掉'}
            className="inline-flex items-baseline gap-1 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 text-[12px] text-[var(--color-ink)] hover:border-[var(--color-border-strong)]"
          >
            {w.name}
            {w.side && <span className="text-[11px] text-[var(--color-warning)]">{w.side}</span>}
          </button>
          {sides && open === w.name && (
            <span className="absolute left-0 top-full z-20 mt-1 flex w-[168px] flex-col gap-1.5 rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-2 shadow-[0_6px_20px_rgba(0,0,0,0.12)]">
              <span className="flex gap-1.5">
                {['正面', '反面'].map((sd) => (
                  <button
                    key={sd}
                    type="button"
                    onClick={() => setSide(w.name, sd)}
                    className={`flex-1 rounded-[2px] border px-2 py-1 text-[12px] ${
                      w.side === sd
                        ? 'border-[var(--color-ink)] text-[var(--color-ink)]'
                        : 'border-[var(--color-border)] text-[var(--color-ink-2)] hover:border-[var(--color-border-strong)]'
                    }`}
                  >
                    {sd}
                  </button>
                ))}
              </span>
              <input
                autoFocus
                value={other}
                onChange={(e) => setOther(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && other.trim()) setSide(w.name, other.trim())
                  if (e.key === 'Escape') setOpen(null)
                }}
                placeholder="其他 · 回车"
                className="h-7 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-[12px] outline-none"
              />
              <span className="flex justify-between">
                {w.side ? (
                  <button type="button" onClick={() => setSide(w.name, '')} className="text-[11.5px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]">
                    不标
                  </button>
                ) : (
                  <span />
                )}
                <button type="button" onClick={() => removeName(w.name)} className="text-[11.5px] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)]">
                  去掉这个人
                </button>
              </span>
            </span>
          )}
        </span>
      ))}
      <input
        list={listId}
        value={draft}
        placeholder={value.length === 0 ? '打姓名 · 可多人' : '＋'}
        onChange={(e) => {
          const v = e.target.value
          // 打了分隔符 (逗号、空格…) 就把前面的名字加上。
          if (/[,，、;；\s]$/.test(v)) return commit(v)
          // 从下拉里点的名字 —— 不是一个字一个字打出来的, 点了就加上。
          const how = (e.nativeEvent as InputEvent).inputType ?? ''
          const typed = how.startsWith('insertText') || how.startsWith('insertComposition') || how.startsWith('delete')
          if (!typed && names.includes(v.trim())) return commit(v)
          setDraft(v)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit(draft)
          }
          // 录入那一行里退格能删掉最后一个人; 表里已经存下的不这么删, 免得手滑。
          if (e.key === 'Backspace' && onDraft && !draft && value.length > 0)
            removeName(value[value.length - 1].name)
        }}
        onBlur={() => draft.trim() && commit(draft)}
        className={`h-6 min-w-[64px] flex-1 bg-transparent px-1 text-[12px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] ${
          value.length === 0 ? 'w-[96px]' : 'w-[48px]'
        }`}
      />
      <datalist id={listId}>
        {names.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
    </span>
  )
}
