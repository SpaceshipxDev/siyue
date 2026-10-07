import { NextRequest } from 'next/server'
import { currentUser, canEditAttendance, canEditHrRecord } from '@/lib/auth'
import { parseWorkbook } from '@/lib/xlsx'
import { extractAttendanceFromXlsx } from '@/lib/gemini'
import { HR_TYPES, hrHasHours, type HrType } from '@/lib/data'
import { isPayrollMonth } from '@/lib/payroll'
import { errMessage } from '@/lib/err'
import { guessMonth, parsePunchSheets } from '@/lib/punch-parse'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// 考勤表上传 —— 只解析，不落库。
//
// 读出来的东西先回到浏览器让人过一眼（哪条不对当场划掉），确认了才走
// mutate 写进人事。一张打卡机导出的表三百条，错一条比漏一条难查，所以中间
// 这一眼是这条路上最要紧的一步，不能省。
export async function POST(request: NextRequest) {
  // 这条路上不能用 requireHrUser: 它没登录就 redirect, 在接口里会变成一个
  // 谁也看不懂的错误。自己判, 自己回话。
  const user = await currentUser()
  // 考勤表页签上导打卡 (mode=punch) 人事也能导; 导进人事记录还是改删那一档。
  if (!user || !canEditAttendance(user)) {
    return Response.json({ ok: false, error: '没有导入权限' }, { status: 403 })
  }

  let form: FormData
  try {
    form = await request.formData()
  } catch (err) {
    return Response.json({ ok: false, error: errMessage(err) }, { status: 400 })
  }

  if (String(form.get('mode') ?? '') !== 'punch' && !canEditHrRecord(user)) {
    return Response.json({ ok: false, error: '没有导入权限' }, { status: 403 })
  }

  const file = form.get('file')
  const month = String(form.get('month') ?? '')
  if (!(file instanceof File)) {
    return Response.json({ ok: false, error: '没有收到文件' }, { status: 400 })
  }
  if (!isPayrollMonth(month)) {
    return Response.json({ ok: false, error: '月份不对' }, { status: 400 })
  }

  try {
    const buf = await file.arrayBuffer()
    const wb = parseWorkbook(buf, file.name)
    // 整本读进去，让模型自己认哪张是考勤表；一张月考勤表的格子数对它不算多。
    const sheets = wb.sheets.map((s) => ({ name: s.name, aoa: s.aoa }))

    // 考勤表页签上导的打卡表 (mode=punch) —— 只要每天的上下班时间, 别的一概
    // 不读: 不往人事考勤里记, 不往工资里记。先按格子直接读 (快、读不断), 读
    // 不出来才交给识别模型兜底。
    if (String(form.get('mode') ?? '') === 'punch') {
      const m = guessMonth(sheets, file.name) ?? month
      let punches: { name: string; dept?: string; day: number; in?: string; out?: string; hours?: number }[] =
        parsePunchSheets(sheets, m)
      if (punches.length === 0) {
        const ai = await extractAttendanceFromXlsx({ fileName: file.name, month: m, sheets })
        const hhmm = (v: unknown) => {
          const t = String(v ?? '').trim().match(/^(\d{1,2}):(\d{2})/)
          return t && Number(t[1]) <= 23 && Number(t[2]) <= 59 ? `${t[1].padStart(2, '0')}:${t[2]}` : undefined
        }
        type P = (typeof punches)[number]
        punches = (ai.punches ?? []).flatMap((p): P[] => {
          const name = String(p.name ?? '').trim()
          const date = String(p.date ?? '').trim()
          if (!name || !date.startsWith(m)) return []
          const day = Number(date.slice(8, 10))
          const tin = hhmm(p.in)
          const tout = hhmm(p.out)
          if (tin && tout && tin !== tout) return [{ name, day, in: tin, out: tout }]
          const h = typeof p.hours === 'number' && p.hours > 0 && p.hours <= 24 ? p.hours : 0
          return h > 0 ? [{ name, day, hours: Math.round(h * 10) / 10 }] : []
        })
      }
      if (punches.length === 0)
        return Response.json({ ok: false, error: '没读出打卡时间 —— 表上要有姓名和每天的上下班时间' })
      return Response.json({ ok: true, month: m, records: [], summaries: [], punches })
    }

    const parsed = await extractAttendanceFromXlsx({
      fileName: file.name,
      month,
      sheets,
    })
    const raw = parsed.records
    // 这张表记哪个月 —— 表上写的为准 (月初导上个月的表是常事), 表上认不出才
    // 用页面上选着的那个月。汇总行没有日期, 全靠这个月份落账。
    const sheetMonth =
      parsed.month && isPayrollMonth(parsed.month) ? parsed.month : month

    // 汇总表 —— 一人一行, 没有日期, 只有这个月的合计。厂里打卡机导出的就是
    // 这一种, 工资那边要的也正是这四个数。
    const num = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 999
        ? Math.round(v * 10) / 10
        : undefined
    const summaries = (parsed.summaries ?? [])
      .map((r) => {
        const name = String(r.name ?? '').trim()
        if (!name) return null
        const row = {
          name,
          workedDays: num(r.workedDays),
          workedHours: num(r.workedHours),
          otWeekdayHours: num(r.otWeekdayHours) ?? 0,
          otWeekendHours: num(r.otWeekendHours) ?? 0,
        }
        // 四个数全是空的那一行不是人, 是表头或者小计行。
        if (
          row.workedDays === undefined &&
          row.workedHours === undefined &&
          row.otWeekdayHours === 0 &&
          row.otWeekendHours === 0
        )
          return null
        return row
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'))

    // 模型输出照单全收是不行的：类型必须是人事认的那几个词，时长必须是正
    // 数，日期必须落在这张表的月份里 (表上写的那个月, 不是页面上选着的那个
    // 月) —— 落在别的月份多半是它把"3/5"读串了。
    const records = raw
      .map((r) => {
        const name = String(r.name ?? '').trim()
        const type = String(r.type ?? '').trim()
        const date = String(r.date ?? '').trim()
        if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
        if (!(HR_TYPES as readonly string[]).includes(type)) return null
        if (!date.startsWith(sheetMonth)) return null
        const t = type as HrType
        const hours =
          typeof r.hours === 'number' && Number.isFinite(r.hours) && r.hours > 0
            ? Math.round(r.hours * 10) / 10
            : undefined
        // 有时长的类型没读出时长就没法记（人事那边也是这么挡的）。
        if (hrHasHours(t) && hours === undefined) return null
        const note = String(r.note ?? '').trim()
        return {
          name,
          type: t,
          date,
          hours: hrHasHours(t) ? hours : undefined,
          note: note || undefined,
        }
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name, 'zh'))

    // 打卡明细 —— 每人每天打卡上了几小时 (没打卡是 0)。只认这张表那个月的日子。
    const punches = (parsed.punches ?? [])
      .map((p) => {
        const name = String(p.name ?? '').trim()
        const date = String(p.date ?? '').trim()
        if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !date.startsWith(sheetMonth)) return null
        // 上下班时间原样带回去 (HH:MM) —— 扣不扣午休、扣多少, 考勤表上按这个
        // 人的部门算; 表上只给了工时的, 才用工时。
        const hhmm = (v: unknown) => {
          const m = String(v ?? '').trim().match(/^(\d{1,2}):(\d{2})/)
          if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return undefined
          return `${m[1].padStart(2, '0')}:${m[2]}`
        }
        const tin = hhmm(p.in)
        const tout = hhmm(p.out)
        const h =
          typeof p.hours === 'number' && Number.isFinite(p.hours) && p.hours >= 0 && p.hours <= 24
            ? Math.round(p.hours * 10) / 10
            : 0
        return tin && tout && tin !== tout
          ? { name, day: Number(date.slice(8, 10)), in: tin, out: tout }
          : { name, day: Number(date.slice(8, 10)), hours: h }
      })
      .filter((p): p is NonNullable<typeof p> => p !== null)

    return Response.json({
      ok: true,
      month: sheetMonth,
      records,
      summaries,
      punches,
      dropped: raw.length - records.length,
    })
  } catch (err) {
    return Response.json({ ok: false, error: errMessage(err) }, { status: 500 })
  }
}
