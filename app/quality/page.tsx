import Link from 'next/link'
import { TopBar } from '@/app/_ui'
import {
  canEditQuality,
  canSeeOrderLedger,
  canSeeReport,
  hrDeptOf,
  requireUser,
} from '@/lib/auth'
import { getDefectRows } from '@/lib/db'
import { getComplaints } from '@/lib/complaints'
import { getProcessDefects } from '@/lib/process-defects'
import { getDefectActions } from '@/lib/defect-actions'
import { getImprovements } from '@/lib/improvements'
import { today } from '@/lib/today'
import { DefectsBoard } from './_defects'
import { ComplaintsBoard } from './_complaints'
import { ProcessBoard } from './_process'
import { ImprovementsBoard } from './_improvements'

export const dynamic = 'force-dynamic'

// 质量 — 四张表。前三张是一个问题的三段, 第四张是问题的反面。
//
//   制程不良 — 生产过程中出的不良, 质量落笔。判定之外还要交代的那几件事:
//     直接责任人、间接责任人、纠正预防措施 —— 工单上装不下的那一半。
//   质量异常 — 厂里自己检出来的 (检验 + 出货前的成品检)。一条都不用录: 检验
//     员在工单上按下判定、写下不良原因的那一刻就有了, 这里只是从几百张工单里
//     收拢起来; 只有纠正预防措施是在这一页填的 —— 那是开会定的, 不是检验员在
//     工位上按得出来的。
//   客诉异常 — 客户反馈回来的。系统无从知道, 只能商务落笔; 带损失金额, 因为
//     质量问题只有换算成钱才谈得上跟谁算账。
//   改善建议 — 唯一一张不是记问题的表: 谁提的、改善前什么样、改善后什么样、
//     对效率/质量/成本有什么影响。看得见问题的是站在机床边上的那个人。
//
// 四张都按月看 (质量是按月复盘的), 都能按屏幕上那一批导出 Excel。
//
// 权限分两档 (lib/auth 的 质量 那一段)。整个模块对全厂的账号开着: 质
// 量问题是谁碰上谁知道, 让他等一个有权限的人来代录, 就是让这条记录不存在。
// 所以记一条、补一个还空着的格 (处理方式 / 责任人 / 措施常常是几天后才定下
// 来的), 有账号就能做。改已经填下去的东西、删一条不是: 那一档是工程和商务于
// 海伟 —— 责任和损失金额是拿来算账的, 悄悄改一格没人看得见。
export default async function QualityPage({
  searchParams,
}: {
  searchParams: Promise<{ v?: string }>
}) {
  const user = await requireUser()
  const canEdit = canEditQuality(user)
  const sp = await searchParams
  const view =
    sp?.v === 'complaint'
      ? 'complaint'
      : sp?.v === 'process'
        ? 'process'
        : sp?.v === 'improve'
          ? 'improve'
          : 'defects'
  const todayStr = today()

  // 只读切到的那一张 — 另一张要扫的表不小, 没人看的时候不去扫。
  const [defects, defectActions, complaints, processDefects, improvements] =
    await Promise.all([
      view === 'defects' ? getDefectRows() : Promise.resolve([]),
      view === 'defects'
        ? getDefectActions()
        : Promise.resolve({} as Record<string, string>),
      view === 'complaint' ? getComplaints() : Promise.resolve([]),
      view === 'process' ? getProcessDefects() : Promise.resolve([]),
      view === 'improve' ? getImprovements() : Promise.resolve([]),
    ])

  const customers = [
    ...new Set(complaints.map((c) => c.customer).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b, 'zh'))

  const depts = [
    ...new Set([hrDeptOf(user), ...improvements.map((r) => r.dept)]),
  ]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'zh'))

  return (
    <div className="flex-1 flex flex-col">
      <TopBar
        title="质量"
        subtitle={
          view === 'complaint'
            ? '客诉异常'
            : view === 'process'
              ? '制程不良记录'
              : view === 'improve'
                ? '改善建议'
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
        <div className="mb-7 flex items-baseline gap-x-6">
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
          <ViewTab
            href="/quality?v=improve"
            label="改善建议"
            active={view === 'improve'}
          />
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
            canEdit={canEdit}
          />
        ) : view === 'improve' ? (
          <ImprovementsBoard
            rows={improvements}
            todayStr={todayStr}
            defaultReporter={user.name}
            defaultDept={hrDeptOf(user)}
            depts={depts}
            canEdit={canEdit}
          />
        ) : view === 'process' ? (
          <ProcessBoard
            rows={processDefects}
            todayStr={todayStr}
            canEdit={canEdit}
          />
        ) : (
          <DefectsBoard
            rows={defects}
            actions={defectActions}
            todayStr={todayStr}
            canEdit={canEdit}
          />
        )}
      </main>
    </div>
  )
}

// 质量异常 / 制程不良 / 客诉异常 / 改善建议 — same underline-active idiom the
// 财务 sub-tabs use.
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
