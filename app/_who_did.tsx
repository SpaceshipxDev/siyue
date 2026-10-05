'use client'

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { withBase } from '@/lib/base-path'
import { getReporterName } from './_reporter'

// 谁做的 —— 操机、喷漆报工按 ✓ 的那一下, 先问一句。
//
// 一个账号几个人轮着用、一张单几个人一起做, 是这两道的常态。点一个名字 = 记
// 给这个人; 点几个名字 = 几个人一起做, 这一道按件数分给他们 (单个零件可以改
// 每人几件, 整单就平分)。报工统计里每个人的产出就分开了。
//
// 最近选过的几个排在最前面 (存在这台机器上, 这一道一份) —— 一个工位前面来来回
// 回就那几个人, 一般点一下就完。不想选也行: 「跳过」照旧记在账号 (或者顶上设
// 的报工人) 上。

type Picked = { names: string[]; shares?: { name: string; qty: number }[] }

let namesCache: string[] | null = null

function recentKey(stage: string) {
  return `siyue:who-did:${stage}`
}

function readRecent(stage: string): string[] {
  try {
    const raw = window.localStorage.getItem(recentKey(stage))
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(arr)
      ? arr.filter((x): x is string => typeof x === 'string').slice(0, 8)
      : []
  } catch {
    return []
  }
}

function saveRecent(stage: string, names: string[]) {
  try {
    const next = [...names, ...readRecent(stage).filter((n) => !names.includes(n))].slice(0, 8)
    window.localStorage.setItem(recentKey(stage), JSON.stringify(next))
  } catch {
    // 隐私模式写不进去 —— 下次就是没有"最近", 不碍事。
  }
}

