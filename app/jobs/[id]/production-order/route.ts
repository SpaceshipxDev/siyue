import { notFound } from 'next/navigation'
import { requireCommerce } from '@/lib/auth'
import { getJob } from '@/lib/db'
import { fetchImages } from '@/lib/pdf/images'
import { buildProductionOrderWorkbook } from '@/lib/production-order/workbook'

// 一键导出生产单 — rebuilds the 越侬生产单 .xlsx from the stored order so
// commerce stops hand-maintaining it in WPS. Commerce-only, same gate as the
// 源文件 widget it sits next to. Generation prefetches every part photo from
// Storage in parallel (like the 出货单 PDF), so keep maxDuration generous.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(
  _req: Request,
  ctx: RouteContext<'/jobs/[id]/production-order'>,
) {
  await requireCommerce()
  const { id } = await ctx.params
  const job = await getJob(id)
  if (!job) notFound()

  const images = await fetchImages(job.components.map((c) => c.imageUrl))
  const wb = await buildProductionOrderWorkbook(job, images)
  const body = await wb.xlsx.writeBuffer()

  const jobNo = job.jobNo || 'draft'
  const fallback = `production-order-${jobNo}.xlsx`
  const encoded = encodeURIComponent(`生产单_${jobNo}.xlsx`)

  return new Response(body, {
    headers: {
      'content-type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
      'cache-control': 'no-store',
    },
  })
}
