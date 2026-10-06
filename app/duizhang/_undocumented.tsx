'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'

// 生产表上点了出货、没开出货单的单 —— 商务那边算「已出货」, 对账单只认出货
// 单, 所以纸上没有它们。一句话说清楚, 点一下补开 (日期用当时点出货那天), 纸
// 上马上就有了。

export type UndocumentedItem = {
  jobId: string
  jobNo: string
  customer: string
  shippedAt?: string
  qty: number
}

export function UndocumentedStrip({ items }: { items: UndocumentedItem[] }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  if (items.length === 0) return null

  function backfill() {
    setError(null)
    start(async () => {
      try {
        const r = await mutate<{ docs: string[] }>({
          kind: 'backfillShipments',
          jobIds: items.map((x) => x.jobId),
        })
        const n = 'data' in r && r.data ? r.data.docs.length : items.length
        showToast(`补开了 ${n} 张出货单`)
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : '补不上')
      }
    })
  }

  return (
    <div className="no-print mt-5 rounded-[2px] border border-[var(--color-warning)]/50 bg-[var(--color-warning-soft)] px-4 py-3 md:px-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-[13px] text-[var(--color-ink)]">
          {items.length} 张单在生产表上点了出货，但没开出货单，对账单上没有它们：
        </span>
        <span className="flex flex-wrap gap-x-3 gap-y-1">
          {items.map((x) => (
            <Link
              key={x.jobId}
              href={`/jobs/${x.jobId}`}
              title={`${x.customer} · ${x.qty} 件${x.shippedAt ? ` · ${x.shippedAt.slice(0, 10)} 点的出货` : ''}`}
              className="mono text-[12.5px] text-[var(--color-ink-2)] hover:text-[var(--color-ink)] hover:underline"
            >
              {x.jobNo || '—'}
            </Link>
          ))}
        </span>
        <button
          type="button"
          onClick={backfill}
          disabled={pending}
          className="ml-auto h-8 rounded-[2px] bg-[var(--color-ink)] px-3 text-[12.5px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-50"
        >
          {pending ? '补开中…' : '补开出货单'}
        </button>
      </div>
      {error && <p className="mt-2 text-[12px] text-[var(--color-overdue)]">{error}</p>}
    </div>
  )
}
