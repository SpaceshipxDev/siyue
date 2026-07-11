'use client'

import { useCallback, useRef, useState } from 'react'
import { withBase } from '@/lib/base-path'
import { BRAND } from '@/lib/brand'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

type ItemStatus = 'parsing' | 'done' | 'error'

type Item = {
  id: string
  fileName: string
  status: ItemStatus
  jobId?: string
  jobNo?: string
  customer?: string
  partsCount?: number
  error?: string
}

export function MasterUploader() {
  const router = useRouter()
  const [items, setItems] = useState<Item[]>([])
  const [drag, setDrag] = useState(false)
  const [creating, setCreating] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const update = useCallback((id: string, patch: Partial<Item>) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)))
  }, [])

  const handle = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files).filter((f) => /\.xlsx?$|\.csv$/i.test(f.name))
      if (list.length === 0) return

      const newItems: Item[] = list.map((f) => ({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        fileName: f.name,
        status: 'parsing',
      }))
      setItems((prev) => [...newItems, ...prev])

      // Open one new tab per file synchronously, inside the user-gesture
      // handler — popup blockers allow this while later async window.open()
      // calls would be blocked. Each tab loads a placeholder until we know
      // its jobId, then we navigate it to /import/[id] where the parsing
      // view auto-refreshes as Gemini fills in the data.
      const tabs = newItems.map(() => {
        try {
          const w = window.open('', '_blank')
          if (w) {
            w.document.title = '思跃 · 上传中'
            w.document.body.style.cssText =
              'margin:0;background:#fbfaf7;color:#5a5851;font-family:-apple-system,BlinkMacSystemFont,sans-serif'
            w.document.body.innerHTML =
              '<div style="padding:64px 40px;font-size:13px">📥 正在上传文件…</div>'
          }
          return w
        } catch {
          return null
        }
      })

      newItems.forEach((item, i) => {
        const file = list[i]
        const tab = tabs[i]
        const fd = new FormData()
        fd.append('file', file)
        fetch(withBase('/api/ingest'), { method: 'POST', body: fd })
          .then(async (r) => {
            const data = (await r.json()) as
              | {
                  ok: true
                  job: {
                    id: string
                    jobNo: string
                    customer: string
                    status?: string
                    components: unknown[]
                  }
                }
              | { ok: false; error: string }
            if ('ok' in data && data.ok) {
              update(item.id, {
                status: 'done',
                jobId: data.job.id,
                jobNo: data.job.jobNo,
                customer: data.job.customer,
                partsCount: data.job.components.length,
              })
              const target = `/import/${data.job.id}`
              if (tab && !tab.closed) {
                try {
                  tab.location.replace(target)
                } catch {
                  // Tab navigation failed — leave the master tab alone.
                  // User can click "审核 →" in the recent uploads list.
                }
              }
              // Popup blocked or navigation failed: do not redirect the
              // master tab. The "审核 →" link in 最近上传 is the manual escape.
              router.refresh()
            } else {
              update(item.id, {
                status: 'error',
                error: 'error' in data ? data.error : 'unknown',
              })
              if (tab && !tab.closed) tab.close()
            }
          })
          .catch((err: unknown) => {
            update(item.id, {
              status: 'error',
              error: err instanceof Error ? err.message : String(err),
            })
            if (tab && !tab.closed) tab.close()
          })
      })
    },
    [router, update],
  )

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDrag(false)
    if (e.dataTransfer.files?.length) handle(e.dataTransfer.files)
  }

  const parsing = items.filter((i) => i.status === 'parsing').length

  const createManual = async () => {
    if (creating) return
    setCreating(true)
    try {
      const r = await fetch(withBase('/api/manual-job'), { method: 'POST' })
      const data = await r.json() as { ok: boolean; jobId?: string; error?: string }
      if (!r.ok || !data.ok || !data.jobId) throw new Error(data.error ?? '新建失败')
      router.push(`/import/${data.jobId}`)
    } finally {
      setCreating(false)
    }
  }

  return (
    <section className="mb-8 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="grid grid-cols-12 gap-0">
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setDrag(true)
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          className={`col-span-5 cursor-pointer border-r border-[var(--color-border)] px-6 py-5 transition-colors ${
            drag ? 'bg-[var(--color-active-bg)]' : 'hover:bg-[var(--color-bg)]'
          }`}
        >
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={(e) => e.target.files && handle(e.target.files)}
          />
          <div className="flex items-baseline justify-between">
            <p className="label">导入工单</p>
            {parsing > 0 && (
              <span className="label text-[var(--color-warning)]">
                <span className="mono mr-1 text-[12px] font-medium">{parsing}</span>
                解析中
              </span>
            )}
          </div>
          <p className="mt-2 text-[14px] font-medium tracking-tight text-[var(--color-ink)]">
            {drag ? '松开以上传' : '拖入或点击上传 Excel'}
          </p>
          <p className="mt-1 text-[12px] text-[var(--color-ink-3)]">
            支持 .xlsx / .xls / .csv · {BRAND.code}-* 报价单 / 生产单
          </p>
          <button
            type="button"
            disabled={creating}
            onClick={(e) => { e.stopPropagation(); void createManual() }}
            className="mt-4 border border-[var(--color-border-strong)] rounded-[2px] px-3 py-1.5 text-[12px] font-medium text-[var(--color-ink)] hover:border-[var(--color-ink)] disabled:opacity-50"
          >
            {creating ? '正在新建…' : '+ 手工新建一个零件'}
          </button>
        </div>

        <div className="col-span-7 px-6 py-5">
          <p className="label mb-3">最近上传</p>
          {items.length === 0 ? (
            <p className="text-[12px] text-[var(--color-ink-4)]">
              上传后这里会显示文件状态 · 每个文件独立解析，不影响看板
            </p>
          ) : (
            <ul className="divide-y divide-[var(--color-border)] -mx-2">
              {items.slice(0, 6).map((it) => (
                <li
                  key={it.id}
                  className="flex items-baseline gap-3 px-2 py-1.5 text-[12px]"
                >
                  <StatusDot status={it.status} />
                  <span className="mono flex-1 truncate text-[var(--color-ink)]">
                    {it.fileName}
                  </span>
                  {it.status === 'parsing' && (
                    <span className="label text-[var(--color-warning)]">
                      解析中 · LLM
                    </span>
                  )}
                  {it.status === 'done' && (
                    <span className="flex items-baseline gap-2 text-[var(--color-ink-2)]">
                      <span className="mono text-[var(--color-ink)]">{it.jobNo}</span>
                      <span>{it.customer}</span>
                      <span className="label">{it.partsCount} 件</span>
                      {it.jobId ? (
                        <Link
                          href={`/import/${it.jobId}`}
                          className="label text-[var(--color-ink)] hover:underline underline-offset-4"
                        >
                          审核 →
                        </Link>
                      ) : null}
                    </span>
                  )}
                  {it.status === 'error' && (
                    <span className="label text-[var(--color-overdue)]" title={it.error}>
                      失败
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  )
}

function StatusDot({ status }: { status: ItemStatus }) {
  const color =
    status === 'parsing'
      ? 'bg-[var(--color-warning)] animate-pulse'
      : status === 'done'
        ? 'bg-[var(--color-success)]'
        : 'bg-[var(--color-overdue)]'
  return <span className={`inline-block h-1.5 w-1.5 rounded-[2px] ${color}`} />
}
