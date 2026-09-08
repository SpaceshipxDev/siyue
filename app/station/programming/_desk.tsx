'use client'

import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import {
  daysFromToday,
  dueState,
  partRef,
  type DueState,
  type StageStatus,
} from '@/lib/data'
import { mutate } from '@/lib/mutate'
import { drawingsByPart, type DrawingFile } from '@/lib/drawing'
import type { NcProgram } from '@/lib/nc-program'
import { PartBlock } from '@/app/_programming'
import {
  ResizableHeader,
  useColumnWidths,
  type ColSpec,
} from '@/app/_col_width'

// 编程台 —— 一行一个要编的件, 按交期排。
//
// 每一行只回答三件事, 从左到右:
//   编什么   工号 · 零件 · 材质数量
//   编得动吗 图纸有没有 (没图是编不动的, 所以它是红的)
//   编好了吗 程序号出了没有
//
// 点开一行, 下面摊开的是工单页上那同一块面板 (图纸 + 程序单), 不是另写一份 ——
// 编程员在哪儿看到的都得是同一个东西。
//
// 报完成就在这一行上: 出完程序点一下, 后面的操机站立刻就看得到活来了。

export type DeskRow = {
  jobId: string
  jobNo: string
  product: string
  dueDate: string
  status: StageStatus
  /** 上游 (工程) 完了没 —— 没完就是"可以先看图, 还轮不到报完成"。 */
  upstreamReady: boolean
  /** 编好的那天 · 谁编的 —— 只有已编的行才有。 */
  doneAt?: string
  doneBy?: string
  componentId: string
  name: string
  qty: number
  note?: string
  partNo?: string
  material?: string
  process?: string
  surfaceTreatment?: string
  imageUrl?: string
  programs: NcProgram[]
  reusable: NcProgram[]
}

// 五个口子, 前四个按"我现在能不能动手"分, 最后一个回答另一个问题:
//   能编   上游 (工程) 完了, 还没开始 —— 今天该干的就是这些
//   在编   自己已经点过开始
//   等上游 工程还没点完成 —— 可以先看图、先传图, 报不了完成
//   已编   编好了的 —— "这张单编程做完没有", 这一栏就是答案。编完的行不该
//          从台面上蒸发: 蒸发了, 管理的人只能挨个去问。
type Lens = 'all' | 'ready' | 'doing' | 'waiting' | 'done'

// 列。工号 / 程序号这些东西没有标准长度 (YNMX-26-4-9-094 和客户给的长料号都
// 是一列), 所以定死多宽都会截掉谁 —— 列宽是可以拉的, 拉过的记在这台机器上。
// 零件那一列吃剩余宽度, 不用拉。
const COLS: ColSpec[] = [
  { key: 'jobNo', label: '工号', width: 152, min: 90 },
  { key: 'part', label: '零件 · 材质 · 数量', flex: true, min: 220 },
  { key: 'drawing', label: '图纸', width: 84, min: 64 },
  { key: 'program', label: '程序号', width: 200, min: 90 },
  { key: 'due', label: '交期', width: 108, min: 84, align: 'right' },
  { key: 'act', label: '', width: 96, min: 96, align: 'right' },
]

