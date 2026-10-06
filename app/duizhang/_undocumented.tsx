'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/mutate'

// 点过出货、还没进出货单的单 —— 只要点过出货就该参与对账。现在点出货时系统
// 自己开出货单; 这里接的是以前点过、没单的那些: 能开出货单的人一打开对账页就
// 自动补上 (日期用当时点出货那天), 纸跟着刷新。补不上 (没权限、网断了) 才
// 留一条提示和一个按钮。

export type UndocumentedItem = {
  jobId: string
  jobNo: string
  customer: string
  shippedAt?: string
  qty: number
}

export function UndocumentedStrip({ items, auto }: { items: UndocumentedItem[]; auto: boolean }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const tried = useRef('')
  const key = items.map((x) => x.jobId).join(',')

  function backfill() {
    setError(null)
    start(async () => {
      try {
        await mutate({ kind: 'backfillShipments', jobIds: items.map((x) => x.jobId) })
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : '补不上')
      }
    })
  }

  // 同一批只自动补一次 —— 补完刷新, 这一条就没了。
  useEffect(() => {
    if (!auto || !key || tried.current === key) return
    tried.current = key
    backfill()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, key])

  if (items.length === 0) return null

  if (auto && !error)
    return (
      <p className="no-print mt-5 text-[12.5px] text-[var(--color-ink-3)]">
        正在把点过出货的 {items.length} 张单补进对账…
      </p>
    )

  return (
    <div className="no-print mt-5 rounded-[2px] border border-[var(--color-warning)]/50 bg-[var(--color-warning-soft)] px-4 py-3 md:px-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-[13px] text-[var(--color-ink)]">
          {items.length} 张单点过出货，还没进对账：
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
        {auto && (
          <button
            type="button"
            onClick={backfill}
            disabled={pending}
            className="ml-auto h-8 rounded-[2px] bg-[var(--color-ink)] px-3 text-[12.5px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-50"
          >
            {pending ? '补进中…' : '再试一次'}
          </button>
        )}
      </div>
      {error ? (
        <p className="mt-2 text-[12px] text-[var(--color-overdue)]">{error}</p>
      ) : (
        <p className="mt-2 text-[12px] text-[var(--color-ink-3)]">开出货的人或财务打开这一页，就会自动补进来。</p>
      )}
    </div>
  )
}
