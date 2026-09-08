'use client'

import { useCallback, useEffect, useMemo, useRef } from 'react'

// 拉列宽 —— 表头两列之间那条竖线, 按住往左右拖。
//
// 为什么需要它: 工号、料号、程序号这些东西没有"标准长度"。YNMX-26-4-9-094 是
// 一个工号, 客户给的 PN-2026-XY-0001-A 也是一个料号, 一列定死多宽都会有人被
// 截掉半截。定宽的表看着整齐, 代价是每天都有人要把鼠标停在一格上等提示框弹
// 出来 —— 那不是读表, 那是查字典。
//
// 拉过的宽度记在这台机器上 (localStorage)。厂里每个人盯的东西不一样: 编程员
// 要看长料号, 跟单要看工号, 各人拉各人的, 不互相覆盖, 也不用谁去设置页里配。
// 双击那条线 = 这一列回到默认宽度。
//
// 怎么实现的: 列宽是 CSS 变量 (--cw-<列名>), 表头和每一行的 grid 模板里写的
// 都是 `var(--cw-x, 默认值)` —— 一个服务端客户端完全一样的常量字符串。拖动时
// 只改容器上的那一个变量, 不动 React 状态: 几百行的表拖起来才跟手, 而且首屏
// 渲染永远是默认宽度, 不会和服务端对不上。

export type ColSpec = {
  key: string
  label: string
  /** 像素宽。给了就是可拉的固定列。 */
  width?: number
  /** 吃掉剩余宽度的那一列 (通常是名称列)。不可拉, 因为它本来就不会被挤窄。 */
  flex?: boolean
  /** 拉到多窄为止。 */
  min?: number
  align?: 'left' | 'right'
}

/** 列之间的间距, 和行上的 gap-x-4 对齐。 */
const GAP = 16
const MIN_DEFAULT = 56

function varName(key: string): string {
  return `--cw-${key.replace(/[^a-zA-Z0-9_-]/g, '')}`
}

function readStored(storageKey: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return {}
    const obj = JSON.parse(raw)
    if (!obj || typeof obj !== 'object') return {}
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

function writeStored(storageKey: string, rows: Record<string, number>): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(rows))
  } catch {
    // 无痕模式 / 存储满 —— 这一次拉宽照样生效, 只是下次不记得。
  }
}

export function useColumnWidths(storageKey: string, cols: ColSpec[]) {
  // 变量挂在这一层上, 表头和所有行都在它里面。
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const stored = readStored(storageKey)
    for (const c of cols) {
      const w = stored[c.key]
      if (typeof w === 'number') el.style.setProperty(varName(c.key), `${w}px`)
    }
    // cols 是模块级常量, 不会在渲染之间变身份。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey])

  const template = useMemo(
    () =>
      cols
        .map((c) =>
          c.flex
            ? `minmax(${c.min ?? 200}px, 1fr)`
            : `var(${varName(c.key)}, ${c.width ?? 120}px)`,
        )
        .join(' '),
    [cols],
  )

  // 拉宽后表格至少这么宽, 超出容器就横向滚 —— 拉过的宽度不会被容器压回去。
  const minWidth = useMemo(
    () =>
      `calc(${cols
        .map((c) =>
          c.flex ? `${c.min ?? 200}px` : `var(${varName(c.key)}, ${c.width ?? 120}px)`,
        )
        .join(' + ')} + ${GAP * Math.max(0, cols.length - 1)}px)`,
    [cols],
  )

  const startResize = useCallback(
    (key: string, e: React.PointerEvent<HTMLElement>) => {
      const col = cols.find((c) => c.key === key)
      const root = rootRef.current
      if (!col || col.flex || !root) return
      e.preventDefault()
      e.stopPropagation()

      const name = varName(key)
      const startX = e.clientX
      const startW =
        parseFloat(getComputedStyle(root).getPropertyValue(name)) ||
        col.width ||
        120
      const min = col.min ?? MIN_DEFAULT
      const handle = e.currentTarget
      handle.setPointerCapture(e.pointerId)
      let latest = startW

      const move = (ev: PointerEvent) => {
        latest = Math.max(min, Math.round(startW + (ev.clientX - startX)))
        root.style.setProperty(name, `${latest}px`)
      }
      const up = () => {
        handle.releasePointerCapture(e.pointerId)
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        writeStored(storageKey, { ...readStored(storageKey), [key]: latest })
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [cols, storageKey],
  )

  const resetCol = useCallback(
    (key: string) => {
      rootRef.current?.style.removeProperty(varName(key))
      const stored = readStored(storageKey)
      delete stored[key]
      writeStored(storageKey, stored)
    },
    [storageKey],
  )

  const resetAll = useCallback(() => {
    const root = rootRef.current
    if (root) for (const c of cols) root.style.removeProperty(varName(c.key))
    writeStored(storageKey, {})
  }, [cols, storageKey])

  return { rootRef, template, minWidth, startResize, resetCol, resetAll }
}

/**
 * 表头。列名之间那条竖线就是把手 —— 按住拖改宽, 双击回默认。
 * 表头和行共用同一个 grid 模板, 所以列永远对得齐。
 */
export function ResizableHeader({
  cols,
  template,
  startResize,
  resetCol,
}: {
  cols: ColSpec[]
  template: string
  startResize: (key: string, e: React.PointerEvent<HTMLElement>) => void
  resetCol: (key: string) => void
}) {
  return (
    <div
      className="grid items-baseline gap-x-4 border-b border-[var(--color-border)] px-3 py-2"
      style={{ gridTemplateColumns: template }}
    >
      {cols.map((c, i) => (
        <span
          key={c.key}
          className={`label relative min-w-0 select-none break-words ${
            c.align === 'right' ? 'text-right' : ''
          }`}
        >
          {c.label}
          {!c.flex && i < cols.length - 1 && (
            <span
              role="separator"
              aria-label={`拉宽 ${c.label || '这一列'}`}
              title="拖动改列宽 · 双击恢复"
              onPointerDown={(e) => startResize(c.key, e)}
              onDoubleClick={() => resetCol(c.key)}
              // 把手比看得见的那条线宽得多 —— 一条 1px 的线是抓不住的。
              className="absolute -right-2.5 top-[-6px] bottom-[-6px] w-5 cursor-col-resize after:absolute after:inset-y-0 after:left-1/2 after:w-px after:bg-[var(--color-border)] hover:after:bg-[var(--color-ink-3)]"
            />
          )}
        </span>
      ))}
    </div>
  )
}
