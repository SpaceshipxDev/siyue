'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/mutate'
import { withBase } from '@/lib/base-path'
import { showToast } from '@/app/_toast'
import {
  BALLOON_KINDS,
  MAX_SAMPLES,
  emptyBalloon,
  judge,
  limits,
  rowVerdict,
  sheetVerdict,
  type AppearanceItem,
  type Balloon,
  type BalloonKind,
  type BalloonSheet,
  type BalloonSheetPatch,
} from '@/lib/balloon'

// 气泡图 —— 上面是图纸, 红色编号气泡叠在图上; 下面是对应的检验表。
//
//   · 「自动识别」让识图把图上的尺寸、形位、粗糙度找出来, 一项一个气泡。
//   · 漏的: 点「＋加气泡」, 再在图上点一下, 就在那儿多一个。
//   · 位置不对: 按住气泡拖。点气泡 = 选中表里那一行 (反过来也一样)。
//   · 表里每一格点着就改; 实测值一填, 判定自己出来。
// 改了就存 (停手半秒后整张存一次), 不用点保存。

const SAVE_MS = 700

export function BalloonEditor({
  initial,
  canDelete,
}: {
  initial: BalloonSheet
  canDelete: boolean
}) {
  const router = useRouter()
  const [sheet, setSheet] = useState(initial)
  const [selected, setSelected] = useState<number | null>(null)
  const [adding, setAdding] = useState(false)
  const [detecting, setDetecting] = useState(false)
  const [saving, setSaving] = useState<'idle' | 'dirty' | 'saving'>('idle')
  const [pending, start] = useTransition()
  const imgBox = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef(sheet)
  const pendingPatch = useRef<BalloonSheetPatch>({})

  // 存 —— 攒半秒的改动一次发出去 (拖气泡、连着填实测值不会一下一存)。
  const flush = async () => {
    timer.current = null
    const patch = pendingPatch.current
    pendingPatch.current = {}
    if (Object.keys(patch).length === 0) return
    setSaving('saving')
    try {
      await mutate({ kind: 'updateBalloonSheet', id: sheet.id, patch })
      setSaving(timer.current ? 'dirty' : 'idle')
    } catch (e) {
      setSaving('dirty')
      showToast(`没存上 · ${e instanceof Error ? e.message : '网络中断'}`, 'warning')
    }
  }
  const edit = (patch: BalloonSheetPatch) => {
    const next = { ...latest.current, ...patch }
    latest.current = next
    setSheet(next)
    pendingPatch.current = { ...pendingPatch.current, ...patch }
    setSaving('dirty')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(flush, SAVE_MS)
  }
  // 离开页面前把没存的存掉。
  useEffect(() => {
    const onHide = () => {
      if (timer.current) {
        clearTimeout(timer.current)
        void flush()
      }
    }
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const balloons = sheet.balloons
  const setBalloons = (bs: Balloon[]) => edit({ balloons: bs })
  const patchBalloon = (n: number, p: Partial<Balloon>) =>
    setBalloons(balloons.map((b) => (b.n === n ? { ...b, ...p } : b)))
  const removeBalloon = (n: number) => {
    // 删了重新编号, 图上和报表上永远是 1、2、3… 连着的。
    setBalloons(balloons.filter((b) => b.n !== n).map((b, i) => ({ ...b, n: i + 1 })))
    setSelected(null)
  }

  // 在图上点一下加一个气泡 (「＋加气泡」开着的时候)。
  const onImageClick = (e: React.MouseEvent) => {
    if (!adding || !imgBox.current) return
    const r = imgBox.current.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width
    const y = (e.clientY - r.top) / r.height
    const n = balloons.length + 1
    setBalloons([...balloons, emptyBalloon(n, x, y, sheet.samples)])
    setSelected(n)
    setAdding(false)
  }

  // 拖气泡。
  const drag = useRef<{ n: number; moved: boolean } | null>(null)
  const onBalloonDown = (e: React.PointerEvent, n: number) => {
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = { n, moved: false }
  }
  const onBalloonMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d || !imgBox.current) return
    const r = imgBox.current.getBoundingClientRect()
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
    d.moved = true
    const next = latest.current.balloons.map((b) => (b.n === d.n ? { ...b, x, y } : b))
    latest.current = { ...latest.current, balloons: next }
    setSheet(latest.current)
  }
  const onBalloonUp = (n: number) => {
    const d = drag.current
    drag.current = null
    if (d?.moved) setBalloons(latest.current.balloons)
    else setSelected(selected === n ? null : n)
  }

  const setSamples = (k: number) => {
    const samples = Math.min(MAX_SAMPLES, Math.max(1, k))
    edit({
      samples,
      balloons: balloons.map((b) => ({
        ...b,
        measured: Array.from({ length: samples }, (_, i) => b.measured[i] ?? ''),
      })),
    })
  }

  const redetect = () => {
    if (balloons.length > 0) {
      const hasData = balloons.some((b) => b.measured.some((m) => m.trim()))
      if (
        !confirm(
          hasData
            ? '重新识别会把现在的气泡和填好的实测值整套换掉，继续？'
            : '重新识别，现在的气泡整套换掉？',
        )
      )
        return
    }
    setDetecting(true)
    fetch(withBase('/api/quality-balloon'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'detect', id: sheet.id }),
    })
      .then((r) => r.json())
      .then((j: { ok: boolean; sheet?: BalloonSheet; error?: string }) => {
        if (!j.ok || !j.sheet) throw new Error(j.error ?? '识图失败')
        latest.current = j.sheet
        setSheet(j.sheet)
        setSelected(null)
        showToast(`识别出 ${j.sheet.balloons.length} 项`, 'success')
      })
      .catch((e) => showToast(e instanceof Error ? e.message : '识图失败', 'warning'))
      .finally(() => setDetecting(false))
  }

  const del = () => {
    if (!confirm(`删掉「${sheet.title}」这张气泡图？`)) return
    start(async () => {
      try {
        await mutate({ kind: 'deleteBalloonSheet', id: sheet.id })
        router.push('/quality?v=balloon')
      } catch (e) {
        showToast(e instanceof Error ? e.message : '删不掉', 'warning')
      }
    })
  }

  const verdict = sheetVerdict(sheet)
  const field =
    'h-8 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[13px] text-[var(--color-ink)] outline-none focus:border-[var(--color-ink)]'
  const cell =
    'w-full min-w-0 bg-transparent px-1 py-1 text-[12.5px] text-[var(--color-ink)] outline-none focus:bg-[var(--color-bg)]'

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        {sheet.jobId ? (
          <Link href={`/jobs/${sheet.jobId}`} className="text-[12.5px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]">
            ← 回工单
          </Link>
        ) : (
          <Link href="/quality?v=balloon" className="text-[12.5px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]">
            ← 气泡图
          </Link>
        )}
        <span className="text-[12px] text-[var(--color-ink-4)]">
          {saving === 'saving' ? '存着…' : saving === 'dirty' ? '待存' : '已存'}
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={redetect}
            disabled={detecting}
            className="h-8 rounded-[2px] border border-[var(--color-border-strong)] px-3 text-[12.5px] text-[var(--color-ink)] hover:border-[var(--color-ink)] disabled:opacity-50"
          >
            {detecting ? '识别中…' : '自动识别'}
          </button>
          <button
            type="button"
            onClick={() => exportExcel(latest.current)}
            className="h-8 rounded-[2px] border border-[var(--color-border-strong)] px-3 text-[12.5px] text-[var(--color-ink)] hover:border-[var(--color-ink)]"
          >
            导出 Excel
          </button>
          <a
            href={withBase(`/quality/balloon/${sheet.id}/print`)}
            target="_blank"
            rel="noopener"
            onClick={() => {
              if (timer.current) {
                clearTimeout(timer.current)
                void flush()
              }
            }}
            className="inline-flex h-8 items-center rounded-[2px] bg-[var(--color-ink)] px-3 text-[12.5px] font-medium text-[var(--color-surface)] hover:opacity-85"
          >
            质检报表
          </a>
          {canDelete && (
            <button
              type="button"
              onClick={del}
              disabled={pending}
              className="h-8 px-2 text-[12px] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)]"
            >
              删除
            </button>
          )}
        </span>
      </div>

      {/* 表头信息 */}
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12.5px] text-[var(--color-ink-3)]">
        {(
          [
            ['title', '图名', 'w-[180px]'],
            ['drawingNo', '图号', 'w-[140px]'],
            ['jobNo', '工单号', 'w-[170px]'],
            ['customer', '客户', 'w-[140px]'],
            ['material', '材料', 'w-[110px]'],
            ['inspector', '检验员', 'w-[90px]'],
          ] as const
        ).map(([k, label, w]) => (
          <label key={k} className="flex items-center gap-1.5">
            {label}
            <input
              value={sheet[k]}
              onChange={(e) => edit({ [k]: e.target.value })}
              className={`${field} ${w}`}
            />
          </label>
        ))}
        <label className="flex items-center gap-1.5">
          检验日期
          <input
            type="date"
            value={sheet.inspectedAt}
            onChange={(e) => edit({ inspectedAt: e.target.value })}
            className={`mono ${field}`}
          />
        </label>
        <label className="flex items-center gap-1.5">
          抽检
          <input
            type="number"
            min={1}
            max={MAX_SAMPLES}
            value={sheet.samples}
            onChange={(e) => setSamples(Number(e.target.value) || 1)}
            className={`mono ${field} w-[56px] text-right`}
          />
          件
        </label>
      </div>

      {/* 图纸 + 气泡 */}
      <div className="mb-2 flex items-center gap-3">
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className={`h-8 rounded-[2px] px-3 text-[12.5px] ${
            adding
              ? 'bg-[var(--color-overdue)] font-medium text-white'
              : 'border border-[var(--color-border-strong)] text-[var(--color-ink)] hover:border-[var(--color-ink)]'
          }`}
        >
          {adding ? '在图上点一下放气泡 · 点这里取消' : '＋加气泡'}
        </button>
        <span className="text-[12px] text-[var(--color-ink-4)]">
          {balloons.length} 个气泡 · 按住气泡能拖 · 点气泡选中表里那一行
        </span>
      </div>
      <div className="mb-6 overflow-auto rounded-[2px] border border-[var(--color-border)] bg-white">
        <div
          ref={imgBox}
          onClick={onImageClick}
          className={`relative inline-block min-w-full ${adding ? 'cursor-crosshair' : ''}`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={withBase(sheet.imageUrl)} alt={sheet.title} className="block w-full select-none" draggable={false} />
          {balloons.map((b) => {
            const v = rowVerdict(b, sheet.samples)
            return (
              <span
                key={b.n}
                onPointerDown={(e) => onBalloonDown(e, b.n)}
                onPointerMove={onBalloonMove}
                onPointerUp={() => onBalloonUp(b.n)}
                onClick={(e) => e.stopPropagation()}
                title={b.spec || `气泡 ${b.n}`}
                style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%` }}
                className={`absolute flex h-[22px] min-w-[22px] -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none select-none items-center justify-center rounded-full border-2 px-1 text-[11px] font-bold leading-none ${
                  selected === b.n
                    ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-white'
                    : v === 'NG'
                      ? 'border-[var(--color-overdue)] bg-[var(--color-overdue)] text-white'
                      : 'border-[#e0301e] bg-white text-[#e0301e]'
                }`}
              >
                {b.n}
              </span>
            )
          })}
        </div>
      </div>

      {/* 检验表 */}
      <div className="overflow-x-auto rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full min-w-[900px] border-collapse text-left">
          <thead>
            <tr className="bg-[#f5f3ed] text-[11.5px] text-[var(--color-ink-3)]">
              <th className="w-[44px] px-2 py-2 text-center font-medium">#</th>
              <th className="w-[160px] px-2 py-2 font-medium">图上标注</th>
              <th className="w-[72px] px-2 py-2 font-medium">类型</th>
              <th className="w-[76px] px-2 py-2 font-medium">名义值</th>
              <th className="w-[64px] px-2 py-2 font-medium">上公差</th>
              <th className="w-[64px] px-2 py-2 font-medium">下公差</th>
              <th className="w-[84px] px-2 py-2 font-medium">下限~上限</th>
              {Array.from({ length: sheet.samples }, (_, i) => (
                <th key={i} className="w-[68px] px-2 py-2 font-medium">实测{i + 1}</th>
              ))}
              <th className="w-[52px] px-2 py-2 text-center font-medium">判定</th>
              <th className="w-[84px] px-2 py-2 font-medium">量具</th>
              <th className="w-[28px]" />
            </tr>
          </thead>
          <tbody>
            {balloons.length === 0 && (
              <tr>
                <td colSpan={9 + sheet.samples} className="px-4 py-10 text-center text-[13px] text-[var(--color-ink-3)]">
                  还没有气泡 —— 点上面「自动识别」，或者「＋加气泡」在图上点
                </td>
              </tr>
            )}
            {balloons.map((b) => {
              const lim = limits(b)
              const v = rowVerdict(b, sheet.samples)
              return (
                <tr
                  key={b.n}
                  onClick={() => setSelected(b.n)}
                  className={`border-t border-[var(--color-border)] ${selected === b.n ? 'bg-[var(--color-active-bg)]' : ''}`}
                >
                  <td className="px-2 py-1 text-center">
                    <span className="inline-flex h-[20px] min-w-[20px] items-center justify-center rounded-full border-2 border-[#e0301e] px-1 text-[10.5px] font-bold text-[#e0301e]">
                      {b.n}
                    </span>
                  </td>
                  <td className="px-1">
                    <input value={b.spec} onChange={(e) => patchBalloon(b.n, { spec: e.target.value })} className={cell} />
                  </td>
                  <td className="px-1">
                    <select
                      value={b.kind}
                      onChange={(e) => patchBalloon(b.n, { kind: e.target.value as BalloonKind })}
                      className={`${cell} cursor-pointer`}
                    >
                      {BALLOON_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {k}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-1">
                    <input value={b.nominal} onChange={(e) => patchBalloon(b.n, { nominal: e.target.value })} className={`mono ${cell}`} />
                  </td>
                  <td className="px-1">
                    <input value={b.tolUp} onChange={(e) => patchBalloon(b.n, { tolUp: e.target.value })} className={`mono ${cell}`} />
                  </td>
                  <td className="px-1">
                    <input value={b.tolDown} onChange={(e) => patchBalloon(b.n, { tolDown: e.target.value })} className={`mono ${cell}`} />
                  </td>
                  <td className="mono px-2 text-[12px] text-[var(--color-ink-3)]">
                    {lim.lo !== '' ? `${lim.lo} ~ ${lim.hi}` : ''}
                  </td>
                  {Array.from({ length: sheet.samples }, (_, i) => {
                    const m = b.measured[i] ?? ''
                    const j = judge(b, m)
                    return (
                      <td key={i} className="px-1">
                        <input
                          value={m}
                          onChange={(e) => {
                            const measured = Array.from({ length: sheet.samples }, (_, k) => b.measured[k] ?? '')
                            measured[i] = e.target.value
                            patchBalloon(b.n, { measured })
                          }}
                          className={`mono ${cell} ${j === 'NG' ? 'font-semibold text-[var(--color-overdue)]' : ''}`}
                        />
                      </td>
                    )
                  })}
                  <td className="px-2 text-center text-[12px] font-semibold">
                    <span className={v === 'NG' ? 'text-[var(--color-overdue)]' : v === 'OK' ? 'text-[var(--color-success)]' : ''}>
                      {v}
                    </span>
                  </td>
                  <td className="px-1">
                    <input value={b.gauge} onChange={(e) => patchBalloon(b.n, { gauge: e.target.value })} placeholder="卡尺…" className={cell} />
                  </td>
                  <td className="px-1 text-center">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        removeBalloon(b.n)
                      }}
                      title={`删掉气泡 ${b.n}`}
                      className="text-[12px] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)]"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* 外观检验 —— 图上技术要求里跟外观有关的那几条, 识图时一起读出来; 逐项
          点合格 / 不合格。漏的点「＋加一项」。 */}
      <h3 className="mb-2 mt-8 text-[14px] font-semibold text-[var(--color-ink)]">外观检验</h3>
      <div className="overflow-x-auto rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full min-w-[700px] border-collapse text-left">
          <thead>
            <tr className="bg-[#f5f3ed] text-[11.5px] text-[var(--color-ink-3)]">
              <th className="w-[44px] px-2 py-2 text-center font-medium">#</th>
              <th className="w-[140px] px-2 py-2 font-medium">检验项目</th>
              <th className="px-2 py-2 font-medium">要求</th>
              <th className="w-[128px] px-2 py-2 text-center font-medium">结果</th>
              <th className="w-[180px] px-2 py-2 font-medium">说明</th>
              <th className="w-[28px]" />
            </tr>
          </thead>
          <tbody>
            {sheet.appearance.map((a, i) => {
              const set = (p: Partial<AppearanceItem>) =>
                edit({ appearance: sheet.appearance.map((x, k) => (k === i ? { ...x, ...p } : x)) })
              return (
                <tr key={i} className="border-t border-[var(--color-border)]">
                  <td className="px-2 text-center text-[12px] text-[var(--color-ink-3)]">{i + 1}</td>
                  <td className="px-1">
                    <input value={a.item} onChange={(e) => set({ item: e.target.value })} className={cell} />
                  </td>
                  <td className="px-1">
                    <input value={a.req} onChange={(e) => set({ req: e.target.value })} className={cell} />
                  </td>
                  <td className="px-1 text-center">
                    <span className="inline-flex overflow-hidden rounded-[2px] border border-[var(--color-border)]">
                      {(['OK', 'NG'] as const).map((r) => (
                        <button
                          key={r}
                          type="button"
                          onClick={() => set({ result: a.result === r ? '' : r })}
                          className={`px-2.5 py-1 text-[12px] ${
                            a.result === r
                              ? r === 'OK'
                                ? 'bg-[var(--color-success)] text-white'
                                : 'bg-[var(--color-overdue)] text-white'
                              : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
                          }`}
                        >
                          {r === 'OK' ? '合格' : '不合格'}
                        </button>
                      ))}
                    </span>
                  </td>
                  <td className="px-1">
                    <input value={a.note} onChange={(e) => set({ note: e.target.value })} placeholder="不合格写一句" className={cell} />
                  </td>
                  <td className="px-1 text-center">
                    <button
                      type="button"
                      onClick={() => edit({ appearance: sheet.appearance.filter((_, k) => k !== i) })}
                      title="删掉这一项"
                      className="text-[12px] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)]"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <button
          type="button"
          onClick={() => edit({ appearance: [...sheet.appearance, { item: '', req: '', result: '', note: '' }] })}
          className="w-full border-t border-[var(--color-border)] px-3 py-2 text-left text-[12.5px] text-[var(--color-ink-3)] hover:bg-[#faf8f2] hover:text-[var(--color-ink)]"
        >
          ＋加一项
        </button>
      </div>

      <div className="mt-4 flex flex-wrap items-start gap-6">
        <label className="flex min-w-[300px] flex-1 flex-col gap-1 text-[12.5px] text-[var(--color-ink-3)]">
          备注
          <textarea
            value={sheet.note}
            onChange={(e) => edit({ note: e.target.value })}
            rows={2}
            className="rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-[13px] text-[var(--color-ink)] outline-none focus:border-[var(--color-ink)]"
          />
        </label>
        <p className="pt-5 text-[14px]">
          结论{' '}
          <span
            className={`ml-1 font-semibold ${
              verdict === '不合格'
                ? 'text-[var(--color-overdue)]'
                : verdict === '合格'
                  ? 'text-[var(--color-success)]'
                  : 'text-[var(--color-ink-4)]'
            }`}
          >
            {verdict || '实测值填完自动出'}
          </span>
        </p>
      </div>
      <p className="mt-3 text-[12px] text-[var(--color-ink-4)]">
        判定：尺寸、角度落在下限～上限之间为 OK；形位公差、粗糙度不超过公差值为 OK；实测格里也可以直接写 OK / NG。一件不合格整行 NG；尺寸或外观有一行 NG，整张不合格。自动识别的结果请对着图核一遍。
      </p>
    </div>
  )
}

// 导出 Excel —— 跟报表同一张表, 一行一个气泡。
async function exportExcel(s: BalloonSheet) {
  const XLSX = await import('xlsx')
  const head = [
    '序号',
    '图上标注',
    '类型',
    '名义值',
    '上公差',
    '下公差',
    '下限',
    '上限',
    ...Array.from({ length: s.samples }, (_, i) => `实测${i + 1}`),
    '判定',
    '量具',
  ]
  const body = s.balloons.map((b) => {
    const lim = limits(b)
    return [
      b.n,
      b.spec,
      b.kind,
      b.nominal,
      b.tolUp,
      b.tolDown,
      lim.lo,
      lim.hi,
      ...Array.from({ length: s.samples }, (_, i) => b.measured[i] ?? ''),
      rowVerdict(b, s.samples),
      b.gauge,
    ]
  })
  const info = [
    ['质检报表'],
    ['图名', s.title, '图号', s.drawingNo, '工单号', s.jobNo],
    ['客户', s.customer, '材料', s.material, '检验员', s.inspector, '检验日期', s.inspectedAt],
    ['结论', sheetVerdict(s), '备注', s.note],
    [],
  ]
  const look = s.appearance.length
    ? [[], ['外观检验'], ['序号', '检验项目', '要求', '结果', '说明'], ...s.appearance.map((a, i) => [i + 1, a.item, a.req, a.result === 'OK' ? '合格' : a.result === 'NG' ? '不合格' : '', a.note])]
    : []
  const ws = XLSX.utils.aoa_to_sheet([...info, head, ...body, ...look])
  ws['!cols'] = head.map((h) => (h === '图上标注' ? { wch: 22 } : { wch: 10 }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '质检报表')
  XLSX.writeFile(wb, `质检报表_${s.title || s.id}.xlsx`)
}
