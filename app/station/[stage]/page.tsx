import { notFound, redirect } from 'next/navigation'
import { STAGES, type Stage } from '@/lib/data'

export const dynamic = 'force-dynamic'

export function generateStaticParams() {
  return STAGES.map((s) => ({ stage: s }))
}

export default async function StationPage(
  props: PageProps<'/station/[stage]'>,
) {
  const { stage: rawStage } = await props.params
  const stage = decodeURIComponent(rawStage) as Stage
  if (!STAGES.includes(stage)) notFound()
  redirect(`/?stage=${encodeURIComponent(stage)}`)
}