export function ProgrammingDesk({
  rows,
  drawings,
  canUpload,
  canWrite,
  canReport,
  hiddenJobs = 0,
  loadError = null,
}: {
  rows: DeskRow[]
  drawings: DrawingFile[]
  canUpload: boolean
  canWrite: boolean
  canReport: boolean
  /** 因为封顶没摊开的工单张数 —— 说出来, 别让人以为活漏了。 */
  hiddenJobs?: number
  /** 取数出岔子时的原话 —— 页面照常出来, 但要讲清哪一段没读到。 */
  loadError?: string | null
}) {
  const [lens, setLens] = useState<Lens>('all')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  // 图纸和程序在这一页上是活的 (传一份、加一条, 行上的字立刻变), 所以本地存
  // 一份, 不靠整页刷新。
  const [files, setFiles] = useState(drawings)
  const [programs, setPrograms] = useState<NcProgram[]>(() =>
    rows.flatMap((r) => r.programs),
  )
  // 刚点过「编好了」的那几行 —— 不抹掉, 就地翻成"已编好"沉到底下。抹掉的话
  // 人点完就找不着了, 也无从确认自己刚才那一下到底记上没有。
  const [justDone, setJustDone] = useState<Map<string, string>>(
    () => new Map(),
  )
  const { rootRef, template, minWidth, startResize, resetCol, resetAll } =
    useColumnWidths('colw:programming', COLS)

  // 归集的键是 partRef (工单 + 零件) —— 这一页上摆着几十张工单, 而零件编号
  // 只在一张工单里唯一 (p1/p2/p3)。按编号归会把全厂每张工单的第一个零件的图
  // 纸和程序全堆到同一行上。
  const dByPart = useMemo(() => drawingsByPart(files), [files])
  const pByPart = useMemo(() => {
    const by = new Map<string, NcProgram[]>()
    for (const p of programs) {
      const k = partRef(p.jobId, p.componentId)
      by.set(k, [...(by.get(k) ?? []), p])
    }
    return by
  }, [programs])

  // 本地刚报完成的, 就地当成 done 参与所有筛选和统计。
  const rowsNow = useMemo(
    () =>
      rows.map((r) => {
        const who = justDone.get(partRef(r.jobId, r.componentId))
        return who === undefined
          ? r
          : { ...r, status: 'done' as StageStatus, doneBy: who }
      }),
    [rows, justDone],
  )

  const needle = q.trim().toLowerCase()
  const visible = useMemo(() => {
    return rowsNow
      .filter((r) =>
        lens === 'ready'
          ? r.upstreamReady && r.status === 'pending'
          : lens === 'doing'
            ? r.status === 'in_progress'
            : lens === 'waiting'
              ? !r.upstreamReady && r.status !== 'done'
              : lens === 'done'
                ? r.status === 'done'
                : // 全部 —— 没编完的在前, 编好的沉到后面。
                  true,
      )
      .filter((r) =>
        needle
          ? `${r.jobNo} ${r.name} ${r.partNo ?? ''} ${r.product}`
              .toLowerCase()
              .includes(needle)
          : true,
      )
      .sort(
        (a, b) =>
          // 编好的沉到后面 —— 台面最上头永远是还要动手的。
          Number(a.status === 'done') - Number(b.status === 'done') ||
          a.dueDate.localeCompare(b.dueDate) ||
          a.jobNo.localeCompare(b.jobNo),
      )
  }, [rowsNow, lens, needle])

  const live = rowsNow
  // 缺图只算还要动手的那些 —— 编都编完了, 再提"缺图"是噪音。
  const noDrawing = live.filter(
    (r) =>
      r.status !== 'done' &&
      (dByPart.get(partRef(r.jobId, r.componentId)) ?? []).length === 0,
  ).length
  const counts = {
    all: live.length,
    ready: live.filter(
      (r) => r.upstreamReady && r.status === 'pending',
    ).length,
    doing: live.filter((r) => r.status === 'in_progress').length,
    waiting: live.filter((r) => !r.upstreamReady && r.status !== 'done').length,
    done: live.filter((r) => r.status === 'done').length,
  }

  return (
    <main className="w-full flex-1 px-4 py-6 md:px-10 md:py-8">
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-5">
        <div>
          <h2 className="text-[26px] font-semibold tracking-tight text-[var(--color-ink)]">
            编程
          </h2>
          <p className="mt-2 text-[13px] text-[var(--color-ink-2)]">
            {counts.all - counts.done} 个件要编
            {counts.done > 0 && (
              <>
                <span className="mx-1.5 text-[var(--color-ink-4)]">·</span>
                <span className="text-[var(--color-success)]">
                  {counts.done} 个已编好
                </span>
              </>
            )}
            {noDrawing > 0 ? (
              <>
                <span className="mx-1.5 text-[var(--color-ink-4)]">·</span>
                <span className="text-[var(--color-overdue)]">
                  {noDrawing} 个还没有图纸
                </span>
              </>
            ) : counts.all > 0 ? (
              <>
                <span className="mx-1.5 text-[var(--color-ink-4)]">·</span>
                <span className="text-[var(--color-success)]">图纸都齐了</span>
              </>
            ) : null}
            {hiddenJobs > 0 && (
              <>
                <span className="mx-1.5 text-[var(--color-ink-4)]">·</span>
                <span title="按交期排, 先摊开最急的那几张">
                  另有 {hiddenJobs} 张单交期更远, 暂未摊开
                </span>
              </>
            )}
          </p>
          {loadError && (
            <p className="mt-1.5 text-[12px] text-[var(--color-overdue)]">
              有一段数据没读到 ({loadError}) — 刷新一次再看
            </p>
          )}
          {/* 商务号能看图、能出程序单, 但点不了工段 (报工要记在真正动手的那
              个人头上, 见 lib/auth 的 COMMERCE_STAGE_SCOPE)。不说明白的话,
              按钮那一格就是空的 —— 人会以为功能坏了。 */}
          {!canReport && (
            <p className="mt-1.5 text-[12px] text-[var(--color-ink-3)]">
              这个账号可以看图、传图、出程序单;「开始 / 编好了」要用工段账号
              (编程 / 工程) 点 —— 报工记的是真正动手的那个人。
            </p>
          )}
        </div>
        <div className="w-[280px]">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜 · 工号 / 零件 / 料号"
            className="w-full border-b border-[var(--color-border-strong)] bg-transparent py-2 text-[13px] text-[var(--color-ink)] placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-ink)] focus:outline-none"
          />
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2">
        {(
          [
            ['all', '全部', counts.all],
            ['ready', '能编', counts.ready],
            ['doing', '在编', counts.doing],
            ['waiting', '等上游', counts.waiting],
            ['done', '已编', counts.done],
          ] as [Lens, string, number][]
        ).map(([k, label, n]) => (
          <button
            key={k}
            type="button"
            onClick={() => setLens(k)}
            className={`text-[14px] tracking-tight transition-colors ${
              lens === k
                ? 'font-semibold text-[var(--color-ink)]'
                : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
            }`}
          >
            {label}
            <span className="mono ml-1.5 text-[11px] text-[var(--color-ink-3)]">
              {n}
            </span>
          </button>
        ))}
        <span className="ml-auto flex items-baseline gap-4">
          <button
            type="button"
            onClick={resetAll}
            title="每一列回到默认宽度"
            className="text-[12px] text-[var(--color-ink-3)] underline underline-offset-2 hover:text-[var(--color-ink)]"
          >
            列宽复位
          </button>
          <Link
            href="/?stage=编程"
            className="text-[12px] text-[var(--color-ink-3)] underline underline-offset-2 hover:text-[var(--color-ink)]"
          >
            工段看板 →
          </Link>
        </span>
      </div>

      <HowTo />

      <div className="mt-5 overflow-x-auto">
        <div ref={rootRef} style={{ minWidth }}>
          <ResizableHeader
            cols={COLS}
            template={template}
            startResize={startResize}
            resetCol={resetCol}
          />
        {visible.length === 0 ? (
          <p className="border-b border-[var(--color-border)] py-16 text-center text-[13px] text-[var(--color-ink-3)]">
            {needle || lens !== 'all' ? '没有匹配的件' : '没有要编的件'}
          </p>
        ) : (
          visible.map((r) => {
            const ref = partRef(r.jobId, r.componentId)
            const parts = dByPart.get(ref) ?? []
            const progs = pByPart.get(ref) ?? []
            const expanded = open === ref
            return (
              <div
                key={ref}
                className="border-b border-[var(--color-border)] last:border-b-0"
              >
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setOpen((cur) => (cur === ref ? null : ref))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setOpen((cur) => (cur === ref ? null : ref))
                    }
                  }}
                  style={{ gridTemplateColumns: template }}
                  className={`grid cursor-pointer items-start gap-x-4 px-3 py-3 transition-colors ${
                    expanded ? 'bg-[#f1eee4]' : 'hover:bg-[#f1eee4]'
                  } ${r.status === 'done' ? 'opacity-65' : ''}`}
                >
                  <span className="mono min-w-0 break-all text-[12.5px] leading-snug text-[var(--color-ink-2)]">
                    {r.jobNo}
                  </span>
                  <div className="flex min-w-0 flex-col leading-tight">
                    <span className="break-words text-[14px] font-medium text-[var(--color-ink)]">
                      {r.name}
                      {r.partNo && (
                        <span className="mono ml-2 text-[11.5px] font-normal text-[var(--color-ink-3)]">
                          {r.partNo}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 break-words text-[11.5px] text-[var(--color-ink-3)]">
                      {[r.material, `${r.qty} 件`, r.process]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </div>

                  {/* 图纸 —— 没图是编不动的, 所以这一格是红的 */}
                  <span className="min-w-0 break-words text-[12.5px] leading-snug">
                    {parts.length > 0 ? (
                      <span className="text-[var(--color-ink-2)]">
                        图纸 {parts.length}
                      </span>
                    ) : r.status === 'done' ? (
                      <span className="text-[var(--color-ink-4)]">无图纸</span>
                    ) : (
                      <span className="text-[var(--color-overdue)]">缺图纸</span>
                    )}
                    {!r.upstreamReady && r.status !== 'done' && (
                      <span
                        className="mt-0.5 block text-[11px] text-[var(--color-ink-4)]"
                        title="工程还没点完成 — 图可以先看先传, 程序也可以先出"
                      >
                        等工程
                      </span>
                    )}
                  </span>

                  {/* 程序 —— 出了就把程序号摆出来, 操机认的就是这个 */}
                  <span className="mono min-w-0 break-all text-[12.5px] leading-snug">
                    {progs.length > 0 ? (
                      <span className="text-[var(--color-ink)]">
                        {progs.map((p) => p.no).join(' · ')}
                      </span>
                    ) : (
                      <span className="text-[var(--color-ink-4)]">未出程序</span>
                    )}
                  </span>

                  {r.status === 'done' ? (
                    // 已编 —— 这一格不再说交期 (它已经不催了), 说的是谁哪天
                    // 编好的。"编程做完没有"这句话的答案就在这里。
                    <div className="flex min-w-0 flex-col items-end leading-tight">
                      <span className="text-[12.5px] text-[var(--color-success)]">
                        已编好
                      </span>
                      <span className="label mt-0.5 break-words text-right text-[var(--color-ink-3)]">
                        {[r.doneBy, r.doneAt?.slice(-5)]
                          .filter(Boolean)
                          .join(' · ') || '—'}
                      </span>
                    </div>
                  ) : (
                    <DueCol dueDate={r.dueDate} />
                  )}

                  <span
                    className="text-right"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {canReport ? (
                      <ReportButton
                        row={r}
                        hasProgram={progs.length > 0}
                        onDone={(who) =>
                          setJustDone((m) => new Map(m).set(ref, who))
                        }
                      />
                    ) : (
                      <span
                        className="text-[11px] text-[var(--color-ink-4)]"
                        title="报工要用工段账号 (编程 / 工程)"
                      >
                        {r.status === 'in_progress' ? '在编' : '待编'}
                      </span>
                    )}
                  </span>
                </div>

                {expanded && (
                  <div className="bg-[#faf8f3] px-3 pb-1">
                    {/* 工单页上那同一块面板 —— 一处改, 两处都对。 */}
                    <PartBlock
                      jobId={r.jobId}
                      part={{
                        componentId: r.componentId,
                        seq: '',
                        name: r.name,
                        qty: r.qty,
                        partNo: r.partNo,
                        material: r.material,
                        process: r.process,
                        surfaceTreatment: r.surfaceTreatment,
                        notes: r.note,
                        imageUrl: r.imageUrl,
                      }}
                      drawings={parts}
                      programs={progs}
                      reusable={progs.length === 0 ? r.reusable : []}
                      canUpload={canUpload}
                      canWrite={canWrite}
                      onDrawingAdded={(d) => setFiles((prev) => [d, ...prev])}
                      onDrawingRemoved={(id) =>
                        setFiles((prev) => prev.filter((x) => x.id !== id))
                      }
                      onProgramAdded={(p) => setPrograms((prev) => [...prev, p])}
                      onProgramRemoved={(id) =>
                        setPrograms((prev) => prev.filter((x) => x.id !== id))
                      }
                    />
                    <p className="pb-3 text-[12px]">
                      <Link
                        href={`/jobs/${r.jobId}`}
                        className="text-[var(--color-ink-3)] underline underline-offset-2 hover:text-[var(--color-ink)]"
                      >
                        打开整张工单 →
                      </Link>
                    </p>
                  </div>
                )}
              </div>
            )
          })
        )}
        </div>
      </div>
    </main>
  )
}

