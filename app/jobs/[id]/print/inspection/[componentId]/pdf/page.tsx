import { requireUser } from '@/lib/auth'
import { PdfLoader } from '@/app/_pdf_loader'

export const dynamic = 'force-dynamic'

export default async function InspectionPdfLoaderPage(
  props: PageProps<'/jobs/[id]/print/inspection/[componentId]/pdf'>,
) {
  await requireUser()
  const { id, componentId } = await props.params
  return (
    <PdfLoader
      rawHref={`/jobs/${id}/print/inspection/${componentId}/pdf/raw`}
      title="出厂检验报告 PDF"
    />
  )
}
