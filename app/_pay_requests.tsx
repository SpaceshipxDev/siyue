'use client'

import { Fragment, useEffect, useId, useMemo, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/mutate'
import { withBase } from '@/lib/base-path'
import { showToast } from '@/app/_toast'
import { usePasteImage } from '@/app/_paste_image'
import { PhotoViewer } from '@/app/_photo_viewer'
import { proxiedStorageUrl } from '@/lib/storage-url'
import { formatCny, type VoucherFile } from '@/lib/data'
import {
  PAY_CATEGORIES,
  PAY_FILE_LABEL,
  PAY_STAGE_LABEL,
  payItemAmount,
  payStage,
  type PayDept,
  type PayFileKind,
  type PayRequest,
  type PayStage,
  type PayStatement,
  cleanStatement,
} from '@/lib/pay-request-shared'

// 付款申请 —— 人事、商务两头共用这一块 (人事 /hr?v=pay, 商务 /pay)。
//
//   填申请 → 商务审核 (黄优兰香 / 于海伟) → 老板批 → 自动落一张应付单到
//   财务 · 应付, 财务照常付款
//
// 平时这一页就是一张单子列表, 点「＋ 付款申请」才展开表单。点开一行看全部:
// 收款方、类别、事项说明、付款清单、凭证和发票 (图点开放大), 下面是这一步
// 该谁按的那个按钮。

type Filter = 'pending' | 'all'

const STAGE_TONE: Record<PayStage, string> = {
  fill: 'text-[var(--color-overdue)] font-medium',
  review: 'text-[var(--color-overdue)] font-medium',
  boss: 'text-[var(--color-warning)] font-medium',
  done: 'text-[var(--color-success)]',
  rejected: 'text-[var(--color-ink-4)]',
}

const COLS =
  'grid-cols-[minmax(0,1fr)_96px] md:grid-cols-[108px_minmax(0,1fr)_112px_88px_120px]'

const inp =
  'h-9 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]'

export function PayRequestBoard({
  requests,
  dept,
  canFile,
  userName,
  isReviewer,
  isBoss,
  showDept,
  openId,
}: {
  requests: PayRequest[]
  /** 这一页填的是哪个部门的申请。 */
  dept: PayDept
  canFile: boolean
  userName: string
  /** 黄优兰香 / 于海伟 / 老板 —— 审核那一步 (自己填的除外, 老板不受限)。 */
  isReviewer: boolean
  isBoss: boolean
  /** 列表里两个部门都有时, 每行标一下是哪边的。 */
  showDept: boolean
  openId?: string
}) {
  const waiting = (r: PayRequest) => {
    const st = payStage(r)
    return st === 'fill' || st === 'review' || st === 'boss'
  }
  const pendingCount = requests.filter(waiting).length
  const [filter, setFilter] = useState<Filter>(pendingCount > 0 ? 'pending' : 'all')
  const [open, setOpen] = useState<string | null>(openId ?? null)
  const [composing, setComposing] = useState(false)

  const shown = useMemo(
    () => (filter === 'pending' ? requests.filter(waiting) : requests),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [requests, filter],
  )

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex items-baseline gap-4">
        {(
          [
            ['pending', `待审批${pendingCount > 0 ? ` ${pendingCount}` : ''}`],
            ['all', '全部'],
          ] as [Filter, string][]
        ).map(([f, label]) => (
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
            {label}
          </button>
        ))}
        {canFile && !composing && (
          <button
            type="button"
            onClick={() => setComposing(true)}
            className="ml-auto h-9 shrink-0 rounded-[2px] bg-[var(--color-ink)] px-4 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85"
          >
            ＋ 付款申请
          </button>
        )}
      </div>

      {composing && (
        <NewRequest
          dept={dept}
          past={requests}
          onCancel={() => setComposing(false)}
          onFiled={(id) => {
            setComposing(false)
            setFilter('pending')
            setOpen(id)
          }}
        />
      )}

      <div className="overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div
          className={`hidden ${COLS} items-center gap-3 border-b border-[var(--color-border)] bg-[#f5f3ed] px-5 py-2 md:grid`}
        >
          <span className="label">付款单号</span>
          <span className="label">收款方 · 事项</span>
          <span className="label text-right">金额</span>
          <span className="label">申请人</span>
          <span className="label text-right">状态</span>
        </div>
        {shown.length === 0 ? (
          <p className="px-5 py-12 text-center text-[13px] text-[var(--color-ink-3)]">
            {requests.length === 0 ? '还没有付款申请' : '没有等着批的'}
          </p>
        ) : (
          shown.map((r) => {
            const st = payStage(r)
            return (
              <Fragment key={r.id}>
                <button
                  type="button"
                  onClick={() => setOpen(open === r.id ? null : r.id)}
                  className={`grid w-full ${COLS} items-center gap-3 border-b border-[var(--color-border)] px-4 py-3 text-left last:border-b-0 md:px-5 ${
                    open === r.id ? 'bg-[#faf8f2]' : 'hover:bg-[#faf8f2]'
                  } ${st === 'rejected' ? 'opacity-55' : ''}`}
                >
                  <span className="mono hidden text-[12.5px] text-[var(--color-ink-2)] md:block">
                    {r.no}
                  </span>
                  <span className="flex min-w-0 items-baseline gap-2">
                    {showDept && (
                      <span className="shrink-0 text-[11px] text-[var(--color-ink-4)]">{r.dept}</span>
                    )}
                    <Chip>{r.category}</Chip>
                    <span className="truncate text-[14px] font-medium tracking-tight text-[var(--color-ink)]">
                      {r.payee}
                    </span>
                    <span className="truncate text-[12px] text-[var(--color-ink-3)]">{r.subject}</span>
                  </span>
                  <span className="mono hidden text-right text-[13px] text-[var(--color-ink)] md:block">
                    {formatCny(r.amountCny)}
                  </span>
                  <span className="hidden truncate text-[12.5px] text-[var(--color-ink-2)] md:block">
                    {r.appliedBy}
                  </span>
                  <span className={`text-right text-[12.5px] ${STAGE_TONE[st]}`}>
                    {PAY_STAGE_LABEL[st]}
                  </span>
                </button>
                {open === r.id && (
                  <Detail
                    r={r}
                    userName={userName}
                    isReviewer={isReviewer}
                    isBoss={isBoss}
                  />
                )}
              </Fragment>
            )
          })
        )}
      </div>

      <p className="mt-4 text-[12px] leading-relaxed text-[var(--color-ink-3)]">
        外协对账单上点「确认」会自动生成一张「待填付款」的申请，点开填好收款账户、补上没定价的金额，再点「提交审核」。谁填的谁看得到，别人填的只有老板、财务、于海伟和审核人看得到。填好的申请先由黄优兰香或于海伟审核（自己填的要让另一个人审），再由老板批。老板批了就自动转到「财务 · 应付」，财务在那里付款、挂回单。发票后补也行，点开这一张传上去。
      </p>
    </div>
  )
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 text-[10.5px] leading-none text-[var(--color-ink-3)]">
      {children}
    </span>
  )
}

