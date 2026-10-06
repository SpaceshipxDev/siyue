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
  canApplyLoan,
  canSettleAccounts,
  hrDeptOf,
} from '@/lib/auth'
import { getLoans } from '@/lib/loan'
import { HrLoanBoard } from './_loans'
import { getActiveUsers, isAdminUser } from '@/lib/db'
import { loadSheetInputs } from './_sheet_data'
import {
  getHrMonth,
  getHrMonths,
  getHrRoster,
  getHrYear,
} from '@/lib/hr'
import { HrImport } from './_import'
import { getHrNotesForMonth, getHrNotesForYear } from '@/lib/hr-note-file'
import { today } from '@/lib/today'
import { getDormEntries } from '@/lib/dorm'
import { DormBoard } from './_dorm'
import { HrBoard } from './_hr'
import { AttendanceSheet } from './_attendance_sheet'
import { buildAttendanceReport } from '@/lib/hr-report'

export const dynamic = 'force-dynamic'

// 人事 — one line per event (加班 / 事假 / 病假 / 工伤 / 迟到 / 旷工 / 违纪 /
// 重大质量异常), filed the day it happens, read back per person by 月 or by 年.
// 加班时长 is summed here and read straight into 工资 — one book, not two.
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
  // 借款 —— 员工来借钱, 人事在这里填申请、等人批 (批下来转到财务)。收申请的
  // 是人事, 所以跟「看全部人事」同一档。
  const seeLoan = canApplyLoan(user)
  const view =
    sp.v === 'dorm' && seeDorm
      ? 'dorm'
      : sp.v === 'loan' && seeLoan
        ? 'loan'
        : sp.v === 'sheet'
          ? 'sheet'
          : 'hr'

  const raw = (sp.p ?? '').trim()
  // 考勤表是按月的一张纸 —— 带着年份过来就看这个月。
  const period =
    /^\d{4}(-\d{2})?$/.test(raw) && !(view === 'sheet' && raw.length === 4)
      ? raw
      : now.slice(0, 7)
  const isYear = period.length === 4

  const [allRecords, notes, months, users, extraNames, dormEntries, loans, sheetInputs] =
    await Promise.all([
      isYear ? getHrYear(period) : getHrMonth(period),
      // 请假条 — 跟记录同一个分片口径, 所以跟着同一趟读: 月度一个文件, 年度
      // 十二个并行。
      isYear ? getHrNotesForYear(period) : getHrNotesForMonth(period),
      getHrMonths(),
      getActiveUsers(),
      getHrRoster(),
      seeDorm ? getDormEntries() : Promise.resolve([]),
      view === 'loan' ? getLoans() : Promise.resolve([]),
      // 考勤表要的名单、部门、工时制度、打卡机汇总 (app/hr/_sheet_data)。
      view === 'sheet' ? loadSheetInputs(period, canSeeAllHr(user)) : Promise.resolve(null),
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
          seeAll ? '全厂 · 加班 · 请假 · 迟到 · 旷工 · 违纪' : `${myDept}部门`
        }
        currentTab="人事"
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
        canSeeReport={canSeeReport(user)}
        canSeeFinance={canSeeOrderLedger(user)}
      />
      <main className="px-4 md:px-10 py-8">
        <div
          className={`mx-auto mb-5 flex items-baseline gap-x-6 ${view === 'sheet' ? 'max-w-[1240px]' : 'max-w-4xl'}`}
        >
            <ViewTab href="/hr" label="考勤" active={view === 'hr'} />
            <ViewTab
              href={`/hr?v=sheet&p=${period.length === 7 ? period : now.slice(0, 7)}`}
              label="考勤表"
              active={view === 'sheet'}
            />
            {seeDorm && (
              <ViewTab href="/hr?v=dorm" label="住宿" active={view === 'dorm'} />
            )}
            {seeLoan && (
              <ViewTab href="/hr?v=loan" label="借款" active={view === 'loan'} />
            )}
        </div>
        {view === 'sheet' ? (
          <SheetView
            month={period}
            report={buildAttendanceReport(
              period,
              records,
              sheetInputs?.extraNames ?? [],
              sheetInputs?.summary ?? {},
              sheetInputs?.calc,
            )}
            scope={seeAll ? '全厂' : `${myDept}部门`}
            canImport={canEditHrRecord(user)}
          />
        ) : view === 'loan' ? (
          <HrLoanBoard
            loans={loans}
            roster={roster}
            userName={user.name}
            canSettle={canSettleAccounts(user)}
            isBoss={isAdminUser(user.id)}
          />
        ) : view === 'dorm' ? (
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
            notes={notes}
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

// 考勤表 —— 由考勤记录排出来的那张月表: 一人一行、每天一格、后面合计。上面
// 换月份, 打印 (横着的 A4) 和导出 (表格里也有这一页) 各一个。
function SheetView({
  month,
  report,
  scope,
  canImport,
}: {
  month: string
  report: ReturnType<typeof buildAttendanceReport>
  scope: string
  /** 导入打卡机导出的考勤表 —— 读出来先过一眼, 记入后这张表就排出来了。 */
  canImport: boolean
}) {
  const [y, m] = month.split('-').map(Number)
  const shift = (d: number) =>
    new Date(Date.UTC(y, m - 1 + d, 1)).toISOString().slice(0, 7)
  const btn =
    'rounded-[2px] border border-[var(--color-border)] px-3 py-1 text-[12.5px] font-medium text-[var(--color-ink-2)] hover:border-[var(--color-border-strong)]'
  return (
    <div className="mx-auto max-w-[1240px]">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <Link
            href={`/hr?v=sheet&p=${shift(-1)}`}
            aria-label="上一月"
            className="px-1.5 text-[15px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
          >
            ‹
          </Link>
          <span className="min-w-[92px] text-center text-[14px] font-semibold tabular-nums text-[var(--color-ink)]">
            {y}年{m}月
          </span>
          <Link
            href={`/hr?v=sheet&p=${shift(1)}`}
            aria-label="下一月"
            className="px-1.5 text-[15px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
          >
            ›
          </Link>
        </div>
        <span className="text-[12.5px] text-[var(--color-ink-3)]">
          {scope} · {report.rows.length} 人
        </span>
        <span className="ml-auto flex items-center gap-2">
          {canImport && <HrImport month={month} toSheet />}
          <a href={`/hr/report?p=${month}`} target="_blank" rel="noopener" className={btn}>
            打印
          </a>
          <Link href={`/hr/export?p=${month}`} prefetch={false} className={btn}>
            导出
          </Link>
        </span>
      </div>
      <div className="overflow-x-auto rounded-[2px] border border-[var(--color-border)] bg-white p-3">
        <AttendanceSheet report={report} />
      </div>
    </div>
  )
}
