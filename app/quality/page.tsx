import Link from 'next/link'
import { TopBar } from '@/app/_ui'
import { canSeeOrderLedger, canSeeReport, requireUser } from '@/lib/auth'
import { getDefectRows } from '@/lib/db'
import { getComplaints } from '@/lib/complaints'
import { getProcessDefects } from '@/lib/process-defects'
import { getDefectActions } from '@/lib/defect-actions'
import { today } from '@/lib/today'
import { DefectsBoard } from './_defects'
import { ComplaintsBoard } from './_complaints'
import { ProcessBoard } from './_process'

export const dynamic = 'force-dynamic'

// 质量 — 三张表, 一个问题的三段。
//
//   制程不良 — 生产过程中出的不良, 质量落笔。判定之外还要交代的那几件事:
//     直接责任人、间接责任人、纠正预防措施 —— 工单上装不下的那一半。
//   质量异常 — 厂里自己检出来的 (检验 + 出货前的成品检)。一条都不用录: 检验
//     员在工单上按下判定、写下不良原因的那一刻就有了, 这里只是从几百张工单里
//     收拢起来; 只有纠正预防措施是在这一页填的 —— 那是开会定的, 不是检验员在
//     工位上按得出来的。
//   客诉异常 — 客户反馈回来的。系统无从知道, 只能商务落笔; 带损失金额, 因为
//     质量问题只有换算成钱才谈得上跟谁算账。
//
// 三张都按月看 (质量是按月复盘的), 都能按屏幕上那一批导出 Excel。
//
// 权限分两档。质量异常 / 客诉异常 跟报工同一档 (canSeeReport): 商务全员 +
// 于海伟 —— 客诉里有损失金额, 不是车间该看的东西。制程不良是全厂的表: 谁发
// 现谁记, 所以有账号的人都进得来、都填得了, 只是他进来只有这一张 (删还是留
// 给上面那一档 —— 大家一起写的表, 少一条比多一条难发现)。
export default async function QualityPage({
  searchParams,
}: {
  searchParams: Promise<{ v?: string }>
}) {
  const user = await requireUser()
  const full = canSeeReport(user)
  const sp = await searchParams
  const view = !full
    ? 'process'
    : sp?.v === 'complaint'
      ? 'complaint'
      : sp?.v === 'process'
        ? 'process'
        : 'defects'
  const todayStr = today()

  // 只读切到的那一张 — 另一张要扫的表不小, 没人看的时候不去扫。
  const [defects, defectActions, complaints, processDefects] =
    await Promise.all([
      view === 'defects' ? getDefectRows() : Promise.resolve([]),
      view === 'defects'
        ? getDefectActions()
        : Promise.resolve({} as Record<string, string>),
      view === 'complaint' ? getComplaints() : Promise.resolve([]),
      view === 'process' ? getProcessDefects() : Promise.resolve([]),
    ])

  const customers = [
    ...new Set(complaints.map((c) => c.customer).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b, 'zh'))

  return (
    <div className="flex-1 flex flex-col">
      <TopBar
        title="质量"
        subtitle={
          view === 'complaint'
            ? '客诉异常'
            : view === 'process'
              ? '制程不良记录'
              : '质量异常'
        }
        currentTab="质量"
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
        canSeeReport={canSeeReport(user)}
        canSeeFinance={canSeeOrderLedger(user)}
      />
      <main className="mx-auto w-full max-w-[1240px] px-4 md:px-10 py-8 md:py-12 flex-1">
        {/* 只有一张表可看的人不需要切换 — 那一行整个不出现。 */}
        <div className="mb-7 flex items-baseline gap-x-6">
          {full && (
            <>
              <ViewTab
                href="/quality"
                label="质量异常"
                active={view === 'defects'}
              />
              <ViewTab
                href="/quality?v=process"
                label="制程不良"
                active={view === 'process'}
              />
              <ViewTab
                href="/quality?v=complaint"
                label="客诉异常"
                active={view === 'complaint'}
              />
            </>
          )}
          <Link
            href="/?stage=质量"
            className="ml-auto text-[12px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
          >
            质量工段看板 →
          </Link>
        </div>
        {view === 'complaint' ? (
          <ComplaintsBoard
            rows={complaints}
            todayStr={todayStr}
            customers={customers}
            canEdit
          />
        ) : view === 'process' ? (
          <ProcessBoard
            rows={processDefects}
            todayStr={todayStr}
            canEdit
            canDelete={full}
          />
        ) : (
          <DefectsBoard
            rows={defects}
            actions={defectActions}
            todayStr={todayStr}
          />
        )}
      </main>
    </div>
  )
}

// 质量异常 / 制程不良 / 客诉异常 — same underline-active idiom the 财务 sub-tabs use.
function ViewTab({
  href,
  label,
  active,
}: {
  href: string
  label: string
  active: boolean
}) {
  return (
    <Link
      href={href}
      className={`border-b pb-1 text-[15px] tracking-tight transition-colors ${
        active
          ? 'border-[var(--color-ink)] font-semibold text-[var(--color-ink)]'
          : 'border-transparent font-medium text-[var(--color-ink-3)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-ink-2)]'
      }`}
    >
      {label}
    </Link>
  )
}
