'use client'

import Link from 'next/link'
import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { deleteJobAction } from './actions'
import { mutate } from '@/lib/mutate'
import type { JobStatus } from '@/lib/data'

// 1.5s matches the typical Gemini Flash Lite latency for a small xlsx —
// short enough that the redirect to /draft feels instant.
const POLL_INTERVAL_MS = 1_500
// After this many seconds without a status flip, we stop polling and surface
// the recovery UI (retry / manual fill). Long enough that a normal big-sheet
// extraction completes without bothering the user; short enough that a truly
// stuck job doesn't trap them on this page.
const TIMEOUT_SECONDS = 45

export function ParsingPoller({
  jobId,
  sourceFile,
  failed,
  error,
  conflict,
  hasSourceFile,
}: {
  jobId: string
  sourceFile?: string
  failed: boolean
  error?: string
  // Set only when failed === true and parse_error encoded a 工号 collision.
  // Renders the dedicated duplicate panel instead of the generic failure UI.
  conflict?: { id: string; jobNo: string; customer: string; status: JobStatus } | null
  hasSourceFile: boolean
}) {
  const router = useRouter()
  const [elapsed, setElapsed] = useState(0)
  const [retrying, startRetry] = useTransition()
  const [manualLoading, startManual] = useTransition()
  const [actionError, setActionError] = useState<string | null>(null)

  const stuck = !failed && elapsed >= TIMEOUT_SECONDS

  // Poll a tiny JSON status endpoint instead of router.refresh()-ing the whole
  // RSC tree every 1.5s. Mainland users hit the HK VM across the GFW; a full
  // RSC refresh is a fat HTTP/2 stream that often gets cut mid-flight and
  // surfaces as the "This page couldn't load" error overlay. The JSON payload
  // here is ~50 bytes and rides over a fresh request, so a single dropped poll
  // is a no-op — the next tick recovers. We only do router.refresh() ONCE,
  // when the status actually flips, to re-render the page into its next phase.
  useEffect(() => {
    if (failed) return
    if (stuck) return
    let cancelled = false
    const tick = window.setInterval(() => setElapsed((s) => s + 1), 1_000)
    const poll = window.setInterval(async () => {
      try {
        const r = await fetch(`/api/job-status/${jobId}`, {
          cache: 'no-store',
        })
        if (!r.ok) return
        const data = (await r.json().catch(() => null)) as
          | { ok?: boolean; status?: string }
          | null
        if (!data?.ok || !data.status) return
        if (cancelled) return
        if (data.status !== 'parsing') {
          // Status flipped to ready / draft / failed. One refresh hands off
          // to the server-rendered next phase (review form or failure UI).
          router.refresh()
        }
      } catch {
        // Network blip — swallow and try again next tick.
      }
    }, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(poll)
      window.clearInterval(tick)
    }
  }, [failed, stuck, router, jobId])

  // After a retry we reset the timer and fall back into the polling branch
  // above. The job's status is flipped server-side to 'parsing' before the
  // POST resolves, so router.refresh() lands on the live spinner state.
  function handleRetry() {
    setActionError(null)
    startRetry(async () => {
      try {
        const r = await fetch('/api/retry-parse', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jobId }),
        })
        const data = (await r.json().catch(() => ({}))) as {
          ok?: boolean
          error?: string
        }
        if (!r.ok || !data.ok) {
          setActionError(data.error ?? '重试失败')
          return
        }
        setElapsed(0)
        router.refresh()
      } catch (err) {
        setActionError(err instanceof Error ? err.message : '重试失败')
      }
    })
  }

  function handleManual() {
    setActionError(null)
    startManual(async () => {
      try {
        await mutate({ kind: 'manualFillJob', jobId })
        // /import/[id] is force-dynamic — refresh re-renders as the draft
        // editor (status flipped to 'draft'). The fetched RSC is moderate
        // (single import page, not the master board) and this is a once-
        // per-stuck-import recovery action, so the GFW exposure is small.
        router.refresh()
      } catch (err) {
        setActionError(err instanceof Error ? err.message : '切换失败')
      }
    })
  }

  if (failed && conflict) {
    return (
      <DuplicatePanel
        jobId={jobId}
        sourceFile={sourceFile}
        conflict={conflict}
      />
    )
  }

  if (failed) {
    return (
      <FailedPanel
        error={error}
        sourceFile={sourceFile}
        hasSourceFile={hasSourceFile}
        retrying={retrying}
        manualLoading={manualLoading}
        actionError={actionError}
        onRetry={handleRetry}
        onManual={handleManual}
      />
    )
  }

  if (stuck) {
    return (
      <StuckPanel
        sourceFile={sourceFile}
        hasSourceFile={hasSourceFile}
        retrying={retrying}
        manualLoading={manualLoading}
        actionError={actionError}
        onRetry={handleRetry}
        onManual={handleManual}
      />
    )
  }

  return <ParsingPanel jobId={jobId} sourceFile={sourceFile} elapsed={elapsed} />
}

