'use client'

import { useCallback, useRef, useState } from 'react'
import { withBase } from '@/lib/base-path'
import Link from 'next/link'
import { APP_TITLE } from '@/lib/brand'

type SheetPayload = {
  name: string
  ref: string | null
  rows: number
  cols: number
  aoa: (string | number | boolean | null)[][]
  records: Record<string, string | number | boolean | null>[]
}

type FilePayload = {
  fileName: string
  size: number
  sheetNames: string[]
  sheets: SheetPayload[]
}

type FileError = { fileName: string; error: string }
type Result = FilePayload | FileError

function isError(r: Result): r is FileError {
  return 'error' in r
}

type View = 'json' | 'table'

export default function BackendPage() {
  const [results, setResults] = useState<Result[]>([])
  const [busy, setBusy] = useState(false)
  const [drag, setDrag] = useState(false)
  const [activeFile, setActiveFile] = useState(0)
  const [activeSheet, setActiveSheet] = useState(0)
  const [view, setView] = useState<View>('json')
  const inputRef = useRef<HTMLInputElement>(null)

  const upload = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files).filter((f) =>
      /\.xlsx?$|\.xls$|\.csv$/i.test(f.name),
    )
    if (list.length === 0) return
    setBusy(true)
    try {
      const fd = new FormData()
      for (const f of list) fd.append('files', f)
      const res = await fetch(withBase('/api/parse-xlsx'), { method: 'POST', body: fd })
      const data = (await res.json()) as { files: Result[]; error?: string }
      if (data.files) {
        setResults(data.files)
        setActiveFile(0)
        setActiveSheet(0)
      }
    } finally {
      setBusy(false)
    }
  }, [])

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDrag(false)
    if (e.dataTransfer.files?.length) upload(e.dataTransfer.files)
  }

  const current = results[activeFile]
  const currentSheet =
    current && !isError(current) ? current.sheets[activeSheet] : null

  return (
    <div className="flex-1 flex flex-col">
      <header className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="px-4 md:px-10 py-5 flex items-baseline justify-between gap-8">
          <div className="flex items-baseline gap-6">
            <Link
              href="/"
              className="label tracking-[0.22em] text-[var(--color-ink)] hover:opacity-60"
            >
              思跃
            </Link>
            <h1 className="text-[15px] font-medium tracking-tight text-[var(--color-ink)]">
              后端工具
            </h1>
            <span className="text-[12px] text-[var(--color-ink-3)]">
              报价单 / 生产单解析
            </span>
          </div>
          <div className="flex items-baseline gap-6">
            <span className="label">XLSX → JSON</span>
          </div>
        </div>
      </header>

      <main className="w-full px-4 md:px-10 py-6 md:py-10 flex-1">
        <div className="mb-6">
          <p className="label mb-1">文件解析</p>
          <h2 className="text-[28px] font-semibold tracking-tight text-[var(--color-ink)]">
            拖入 Excel 文件
          </h2>
          <p className="mt-1 text-[13px] text-[var(--color-ink-2)]">
            支持 .xlsx / .xls / .csv · 解析为结构化 JSON · 数据仅在本地内存中处理
          </p>
        </div>

        <div
          onDragOver={(e) => {
            e.preventDefault()
            setDrag(true)
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          className={`group cursor-pointer rounded-[2px] border-2 border-dashed bg-[var(--color-surface)] px-10 py-14 text-center transition-colors ${
            drag
              ? 'border-[var(--color-ink)] bg-[var(--color-active-bg)]'
              : 'border-[var(--color-border-strong)] hover:border-[var(--color-ink-3)]'
          }`}
        >
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={(e) => e.target.files && upload(e.target.files)}
          />
          <p className="label mb-3">
            {busy ? '解析中…' : drag ? '松开以上传' : '点击选择 · 或拖入文件'}
          </p>
          <p className="text-[14px] text-[var(--color-ink-2)]">
            可同时上传多个 Excel 工作簿
          </p>
        </div>

        {results.length > 0 && (
          <section className="mt-10">
            <div className="mb-3 flex items-baseline justify-between">
              <p className="label">已解析文件</p>
              <button
                type="button"
                onClick={() => setResults([])}
                className="label hover:text-[var(--color-overdue)] cursor-pointer"
              >
                清空
              </button>
            </div>
            <div className="rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
              {/* file tabs */}
              <div className="flex flex-wrap border-b border-[var(--color-border)]">
                {results.map((r, i) => {
                  const active = i === activeFile
                  const err = isError(r)
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => {
                        setActiveFile(i)
                        setActiveSheet(0)
                      }}
                      className={`relative px-5 py-3 text-[12px] tracking-wider transition-colors ${
                        active
                          ? 'text-[var(--color-ink)] font-semibold bg-[var(--color-surface)]'
                          : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)] bg-[var(--color-bg)]'
                      } ${err ? 'text-[var(--color-overdue)]' : ''}`}
                    >
                      <span className="mono">{r.fileName}</span>
                      {!err && (
                        <span className="ml-2 text-[10px] text-[var(--color-ink-3)]">
                          {r.sheets.length} 表
                        </span>
                      )}
                      {active && (
                        <span className="absolute inset-x-0 -bottom-px h-[2px] bg-[var(--color-ink)]" />
                      )}
                    </button>
                  )
                })}
              </div>

              {current && isError(current) && (
                <div className="p-6 text-[13px] text-[var(--color-overdue)]">
                  解析失败 · {current.error}
                </div>
              )}

              {current && !isError(current) && currentSheet && (
                <>
                  {/* sheet selector + meta + view toggle */}
                  <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 border-b border-[var(--color-border)] px-5 py-3">
                    <div className="flex items-baseline gap-2">
                      <span className="label">工作表</span>
                      <select
                        value={activeSheet}
                        onChange={(e) => setActiveSheet(Number(e.target.value))}
                        className="mono text-[13px] bg-transparent text-[var(--color-ink)] cursor-pointer outline-none"
                      >
                        {current.sheets.map((s, i) => (
                          <option key={i} value={i}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <span className="label">
                      范围 ·{' '}
                      <span className="mono normal-case tracking-normal text-[var(--color-ink-2)]">
                        {currentSheet.ref ?? '空'}
                      </span>
                    </span>
                    <span className="label">
                      行 ·{' '}
                      <span className="mono normal-case tracking-normal text-[var(--color-ink-2)]">
                        {currentSheet.rows}
                      </span>
                    </span>
                    <span className="label">
                      列 ·{' '}
                      <span className="mono normal-case tracking-normal text-[var(--color-ink-2)]">
                        {currentSheet.cols}
                      </span>
                    </span>
                    <span className="label">
                      大小 ·{' '}
                      <span className="mono normal-case tracking-normal text-[var(--color-ink-2)]">
                        {(current.size / 1024).toFixed(1)} KB
                      </span>
                    </span>
                    <div className="ml-auto flex items-center gap-1 rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-bg)] p-0.5">
                      <ToggleBtn
                        active={view === 'json'}
                        onClick={() => setView('json')}
                      >
                        JSON
                      </ToggleBtn>
                      <ToggleBtn
                        active={view === 'table'}
                        onClick={() => setView('table')}
                      >
                        表格
                      </ToggleBtn>
                    </div>
                    <button
                      type="button"
                      onClick={() => copyJson(currentSheet)}
                      className="label hover:text-[var(--color-ink)] cursor-pointer"
                    >
                      复制 JSON
                    </button>
                    <button
                      type="button"
                      onClick={() => downloadJson(current.fileName, currentSheet)}
                      className="label hover:text-[var(--color-ink)] cursor-pointer"
                    >
                      下载 .json
                    </button>
                  </div>

                  {view === 'json' ? (
                    <JsonView sheet={currentSheet} />
                  ) : (
                    <TableView sheet={currentSheet} />
                  )}
                </>
              )}
            </div>
          </section>
        )}
      </main>

      <footer className="border-t border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="px-4 md:px-10 py-4 flex items-baseline justify-between text-[var(--color-ink-3)]">
          <span className="label">{APP_TITLE} · 后端 v0.1</span>
          <Link href="/" className="label hover:text-[var(--color-ink)]">
            ← 返回看板
          </Link>
        </div>
      </footer>
    </div>
  )
}

function ToggleBtn({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`label rounded-[2px] px-3 py-1 cursor-pointer transition-colors ${
        active
          ? 'bg-[var(--color-surface)] text-[var(--color-ink)] shadow-[0_0_0_1px_var(--color-border-strong)]'
          : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
      }`}
    >
      {children}
    </button>
  )
}

function JsonView({ sheet }: { sheet: SheetPayload }) {
  const text = JSON.stringify(
    { name: sheet.name, ref: sheet.ref, rows: sheet.rows, records: sheet.records, aoa: sheet.aoa },
    null,
    2,
  )
  return (
    <pre className="mono max-h-[640px] overflow-auto whitespace-pre p-5 text-[12px] leading-[1.55] text-[var(--color-ink)]">
      {text}
    </pre>
  )
}

function TableView({ sheet }: { sheet: SheetPayload }) {
  if (sheet.aoa.length === 0) {
    return (
      <div className="p-6 text-[13px] text-[var(--color-ink-3)]">空表</div>
    )
  }
  return (
    <div className="max-h-[640px] overflow-auto">
      <table className="sheet w-full text-left text-[12px]">
        <thead>
          <tr>
            <th className="px-2 py-2 label text-center w-10">#</th>
            {Array.from({ length: sheet.cols }).map((_, i) => (
              <th key={i} className="px-2 py-2 label text-center">
                {colLabel(i)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sheet.aoa.map((row, r) => (
            <tr key={r}>
              <td className="px-2 py-1.5 mono text-[10px] text-[var(--color-ink-3)] text-center">
                {r + 1}
              </td>
              {Array.from({ length: sheet.cols }).map((_, c) => {
                const v = row[c]
                return (
                  <td
                    key={c}
                    className={`px-2 py-1.5 align-top whitespace-nowrap ${
                      typeof v === 'number'
                        ? 'mono text-right text-[var(--color-ink)]'
                        : 'text-[var(--color-ink)]'
                    }`}
                  >
                    {v == null || v === '' ? (
                      <span className="text-[var(--color-ink-4)]">—</span>
                    ) : (
                      String(v)
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function colLabel(i: number): string {
  let s = ''
  let n = i
  do {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}

function copyJson(sheet: SheetPayload) {
  const text = JSON.stringify(sheet, null, 2)
  navigator.clipboard.writeText(text)
}

function downloadJson(fileName: string, sheet: SheetPayload) {
  const blob = new Blob([JSON.stringify(sheet, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${fileName.replace(/\.[^.]+$/, '')}__${sheet.name}.json`
  a.click()
  URL.revokeObjectURL(url)
}
