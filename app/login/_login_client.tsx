'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { AppUser } from '@/lib/db'
import { loginAction, loginAdminAction, loginOpenAction } from './actions'

const PIN_LENGTH = 4

type Mode = 'login' | 'admin'

type View =
  | { kind: 'grid' }
  | { kind: 'admin-pick' }
  | { kind: 'keypad'; user: AppUser; mode: Mode }

export function LoginClient({
  users,
  boss,
  admins,
  open = false,
}: {
  users: AppUser[]
  boss: AppUser
  // Accounts with 老板-level authority (bootstrap 老板 + promoted owners).
  // With more than one, 管理员工 asks which admin is signing in; with just
  // the boss it jumps straight to his keypad (the original behaviour).
  admins: AppUser[]
  // OPEN_LOGIN=1 pilot mode: tapping a name IS the login. The server action
  // re-checks the env var, so this prop is display-flow only.
  open?: boolean
}) {
  const [view, setView] = useState<View>({ kind: 'grid' })
  const [pendingId, setPendingId] = useState<string | undefined>()
  const [isPending, startTransition] = useTransition()
  const router = useRouter()

  function pick(u: AppUser) {
    if (!open) {
      setView({ kind: 'keypad', user: u, mode: 'login' })
      return
    }
    if (isPending) return
    setPendingId(u.id)
    startTransition(async () => {
      const res = await loginOpenAction(u.id)
      if (res.ok) {
        router.replace(res.redirectTo)
        router.refresh()
      } else {
        // Env flag off on the server (or user vanished) — fall back to PIN.
        setPendingId(undefined)
        setView({ kind: 'keypad', user: u, mode: 'login' })
      }
    })
  }

  if (view.kind === 'grid') {
    return (
      <UserGrid
        users={users}
        bossId={boss.id}
        open={open}
        pendingId={isPending ? pendingId : undefined}
        onPick={pick}
        onManage={() =>
          admins.length > 1
            ? setView({ kind: 'admin-pick' })
            : setView({ kind: 'keypad', user: boss, mode: 'admin' })
        }
      />
    )
  }

  if (view.kind === 'admin-pick') {
    return (
      <AdminPick
        admins={admins}
        bossId={boss.id}
        onPick={(u) => setView({ kind: 'keypad', user: u, mode: 'admin' })}
        onBack={() => setView({ kind: 'grid' })}
      />
    )
  }
  // Key on the user id + mode so all keypad state resets cleanly when the
  // operator backs out and picks a different tile or switches modes.
  return (
    <KeypadShell
      key={`${view.user.id}-${view.mode}`}
      user={view.user}
      mode={view.mode}
      isBoss={view.user.id === boss.id}
      onBack={() => setView({ kind: 'grid' })}
    />
  )
}

function KeypadShell({
  user,
  mode,
  isBoss,
  onBack,
}: {
  user: AppUser
  mode: Mode
  isBoss: boolean
  onBack: () => void
}) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [shake, setShake] = useState(false)
  const [isPending, startTransition] = useTransition()
  const router = useRouter()

  function trySubmit(value: string) {
    startTransition(async () => {
      const action = mode === 'admin' ? loginAdminAction : loginAction
      const res = await action(user.id, value)
      if (res.ok) {
        router.replace(res.redirectTo)
        router.refresh()
      } else {
        setError(res.error)
        setShake(true)
        setPin('')
        setTimeout(() => setShake(false), 400)
      }
    })
  }

  function digit(d: string) {
    if (isPending) return
    if (pin.length >= PIN_LENGTH) return
    setError(null)
    const next = pin + d
    setPin(next)
    if (next.length === PIN_LENGTH) trySubmit(next)
  }

  function backspace() {
    if (isPending) return
    setPin(pin.slice(0, -1))
    setError(null)
  }

  return (
    <Keypad
      user={user}
      mode={mode}
      isBoss={isBoss}
      pin={pin}
      error={error}
      shake={shake}
      pending={isPending}
      onDigit={digit}
      onBackspace={backspace}
      onBack={onBack}
    />
  )
}

