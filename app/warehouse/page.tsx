import Link from 'next/link'
import { TopBar } from '@/app/_ui'
import {
  canEditWarehouse,
  canSeeOrderLedger,
  canSeeReport,
  requireUser,
} from '@/lib/auth'
import { getStockMoves, rollupStock } from '@/lib/warehouse'
import { today } from '@/lib/today'
import { StockBoard } from './_stock'
import { LogBoard } from './_log'

export const dynamic = 'force-dynamic'

// 仓库 — 两页, 同一份数据的两个面。
//
//   库存    — 现在还有多少。一个数都不用录: 每一行都是出入库记录加出来的
//     (入库合计 − 出库合计), 所以它永远跟记录对得上。
//   出入库  — 唯一在录的东西: 哪一天 · 什么物料 · 什么规格 · 进还是出 · 多少。
//
// 两档权限 (lib/auth canEditWarehouse): 记一笔对全厂的账号开着 —— 东西是当场
// 进出的, 让仓管等一个有权限的人来代录, 就是让这笔账不存在。改已经记下的、删
// 一笔是工程和商务于海伟: 库存是这些记录加出来的, 悄悄改一笔, 库存就跟着错。
export default async function WarehousePage({
  searchParams,
}: {
  searchParams: Promise<{ v?: string; q?: string }>
}) {
  const user = await requireUser()
  const canEdit = canEditWarehouse(user)
  const sp = await searchParams
  const view = sp?.v === 'log' ? 'log' : 'stock'
  const todayStr = today()

  const moves = await getStockMoves()
  const items = rollupStock(moves)

  // 物料名 + 它上一次用的规格 — 录入行的建议, 同一样东西不该写出三种写法。
  const names = items.map((it) => it.name)
  const specByName: Record<string, string> = {}
  for (const m of moves) {
    if (m.name && m.spec && !specByName[m.name]) specByName[m.name] = m.spec
  }

  return (
    <div className="flex-1 flex flex-col">
      <TopBar
        title="仓库"
        subtitle={view === 'log' ? '出入库记录' : '库存'}
        currentTab="仓库"
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
        canSeeReport={canSeeReport(user)}
        canSeeFinance={canSeeOrderLedger(user)}
      />
      <main className="mx-auto w-full max-w-[1240px] px-4 md:px-10 py-8 md:py-12 flex-1">
        <div className="mb-7 flex items-baseline gap-x-6">
          <ViewTab href="/warehouse" label="库存" active={view === 'stock'} />
          <ViewTab
            href="/warehouse?v=log"
            label="出入库记录"
            active={view === 'log'}
          />
        </div>
        {view === 'log' ? (
          <LogBoard
            rows={moves}
            todayStr={todayStr}
            names={[...new Set(names)]}
            specByName={specByName}
            initialQ={typeof sp?.q === 'string' ? sp.q : ''}
            canEdit={canEdit}
          />
        ) : (
          <StockBoard items={items} />
        )}
      </main>
    </div>
  )
}

// 库存 / 出入库记录 — same underline-active idiom the 质量 / 财务 sub-tabs use.
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
