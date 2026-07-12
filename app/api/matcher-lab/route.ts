import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { getUserById } from '@/lib/db'
import { readSession } from '@/lib/session'
import {
  matchLabAsset,
  matchImageBytes,
  matcherStats,
  readLabManifest,
  registerAllLabDocuments,
  resolveLabAsset,
  revealLabFolder,
  runLabSuite,
} from '@/lib/matcher-lab'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

async function authorized(): Promise<boolean> {
  const session = await readSession()
  if (!session) return false
  const user = await getUserById(session.sub)
  return Boolean(user?.active && user.role === 'commerce')
}

function mime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.tif' || ext === '.tiff') return 'image/tiff'
  return 'image/jpeg'
}

export async function GET(request: Request): Promise<Response> {
  if (!(await authorized())) return Response.json({ error: 'forbidden' }, { status: 403 })
  const asset = new URL(request.url).searchParams.get('asset')
  if (asset) {
    try {
      const filePath = resolveLabAsset(asset)
      return new Response(await readFile(filePath), {
        headers: { 'Content-Type': mime(filePath), 'Cache-Control': 'private, max-age=300' },
      })
    } catch {
      return Response.json({ error: 'asset not found' }, { status: 404 })
    }
  }
  try {
    const [manifest, stats] = await Promise.all([readLabManifest(), matcherStats()])
    return Response.json({ manifest, matcher: { online: Boolean(stats), stats } })
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'matcher lab unavailable' },
      { status: 500 },
    )
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!(await authorized())) return Response.json({ error: 'forbidden' }, { status: 403 })
  try {
    if (request.headers.get('content-type')?.includes('multipart/form-data')) {
      const form = await request.formData()
      const upload = form.get('image')
      if (!(upload instanceof File)) {
        return Response.json({ error: 'choose an image to match' }, { status: 400 })
      }
      if (!upload.type.startsWith('image/')) {
        return Response.json({ error: 'the uploaded file must be an image' }, { status: 415 })
      }
      if (upload.size > 30 * 1024 * 1024) {
        return Response.json({ error: 'image exceeds 30 MB' }, { status: 413 })
      }
      const result = await matchImageBytes(
        new Uint8Array(await upload.arrayBuffer()),
        upload.name,
        upload.type,
      )
      const manifest = await readLabManifest()
      const matchedDocument = result.best
        ? manifest.documents.find((document) => document.id === result.best?.component_id) || null
        : null
      return Response.json({ ...result, matchedDocument })
    }
    const body = (await request.json()) as {
      action?: string
      asset?: string
      documentIds?: string[]
    }
    if (body.action === 'register_all') {
      return Response.json(await registerAllLabDocuments())
    }
    if (body.action === 'match' && body.asset) {
      return Response.json(await matchLabAsset(body.asset))
    }
    if (body.action === 'run_suite') {
      return Response.json(await runLabSuite(body.documentIds))
    }
    if (body.action === 'reveal_folder') {
      return Response.json({ path: await revealLabFolder() })
    }
    return Response.json({ error: 'unknown action' }, { status: 400 })
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'matcher lab action failed' },
      { status: 500 },
    )
  }
}
