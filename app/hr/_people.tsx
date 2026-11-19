'use client'

import { useState, useTransition } from 'react'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'

// 名单 —— 报工时「谁做的」那张选人名单, 在这里一次改完 (于海伟 2026-11-19)。
// 每个名字就是一个框: 改字、回车或点别处就存; ✕ 从名单上去掉; 去掉的收在最下
// 面, 点「放回」又回来。只动这张选人名单 (lib/people-picker), 登录账号、人事
// 记录、以前的报工都不变。
export function PeopleBoard({ names, hidden }: { names: string[]; hidden: string[] }) {
  const [q, setQ] = useState('')
  const [adding, setAdding] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [pending, start] = useTransition()

  const run = (body: Record<string, unknown> & { kind: string }) =>
    start(async () => {
      try {
        await mutate(body)
      } catch (e) {
        showToast(e instanceof Error ? e.message : '没改上', 'warning')
      }
    })

  const needle = q.trim()
  const shown = needle ? names.filter((n) => n.includes(needle)) : names
  const inp =
    'h-9 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]'

  return (
    <div className="mx-auto max-w-4xl">
      <p className="mb-4 text-[12.5px] text-[var(--color-ink-3)]">
        报工时「谁做的」选的就是这 {names.length} 个名字。点名字直接改，✕ 去掉；只改这张名单，账号和以前的报工都不变。
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="找人"
          className={`${inp} w-[160px]`}
        />
        <span className="flex items-center gap-2">
          <input
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && adding.trim()) {
                run({ kind: 'addPickerName', name: adding.trim() })
                setAdding('')
              }
            }}
            placeholder="加一个人"
            className={`${inp} w-[140px]`}
          />
          <button
            type="button"
            disabled={pending || !adding.trim()}
            onClick={() => {
              run({ kind: 'addPickerName', name: adding.trim() })
              setAdding('')
            }}
            className="rounded-[2px] bg-[var(--color-ink)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-40"
          >
            加上
          </button>
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
        {shown.map((n) => (
          <span
            key={n}
            className="flex items-center rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] focus-within:border-[var(--color-ink)]"
          >
            <input
              defaultValue={n}
              disabled={pending}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing)
                  (e.target as HTMLInputElement).blur()
              }}
              onBlur={(e) => {
                const to = e.target.value.trim()
                if (!to || to === n) {
                  e.target.value = n
                  return
                }
                run({ kind: 'renamePickerName', name: n, to })
              }}
              className="h-9 min-w-0 flex-1 bg-transparent px-2.5 text-[13.5px] text-[var(--color-ink)] outline-none"
            />
            <button
              type="button"
              disabled={pending}
              title={`把「${n}」从名单上去掉`}
              onClick={() => run({ kind: 'hidePickerName', name: n })}
              className="px-2 text-[12px] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)] disabled:opacity-40"
            >
              ✕
            </button>
          </span>
        ))}
      </div>

      {hidden.length > 0 && (
        <div className="mt-8">
          <button
            type="button"
            onClick={() => setShowHidden((v) => !v)}
            className="text-[12.5px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
          >
            已去掉 {hidden.length} 个 {showHidden ? '▴' : '▾'}
          </button>
          {showHidden && (
            <div className="mt-3 flex flex-wrap gap-2">
              {hidden.map((n) => (
                <span
                  key={n}
                  className="inline-flex items-center gap-2 rounded-[2px] border border-dashed border-[var(--color-border-strong)] px-2.5 py-1.5 text-[13px] text-[var(--color-ink-3)]"
                >
                  {n}
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => run({ kind: 'restorePickerName', name: n })}
                    className="text-[12px] text-[var(--color-ink-2)] hover:text-[var(--color-ink)] hover:underline underline-offset-2"
                  >
                    放回
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
