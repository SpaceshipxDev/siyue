'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'

// 转外协 —— 零件那一行, 检验报告 · 图纸变更 后面。点一下变成「确认转外协」,
// 再点才算 (点错了只有于海伟、老板能取消)。转了: 这个零件还没开工的 编程 /
// 操机 / 车铣 关掉, 这张单进看板「待外协」; 商务开了外协单这条就自己消掉
// (lib/outsource-transfer)。
export function PartTransfer({
  jobId,
  componentId,
  partName,
  mark,
  canTransfer,
  canCancel,
  atVendor,
}: {
  jobId: string
  componentId: string
  partName: string
  /** 转过、还没开外协单的那一条。 */
  mark?: { by: string; at: string; removed: string[] }
  canTransfer: boolean
  canCancel: boolean
  /** 已经在外协厂了 —— 不用再转。 */
  atVendor: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [armed, setArmed] = useState(false)

  const run = (kind: 'transferPartOutsource' | 'cancelPartOutsource') =>
    start(async () => {
      try {
        await mutate({ kind, jobId, componentId })
        setArmed(false)
        showToast(
          kind === 'transferPartOutsource' ? `${partName} 已转外协` : `${partName} 已取消转外协`,
          'success',
        )
        router.refresh()
      } catch (e) {
        setArmed(false)
        showToast(e instanceof Error ? e.message : '没成功，再试一次', 'warning')
      }
    })

  if (mark) {
    return (
      <span className="inline-flex items-center gap-2 whitespace-nowrap">
        <span
          className="inline-flex items-center rounded-[2px] border border-[var(--color-warning)] px-1.5 py-0.5 text-[10px] tracking-wider text-[var(--color-warning)]"
          title={`${mark.by} ${mark.at.slice(5, 10)} 转外协${
            mark.removed.length ? ` · 关掉了 ${mark.removed.join('、')}` : ''
          } · 等商务开外协单`}
        >
          转外协 · 待外协
        </span>
        {canCancel && (
          <button
            type="button"
            disabled={pending}
            onClick={() => (armed ? run('cancelPartOutsource') : setArmed(true))}
            onBlur={() => setArmed(false)}
            className={`text-[10px] tracking-wider transition-colors disabled:opacity-50 ${
              armed
                ? 'font-semibold text-[var(--color-overdue)]'
                : 'text-[var(--color-ink-4)] hover:text-[var(--color-ink)]'
            }`}
          >
            {pending ? '取消中…' : armed ? '确认取消' : '取消'}
          </button>
        )}
      </span>
    )
  }

  if (!canTransfer || atVendor) return null

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => (armed ? run('transferPartOutsource') : setArmed(true))}
      onBlur={() => setArmed(false)}
      title="这个零件外发：关掉还没开工的编程、操机、车铣，进待外协"
      className={`whitespace-nowrap text-[10px] tracking-wider outline-none transition-colors disabled:opacity-50 ${
        armed
          ? 'font-semibold text-[var(--color-warning)]'
          : 'text-[var(--color-ink-4)] hover:text-[var(--color-warning)]'
      }`}
    >
      {pending ? '转外协中…' : armed ? '确认转外协' : '转外协'}
    </button>
  )
}
