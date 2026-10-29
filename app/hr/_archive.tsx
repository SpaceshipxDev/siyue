'use client'

import { Fragment, useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/mutate'
import { withBase } from '@/lib/base-path'
import { showToast } from '@/app/_toast'
import {
  ARCHIVE_KINDS,
  ARCHIVE_KIND_LABEL,
  LEAVE_KINDS,
  archiveFileHref,
  type ArchiveFile,
  type ArchiveKind,
  type ArchivePerson,
} from '@/lib/hr-archive-shared'

// 人事 · 档案 (于海伟 2026-10-29) —— 一个员工一份: 身份证、劳动合同、社保证
// 明、外宿/内宿、个人简历。照片点一下放大, PDF 点一下在新窗口打开。
//
//   在职 / 离职 两栏: 办了离职的挪到「离职」那一栏, 档案原样留着。
//   人事、于海伟、老板看得到, 也都能建档、传文件、点住宿、办离职 (于海伟
//   2026-10-29: 相关资料人事都可以上传, 离职人事办理); 删文件、删档案只有老板
//   和于海伟。
//
//   离职那一块: 离职办理、工作交接证明、领用工具归还交接证明三样材料, 旁边
//   提一句这个人在「工具」里还有几件没还。

type Filter = 'active' | 'left'

const inp =
  'h-9 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]'

function isImage(f: ArchiveFile): boolean {
  if (/heic/i.test(`${f.contentType ?? ''} ${f.filename}`)) return false
  return (f.contentType ?? '').startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(f.filename)
}

export function ArchiveBoard({
  people,
  roster,
  canEdit,
  canUpload,
  todayStr,
  toolsOut = {},
}: {
  /** 工具领用里还没还的件数, 按人名 —— 离职那一块提一句。 */
  toolsOut?: Record<string, number>
  people: ArchivePerson[]
  roster: string[]
  /** 删文件、删档案 —— 老板和于海伟。 */
  canEdit: boolean
  /** 建档、传文件、点住宿、办离职 —— 再加上人事。 */
  canUpload: boolean
  todayStr: string
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [filter, setFilter] = useState<Filter>('active')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const active = people.filter((p) => !p.leftAt)
  const left = people.filter((p) => p.leftAt)
  const needle = q.trim()
  const shown = (filter === 'active' ? active : left).filter((p) => !needle || p.name.includes(needle))
  const listId = 'archive-roster'

  function create() {
    if (!name.trim()) return setError('先填姓名')
    setError(null)
    start(async () => {
      try {
        const r = await mutate<{ id: string }>({ kind: 'createArchivePerson', name: name.trim() })
        setName('')
        setFilter('active')
        setOpen(r.data.id)
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : '建不了')
      }
    })
  }

  return (
    <div className="mx-auto max-w-4xl">
      {canUpload && (
        <div className="mb-6 flex flex-wrap items-center gap-2.5 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-4 md:px-5">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
            list={listId}
            placeholder="员工姓名"
            className={`${inp} w-[160px]`}
          />
          <datalist id={listId}>
            {roster.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          <button
            type="button"
            onClick={create}
            disabled={pending}
            className="h-9 shrink-0 rounded-[2px] bg-[var(--color-ink)] px-4 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-50"
          >
            ＋ 建档
          </button>
          <span className="text-[12px] text-[var(--color-ink-3)]">建好以后点开那一行传身份证、合同这些</span>
          {error && <span className="text-[12px] text-[var(--color-overdue)]">{error}</span>}
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-baseline gap-4">
        {(
          [
            ['active', `在职 ${active.length}`],
            ['left', `离职 ${left.length}`],
          ] as [Filter, string][]
        ).map(([f, label]) => (
          <button
            key={f}
            type="button"
            onClick={() => {
              setFilter(f)
              setOpen(null)
            }}
            className={`text-[13.5px] tracking-tight transition-colors ${
              filter === f
                ? 'font-semibold text-[var(--color-ink)]'
                : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
            }`}
          >
            {label}
          </button>
        ))}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="找人"
          className={`${inp} ml-auto h-8 w-[140px] bg-[var(--color-surface)]`}
        />
      </div>

      <div className="overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        {shown.length === 0 ? (
          <p className="px-5 py-12 text-center text-[13px] text-[var(--color-ink-3)]">
            {needle
              ? '没有这个人的档案'
              : filter === 'left'
                ? '还没有办过离职的'
                : canUpload
                  ? '还没有档案 —— 上面填个姓名建一份'
                  : '还没有档案'}
          </p>
        ) : (
          shown.map((p) => {
            const have = new Set(p.files.map((f) => f.kind))
            // 离职那一栏多看三样离职材料。
            const kinds = p.leftAt ? [...ARCHIVE_KINDS, ...LEAVE_KINDS] : ARCHIVE_KINDS
            return (
              <Fragment key={p.id}>
                <button
                  type="button"
                  onClick={() => setOpen(open === p.id ? null : p.id)}
                  className={`flex w-full flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-[var(--color-border)] px-4 py-3 text-left last:border-b-0 md:px-5 ${
                    open === p.id ? 'bg-[#faf8f2]' : 'hover:bg-[#faf8f2]'
                  }`}
                >
                  <span className="w-[96px] shrink-0 truncate text-[14px] font-medium tracking-tight text-[var(--color-ink)]">
                    {p.name}
                  </span>
                  <span className="w-[40px] shrink-0 text-[12px] text-[var(--color-ink-3)]">{p.lodging ?? ''}</span>
                  <span className="flex flex-1 flex-wrap gap-1.5">
                    {kinds.map((k) => (
                      <span
                        key={k}
                        className={`rounded-[2px] border px-1.5 py-0.5 text-[11.5px] ${
                          have.has(k)
                            ? 'border-[var(--color-border-strong)] text-[var(--color-ink-2)]'
                            : 'border-dashed border-[var(--color-border)] text-[var(--color-ink-4)]'
                        }`}
                      >
                        {have.has(k) ? '✓ ' : ''}
                        {ARCHIVE_KIND_LABEL[k]}
                      </span>
                    ))}
                  </span>
                  {p.leftAt && (
                    <span className="text-[12px] text-[var(--color-ink-3)]">{p.leftAt} 离职</span>
                  )}
                </button>
                {open === p.id && (
                  <PersonPanel
                    p={p}
                    canEdit={canEdit}
                    canUpload={canUpload}
                    todayStr={todayStr}
                    toolsOut={toolsOut[p.name] ?? 0}
                  />
                )}
              </Fragment>
            )
          })
        )}
      </div>

      <p className="mt-4 text-[12px] leading-relaxed text-[var(--color-ink-3)]">
        人事、于海伟、老板看得到，也都能建档、传文件、办离职；删文件、删档案只有老板和于海伟。照片点一下放大，PDF 点一下在新窗口打开。办了离职的挪到「离职」那一栏，档案原样留着。
      </p>
    </div>
  )
}

function PersonPanel({
  p,
  canEdit,
  canUpload,
  todayStr,
  toolsOut,
}: {
  p: ArchivePerson
  canEdit: boolean
  canUpload: boolean
  todayStr: string
  toolsOut: number
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [leaveDate, setLeaveDate] = useState(todayStr)
  const [armLeave, setArmLeave] = useState(false)
  const [armDelete, setArmDelete] = useState(false)

  function run(body: Record<string, unknown> & { kind: string }, okMsg?: string) {
    setError(null)
    start(async () => {
      try {
        await mutate(body)
        if (okMsg) showToast(okMsg, 'success')
        setArmLeave(false)
        setArmDelete(false)
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : '办不了')
      }
    })
  }

  return (
    <div className="border-b border-[var(--color-border)] bg-[#faf8f2] px-4 py-4 last:border-b-0 md:px-5">
      <div className="mb-3 flex flex-wrap items-center gap-3 text-[12.5px] text-[var(--color-ink-2)]">
        <span className="text-[var(--color-ink-4)]">住宿</span>
        {canUpload ? (
          <span className="inline-flex overflow-hidden rounded-[2px] border border-[var(--color-border-strong)]">
            {(['内宿', '外宿'] as const).map((v) => (
              <button
                key={v}
                type="button"
                disabled={pending}
                onClick={() => run({ kind: 'updateArchivePerson', id: p.id, lodging: p.lodging === v ? null : v })}
                className={`px-3 py-1 text-[12px] ${
                  p.lodging === v
                    ? 'bg-[var(--color-ink)] text-[var(--color-surface)]'
                    : 'bg-[var(--color-surface)] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
                }`}
              >
                {v}
              </button>
            ))}
          </span>
        ) : (
          <span>{p.lodging ?? '—'}</span>
        )}
        {p.leftAt && (
          <span className="text-[var(--color-ink-3)]">
            {p.leftAt} 办的离职{p.leftBy ? ` · ${p.leftBy}` : ''}
          </span>
        )}
      </div>

      <div className="space-y-2.5">
        {ARCHIVE_KINDS.map((k) => (
          <KindRow key={k} p={p} kind={k} canEdit={canEdit} canUpload={canUpload} />
        ))}
      </div>

      {/* 离职 —— 三样材料 + 办理离职 (人事就能办)。 */}
      <div className="mt-4 border-t border-[var(--color-border)] pt-3">
        <p className="mb-2 flex flex-wrap items-baseline gap-3">
          <span className="text-[13px] font-medium text-[var(--color-ink)]">离职</span>
          <span
            className={`text-[12px] ${toolsOut > 0 ? 'text-[var(--color-overdue)]' : 'text-[var(--color-ink-3)]'}`}
          >
            {toolsOut > 0
              ? `领用的工具还有 ${toolsOut} 件没还 —— 去「工具」那一栏做离职归还确认`
              : '领用的工具都还了'}
          </span>
        </p>
        <div className="space-y-2.5">
          {LEAVE_KINDS.map((k) => (
            <KindRow key={k} p={p} kind={k} canEdit={canEdit} canUpload={canUpload} />
          ))}
        </div>
      </div>

      {(canUpload || canEdit) && (
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-[var(--color-border)] pt-3 text-[12.5px]">
          {!canUpload ? null : p.leftAt ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => run({ kind: 'setArchiveLeft', id: p.id, leftAt: null }, '已撤销离职，回到在职')}
              className="text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
            >
              离职办错了，撤销
            </button>
          ) : armLeave ? (
            <>
              <span className="text-[var(--color-ink-2)]">离职日期</span>
              <input
                type="date"
                value={leaveDate}
                onChange={(e) => setLeaveDate(e.target.value)}
                className="mono h-8 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[12.5px] outline-none"
              />
              <button
                type="button"
                disabled={pending}
                onClick={() => run({ kind: 'setArchiveLeft', id: p.id, leftAt: leaveDate }, '已办离职，挪到「离职」那一栏')}
                className="h-8 rounded-[2px] bg-[var(--color-ink)] px-3 text-[12.5px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-50"
              >
                确认离职
              </button>
              <button type="button" onClick={() => setArmLeave(false)} className="text-[var(--color-ink-3)]">
                取消
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setArmLeave(true)}
              className="h-8 rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-[12.5px] font-medium text-[var(--color-ink-2)] hover:text-[var(--color-ink)]"
            >
              办理离职
            </button>
          )}
          {error && <span className="text-[12px] text-[var(--color-overdue)]">{error}</span>}
          {canEdit && (
          <span className="ml-auto">
            {armDelete ? (
              <span className="inline-flex gap-3">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => run({ kind: 'deleteArchivePerson', id: p.id }, '档案已删除')}
                  className="font-medium text-[var(--color-overdue)] hover:underline"
                >
                  确认删除整份档案
                </button>
                <button type="button" onClick={() => setArmDelete(false)} className="text-[var(--color-ink-3)]">
                  取消
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setArmDelete(true)}
                className="text-[11.5px] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)]"
              >
                删除这份档案
              </button>
            )}
          </span>
          )}
        </div>
      )}
    </div>
  )
}

