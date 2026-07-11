import { requireOutsourceManager } from '@/lib/auth'
import { PdfLoader } from '@/app/_pdf_loader'

export const dynamic = 'force-dynamic'

export default async function TravellerPdfLoaderPage(
  props: PageProps<'/print/traveller/[jobId]/pdf'>,
) {
  await requireOutsourceManager()
  const { jobId } = await props.params
  return (
    <PdfLoader rawHref={`/print/traveller/${jobId}/pdf/raw`} title="随工单 PDF" />
  )
}
