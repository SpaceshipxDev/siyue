import { currentUser } from '@/lib/auth'
import { STAGES, type Stage } from '@/lib/data'
import {
  getMasterFacets,
  type MasterStatusFilter,
} from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function parseStatus(v: string | null): MasterStatusFilter | undefined {
  return v === 'pending' || v === 'partial' || v === 'done' ? v : undefined
}

function parseStatusByStage(url: URL): Partial<Record<Stage, MasterStatusFilter>> {
  const out: Partial<Record<Stage, MasterStatusFilter>> = {}
  for (const stage of STAGES) {
    const value =
      parseStatus(url.searchParams.get(`status.${stage}`)) ??
      parseStatus(url.searchParams.get(`status[${stage}]`))
    if (value) out[stage] = value
  }
  return out
}

export async function GET(request: Request): Promise<Response> {
  const user = await currentUser()
  if (!user) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  try {
    const url = new URL(request.url)
    const ship = url.searchParams.get('ship')
    const sort = url.searchParams.get('sort')
    const facets = await getMasterFacets({
      q: url.searchParams.get('q') ?? undefined,
      jobNoOnlySearch: user.role === 'production' && user.defaultStage !== '出货',
      ship:
        ship === 'live' || ship === 'paused' || ship === 'shipped'
          ? ship
          : undefined,
      sort: sort === 'jobNo' ? 'jobNo' : 'due',
      dateStart: url.searchParams.get('dateStart') ?? undefined,
      dateEnd: url.searchParams.get('dateEnd') ?? undefined,
      statusByStage: parseStatusByStage(url),
    })
    return Response.json(
      { ok: true, ...facets },
      { headers: { 'cache-control': 'no-store' } },
    )
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[api/master/facets]', message)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}
