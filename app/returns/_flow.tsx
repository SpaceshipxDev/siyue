'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { withBase } from '@/lib/base-path'
import { mutate } from '@/lib/mutate'
import {
  returnStep,
  RETURN_STEP_LABEL,
  RETURN_STEP_OWNER,
  type ReturnFlow,
} from '@/lib/return-flow'
import type { ReturnDeskRow } from './_view'

// 退货流转单 —— 一条退货从客户打电话回来到再发出去, 中间要过谁的手, 这一栏
// 从上往下就是那个顺序。一段一行字, 一个人签一格:
//
//   ① 退货登记  商务 (已经填过了, 这里只是摆出来给下面几个人看)
//   ② 处理方案  工程
//   ③ 原因调查  质量
//   ④ 下发返工  工程 → 打一张返工工单交到车间
//   ⑤ 返工入库  生产
//   ⑥ 制作出货单 商务
//   ⑦ 结案
//
// 该谁签的格子只有谁能点 —— 处理方案是工程的判断, 原因调查是质量的结论, 两
// 个人的名字串了, 这张单以后就不能当凭据用。轮不到你的那几格是灰的文字, 不
// 是禁用的按钮: 灰字告诉你在等谁, 禁用的按钮只让人想再点一次。

export function ReturnFlowPanel({
  row,
  perms,
}: {
  row: ReturnDeskRow
  perms: {
    plan: boolean
    cause: boolean
    rework: boolean
    ship: boolean
  }
}) {
  const router = useRouter()
  const [flow, setFlow] = useState<ReturnFlow | undefined>(row.flow)
  const step = returnStep(flow)
  const totalQty = row.parts.reduce((s, p) => s + p.qty, 0)

  const save = async (entry: Record<string, unknown>) => {
    const res = await mutate<ReturnFlow>({
      kind: 'setReturnFlow',
      returnId: row.ret.id,
      entry,
    })
    if (res.data) setFlow(res.data)
    router.refresh()
  }

  return (
    <div className="border-t border-[var(--color-border)] bg-[#faf8f3] px-5 py-5">
      <div className="mx-auto max-w-[760px]">
        {/* ① 退货登记 —— 商务已经填过的那几笔, 摆出来给下面的人看。 */}
        <Section
          n="1"
          title="退货登记"
          owner="商务"
          done
          sign={signature(row.ret.createdBy, row.ret.createdAt)}
        >
          <p className="text-[13px] leading-relaxed text-[var(--color-ink)]">
            {row.parts.map((p) => `${p.name} ${p.qty}件`).join(' · ')}
          </p>
          <p className="mt-1.5 text-[13px] text-[var(--color-ink-2)]">
            不良原因 · {row.ret.reason}
            {row.ret.reasonText ? ` — ${row.ret.reasonText}` : ''}
          </p>
          <p className="mt-1 text-[13px] text-[var(--color-ink-2)]">
            二次交期 · <span className="mono">{row.ret.dueDate}</span>
          </p>
        </Section>

        {/* ② 处理方案 —— 工程 */}
        <WriteSection
          n="2"
          title="处理方案"
          owner="工程"
          placeholder="这批件怎么救 — 返修哪几道 / 报废重做 / 让步接收"
          value={flow?.plan}
          sign={signature(flow?.planBy, flow?.planAt)}
          canWrite={perms.plan}
          onSave={(text) => save({ kind: 'plan', text })}
        />

        {/* ③ 原因调查 —— 质量 */}
        <WriteSection
          n="3"
          title="原因调查"
          owner="质量"
          placeholder="为什么会出这个不良, 以后怎么不再出"
          value={flow?.cause}
          sign={signature(flow?.causeBy, flow?.causeAt)}
          canWrite={perms.cause}
          onSave={(text) => save({ kind: 'cause', text })}
        />

        {/* ④ 下发返工 —— 方案和调查都有了才轮到这一步, 车间要的是那张纸。 */}
        <Section
          n="4"
          title="下发返工"
          owner="工程"
          done={!!flow?.releasedAt}
          sign={signature(flow?.releasedBy, flow?.releasedAt)}
        >
          {flow?.releasedAt ? (
            <PrintLink id={row.ret.id}>重新打印返工工单</PrintLink>
          ) : !flow?.plan || !flow?.cause ? (
            <p className="text-[13px] text-[var(--color-ink-3)]">
              等{!flow?.plan ? '工程填处理方案' : '质量填原因调查'}
            </p>
          ) : perms.rework ? (
            <ActionButton
              label="下发返工工单"
              onRun={async () => {
                await save({ kind: 'release' })
                window.open(
                  withBase(`/returns/${row.ret.id}/print`),
                  '_blank',
                  'noopener',
                )
              }}
            />
          ) : (
            <p className="text-[13px] text-[var(--color-ink-3)]">等工程下发</p>
          )}
        </Section>

        {/* ⑤ 返工入库 —— 生产做完了, 几件回到成品。 */}
        <Section
          n="5"
          title="返工入库"
          owner="生产"
          done={!!flow?.stockedAt}
          sign={signature(flow?.stockedBy, flow?.stockedAt)}
        >
          {flow?.stockedAt ? (
            <p className="text-[13px] text-[var(--color-ink)]">
              入库 {flow.stockedQty ?? totalQty} 件
            </p>
          ) : !flow?.releasedAt ? (
            <p className="text-[13px] text-[var(--color-ink-3)]">等下发返工</p>
          ) : perms.rework ? (
            <StockRow
              defaultQty={totalQty}
              onRun={(qty) => save({ kind: 'stock', qty })}
            />
          ) : (
            <p className="text-[13px] text-[var(--color-ink-3)]">等返工入库</p>
          )}
        </Section>

        {/* ⑥ 制作出货单 —— 返工好的件再发一次, 客户要一张新的交货单。 */}
        <Section
          n="6"
          title="制作出货单"
          owner="商务"
          done={!!flow?.shippedAt}
          sign={signature(flow?.shippedBy, flow?.shippedAt)}
        >
          {flow?.shippedAt ? (
            <a
              href={withBase(
                `/jobs/${row.ret.jobId}/print/shipping${
                  flow.shipmentId ? `?shipment=${flow.shipmentId}` : ''
                }`,
              )}
              target="_blank"
              rel="noopener"
              className="text-[13px] text-[var(--color-ink-2)] underline underline-offset-2 hover:text-[var(--color-ink)]"
            >
              查看出货单
            </a>
          ) : !flow?.stockedAt ? (
            <p className="text-[13px] text-[var(--color-ink-3)]">等返工入库</p>
          ) : perms.ship ? (
            <ReworkShipping row={row} onDone={() => router.refresh()} />
          ) : (
            <p className="text-[13px] text-[var(--color-ink-3)]">等商务出货</p>
          )}
        </Section>

        {/* ⑦ 结案 */}
        <div className="mt-6 flex items-center justify-between gap-4 border-t border-[var(--color-border)] pt-4">
          <p className="text-[12px] text-[var(--color-ink-3)]">
            {step === 'done'
              ? '走完了 — 可以结案'
              : `当前 · ${RETURN_STEP_LABEL[step]} (等${RETURN_STEP_OWNER[step]})`}
          </p>
          {perms.rework && (
            <CloseButton returnId={row.ret.id} ready={step === 'done'} />
          )}
        </div>
      </div>
    </div>
  )
}

