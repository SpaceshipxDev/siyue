import { HR_TYPES } from '@/lib/data'
import { HR_SHORT, totalHeader, type AttendanceReport } from '@/lib/hr-report'

// 考勤表那一张格子 —— 人事「考勤表」页签和打印页共用 (口径在 lib/hr-report)。
// 一人一行, 每天一格, 周日那一列浅一点; 旷工 / 违纪 / 质量异常红字; 最后几列
// 是这个月的合计。

const WEEK = ['日', '一', '二', '三', '四', '五', '六']
const TH = 'border border-[#14130f] px-0.5 py-1 font-medium'
const TD = 'border border-[#14130f] px-0.5 py-1 break-all'

export function AttendanceSheet({ report }: { report: AttendanceReport }) {
  if (report.rows.length === 0)
    return (
      <p className="py-16 text-center text-[13px] text-[var(--color-ink-3)]">这个月没有考勤记录</p>
    )
  return (
    <>
      <table className="w-full min-w-[1080px] table-fixed border-collapse bg-white text-center text-[10px] leading-tight text-[var(--color-ink)] print:min-w-0">
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
            <th rowSpan={2} className={TH}>
              序
            </th>
            <th rowSpan={2} className={TH}>
              姓名
            </th>
            <th rowSpan={2} className={TH}>
              部门
            </th>
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
      <p className="mt-2 text-[10.5px] text-[var(--color-ink-3)]">
        {HR_TYPES.map((t) => `${HR_SHORT[t]} = ${t}`).join('　')}
        　· 字后面的数字是小时（加2 = 加班 2 小时）· 空格 = 当天没有记录
      </p>
    </>
  )
}
