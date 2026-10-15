'use client'

import { useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { withBase } from '@/lib/base-path'

// 沟通单列表 —— 输工号: 有就点开, 没有就新开一张。导入原来的 Excel 也在这里,
// 工号认标题。

export type CommOrderBrief = { jobNo: string; due: string; rounds: number; by: string; at: string }

export const commHref = (jobNo: string) => `/comm/${encodeURIComponent(jobNo)}`

export function CommOrderList({ sheets, jobNos }: { sheets: CommOrderBrief[]; jobNos: string[] }) {
  const router = useRouter()
  const [q, setQ] = useState('')
  const needle = q.trim().replace(/\s+/g, '').toLowerCase()
  const shown = useMemo(
    () => (needle ? sheets.filter((s) => s.jobNo.toLowerCase().includes(needle)) : sheets),
    [sheets, needle],
  )
  const exact = sheets.find((s) => s.jobNo.toLowerCase() === needle)
  const open = (no: string) => router.push(commHref(no.trim().replace(/\s+/g, '')))

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={q}
          list="comm-jobnos"
          autoFocus
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && needle) open(exact?.jobNo ?? q)
          }}
          placeholder="输工单号查找 / 新建"
          className="mono h-10 min-w-[260px] flex-1 rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-[14px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-ink)]"
        />
        <datalist id="comm-jobnos">
          {jobNos.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        <ImportButton onDone={open} />
      </div>

      {needle && !exact && (
        <button
          type="button"
          onClick={() => open(q)}
          className="mb-4 w-full rounded-[2px] border border-dashed border-[var(--color-border-strong)] px-4 py-3 text-left text-[13px] text-[var(--color-ink-2)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)]"
        >
          新建 <span className="mono font-medium">{q.trim()}</span> 工单分析沟通确认单 →
        </button>
      )}

      <div className="overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        {shown.length === 0 ? (
          <p className="px-5 py-12 text-center text-[13px] text-[var(--color-ink-3)]">
            {needle ? '没有这个工号的沟通单' : '还没有沟通单 —— 输工号新建，或者导入原来的 Excel'}
          </p>
        ) : (
          shown.map((s) => (
            <Link
              key={s.jobNo}
              href={commHref(s.jobNo)}
              className="flex items-baseline gap-6 border-b border-[var(--color-border)] px-5 py-3.5 last:border-b-0 hover:bg-[#f1eee4]"
            >
              <span className="mono w-40 shrink-0 truncate text-[13px] font-medium text-[var(--color-ink)]">
                {s.jobNo}
              </span>
              <span className="mono w-28 shrink-0 text-[12.5px] text-[var(--color-ink-2)]">
                {s.due ? `交期 ${s.due.slice(5)}` : ''}
              </span>
              <span className="flex-1 text-[13px] text-[var(--color-ink-2)]">
                沟通 {s.rounds} 次
              </span>
              <span className="text-[12px] text-[var(--color-ink-3)]">
                {s.by} · {s.at.slice(5, 10)}
              </span>
            </Link>
          ))
        )}
      </div>
    </div>
  )
}

/** 导入 Excel —— jobNo 给了就进那一张, 没给就认标题。 */
export function ImportButton({ jobNo, onDone }: { jobNo?: string; onDone: (jobNo: string) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <span className="flex items-center gap-2">
      <input
        ref={ref}
        type="file"
        accept=".xlsx"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (!file) return
          setBusy(true)
          setError(null)
          try {
            const fd = new FormData()
            fd.append('file', file)
            if (jobNo) fd.append('jobNo', jobNo)
            const res = await fetch(withBase('/api/comm-order/import'), { method: 'POST', body: fd })
            const d = (await res.json()) as { ok?: boolean; jobNo?: string; error?: string }
            if (!d.ok || !d.jobNo) throw new Error(d.error || '导入失败')
            onDone(d.jobNo)
          } catch (err) {
            setError(err instanceof Error ? err.message : '导入失败')
          } finally {
            setBusy(false)
          }
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => ref.current?.click()}
        className="h-10 shrink-0 rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 text-[13px] text-[var(--color-ink-2)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)] disabled:opacity-50"
      >
        {busy ? '导入中…' : '导入 Excel'}
      </button>
      {error && <span className="text-[12px] text-[var(--color-overdue)]">{error}</span>}
    </span>
  )
}
