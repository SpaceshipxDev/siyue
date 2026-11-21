import { notFound } from 'next/navigation'
import { TopBar } from '@/app/_ui'
import { canEditQuality, canSeeOrderLedger, canSeeReport, requireUser } from '@/lib/auth'
import { getBalloonSheet } from '@/lib/balloon-store'
import { BalloonEditor } from './_editor'

export const dynamic = 'force-dynamic'

// 质量 · 气泡图 —— 一张图纸的气泡和检验表 (lib/balloon)。
export default async function BalloonSheetPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const user = await requireUser()
  const { id } = await params
  const sheet = await getBalloonSheet(id)
  if (!sheet) notFound()
  return (
    <div className="flex-1 flex flex-col">
      <TopBar
        title="质量"
        subtitle={`气泡图 · ${sheet.title}`}
        currentTab="质量"
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
        canSeeReport={canSeeReport(user)}
        canSeeFinance={canSeeOrderLedger(user)}
      />
      <main className="w-full px-4 md:px-10 py-6 md:py-8 flex-1">
        <BalloonEditor initial={sheet} canDelete={canEditQuality(user)} />
      </main>
    </div>
  )
}
