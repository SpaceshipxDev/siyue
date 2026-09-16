import { NextRequest } from 'next/server'
import { currentUser, canSeeExpenses } from '@/lib/auth'
import { parseWorkbook } from '@/lib/xlsx'
import { extractPayrollFromXlsx } from '@/lib/gemini'
import { errMessage } from '@/lib/err'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// 工资表上传 —— 只解析，不落库。
//
// 跟考勤表那条路一样：读出来的先回到浏览器让人过一眼（哪一行不对当场划掉），
// 确认了才走 mutate 写进名册。工资是钱，读错一个数比漏一行难查得多。
export async function POST(request: NextRequest) {
  const user = await currentUser()
  if (!user || !canSeeExpenses(user)) {
    return Response.json({ ok: false, error: '没有导入权限' }, { status: 403 })
  }

  let form: FormData
  try {
    form = await request.formData()
  } catch (err) {
    return Response.json({ ok: false, error: errMessage(err) }, { status: 400 })
  }

  const file = form.get('file')
  if (!(file instanceof File)) {
    return Response.json({ ok: false, error: '没有收到文件' }, { status: 400 })
  }

  try {
    const buf = await file.arrayBuffer()
    const wb = parseWorkbook(buf, file.name)
    const sheets = wb.sheets.map((s) => ({ name: s.name, aoa: s.aoa }))
    const raw = await extractPayrollFromXlsx({ fileName: file.name, sheets })

    const money = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 200000
        ? Math.round(v)
        : undefined
    // 工时按小时, 留一位小数 —— 249.5 这种是常态。
    const hours = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 999
        ? Math.round(v * 10) / 10
        : undefined

    const rows = raw
      .map((r) => {
        const name = String(r.name ?? '').trim()
        if (!name) return null
        const dept = String(r.dept ?? '').trim()
        const row = {
          name,
          dept: dept || undefined,
          monthlyCny: money(r.monthlyCny),
          housingAllowanceCny: money(r.housingAllowanceCny),
          // 按月变的那几样 —— 写进当月的考勤汇总, 不进名册。
          workedDays: hours(r.workedDays),
          workedHours: hours(r.workedHours),
          otWeekdayHours: hours(r.otWeekdayHours),
          otWeekendHours: hours(r.otWeekendHours),
        }
        // 什么都没读到的那一行不是人, 是表头或者分隔行。
        if (
          row.dept === undefined &&
          row.monthlyCny === undefined &&
          row.housingAllowanceCny === undefined &&
          row.workedDays === undefined &&
          row.workedHours === undefined &&
          row.otWeekdayHours === undefined &&
          row.otWeekendHours === undefined
        )
          return null
        return row
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)

    // 同名只留最后一行 —— 一张表里同一个人出现两次, 后面那行多半是更新。
    const byName = new Map<string, (typeof rows)[number]>()
    for (const r of rows) byName.set(r.name, r)

    return Response.json({
      ok: true,
      rows: [...byName.values()],
      dropped: raw.length - byName.size,
    })
  } catch (err) {
    return Response.json({ ok: false, error: errMessage(err) }, { status: 500 })
  }
}
