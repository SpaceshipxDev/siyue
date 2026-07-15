import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { requirePulseViewer } from '@/lib/auth'
import { getMachineDashboard, machineDashboardProxyMatches } from '@/lib/machines'
import { MachineDevDashboard } from './_dev-dashboard'

export const metadata: Metadata = {
  title: 'CNC 网络读取实验室 · 思跃',
  description: 'CNC 自动发现、接口能力、实时数据与 NC 源码',
}
export const dynamic = 'force-dynamic'

export default async function MachineDevPage() {
  const proxyAccess = machineDashboardProxyMatches(await headers())
  if (!proxyAccess) await requirePulseViewer()
  let initial: Awaited<ReturnType<typeof getMachineDashboard>> = {
    machines: [],
    events: [],
    serverTime: new Date().toISOString(),
  }
  try {
    initial = await getMachineDashboard()
  } catch {
  }
  return <MachineDevDashboard initial={initial} />
}
