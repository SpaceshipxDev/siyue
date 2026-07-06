'use client'

import { useRef, useState } from 'react'
import { withBase } from '@/lib/base-path'

type Turn = { role: 'user' | 'assistant'; text: string }
type Sheet = { name: string; aoa: (string | number | boolean | null)[][] }
type SheetMeta = { name: string; ref: string | null; rows: number; cols: number }
type Doc = {
  fileName: string
  sizeBytes: number
  sheetNames: string[]
  sheetMeta: SheetMeta[]
  sheets: Sheet[]
}

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

export default function PlaygroundPage() {
  const [doc, setDoc] = useState<Doc | null>(null)
  const [history, setHistory] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState<'idle' | 'parsing' | 'thinking'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [showJson, setShowJson] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    setError(null)
    setBusy('parsing')
    try {
      const fd = new FormData()
      fd.append('file', f)
      const res = await fetch(withBase('/api/playground/upload'), { method: 'POST', body: fd })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? `upload ${res.status}`)
      setDoc(json)
      setHistory([])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy('idle')
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  async function send() {
    const msg = input.trim()
    if (!msg || busy !== 'idle') return
    setError(null)
    const next = [...history, { role: 'user' as const, text: msg }]
    setHistory(next)
    setInput('')
    setBusy('thinking')
    try {
      const payloadDoc = doc
        ? { fileName: doc.fileName, sheets: doc.sheets }
        : null
      const res = await fetch(withBase('/api/playground/chat'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ doc: payloadDoc, history, message: msg }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? `chat ${res.status}`)
      setHistory([...next, { role: 'assistant', text: json.text || '(empty)' }])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setHistory(next)
    } finally {
      setBusy('idle')
    }
  }

  function reset() {
    setDoc(null)
    setHistory([])
    setInput('')
    setError(null)
    setShowJson(false)
  }

  const previewJson = doc
    ? JSON.stringify(
        { fileName: doc.fileName, sheets: doc.sheets },
        null,
        2,
      )
    : ''
  const previewBytes = new Blob([previewJson]).size

  return (
    <main className="min-h-screen flex flex-col max-w-3xl mx-auto w-full px-6 py-8">
      <header className="flex items-baseline justify-between mb-6">
        <div>
          <h1 className="text-lg font-medium tracking-tight">Gemini playground</h1>
          <p className="text-xs text-[var(--color-ink-3)] mt-1">
            通过当前 ingest 流程（parseWorkbook → AoA JSON）与 gemini-3.1-flash-lite-preview 对话
          </p>
        </div>
        {(doc || history.length > 0) && (
          <button
            onClick={reset}
            className="text-xs text-[var(--color-ink-3)] hover:text-[var(--color-ink)] transition"
          >
            清空
          </button>
        )}
      </header>

      <section className="mb-4">
        {doc ? (
          <div className="rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[var(--color-ink-3)] shrink-0">📄</span>
                <span className="truncate font-medium">{doc.fileName}</span>
              </div>
              <button
                onClick={() => {
                  setDoc(null)
                  setHistory([])
                }}
                className="text-xs text-[var(--color-ink-3)] hover:text-[var(--color-overdue)] transition shrink-0"
              >
                移除
              </button>
            </div>
            <div className="mt-2 text-xs text-[var(--color-ink-3)] flex flex-wrap gap-x-3 gap-y-1">
              <span>{fmtBytes(doc.sizeBytes)}</span>
              <span>·</span>
              <span>{doc.sheetMeta.length} 个工作表</span>
              {doc.sheetMeta.map((s) => (
                <span key={s.name}>
                  · {s.name}: {s.rows}行×{s.cols}列
                </span>
              ))}
              <span>·</span>
              <span>JSON ≈ {fmtBytes(previewBytes)}</span>
            </div>
            <button
              onClick={() => setShowJson((v) => !v)}
              className="mt-2 text-xs text-[var(--color-ink-2)] underline-offset-2 hover:underline"
            >
              {showJson ? '隐藏' : '查看'} 发送给模型的 JSON
            </button>
            {showJson && (
              <pre className="mt-2 max-h-72 overflow-auto rounded-[2px] bg-[var(--color-muted-bg)] p-2 text-[11px] leading-snug font-mono">
                {previewJson}
              </pre>
            )}
          </div>
        ) : (
          <label
            className={`flex items-center justify-center rounded-[2px] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-6 text-sm text-[var(--color-ink-2)] cursor-pointer hover:bg-[var(--color-muted-bg)] transition ${
              busy === 'parsing' ? 'opacity-50 pointer-events-none' : ''
            }`}
          >
            <input
              ref={fileInput}
              type="file"
              accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              onChange={handleUpload}
              disabled={busy !== 'idle'}
            />
            {busy === 'parsing' ? '解析中…' : '点击选择 .xlsx 文件'}
          </label>
        )}
      </section>

      <section className="flex-1 flex flex-col gap-3 mb-4 min-h-[300px]">
        {history.length === 0 && !error && (
          <div className="text-center text-xs text-[var(--color-ink-3)] py-12">
            {doc ? '提一个问题开始对话（例如"这张单的总金额是多少？"）' : '先上传一个 xlsx 文件'}
          </div>
        )}
        {history.map((t, i) => (
          <div
            key={i}
            className={`rounded-[2px] px-3 py-2 text-sm whitespace-pre-wrap leading-relaxed ${
              t.role === 'user'
                ? 'bg-[var(--color-active-bg)] text-[var(--color-ink)] self-end max-w-[80%]'
                : 'bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-ink)] self-start max-w-[90%]'
            }`}
          >
            {t.text}
          </div>
        ))}
        {busy === 'thinking' && (
          <div className="self-start text-xs text-[var(--color-ink-3)] px-3 py-2">思考中…</div>
        )}
        {error && (
          <div className="self-stretch rounded-[2px] border border-[var(--color-overdue)] bg-[var(--color-overdue-soft)] text-[var(--color-overdue)] px-3 py-2 text-xs">
            {error}
          </div>
        )}
      </section>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
        className="flex gap-2 sticky bottom-0 bg-[var(--color-bg)] pt-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={doc ? '问点什么…' : '请先上传 xlsx'}
          disabled={!doc || busy !== 'idle'}
          className="flex-1 rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-ink)] disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!doc || busy !== 'idle' || !input.trim()}
          className="rounded-[2px] bg-[var(--color-ink)] text-[var(--color-bg)] px-4 py-2 text-sm disabled:opacity-30 disabled:cursor-not-allowed"
        >
          发送
        </button>
      </form>
    </main>
  )
}
