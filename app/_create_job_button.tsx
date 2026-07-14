'use client'

import { useRouter } from 'next/navigation'

export const OPEN_NEW_JOB_EVENT = 'siyue:open-new-job'

export function CreateJobButton({ mobile = false }: { mobile?: boolean }) {
  const router = useRouter()

  function openEditor() {
    if (mobile) {
      router.push('/?new=1')
      return
    }
    window.dispatchEvent(new Event(OPEN_NEW_JOB_EVENT))
  }

  return (
    <button
      type="button"
      onClick={openEditor}
      className={
        mobile
          ? 'h-12 rounded-[6px] bg-[var(--color-ink)] px-4 text-[14px] font-semibold text-[var(--color-surface)]'
          : 'h-10 rounded-[3px] bg-[var(--color-ink)] px-4 text-[13px] font-semibold text-[var(--color-surface)] transition-opacity hover:opacity-80'
      }
    >
      ＋ 新建工单
    </button>
  )
}
