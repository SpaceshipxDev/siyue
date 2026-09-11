'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { withBase } from '@/lib/base-path'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'
import { hrHasHours, type HrType } from '@/lib/data'

// 考勤表导入 —— 把打卡机导出的那张 Excel 摊平成人事记录。
//
// 三步，中间那一步是关键：
//   选文件 → **预览、划掉不对的** → 记入
//
// 一张月考勤表两三百条，人不可能一条条手敲；但也不能读完就直接落库 —— 读错
// 一条比漏一条难查得多。所以中间这一眼不能省：读出来的东西先摆在这儿，一行
// 一个叉，划完再按"记入"。
//
// 落库走的是和手记同一条路 (mutate addHrRecords)，校验、部门归属、谁记的，
// 一个字都没放松。

type Row = {
  name: string
  type: HrType
  date: string
  hours?: number
  note?: string
}

export function HrImport({ month }: { month: string }) {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [rows, setRows] = useState<Row[] | null>(null)
  const [fileName, setFileName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const pick = () => fileRef.current?.click()

  const onFile = async (file: File) => {
    setError(null)
    setBusy(true)
    setFileName(file.name)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('month', month)
      const res = await fetch(withBase('/api/hr-import'), {
        method: 'POST',
        body: fd,
      })
      const data = (await res.json()) as {
        ok?: boolean
        error?: string
        records?: Row[]
        dropped?: number
      }
      if (!data.ok || !data.records) {
        setError(data.error ?? '读不出来')
        return
      }
      if (data.records.length === 0) {
        setError('这张表里没读到加班或请假的记录')
        return
      }
      setRows(data.records)
    } catch (e) {
      setError(e instanceof Error ? e.message : '读不出来')
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const commit = async () => {
    if (!rows || rows.length === 0) return
    setBusy(true)
    try {
      const r = await mutate<{ count: number }>({
        kind: 'addHrRecords',
        inputs: rows.map((x) => ({
          name: x.name,
          type: x.type,
          date: x.date,
          hours: hrHasHours(x.type) ? x.hours : undefined,
          note: x.note,
        })),
      })
      setRows(null)
      showToast(`已记入 ${r.data.count} 条`, 'success')
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : '记不上')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx,.xls,.csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void onFile(f)
        }}
      />
      <button
        type="button"
        onClick={pick}
        disabled={busy}
        className="rounded-[2px] border border-[var(--color-border)] px-3 py-1 text-[12.5px] font-medium text-[var(--color-ink-2)] hover:border-[var(--color-border-strong)] disabled:opacity-50"
      >
        {busy && !rows ? '读表中…' : '导入考勤表'}
      </button>

      {error && !rows ? (
        <span className="text-[12px] text-[var(--color-overdue)]">{error}</span>
      ) : null}

      {rows ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 px-4">
          <div className="flex max-h-[82vh] w-full max-w-2xl flex-col rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[0_12px_40px_rgba(0,0,0,0.18)]">
            <div className="flex items-baseline justify-between gap-4 border-b border-[var(--color-border)] px-5 py-3">
              <span className="text-[14px] font-semibold tracking-tight">
                读到 {rows.length} 条 · {monthLabel(month)}
              </span>
              <span className="min-w-0 truncate text-[11.5px] text-[var(--color-ink-4)]">
                {fileName}
              </span>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-1">
              {rows.map((r, i) => (
                <div
                  key={`${r.name}-${r.date}-${r.type}-${i}`}
                  className="flex items-baseline gap-3 border-b border-[var(--color-border)] py-2 last:border-b-0"
                >
                  <span className="mono shrink-0 text-[12.5px] text-[var(--color-ink-2)]">
                    {r.date.slice(5)}
                  </span>
                  <span className="w-[72px] shrink-0 truncate text-[13px] font-medium">
                    {r.name}
                  </span>
                  <span className="w-[56px] shrink-0 text-[12.5px] text-[var(--color-ink)]">
                    {r.type}
                  </span>
                  <span className="mono w-[48px] shrink-0 text-right text-[12.5px] text-[var(--color-ink-2)]">
                    {r.hours ? `${r.hours}h` : ''}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-ink-3)]">
                    {r.note}
                  </span>
                  <button
                    type="button"
                    title="不记这一条"
                    onClick={() =>
                      setRows((cur) =>
                        (cur ?? []).filter((_, j) => j !== i),
                      )
                    }
                    className="shrink-0 px-1 text-[12px] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)]"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>

            <div className="flex items-center gap-3 border-t border-[var(--color-border)] px-5 py-3">
              <button
                type="button"
                onClick={commit}
                disabled={busy || rows.length === 0}
                className="rounded-[2px] bg-[var(--color-ink)] px-4 py-1.5 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-40"
              >
                {busy ? '记入中…' : `记入 ${rows.length} 条`}
              </button>
              <button
                type="button"
                onClick={() => {
                  setRows(null)
                  setError(null)
                }}
                disabled={busy}
                className="text-[12.5px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
              >
                取消
              </button>
              {error ? (
                <span className="text-[12px] text-[var(--color-overdue)]">
                  {error}
                </span>
              ) : (
                <span className="ml-auto text-[11.5px] text-[var(--color-ink-4)]">
                  不对的划掉再记 · 加班会自动分平时和周末
                </span>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}

function monthLabel(m: string): string {
  const [y, mm] = m.split('-')
  return `${y}年${Number(mm)}月`
}