// 一类文件一行 —— 已经传的排开 (照片缩略图点了放大, PDF 点了新窗口开), 能改
// 的人后面一个「＋ 传」。
function KindRow({
  p,
  kind,
  canEdit,
  canUpload,
}: {
  p: ArchivePerson
  kind: ArchiveKind
  canEdit: boolean
  canUpload: boolean
}) {
  const router = useRouter()
  const ref = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const files = useMemo(() => p.files.filter((f) => f.kind === kind), [p.files, kind])

  async function upload(list: File[]) {
    if (list.length === 0) return
    setBusy(true)
    try {
      for (const f of list) {
        const fd = new FormData()
        fd.append('file', f)
        fd.append('personId', p.id)
        fd.append('kind', kind)
        const res = await fetch(withBase('/api/hr-archive'), { method: 'POST', body: fd })
        const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
        if (!d.ok) throw new Error(d.error ?? '传不上')
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : '传不上', 'warning')
    } finally {
      setBusy(false)
      if (ref.current) ref.current.value = ''
      router.refresh()
    }
  }

  async function remove(f: ArchiveFile) {
    if (!confirm(`删掉「${f.filename}」？`)) return
    const res = await fetch(
      withBase(`/api/hr-archive?p=${encodeURIComponent(p.id)}&f=${encodeURIComponent(f.id)}`),
      { method: 'DELETE' },
    ).catch(() => null)
    const d = (await res?.json().catch(() => ({}))) as { ok?: boolean; error?: string } | undefined
    if (!d?.ok) showToast(d?.error ?? '删不掉', 'warning')
    router.refresh()
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="label w-[140px] shrink-0">{ARCHIVE_KIND_LABEL[kind]}</span>
      {files.length === 0 && !canUpload && <span className="text-[12px] text-[var(--color-ink-4)]">—</span>}
      {files.map((f) => {
        const href = withBase(archiveFileHref(p.id, f.id))
        return (
          <span key={f.id} className="group/af relative">
            {isImage(f) ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={href}
                alt={f.filename}
                title={`${f.filename} — 点开放大`}
                className="h-14 w-14 cursor-zoom-in rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] object-cover"
              />
            ) : (
              <a
                href={href}
                target="_blank"
                rel="noopener"
                title={f.filename}
                className="flex h-14 w-[120px] flex-col justify-center rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 hover:border-[var(--color-ink)]"
              >
                <span className="text-[11px] font-semibold text-[var(--color-overdue)]">
                  {/\.pdf$/i.test(f.filename) || f.contentType === 'application/pdf' ? 'PDF' : '文件'}
                </span>
                <span className="truncate text-[11.5px] text-[var(--color-ink-2)]">{f.filename}</span>
              </a>
            )}
            {canEdit && (
              <button
                type="button"
                onClick={() => void remove(f)}
                aria-label="删掉这一个"
                className="absolute -right-1.5 -top-1.5 hidden h-[16px] w-[16px] items-center justify-center rounded-full bg-[var(--color-ink)] text-[9px] leading-none text-[var(--color-surface)] group-hover/af:flex"
              >
                ✕
              </button>
            )}
          </span>
        )
      })}
      {canUpload && (
        <>
          <input
            ref={ref}
            type="file"
            multiple
            accept="image/*,application/pdf"
            className="hidden"
            onChange={(e) => void upload(Array.from(e.target.files ?? []))}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => ref.current?.click()}
            className="h-14 rounded-[2px] border border-dashed border-[var(--color-border-strong)] px-3 text-[12px] text-[var(--color-ink-3)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)] disabled:opacity-50"
          >
            {busy ? '上传中…' : '＋ 传'}
          </button>
        </>
      )}
    </div>
  )
}
