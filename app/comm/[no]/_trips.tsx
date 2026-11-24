'use client'

import { useState, type ReactNode } from 'react'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'
import { EditableTextArea } from '@/app/_editable'
import type { CommOrder, CommTripRow, CommTripTextField } from '@/lib/comm-order'
import { CommOrderSheet, ImageCell } from './_sheet'

// 工单页「沟通」那一栏 —— 两张表切着看 (于海伟 2026-11-24):
//   工单分析沟通确认单 —— 原来那张 (./_sheet)。
//   出差沟通确认 —— 去客户那边当面谈的, 一次出差一行, 能挂现场拍的图。加一行
//     时日期、出差人、客户按这张工单先填上, 不对点了就改。
// 不带 key: 刷新回来两张表各自换新数据, 正看着哪一张不跳回去。

type View = 'analysis' | 'trip'

export function JobCommTab({
  canWrite,
  jobNo,
  order,
  jobDue,
  today,
  me,
  customer,
}: {
  canWrite: boolean
  jobNo: string
  order?: CommOrder
  jobDue: string
  today: string
  me: string
  /** 看得到客户的才带, 看不到的空着。 */
  customer: string
}) {
  const [view, setView] = useState<View>('analysis')
  const rounds = order?.rows.length ?? 0
  const trips = order?.trips.length ?? 0
  const title = (
    <div className="flex items-baseline gap-5">
      {(
        [
          ['analysis', '工单分析沟通确认单', rounds],
          ['trip', '出差沟通确认', trips],
        ] as const
      ).map(([k, label, n]) => (
        <button
          key={k}
          type="button"
          onClick={() => setView(k)}
          className={`text-[15px] tracking-tight ${
            view === k
              ? 'font-medium text-[var(--color-ink)]'
              : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
          }`}
        >
          {label}
          {n > 0 && <span className="mono ml-1 text-[11px] text-[var(--color-ink-4)]">{n}</span>}
        </button>
      ))}
    </div>
  )
  return view === 'analysis' ? (
    <CommOrderSheet
      key={order?.updatedAt ?? jobNo}
      embedded
      title={title}
      canWrite={canWrite}
      jobNo={order?.jobNo ?? jobNo}
      initial={order?.rows ?? []}
      initialDue={order?.dueDate ?? ''}
      jobDue={jobDue}
    />
  ) : (
    <CommTripSheet
      key={order?.updatedAt ?? jobNo}
      title={title}
      canWrite={canWrite}
      jobNo={order?.jobNo ?? jobNo}
      initial={order?.trips ?? []}
      prefill={{ date: today, people: me, place: customer }}
    />
  )
}

const COLS: { field: CommTripTextField | 'images'; head: string; w: number }[] = [
  { field: 'date', head: '出差日期', w: 110 },
  { field: 'people', head: '出差人员', w: 120 },
  { field: 'place', head: '客户 / 地点', w: 150 },
  { field: 'content', head: '沟通内容', w: 260 },
  { field: 'images', head: '图片', w: 200 },
  { field: 'result', head: '客户确认结果', w: 200 },
  { field: 'contact', head: '客户对接人', w: 110 },
]

const th =
  'border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-2 text-center text-[12px] font-medium text-[var(--color-ink-2)] align-middle'
const td = 'border border-[var(--color-border)] px-2 py-1.5 align-top text-[13px] text-[var(--color-ink)]'

function CommTripSheet({
  title,
  canWrite,
  jobNo,
  initial,
  prefill,
}: {
  title: ReactNode
  canWrite: boolean
  jobNo: string
  initial: CommTripRow[]
  prefill: Partial<Record<CommTripTextField, string>>
}) {
  const [rows, setRows] = useState(initial)
  const [adding, setAdding] = useState(false)
  const apply = (sheet?: CommOrder) => setRows(sheet?.trips ?? [])
  const call = async (body: Record<string, unknown> & { kind: string }) => {
    const res = await mutate<{ sheet?: CommOrder }>({ ...body, jobNo })
    apply(res.data?.sheet)
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-3">{title}</div>
      <div className="overflow-x-auto">
        <table className="border-collapse bg-[var(--color-surface)]">
          <thead>
            <tr>
              <th className={th} style={{ width: 52 }}>序号</th>
              {COLS.map((c) => (
                <th key={c.field} className={th} style={{ width: c.w, minWidth: c.w }}>
                  {c.head}
                </th>
              ))}
              <th className={th} style={{ width: 100 }}>记录人</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id} className="group/row">
                <td className={`${td} text-center align-middle text-[12.5px] text-[var(--color-ink-2)]`}>
                  {i + 1}
                </td>
                {COLS.map((c) => {
                  const f = c.field
                  return f === 'images' ? (
                    <td key={f} className={td}>
                      <ImageCell
                        canWrite={canWrite}
                        jobNo={jobNo}
                        rowId={r.id}
                        field="trip"
                        list={r.images}
                        onSheet={apply}
                        onDelete={(imageId) => call({ kind: 'commTripDeleteImage', rowId: r.id, imageId })}
                      />
                    </td>
                  ) : (
                    <td key={f} className={td}>
                      {!canWrite ? (
                        <p className="min-h-[44px] whitespace-pre-wrap text-[13px] leading-snug">{r[f]}</p>
                      ) : (
                        <EditableTextArea
                          value={r[f]}
                          placeholder=""
                          className={`min-h-[44px] text-[13px] ${f === 'date' ? 'mono' : ''}`}
                          onSave={(text) => call({ kind: 'commTripUpdate', rowId: r.id, field: f, text })}
                        />
                      )}
                    </td>
                  )
                })}
                <td className={`${td} text-[12px] text-[var(--color-ink-3)]`}>
                  {r.by}
                  {r.at && <span className="mono block text-[11px]">{r.at.slice(5, 10)}</span>}
                </td>
                <td className="px-1 align-middle">
                  {canWrite && (
                    <button
                      type="button"
                      onClick={() => {
                        if (!confirm(`删掉第 ${i + 1} 次出差这一行？`)) return
                        call({ kind: 'commTripDelete', rowId: r.id }).catch((e) =>
                          showToast(e instanceof Error ? e.message : '删不掉', 'warning'),
                        )
                      }}
                      className="text-[11.5px] text-[var(--color-ink-4)] transition-opacity hover:text-[var(--color-overdue)] md:opacity-0 md:group-hover/row:opacity-100"
                    >
                      删
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!canWrite ? (
        rows.length === 0 && <p className="mt-4 text-[13px] text-[var(--color-ink-3)]">还没有出差沟通记录</p>
      ) : (
        <div className="mt-4 flex">
          <button
            type="button"
            disabled={adding}
            onClick={async () => {
              setAdding(true)
              try {
                await call({ kind: 'commTripAdd', init: prefill })
              } catch (e) {
                showToast(e instanceof Error ? e.message : '加不上', 'warning')
              } finally {
                setAdding(false)
              }
            }}
            className="rounded-[2px] border border-dashed border-[var(--color-border-strong)] px-5 py-2.5 text-[13px] text-[var(--color-ink-2)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)] disabled:opacity-50"
          >
            {adding ? '加一行…' : '+ 记一次出差'}
          </button>
        </div>
      )}
    </div>
  )
}
