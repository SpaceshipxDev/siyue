'use client'

import { Fragment, useCallback, useMemo, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { withBase } from '@/lib/base-path'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'
import { formatCny } from '@/lib/data'
import { DatePop } from '@/app/_datepop'
import { usePasteImage } from '@/app/_paste_image'
import { proxiedStorageUrl } from '@/lib/storage-url'
import {
  settleOutstanding,
  settleOverdueDays,
  settlePaid,
  settleStatus,
  type PayablePayment,
  type PaymentProof,
  type SettleStatus,
} from '@/lib/settle-shared'

// 应收 / 应付 — 对账单认下来之后落下的每一张单, 和它名下的每一笔收/付款。
//
// 两条对称的线, 一个页面样子:
//   应收: 对账 → 审批 → 这里 (等客户的钱回来)
//   应付: 对账 · 供应商 → 确认 → 这里 (我们付给外协的钱)
//
// 一张单一行, 看的是"还差多少、拖了几天"; 点开记一笔, 余额自己减掉, 结清了
// 这一行就沉下去。默认只看没结清的 —— 这一页每天打开要回答的就一个问题。
//
// 应付多一样: 付款凭证。传一张回单上来, 机器先把日期、金额、摘要读出来填
// 好, 人看一眼对不对再点「记付款」, 那张回单就挂在这一笔上。

export type SettleKind = 'receivable' | 'payable'

/** 列表上的一张单 —— 应收单和应付单摊平成同一个样子 (party = 客户 / 供应商)。 */
export type SettleRow = {
  id: string
  no: string
  party: string
  period: string
  amountCny: number
  lineCount: number
  totalQty: number
  approvedBy: string
  approvedAt: string
  dueDate: string
  payments: PayablePayment[]
  voidedAt?: string
  voidedBy?: string
}

const COPY = {
  receivable: {
    no: '应收单号',
    party: '客户',
    amount: '应收',
    paid: '已回款',
    left: '未收',
    total: '未收合计',
    monthPaid: '月回款',
    filterOpen: '未收清',
    status: {
      open: '未回款',
      partial: '部分回款',
      overdue: '逾期',
      paid: '已收清',
      void: '已作废',
    } as Record<SettleStatus, string>,
    noPay: '还没有回款',
    act: '记回款',
    amountPh: '回款金额',
    notePh: '备注 · 转账 / 承兑…',
    over: '比未收多了',
    by: '审批',
    emptyNone: '还没有应收单 —— 到「对账」里选一个客户，审批通过就会落在这里',
    emptyClear: '钱都收清了',
    sheetKind: '',
    idKey: 'receivableId',
    addKind: 'addReceivablePayment',
    delKind: 'deleteReceivablePayment',
    voidKind: 'voidReceivable',
    foot:
      '每一张都是在「对账」里审批通过的那张对账单——金额是审批那一刻的合计，之后出货单再改也不会跟着变。约定回款日是审批后 30 天，过了就标逾期。',
  },
  payable: {
    no: '应付单号',
    party: '供应商',
    amount: '应付',
    paid: '已付',
    left: '未付',
    total: '未付合计',
    monthPaid: '月付款',
    filterOpen: '未付清',
    status: {
      open: '未付款',
      partial: '部分付款',
      overdue: '逾期',
      paid: '已付清',
      void: '已作废',
    } as Record<SettleStatus, string>,
    noPay: '还没有付款',
    act: '记付款',
    amountPh: '付款金额',
    notePh: '备注 · 哪个账户 / 用途…',
    over: '比未付多了',
    by: '确认',
    emptyNone: '还没有应付单 —— 到「对账 · 供应商」里选一家，确认无误就会落在这里',
    emptyClear: '都付清了',
    sheetKind: 'vendor',
    idKey: 'payableId',
    addKind: 'addPayablePayment',
    delKind: 'deletePayablePayment',
    voidKind: 'voidPayable',
    foot:
      '每一张都是在「对账 · 供应商」里确认过的外协对账单——金额是确认那一刻的合计。约定付款日是确认后 30 天。付款时传一张回单，日期金额会自己填好，那张回单就挂在这笔付款上。',
  },
} as const

const COLS =
  'grid-cols-[minmax(0,1fr)_76px] md:grid-cols-[112px_minmax(0,1fr)_72px_104px_104px_104px_96px]'

type Filter = 'open' | 'all'

export function SettleBoard({
  kind,
  rows,
  todayStr,
  canEdit,
  openId,
}: {
  kind: SettleKind
  rows: SettleRow[]
  todayStr: string
  /** 记一笔 / 删一笔 / 作废 —— 管钱那一档 (lib/auth canSettleAccounts)。 */
  canEdit: boolean
  /** 从对账页「去应收/去应付 →」进来时直接摊开的那一张。 */
  openId?: string
}) {
  const c = COPY[kind]
  const [filter, setFilter] = useState<Filter>(() => {
    // 从对账页点过来的那张要是已经结清了, 默认筛选会把它藏掉 —— 那就看全部。
    const target = openId ? rows.find((r) => r.id === openId) : undefined
    return target && settleStatus(target, todayStr) === 'paid' ? 'all' : 'open'
  })
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<string | null>(openId ?? null)

  const month = todayStr.slice(0, 7)

  const stats = useMemo(() => {
    let outstanding = 0
    let overdue = 0
    let paidThisMonth = 0
    for (const r of rows) {
      if (r.voidedAt) continue
      outstanding += settleOutstanding(r)
      if (settleStatus(r, todayStr) === 'overdue') overdue += 1
      for (const p of r.payments) {
        if (p.date.slice(0, 7) === month) paidThisMonth += p.amountCny
      }
    }
    return {
      outstanding: Math.round(outstanding * 100) / 100,
      overdue,
      paidThisMonth: Math.round(paidThisMonth * 100) / 100,
    }
  }, [rows, todayStr, month])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return rows.filter((r) => {
      const st = settleStatus(r, todayStr)
      if (filter === 'open' && (st === 'paid' || st === 'void')) return false
      if (!needle) return true
      return [r.no, r.party, r.period].join(' ').toLowerCase().includes(needle)
    })
  }, [rows, filter, q, todayStr])

  return (
    <div>
      <div className="mb-8 flex flex-wrap items-end gap-x-10 gap-y-4">
        <div>
          <p className="text-[32px] font-semibold leading-none tracking-tight tabular-nums text-[var(--color-overdue)]">
            {formatCny(stats.outstanding)}
          </p>
          <p className="label mt-2.5">{c.total}</p>
        </div>
        <div>
          <p
            className={`text-[22px] font-semibold leading-none tracking-tight tabular-nums ${
              stats.overdue > 0 ? 'text-[var(--color-overdue)]' : 'text-[var(--color-ink-3)]'
            }`}
          >
            {stats.overdue}
          </p>
          <p className="label mt-2.5">逾期</p>
        </div>
        <div>
          <p className="text-[22px] font-semibold leading-none tracking-tight tabular-nums text-[var(--color-ink)]">
            {formatCny(stats.paidThisMonth)}
          </p>
          <p className="label mt-2.5">
            {Number(month.slice(5))}
            {c.monthPaid}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-4">
          <div className="flex items-baseline gap-4">
            {(['open', 'all'] as Filter[]).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`text-[13.5px] tracking-tight transition-colors ${
                  filter === f
                    ? 'font-semibold text-[var(--color-ink)]'
                    : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
                }`}
              >
                {f === 'open' ? c.filterOpen : '全部'}
              </button>
            ))}
          </div>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`搜索 · ${c.party} / 单号`}
            className="h-9 w-[180px] rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div
          className={`hidden ${COLS} items-center gap-3 border-b border-[var(--color-border)] bg-[#f5f3ed] px-5 py-2 md:grid`}
        >
          <span className="label">{c.no}</span>
          <span className="label">{c.party}</span>
          <span className="label">期间</span>
          <span className="label text-right">{c.amount}</span>
          <span className="label text-right">{c.paid}</span>
          <span className="label text-right">{c.left}</span>
          <span className="label text-right">状态</span>
        </div>

        {shown.length === 0 ? (
          <p className="px-5 py-12 text-center text-[13px] leading-relaxed text-[var(--color-ink-3)]">
            {q
              ? '没有匹配的单子'
              : rows.length === 0
                ? c.emptyNone
                : filter === 'open'
                  ? c.emptyClear
                  : c.emptyNone}
          </p>
        ) : (
          shown.map((r) => {
            const paid = settlePaid(r)
            const left = settleOutstanding(r)
            return (
              <Fragment key={r.id}>
                <button
                  type="button"
                  onClick={() => setOpen(open === r.id ? null : r.id)}
                  className={`grid w-full ${COLS} items-center gap-3 border-b border-[var(--color-border)] px-4 py-3 text-left last:border-b-0 md:px-5 ${
                    open === r.id ? 'bg-[#faf8f2]' : 'hover:bg-[#faf8f2]'
                  } ${r.voidedAt ? 'opacity-50' : ''}`}
                >
                  <span className="mono hidden text-[12.5px] text-[var(--color-ink-2)] md:block">
                    {r.no}
                  </span>
                  <span className="min-w-0 truncate text-[14px] font-medium tracking-tight text-[var(--color-ink)]">
                    {r.party}
                    <span className="mono ml-2 text-[11.5px] font-normal text-[var(--color-ink-4)] md:hidden">
                      {r.no}
                    </span>
                  </span>
                  <span className="mono hidden text-[12.5px] text-[var(--color-ink-2)] md:block">
                    {r.period.slice(2).replace('-', '.')}
                  </span>
                  <span className="mono hidden text-right text-[13px] text-[var(--color-ink)] md:block">
                    {formatCny(r.amountCny)}
                  </span>
                  <span className="mono hidden text-right text-[13px] text-[var(--color-ink-2)] md:block">
                    {paid > 0 ? formatCny(paid) : '—'}
                  </span>
                  <span
                    className={`mono hidden text-right text-[13px] font-medium md:block ${
                      left > 0 ? 'text-[var(--color-overdue)]' : 'text-[var(--color-ink-4)]'
                    }`}
                  >
                    {left > 0 ? formatCny(left) : '—'}
                  </span>
                  <StatusTag r={r} todayStr={todayStr} labels={c.status} />
                </button>
                {open === r.id && (
                  <Detail kind={kind} r={r} todayStr={todayStr} canEdit={canEdit} />
                )}
              </Fragment>
            )
          })
        )}
      </div>

      <p className="mt-4 text-[12px] leading-relaxed text-[var(--color-ink-3)]">{c.foot}</p>
    </div>
  )
}

