import { notFound } from 'next/navigation'
import { requireProductionOrderExporter } from '@/lib/auth'
import { getJob } from '@/lib/db'
import { fetchImages } from '@/lib/pdf/images'
import { buildProductionOrderWorkbook } from '@/lib/production-order/workbook'

// 一键导出生产单 — rebuilds the 越侬生产单 .xlsx from the stored order so
// nobody hand-maintains it in WPS. 商务 + 工程 (canExportProductionOrder): the
// sheet is a floor traveler with no customer name and no prices, and 工程 owns
// the fields it's built from. Generation prefetches every part photo from
// Storage in parallel (like the 出货单 PDF), so keep maxDuration generous.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(
  _req: Request,
  ctx: RouteContext<'/jobs/[id]/production-order'>,
) {
  await requireProductionOrderExporter()
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
