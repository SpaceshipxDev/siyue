'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/mutate'
import { withBase } from '@/lib/base-path'
import { proxiedStorageUrl } from '@/lib/storage-url'
import { showToast } from '@/app/_toast'
import { EditableTextArea } from '@/app/_editable'
import { roundLabel } from '@/lib/comm-order-label'
import type {
  CommImage,
  CommOrder,
  CommOrderImageField,
  CommOrderRow,
  CommOrderTextField,
} from '@/lib/comm-order'
import { ImportButton } from '../_list'

// 工单分析沟通确认单 —— 照厂里那张 Excel 摆: 每次沟通一行, 每一格点了就改,
// 图片那两列点「+ 图」或者直接粘贴截图。记录人自动记 (最后改这一行的人)。
//
// 长在工单页「零件」后面那一栏里 (embedded, 于海伟 2026-10-20): 工号和交期工
// 单页头上都有了, 这里只留表、导入、导出。
// 全厂都看得到 (于海伟 2026-10-20); 只有工程、商务能改 —— 别人看到的是一张
// 只读的表, 没有导入、加行、删、传图。

type Col =
  | { kind: 'text'; field: CommOrderTextField; head: string; sub?: string; w: number }
  | { kind: 'image'; field: CommOrderImageField; head: string; w: number; text?: CommOrderTextField }

const COLS: Col[] = [
  { kind: 'text', field: 'fileName', head: '文件名/图号', w: 150 },
  { kind: 'image', field: 'images', head: '图片', w: 170 },
  { kind: 'image', field: 'reqImages', head: '文件/图纸要求（截图）', w: 210, text: 'req' },
  { kind: 'text', field: 'problem', head: '不满足与问题说明', w: 200 },
  { kind: 'text', field: 'suggestion', head: '改善建议', w: 190 },
  {
    kind: 'text',
    field: 'missing',
    head: '缺失说明',
    sub: '图档（2D.3D.丝印图.组装图）.配件，色板，适配件',
    w: 190,
  },
  { kind: 'text', field: 'result', head: '客户确认结果', w: 170 },
  { kind: 'text', field: 'contact', head: '客户对接人', w: 110 },
]

const th =
  'border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-2 text-center text-[12px] font-medium text-[var(--color-ink-2)] align-middle'
const td = 'border border-[var(--color-border)] px-2 py-1.5 align-top text-[13px] text-[var(--color-ink)]'