// ── 一段 ──────────────────────────────────────────────────────────────────

function Section({
  n,
  title,
  owner,
  done,
  sign,
  children,
}: {
  n: string
  title: string
  owner: string
  done: boolean
  sign?: string
  children: React.ReactNode
}) {
  return (
    <section className="flex gap-4 border-b border-[var(--color-border)] py-4 last:border-b-0">
      <span
        className={`mono mt-[2px] flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-full text-[11px] ${
          done
            ? 'bg-[var(--color-ink)] text-[var(--color-surface)]'
            : 'border border-[var(--color-border-strong)] text-[var(--color-ink-3)]'
        }`}
      >
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 flex items-baseline gap-2">
          <span className="text-[13px] font-medium text-[var(--color-ink)]">
            {title}
          </span>
          <span className="label text-[var(--color-ink-3)]">{owner}</span>
          {sign && (
            <span className="ml-auto shrink-0 text-[11px] tabular-nums text-[var(--color-ink-3)]">
              {sign}
            </span>
          )}
        </div>
        {children}
      </div>
    </section>
  )
}

// 一格字 —— 点着就能改, 存下就是签名。跟工单页上的 inline edit 一个手势。
function WriteSection({
  n,
  title,
  owner,
  placeholder,
  value,
  sign,
  canWrite,
  onSave,
}: {
  n: string
  title: string
  owner: string
  placeholder: string
  value?: string
  sign?: string
  canWrite: boolean
  onSave: (text: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(value ?? '')
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const commit = () => {
    setError(null)
    start(async () => {
      try {
        await onSave(text)
        setEditing(false)
      } catch (e) {
        setError(e instanceof Error ? e.message : '保存失败')
      }
    })
  }

  return (
    <Section n={n} title={title} owner={owner} done={!!value} sign={sign}>
      {editing ? (
        <div>
          <textarea
            autoFocus
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={placeholder}
            className="w-full resize-y rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 py-2 text-[13px] leading-relaxed text-[var(--color-ink)] placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-ink)] focus:outline-none"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={commit}
              disabled={pending}
              className="rounded-[2px] bg-[var(--color-ink)] px-3 py-1.5 text-[12px] tracking-wider text-[var(--color-surface)] hover:opacity-80 disabled:opacity-40"
            >
              {pending ? '保存中…' : '保存'}
            </button>
            <button
              type="button"
              onClick={() => {
                setText(value ?? '')
                setEditing(false)
              }}
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
      ) : value ? (
        <p
          className={`whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--color-ink)] ${
            canWrite ? 'cursor-text hover:opacity-70' : ''
          }`}
          onClick={() => canWrite && setEditing(true)}
        >
          {value}
        </p>
      ) : canWrite ? (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-[13px] text-[var(--color-ink-3)] underline underline-offset-2 hover:text-[var(--color-ink)]"
        >
          {placeholder}
        </button>
      ) : (
        <p className="text-[13px] text-[var(--color-ink-3)]">等{owner}填</p>
      )}
    </Section>
  )
}

function ActionButton({
  label,
  onRun,
}: {
  label: string
  onRun: () => Promise<void>
}) {
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setError(null)
          start(async () => {
            try {
              await onRun()
            } catch (e) {
              setError(e instanceof Error ? e.message : '操作失败')
            }
          })
        }}
        className="rounded-[2px] bg-[var(--color-ink)] px-3 py-1.5 text-[12px] tracking-wider text-[var(--color-surface)] hover:opacity-80 disabled:opacity-40"
      >
        {pending ? '处理中…' : label}
      </button>
      {error && (
        <span className="text-[12px] text-[var(--color-overdue)]">{error}</span>
      )}
    </div>
  )
}

