import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default async function StationJobPage(
  props: PageProps<'/station/[stage]/[jobId]'>,
) {
  const { jobId } = await props.params
  redirect(`/jobs/${jobId}`)
}
