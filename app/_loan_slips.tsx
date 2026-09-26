'use client'

import { useCallback, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { withBase } from '@/lib/base-path'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'
import { usePasteImage } from '@/app/_paste_image'
import { proxiedStorageUrl } from '@/lib/storage-url'
import { PhotoViewer } from '@/app/_photo_viewer'
import type { LoanSlip } from '@/lib/loan-shared'

// 借支单 —— 借钱的人签了字的那张纸, 挂在这笔借款上。人事那头和财务那头是同
// 一块: 一排缩略图, 点一张铺满屏幕看清楚签名和金额; 「＋ 支单」拍照或选文件,
// 电脑上也可以直接 Ctrl+V 粘微信里的图。
//
// 钱放出去以后就只看不删 —— 那张纸是这笔钱出去的凭据。

function isImage(s: { contentType?: string; filename: string }): boolean {
  if (s.contentType?.startsWith('image/')) return true
  return /\.(png|jpe?g|webp|heic)$/i.test(s.filename)
}

/** 传一张支单到这笔借款上 —— 填申请时暂存的那几张, 提交后也走这一条。 */
export async function uploadLoanSlip(loanId: string, file: File): Promise<LoanSlip> {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('loanId', loanId)
  const res = await fetch(withBase('/api/loan-slip'), { method: 'POST', body: fd })
  const data = (await res.json()) as { ok: true; slip: LoanSlip } | { ok: false; error: string }
  if (!data.ok) throw new Error(data.error)
  return data.slip
}

export function LoanSlips({
  loanId,
  slips,
  canUpload,
  canDelete,
}: {
  loanId: string
  slips: LoanSlip[]
  canUpload: boolean
  /** 放款前才能删。 */
  canDelete: boolean
}) {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)
  const zoneRef = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  const [viewing, setViewing] = useState<number | null>(null)

  const images = slips.filter(isImage)

  const add = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return
      setBusy(true)
      try {
        for (const f of files) await uploadLoanSlip(loanId, f)
        router.refresh()
      } catch (e) {
        showToast(`传不上 · ${e instanceof Error ? e.message : '网络中断'}`, 'warning')
      } finally {
        setBusy(false)
      }
    },
    [loanId, router],
  )

  usePasteImage(zoneRef, (f) => void add([f]), canUpload)

  async function remove(slipId: string) {
    try {
      await mutate({ kind: 'deleteLoanSlip', loanId, slipId })
      router.refresh()
    } catch (e) {
      showToast(e instanceof Error ? e.message : '删不掉', 'warning')
    }
  }

  if (slips.length === 0 && !canUpload) return null

  return (
    <div ref={zoneRef} className="flex flex-wrap items-center gap-2">
      <span className="mr-1 text-[12px] text-[var(--color-ink-4)]">借支单</span>
      {slips.map((s) => (
        <span key={s.id} className="group/slip relative inline-block">
          {isImage(s) ? (
            <button
              type="button"
              onClick={() => setViewing(images.findIndex((x) => x.id === s.id))}
              title={`点开看大图 · ${s.filename}`}
              className="block h-[52px] w-[52px] overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-ink-3)]"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={proxiedStorageUrl(s.url)}
                alt={s.filename}
                className="h-full w-full object-cover"
              />
            </button>
          ) : (
            <a
              href={proxiedStorageUrl(s.url)}
              target="_blank"
              rel="noopener noreferrer"
              title={s.filename}
              className="flex h-[52px] w-[52px] items-center justify-center rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] text-[10px] text-[var(--color-ink-3)] hover:border-[var(--color-ink-3)]"
            >
              PDF
            </a>
          )}
          {canDelete && (
            <button
              type="button"
              onClick={() => void remove(s.id)}
              aria-label="删掉这张支单"
              className="absolute -right-1.5 -top-1.5 hidden h-[16px] w-[16px] items-center justify-center rounded-full border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[11px] leading-none text-[var(--color-ink-3)] hover:text-[var(--color-overdue)] group-hover/slip:flex"
            >
              ×
            </button>
          )}
        </span>
      ))}
      {canUpload && (
        <>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="image/*,application/pdf"
            className="hidden"
            onChange={(e) => {
              const fs = Array.from(e.target.files ?? [])
              e.target.value = ''
              void add(fs)
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            title="拍照或选文件（也可以 Ctrl+V 粘贴）"
            className="flex h-[52px] w-[52px] items-center justify-center rounded-[2px] border border-dashed border-[var(--color-border-strong)] text-[12px] text-[var(--color-ink-3)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)] disabled:opacity-50"
          >
            {busy ? '…' : '＋ 支单'}
          </button>
        </>
      )}
      {viewing !== null && images.length > 0 && (
        <PhotoViewer
          items={images}
          start={viewing}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  )
}
