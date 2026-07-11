import { requireCommerce } from '@/lib/auth'
import { PdfLoader } from '@/app/_pdf_loader'

export const dynamic = 'force-dynamic'

export default async function OutsourcePdfLoaderPage(
  props: PageProps<'/print/outsource/[blockId]/pdf'>,
) {
  await requireCommerce()
  const { blockId } = await props.params
  return <PdfLoader rawHref={`/print/outsource/${blockId}/pdf/raw`} title="外协单 PDF" />
}
