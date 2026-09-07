import { NextRequest } from 'next/server'
import { parseWorkbook } from '@/lib/xlsx'
import { canEditWarehouse, currentUser } from '@/lib/auth'
import { errMessage } from '@/lib/err'

/*
 * 原始台账导入 第一步 — 把拖进来的 .xlsx / .xls / .csv 变成一张纯文字的表格。
 *
 * 只做这一件事: 读出来, 原样交回浏览器。哪一列是日期、哪一列是数量、哪些行
 * 能记账, 全在 app/warehouse/_import.tsx 里当着人的面认 —— 人看得见认成了
 * 什么, 才敢按那个「导入」。这里不写任何东西进库。
 *
 * 整本工作簿的每一张表都交回去: 老台账常常一个月一张表, 只读第一张等于只导
 * 进来一个月。
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MAX_ROWS = 4000
const MAX_COLS = 24

export async function POST(request: NextRequest) {
  const user = await currentUser()
  if (!user || !canEditWarehouse(user)) {
    return Response.json(
      { ok: false, error: '导入原始台账要找工程或于海伟' },
      { status: 401 },
    )
  }

  let file: File | null = null
  try {
    const form = await request.formData()
    const f = form.get('file')
    if (f instanceof File) file = f
  } catch (err) {
    return Response.json({ ok: false, error: errMessage(err) }, { status: 400 })
  }
  if (!file) return Response.json({ ok: false, error: '没有文件' }, { status: 400 })

  try {
    const wb = parseWorkbook(await file.arrayBuffer(), file.name)
    const sheets = wb.sheets
      .map((s) => ({
        name: s.name,
        aoa: s.aoa
          .slice(0, MAX_ROWS)
          .map((row) =>
            row.slice(0, MAX_COLS).map((c) => (c == null ? '' : String(c))),
          ),
      }))
      .filter((s) => s.aoa.length > 0)
    if (!sheets.length) {
      return Response.json({ ok: false, error: '这个文件是空的' }, { status: 400 })
    }
    return Response.json({ ok: true, fileName: wb.fileName, sheets })
  } catch (err) {
    return Response.json(
      { ok: false, error: `这个文件读不了 · ${errMessage(err)}` },
      { status: 400 },
    )
  }
}
