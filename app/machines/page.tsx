import type { Metadata } from 'next'
import { requirePulseViewer } from '@/lib/auth'
import { getMachineDashboard } from '@/lib/machines'
import { MachineDashboard } from './_dashboard'

export const metadata: Metadata = {
  title: '机床 · 思跃',
  description: '英玛 CNC 实时状态与程序看板',
}
export const dynamic = 'force-dynamic'

export default async function MachinesPage() {
  const user = await requirePulseViewer()
  let initial: Awaited<ReturnType<typeof getMachineDashboard>> = {
    machines: [],
    events: [],
    serverTime: new Date().toISOString(),
  }
  try {
    initial = await getMachineDashboard()
  } catch {
    // The client feed keeps retrying. This also lets the page render a useful
    // empty state during the brief deploy window before migration 0088 lands.
  }
  return <MachineDashboard initial={initial} userName={user.name} />
}
