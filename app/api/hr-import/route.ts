import { NextRequest } from 'next/server'
import { currentUser, canEditHrRecord } from '@/lib/auth'
import { parseWorkbook } from '@/lib/xlsx'
import { extractAttendanceFromXlsx } from '@/lib/gemini'
import { HR_TYPES, hrHasHours, type HrType } from '@/lib/data'
import { isPayrollMonth } from '@/lib/payroll'
import { errMessage } from '@/lib/err'

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
  if (!user || !canEditHrRecord(user)) {
    return Response.json({ ok: false, error: '没有导入权限' }, { status: 403 })
  }

  let form: FormData
  try {
    form = await request.formData()
  } catch (err) {
    return Response.json({ ok: false, error: errMessage(err) }, { status: 400 })
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
    const raw = await extractAttendanceFromXlsx({
      fileName: file.name,
      month,
      sheets,
    })

    // 模型输出照单全收是不行的：类型必须是人事认的那几个词，时长必须是正
    // 数，日期必须落在这张表的月份里 —— 落在别的月份多半是它把"3/5"读串了。
    const records = raw
      .map((r) => {
        const name = String(r.name ?? '').trim()
        const type = String(r.type ?? '').trim()
        const date = String(r.date ?? '').trim()
        if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
        if (!(HR_TYPES as readonly string[]).includes(type)) return null
        if (!date.startsWith(month)) return null
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

    return Response.json({ ok: true, records, dropped: raw.length - records.length })
  } catch (err) {
    return Response.json({ ok: false, error: errMessage(err) }, { status: 500 })
  }
}