// ── 新申请 ──────────────────────────────────────────────────────────────────

type DraftItem = { key: number; name: string; qty: string; price: string; amount: string }

function num(s: string): number | undefined {
  const t = s.trim().replace(/[¥,，元\s]/g, '')
  if (!t) return undefined
  const n = Number(t)
  return Number.isFinite(n) ? n : undefined
}

// ── 付款清单导入 —— Excel / CSV 文件, 或者从 Excel 里复制几行粘进来 ──────────
//
// 认表头: 名称 (品名 / 项目 / 内容 / 明细…)、数量、单价、金额 (合计 / 小计 /
// 总价)。没有表头就按位置猜: 第一个不是数的格子当名称, 后面的数一个当金额,
// 两个当数量 + 单价, 三个当数量 + 单价 + 金额。合计 / 总计那一行跳过。

type ImportedItem = { name: string; qty: string; price: string; amount: string }

const NAME_HEAD = /名称|品名|项目|内容|明细|摘要|物品|事项|货物|规格/
const QTY_HEAD = /数量/
const PRICE_HEAD = /单价|价格/
const AMOUNT_HEAD = /金额|合计|小计|总价|总额/
const TOTAL_ROW = /^(合\s*计|总\s*计|小\s*计|总额)/

function cellText(v: unknown): string {
  if (v == null) return ''
  return String(v).trim()
}

function cellNum(v: unknown): string {
  const t = cellText(v).replace(/[¥,，元\s]/g, '')
  return t && Number.isFinite(Number(t)) ? t : ''
}

function gridToItems(grid: unknown[][]): ImportedItem[] {
  const rows = grid.filter((r) => Array.isArray(r) && r.some((c) => cellText(c)))
  let head = -1
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const texts = rows[i].map(cellText)
    if (texts.some((t) => NAME_HEAD.test(t)) && texts.some((t) => AMOUNT_HEAD.test(t) || PRICE_HEAD.test(t) || QTY_HEAD.test(t))) {
      head = i
      break
    }
  }
  const out: ImportedItem[] = []
  if (head >= 0) {
    const h = rows[head].map(cellText)
    const find = (re: RegExp, not?: RegExp) => h.findIndex((t) => re.test(t) && !(not && not.test(t)))
    const nameCol = find(NAME_HEAD)
    const qtyCol = find(QTY_HEAD)
    const priceCol = find(PRICE_HEAD)
    const amountCol = find(AMOUNT_HEAD, PRICE_HEAD)
    for (const r of rows.slice(head + 1)) {
      const name = cellText(r[nameCol])
      if (!name || TOTAL_ROW.test(name)) continue
      out.push({
        name,
        qty: qtyCol >= 0 ? cellNum(r[qtyCol]) : '',
        price: priceCol >= 0 ? cellNum(r[priceCol]) : '',
        amount: amountCol >= 0 ? cellNum(r[amountCol]) : '',
      })
    }
    return out
  }
  for (const r of rows) {
    const nameAt = r.findIndex((c) => cellText(c) && !cellNum(c))
    if (nameAt < 0) continue
    const name = cellText(r[nameAt])
    if (TOTAL_ROW.test(name)) continue
    const nums = r.slice(nameAt + 1).map(cellNum).filter(Boolean)
    out.push(
      nums.length >= 3
        ? { name, qty: nums[0], price: nums[1], amount: nums[2] }
        : nums.length === 2
          ? { name, qty: nums[0], price: nums[1], amount: '' }
          : { name, qty: '', price: '', amount: nums[0] ?? '' },
    )
  }
  return out
}

/** 对账单明细 —— 整张表原样读进来 (第一张工作表, 格子按表里显示的样子)。 */
async function readStatementFile(file: File): Promise<PayStatement | undefined> {
  const XLSX = await import('xlsx')
  const buf = await file.arrayBuffer()
  // CSV 是纯文字 —— 先认编码 (UTF-8 不对就是 GBK, 国内导出来的多半是它), 格
  // 子原样不转; Excel 里的日期按 年-月-日 写。
  let wb
  if (/\.csv$/i.test(file.name)) {
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
    } catch {
      text = new TextDecoder('gbk').decode(buf)
    }
    wb = XLSX.read(text.replace(/^\uFEFF/, ''), { type: 'string', raw: true })
  } else {
    wb = XLSX.read(buf, { type: 'array', cellDates: true })
  }
  const ws = wb.Sheets[wb.SheetNames[0]]
  if (!ws) return undefined
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    raw: false,
    defval: '',
    dateNF: 'yyyy-mm-dd',
  })
  return cleanStatement(grid, file.name.replace(/\.(xlsx|xls|csv)$/i, ''))
}