function AdminPick({
  admins,
  bossId,
  onPick,
  onBack,
}: {
  admins: AppUser[]
  bossId: string
  onPick: (u: AppUser) => void
  onBack: () => void
}) {
  return (
    <div className="min-h-dvh flex flex-col items-center bg-[var(--color-bg)]">
      <header className="w-full border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="mx-auto max-w-[1500px] px-4 md:px-10 py-5 flex items-center justify-between">
          <button
            onClick={onBack}
            className="label text-[var(--color-ink-2)] hover:text-[var(--color-ink)]"
          >
            ← 返回
          </button>
          <span className="label tracking-[0.22em] text-[var(--color-ink)]">
            思跃 · 管理员工
          </span>
          <span style={{ width: 60 }} />
        </div>
      </header>
      <main className="w-full max-w-[1100px] px-4 md:px-10 py-10 md:py-16 flex-1">
        <h1 className="text-[28px] font-semibold tracking-tight text-[var(--color-ink)] mb-1">
          谁在管理？
        </h1>
        <p className="text-[13px] text-[var(--color-ink-2)] mb-8">
          点击你的姓名，然后输入 4 位 PIN
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {admins.map((u) => (
            <UserTile key={u.id} user={u} isBoss={u.id === bossId} onPick={onPick} />
          ))}
        </div>
      </main>
    </div>
  )
}

function UserGrid({
  users,
  bossId,
  open,
  pendingId,
  onPick,
  onManage,
}: {
  users: AppUser[]
  bossId: string
  open: boolean
  pendingId?: string
  onPick: (u: AppUser) => void
  onManage: () => void
}) {
  return (
    <div className="min-h-dvh flex flex-col items-center bg-[var(--color-bg)]">
      <header className="w-full border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="mx-auto max-w-[1500px] px-4 md:px-10 py-5 flex items-center justify-between gap-4">
          <div className="flex items-baseline gap-4">
            <span className="label tracking-[0.22em] text-[var(--color-ink)]">思跃</span>
            <span className="text-[14px] text-[var(--color-ink-2)]">登录</span>
          </div>
          <button
            type="button"
            onClick={onManage}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-[2px] border border-[var(--color-border-strong)] bg-transparent text-[13px] tracking-wider text-[var(--color-ink-2)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)] hover:bg-[var(--color-surface)] transition-colors"
            aria-label="管理员工"
          >
            <KeyIcon />
            <span>管理员工</span>
          </button>
        </div>
      </header>
      <main className="w-full max-w-[1100px] px-4 md:px-10 py-10 md:py-16 flex-1">
        <h1 className="text-[28px] font-semibold tracking-tight text-[var(--color-ink)] mb-1">
          {open ? '点你的名字，直接进入' : '请选择身份'}
        </h1>
        <p className="text-[13px] text-[var(--color-ink-2)] mb-8">
          {open ? '不用密码。' : '点击你的姓名，然后输入 4 位 PIN'}
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {users.map((u) => (
            <UserTile
              key={u.id}
              user={u}
              isBoss={u.id === bossId}
              pending={pendingId === u.id}
              onPick={onPick}
            />
          ))}
        </div>
      </main>
    </div>
  )
}

function UserTile({
  user,
  isBoss,
  pending = false,
  onPick,
}: {
  user: AppUser
  isBoss: boolean
  pending?: boolean
  onPick: (u: AppUser) => void
}) {
  const subtitle = isBoss
    ? '老板'
    : user.role === 'commerce'
      ? '商务'
      : `生产 · ${user.defaultStage ?? ''}`
  return (
    <button
      type="button"
      onClick={() => onPick(user)}
      disabled={pending}
      className={`w-full flex flex-col items-start gap-1 rounded-[2px] border bg-[var(--color-surface)] px-5 py-5 text-left transition-colors ${
        isBoss
          ? 'border-[var(--color-ink)] hover:opacity-80'
          : 'border-[var(--color-border)] hover:border-[var(--color-ink)]'
      } ${pending ? 'opacity-60' : ''}`}
    >
      <span className="text-[18px] font-semibold tracking-tight text-[var(--color-ink)]">
        {pending ? '正在进入…' : user.name}
      </span>
      <span
        className={`label ${isBoss ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-3)]'}`}
      >
        {subtitle}
      </span>
    </button>
  )
}