// 编程怎么走一遍 —— 默认收着。一张工作台如果需要一本说明书, 那是台子没做好;
// 但一条新流程刚上线的头几周, 人确实要一个地方对一下顺序。所以它在这里, 收
// 起来只占一行字, 展开是五句话, 不是一页文档。
function HowTo() {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-[12px] text-[var(--color-ink-3)] underline underline-offset-2 hover:text-[var(--color-ink)]"
      >
        {open ? '收起流程' : '编程怎么走一遍'}
      </button>
      {open && (
        <ol className="mt-2 max-w-[720px] space-y-1.5 border-l-2 border-[var(--color-border)] pl-4 text-[12.5px] leading-relaxed text-[var(--color-ink-2)]">
          <li>
            <b className="text-[var(--color-ink)]">① 看图看料。</b>
            点开一行, 材质 · 数量 · 加工方式 · 表面处理都在上面, 图纸点文件名
            就下载 (三维和二维都在)。<span className="text-[var(--color-overdue)]">缺图纸</span>
            就找商务或工程要 —— 他们在这里也能直接传。
          </li>
          <li>
            <b className="text-[var(--color-ink)]">② 看以前编过没有。</b>
            同一个件半年前来过, 这里会写「这个件以前编过」, 点「带过来」把上回的
            程序号 · 机床 · 刀具原样搬来, 不用重编。
          </li>
          <li>
            <b className="text-[var(--color-ink)]">③ 点「开始」。</b>
            全厂就知道这个件在你手上了。上游工程还没点完成的, 这一行写着「等工
            程」—— 图可以先看先传, 开始会问你一句。商务号看得到这一页、也能出
            程序单, 但点不了这个按钮 (报工得记在动手的人头上)。
          </li>
          <li>
            <b className="text-[var(--color-ink)]">④ 出程序单。</b>
            刀路照旧在 UG 里做、程序照旧存共享盘; 回到这里把
            <b> 程序号 · 机床 · 装夹 · 刀具 · 单件分钟</b> 填上。这几个字是给操
            机看的 —— 他在机台前照着调程序、备刀, 不用再回头找你。
          </li>
          <li>
            <b className="text-[var(--color-ink)]">⑤ 点「编好了」。</b>
            操机站立刻看到活来了。程序号还没填就报完成, 会先问你一句。
          </li>
          <li>
            <b className="text-[var(--color-ink)]">怎么知道编好了没有。</b>
            上面那排口子里的<b>「已编」</b>就是答案 —— 谁哪天编好的、出的哪几
            个程序号, 都写在行上。编好的件不会从这一页消失, 只是淡下去沉到底
            部。整张工单的编程进度, 也可以在看板的「编程」那一列上一眼看到。
          </li>
        </ol>
      )}
    </div>
  )
}