export function CommOrderSheet({
  jobNo,
  initial,
  initialDue,
  jobDue,
  embedded,
  canWrite = true,
}: {
  embedded?: boolean
  canWrite?: boolean
  jobNo: string
  initial: CommOrderRow[]
  /** 手填的交期 */
  initialDue: string
  /** 系统里这个工号的工单交期 —— 没手填时显示它 */
  jobDue: string
}) {
  const router = useRouter()
  const [rows, setRows] = useState(initial)
  const [due, setDue] = useState(initialDue)
  const [adding, setAdding] = useState(false)

  const apply = (sheet?: CommOrder) => {
    setRows(sheet?.rows ?? [])
    setDue(sheet?.dueDate ?? '')
  }
  const call = async (body: Record<string, unknown> & { kind: string }) => {
    const res = await mutate<{ sheet?: CommOrder }>({ ...body, jobNo })
    apply(res.data?.sheet)
  }

  const addRow = async () => {
    setAdding(true)
    try {
      await call({ kind: 'commOrderAddRow' })
    } catch (e) {
      showToast(e instanceof Error ? e.message : '加不上', 'warning')
    } finally {
      setAdding(false)
    }
  }

  // 导入 / 导出 —— 两种摆法都放在右上角。
  const tools = canWrite && (
    <span className="ml-auto flex items-center gap-3">
      <ImportButton jobNo={jobNo} onDone={() => router.refresh()} />
      {rows.length > 0 && (
        <a
          href={withBase(`/comm/${encodeURIComponent(jobNo)}/export`)}
          className="flex h-10 items-center rounded-[2px] bg-[var(--color-ink)] px-4 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85"
        >
          导出 Excel
        </a>
      )}
    </span>
  )

  return (
    <div>
      {embedded ? (
        <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-3">
          <h2 className="text-[15px] font-medium tracking-tight text-[var(--color-ink)]">
            工单分析沟通确认单
          </h2>
          {tools}
        </div>
      ) : (
        <>
        <div className="mb-6 flex flex-wrap items-center gap-x-6 gap-y-3">
          <Link href="/comm" className="text-[12px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]">
            ← 全部沟通单
          </Link>
          {tools}
        </div>

        <h2 className="text-center text-[24px] font-semibold tracking-tight text-[var(--color-ink)]">
          <span className="mono">{jobNo}</span>工单分析沟通确认单
        </h2>

        {/* 交期 —— 没手填就是系统里这张工单的交期; 改了就按改的。 */}
        <label className="mb-5 mt-2 flex items-baseline justify-center gap-2 text-[13px] text-[var(--color-ink-2)]">
          交期
          <input
            type="date"
            value={due || jobDue}
            onChange={(e) => {
              const v = e.target.value
              if (v && v < '2000-01-01') return
              if (v === (due || jobDue)) return
              const prev = due
              setDue(v)
              call({ kind: 'commOrderSetDue', dueDate: v }).catch((err) => {
                setDue(prev)
                showToast(err instanceof Error ? err.message : '改不了', 'warning')
              })
            }}
            className="mono border-b border-dashed border-[var(--color-border-strong)] bg-transparent text-[14px] text-[var(--color-ink)] outline-none hover:border-[var(--color-ink)] focus:border-[var(--color-ink)]"
          />
          {!due && jobDue && <span className="text-[11.5px] text-[var(--color-ink-4)]">按工单</span>}
        </label>
        </>
      )}

      <div className="overflow-x-auto">
        <table className={`${embedded ? '' : 'mx-auto '}border-collapse bg-[var(--color-surface)]`}>
          <thead>
            <tr>
              <th className={th} style={{ width: 84 }}>序号</th>
              {COLS.map((c) => (
                <th key={c.field} className={th} style={{ width: c.w, minWidth: c.w }}>
                  {c.head}
                  {c.kind === 'text' && c.sub && (
                    <span className="mt-1 block border-t border-[var(--color-border)] pt-1 text-[10.5px] font-normal leading-snug text-[var(--color-ink-3)]">
                      {c.sub}
                    </span>
                  )}
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
                  {roundLabel(i)}
                </td>
                {COLS.map((c) =>
                  c.kind === 'image' ? (
                    <td key={c.field} className={td}>
                      <ImageCell
                        canWrite={canWrite}
                        jobNo={jobNo}
                        rowId={r.id}
                        field={c.field}
                        list={r[c.field]}
                        onSheet={apply}
                        onDelete={(imageId) =>
                          call({ kind: 'commOrderDeleteImage', rowId: r.id, field: c.field, imageId })
                        }
                      />
                      {c.text && !canWrite && r[c.text] && (
                        <p className="mt-1 whitespace-pre-wrap text-[12.5px]">{r[c.text]}</p>
                      )}
                      {c.text && canWrite && (
                        <EditableTextArea
                          value={r[c.text]}
                          placeholder="补充说明"
                          className="mt-1 text-[12.5px] placeholder:text-[var(--color-ink-4)]"
                          onSave={(text) =>
                            call({ kind: 'commOrderUpdateRow', rowId: r.id, field: c.text, text })
                          }
                        />
                      )}
                    </td>
                  ) : (
                    <td key={c.field} className={td}>
                      {!canWrite ? (
                        <p className="min-h-[44px] whitespace-pre-wrap text-[13px] leading-snug">{r[c.field]}</p>
                      ) : (
                      <EditableTextArea
                        value={r[c.field]}
                        placeholder=""
                        className="min-h-[44px] text-[13px]"
                        onSave={(text) =>
                          call({ kind: 'commOrderUpdateRow', rowId: r.id, field: c.field, text })
                        }
                      />
                      )}
                    </td>
                  ),
                )}
                <td className={`${td} text-[12px] text-[var(--color-ink-3)]`}>
                  {r.by}
                  {r.at && <span className="mono block text-[11px]">{r.at.slice(5, 10)}</span>}
                </td>
                <td className="px-1 align-middle">
                  {canWrite && (
                  <button
                    type="button"
                    onClick={() => {
                      if (!confirm(`删掉${roundLabel(i)}这一行？`)) return
                      call({ kind: 'commOrderDeleteRow', rowId: r.id }).catch((e) =>
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
        rows.length === 0 && (
          <p className="mt-4 text-[13px] text-[var(--color-ink-3)]">还没有沟通记录</p>
        )
      ) : (
      <div className={`mt-4 flex ${embedded ? '' : 'justify-center'}`}>
        <button
          type="button"
          disabled={adding}
          onClick={addRow}
          className="rounded-[2px] border border-dashed border-[var(--color-border-strong)] px-5 py-2.5 text-[13px] text-[var(--color-ink-2)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)] disabled:opacity-50"
        >
          {adding ? '加一行…' : `+ 记${roundLabel(rows.length)}`}
        </button>
      </div>
      )}
    </div>
  )
}

// 一格图 —— 点缩略图看大图; 「+ 图」选文件, 或者点一下这一格直接粘贴截图。
function ImageCell({
  canWrite,
  jobNo,
  rowId,
  field,
  list,
  onSheet,
  onDelete,
}: {
  canWrite: boolean
  jobNo: string
  rowId: string
  field: CommOrderImageField
  list: CommImage[]
  onSheet: (s?: CommOrder) => void
  onDelete: (imageId: string) => Promise<void>
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  const upload = async (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith('image/'))
    if (imgs.length === 0) return
    setBusy(true)
    try {
      for (const f of imgs) {
        const fd = new FormData()
        fd.append('file', f, f.name || '截图.png')
        fd.append('jobNo', jobNo)
        fd.append('rowId', rowId)
        fd.append('field', field)
        const res = await fetch(withBase('/api/comm-order/photo'), { method: 'POST', body: fd })
        const d = (await res.json()) as { ok?: boolean; sheet?: CommOrder; error?: string }
        if (!d.ok) throw new Error(d.error || '传不上')
        onSheet(d.sheet)
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : '传不上', 'warning')
    } finally {
      setBusy(false)
    }
  }

  // 只看的人: 只有缩略图, 点开看大图。
  if (!canWrite)
    return (
      <div className="flex flex-wrap gap-1.5">
        {list.map((im) => (
          <a key={im.id} href={proxiedStorageUrl(im.url)} target="_blank" rel="noopener">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={proxiedStorageUrl(im.url)}
              alt={im.name}
              className="h-20 max-w-[150px] rounded-[2px] border border-[var(--color-border)] object-contain"
            />
          </a>
        ))}
      </div>
    )

  return (
    <div
      tabIndex={0}
      onPaste={(e) => {
        const files = [...e.clipboardData.files]
        if (files.length > 0) {
          e.preventDefault()
          void upload(files)
        }
      }}
      title="可以点这一格后直接粘贴截图"
      className="rounded-[2px] outline-none focus:bg-[var(--color-active-bg)]"
    >
      {list.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {list.map((im) => (
            <span key={im.id} className="group/img relative">
              <a href={proxiedStorageUrl(im.url)} target="_blank" rel="noopener">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={proxiedStorageUrl(im.url)}
                  alt={im.name}
                  className="h-20 max-w-[150px] rounded-[2px] border border-[var(--color-border)] object-contain"
                />
              </a>
              <button
                type="button"
                onClick={() => {
                  if (confirm('删掉这张图？'))
                    onDelete(im.id).catch((e) => showToast(e instanceof Error ? e.message : '删不掉', 'warning'))
                }}
                className="absolute right-0.5 top-0.5 h-5 w-5 md:hidden md:group-hover/img:block rounded-full bg-black/60 text-[11px] leading-5 text-white"
                aria-label="删掉这张图"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        ref={ref}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          void upload(files)
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => ref.current?.click()}
        className="mt-1 text-[11.5px] text-[var(--color-ink-4)] hover:text-[var(--color-ink)] disabled:opacity-50"
      >
        {busy ? '上传中…' : '+ 图'}
      </button>
    </div>
  )
}