async function readItemsFile(file: File): Promise<ImportedItem[]> {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' })
  const ws = wb.Sheets[wb.SheetNames[0]]
  if (!ws) return []
  return gridToItems(XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: '' }))
}

function NewRequest({
  dept,
  past,
  onCancel,
  onFiled,
}: {
  dept: PayDept
  past: PayRequest[]
  onCancel: () => void
  onFiled: (id: string) => void
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const listId = useId()
  const seq = useRef(1)
  const [payee, setPayee] = useState('')
  const [account, setAccount] = useState('')
  const [category, setCategory] = useState('')
  const [subject, setSubject] = useState('')
  const [note, setNote] = useState('')
  const [items, setItems] = useState<DraftItem[]>([
    { key: 0, name: '', qty: '', price: '', amount: '' },
  ])
  const [staged, setStaged] = useState<Record<PayFileKind, File[]>>({ voucher: [], invoice: [] })
  const [statement, setStatement] = useState<PayStatement | undefined>()
  const [error, setError] = useState<string | null>(null)

  // 以前付过的收款方 —— 选中就把上回的账户带上, 不用再打一遍。
  const accountOf = useMemo(() => {
    const m = new Map<string, string>()
    for (const r of past) if (r.payeeAccount && !m.has(r.payee)) m.set(r.payee, r.payeeAccount)
    return m
  }, [past])

  const lineAmount = (i: DraftItem) =>
    payItemAmount({ qty: num(i.qty), unitPriceCny: num(i.price), amountCny: num(i.amount) })
  const total = items.reduce((s, i) => s + lineAmount(i), 0)

  const patch = (key: number, p: Partial<DraftItem>) =>
    setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...p } : x)))

  // 导进来的接在已经填了的后面, 空行顶掉。
  const importRef = useRef<HTMLInputElement>(null)
  const addImported = (got: ImportedItem[]) => {
    if (got.length === 0) {
      setError('表格里没认出清单 —— 要有「名称」一列，或者一行一项：名称、数量、单价、金额')
      return
    }
    setError(null)
    setItems((xs) => [
      ...xs.filter((x) => x.name.trim() || x.amount.trim() || x.qty.trim() || x.price.trim()),
      ...got.map((g) => ({ key: seq.current++, ...g })),
    ])
    showToast(`导入了 ${got.length} 项`, 'success')
  }

  function submit() {
    if (!payee.trim()) return setError('先填收款方')
    if (!category) return setError('选一个付款类别')
    if (!subject.trim()) return setError('写一句付款事项')
    const lines = items.filter((i) => i.name.trim())
    if (lines.length === 0) return setError('付款清单至少填一项')
    if (!lines.some((i) => lineAmount(i) > 0)) return setError('付款清单要有金额')
    setError(null)
    start(async () => {
      try {
        const r = await mutate<{ id: string; no: string }>({
          kind: 'createPayRequest',
          input: {
            dept,
            payee: payee.trim(),
            payeeAccount: account.trim() || undefined,
            category,
            subject: subject.trim(),
            note: note.trim() || undefined,
            items: lines.map((i) => ({
              name: i.name.trim(),
              qty: num(i.qty),
              unitPriceCny: num(i.price),
              amountCny: lineAmount(i),
            })),
            statement,
          },
        })
        let failed = 0
        for (const kind of ['voucher', 'invoice'] as PayFileKind[]) {
          for (const f of staged[kind]) {
            try {
              await uploadPayFile(r.data.id, kind, f)
            } catch {
              failed += 1
            }
          }
        }
        if (failed > 0) showToast(`申请交上了，有 ${failed} 个附件没传上——点开那一行再补`, 'warning')
        else showToast(`${r.data.no} 已提交，等审核`, 'success')
        onFiled(r.data.id)
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : '提交不上')
      }
    })
  }

  return (
    <div className="mb-6 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-4 md:px-5">
      <div className="flex flex-wrap items-center gap-2.5">
        <input
          value={payee}
          onChange={(e) => {
            const v = e.target.value
            setPayee(v)
            if (!account && accountOf.has(v.trim())) setAccount(accountOf.get(v.trim())!)
          }}
          placeholder="收款方"
          list={listId}
          autoFocus
          className={`${inp} w-[200px]`}
        />
        <datalist id={listId}>
          {[...accountOf.keys(), ...past.map((r) => r.payee)]
            .filter((v, i, a) => v && a.indexOf(v) === i)
            .map((n) => (
              <option key={n} value={n} />
            ))}
        </datalist>
        <input
          value={account}
          onChange={(e) => setAccount(e.target.value)}
          placeholder="收款账户 · 开户行 / 账号 / 联系人"
          className={`${inp} min-w-[220px] flex-1`}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <span className="label mr-1">付款类别</span>
        {PAY_CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setCategory((cur) => (cur === c ? '' : c))}
            className={`rounded-[2px] border px-2.5 py-1 text-[12px] ${
              category === c
                ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-surface)]'
                : 'border-[var(--color-border)] text-[var(--color-ink-2)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)]'
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      <div className="mt-3 flex flex-col gap-2.5">
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="付款事项 · 一句话说清付什么钱"
          className={`${inp} w-full`}
        />
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder="说明 · 可空"
          className="w-full resize-none rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
        />
      </div>

      {/* 付款清单 —— 一项一行; 数量和单价都填了金额自己算, 不然直接填金额。 */}
      <div className="mt-4">
        <div className="grid grid-cols-[minmax(0,1fr)_64px_84px_96px_20px] items-center gap-2 pb-1">
          <span className="label">付款清单</span>
          <span className="label text-right">数量</span>
          <span className="label text-right">单价</span>
          <span className="label text-right">金额</span>
          <span />
        </div>
        {items.map((i) => {
          const auto = num(i.qty) !== undefined && num(i.price) !== undefined
          return (
            <div
              key={i.key}
              className="grid grid-cols-[minmax(0,1fr)_64px_84px_96px_20px] items-center gap-2 py-1"
            >
              <input
                value={i.name}
                onChange={(e) => patch(i.key, { name: e.target.value })}
                onPaste={(e) => {
                  // 从 Excel 复制了好几格 —— 当成一张小表导进来。
                  const t = e.clipboardData.getData('text')
                  if (!/[\t\n]/.test(t.trim())) return
                  e.preventDefault()
                  addImported(
                    gridToItems(t.replace(/\r/g, '').split('\n').map((l) => l.split('\t'))),
                  )
                }}
                placeholder="名称"
                className={`${inp} w-full`}
              />
              <input
                value={i.qty}
                onChange={(e) => patch(i.key, { qty: e.target.value })}
                inputMode="decimal"
                className={`mono ${inp} w-full text-right`}
              />
              <input
                value={i.price}
                onChange={(e) => patch(i.key, { price: e.target.value })}
                inputMode="decimal"
                className={`mono ${inp} w-full text-right`}
              />
              <input
                value={auto ? String(lineAmount(i)) : i.amount}
                onChange={(e) => patch(i.key, { amount: e.target.value })}
                readOnly={auto}
                inputMode="decimal"
                className={`mono ${inp} w-full text-right ${auto ? 'text-[var(--color-ink-3)]' : ''}`}
              />
              {items.length > 1 ? (
                <button
                  type="button"
                  onClick={() => setItems((xs) => xs.filter((x) => x.key !== i.key))}
                  aria-label="删掉这一行"
                  className="text-[14px] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)]"
                >
                  ×
                </button>
              ) : (
                <span />
              )}
            </div>
          )
        })}
        <div className="mt-1 flex items-center gap-3">
          <button
            type="button"
            onClick={() =>
              setItems((xs) => [...xs, { key: seq.current++, name: '', qty: '', price: '', amount: '' }])
            }
            className="text-[12.5px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
          >
            ＋ 加一行
          </button>
          <input
            ref={importRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (!f) return
              try {
                addImported(await readItemsFile(f))
              } catch {
                setError('这个表格读不出来 —— 换成 Excel（.xlsx）再试')
              }
            }}
          />
          <button
            type="button"
            onClick={() => importRef.current?.click()}
            title="选一个 Excel 表格，按名称、数量、单价、金额把清单填进来；也可以从 Excel 复制几行直接粘到名称框里"
            className="text-[12.5px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
          >
            导入表格
          </button>
          <span className="ml-auto text-[12px] text-[var(--color-ink-3)]">合计</span>
          <span className="mono w-[96px] text-right text-[14px] font-semibold text-[var(--color-ink)]">
            {formatCny(total)}
          </span>
          <span className="w-[20px]" />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2.5">
        {(['voucher', 'invoice'] as PayFileKind[]).map((kind) => (
          <Fragment key={kind}>
            <StagedFiles
              label={PAY_FILE_LABEL[kind]}
              files={staged[kind]}
              onChange={(fs) => setStaged((s) => ({ ...s, [kind]: fs }))}
            />
            {/* 对账单明细 —— 跟在付款凭证后面 (于海伟 2026-10-24)。 */}
            {kind === 'voucher' && (
              <StatementPick value={statement} onChange={setStatement} onError={setError} />
            )}
          </Fragment>
        ))}
        <span className="flex-1" />
        <button
          type="button"
          onClick={onCancel}
          className="text-[13px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
        >
          取消
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={pending}
          className="h-9 shrink-0 rounded-[2px] bg-[var(--color-ink)] px-4 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-50"
        >
          {pending ? '提交中…' : '提交申请'}
        </button>
      </div>
      {error && <p className="mt-2 text-[12px] text-[var(--color-overdue)]">{error}</p>}
      {statement && (
        <div className="mt-3">
          <StatementTable s={statement} />
        </div>
      )}
    </div>
  )
}

// 导入对账单明细的那个按钮 —— 选了 Excel / CSV 就读成一张表; 有了就显示几行,
// 点 × 去掉。
function StatementPick({
  value,
  onChange,
  onError,
  busy: outerBusy,
  noChip,
}: {
  value?: PayStatement
  onChange: (s: PayStatement | undefined) => void
  onError: (e: string | null) => void
  busy?: boolean
  /** 外面自己写着是哪张 —— 这里只要那个按钮。 */
  noChip?: boolean
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  return (
    <span className="inline-flex items-center gap-1.5">
      <input
        ref={ref}
        type="file"
        accept=".xlsx,.xls,.csv"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (!f) return
          setBusy(true)
          try {
            const got = await readStatementFile(f)
            if (!got) onError('这张表是空的')
            else {
              onError(null)
              onChange(got)
            }
          } catch {
            onError('这个表格读不出来 —— 换成 Excel（.xlsx）再试')
          } finally {
            setBusy(false)
          }
        }}
      />
      {value && !noChip && (
        <span className="inline-flex h-9 items-center gap-1.5 rounded-[2px] border border-[var(--color-border)] px-2.5 text-[12.5px] text-[var(--color-ink-2)]">
          对账单明细 {Math.max(0, value.rows.length - 1)} 行
          <button
            type="button"
            onClick={() => onChange(undefined)}
            aria-label="去掉对账单明细"
            className="text-[var(--color-ink-4)] hover:text-[var(--color-overdue)]"
          >
            ×
          </button>
        </span>
      )}
      <button
        type="button"
        disabled={busy || outerBusy}
        onClick={() => ref.current?.click()}
        title="选供应商的对账单 Excel，整张表原样导进来"
        className="h-9 shrink-0 rounded-[2px] border border-dashed border-[var(--color-border-strong)] px-3 text-[12.5px] text-[var(--color-ink-2)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)] disabled:opacity-50"
      >
        {busy || outerBusy ? '读取中…' : value ? '换一张' : '＋ 对账单明细'}
      </button>
    </span>
  )
}

// 对账单明细那张表 —— 第一行是表头; 长的在框里滚。
function StatementTable({ s }: { s: PayStatement }) {
  const [head, ...body] = s.rows
  return (
    <div className="max-h-[320px] overflow-auto rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
      <table className="w-full border-collapse text-[12px]">
        <thead className="sticky top-0 bg-[#f5f3ed]">
          <tr>
            {head.map((h, i) => (
              <th
                key={i}
                className="whitespace-nowrap border-b border-[var(--color-border)] px-2 py-1.5 text-left font-medium text-[var(--color-ink-2)]"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, x) => (
            <tr key={x} className="border-b border-[var(--color-border)] last:border-b-0">
              {r.map((c, i) => (
                <td
                  key={i}
                  className={`px-2 py-1 text-[var(--color-ink)] ${
                    /^-?[\d,.]+$/.test(c) ? 'mono whitespace-nowrap text-right' : ''
                  }`}
                >
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// 点开一张申请时的对账单明细 —— 有就摆着, 没批之前能导、能换、能去掉。
function StatementStrip({ r, canEdit }: { r: PayRequest; canEdit: boolean }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const save = (s: PayStatement | undefined) =>
    start(async () => {
      try {
        await mutate({ kind: 'setPayStatement', payRequestId: r.id, statement: s ?? null })
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : '存不上')
      }
    })
  if (!r.statement && !canEdit) return null
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="label w-[56px] shrink-0">对账单</span>
        {r.statement && (
          <span className="text-[12.5px] text-[var(--color-ink-2)]">
            {r.statement.filename} · {Math.max(0, r.statement.rows.length - 1)} 行
          </span>
        )}
        {canEdit && (
          <StatementPick
            value={r.statement}
            noChip
            onChange={(s) => s && save(s)}
            onError={setError}
            busy={pending}
          />
        )}
        {canEdit && r.statement && (
          <button
            type="button"
            disabled={pending}
            onClick={() => confirm('去掉这张对账单明细？') && save(undefined)}
            className="text-[12px] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)]"
          >
            去掉
          </button>
        )}
        {error && <span className="text-[12px] text-[var(--color-overdue)]">{error}</span>}
      </div>
      {r.statement && (
        <div className="mt-2">
          <StatementTable s={r.statement} />
        </div>
      )}
    </div>
  )
}

// 填申请时先选好的附件 —— 申请落下拿到单号再传上去。选了就排出缩略图, 图点
// 一下放大看清楚, 选错的点 × 拿掉。
function StagedFiles({
  label,
  files,
  onChange,
}: {
  label: string
  files: File[]
  onChange: (fs: File[]) => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [viewing, setViewing] = useState<number | null>(null)
  // 本地预览地址 —— 在 effect 里建、在 effect 里收, 文件换了就重建。
  const [urls, setUrls] = useState<string[]>([])
  useEffect(() => {
    const u = files.map((f) => URL.createObjectURL(f))
    setUrls(u)
    return () => u.forEach((x) => URL.revokeObjectURL(x))
  }, [files])
  const zoomable = (f: File) => f.type.startsWith('image/') && !/heic/i.test(f.type + f.name)
  const images = files
    .map((f, i) => ({ f, url: urls[i] }))
    .filter((x) => zoomable(x.f) && x.url)

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <input
        ref={ref}
        type="file"
        multiple
        accept="image/*,application/pdf"
        className="hidden"
        onChange={(e) => {
          const fs = Array.from(e.target.files ?? [])
          e.target.value = ''
          if (fs.length > 0) onChange([...files, ...fs])
        }}
      />
      {files.length > 0 && <span className="label mr-0.5">{label}</span>}
      {files.map((f, i) => (
        <span key={`${f.name}-${i}`} className="group/ph relative">
          {zoomable(f) && urls[i] ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={urls[i]}
              alt={f.name}
              title={`${f.name} — 点开放大`}
              onClick={() => setViewing(images.findIndex((x) => x.f === f))}
              className="h-9 w-9 cursor-zoom-in rounded-[2px] border border-[var(--color-border)] object-cover"
            />
          ) : (
            <span
              title={f.name}
              className="flex h-9 w-9 items-center justify-center rounded-[2px] border border-[var(--color-border)] text-[10px] text-[var(--color-ink-3)]"
            >
              {/\.pdf$/i.test(f.name) ? 'PDF' : '图'}
            </span>
          )}
          <button
            type="button"
            onClick={() => onChange(files.filter((_, x) => x !== i))}
            aria-label="拿掉这一个"
            className="absolute -right-1 -top-1 hidden h-[15px] w-[15px] items-center justify-center rounded-full bg-[var(--color-ink)] text-[9px] leading-none text-[var(--color-surface)] group-hover/ph:flex"
          >
            ✕
          </button>
        </span>
      ))}
      <button
        type="button"
        onClick={() => ref.current?.click()}
        className="h-9 shrink-0 rounded-[2px] border border-dashed border-[var(--color-border-strong)] px-3 text-[12.5px] text-[var(--color-ink-2)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)]"
      >
        {files.length > 0 ? '＋' : `＋ ${label}`}
      </button>
      {viewing !== null && viewing >= 0 && (
        <PhotoViewer
          items={images.map((x) => ({ url: x.url, filename: x.f.name }))}
          start={viewing}
          onClose={() => setViewing(null)}
        />
      )}
    </span>
  )
}

async function uploadPayFile(id: string, kind: PayFileKind, file: File): Promise<VoucherFile> {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('id', id)
  fd.append('kind', kind)
  const res = await fetch(withBase('/api/pay-request-file'), { method: 'POST', body: fd })
  const d = (await res.json().catch(() => ({}))) as { ok?: boolean; file?: VoucherFile; error?: string }
  if (!d.ok || !d.file) throw new Error(d.error ?? '传不上')
  return d.file
}

// ── 点开一张 ────────────────────────────────────────────────────────────────

function Detail({
  r,
  userName,
  isReviewer,
  isBoss,
}: {
  r: PayRequest
  userName: string
  isReviewer: boolean
  isBoss: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const st = payStage(r)
  const [armReject, setArmReject] = useState(false)
  const [rejectNote, setRejectNote] = useState('')
  const [armDelete, setArmDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 这一步轮不轮到我按。
  const canAct =
    st === 'review' ? isBoss || (isReviewer && r.appliedBy !== userName) : st === 'boss' ? isBoss : false
  const canDelete = st !== 'done' && (r.appliedBy === userName || isReviewer)
  // 对账来的那张, 填付款的是确认对账的人 (或者审批的人)。
  const canFill = st === 'fill' && (r.appliedBy === userName || isReviewer || isBoss)

  function run(body: Record<string, unknown> & { kind: string }, ok: string) {
    setError(null)
    start(async () => {
      try {
        const res = await mutate<{ payableNo?: string }>(body)
        const no = (res as { data?: { payableNo?: string } }).data?.payableNo
        showToast(no ? `已批准，转到财务应付 ${no}` : ok, 'success')
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : '办不了')
      }
    })
  }

  const approveLabel = st === 'boss' || isBoss ? '老板批准' : '审核通过'

  return (
    <div className="border-b border-[var(--color-border)] bg-[#faf8f2] px-4 py-4 last:border-b-0 md:px-5">
      <div className="grid gap-x-10 gap-y-1.5 text-[12.5px] text-[var(--color-ink-2)] md:grid-cols-2">
        <p>
          <span className="text-[var(--color-ink-4)]">收款方</span> {r.payee}
          {r.payeeAccount && <span className="text-[var(--color-ink-3)]"> · {r.payeeAccount}</span>}
        </p>
        <p>
          <span className="text-[var(--color-ink-4)]">类别</span> {r.category}
          <span className="text-[var(--color-ink-4)]"> · {r.dept}</span>
          <span className="mono text-[var(--color-ink-4)]"> · {r.no}</span>
        </p>
        <p className="md:col-span-2">
          <span className="text-[var(--color-ink-4)]">事项</span> {r.subject}
        </p>
        {r.note && (
          <p className="whitespace-pre-wrap md:col-span-2">
            <span className="text-[var(--color-ink-4)]">说明</span> {r.note}
          </p>
        )}
      </div>

      {canFill ? (
        <FillForm r={r} />
      ) : (
      <div className="mt-3 max-w-[560px]">
        <div className="grid grid-cols-[minmax(0,1fr)_56px_80px_96px] gap-2 border-b border-[var(--color-border)] pb-1">
          <span className="label">付款清单</span>
          <span className="label text-right">数量</span>
          <span className="label text-right">单价</span>
          <span className="label text-right">金额</span>
        </div>
        {r.items.map((i, x) => (
          <div
            key={x}
            className="grid grid-cols-[minmax(0,1fr)_56px_80px_96px] gap-2 border-b border-[var(--color-border)] py-1 text-[12.5px] last:border-b-0"
          >
            <span className="min-w-0 break-words text-[var(--color-ink)]">{i.name}</span>
            <span className="mono text-right text-[var(--color-ink-3)]">{i.qty ?? ''}</span>
            <span className="mono text-right text-[var(--color-ink-3)]">
              {i.unitPriceCny != null ? formatCny(i.unitPriceCny) : ''}
            </span>
            <span className="mono text-right text-[var(--color-ink)]">{formatCny(i.amountCny)}</span>
          </div>
        ))}
        <div className="flex justify-end gap-3 pt-1.5 text-[12.5px]">
          <span className="text-[var(--color-ink-3)]">合计</span>
          <span className="mono w-[96px] text-right font-semibold text-[var(--color-ink)]">
            {formatCny(r.amountCny)}
          </span>
        </div>
      </div>
      )}

      <div className="mt-3 flex flex-col gap-2.5">
        <FileStrip r={r} kind="voucher" canDelete={st !== 'done'} />
        <StatementStrip
          r={r}
          canEdit={st !== 'done' && st !== 'rejected' && (r.appliedBy === userName || isReviewer || isBoss)}
        />
        <FileStrip r={r} kind="invoice" canDelete={st !== 'done'} />
      </div>

      <div className="mt-3 space-y-0.5 text-[12px] text-[var(--color-ink-3)]">
        <p>
          {r.appliedBy} {r.appliedAt.slice(0, 10)} 申请
          {r.reviewedBy && ` · ${r.reviewedBy} ${r.reviewedAt?.slice(0, 10)} 审核`}
          {r.approvedBy && ` · ${r.approvedBy} ${r.approvedAt?.slice(0, 10)} 批准`}
          {r.rejectedBy && (
            <span className="text-[var(--color-overdue)]">
              {' '}
              · {r.rejectedBy} {r.rejectedAt?.slice(0, 10)} 驳回{r.rejectNote ? `：${r.rejectNote}` : ''}
            </span>
          )}
        </p>
        {r.payableId && (
          <p>
            已转到财务应付{' '}
            <Link
              href={`/finance?tab=payable&open=${encodeURIComponent(r.payableId)}`}
              className="mono text-[var(--color-info)] hover:underline"
            >
              {r.payableNo ?? '看应付单'}
            </Link>
          </p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2.5">
        {canAct &&
          (armReject ? (
            <>
              <input
                value={rejectNote}
                onChange={(e) => setRejectNote(e.target.value)}
                placeholder="驳回原因 · 让申请人知道为什么"
                autoFocus
                className="h-9 min-w-[200px] flex-1 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-[13px] outline-none md:max-w-[320px]"
              />
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  run(
                    { kind: 'decidePayRequest', payRequestId: r.id, decision: 'reject', note: rejectNote },
                    '已驳回',
                  )
                }
                className="h-9 shrink-0 rounded-[2px] bg-[var(--color-overdue)] px-4 text-[13px] font-medium text-white hover:opacity-85 disabled:opacity-50"
              >
                确认驳回
              </button>
              <button
                type="button"
                onClick={() => setArmReject(false)}
                className="text-[12.5px] text-[var(--color-ink-3)]"
              >
                取消
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  run(
                    { kind: 'decidePayRequest', payRequestId: r.id, decision: 'approve' },
                    '已审核，等老板批',
                  )
                }
                className="h-9 shrink-0 rounded-[2px] bg-[var(--color-ink)] px-4 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-50"
              >
                {approveLabel}
              </button>
              <button
                type="button"
                onClick={() => setArmReject(true)}
                className="h-9 shrink-0 rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 text-[13px] font-medium text-[var(--color-ink-2)] hover:text-[var(--color-ink)]"
              >
                驳回
              </button>
            </>
          ))}
        {st === 'fill' && !canFill && (
          <span className="text-[12.5px] text-[var(--color-ink-3)]">等{r.appliedBy}填付款</span>
        )}
        {!canAct && (st === 'review' || st === 'boss') && (
          <span className="text-[12.5px] text-[var(--color-ink-3)]">
            {st === 'boss'
              ? '等老板批'
              : isReviewer
                ? '这张是你填的，要让另一个人来审核'
                : '等黄优兰香或于海伟审核'}
          </span>
        )}
        {error && <span className="text-[12px] text-[var(--color-overdue)]">{error}</span>}

        {canDelete && (
          <span className="ml-auto text-[11.5px]">
            {armDelete ? (
              <span className="inline-flex gap-3">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => run({ kind: 'deletePayRequest', payRequestId: r.id }, '已删除')}
                  className="font-medium text-[var(--color-overdue)] hover:underline"
                >
                  确认删除
                </button>
                <button
                  type="button"
                  onClick={() => setArmDelete(false)}
                  className="text-[var(--color-ink-3)]"
                >
                  取消
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setArmDelete(true)}
                className="text-[var(--color-ink-4)] hover:text-[var(--color-overdue)]"
              >
                删除这张申请
              </button>
            )}
          </span>
        )}
      </div>
    </div>
  )
}

// 待填付款 —— 外协对账确认生成的那张: 收款账户、说明、每一项的金额 (没定价
// 的在这里补), 填好点「提交审核」。凭证、发票在下面照常传。
function FillForm({ r }: { r: PayRequest }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [account, setAccount] = useState(r.payeeAccount ?? '')
  const [note, setNote] = useState(r.note ?? '')
  const [amounts, setAmounts] = useState(() => r.items.map((i) => (i.amountCny ? String(i.amountCny) : '')))
  const [error, setError] = useState<string | null>(null)
  const nums = amounts.map((a) => num(a) ?? 0)
  const total = Math.round(nums.reduce((t, n) => t + n, 0) * 100) / 100

  function go(submit: boolean) {
    if (amounts.some((a) => a.trim() && num(a) === undefined)) return setError('金额要填数字')
    if (submit && !(total > 0)) return setError('付款金额是 0 —— 先把金额补上')
    setError(null)
    start(async () => {
      try {
        await mutate({
          kind: 'fillPayRequest',
          payRequestId: r.id,
          payeeAccount: account,
          note,
          amounts: nums,
        })
        if (submit) await mutate({ kind: 'submitPayRequest', payRequestId: r.id })
        showToast(submit ? '已提交审核' : '已保存', 'success')
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : '存不上')
      }
    })
  }

  return (
    <div className="mt-3 max-w-[640px]">
      <div className="flex flex-wrap gap-2.5">
        <input
          value={account}
          onChange={(e) => setAccount(e.target.value)}
          placeholder="收款账户 · 开户行 / 账号 / 联系人"
          className={`${inp} min-w-[240px] flex-1 bg-[var(--color-surface)]`}
        />
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="说明 · 可空"
          className={`${inp} min-w-[160px] flex-1 bg-[var(--color-surface)]`}
        />
      </div>
      <div className="mt-3 grid grid-cols-[minmax(0,1fr)_56px_112px] gap-2 border-b border-[var(--color-border)] pb-1">
        <span className="label">付款清单</span>
        <span className="label text-right">数量</span>
        <span className="label text-right">金额</span>
      </div>
      {r.items.map((i, x) => (
        <div
          key={x}
          className="grid grid-cols-[minmax(0,1fr)_56px_112px] items-center gap-2 border-b border-[var(--color-border)] py-1 text-[12.5px]"
        >
          <span className="min-w-0 break-words text-[var(--color-ink)]">{i.name}</span>
          <span className="mono text-right text-[var(--color-ink-3)]">{i.qty ?? ''}</span>
          <input
            value={amounts[x]}
            onChange={(e) => setAmounts((cur) => cur.map((a, k) => (k === x ? e.target.value : a)))}
            placeholder="没定价 · 补金额"
            inputMode="decimal"
            className={`mono h-8 rounded-[2px] border px-2 text-right text-[12.5px] outline-none ${
              amounts[x].trim()
                ? 'border-[var(--color-border)] bg-[var(--color-surface)]'
                : 'border-[var(--color-overdue)] bg-[var(--color-surface)] placeholder:text-[var(--color-overdue)]'
            }`}
          />
        </div>
      ))}
      <div className="flex justify-end gap-3 pt-1.5 text-[12.5px]">
        <span className="text-[var(--color-ink-3)]">合计</span>
        <span className="mono w-[112px] text-right font-semibold text-[var(--color-ink)]">
          {formatCny(total)}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          disabled={pending}
          onClick={() => go(true)}
          className="h-9 shrink-0 rounded-[2px] bg-[var(--color-ink)] px-4 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-50"
        >
          提交审核
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => go(false)}
          className="h-9 shrink-0 rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 text-[13px] font-medium text-[var(--color-ink-2)] hover:text-[var(--color-ink)] disabled:opacity-50"
        >
          先存着
        </button>
        {error && <span className="text-[12px] text-[var(--color-overdue)]">{error}</span>}
      </div>
    </div>
  )
}

// 浏览器能直接显示的图 —— heic (苹果原图) 显示不了, 跟 PDF 一样点开新页下载。
function isImage(f: { contentType?: string; filename: string }): boolean {
  if (/heic/i.test(`${f.contentType ?? ''} ${f.filename}`)) return false
  if (f.contentType?.startsWith('image/')) return true
  return /\.(png|jpe?g|webp)$/i.test(f.filename)
}

// 付款凭证 / 发票 —— 缩略图一排, 图点开放大 (左右翻), PDF 点开新页看; 「＋」传
// 一张, 鼠标停在这一排上 Ctrl+V 直接贴截图。批下来以后只加不删。
function FileStrip({
  r,
  kind,
  canDelete,
}: {
  r: PayRequest
  kind: PayFileKind
  canDelete: boolean
}) {
  const router = useRouter()
  const zoneRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [viewing, setViewing] = useState<number | null>(null)
  const files = kind === 'voucher' ? r.vouchers : r.invoices
  const images = files.filter(isImage)
  const label = PAY_FILE_LABEL[kind]

  const add = async (fs: File[]) => {
    if (fs.length === 0) return
    setBusy(true)
    try {
      for (const f of fs) await uploadPayFile(r.id, kind, f)
    } catch (e) {
      showToast(e instanceof Error ? e.message : '传不上', 'warning')
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
      router.refresh()
    }
  }

  usePasteImage(zoneRef, (f) => void add([f]))

  const remove = async (fileId: string) => {
    const res = await fetch(
      withBase(
        `/api/pay-request-file?id=${encodeURIComponent(r.id)}&kind=${kind}&fileId=${encodeURIComponent(fileId)}`,
      ),
      { method: 'DELETE' },
    ).catch(() => null)
    const d = (await res?.json().catch(() => ({}))) as { ok?: boolean; error?: string } | undefined
    if (!d?.ok) showToast(d?.error ?? '删不掉', 'warning')
    router.refresh()
  }

  return (
    <div ref={zoneRef} className="flex flex-wrap items-center gap-2">
      <span className="label w-[56px] shrink-0">{label}</span>
      <input
        ref={fileRef}
        type="file"
        multiple
        accept="image/*,application/pdf"
        className="hidden"
        onChange={(e) => void add(Array.from(e.target.files ?? []))}
      />
      {files.map((f) => (
        <span key={f.id} className="group/ph relative">
          {isImage(f) ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={proxiedStorageUrl(f.url)}
              alt={f.filename}
              title={`${f.filename}${f.uploadedBy ? ` · ${f.uploadedBy}` : ''} — 点开放大`}
              onClick={() => setViewing(images.indexOf(f))}
              className="h-[48px] w-[48px] cursor-zoom-in rounded-[2px] border border-[var(--color-border)] object-cover"
            />
          ) : (
            <a
              href={proxiedStorageUrl(f.url)}
              target="_blank"
              rel="noreferrer"
              title={f.filename}
              className="flex h-[48px] w-[48px] items-center justify-center rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] text-[10.5px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
            >
              {/\.pdf$/i.test(f.filename) ? 'PDF' : '图'}
            </a>
          )}
          {canDelete && (
            <button
              type="button"
              title="删掉这一个"
              onClick={() => void remove(f.id)}
              className="absolute -right-1 -top-1 hidden h-[15px] w-[15px] items-center justify-center rounded-full bg-[var(--color-ink)] text-[9px] leading-none text-[var(--color-surface)] group-hover/ph:flex"
            >
              ✕
            </button>
          )}
        </span>
      ))}
      <button
        type="button"
        disabled={busy}
        onClick={() => fileRef.current?.click()}
        className="inline-flex h-[48px] min-w-[48px] items-center justify-center rounded-[2px] border border-dashed border-[var(--color-border-strong)] px-2 text-[11.5px] text-[var(--color-ink-3)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)] disabled:opacity-50"
      >
        {busy ? '上传中' : files.length === 0 ? `＋ ${label}` : '＋'}
      </button>
      {viewing !== null && images.length > 0 && (
        <PhotoViewer
          items={images.map((f) => ({ url: f.url, filename: f.filename }))}
          start={viewing}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  )
}
