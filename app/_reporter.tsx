'use client'

import { useEffect, useState } from 'react'

/*
 * 报工人 — 这台机器前面站的是谁。
 *
 * 车间半数账号是共用的 (塑料操机001、打磨喷漆、批量组001…): 两个人分开报同一
 * 张单的不同零件, 报出来却是同一个名字, 报工统计自然分不开。账号管的是"能不
 * 能报这道工序", 管不了"是谁在报"。
 *
 * 所以在账号之外留一个名字, 存在这台机器上 (localStorage), 报工的时候跟着一
 * 起走 —— 每一下 ▶ / ✓ / 完成数量都记在这个名字上, 报工统计里两个人就分开了。
 * 没设的话照旧记账号名, 什么都不变。
 *
 * 一次设定, 换人再点一下。班组交接就是换这一个名字。
 */

const KEY = 'siyue:reporter'
const EVENT = 'siyue:reporter-changed'

/** 报工时跟着请求走的那个名字 — 没设就返回空, 服务端退回账号名。 */
export function getReporterName(): string {
  if (typeof window === 'undefined') return ''
  try {
    return (window.localStorage.getItem(KEY) ?? '').trim().slice(0, 24)
  } catch {
    return ''
  }
}

function setReporterName(name: string): void {
  try {
    const v = name.trim().slice(0, 24)
    if (v) window.localStorage.setItem(KEY, v)
    else window.localStorage.removeItem(KEY)
  } catch {
    // 隐私模式下写不进去 — 这一台就退回账号名, 不该因此拦住报工。
  }
  window.dispatchEvent(new CustomEvent(EVENT))
}

/**
 * 顶栏上的那一小块。生产账号才出现 —— 商务不报工, 给他们看只是多一个字。
 */
export function ReporterChip({ accountName }: { accountName: string }) {
  const [name, setName] = useState('')
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    const read = () => setName(getReporterName())
    read()
    window.addEventListener(EVENT, read)
    window.addEventListener('storage', read)
    return () => {
      window.removeEventListener(EVENT, read)
      window.removeEventListener('storage', read)
    }
  }, [])

  const save = () => {
    setReporterName(draft)
    setOpen(false)
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setDraft(name)
          setOpen(true)
        }}
        title="这台机器上报工记在谁名下 · 换人点一下"
        className={`whitespace-nowrap text-[12px] transition-colors ${
          name
            ? 'font-medium text-[var(--color-ink)]'
            : 'text-[var(--color-ink-4)] hover:text-[var(--color-ink-2)]'
        }`}
      >
        报工人 · {name || '设一下'}
      </button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="报工人"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-[340px] max-w-[92vw] rounded-[2px] border border-[var(--color-ink)] bg-[var(--color-surface)] p-6 shadow-xl"
          >
            <p className="label mb-1 text-[var(--color-ink-3)]">报工人</p>
            <h3 className="mb-4 text-[15px] font-medium tracking-tight text-[var(--color-ink)]">
              这台机器上报的工，记在谁名下
            </h3>
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save()
                if (e.key === 'Escape') setOpen(false)
              }}
              placeholder={accountName}
              className="h-10 w-full rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-[14px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
            />
            <p className="mt-3 text-[12px] text-[var(--color-ink-3)]">
              一个账号两个人用的时候，各自设一下自己的名字，报工统计就分得开。
              空着就还是记「{accountName}」。换班点一下改掉。
            </p>
            <div className="mt-6 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-[2px] border border-[var(--color-border)] px-3 py-1.5 text-[12px] tracking-wider text-[var(--color-ink-2)] hover:bg-[#f1eee4]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={save}
                className="rounded-[2px] bg-[var(--color-ink)] px-3 py-1.5 text-[12px] tracking-wider text-[var(--color-surface)] hover:opacity-80"
              >
                记住
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
