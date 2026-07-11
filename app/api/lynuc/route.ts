import { readLynucMachines } from '@/lib/lynuc'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const host = new URL(request.url).hostname
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    return Response.json({ error: 'LYNUC 采集仅允许本机访问' }, { status: 403 })
  }

  const machines = await readLynucMachines()
  return Response.json(
    { machines, sampledAt: new Date().toISOString() },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
