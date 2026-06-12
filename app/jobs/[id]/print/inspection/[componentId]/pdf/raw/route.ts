import { notFound } from 'next/navigation'
import { renderToBuffer } from '@react-pdf/renderer'
import { requireUser } from '@/lib/auth'
import { getInspectionReport, getJob } from '@/lib/db'
import { emptyReport } from '@/lib/inspection-report'
import { InspectionReportPDF } from '@/lib/pdf/inspection'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(
  _req: Request,
  ctx: RouteContext<'/jobs/[id]/print/inspection/[componentId]/pdf/raw'>,
) {
  await requireUser()
  const { id, componentId } = await ctx.params
  const decodedComponentId = decodeURIComponent(componentId)
  const [job, report] = await Promise.all([
    getJob(id),
    getInspectionReport(id, decodedComponentId),
  ])
  if (!job) notFound()
  const component = job.components.find((c) => c.id === decodedComponentId)
  if (!component) notFound()

  const pdf = await renderToBuffer(
    InspectionReportPDF({
      header: {
        jobNo: job.jobNo,
        customer: job.customer,
        partName: component.name,
        material: component.material ?? '',
        surfaceTreatment: component.surfaceTreatment ?? '',
        qty: component.qty,
      },
      report: report ?? { id: '', ...emptyReport(decodedComponentId) },
    }),
  )

  const fileName = `inspection-${report?.reportNo ?? job.jobNo}.pdf`
  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${encodeURIComponent(fileName)}"`,
      'Cache-Control': 'no-store',
    },
  })
}
