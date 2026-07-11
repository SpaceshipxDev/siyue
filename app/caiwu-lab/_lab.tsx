'use client'

// caiwu-lab shell — the design switcher. Mounts ONE MockStoreProvider above
// the three designs so they share state (flip between them mid-session and an
// appended installment persists). The switcher reuses the underline-active tab
// idiom from the master board, not new chrome.

import { useState } from 'react'
import { MockStoreProvider, useMockStore } from './_store'
import HuozhangDesign from './_huozhang'
import FenqiDesign from './_fenqi'
import KaipiaoDesign from './_kaipiao'
import LiushuiDesign from './_liushui'

type DesignKey = 'huozhang' | 'fenqi' | 'kaipiao' | 'liushui'

const DESIGNS: { key: DesignKey; label: string; sub: string }[] = [
  { key: 'huozhang', label: '活账单', sub: '一行一单' },
  { key: 'fenqi', label: '分期账', sub: '一行两余额' },
  { key: 'kaipiao', label: '开票本', sub: '客户对账' },
  { key: 'liushui', label: '流水卡', sub: '收件箱' },
]

function normalize(d: string): DesignKey {
  return d === 'fenqi' || d === 'kaipiao' || d === 'liushui' ? d : 'huozhang'
}

function ResetButton() {
  const store = useMockStore()
  return (
    <button
      type="button"
      onClick={() => store.reset()}
      className="rounded-[2px] px-2 py-1 text-[12px] text-[var(--color-ink-3)] hover:bg-[var(--color-active-bg)] hover:text-[var(--color-ink)] transition-colors"
    >
      重置数据
    </button>
  )
}

export default function CaiwuLab({ initialDesign }: { initialDesign: string }) {
  const [design, setDesign] = useState<DesignKey>(normalize(initialDesign))

  const select = (d: DesignKey) => {
    setDesign(d)
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', `/caiwu-lab?design=${d}`)
    }
  }

  return (
    <MockStoreProvider>
      <div className="min-h-screen bg-[var(--color-bg)]">
        {/* Switcher bar — lab chrome. Looks like the board's tab strip. */}
        <div className="sticky top-0 z-20 flex items-center justify-between border-b border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-bg)_88%,transparent)] px-6 backdrop-blur-md">
          <div className="flex items-end gap-1">
            <span className="mr-3 py-3 text-[12px] tracking-[0.14em] text-[var(--color-ink-4)] uppercase">
              财务 · Lab
            </span>
            {DESIGNS.map((d) => {
              const active = d.key === design
              return (
                <button
                  key={d.key}
                  type="button"
                  onClick={() => select(d.key)}
                  className={`relative flex flex-col items-start gap-0.5 px-3 py-2.5 transition-colors ${
                    active ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink-2)]'
                  }`}
                >
                  <span className={`text-[14px] ${active ? 'font-semibold' : ''}`}>{d.label}</span>
                  <span className="mono text-[10px] text-[var(--color-ink-4)]">{d.sub}</span>
                  {active && (
                    <span className="absolute right-3 bottom-0 left-3 h-[2px] rounded-[2px] bg-[var(--color-ink)]" />
                  )}
                </button>
              )
            })}
          </div>
          <ResetButton />
        </div>

        {/* 活账单 is a dense spreadsheet — it wants the full width; the others
            stay centered in the reading column. */}
        <div className={design === 'huozhang' ? '' : 'mx-auto max-w-[1280px]'}>
          {design === 'huozhang' && <HuozhangDesign />}
          {design === 'fenqi' && <FenqiDesign />}
          {design === 'kaipiao' && <KaipiaoDesign />}
          {design === 'liushui' && <LiushuiDesign />}
        </div>
      </div>
    </MockStoreProvider>
  )
}
