import { notFound } from 'next/navigation'
import { renderToBuffer } from '@react-pdf/renderer'
import { requireOutsourceManager } from '@/lib/auth'
import { ensureOutsourceDocNo, getOutsourceBlock, getVendors } from '@/lib/db'
import { contentDisposition } from '@/lib/content-disposition'
import { fetchImages } from '@/lib/pdf/images'
import { OutsourceDocPDF } from '@/lib/pdf/outsource'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(
  _req: Request,
  ctx: RouteContext<'/print/outsource/[blockId]/pdf/raw'>,
) {
  await requireOutsourceManager()
  const { blockId } = await ctx.params
  const [info, vendors] = await Promise.all([
    getOutsourceBlock(blockId),
    getVendors(),
  ])
  if (!info) notFound()

  const docNo = info.block.docNo ?? (await ensureOutsourceDocNo(blockId))

  const now = new Date()
  const createdAt = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
    2,
    '0',
  )}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(
    2,
    '0',
  )}:${String(now.getMinutes()).padStart(2, '0')}`

  const images = await fetchImages(info.block.members.map((m) => m.imageUrl))

  const pdf = await renderToBuffer(
    OutsourceDocPDF({
      block: info.block,
      jobNo: info.jobNo,
      vendors,
      docNo,
      createdAt,
      images,
    }),
  )

  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': contentDisposition(`outsource-${docNo}.pdf`),
      'Cache-Control': 'no-store',
    },
  })
}
