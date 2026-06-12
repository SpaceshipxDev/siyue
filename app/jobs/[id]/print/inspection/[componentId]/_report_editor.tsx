'use client'

import { useEffect, useRef, useState } from 'react'
import { mutate } from '@/lib/mutate'
import {
  dimLimit,
  emptyDimRow,
  PROCESS_CHECKS,
  type DimRow,
  type DimVerdict,
  type InspectionReport,
  type InspectionReportPatch,
} from '@/lib/inspection-report'

// 出厂检验报告 editor — the whole document is the form. Every input commits
// into one local report object; a debounced autosave pushes the full patch
// through /api/mutate (upsertInspectionReport). One inspector fills one
// report, so whole-document last-write-wins is correct and keeps the wire
// to a single kind.

type Header = {
  brand: string
  jobNo: string
  customer: string
  partName: string
  material: string
  surfaceTreatment: string
  qty: number
}

type Draft = Omit<InspectionReport, 'id' | 'partId' | 'createdBy' | 'createdAt' | 'updatedAt' | 'updatedBy'>

function toDraft(r: InspectionReport): Draft {
  return {
    reportNo: r.reportNo,
    inspectMethod: r.inspectMethod,
    dims: r.dims.length > 0 ? r.dims : [emptyDimRow(1)],
    processChecks: r.processChecks,
    performance: r.performance,
    appearance: r.appearance,
    packaging: r.packaging,
    disposition: r.disposition,
    customerPlan: r.customerPlan,
    finalVerdict: r.finalVerdict,
    evaluation: r.evaluation,
    confirmer: r.confirmer,
    inspector: r.inspector,
    approver: r.approver,
    inspectedAt: r.inspectedAt,
  }
}

function toPatch(d: Draft): InspectionReportPatch {
  return {
    reportNo: d.reportNo ?? null,
    inspectMethod: d.inspectMethod ?? null,
    dims: d.dims,
    processChecks: d.processChecks,
    performance: d.performance,
    appearance: d.appearance,
    packaging: d.packaging,
    disposition: d.disposition ?? null,
    customerPlan: d.customerPlan ?? null,
    finalVerdict: d.finalVerdict ?? null,
    evaluation: d.evaluation ?? null,
    confirmer: d.confirmer ?? null,
    inspector: d.inspector ?? null,
    approver: d.approver ?? null,
    inspectedAt: d.inspectedAt ?? null,
  }
}

