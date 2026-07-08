import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { APP_TITLE } from '@/lib/brand'
import { markContactedAction, undoContactedAction } from './actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 潜在客户台账 — inbound callback requests from the public siyue.ai landing.
// Ledger, newest first: same cells every row, the 状态 column carries the only
// action (tap-call the 手机, then stamp 已联系). Auth is handled by the parent
// /backend layout (requireCommerce).

type Lead = {
  id: string
  created_at: string
  phone: string
  name: string | null
  company: string | null
  source: string
  contacted_at: string | null
}

// Asia/Shanghai — the boss reads these on a phone on the floor, not in UTC.
const FMT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})
const FMT_DATE = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
})

function fmtDateTime(iso: string): string {
  const p = Object.fromEntries(FMT.formatToParts(new Date(iso)).map((x) => [x.type, x.value]))
  return `${p.month}-${p.day} ${p.hour}:${p.minute}`
}
function fmtDate(iso: string): string {
  const p = Object.fromEntries(FMT_DATE.formatToParts(new Date(iso)).map((x) => [x.type, x.value]))
  return `${p.month}-${p.day}`
}

export default async function LeadsPage() {
  const { data, error } = await supabase
    .from('leads')
    .select('id, created_at, phone, name, company, source, contacted_at')
    .order('created_at', { ascending: false })
    .limit(500)

  const leads = (data ?? []) as Lead[]

  return (
    <div className="flex-1 flex flex-col">
      <header className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="px-4 md:px-10 py-5 flex items-baseline justify-between gap-8">
          <div className="flex items-baseline gap-6">
            <Link
              href="/"
              className="label tracking-[0.22em] text-[var(--color-ink)] hover:opacity-60"
            >
              思跃
            </Link>
            <h1 className="text-[15px] font-medium tracking-tight text-[var(--color-ink)]">
              潜在客户
            </h1>
            <span className="text-[12px] text-[var(--color-ink-3)]">
              siyue.ai 落地页留资
            </span>
          </div>
          <Link href="/backend" className="label hover:text-[var(--color-ink)]">
            ← 后端工具
          </Link>
        </div>
      </header>

      <main className="w-full px-4 md:px-10 py-6 md:py-10 flex-1">
        <div className="mb-6 flex items-baseline justify-between">
          <div>
            <p className="label mb-1">留资台账</p>
            <h2 className="text-[28px] font-semibold tracking-tight text-[var(--color-ink)]">
              {leads.length} 条线索
            </h2>
          </div>
        </div>

        {error && (
          <div className="mb-6 rounded-[2px] border border-[var(--color-overdue)] bg-[var(--color-overdue-soft)] px-4 py-3 text-[13px] text-[var(--color-overdue)]">
            读取失败 · {error.message}
          </div>
        )}

        <div className="rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] overflow-x-auto">
          <table className="sheet w-full text-left text-[13px]">
            <thead>
              <tr>
                <th className="px-3 py-2.5 label whitespace-nowrap">时间</th>
                <th className="px-3 py-2.5 label whitespace-nowrap">称呼</th>
                <th className="px-3 py-2.5 label whitespace-nowrap">公司</th>
                <th className="px-3 py-2.5 label whitespace-nowrap">手机</th>
                <th className="px-3 py-2.5 label whitespace-nowrap">来源</th>
                <th className="px-3 py-2.5 label whitespace-nowrap">状态</th>
              </tr>
            </thead>
            <tbody>
              {leads.length === 0 && !error && (
                <tr>
                  <td colSpan={6} className="px-3 py-10 text-center text-[13px] text-[var(--color-ink-3)]">
                    暂无线索
                  </td>
                </tr>
              )}
              {leads.map((lead) => (
                <tr key={lead.id}>
                  <td className="px-3 py-2 mono whitespace-nowrap text-[var(--color-ink-2)]">
                    {fmtDateTime(lead.created_at)}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-[var(--color-ink)]">
                    {lead.name || <span className="text-[var(--color-ink-4)]">—</span>}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-[var(--color-ink)]">
                    {lead.company || <span className="text-[var(--color-ink-4)]">—</span>}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <a
                      href={`tel:${lead.phone}`}
                      className="mono text-[var(--color-info)] hover:underline"
                    >
                      {lead.phone}
                    </a>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-[var(--color-ink-3)]">
                    {lead.source}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {lead.contacted_at ? (
                      <span className="inline-flex items-baseline gap-2">
                        <span className="text-[var(--color-success)]">
                          已联系 {fmtDate(lead.contacted_at)}
                        </span>
                        <form
                          action={async () => {
                            'use server'
                            await undoContactedAction(lead.id)
                          }}
                        >
                          <button
                            type="submit"
                            className="label text-[var(--color-ink-3)] hover:text-[var(--color-overdue)] cursor-pointer"
                          >
                            撤销
                          </button>
                        </form>
                      </span>
                    ) : (
                      <form
                        action={async () => {
                          'use server'
                          await markContactedAction(lead.id)
                        }}
                      >
                        <button
                          type="submit"
                          className="rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2.5 py-1 text-[12px] text-[var(--color-ink)] hover:bg-[var(--color-active-bg)] cursor-pointer"
                        >
                          标记已联系
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>

      <footer className="border-t border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="px-4 md:px-10 py-4 flex items-baseline justify-between text-[var(--color-ink-3)]">
          <span className="label">{APP_TITLE} · 潜在客户</span>
          <Link href="/backend" className="label hover:text-[var(--color-ink)]">
            ← 后端工具
          </Link>
        </div>
      </footer>
    </div>
  )
}
