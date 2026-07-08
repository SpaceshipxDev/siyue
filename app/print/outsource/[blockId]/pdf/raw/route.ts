import { notFound } from 'next/navigation'
import { renderToBuffer } from '@react-pdf/renderer'
import QRCode from 'qrcode'
import { requireOutsourceManager } from '@/lib/auth'
import { ensureOutsourceDocNo, getOutsourceBlock, getVendors } from '@/lib/db'
import { vendorById } from '@/lib/data'
import { BRAND } from '@/lib/brand'
import { contentDisposition } from '@/lib/content-disposition'
import { fetchImages } from '@/lib/pdf/images'
import { OutsourceDocPDF } from '@/lib/pdf/outsource'
import { nowStampShanghai } from '@/lib/today'

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

  const createdAt = nowStampShanghai()

  const images = await fetchImages(info.block.members.map((m) => m.imageUrl))

  // Vendor-portal onboarding QR (same silent-onboarding rationale as the HTML
  // doc). Pre-migration vendors have no token → no QR at all.
  const vendor = vendorById(info.block.vendorId, vendors)
  const portalToken = vendor?.portalToken
  const portalQrDataUrl = portalToken
    ? await QRCode.toDataURL(`https://${BRAND.domain}/w/${portalToken}`, {
        margin: 0,
        width: 256,
      })
    : null
  const portalUrlShort = portalToken
    ? `${BRAND.domain}/w/${portalToken.slice(0, 6)}…`
    : null

  const pdf = await renderToBuffer(
    OutsourceDocPDF({
      block: info.block,
      jobNo: info.jobNo,
      vendors,
      docNo,
      createdAt,
      images,
      portalQrDataUrl,
      portalUrlShort,
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
