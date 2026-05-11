import { requireUser } from '@/lib/auth'
import { PdfLoader } from '@/app/_pdf_loader'

export const dynamic = 'force-dynamic'

export default async function ShippingPdfLoaderPage(
  props: PageProps<'/jobs/[id]/print/shipping/pdf'>,
) {
  await requireUser()
  const { id } = await props.params
  return <PdfLoader rawHref={`/jobs/${id}/print/shipping/pdf/raw`} title="出货单 PDF" />
}
