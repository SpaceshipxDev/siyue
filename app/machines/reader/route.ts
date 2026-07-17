import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { canSeeFactoryPulse, currentUser } from '@/lib/auth'
import { machineDashboardProxyMatches } from '@/lib/machines'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const FILE_NAME = 'YingmaMachineWatcher-4.1.2.zip'
const ARCHIVE_PATH = path.join(
  /* turbopackIgnore: true */ process.cwd(),
  'services',
  'machine-watcher',
  'dist',
  FILE_NAME,
)

export async function GET(request: Request): Promise<Response> {
  if (!machineDashboardProxyMatches(request.headers)) {
    const user = await currentUser()
    if (!user) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
    if (!canSeeFactoryPulse(user)) return Response.json({ ok: false, error: 'forbidden' }, { status: 403 })
  }
  try {
    const archive = await readFile(ARCHIVE_PATH)
    return new Response(archive, {
      headers: {
        'cache-control': 'private, no-store',
        'content-disposition': `attachment; filename="${FILE_NAME}"`,
        'content-length': String(archive.byteLength),
        'content-type': 'application/zip',
      },
    })
  } catch {
    return Response.json({ ok: false, error: 'reader package is not available' }, { status: 503 })
  }
}
