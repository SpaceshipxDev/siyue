import { TopBar } from '@/app/_ui'
import { requireHrUser, canSeeReport, canSeeOrderLedger } from '@/lib/auth'
import { getActiveUsers } from '@/lib/db'
import { getHrMonth, getHrMonths, getHrYear } from '@/lib/hr'
import { today } from '@/lib/today'
import { HrBoard } from './_hr'

export const dynamic = 'force-dynamic'

// 人事 — one line per event (请假 / 迟到 / 旷工 / 违纪 / 重大质量异常), filed
// the day it happens, read back per person by 月 or by 年.
//
// The period is a URL param, not client state: the boss lands on this month,
// and a month he wants to keep looking at is a link he can leave open. The
// server reads exactly the shard(s) that period needs (lib/hr.ts).
export default async function HrPage({
  searchParams,
}: {
  searchParams: Promise<{ p?: string }>
}) {
  const user = await requireHrUser()
  const sp = await searchParams
  const now = today()

  // 'YYYY-MM' reads a month, 'YYYY' reads a year. Anything else falls back to
  // the month we're in, which is what somebody arriving from the nav wants.
  const raw = (sp.p ?? '').trim()
  const period = /^\d{4}(-\d{2})?$/.test(raw) ? raw : now.slice(0, 7)
  const isYear = period.length === 4

  const [records, months, users] = await Promise.all([
    isYear ? getHrYear(period) : getHrMonth(period),
    getHrMonths(),
    getActiveUsers(),
  ])

  return (
    <div className="min-h-dvh bg-[var(--color-bg)]">
      <TopBar
        title="人事"
        subtitle="请假 · 迟到 · 旷工 · 违纪 · 质量异常"
        currentTab="人事"
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
        canSeeReport={canSeeReport(user)}
        canSeeFinance={canSeeOrderLedger(user)}
      />
      <main className="px-4 md:px-10 py-8">
        <HrBoard
          records={records}
          period={period}
          months={months}
          roster={users.map((u) => u.name)}
          today={now}
        />
      </main>
    </div>
  )
}