function StatusTag({
  r,
  todayStr,
  labels,
}: {
  r: SettleRow
  todayStr: string
  labels: Record<SettleStatus, string>
}) {
  const st = settleStatus(r, todayStr)
  const tone: Record<SettleStatus, string> = {
    open: 'text-[var(--color-ink-2)]',
    partial: 'text-[var(--color-warning)]',
    overdue: 'text-[var(--color-overdue)] font-medium',
    paid: 'text-[var(--color-success)]',
    void: 'text-[var(--color-ink-4)]',
  }
  return (
    <span className={`text-right text-[12.5px] ${tone[st]}`}>
      {st === 'overdue' ? `逾期 ${settleOverdueDays(r, todayStr)} 天` : labels[st]}
    </span>
  )
}

function isImage(p: PaymentProof): boolean {
  if (p.contentType?.startsWith('image/')) return true
  return /\.(png|jpe?g|webp|heic)$/i.test(p.filename)
}

// 两个名字是不是说的同一家 —— 回单上的户名常常是全称 ("杭州某某表面处理有限
// 公司"), 系统里是简称 ("某某表处")。去掉空白后一边包含另一边就算对得上;
// 对不上只是提醒一句, 不拦。
function samePayee(a: string, b: string): boolean {
  const x = a.replace(/\s/g, '')
  const y = b.replace(/\s/g, '')
  if (!x || !y) return true
  return x.includes(y) || y.includes(x) || x.slice(0, 2) === y.slice(0, 2)
}