export function ReportEditor({
  jobId,
  componentId,
  header,
  initial,
  editable,
  userName,
}: {
  jobId: string
  componentId: string
  header: Header
  initial: InspectionReport
  editable: boolean
  userName: string
}) {
  const [draft, setDraft] = useState<Draft>(() => {
    const d = toDraft(initial)
    // First open: prefill the inspector + date so the common path is
    // measure → tick → print, zero ceremony.
    if (!initial.id) {
      d.inspector = d.inspector || userName
      d.inspectedAt =
        d.inspectedAt ||
        new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
    }
    return d
  })
  const [saveState, setSaveState] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'failed'>(
    'idle',
  )
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Source of truth for the debounced save — written ONLY inside `update`
  // (an event-handler path), never during render, so the autosave always
  // serializes the latest keystroke without a render-phase ref read.
  const latest = useRef<Draft | null>(null)

  const update = (fn: (d: Draft) => Draft) => {
    if (!editable) return
    setDraft((prev) => {
      const next = fn(latest.current ?? prev)
      latest.current = next
      return next
    })
    setSaveState('dirty')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void save(), 900)
  }

  const save = async () => {
    const snapshot = latest.current
    if (!snapshot) return
    setSaveState('saving')
    try {
      await mutate({
        kind: 'upsertInspectionReport',
        jobId,
        componentId,
        patch: toPatch(snapshot),
      })
      setSaveState('saved')
    } catch {
      setSaveState('failed')
    }
  }

  // Flush the debounce on unload so a quick fill-and-close still persists.
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    update((d) => ({ ...d, [key]: value }))

  const setDim = (i: number, patch: Partial<DimRow>) =>
    update((d) => ({
      ...d,
      dims: d.dims.map((row, k) => (k === i ? { ...row, ...patch } : row)),
    }))

  const toggleCheck = (item: string) =>
    update((d) => ({
      ...d,
      processChecks: d.processChecks.includes(item)
        ? d.processChecks.filter((x) => x !== item)
        : [...d.processChecks, item],
    }))

  const ro = !editable

  return (
    <div>
      {/* Save indicator — screen only, floats with the toolbar. */}
      <div className="no-print fixed top-3 left-3 z-50">
        <span
          className={`px-2 py-1 rounded-[2px] text-[11px] tracking-wider ${
            saveState === 'failed'
              ? 'bg-[var(--color-overdue)] text-white'
              : 'bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-ink-3)]'
          }`}
        >
          {saveState === 'saving' || saveState === 'dirty'
            ? '保存中…'
            : saveState === 'saved'
              ? '已保存'
              : saveState === 'failed'
                ? '保存失败 · 修改后重试'
                : ro
                  ? '只读'
                  : '自动保存'}
        </span>
      </div>

      <header className="border-b border-[var(--color-ink)] pb-3">
        <p className="text-center text-[12px] text-[var(--color-ink-2)] tracking-wide">
          {header.brand}
        </p>
        <h1 className="text-center text-[26px] font-semibold tracking-tight mt-1">
          出厂检验报告
        </h1>
        <p className="text-center text-[10px] text-[var(--color-ink-3)] tracking-[0.18em] uppercase mt-0.5">
          Outgoing Quality Inspection Report
        </p>
        <p className="text-right text-[12px] mono mt-1">
          <Inline
            value={draft.reportNo ?? ''}
            placeholder="报告编号 QR…"
            onChange={(v) => set('reportNo', v)}
            readOnly={ro}
            className="text-right"
          />
        </p>
      </header>

      {/* Header facts — live from the job/part, never stored. */}
      <section className="grid grid-cols-3 gap-x-8 gap-y-2 py-4 text-[13px] border-b border-[var(--color-border)]">
        <Fact label="订单编号" value={header.jobNo} mono />
        <Fact label="客户名称" value={header.customer} />
        <Fact label="零件名称" value={header.partName} />
        <Fact label="材料" value={header.material || '—'} />
        <Fact label="表面处理" value={header.surfaceTreatment || '—'} />
        <Fact label="发货数 / PCS" value={String(header.qty)} mono />
        <div className="col-span-3 flex items-baseline gap-2">
          <span className="label shrink-0">检验方法</span>
          <Inline
            value={draft.inspectMethod ?? ''}
            placeholder="抽检 / 全检 · 量具 …"
            onChange={(v) => set('inspectMethod', v)}
            readOnly={ro}
            className="flex-1"
          />
        </div>
      </section>

      {/* 尺寸检验 */}
      <section className="py-4 border-b border-[var(--color-border)]">
        <p className="label mb-2">尺寸检验</p>
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr className="border-y border-[var(--color-border-strong)]">
              <Th className="w-[90px]">位置</Th>
              <Th className="text-right">标准值</Th>
              <Th className="w-[40px]">单位</Th>
              <Th className="text-right">上公差</Th>
              <Th className="text-right">下公差</Th>
              <Th className="text-right">上限</Th>
              <Th className="text-right">下限</Th>
              <Th className="text-right">实测数值</Th>
              <Th className="w-[86px]">判定</Th>
              <Th>使用量具</Th>
              {!ro ? <Th className="w-[24px] no-print"> </Th> : null}
            </tr>
          </thead>
          <tbody>
            {draft.dims.map((row, i) => (
              <tr key={i} className="border-b border-[var(--color-border)]">
                <Td>
                  <Inline value={row.label} onChange={(v) => setDim(i, { label: v })} readOnly={ro} />
                </Td>
                <Td className="text-right">
                  <Inline mono value={row.nominal} onChange={(v) => setDim(i, { nominal: v })} readOnly={ro} className="text-right" />
                </Td>
                <Td>
                  <Inline mono value={row.unit} onChange={(v) => setDim(i, { unit: v })} readOnly={ro} />
                </Td>
                <Td className="text-right">
                  <Inline mono value={row.tolUp} placeholder="+" onChange={(v) => setDim(i, { tolUp: v })} readOnly={ro} className="text-right" />
                </Td>
                <Td className="text-right">
                  <Inline mono value={row.tolDown} placeholder="−" onChange={(v) => setDim(i, { tolDown: v })} readOnly={ro} className="text-right" />
                </Td>
                <Td className="text-right mono text-[var(--color-ink-3)]">
                  {dimLimit(row.nominal, row.tolUp)}
                </Td>
                <Td className="text-right mono text-[var(--color-ink-3)]">
                  {dimLimit(row.nominal, row.tolDown)}
                </Td>
                <Td className="text-right">
                  <Inline mono value={row.measured} onChange={(v) => setDim(i, { measured: v })} readOnly={ro} className="text-right" />
                </Td>
                <Td>
                  <VerdictPick
                    value={row.verdict}
                    onChange={(v) => setDim(i, { verdict: v })}
                    readOnly={ro}
                  />
                </Td>
                <Td>
                  <Inline value={row.gauge} placeholder="卡尺 / 千分尺 …" onChange={(v) => setDim(i, { gauge: v })} readOnly={ro} />
                </Td>
                {!ro ? (
                  <Td className="no-print">
                    <button
                      type="button"
                      onClick={() =>
                        update((d) => ({
                          ...d,
                          dims: d.dims.filter((_, k) => k !== i),
                        }))
                      }
                      aria-label="删除此行"
                      className="text-[var(--color-ink-4)] hover:text-[var(--color-overdue)] text-[13px] leading-none px-1"
                    >
                      ×
                    </button>
                  </Td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
        {!ro ? (
          <button
            type="button"
            onClick={() =>
              update((d) => ({
                ...d,
                dims: [...d.dims, emptyDimRow(d.dims.length + 1)],
              }))
            }
            className="no-print mt-2 label text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
          >
            + 添加尺寸
          </button>
        ) : null}
      </section>

      {/* 其他工序检查 */}
      <section className="py-4 border-b border-[var(--color-border)]">
        <p className="label mb-2">其他工序检查</p>
        <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-[13px]">
          {PROCESS_CHECKS.map((item) => {
            const on = draft.processChecks.includes(item)
            return (
              <label
                key={item}
                className={`inline-flex items-center gap-1.5 ${ro ? '' : 'cursor-pointer'}`}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggleCheck(item)}
                  disabled={ro}
                  className="accent-[var(--color-ink)] screen-only"
                />
                <span className="print-only mono">{on ? '■' : '□'}</span>
                <span className={on ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-2)]'}>
                  {item}
                </span>
              </label>
            )
          })}
        </div>
      </section>

      {/* 产品性能 */}
      <section className="py-4 border-b border-[var(--color-border)]">
        <p className="label mb-2">产品性能</p>
        <div className="grid grid-cols-5 gap-x-6 gap-y-2 text-[13px]">
          <LabeledInline label="涂层附着力" value={draft.performance.coatingAdhesion} readOnly={ro}
            onChange={(v) => set('performance', { ...draft.performance, coatingAdhesion: v })} />
          <LabeledInline label="丝印耐醇性" value={draft.performance.silkAlcohol} readOnly={ro}
            onChange={(v) => set('performance', { ...draft.performance, silkAlcohol: v })} />
          <LabeledInline label="丝印附着力" value={draft.performance.silkAdhesion} readOnly={ro}
            onChange={(v) => set('performance', { ...draft.performance, silkAdhesion: v })} />
          <LabeledInline label="螺母通止规" value={draft.performance.nutGauge} readOnly={ro}
            onChange={(v) => set('performance', { ...draft.performance, nutGauge: v })} />
          <LabeledInline label="其他项" value={draft.performance.other} readOnly={ro}
            onChange={(v) => set('performance', { ...draft.performance, other: v })} />
        </div>
      </section>

      {/* 产品外观 */}
      <section className="py-4 border-b border-[var(--color-border)]">
        <p className="label mb-2">产品外观</p>
        <div className="grid grid-cols-3 gap-x-6 gap-y-2 text-[13px]">
          <div className="flex items-baseline gap-2">
            <span className="label shrink-0">色差值</span>
            <span className="text-[12px] text-[var(--color-ink-3)] shrink-0">要求 ⊿E≤1.5 · 实测</span>
            <Inline mono value={draft.appearance.colorDiffMeasured} readOnly={ro}
              onChange={(v) => set('appearance', { ...draft.appearance, colorDiffMeasured: v })} className="flex-1" />
          </div>
          <LabeledInline label="外观缺陷" value={draft.appearance.defects} readOnly={ro}
            onChange={(v) => set('appearance', { ...draft.appearance, defects: v })} />
          <LabeledInline label="外观不良描述" value={draft.appearance.defectDesc} readOnly={ro}
            onChange={(v) => set('appearance', { ...draft.appearance, defectDesc: v })} />
        </div>
      </section>

      {/* 来料包装 */}
      <section className="py-4 border-b border-[var(--color-border)]">
        <p className="label mb-2">来料包装</p>
        <div className="grid grid-cols-4 gap-x-6 gap-y-2 text-[13px]">
          <LabeledInline label="打包方式" value={draft.packaging.method} readOnly={ro}
            onChange={(v) => set('packaging', { ...draft.packaging, method: v })} />
          <LabeledInline label="外箱外观" value={draft.packaging.boxAppearance} readOnly={ro}
            onChange={(v) => set('packaging', { ...draft.packaging, boxAppearance: v })} />
          <LabeledInline label="外箱标识" value={draft.packaging.boxLabel} readOnly={ro}
            onChange={(v) => set('packaging', { ...draft.packaging, boxLabel: v })} />
          <LabeledInline label="随货文件" value={draft.packaging.documents} readOnly={ro}
            onChange={(v) => set('packaging', { ...draft.packaging, documents: v })} />
        </div>
      </section>

      {/* 处理方案 + 判定 */}
      <section className="py-4 border-b border-[var(--color-border)] text-[13px]">
        <div className="grid grid-cols-2 gap-x-8 gap-y-2">
          <LabeledInline label="本批次产品处理方案" value={draft.disposition ?? ''} readOnly={ro}
            onChange={(v) => set('disposition', v)} />
          <LabeledInline label="客户沟通后处理方案" value={draft.customerPlan ?? ''} readOnly={ro}
            onChange={(v) => set('customerPlan', v)} />
          <LabeledInline label="最终判定结果" value={draft.finalVerdict ?? ''} readOnly={ro}
            onChange={(v) => set('finalVerdict', v)} />
          <div className="flex items-baseline gap-4">
            <LabeledInline label="评估处理结果" value={draft.evaluation ?? ''} readOnly={ro}
              onChange={(v) => set('evaluation', v)} className="flex-1" />
            <LabeledInline label="确认人" value={draft.confirmer ?? ''} readOnly={ro}
              onChange={(v) => set('confirmer', v)} className="w-[140px]" />
          </div>
        </div>
      </section>

      {/* Signatures */}
      <section className="pt-6 grid grid-cols-3 gap-x-8 text-[13px]">
        <LabeledInline label="质检员" value={draft.inspector ?? ''} readOnly={ro}
          onChange={(v) => set('inspector', v)} />
        <LabeledInline label="审核 / 批准" value={draft.approver ?? ''} readOnly={ro}
          onChange={(v) => set('approver', v)} />
        <div className="flex items-baseline gap-2">
          <span className="label shrink-0">检验时间</span>
          <Inline mono value={draft.inspectedAt ?? ''} placeholder="YYYY-MM-DD" readOnly={ro}
            onChange={(v) => set('inspectedAt', v)} className="flex-1" />
        </div>
      </section>
    </div>
  )
}

// === primitives ===

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <span className="label shrink-0">{label}</span>
      <span className={`truncate ${mono ? 'mono' : ''}`}>{value}</span>
    </div>
  )
}

