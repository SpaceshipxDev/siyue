import { requireUser } from '@/lib/auth'
import { PdfLoader } from '@/app/_pdf_loader'

export const dynamic = 'force-dynamic'

export default async function ShippingPdfLoaderPage(
  props: PageProps<'/jobs/[id]/print/shipping/pdf'>,
) {
  await requireUser()
  const { id } = await props.params
  const sp = await props.searchParams
  const shipmentId = typeof sp.shipment === 'string' ? sp.shipment : undefined
  const rawHref = shipmentId
    ? `/jobs/${id}/print/shipping/pdf/raw?shipment=${shipmentId}`
    : `/jobs/${id}/print/shipping/pdf/raw`
  return <PdfLoader rawHref={rawHref} title="出货单 PDF" />
}