export function WhoDidSheet({
  stage,
  label,
  totalQty,
  onConfirm,
  onSkip,
  onCancel,
}: {
  stage: string
  /** 弹窗上那一行字: 零件名; 整单不传。 */
  label?: string
  /** 单个零件的件数 —— 有它就能给每个人填几件; 整单不传, 几个人就平分。 */
  totalQty?: number
  onConfirm: (p: Picked) => void
  onSkip: () => void
  onCancel: () => void
}) {
  const [all, setAll] = useState<string[]>(namesCache ?? [])
  // 只在点了 ✓ 之后才挂上, 一定在浏览器里, 直接读本机存的。
  const [recent] = useState<string[]>(() => readRecent(stage))
  const [me] = useState(() => getReporterName())
  const [q, setQ] = useState('')
  // 默认先挑上顶上设的那个报工人 —— 多数时候就是这个人。
  const [picked, setPicked] = useState<string[]>(() => (me ? [me] : []))
  const [qtys, setQtys] = useState<Record<string, string>>({})

  useEffect(() => {
    if (namesCache) return
    let alive = true
    fetch(withBase('/api/people'), { cache: 'no-store' })
      .then((res) => res.json())
      .then((d: { ok?: boolean; names?: string[] }) => {
        if (!alive || !d.ok || !d.names) return
        namesCache = d.names
        setAll(d.names)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const needle = q.trim()
  const list = useMemo(() => {
    const rest = all.filter((n) => !recent.includes(n))
    const merged = [...recent, ...rest]
    return needle ? merged.filter((n) => n.includes(needle)) : merged
  }, [all, recent, needle])

  function toggle(name: string) {
    setPicked((cur) => (cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name]))
  }

  // 几个人一起做、又知道件数: 每人几件, 默认平分 (最后一个人兜零头)。
  const many = picked.length > 1
  const shareOf = (name: string, i: number): string => {
    if (qtys[name] !== undefined) return qtys[name]
    if (!totalQty) return ''
    const base = Math.floor((totalQty / picked.length) * 100) / 100
    if (i < picked.length - 1) return String(base)
    return String(Math.round((totalQty - base * (picked.length - 1)) * 100) / 100)
  }
  const shares = picked.map((name, i) => ({
    name,
    qty: Number(shareOf(name, i)) || 0,
  }))
  const sum = Math.round(shares.reduce((s, x) => s + x.qty, 0) * 100) / 100

  function confirm() {
    if (picked.length === 0) return
    saveRecent(stage, picked)
    onConfirm(
      many && totalQty
        ? { names: picked, shares: shares.filter((s) => s.qty > 0) }
        : { names: picked },
    )
  }

  const chip = (name: string) => {
    const on = picked.includes(name)
    return (
      <button
        key={name}
        type="button"
        onClick={() => toggle(name)}
        aria-pressed={on}
        className={`rounded-[2px] border px-3 py-1.5 text-[13.5px] transition-colors ${
          on
            ? 'border-[var(--color-ink)] bg-[var(--color-ink)] font-medium text-[var(--color-surface)]'
            : 'border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-ink-2)] hover:border-[var(--color-ink)]'
        }`}
      >
        {name}
      </button>
    )
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="谁做的"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={(e) => {
        // 弹窗是挂在格子里面的 (React 树上), 点击别冒到格子的按钮上去。
        e.stopPropagation()
        onCancel()
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[86vh] w-[480px] max-w-full flex-col rounded-[2px] border border-[var(--color-ink)] bg-[var(--color-surface)] p-6 shadow-xl"
      >
        <p className="label mb-1 text-[var(--color-ink-3)]">{stage} · 报工</p>
        <h3 className="text-[17px] font-semibold tracking-tight text-[var(--color-ink)]">
          谁做的？
        </h3>
        {label ? (
          <p className="mt-0.5 truncate text-[12.5px] text-[var(--color-ink-3)]">{label}</p>
        ) : null}

        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            // 名单里没有的人 —— 打完名字按回车就加上。
            if (e.key === 'Enter' && needle && !picked.includes(needle)) {
              setPicked((cur) => [...cur, needle])
              setQ('')
            }
          }}
          placeholder="找人 · 名单里没有的打完名字按回车"
          className="mt-4 h-9 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
        />

        <div className="mt-3 min-h-[60px] flex-1 overflow-y-auto">
          {/* 名单之外临时加的人也显示在最前面 */}
          <div className="flex flex-wrap gap-2">
            {picked.filter((n) => !list.includes(n) && !all.includes(n)).map(chip)}
            {list.map(chip)}
          </div>
          {list.length === 0 && all.length === 0 && (
            <p className="py-4 text-center text-[12.5px] text-[var(--color-ink-4)]">名单读取中…</p>
          )}
        </div>

        {many && (
          <div className="mt-4 border-t border-[var(--color-border)] pt-3">
            {totalQty ? (
              <>
                <p className="label mb-2">
                  {picked.length} 人一起做 · 每人几件{' '}
                  <span
                    className={
                      sum === totalQty ? 'text-[var(--color-ink-3)]' : 'text-[var(--color-warning)]'
                    }
                  >
                    （合计 {sum} / {totalQty}）
                  </span>
                </p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                  {picked.map((name, i) => (
                    <label key={name} className="flex items-center gap-2">
                      <span className="w-[72px] shrink-0 truncate text-[13px] text-[var(--color-ink)]">
                        {name}
                      </span>
                      <input
                        value={shareOf(name, i)}
                        onChange={(e) => setQtys((cur) => ({ ...cur, [name]: e.target.value }))}
                        inputMode="decimal"
                        className="mono h-8 w-[72px] rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-right text-[13px] outline-none focus:border-[var(--color-border-strong)]"
                      />
                      <span className="text-[12px] text-[var(--color-ink-3)]">件</span>
                    </label>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-[12.5px] text-[var(--color-ink-2)]">
                {picked.join('、')} {picked.length} 人一起做 —— 这一单每个零件平分给这几个人。
              </p>
            )}
          </div>
        )}

        <div className="mt-5 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onSkip}
            className="text-[12px] text-[var(--color-ink-4)] hover:text-[var(--color-ink)]"
            title="不选人，跟以前一样记在账号上"
          >
            跳过，记在{me || '账号'}上
          </button>
          <span className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-[2px] border border-[var(--color-border)] px-3 py-1.5 text-[12px] tracking-wider text-[var(--color-ink-2)] hover:bg-[#f1eee4]"
            >
              取消
            </button>
            <button
              type="button"
              disabled={picked.length === 0}
              onClick={confirm}
              className="rounded-[2px] bg-[var(--color-ink)] px-4 py-1.5 text-[12.5px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-40"
            >
              {picked.length <= 1
                ? `完成 · 记给${picked[0] ?? '…'}`
                : `完成 · ${picked.length} 人分`}
            </button>
          </span>
        </div>
      </div>
    </div>,
    document.body,
  )
}