function Inline({
  value,
  onChange,
  placeholder = '—',
  readOnly,
  mono,
  className = '',
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  readOnly?: boolean
  mono?: boolean
  className?: string
}) {
  if (readOnly) {
    return (
      <span className={`${mono ? 'mono' : ''} ${value ? '' : 'text-[var(--color-ink-4)]'} ${className}`}>
        {value || '—'}
      </span>
    )
  }
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      spellCheck={false}
      className={`bg-transparent border-0 border-b border-dotted border-[var(--color-border-strong)] outline-none rounded-none px-0.5 py-0.5 w-full min-w-0 focus:border-solid focus:border-[var(--color-ink)] placeholder:text-[var(--color-ink-4)] ${
        mono ? 'mono' : ''
      } ${className}`}
    />
  )
}

function LabeledInline({
  label,
  value,
  onChange,
  readOnly,
  className = '',
}: {
  label: string
  value: string
  onChange: (v: string) => void
  readOnly?: boolean
  className?: string
}) {
  return (
    <div className={`flex items-baseline gap-2 min-w-0 ${className}`}>
      <span className="label shrink-0">{label}</span>
      <Inline value={value} onChange={onChange} readOnly={readOnly} className="flex-1" />
    </div>
  )
}

const DIM_VERDICTS: DimVerdict[] = ['OK', 'NG', 'Marginal']