function ParsingPanel({
  jobId,
  sourceFile,
  elapsed,
}: {
  jobId: string
  sourceFile?: string
  elapsed: number
}) {
  return (
    <section className="rounded-[2px] border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-8 py-12">
      <div className="flex items-center gap-3 mb-4">
        <span className="inline-block h-2 w-2 rounded-[2px] bg-[var(--color-warning)] animate-pulse" />
        <p className="label text-[var(--color-warning)]">AI 解析中</p>
        <span className="ml-auto label text-[var(--color-ink-3)] mono">
          {elapsed}s / {TIMEOUT_SECONDS}s
        </span>
      </div>
      <h2 className="text-[22px] font-semibold tracking-tight text-[var(--color-ink)] mb-2">
        正在抽取工单及零件清单
      </h2>
      <p className="text-[13px] text-[var(--color-ink-2)] mb-8 leading-relaxed">
        Gemini 3.1 Flash Lite 正在读取
        {sourceFile ? (
          <span className="mono mx-1 text-[var(--color-ink)]">{sourceFile}</span>
        ) : (
          ' 上传的文件 '
        )}
        。通常需要 2-6 秒。完成后本页会自动刷新为可编辑视图，您可以核对内容并为每个零件配图。
      </p>
      <ul className="text-[12px] text-[var(--color-ink-3)] space-y-1.5 leading-relaxed">
        <li>· 抽取工号、客户、产品、交期、金额</li>
        <li>· 拆分零件名称、数量、材料、表面处理</li>
        <li>· 跳过表头、合计、付款方式等说明行</li>
      </ul>
      <p className="label text-[var(--color-ink-3)] mt-8">
        工单编号 · <span className="mono">{jobId}</span>
      </p>
    </section>
  )
}

function StuckPanel({
  sourceFile,
  hasSourceFile,
  retrying,
  manualLoading,
  actionError,
  onRetry,
  onManual,
}: {
  sourceFile?: string
  hasSourceFile: boolean
  retrying: boolean
  manualLoading: boolean
  actionError: string | null
  onRetry: () => void
  onManual: () => void
}) {
  return (
    <section className="rounded-[2px] border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-8 py-10">
      <p className="label text-[var(--color-warning)] mb-3">解析未完成</p>
      <h2 className="text-[20px] font-semibold tracking-tight text-[var(--color-ink)] mb-3">
        AI 解析超过 {TIMEOUT_SECONDS} 秒仍未返回
      </h2>
      <p className="text-[13px] text-[var(--color-ink-2)] mb-6 leading-relaxed">
        通常 2-6 秒就能完成。这份文件可能太大、格式异常，或网络/模型暂时不可用。
        {sourceFile ? (
          <>
            源文件 <span className="mono mx-0.5 text-[var(--color-ink)]">{sourceFile}</span>。
          </>
        ) : null}
      </p>
      <RecoveryActions
        hasSourceFile={hasSourceFile}
        retrying={retrying}
        manualLoading={manualLoading}
        onRetry={onRetry}
        onManual={onManual}
      />
      {actionError ? (
        <p className="mt-4 text-[12px] text-[var(--color-overdue)]">{actionError}</p>
      ) : null}
    </section>
  )
}

function FailedPanel({
  error,
  sourceFile,
  hasSourceFile,
  retrying,
  manualLoading,
  actionError,
  onRetry,
  onManual,
}: {
  error?: string
  sourceFile?: string
  hasSourceFile: boolean
  retrying: boolean
  manualLoading: boolean
  actionError: string | null
  onRetry: () => void
  onManual: () => void
}) {
  return (
    <section className="rounded-[2px] border border-[var(--color-overdue)] bg-[var(--color-overdue-soft)] px-8 py-10">
      <p className="label text-[var(--color-overdue)] mb-3">解析失败</p>
      <h2 className="text-[20px] font-semibold tracking-tight text-[var(--color-ink)] mb-3">
        AI 未能提取这份文件
      </h2>
      <p className="text-[13px] text-[var(--color-ink-2)] mb-6 leading-relaxed">
        请检查源文件格式
        {sourceFile ? (
          <>
            （<span className="mono text-[var(--color-ink)]">{sourceFile}</span>）
          </>
        ) : null}
        ，或重试一次；如果反复失败，可改用手动填写。
      </p>
      <RecoveryActions
        hasSourceFile={hasSourceFile}
        retrying={retrying}
        manualLoading={manualLoading}
        onRetry={onRetry}
        onManual={onManual}
      />
      {actionError ? (
        <p className="mt-4 text-[12px] text-[var(--color-overdue)]">{actionError}</p>
      ) : null}
      {error ? (
        <pre className="mono text-[11px] text-[var(--color-ink-3)] whitespace-pre-wrap border-t border-[var(--color-overdue)] pt-4 mt-6">
          {error}
        </pre>
      ) : null}
    </section>
  )
}

