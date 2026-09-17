'use client'

import { useMemo, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/mutate'
import { withBase } from '@/lib/base-path'
import { proxiedStorageUrl } from '@/lib/storage-url'
import { showToast } from '@/app/_toast'
import { EditableText, EditableTextArea } from '@/app/_editable'
import type { ChangePhoto, ChangeRecord } from '@/lib/changes'

// 变更管理 —— 客户把要求改了。
//
// 别的几张表记的是"做出来的东西不对"，这一张记的是"要求本身变了"：图纸改了、
// 尺寸改了、颜色改了。厂里最贵的质量事故有一半是这么来的——不是做错了，是照
// 着旧图做对了。
//
// 所以这张表就五件事：哪个客户 · 哪天变的 · 变了什么 · 谁发起的 · 图。图是
// 最要紧的一项：变更十有八九是"看这张新图"，一句话说不清，所以图能传多张，
// 点开放大到满屏。

const MONTHS = [
  '01', '02', '03', '04', '05', '06',
  '07', '08', '09', '10', '11', '12',
]

const COLS =
  'grid-cols-[64px_minmax(0,1fr)_96px_72px_minmax(0,2fr)_minmax(0,1fr)_72px_28px]'

export function ChangesBoard({
  rows,
  todayStr,
  customers,
  depts,
  defaultDept,
  canEdit,
}: {
  rows: ChangeRecord[]
  todayStr: string
  /** 打过交道的客户 — 录入那一格的联想。 */
  customers: string[]
  depts: string[]
  defaultDept: string
  /**
   * 改已经填下去的东西 / 删一条 / 删图 — 质量 + 工程 + 商务于海伟。
   * 记一条、补一个还空着的格、加图，有账号的人都可以，不看这个。
   */
  canEdit: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [month, setMonth] = useState(todayStr.slice(5, 7))
  const [q, setQ] = useState('')
  const [armDelete, setArmDelete] = useState<string | null>(null)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const year = todayStr.slice(0, 4)

  // 记一笔
  const [date, setDate] = useState(todayStr)
  const [customer, setCustomer] = useState('')
  const [jobNo, setJobNo] = useState('')
  const [dept, setDept] = useState(defaultDept)
  const [content, setContent] = useState('')
  const [error, setError] = useState<string | null>(null)

  const monthRows = useMemo(() => {
    const ym = `${year}-${month}`
    const needle = q.trim().toLowerCase()
    return rows
      .filter((r) => r.date.slice(0, 7) === ym)
      .filter((r) =>
        !needle
          ? true
          : [r.customer, r.jobNo, r.dept, r.content, r.by]
              .filter(Boolean)
              .join(' ')
              .toLowerCase()
              .includes(needle),
      )
  }, [rows, year, month, q])

  const noPhoto = monthRows.filter((r) => r.photos.length === 0).length

  function add() {
    if (!customer.trim()) return setError('先填客户')
    if (!content.trim()) return setError('填一下变更内容')
    setError(null)
    start(async () => {
      try {
        await mutate({
          kind: 'addChangeRecord',
          input: {
            date,
            customer: customer.trim(),
            jobNo: jobNo.trim(),
            dept: dept.trim(),
            content: content.trim(),
          },
        })
        setCustomer('')
        setJobNo('')
        setContent('')
        setDate(todayStr)
        setMonth(date.slice(5, 7))
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : '记不上')
      }
    })
  }

  async function patch(id: string, p: Record<string, unknown>) {
    await mutate({ kind: 'updateChangeRecord', changeId: id, patch: p })
    router.refresh()
  }

  function remove(id: string) {
    start(async () => {
      try {
        await mutate({ kind: 'deleteChangeRecord', changeId: id })
        setArmDelete(null)
        router.refresh()
      } catch (e) {
        showToast(e instanceof Error ? e.message : '删不掉', 'warning')
      }
    })
  }

  const inp =
    'h-9 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]'

  const exportHref = `/quality/export?v=change&m=${year}-${month}${
    q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''
  }`

  return (
    <div>
      <div className="mb-5 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-4 md:px-5">
        <div className="flex flex-wrap items-center gap-2.5">
          <input
            type="date"
            value={date}
            max={todayStr}
            onChange={(e) => setDate(e.target.value || todayStr)}
            className={`mono ${inp}`}
          />
          <input
            value={customer}
            onChange={(e) => setCustomer(e.target.value)}
            placeholder="客户"
            list="change-customers"
            className={`${inp} w-[150px]`}
          />
          <datalist id="change-customers">
            {customers.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <input
            value={jobNo}
            onChange={(e) => setJobNo(e.target.value)}
            placeholder="工号 · 可空"
            className={`mono ${inp} w-[118px]`}
          />
          <input
            value={dept}
            onChange={(e) => setDept(e.target.value)}
            placeholder="发起部门"
            list="change-depts"
            className={`${inp} w-[100px]`}
          />
          <datalist id="change-depts">
            {depts.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
          <input
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="变更内容 · 改了什么"
            onKeyDown={(e) => e.key === 'Enter' && add()}
            className={`${inp} min-w-[200px] flex-1`}
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
        {error && (
          <p className="mt-2 text-[12px] text-[var(--color-overdue)]">
            {error}
          </p>
        )}
        <p className="mt-2 text-[11.5px] text-[var(--color-ink-4)]">
          先把变更记下来，图在下面那一行点「＋ 图」补——图纸、截图、手机拍的都
          行，可以传多张。
        </p>
      </div>

      <div className="mb-6 flex flex-wrap items-end gap-x-10 gap-y-4">
        <div>
          <p className="text-[32px] font-semibold leading-none tracking-tight tabular-nums text-[var(--color-ink)]">
            {monthRows.length}
          </p>
          <p className="label mt-2.5">{Number(month)}月变更</p>
        </div>
        <div>
          <p
            className={`text-[22px] font-semibold leading-none tracking-tight tabular-nums ${
              noPhoto > 0
                ? 'text-[var(--color-overdue)]'
                : 'text-[var(--color-ink-3)]'
            }`}
          >
            {noPhoto}
          </p>
          <p className="label mt-2.5">还没附图</p>
        </div>
        <div className="ml-auto flex items-center gap-2.5">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索 · 客户 / 工号 / 内容"
            className="h-9 w-[210px] rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
          />
          {canEdit && (
            <Link
              href={exportHref}
              prefetch={false}
              className="rounded-[2px] border border-[var(--color-border)] px-3.5 py-2 text-[13px] font-medium text-[var(--color-ink-2)] hover:border-[var(--color-border-strong)]"
            >
              导出
            </Link>
          )}
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {MONTHS.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMonth(m)}
            className={`rounded-[2px] border bg-[var(--color-surface)] px-2.5 py-1 text-[12.5px] font-medium ${
              m === month
                ? 'border-[var(--color-ink)] text-[var(--color-ink)] shadow-[inset_0_0_0_1px_var(--color-ink)]'
                : 'border-[var(--color-border)] text-[var(--color-ink-3)] hover:border-[var(--color-border-strong)]'
            }`}
          >
            {Number(m)}月
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div
          className={`hidden ${COLS} items-center gap-3 border-b border-[var(--color-border)] bg-[#f5f3ed] px-5 py-2 md:grid`}
        >
          <span className="label">变更日期</span>
          <span className="label">客户</span>
          <span className="label">工号</span>
          <span className="label">发起部门</span>
          <span className="label">变更内容</span>
          <span className="label">图片 / 图纸</span>
          <span className="label">记录人</span>
          <span />
        </div>

        {monthRows.length === 0 ? (
          <p className="px-5 py-12 text-center text-[13px] text-[var(--color-ink-3)]">
            {q ? '没有匹配的记录' : '这个月没有变更'}
          </p>
        ) : (
          monthRows.map((r) => (
            <div
              key={r.id}
              className={`grid ${COLS} items-start gap-3 border-b border-[var(--color-border)] px-4 py-2.5 last:border-b-0 hover:bg-[#faf8f2] md:px-5`}
            >
              <span className="mono text-[12.5px] tabular-nums text-[var(--color-ink-2)]">
                {r.date.slice(5)}
              </span>
              <Cell
                canEdit={canEdit || !r.customer}
                strong
                value={r.customer}
                onSave={(v) => patch(r.id, { customer: v })}
              />
              <Cell
                canEdit={canEdit || !r.jobNo}
                mono
                value={r.jobNo}
                onSave={(v) => patch(r.id, { jobNo: v })}
              />
              <Cell
                canEdit={canEdit || !r.dept}
                value={r.dept}
                onSave={(v) => patch(r.id, { dept: v })}
              />
              <Cell
                canEdit={canEdit || !r.content}
                value={r.content}
                onSave={(v) => patch(r.id, { content: v })}
              />
              <Photos
                changeId={r.id}
                photos={r.photos}
                canDelete={canEdit}
                onOpen={setLightbox}
                onChanged={() => router.refresh()}
              />
              <span
                className="break-words text-[12.5px] text-[var(--color-ink-2)]"
                title={
                  r.createdAt ? `记于 ${r.createdAt.slice(0, 10)}` : undefined
                }
              >
                {r.by || '—'}
              </span>
              <span className="text-right">
                {canEdit &&
                  (armDelete === r.id ? (
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
                  ))}
              </span>
            </div>
          ))
        )}
      </div>

      <p className="mt-4 text-[12px] text-[var(--color-ink-3)]">
        客户改了要求就记在这儿——不是做错了，是照着旧图做对了，那才是最贵的那
        种事故。图能传多张，点一下放大到满屏。还空着的格谁都填得上，填过的要改
        找质量或于海伟。导出的就是屏幕上这一批。
      </p>

      {/* 放大 —— 点哪儿都关得掉。 */}
      {lightbox && (
        <div
          role="dialog"
          aria-label="查看大图"
          className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/85 p-4"
          onClick={() => setLightbox(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={proxiedStorageUrl(lightbox)}
            alt=""
            className="max-h-[92vh] max-w-[94vw] rounded-[2px] bg-white object-contain"
          />
        </div>
      )}
    </div>
  )
}

// 一条变更的图 —— 缩略图一排, 点开放大; 末尾一个「＋ 图」。
function Photos({
  changeId,
  photos,
  canDelete,
  onOpen,
  onChanged,
}: {
  changeId: string
  photos: ChangePhoto[]
  canDelete: boolean
  onOpen: (url: string) => void
  onChanged: () => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  const upload = async (files: File[]) => {
    setBusy(true)
    try {
      for (const f of files) {
        const fd = new FormData()
        fd.append('file', f)
        fd.append('changeId', changeId)
        const res = await fetch(withBase('/api/upload-change-photo'), {
          method: 'POST',
          body: fd,
        })
        const data = (await res.json()) as { ok?: boolean; error?: string }
        if (!data.ok) {
          showToast(data.error ?? '传不上去', 'warning')
          break
        }
      }
      onChanged()
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <input
        ref={fileRef}
        type="file"
        multiple
        accept="image/*,.pdf"
        className="hidden"
        onChange={(e) => {
          const fs = Array.from(e.target.files ?? [])
          if (fs.length > 0) void upload(fs)
        }}
      />
      {photos.map((p) => (
        <span key={p.id} className="group/ph relative">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={proxiedStorageUrl(p.url)}
            alt={p.filename}
            title={`${p.filename}${p.uploadedBy ? ` · ${p.uploadedBy}` : ''} — 点开放大`}
            onClick={() => onOpen(p.url)}
            className="h-[34px] w-[34px] cursor-zoom-in rounded-[2px] border border-[var(--color-border)] object-cover"
          />
          {canDelete && (
            <button
              type="button"
              title="删掉这张图"
              onClick={async () => {
                await mutate({
                  kind: 'deleteChangePhoto',
                  changeId,
                  photoId: p.id,
                })
                onChanged()
              }}
              className="absolute -right-1 -top-1 hidden h-[14px] w-[14px] items-center justify-center rounded-full bg-[var(--color-ink)] text-[9px] leading-none text-[var(--color-surface)] group-hover/ph:flex"
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
        className="rounded-[2px] border border-dashed border-[var(--color-border-strong)] px-1.5 py-1 text-[11px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] disabled:opacity-50"
      >
        {busy ? '传…' : '＋ 图'}
      </button>
    </span>
  )
}

function Cell({
  canEdit,
  value,
  onSave,
  mono,
  strong,
  placeholder = '—',
}: {
  canEdit: boolean
  value?: string
  onSave: (v: string) => Promise<void>
  mono?: boolean
  strong?: boolean
  placeholder?: string
}) {
  const cls = `text-[12.5px] ${
    strong
      ? 'font-medium tracking-tight text-[var(--color-ink)]'
      : 'text-[var(--color-ink-2)]'
  }`
  if (!canEdit) {
    return (
      <span className={`${mono ? 'mono ' : ''}break-words ${cls}`}>
        {value || placeholder}
      </span>
    )
  }
  if (mono) {
    return (
      <EditableText
        mono
        value={value}
        placeholder={placeholder}
        className={cls}
        onSave={onSave}
      />
    )
  }
  return (
    <EditableTextArea
      value={value}
      placeholder={placeholder}
      className={cls}
      onSave={onSave}
    />
  )
}
