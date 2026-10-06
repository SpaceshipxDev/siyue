import { canSeeAllHr, hrDeptOf, requireHrUser } from '@/lib/auth'
import { getHrMonth } from '@/lib/hr'
import { loadSheetInputs } from '../_sheet_data'
import { BRAND } from '@/lib/brand'
import { today } from '@/lib/today'
import { buildAttendanceReport } from '@/lib/hr-report'
import { AttendanceSheet } from '../_attendance_sheet'
import { PrintButton } from '@/app/_print_button'

export const dynamic = 'force-dynamic'

// 考勤表打印页 —— 人事「考勤表」页签上点「打印」打开的那一张纸: 一个月, 一人一行, 每天一格,
// 后面合计。横着的 A4, 直接打印。口径在 lib/hr-report.ts, 跟导出的表格同一份。
//
// 部门范围跟人事页一样: 看全部的看全厂 (人事记过名字的人没有记录也上表, 一
// 眼看出谁这个月干干净净); 看本部门的只有本部门有记录的人。

export default async function HrReportPage({
  searchParams,
}: {
  searchParams: Promise<{ p?: string }>
}) {
  const user = await requireHrUser()
  const sp = await searchParams
  const month = /^\d{4}-\d{2}$/.test(sp.p ?? '') ? (sp.p as string) : today().slice(0, 7)

  const seeAll = canSeeAllHr(user)
  const myDept = hrDeptOf(user)
  const [all, inputs] = await Promise.all([getHrMonth(month), loadSheetInputs(month, seeAll)])
  const records = seeAll ? all : all.filter((r) => (r.dept ?? '商务') === myDept)
  const report = buildAttendanceReport(
    month,
    records,
    inputs.extraNames,
    inputs.summary,
    inputs.calc,
  )
  const [y, m] = month.split('-')

  return (
    <div className="bg-white">
      <style>{`@page { size: A4 landscape; margin: 8mm; }`}</style>
      <PrintButton />
      <div className="mx-auto max-w-[1180px] px-4 py-6 print:max-w-none print:p-0">
        <header className="mb-3 text-center">
          <p className="text-[12px] tracking-wide text-[var(--color-ink-2)]">{BRAND.legalName}</p>
          <h1 className="mt-1 text-[20px] font-semibold tracking-[0.15em] text-[var(--color-ink)]">
            {y}年{Number(m)}月考勤表
          </h1>
          <p className="mt-1 text-[11px] text-[var(--color-ink-3)]">
            {seeAll ? '全厂' : `${myDept}部门`} · {report.rows.length} 人 · 制表 {user.name} ·{' '}
            {today()}
          </p>
        </header>

        <AttendanceSheet report={report} />
        <div className="mt-8 flex justify-between gap-10 text-[11px] text-[var(--color-ink-2)]">
          {['制表', '审核', '批准'].map((s) => (
            <p key={s} className="min-w-[180px] flex-1">
              {s}
              <span className="mt-6 block h-px w-full bg-[var(--color-ink)]" />
            </p>
          ))}
        </div>
      </div>
    </div>
  )
}
