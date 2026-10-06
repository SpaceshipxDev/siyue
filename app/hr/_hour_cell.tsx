'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'

// 考勤表的一格 —— 那天出勤几小时 (下面小字是那天记的事)。能改考勤的人点一
// 下就能填实际上班时长, 回车存; 清空回到系统算的数。填过的格子数字下面有一道
// 线, 一眼看得出哪些是人填的。

export function HourCell({
  month,
  name,
  day,
  value,
  filled,
  codes,
  editable,
}: {
  month: string
  name: string
  day: number
  value: number | null
  filled: boolean
  codes: string
  editable: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  function save() {
    const raw = draft.trim()
    setEditing(false)
    const next = raw === '' ? null : Number(raw)
    if (next !== null && !(Number.isFinite(next) && next >= 0 && next <= 24)) {
      showToast('上班时长要填 0 到 24 之间的数', 'warning')
      return
    }
    if (next === null && !filled) return
    if (next !== null && filled && next === value) return
    start(async () => {
      try {
        await mutate({ kind: 'setDailyHours', month, name, day, hours: next })
        router.refresh()
      } catch (e) {
        showToast(e instanceof Error ? e.message : '存不上', 'warning')
      }
    })
  }

  const codesLine = codes ? (
    <span
      className={`block text-[8.5px] ${
        /[旷违质]/.test(codes) ? 'font-semibold text-[var(--color-overdue)]' : 'text-[var(--color-ink-3)]'
      }`}
    >
      {codes}
    </span>
  ) : null

  if (editing)
    return (
      <>
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') setEditing(false)
          }}
          inputMode="decimal"
          placeholder={filled ? '' : '小时'}
          className="mono h-5 w-full rounded-[2px] border border-[var(--color-ink)] bg-white px-0.5 text-center text-[10.5px] outline-none"
        />
        {codesLine}
      </>
    )

  const number =
    value !== null ? (
      <span
        className={`mono block text-[10.5px] ${
          value === 0 ? 'text-[var(--color-ink-4)]' : 'font-medium'
        } ${filled ? 'underline decoration-[var(--color-info)] underline-offset-2' : ''} ${
          pending ? 'opacity-50' : ''
        }`}
      >
        {value}
      </span>
    ) : null

  if (!editable)
    return (
      <>
        {number}
        {codesLine}
      </>
    )

  return (
    <button
      type="button"
      onClick={() => {
        setDraft(value !== null ? String(value) : '')
        setEditing(true)
      }}
      title={filled ? '手填的实际上班时长 · 点一下改，清空回到系统算的数' : '点一下填实际上班时长'}
      className="block min-h-[18px] w-full hover:bg-[var(--color-active-bg)]"
    >
      {number}
      {codesLine}
    </button>
  )
}