function Keypad({
  user,
  mode,
  isBoss,
  pin,
  error,
  shake,
  pending,
  onDigit,
  onBackspace,
  onBack,
}: {
  user: AppUser
  mode: Mode
  isBoss: boolean
  pin: string
  error: string | null
  shake: boolean
  pending: boolean
  onDigit: (d: string) => void
  onBackspace: () => void
  onBack: () => void
}) {
  const isAdmin = mode === 'admin'
  return (
    <div className="min-h-dvh flex flex-col items-center bg-[var(--color-bg)]">
      <header className="w-full border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="mx-auto max-w-[1500px] px-4 md:px-10 py-5 flex items-center justify-between">
          <button
            onClick={onBack}
            className="label text-[var(--color-ink-2)] hover:text-[var(--color-ink)]"
          >
            ← 返回
          </button>
          <span className="label tracking-[0.22em] text-[var(--color-ink)]">
            {isAdmin ? '思跃 · 管理员工' : '思跃'}
          </span>
          <span style={{ width: 60 }} />
        </div>
      </header>
      <main className="w-full max-w-[420px] px-6 py-12 md:py-20 flex-1 flex flex-col items-center">
        <h1 className="text-[28px] font-semibold tracking-tight text-[var(--color-ink)] mb-1">
          {user.name}
        </h1>
        <p className="label text-[var(--color-ink-3)] mb-10">
          {isBoss
            ? '老板'
            : user.role === 'commerce'
              ? '商务'
              : `生产 · ${user.defaultStage ?? ''}`}
        </p>

        <div
          className={`flex items-center gap-4 mb-8 transition-transform ${shake ? 'animate-pulse-shake' : ''}`}
          style={shake ? { animation: 'pin-shake 0.4s' } : undefined}
        >
          {Array.from({ length: PIN_LENGTH }).map((_, i) => {
            const filled = i < pin.length
            return (
              <span
                key={i}
                className={`block h-4 w-4 rounded-[2px] border-2 ${
                  filled
                    ? 'border-[var(--color-ink)] bg-[var(--color-ink)]'
                    : 'border-[var(--color-border-strong)] bg-transparent'
                }`}
              />
            )
          })}
        </div>

        <div className="h-5 mb-6">
          {error ? (
            <p className="text-[12px] text-[var(--color-overdue)]">{error}</p>
          ) : pending ? (
            <p className="label text-[var(--color-ink-3)]">验证中…</p>
          ) : (
            <p className="label text-[var(--color-ink-3)]">
              {isBoss ? '输入老板 PIN' : '输入 PIN'}
            </p>
          )}
        </div>

        <div className="grid grid-cols-3 gap-3 w-full max-w-[300px]">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
            <KeyButton key={n} onClick={() => onDigit(String(n))} disabled={pending}>
              {n}
            </KeyButton>
          ))}
          <span />
          <KeyButton onClick={() => onDigit('0')} disabled={pending}>
            0
          </KeyButton>
          <KeyButton onClick={onBackspace} disabled={pending} ghost>
            ⌫
          </KeyButton>
        </div>
      </main>

      <style jsx global>{`
        @keyframes pin-shake {
          0%, 100% { transform: translateX(0); }
          25% { transform: translateX(-8px); }
          75% { transform: translateX(8px); }
        }
      `}</style>
    </div>
  )
}

function KeyButton({
  children,
  onClick,
  disabled,
  ghost,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  ghost?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`h-16 rounded-[2px] text-[24px] mono font-medium transition-colors disabled:opacity-50 ${
        ghost
          ? 'text-[var(--color-ink-2)] hover:bg-[var(--color-bg)]'
          : 'bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-ink)] hover:border-[var(--color-ink)]'
      }`}
    >
      {children}
    </button>
  )
}

function KeyIcon() {
  // A simple key glyph — communicates "admin / unlock" without leaning on
  // gear or person icons that read as either too generic (settings) or
  // ambiguous (which person?).
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="5"
        cy="8"
        r="3"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M8 8 L14 8 M12 8 L12 11 M14 8 L14 10.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