function DuplicatePanel({
  jobId,
  sourceFile,
  conflict,
}: {
  jobId: string
  sourceFile?: string
  conflict: { id: string; jobNo: string; customer: string; status: JobStatus }
}) {
  const router = useRouter()
  const [discarding, startDiscard] = useTransition()
  const [actionError, setActionError] = useState<string | null>(null)

  const handleDiscard = () => {
    setActionError(null)
    startDiscard(async () => {
      try {
        await deleteJobAction(jobId)
        router.push('/')
      } catch (err) {
        setActionError(err instanceof Error ? err.message : '删除失败')
      }
    })
  }

  return (
    <section className="rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-8 py-10">
      <p className="label text-[var(--color-ink-3)] mb-3">导入已暂停 · 工号冲突</p>
      <h2 className="text-[20px] font-semibold tracking-tight text-[var(--color-ink)] mb-2">
        工号 <span className="mono">{conflict.jobNo}</span>{' '}
        {conflict.status === 'draft' ? '已有未确认草稿' : '已存在'}
      </h2>
      <p className="text-[13px] text-[var(--color-ink-2)] leading-relaxed">
        {conflict.status === 'draft'
          ? '之前导入过这个工号但还没确认（仍是草稿，未进入看板）。'
          : '系统中已有一份相同工号的工单。'}
        {sourceFile ? (
          <>
            {' '}本次上传的源文件
            <span className="mono mx-1 text-[var(--color-ink)]">{sourceFile}</span>
            未导入，避免覆盖原工单。
          </>
        ) : null}
      </p>

      <dl className="mt-7 grid grid-cols-[68px_1fr] gap-y-2.5 gap-x-4 text-[13px] border-t border-[var(--color-border)] pt-6">
        <dt className="label text-[var(--color-ink-3)] pt-0.5">工号</dt>
        <dd className="mono text-[var(--color-ink)]">{conflict.jobNo}</dd>
        {conflict.customer ? (
          <>
            <dt className="label text-[var(--color-ink-3)] pt-0.5">客户</dt>
            <dd className="text-[var(--color-ink)] truncate">{conflict.customer}</dd>
          </>
        ) : null}
      </dl>

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <Link
          href={
            conflict.status === 'draft'
              ? `/import/${conflict.id}`
              : `/jobs/${conflict.id}`
          }
          className="inline-flex items-center gap-2 rounded-[2px] border border-[var(--color-ink)] bg-[var(--color-ink)] px-4 py-2 text-[13px] font-medium text-[var(--color-bg)] transition hover:brightness-110"
        >
          {conflict.status === 'draft' ? '打开草稿继续 →' : '打开已存在工单 →'}
        </Link>
        <button
          type="button"
          onClick={handleDiscard}
          disabled={discarding}
          className="inline-flex items-center gap-2 rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-4 py-2 text-[13px] font-medium text-[var(--color-ink-2)] transition hover:text-[var(--color-overdue)] hover:border-[var(--color-overdue)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {discarding ? '丢弃中…' : '丢弃此次上传'}
        </button>
        <span className="label text-[var(--color-ink-3)]">
          如需以新工号导入，请先在原工单中改号
        </span>
      </div>

      {actionError ? (
        <p className="mt-4 text-[12px] text-[var(--color-overdue)]">{actionError}</p>
      ) : null}
    </section>
  )
}

function RecoveryActions({
  hasSourceFile,
  retrying,
  manualLoading,
  onRetry,
  onManual,
}: {
  hasSourceFile: boolean
  retrying: boolean
  manualLoading: boolean
  onRetry: () => void
  onManual: () => void
}) {
  const busy = retrying || manualLoading
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={onRetry}
        disabled={busy || !hasSourceFile}
        title={hasSourceFile ? undefined : '没有源文件可重试'}
        className="inline-flex items-center gap-2 rounded-[2px] border border-[var(--color-ink)] bg-[var(--color-ink)] px-4 py-2 text-[13px] font-medium text-[var(--color-bg)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {retrying ? '重试中…' : '重试解析'}
      </button>
      <button
        type="button"
        onClick={onManual}
        disabled={busy}
        className="inline-flex items-center gap-2 rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-4 py-2 text-[13px] font-medium text-[var(--color-ink)] transition hover:bg-[var(--color-active-bg)] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {manualLoading ? '切换中…' : '手动填写'}
      </button>
      <span className="label text-[var(--color-ink-3)]">
        重试会再次调用 AI · 手动填写会跳过解析直接进入草稿
      </span>
    </div>
  )
}
