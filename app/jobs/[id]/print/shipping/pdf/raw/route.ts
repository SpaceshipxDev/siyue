import { notFound } from 'next/navigation'
import { renderToBuffer } from '@react-pdf/renderer'
import { requireUser } from '@/lib/auth'
import { getCustomers, getJob } from '@/lib/db'
import { latestShipment } from '@/lib/data'
import { fetchImages } from '@/lib/pdf/images'
import { ShippingDocPDF } from '@/lib/pdf/shipping'

// Raw PDF bytes for the 出货单. The parent /pdf page renders a spinner and
// fetches this URL via XHR/blob so the user gets immediate visual feedback
// (PDF cold renders take 3–6s and a blank tab during that window felt broken).

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// PDF render + Noto Sans SC font fetch (cold start) + N image fetches in
// parallel. Keep generous so an outlier slow image doesn't 504.
export const maxDuration = 60

export async function GET(
  _req: Request,
  ctx: RouteContext<'/jobs/[id]/print/shipping/pdf/raw'>,
) {
  await requireUser()
  const { id } = await ctx.params
  const [job, customers] = await Promise.all([getJob(id), getCustomers()])
  if (!job) notFound()

  const shipment = latestShipment(job)
  const docNo = shipment?.docNo ?? job.shippingDocNo ?? 'draft'
  const images = await fetchImages(job.components.map((c) => c.imageUrl))

  const pdf = await renderToBuffer(
    ShippingDocPDF({ job, customers, images }),
  )

  // Inline so it opens in the browser's PDF viewer; Save still works from there.
  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="shipping-${docNo}.pdf"`,
      'Cache-Control': 'no-store',
    },
  })
}
