import { notFound } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { getInspectionReport, getJob } from '@/lib/db'
import { emptyReport } from '@/lib/inspection-report'
import { BRAND } from '@/lib/brand'
import { PrintToolbar } from '@/app/_print'
import { ReportEditor } from './_report_editor'

export const dynamic = 'force-dynamic'

// 出厂检验报告 — the editable print surface for the shop's standard
// QR0707-004 template, reachable from the part row / 质量 step. One surface:
// fill in the blanks on the document itself (same pattern as the 外协单
// print page). Header facts come from the live job/part — never stored, so
// the report can't drift from an edited part.

export default async function InspectionReportPage(
  props: PageProps<'/jobs/[id]/print/inspection/[componentId]'>,
) {
  const user = await requireUser()
  const { id, componentId } = await props.params
  const decodedComponentId = decodeURIComponent(componentId)
  const [job, report] = await Promise.all([
    getJob(id),
    getInspectionReport(id, decodedComponentId),
  ])
  if (!job) notFound()
  const component = job.components.find((c) => c.id === decodedComponentId)
  if (!component) notFound()

  const editable =
    user.role === 'commerce' ||
    user.defaultStage === '工程' ||
    user.defaultStage === '检验' ||
    user.defaultStage === '质量'

  return (
    <>
      <PrintToolbar
        pdfHref={`/jobs/${job.id}/print/inspection/${encodeURIComponent(decodedComponentId)}/pdf`}
      />
      <article className="doc">
        <ReportEditor
          jobId={job.id}
          componentId={decodedComponentId}
          header={{
            brand: BRAND.legalName,
            jobNo: job.jobNo,
            customer: job.customer,
            partName: component.name,
            material: component.material ?? '',
            surfaceTreatment: component.surfaceTreatment ?? '',
            qty: component.qty,
          }}
          initial={report ?? { id: '', ...emptyReport(decodedComponentId) }}
          editable={editable}
          userName={user.name}
        />
      </article>
    </>
  )
}