function VerdictPick({
  value,
  onChange,
  readOnly,
}: {
  value: DimVerdict
  onChange: (v: DimVerdict) => void
  readOnly?: boolean
}) {
  if (readOnly) {
    return (
      <span
        className={`mono text-[11px] ${
          value === 'NG'
            ? 'text-[var(--color-overdue)] font-semibold'
            : value === 'OK'
              ? 'text-[var(--color-success)]'
              : 'text-[var(--color-ink-2)]'
        }`}
      >
        {value || '—'}
      </span>
    )
  }
  return (
    <>
      <span className="screen-only inline-flex gap-0.5">
        {DIM_VERDICTS.map((v) => {
          const active = value === v
          return (
            <button
              key={v}
              type="button"
              onClick={() => onChange(active ? '' : v)}
              aria-pressed={active}
              className={`px-1 py-0.5 rounded-[2px] mono text-[10px] border transition-colors ${
                active
                  ? v === 'NG'
                    ? 'border-[var(--color-overdue)] bg-[var(--color-overdue)] text-white'
                    : 'border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-surface)]'
                  : 'border-[var(--color-border)] text-[var(--color-ink-3)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)]'
              }`}
            >
              {v === 'Marginal' ? 'Mg' : v}
            </button>
          )
        })}
      </span>
      <span
        className={`print-only mono text-[11px] ${
          value === 'NG' ? 'font-semibold' : ''
        }`}
      >
        {value || ''}
      </span>
    </>
  )
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={`label font-medium px-1.5 py-1.5 text-left whitespace-nowrap ${className}`}>
      {children}
    </th>
  )
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-1.5 py-1 align-baseline ${className}`}>{children}</td>
}
