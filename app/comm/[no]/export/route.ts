import { notFound, redirect } from 'next/navigation'
import { canWriteCommSheet, landingPathFor, requireUser } from '@/lib/auth'
import { commOrderTitle, dueOf, getCommOrder, jobDueDates } from '@/lib/comm-order'
import { buildCommOrderWorkbook } from '@/lib/comm-order-xlsx'
import { contentDisposition } from '@/lib/content-disposition'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// 按工号导出 —— 跟厂里原来那张 Excel 一个样子, 图片嵌在格子里。
export async function GET(_req: Request, ctx: { params: Promise<{ no: string }> }) {
  const user = await requireUser()
  if (!canWriteCommSheet(user)) redirect(landingPathFor(user))
  const { no } = await ctx.params
  let jobNo = no
  try {
    jobNo = decodeURIComponent(no)
  } catch {}
  const sheet = await getCommOrder(jobNo)
  if (!sheet) notFound()
  const wb = await buildCommOrderWorkbook(sheet, dueOf(sheet.jobNo, sheet.dueDate, await jobDueDates()))
  const body = await wb.xlsx.writeBuffer()
  return new Response(body, {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': contentDisposition(`${commOrderTitle(sheet.jobNo)}.xlsx`, 'attachment'),
      'cache-control': 'no-store',
    },
  })
}
