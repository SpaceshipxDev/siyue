import { notFound, redirect } from 'next/navigation'
import { STAGES, type Stage } from '@/lib/data'
import { currentUser, landingPathFor } from '@/lib/auth'

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
  // 工程 head's home is the holistic master view, not the per-stage
  // workbench — so a stale `/station/工程` link from cache or muscle memory
  // sends them to /, not back to the old single-stage page.
  const user = await currentUser()
  if (user && stage === user.defaultStage) {
    redirect(landingPathFor(user))
  }
  redirect(`/?stage=${encodeURIComponent(stage)}`)
}
