import type { AttendanceReport } from '@/lib/hr-report'
import { HourCell } from './_hour_cell'

// 考勤表那一张格子 —— 人事「考勤表」页签和打印页共用 (口径在 lib/hr-report)。
// 一人一行, 每天一格是那天的上班时长, 周日那一列浅一点; 最后两列是这个月的
// 出勤天数和工时。

const WEEK = ['日', '一', '二', '三', '四', '五', '六']
const TH = 'border border-[#14130f] px-0.5 py-1 font-medium'
const TD = 'border border-[#14130f] px-0.5 py-1 break-all'

export function AttendanceSheet({
  report,
  editable = false,
}: {
  report: AttendanceReport
  /** 能改考勤的人在页签上: 每一格点一下填实际上班时长。打印页不给。 */
  editable?: boolean
}) {
  if (report.rows.length === 0)
    return (
      <p className="py-16 text-center text-[13px] text-[var(--color-ink-3)]">
        这个月还没导入打卡 —— 点上面「导入考勤表」
      </p>
    )
  return (
    <>
      <table className="w-full min-w-[1000px] table-fixed border-collapse bg-white text-center text-[10px] leading-tight text-[var(--color-ink)] print:min-w-0">
        <colgroup>
          <col style={{ width: 22 }} />
          <col style={{ width: 52 }} />
          <col style={{ width: 44 }} />
          {report.weekdays.map((_, i) => (
            <col key={i} />
          ))}
          {report.attendHeaders.map((h) => (
            <col key={h} style={{ width: 40 }} />
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
            {report.attendHeaders.map((h) => (
              <th key={h} rowSpan={2} className={`${TH} bg-[#eef3ec]`}>
                {h}
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
              {r.hours.map((h, j) => (
                <td
                  key={j}
                  className={`${TD} ${report.weekdays[j] === 0 ? 'bg-[#f7f5ef]' : ''}`}
                >
                  <HourCell
                    month={report.month}
                    name={r.name}
                    day={j + 1}
                    value={h}
                    filled={r.filled[j]}
                    codes=""
                    editable={editable}
                  />
                </td>
              ))}
              {r.attend.map((v, k) => (
                <td key={`w${k}`} className={`${TD} bg-[#f6f9f5] font-medium`}>
                  {v}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[10.5px] text-[var(--color-ink-3)]">
        每天的数字 = 当天上班时长（小时），按导入的打卡算：操机部门是下班减上班；其他部门再扣中午
        1.5 小时（11:30–13:00）和 17:30–18:00 那半小时。没打卡是 0。数字带下划线的是手填的。
        跟人事考勤记录、工资核算都不挂钩。
      </p>
    </>
  )
}
