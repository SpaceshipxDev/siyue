'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { withBase } from '@/lib/base-path'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'
import { formatCny } from '@/lib/data'

// 工资表导入 —— 把 Excel 上定好的那张表读进名册。
//
// 三步，中间那一步是关键：
//   选文件 → **预览、划掉不对的** → 导入
//
// 读两类东西，各归各的地方：
//   跟着人走的四样（姓名 · 部门 · 综合工资 · 房补）→ 名册，定一次管往后每月
//   按月变的（实际出勤小时 · 出勤天数 · 平时/周末加班）→ 当月的考勤汇总
//
// 厂里的工资表常常把考勤也抄在同一张表上，那就顺手一起读进来，省得再单独传
// 一份考勤表。表上没有的列一概不动。
//
// 表里没给的那一列不动：只有部门那一列的表，不会把谁的工资清成 0。已经在表
// 上的人是更新，没有的人是新加。

type Row = {
  name: string
  dept?: string
  monthlyCny?: number
  housingAllowanceCny?: number
  // 按月变的那几样 —— 写进当月的考勤汇总, 不进名册。
  workedDays?: number
  workedHours?: number
  otWeekdayHours?: number
  otWeekendHours?: number
}

/** 这一行带没带考勤 —— 带了就顺手把当月的出勤和加班也写了。 */
function hasAttendance(r: Row): boolean {
  return (
    r.workedDays !== undefined ||
    r.workedHours !== undefined ||
    r.otWeekdayHours !== undefined ||
    r.otWeekendHours !== undefined
  )
}

export function PayrollImport({
  month,
  locked,
}: {
  /** 当前看的那个月 — 表上抄来的考勤写进这个月。 */
  month: string
  locked: boolean
}) {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [rows, setRows] = useState<Row[] | null>(null)
  const [fileName, setFileName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const onFile = async (file: File) => {
    setError(null)
    setBusy(true)
    setFileName(file.name)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch(withBase('/api/payroll-import'), {
        method: 'POST',
        body: fd,
      })
      const data = (await res.json()) as {
        ok?: boolean
        error?: string
        rows?: Row[]
      }
      if (!data.ok || !data.rows || data.rows.length === 0) {
        setError(data.error ?? '这张表里没读到人')
        return
      }
      setRows(data.rows)
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
      const r = await mutate<{ added: number; updated: number }>({
        kind: 'importPayrollBase',
        rows,
      })
      // 表上抄了考勤的那几行 —— 出勤小时和加班写进这个月的考勤汇总。名册那
      // 边只管跟着人走的四样, 按月变的东西不该躺在名册里。
      const att = rows.filter(hasAttendance)
      let attCount = 0
      if (att.length > 0) {
        const a = await mutate<{ count: number }>({
          kind: 'saveAttendanceSummary',
          month,
          rows: att.map((x) => ({
            name: x.name,
            workedDays: x.workedDays,
            workedHours: x.workedHours,
            otWeekdayHours: x.otWeekdayHours ?? 0,
            otWeekendHours: x.otWeekendHours ?? 0,
          })),
        })
        attCount = a.data.count
      }
      setRows(null)
      showToast(
        `已导入 · 新增 ${r.data.added} 人 · 更新 ${r.data.updated} 人` +
          (attCount > 0 ? ` · 考勤 ${attCount} 人` : ''),
        'success',
      )
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : '导入失败')
    } finally {
      setBusy(false)
    }
  }

  if (locked) return null

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
        onClick={() => fileRef.current?.click()}
        disabled={busy}
        className="rounded-[2px] border border-[var(--color-border)] px-4 py-2 text-[13px] font-medium text-[var(--color-ink-2)] hover:border-[var(--color-border-strong)] disabled:opacity-50"
      >
        {busy && !rows ? '读表中…' : '导入工资表'}
      </button>

      {rows ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 px-4">
          <div className="flex max-h-[82vh] w-full max-w-xl flex-col rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[0_12px_40px_rgba(0,0,0,0.18)]">
            <div className="flex items-baseline justify-between gap-4 border-b border-[var(--color-border)] px-5 py-3">
              <span className="text-[14px] font-semibold tracking-tight">
                读到 {rows.length} 人
              </span>
              <span className="min-w-0 truncate text-[11.5px] text-[var(--color-ink-4)]">
                {fileName}
              </span>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-1">
              {rows.map((r, i) => (
                <div
                  key={`${r.name}-${i}`}
                  className="flex items-baseline gap-3 border-b border-[var(--color-border)] py-2 last:border-b-0"
                >
                  <span className="w-[76px] shrink-0 truncate text-[13px] font-medium">
                    {r.name}
                  </span>
                  <span className="w-[72px] shrink-0 truncate text-[12px] text-[var(--color-ink-3)]">
                    {r.dept ?? ''}
                  </span>
                  <span className="mono w-[80px] shrink-0 text-right text-[12.5px] text-[var(--color-ink)]">
                    {r.monthlyCny !== undefined ? formatCny(r.monthlyCny) : ''}
                  </span>
                  <span className="mono w-[96px] shrink-0 text-right text-[12.5px] text-[var(--color-ink-2)]">
                    {r.housingAllowanceCny !== undefined
                      ? `房补 ${formatCny(r.housingAllowanceCny)}`
                      : ''}
                  </span>
                  <span className="mono min-w-0 flex-1 truncate text-[12px] text-[var(--color-ink-3)]">
                    {r.workedHours !== undefined ? `出勤 ${r.workedHours}h` : ''}
                    {r.otWeekdayHours ? ` 平时 ${r.otWeekdayHours}h` : ''}
                    {r.otWeekendHours ? ` 周末 ${r.otWeekendHours}h` : ''}
                  </span>
                  <button
                    type="button"
                    title="不导这一行"
                    onClick={() =>
                      setRows((cur) => {
                        const next = (cur ?? []).filter((_, j) => j !== i)
                        return next.length > 0 ? next : null
                      })
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
                {busy ? '导入中…' : `导入 ${rows.length} 人`}
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
                  表里没给的那一列不动 · 工资真的动了会记一条调薪 · 出勤和加
                  班写进当月
                </span>
              )}
            </div>
          </div>
        </div>
      ) : error ? (
        <span className="text-[12px] text-[var(--color-overdue)]">{error}</span>
      ) : null}
    </>
  )
}
