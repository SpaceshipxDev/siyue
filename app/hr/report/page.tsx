import { canSeeAllHr, hrDeptOf, requireHrUser } from '@/lib/auth'
import { getHrMonth, getHrRoster } from '@/lib/hr'
import { HR_TYPES } from '@/lib/data'
import { BRAND } from '@/lib/brand'
import { today } from '@/lib/today'
import { buildAttendanceReport, HR_SHORT, totalHeader } from '@/lib/hr-report'
import { PrintButton } from '@/app/_print_button'

export const dynamic = 'force-dynamic'

// 考勤报表 —— 人事页「考勤报表」打开的那一张纸: 一个月, 一人一行, 每天一格,
// 后面合计。横着的 A4, 直接打印。口径在 lib/hr-report.ts, 跟导出的表格同一份。
//
// 部门范围跟人事页一样: 看全部的看全厂 (人事记过名字的人没有记录也上表, 一
// 眼看出谁这个月干干净净); 看本部门的只有本部门有记录的人。

const WEEK = ['日', '一', '二', '三', '四', '五', '六']

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
  const [all, roster] = await Promise.all([
    getHrMonth(month),
    seeAll ? getHrRoster() : Promise.resolve([] as string[]),
  ])
  const records = seeAll ? all : all.filter((r) => (r.dept ?? '商务') === myDept)
  const report = buildAttendanceReport(month, records, roster)
  const [y, m] = month.split('-')

  return (
    <div className="bg-white">
      <style>{`@page { size: A4 landscape; margin: 8mm; }`}</style>
      <PrintButton />
      <div className="mx-auto max-w-[1180px] px-4 py-6 print:max-w-none print:p-0">
        <header className="mb-3 text-center">
          <p className="text-[12px] tracking-wide text-[var(--color-ink-2)]">{BRAND.legalName}</p>
          <h1 className="mt-1 text-[20px] font-semibold tracking-[0.15em] text-[var(--color-ink)]">
            {y}年{Number(m)}月考勤报表
          </h1>
          <p className="mt-1 text-[11px] text-[var(--color-ink-3)]">
            {seeAll ? '全厂' : `${myDept}部门`} · {report.rows.length} 人 · 制表 {user.name} ·{' '}
            {today()}
          </p>
        </header>

        {report.rows.length === 0 ? (
          <p className="py-16 text-center text-[13px] text-[var(--color-ink-3)]">这个月没有考勤记录</p>
        ) : (
          <table className="w-full table-fixed border-collapse text-center text-[10px] leading-tight text-[var(--color-ink)]">
            <colgroup>
              <col style={{ width: 22 }} />
              <col style={{ width: 52 }} />
              <col style={{ width: 40 }} />
              {report.weekdays.map((_, i) => (
                <col key={i} />
              ))}
              {HR_TYPES.map((t) => (
                <col key={t} style={{ width: 34 }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th rowSpan={2} className={TH}>序</th>
                <th rowSpan={2} className={TH}>姓名</th>
                <th rowSpan={2} className={TH}>部门</th>
                {report.weekdays.map((w, i) => (
                  <th key={i} className={`${TH} ${w === 0 ? 'bg-[#f1eee4]' : ''}`}>
                    {i + 1}
                  </th>
                ))}
                {HR_TYPES.map((t) => (
                  <th key={t} rowSpan={2} className={`${TH} bg-[#f5f3ed]`}>
                    {totalHeader(t)}
                  </th>
                ))}
              </tr>
              <tr>
                {report.weekdays.map((w, i) => (
                  <th
                    key={i}
                    className={`${TH} font-normal text-[var(--color-ink-3)] ${w === 0 ? 'bg-[#f1eee4]' : ''}`}
                  >
                    {WEEK[w]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.rows.map((r, i) => (
                <tr key={r.name}>
                  <td className={TD}>{i + 1}</td>
                  <td className={`${TD} font-medium`}>{r.name}</td>
                  <td className={`${TD} text-[var(--color-ink-2)]`}>{r.dept}</td>
                  {r.days.map((d, j) => (
                    <td
                      key={j}
                      className={`${TD} ${report.weekdays[j] === 0 ? 'bg-[#f7f5ef]' : ''} ${
                        /[旷违质]/.test(d) ? 'font-semibold text-[var(--color-overdue)]' : ''
                      }`}
                    >
                      {d}
                    </td>
                  ))}
                  {HR_TYPES.map((t) => (
                    <td key={t} className={`${TD} bg-[#fbfaf6] font-medium`}>
                      {r.totals[t] || ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <p className="mt-2 text-[10px] text-[var(--color-ink-3)]">
          图例：
          {HR_TYPES.map((t) => `${HR_SHORT[t]} = ${t}`).join('　')}
          　· 字后面的数字是小时（加2 = 加班 2 小时）· 空格 = 当天没有记录
        </p>
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

const TH = 'border border-[#14130f] px-0.5 py-1 font-medium'
const TD = 'border border-[#14130f] px-0.5 py-1 break-all'