function DueCol({ dueDate }: { dueDate: string }) {
  const ds: DueState = dueState(dueDate)
  const days = daysFromToday(dueDate)
  const tone =
    ds === 'overdue'
      ? 'text-[var(--color-overdue)]'
      : ds === 'today'
        ? 'text-[var(--color-warning)]'
        : 'text-[var(--color-ink)]'
  return (
    <div className="flex min-w-0 flex-col items-end leading-tight">
      <span className={`mono text-[12.5px] ${tone}`}>{dueDate || '—'}</span>
      {dueDate && (
        <span className="label mt-0.5 text-[var(--color-ink-3)]">
          {ds === 'overdue'
            ? `逾期 ${Math.abs(days)} 天`
            : ds === 'today'
              ? '今天'
              : `${days} 天`}
        </span>
      )}
    </div>
  )
}

// 开始 / 编好了 —— 跟工段看板上点的是同一个动作, 所以报工、看板、下游站台
// 立刻都对得上。没出程序就点完成会先问一句: 程序号没进系统, 操机还是得来问人。
function ReportButton({
  row,
  hasProgram,
  onDone,
}: {
  row: DeskRow
  hasProgram: boolean
  onDone: (who: string) => void
}) {
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const run = (kind: 'startStage' | 'finishStage') => {
    setError(null)
    start(async () => {
      try {
        await mutate({
          kind,
          jobId: row.jobId,
          componentId: row.componentId,
          stage: '编程',
        })
        if (kind === 'finishStage') onDone('刚才')
      } catch (e) {
        setError(e instanceof Error ? e.message : '报工失败')
      }
    })
  }

  if (error)
    return (
      <span className="text-[11px] text-[var(--color-overdue)]">{error}</span>
    )

  // 已经编好的不再给按钮 —— 右边那一格已经写着"已编好 · 谁 · 哪天"。要退回
  // 去改, 走工段看板的撤销 (那是名单制的动作, 不该藏在这一页的一个小按钮里)。
  if (row.status === 'done') return null

  if (row.status === 'pending')
    return (
      <button
        type="button"
        disabled={pending}
        title={
          row.upstreamReady
            ? undefined
            : '工程这一站还没点完成 — 现在开始会把它一起标完成'
        }
        onClick={() => {
          // 系统的规矩是"我在做, 前面的就算做完了"(开始一道工序会把上游一并
          // 标完成)。那在这里得说出来 —— 编程员替工程点完成这件事, 应该是他
          // 知情之后按的, 不是顺手带出来的。
          if (
            !row.upstreamReady &&
            !confirm('工程这一站还没点完成。现在开始, 会把工程一起标完成。确定?')
          )
            return
          run('startStage')
        }}
        className="rounded-[2px] border border-[var(--color-border-strong)] px-2.5 py-1 text-[12px] text-[var(--color-ink-2)] transition-colors hover:text-[var(--color-ink)] disabled:opacity-40"
      >
        {pending ? '…' : '开始'}
      </button>
    )

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (
          !hasProgram &&
          !confirm('程序号还没进系统 — 操机在机台前还是得来问你。确定报完成?')
        )
          return
        run('finishStage')
      }}
      className="rounded-[2px] bg-[var(--color-ink)] px-2.5 py-1 text-[12px] text-[var(--color-surface)] transition-opacity hover:opacity-80 disabled:opacity-40"
    >
      {pending ? '…' : '编好了'}
    </button>
  )
}
