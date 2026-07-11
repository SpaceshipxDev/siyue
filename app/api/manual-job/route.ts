import { currentUser, canEditProductionFields } from '@/lib/auth'
import { appendComponent, createParsingJob, markJobAsDraft } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function POST() {
  const user = await currentUser()
  if (!user || !canEditProductionFields(user)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const job = await createParsingJob({ sourceFile: '手工新建' })
  await markJobAsDraft(job.id)
  // Yingma's physical packet is one component per traveller. Seed that row so
  // the clerk lands directly in the proven inline editor with nothing else to
  // understand or click.
  await appendComponent(job.id)
  return Response.json({ ok: true, jobId: job.id })
}
