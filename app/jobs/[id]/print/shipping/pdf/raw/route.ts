import { notFound } from 'next/navigation'
import { renderToBuffer } from '@react-pdf/renderer'
import { requireUser } from '@/lib/auth'
import {
  getCustomers,
  getJob,
  updateJob,
  upsertCustomerByName,
} from '@/lib/db'
import { customerById } from '@/lib/data'
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
  let [job, customers] = await Promise.all([getJob(id), getCustomers()])
  if (!job) notFound()

  // Mirror the preview page: link the customer row on first render so
  // contact/phone are available here. Direct-to-PDF navigation (bookmarks,
  // revalidatePath warm-ups) would otherwise miss the linking the preview
  // performs and print 联系人 as '—' even when the customer record exists.
  if (job.customer && !customerById(job.customerId, customers)) {
    const upserted = await upsertCustomerByName(job.customer)
    if (upserted && job.customerId !== upserted.id) {
      await updateJob(job.id, { customerId: upserted.id })
      const refreshed = await Promise.all([getJob(id), getCustomers()])
      if (!refreshed[0]) notFound()
      job = refreshed[0]
      customers = refreshed[1]
    }
  }

  // Filename uses the 销售单号 to match the 出货单号 now printed on the doc.
  const docNo = job.jobNo || 'draft'
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
