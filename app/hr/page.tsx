import Link from 'next/link'
import { TopBar } from '@/app/_ui'
import {
  canEditDorm,
  canSeeDorm,
  requireHrUser,
  canDeleteHrRecord,
  canEditHrRecord,
  canSeeAllHr,
  canSeeReport,
  canSeeOrderLedger,
  hrDeptOf,
} from '@/lib/auth'
import { getActiveUsers } from '@/lib/db'
import { getHrMonth, getHrMonths, getHrRoster, getHrYear } from '@/lib/hr'
import { today } from '@/lib/today'
import { getDormEntries } from '@/lib/dorm'
import { DormBoard } from './_dorm'
import { HrBoard } from './_hr'

export const dynamic = 'force-dynamic'

// 人事 — one line per event (事假 / 病假 / 工伤 / 迟到 / 旷工 / 违纪 /
// 重大质量异常), filed the day it happens, read back per person by 月 or by 年.
//
// The period is a URL param, not client state: the boss lands on this month,
// and a month he wants to keep looking at is a link he can leave open. The
// server reads exactly the shard(s) that period needs (lib/hr.ts).
export default async function HrPage({
  searchParams,
}: {
  searchParams: Promise<{ p?: string; v?: string }>
}) {
  const user = await requireHrUser()
  const sp = await searchParams
  const now = today()

  // 'YYYY-MM' reads a month, 'YYYY' reads a year. Anything else falls back to
  // the month we're in, which is what somebody arriving from the nav wants.
  // 住宿登记 — 人事的第二张表, 归同一个模块但另一批人在看 (canSeeDorm)。
  // 没这个权限的人连切换都看不到, 页面就还是原来那一张考勤表。
  const seeDorm = canSeeDorm(user)
  const view = sp.v === 'dorm' && seeDorm ? 'dorm' : 'hr'

  const raw = (sp.p ?? '').trim()
  const period = /^\d{4}(-\d{2})?$/.test(raw) ? raw : now.slice(0, 7)
  const isYear = period.length === 4

  const [allRecords, months, users, extraNames, dormEntries] =
    await Promise.all([
      isYear ? getHrYear(period) : getHrMonth(period),
      getHrMonths(),
      getActiveUsers(),
      getHrRoster(),
      seeDorm ? getDormEntries() : Promise.resolve([]),
    ])

  // 看全部 vs 看本部门. Scoped here, on the server, so a 工段长's page never
  // holds another team's lines in the first place — there is nothing to leak
  // through a devtools panel or a stale client filter. Lines filed before 部门
  // existed carry none; they read as the office's, which is where the people
  // who filed them sit.
  const seeAll = canSeeAllHr(user)
  const myDept = hrDeptOf(user)
  const records = seeAll
    ? allRecords
    : allRecords.filter((r) => (r.dept ?? '商务') === myDept)

  // Who the picker offers: system accounts plus everybody 人事 has been asked
  // to remember. Shared station accounts and people with no login at all still
  // take leave, so the account list alone was never the shop's roster. Scoped
  // the same way — you can only file on people you can read.
  const roster = [
    ...new Set([
      ...users.filter((u) => seeAll || hrDeptOf(u) === myDept).map((u) => u.name),
      ...extraNames,
    ]),
  ].sort((a, b) => a.localeCompare(b, 'zh'))

  return (
    <div className="min-h-dvh bg-[var(--color-bg)]">
      <TopBar
        title="人事"
        subtitle={
          seeAll ? '全厂 · 请假 · 迟到 · 旷工 · 违纪 · 质量异常' : `${myDept}部门`
        }
        currentTab="人事"
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
        canSeeReport={canSeeReport(user)}
        canSeeFinance={canSeeOrderLedger(user)}
      />
      <main className="px-4 md:px-10 py-8">
        {seeDorm && (
          <div className="mx-auto mb-5 flex max-w-4xl items-baseline gap-x-6">
            <ViewTab href="/hr" label="考勤" active={view === 'hr'} />
            <ViewTab href="/hr?v=dorm" label="住宿" active={view === 'dorm'} />
          </div>
        )}
        {view === 'dorm' ? (
          <DormBoard
            entries={dormEntries}
            roster={roster}
            deptOf={Object.fromEntries(
              users.map((u) => [u.name, hrDeptOf(u)]),
            )}
            canEdit={canEditDorm(user)}
          />
        ) : (
          <HrBoard
            records={records}
            period={period}
            months={months}
            roster={roster}
            canDelete={canDeleteHrRecord(user)}
            canEdit={canEditHrRecord(user)}
            scope={seeAll ? null : myDept}
            today={now}
          />
        )}
      </main>
    </div>
  )
}

// 考勤 / 住宿 — same underline-active idiom the 财务 sub-tabs use. Server-
// rendered links so the gate stays on the server.
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
