import { redirect } from 'next/navigation'
import {
  canEditProductionFields,
  canSeeReport,
  landingPathFor,
  requireUser,
} from '@/lib/auth'
import { TopBar } from '@/app/_ui'
import { ManualImportWorkspace } from './_workspace'

export const dynamic = 'force-dynamic'

// 清单导入 — the no-AI import path. Same access rule as the AI import:
// commerce + 工程 head (the proxy already allows both onto /import/*).
export default async function ManualImportPage() {
  const user = await requireUser()
  if (!canEditProductionFields(user)) redirect(landingPathFor(user))
  return (
    <div className="flex-1 flex flex-col">
      <TopBar
        title="清单导入"
        subtitle="粘贴或上传表格 · 对好列 · 导入"
        currentTab={user.defaultStage === '工程' ? '工程' : '商务'}
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
        canSeeReport={canSeeReport(user)}
      />
      <ManualImportWorkspace />
    </div>
  )
}