function Detail({
  kind,
  r,
  todayStr,
  canEdit,
}: {
  kind: SettleKind
  r: SettleRow
  todayStr: string
  canEdit: boolean
}) {
  const c = COPY[kind]
  const router = useRouter()
  const [pending, start] = useTransition()
  const left = settleOutstanding(r)
  const [date, setDate] = useState(todayStr)
  const [amount, setAmount] = useState(left > 0 ? String(left) : '')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [armVoid, setArmVoid] = useState(false)
  const [armDel, setArmDel] = useState<string | null>(null)

  // 付款凭证 (只有应付) —— 传上去、机器读一遍, 挂在这一笔上。
  const [proof, setProof] = useState<PaymentProof | null>(null)
  const [reading, setReading] = useState(false)
  const [hint, setHint] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const zoneRef = useRef<HTMLDivElement>(null)

  const uploadProof = useCallback(
    async (file: File) => {
      setError(null)
      setHint(null)
      setReading(true)
      try {
        const fd = new FormData()
        fd.append('file', file)
        fd.append('payableId', r.id)
        const res = await fetch(withBase('/api/payable-proof'), { method: 'POST', body: fd })
        const data = (await res.json()) as
          | {
              ok: true
              proof: PaymentProof
              extracted: {
                date: string | null
                amountCny: number | null
                payee: string | null
                memo: string | null
              } | null
            }
          | { ok: false; error: string }
        if (!data.ok) {
          setError(data.error)
          return
        }
        setProof(data.proof)
        const x = data.extracted
        if (!x || (!x.date && !x.amountCny)) {
          setHint('凭证存好了，没读出日期金额——自己填一下')
          return
        }
        if (x.date) setDate(x.date > todayStr ? todayStr : x.date)
        if (x.amountCny) setAmount(String(x.amountCny))
        if (x.memo) setNote(x.memo)
        if (x.payee && !samePayee(x.payee, r.party)) {
          setHint(`凭证上的收款方是「${x.payee}」，跟「${r.party}」对不上——看一眼再记`)
        } else {
          setHint('日期、金额从凭证上读出来了，看一眼对不对')
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : '传不上')
      } finally {
        setReading(false)
      }
    },
    [r.id, r.party, todayStr],
  )

  usePasteImage(zoneRef, (f) => void uploadProof(f), kind === 'payable' && canEdit)

  function addPayment() {
    const n = Number(amount.trim().replace(/[¥,，元\s]/g, ''))
    if (!Number.isFinite(n) || n <= 0) return setError(`${c.amountPh}要填一个正数`)
    setError(null)
    start(async () => {
      try {
        await mutate({
          kind: c.addKind,
          [c.idKey]: r.id,
          input: {
            date,
            amountCny: n,
            note: note.trim() || undefined,
            ...(kind === 'payable' && proof ? { proof } : {}),
          },
        })
        if (n > left + 0.005) {
          showToast(`记下了——${c.over} ${formatCny(n - left)}`, 'warning')
        }
        setNote('')
        setAmount('')
        setProof(null)
        setHint(null)
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : '记不上')
      }
    })
  }

  function delPayment(pid: string) {
    start(async () => {
      try {
        await mutate({ kind: c.delKind, [c.idKey]: r.id, paymentId: pid })
        setArmDel(null)
        router.refresh()
      } catch (e) {
        showToast(e instanceof Error ? e.message : '删不掉', 'warning')
      }
    })
  }

  function doVoid() {
    start(async () => {
      try {
        await mutate({ kind: c.voidKind, [c.idKey]: r.id })
        setArmVoid(false)
        router.refresh()
      } catch (e) {
        setArmVoid(false)
        showToast(e instanceof Error ? e.message : '作废不了', 'warning')
      }
    })
  }

  const inp =
    'h-9 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]'

  const sheetHref = `/duizhang?${c.sheetKind ? `kind=${c.sheetKind}&` : ''}name=${encodeURIComponent(
    r.party,
  )}&m=${r.period}`

  return (
    <div
      ref={zoneRef}
      className="border-b border-[var(--color-border)] bg-[#faf8f2] px-4 py-4 last:border-b-0 md:px-5"
    >
      {/* 已记的每一笔 —— 按日期排; 应付那边带着凭证。 */}
      {r.payments.length === 0 ? (
        <p className="text-[12.5px] text-[var(--color-ink-3)]">{c.noPay}</p>
      ) : (
        <div className="max-w-[720px]">
          {r.payments.map((p) => (
            <div
              key={p.id}
              className="flex items-center gap-4 border-b border-[var(--color-border)] py-2 last:border-b-0"
            >
              <span className="mono w-[84px] shrink-0 text-[12.5px] text-[var(--color-ink-2)]">
                {p.date}
              </span>
              <span className="mono w-[104px] shrink-0 text-right text-[13px] font-medium text-[var(--color-ink)]">
                {formatCny(p.amountCny)}
              </span>
              {kind === 'payable' &&
                (p.proof ? (
                  <a
                    href={proxiedStorageUrl(p.proof.url)}
                    target="_blank"
                    rel="noreferrer"
                    title={`付款凭证 · ${p.proof.filename}`}
                    className="shrink-0"
                  >
                    {isImage(p.proof) ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={proxiedStorageUrl(p.proof.url)}
                        alt="付款凭证"
                        className="h-8 w-8 rounded-[2px] border border-[var(--color-border)] object-cover"
                      />
                    ) : (
                      <span className="flex h-8 w-8 items-center justify-center rounded-[2px] border border-[var(--color-border)] text-[10px] text-[var(--color-ink-3)]">
                        PDF
                      </span>
                    )}
                  </a>
                ) : (
                  <span
                    className="flex h-8 w-8 shrink-0 items-center justify-center text-[10.5px] text-[var(--color-ink-4)]"
                    title="这一笔没挂凭证"
                  >
                    无凭证
                  </span>
                ))}
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--color-ink-2)]">
                {p.note}
              </span>
              <span className="shrink-0 text-[11.5px] text-[var(--color-ink-4)]">{p.by}</span>
              {canEdit &&
                (armDel === p.id ? (
                  <button
                    type="button"
                    onClick={() => delPayment(p.id)}
                    disabled={pending}
                    className="shrink-0 text-[11.5px] font-medium text-[var(--color-overdue)] hover:underline disabled:opacity-50"
                  >
                    确认删
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setArmDel(p.id)}
                    className="shrink-0 text-[11.5px] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)]"
                  >
                    删
                  </button>
                ))}
            </div>
          ))}
        </div>
      )}

      {/* 记一笔 —— 金额默认就是还差的那个数, 一次结清就是点一下。应付那边
          先传凭证最省事: 日期金额机器填好, 人看一眼就记。 */}
      {canEdit && !r.voidedAt && left > 0 && (
        <div className="mt-3">
          <div className="flex flex-wrap items-center gap-2.5">
            {kind === 'payable' && (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*,application/pdf"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    e.target.value = ''
                    if (f) void uploadProof(f)
                  }}
                />
                {proof ? (
                  <span className="relative inline-flex shrink-0">
                    <a
                      href={proxiedStorageUrl(proof.url)}
                      target="_blank"
                      rel="noreferrer"
                      title={proof.filename}
                    >
                      {isImage(proof) ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={proxiedStorageUrl(proof.url)}
                          alt="付款凭证"
                          className="h-9 w-9 rounded-[2px] border border-[var(--color-border)] object-cover"
                        />
                      ) : (
                        <span className="flex h-9 w-9 items-center justify-center rounded-[2px] border border-[var(--color-border)] text-[10px] text-[var(--color-ink-3)]">
                          PDF
                        </span>
                      )}
                    </a>
                    <button
                      type="button"
                      onClick={() => {
                        setProof(null)
                        setHint(null)
                      }}
                      aria-label="拿掉这张凭证"
                      className="absolute -right-1.5 -top-1.5 flex h-[16px] w-[16px] items-center justify-center rounded-full border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[11px] leading-none text-[var(--color-ink-3)] hover:text-[var(--color-overdue)]"
                    >
                      ×
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    disabled={reading}
                    title="传一张银行回单 / 转账截图 —— 日期金额自己填好（也可以 Ctrl+V 粘贴）"
                    className="h-9 shrink-0 rounded-[2px] border border-dashed border-[var(--color-border-strong)] px-3 text-[12.5px] text-[var(--color-ink-2)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)] disabled:opacity-60"
                  >
                    {reading ? '读凭证中…' : '传凭证'}
                  </button>
                )}
              </>
            )}
            <DatePop
              value={date}
              onChange={(d) => d && setDate(d)}
              allowFuture={false}
              portal
              triggerClass="text-[13px]"
            />
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={c.amountPh}
              inputMode="decimal"
              className={`mono ${inp} w-[120px] text-right`}
            />
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addPayment()}
              placeholder={c.notePh}
              className={`${inp} min-w-[160px] flex-1 md:max-w-[300px]`}
            />
            <button
              type="button"
              onClick={addPayment}
              disabled={pending || reading}
              className="h-9 shrink-0 rounded-[2px] bg-[var(--color-ink)] px-4 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-50"
            >
              {c.act}
            </button>
          </div>
          {(hint || error) && (
            <p
              className={`mt-2 text-[12px] ${
                error
                  ? 'text-[var(--color-overdue)]'
                  : hint?.includes('对不上')
                    ? 'text-[var(--color-warning)]'
                    : 'text-[var(--color-ink-3)]'
              }`}
            >
              {error ?? hint}
            </p>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[11.5px] text-[var(--color-ink-4)]">
        <Link
          href={sheetHref}
          className="text-[12.5px] font-medium text-[var(--color-ink-2)] hover:text-[var(--color-ink)]"
        >
          看对账单 →
        </Link>
        <span>
          {r.lineCount} 行 · {r.totalQty} 件
        </span>
        <span>
          {r.approvedBy} {c.by}于 {r.approvedAt.slice(0, 10)}
        </span>
        <span>约定 {r.dueDate}</span>
        {r.voidedAt && (
          <span>
            {r.voidedBy} 作废于 {r.voidedAt.slice(0, 10)}
          </span>
        )}
        {canEdit && !r.voidedAt && r.payments.length === 0 && (
          <span className="ml-auto">
            {armVoid ? (
              <span className="inline-flex gap-3">
                <button
                  type="button"
                  onClick={doVoid}
                  disabled={pending}
                  className="font-medium text-[var(--color-overdue)] hover:underline disabled:opacity-50"
                >
                  确认作废
                </button>
                <button
                  type="button"
                  onClick={() => setArmVoid(false)}
                  className="text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
                >
                  取消
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setArmVoid(true)}
                title={`${c.by}错了、或者单据变了要按新数重来 —— 作废后回到对账里重新${c.by}`}
                className="hover:text-[var(--color-overdue)]"
              >
                作废
              </button>
            )}
          </span>
        )}
      </div>
    </div>
  )
}
