'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import type { ComponentBoardRow, BoardStageChip } from '@/lib/packets'
import { proxiedStorageUrl } from '@/lib/storage-url'
import { mutate } from '@/lib/mutate'

// The PMC's board — every live component as one row, read left to right the
// way a part physically flows: 编程 → CNC OPs → 后处理 → 出货. The 进度
// column answers her one question ("这个单子现在在哪、做了多少、谁在做")
// without walking the floor.

function mdCn(ymd?: string): string {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}/.test(ymd)) return ymd ?? '—'
  const [, m, d] = ymd.slice(0, 10).split('-').map(Number)
  return `${m}/${d}`
}

function relTime(iso?: string): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000))
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins}分钟前`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}小时前`
  return `${Math.floor(hrs / 24)}天前`
}

function dueTone(ymd: string | undefined, shipped: boolean): string {
  if (shipped || !ymd) return 'text-[var(--color-ink-2)]'
  const today = new Date()
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  if (ymd < iso) return 'text-[var(--color-overdue)] font-semibold'
  if (ymd === iso) return 'text-[var(--color-warning)] font-semibold'
  return 'text-[var(--color-ink)]'
}

function Chip({ chip, qty }: { chip: BoardStageChip; qty: number }) {
  if (chip.status === 'done') {
    return (
      <span
        title={chip.by ? `${chip.label} · ${chip.by}` : chip.label}
        className="inline-flex items-center gap-1 h-6 px-2 rounded-[3px] text-[11px] font-medium bg-[var(--color-success-soft)] text-[var(--color-success)] border border-[var(--color-success)]"
      >
        {chip.label} ✓
      </span>
    )
  }
  if (chip.status === 'in_progress') {
    return (
      <span
        title={chip.by ? `${chip.label} · ${chip.by}` : chip.label}
        className="inline-flex items-center gap-1 h-6 px-2 rounded-[3px] text-[11px] font-semibold bg-[color-mix(in_srgb,var(--color-warning)_14%,transparent)] text-[var(--color-warning)] border border-[var(--color-warning)]"
      >
        {chip.label} {chip.doneQty}/{qty}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center h-6 px-2 rounded-[3px] text-[11px] text-[var(--color-ink-3)] border border-[var(--color-border)]">
      {chip.label}
    </span>
  )
}

type Seg = 'active' | 'shipped' | 'all'

export function ComponentSheet({
  rows,
  canDeleteJobs = false,
}: {
  rows: ComponentBoardRow[]
  canDeleteJobs?: boolean
}) {
  const [q, setQ] = useState('')
  const [seg, setSeg] = useState<Seg>('active')
  const [customer, setCustomer] = useState('')
  const [deletedJobIds, setDeletedJobIds] = useState<Set<string>>(new Set())
  const [deletingJobIds, setDeletingJobIds] = useState<Set<string>>(new Set())
  const [viewer, setViewer] = useState<{
    row: ComponentBoardRow
    index: number
  } | null>(null)

  const customers = useMemo(
    () => [...new Set(rows.map((r) => r.customer).filter(Boolean))].sort(),
    [rows],
  )

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return rows.filter((r) => {
      if (deletedJobIds.has(r.jobId)) return false
      if (seg === 'active' && r.shipped) return false
      if (seg === 'shipped' && !r.shipped) return false
      if (customer && r.customer !== customer) return false
      if (!needle) return true
      return [r.partNo, r.drawingNo, r.name, r.customer, r.jobNo]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle))
    })
  }, [rows, q, seg, customer, deletedJobIds])

  async function removeJob(row: ComponentBoardRow) {
    const partCount = rows.filter((candidate) => candidate.jobId === row.jobId).length
    if (
      !confirm(
        `永久删除工单「${row.jobNo}」及其 ${partCount} 个零件？\n\n生产进度、报工记录和上传资料也会一并删除，此操作无法撤销。`,
      )
    ) {
      return
    }

    setDeletingJobIds((current) => new Set(current).add(row.jobId))
    setDeletedJobIds((current) => new Set(current).add(row.jobId))
    try {
      await mutate({ kind: 'deleteJob', jobId: row.jobId })
    } catch (error) {
      setDeletedJobIds((current) => {
        const next = new Set(current)
        next.delete(row.jobId)
        return next
      })
      alert(error instanceof Error ? `删除失败：${error.message}` : '删除失败')
    } finally {
      setDeletingJobIds((current) => {
        const next = new Set(current)
        next.delete(row.jobId)
        return next
      })
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜 货号 / 图纸号 / 名称 / 客户"
          className="h-9 px-3 w-64 max-w-full text-[13px] border border-[var(--color-border-strong)] rounded-[3px] bg-[var(--color-surface)] outline-none focus:border-[var(--color-ink)]"
        />
        <select
          value={customer}
          onChange={(e) => setCustomer(e.target.value)}
          className="h-9 px-2 text-[13px] border border-[var(--color-border-strong)] rounded-[3px] bg-[var(--color-surface)]"
        >
          <option value="">全部客户</option>
          {customers.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <div className="flex border border-[var(--color-border-strong)] rounded-[3px] overflow-hidden">
          {(
            [
              ['active', '在产'],
              ['shipped', '已出货'],
              ['all', '全部'],
            ] as [Seg, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setSeg(key)}
              className={`h-9 px-3 text-[12px] font-medium ${
                seg === key
                  ? 'bg-[var(--color-ink)] text-[var(--color-surface)]'
                  : 'bg-[var(--color-surface)] text-[var(--color-ink-2)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="text-[12px] text-[var(--color-ink-3)] ml-auto">
          {filtered.length} 个零件
        </span>
      </div>

      <div className="overflow-x-auto border border-[var(--color-border-strong)] rounded-[3px] bg-[var(--color-surface)]">
        <table className="w-full min-w-[1080px] border-collapse">
          <thead>
            <tr className="border-b border-[var(--color-border-strong)] text-left">
              {[
                '源图',
                '客户',
                '货号',
                '描述',
                '图纸号',
                '数量',
                '交期',
                '工序',
                '最近报工',
                ...(canDeleteJobs ? ['操作'] : []),
              ].map(
                (h) => (
                  <th
                    key={h}
                    className="px-3 py-2.5 text-[11px] font-semibold tracking-[0.08em] text-[var(--color-ink-3)] whitespace-nowrap"
                  >
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr
                key={r.partId}
                className="border-b border-[var(--color-border)] last:border-b-0 hover:bg-[var(--color-bg)]"
              >
                <td className="px-3 py-2">
                  <SourceImagesButton row={r} onOpen={() => setViewer({ row: r, index: 0 })} />
                </td>
                <td className="px-3 py-2.5 text-[12px] text-[var(--color-ink-2)] whitespace-nowrap">
                  {r.customer || '—'}
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <Link
                    href={`/jobs/${r.jobId}`}
                    className="font-mono text-[12px] font-semibold text-[var(--color-ink)] underline-offset-2 hover:underline"
                  >
                    {r.partNo || r.jobNo}
                  </Link>
                </td>
                <td className="px-3 py-2.5 text-[13px] font-medium whitespace-nowrap">
                  <Link href={`/jobs/${r.jobId}`} className="hover:underline underline-offset-2">
                    {r.name}
                  </Link>
                </td>
                <td className="px-3 py-2.5 font-mono text-[11px] text-[var(--color-ink-2)] max-w-[220px] truncate">
                  {r.drawingNo || '—'}
                </td>
                <td className="px-3 py-2.5 text-[13px] font-semibold font-mono">{r.qty}</td>
                <td className={`px-3 py-2.5 text-[12px] font-mono whitespace-nowrap ${dueTone(r.dueDate, r.shipped)}`}>
                  {mdCn(r.dueDate)}
                </td>
                <td className="px-3 py-2.5">
                  {/* The whole route in one read: 编程 → OPs → 后处理 → 出货.
                      Exactly the stages this part carries, nothing else. */}
                  <div className="flex items-center gap-1.5 flex-nowrap">
                    <span
                      title={r.programmedBy ? `编程 · ${r.programmedBy}` : '等编程拍照录入'}
                      className={`inline-flex items-center h-6 px-2 rounded-[3px] text-[11px] font-medium border ${
                        r.programmed
                          ? 'bg-[var(--color-success-soft)] text-[var(--color-success)] border-[var(--color-success)]'
                          : 'text-[var(--color-ink-3)] border-[var(--color-border)]'
                      }`}
                    >
                      编程{r.programmed ? ' ✓' : ''}
                    </span>
                    {r.ops.map((c) => (
                      <Chip key={c.stage} chip={c} qty={r.qty} />
                    ))}
                    {r.post ? <Chip chip={{ ...r.post, label: '后处理' }} qty={r.qty} /> : null}
                    {r.shipped ? (
                      <span className="inline-flex items-center h-6 px-2 rounded-[3px] text-[11px] font-medium bg-[var(--color-success-soft)] text-[var(--color-success)] border border-[var(--color-success)]">
                        出货 ✓
                      </span>
                    ) : r.ship && r.ship.doneQty > 0 ? (
                      <span className="inline-flex items-center h-6 px-2 rounded-[3px] text-[11px] font-semibold text-[var(--color-warning)] border border-[var(--color-warning)]">
                        出货 {r.ship.doneQty}/{r.qty}
                      </span>
                    ) : (
                      <span className="inline-flex items-center h-6 px-2 rounded-[3px] text-[11px] text-[var(--color-ink-3)] border border-[var(--color-border)]">
                        出货
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2.5 text-[11px] text-[var(--color-ink-2)] whitespace-nowrap">
                  {r.lastReport ? (
                    <>
                      <span className="font-medium text-[var(--color-ink)]">
                        {r.lastReport.actor}
                      </span>{' '}
                      {r.lastReport.stage} +{r.lastReport.qty} ·{' '}
                      {relTime(r.lastReport.at)}
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                {canDeleteJobs ? (
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      disabled={deletingJobIds.has(r.jobId)}
                      onClick={() => void removeJob(r)}
                      title={`删除工单 ${r.jobNo}`}
                      aria-label={`删除工单 ${r.jobNo}`}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-[3px] text-[var(--color-ink-3)] transition-colors hover:bg-[var(--color-overdue-soft)] hover:text-[var(--color-overdue)] disabled:opacity-40"
                    >
                      <TrashIcon />
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
            {filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={canDeleteJobs ? 10 : 9}
                  className="px-3 py-10 text-center text-[13px] text-[var(--color-ink-3)]"
                >
                  没有匹配的零件 — 编程拍照录入后会自动出现在这里
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {viewer ? (
        <SourceImageViewer
          row={viewer.row}
          index={viewer.index}
          onIndexChange={(index) => setViewer({ row: viewer.row, index })}
          onClose={() => setViewer(null)}
        />
      ) : null}
    </div>
  )
}

function SourceImagesButton({
  row,
  onOpen,
}: {
  row: ComponentBoardRow
  onOpen: () => void
}) {
  const first = row.sourceImages[0]
  if (!first) {
    return (
      <span className="flex h-10 w-10 items-center justify-center rounded-[3px] border border-dashed border-[var(--color-border)] text-[10px] text-[var(--color-ink-4)]">
        —
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`查看 ${row.partNo || row.jobNo} 的源图，共 ${row.sourceImages.length} 张`}
      title={`查看源图 · ${row.sourceImages.length} 张`}
      className="group relative block h-10 w-10 overflow-hidden rounded-[3px] border border-[var(--color-border-strong)] bg-[var(--color-muted-bg)] hover:border-[var(--color-ink)]"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={proxiedStorageUrl(first.url)}
        alt=""
        loading="lazy"
        decoding="async"
        className="h-full w-full object-cover transition-transform group-hover:scale-105"
      />
      {row.sourceImages.length > 1 ? (
        <span className="absolute bottom-0 right-0 min-w-4 bg-black/75 px-1 py-0.5 text-[9px] font-semibold leading-none text-white">
          {row.sourceImages.length}
        </span>
      ) : null}
    </button>
  )
}

function SourceImageViewer({
  row,
  index,
  onIndexChange,
  onClose,
}: {
  row: ComponentBoardRow
  index: number
  onIndexChange: (index: number) => void
  onClose: () => void
}) {
  const images = row.sourceImages
  const image = images[index]

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key === 'ArrowLeft' && images.length > 1) {
        onIndexChange((index - 1 + images.length) % images.length)
      }
      if (event.key === 'ArrowRight' && images.length > 1) {
        onIndexChange((index + 1) % images.length)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [images.length, index, onClose, onIndexChange])

  if (!image) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${row.partNo || row.jobNo} 源图`}
      className="fixed inset-0 z-[100] flex flex-col bg-black/88 p-3 md:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 text-white">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-semibold">
            {row.partNo || row.jobNo} · {row.name}
          </p>
          <p className="mt-0.5 text-[11px] text-white/65">
            {image.label} · {index + 1}/{images.length}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭源图"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/10 text-[24px] leading-none hover:bg-white/20"
        >
          ×
        </button>
      </div>

      <div className="relative mx-auto mt-3 flex min-h-0 w-full max-w-6xl flex-1 items-center justify-center">
        {images.length > 1 ? (
          <button
            type="button"
            onClick={() => onIndexChange((index - 1 + images.length) % images.length)}
            aria-label="上一张源图"
            className="absolute left-0 z-10 flex h-12 w-10 items-center justify-center rounded-r-[4px] bg-black/50 text-[28px] text-white hover:bg-black/75 md:left-2"
          >
            ‹
          </button>
        ) : null}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={proxiedStorageUrl(image.url)}
          alt={`${row.partNo || row.jobNo} · ${image.label}`}
          className="max-h-full max-w-full object-contain"
        />
        {images.length > 1 ? (
          <button
            type="button"
            onClick={() => onIndexChange((index + 1) % images.length)}
            aria-label="下一张源图"
            className="absolute right-0 z-10 flex h-12 w-10 items-center justify-center rounded-l-[4px] bg-black/50 text-[28px] text-white hover:bg-black/75 md:right-2"
          >
            ›
          </button>
        ) : null}
      </div>

      {images.length > 1 ? (
        <div className="mx-auto mt-3 flex max-w-full gap-2 overflow-x-auto pb-1">
          {images.map((candidate, candidateIndex) => (
            <button
              type="button"
              key={`${candidate.url}-${candidateIndex}`}
              onClick={() => onIndexChange(candidateIndex)}
              aria-label={`查看第 ${candidateIndex + 1} 张源图`}
              className={`h-14 w-14 shrink-0 overflow-hidden rounded-[3px] border-2 bg-white/5 ${
                candidateIndex === index ? 'border-white' : 'border-transparent opacity-60 hover:opacity-100'
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={proxiedStorageUrl(candidate.url)}
                alt=""
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover"
              />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function TrashIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v5M14 11v5" />
    </svg>
  )
}