function StockRow({
  defaultQty,
  onRun,
}: {
  defaultQty: number
  onRun: (qty: number) => Promise<void>
}) {
  const [qty, setQty] = useState(defaultQty)
  return (
    <div className="flex items-center gap-3">
      <label className="flex items-baseline gap-2 text-[13px] text-[var(--color-ink-2)]">
        入库
        <input
          type="number"
          min={0}
          value={qty}
          onChange={(e) => setQty(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
          className="mono w-[64px] border-b border-[var(--color-border-strong)] bg-transparent py-0.5 text-right text-[13px] text-[var(--color-ink)] focus:border-[var(--color-ink)] focus:outline-none"
        />
        件
      </label>
      <ActionButton label="确认入库" onRun={() => onRun(qty)} />
    </div>
  )
}

// 返工后的补发 —— 只列这次退回的零件, 数量默认就是退回的数量。
function ReworkShipping({
  row,
  onDone,
}: {
  row: ReturnDeskRow
  onDone: () => void
}) {
  const [open, setOpen] = useState(false)
  const [picks, setPicks] = useState<Record<string, number>>(() =>
    Object.fromEntries(row.parts.map((p) => [p.componentId, p.qty])),
  )
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-[2px] bg-[var(--color-ink)] px-3 py-1.5 text-[12px] tracking-wider text-[var(--color-surface)] hover:opacity-80"
      >
        制作出货单
      </button>
    )

  const submit = () => {
    setError(null)
    const selections = row.parts
      .map((p) => ({ componentId: p.componentId, qty: picks[p.componentId] ?? 0 }))
      .filter((s) => s.qty > 0)
    if (selections.length === 0) {
      setError('请至少填一个数量')
      return
    }
    start(async () => {
      try {
        await mutate({
          kind: 'prepareShipping',
          jobId: row.ret.jobId,
          selections,
          returnId: row.ret.id,
        })
        window.open(
          withBase(`/jobs/${row.ret.jobId}/print/shipping`),
          '_blank',
          'noopener',
        )
        setOpen(false)
        onDone()
      } catch (e) {
        setError(e instanceof Error ? e.message : '提交失败')
      }
    })
  }

  return (
    <div className="rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-2.5">
      {row.parts.map((p) => (
        <div
          key={p.componentId}
          className="flex items-baseline justify-between gap-4 border-b border-[var(--color-border)] py-1.5 last:border-b-0"
        >
          <span className="min-w-0 truncate text-[13px] text-[var(--color-ink)]">
            {p.name}
          </span>
          <span className="flex shrink-0 items-baseline gap-1.5">
            <input
              type="number"
              min={0}
              max={p.qty}
              value={picks[p.componentId] ?? 0}
              onChange={(e) =>
                setPicks((prev) => ({
                  ...prev,
                  [p.componentId]: Math.max(
                    0,
                    Math.min(p.qty, Math.floor(Number(e.target.value) || 0)),
                  ),
                }))
              }
              className="mono w-[56px] border-b border-[var(--color-border-strong)] bg-transparent py-0.5 text-right text-[13px] focus:border-[var(--color-ink)] focus:outline-none"
            />
            <span className="text-[11px] text-[var(--color-ink-3)]">
              / 退回 {p.qty}
            </span>
          </span>
        </div>
      ))}
      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={pending}
          className="rounded-[2px] bg-[var(--color-ink)] px-3 py-1.5 text-[12px] tracking-wider text-[var(--color-surface)] hover:opacity-80 disabled:opacity-40"
        >
          {pending ? '开单中…' : '开出货单'}
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
          <span className="text-[12px] text-[var(--color-overdue)]">{error}</span>
        )}
      </div>
    </div>
  )
}

function CloseButton({ returnId, ready }: { returnId: string; ready: boolean }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (
          !confirm(
            ready
              ? '确认结案?这条退货将移到已完成。'
              : '流程还没走完 — 确定要提前结案吗?',
          )
        )
          return
        start(async () => {
          await mutate({ kind: 'closeReturn', returnId })
          router.refresh()
        })
      }}
      className={`rounded-[2px] px-3 py-1.5 text-[12px] tracking-wider transition-colors disabled:opacity-40 ${
        ready
          ? 'bg-[var(--color-ink)] text-[var(--color-surface)] hover:opacity-80'
          : 'border border-[var(--color-border-strong)] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
      }`}
    >
      {pending ? '结案中…' : '结案'}
    </button>
  )
}

function PrintLink({
  id,
  children,
}: {
  id: string
  children: React.ReactNode
}) {
  return (
    <a
      href={withBase(`/returns/${id}/print`)}
      target="_blank"
      rel="noopener"
      className="text-[13px] text-[var(--color-ink-2)] underline underline-offset-2 hover:text-[var(--color-ink)]"
    >
      {children}
    </a>
  )
}

/** 「张三 · 09-08」 — 谁签的、哪天签的。 */
function signature(by?: string, at?: string): string | undefined {
  if (!by && !at) return undefined
  const day = at ? at.slice(5, 10) : ''
  return [by, day].filter(Boolean).join(' · ')
}
