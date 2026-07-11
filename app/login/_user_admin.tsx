'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { AppUser } from '@/lib/db'
import {
  createUserFormAction,
  deleteUserAction,
  resetPinAction,
  setActiveAction,
  setFinanceAction,
} from './admin_actions'

export function UserAdmin({
  users,
  bossId,
  adminIds,
  stages,
}: {
  users: AppUser[]
  bossId: string
  adminIds: string[]
  stages: readonly string[]
}) {
  return (
    <div className="space-y-10">
      <NewUserForm stages={stages} />
      <UserList users={users} bossId={bossId} adminIds={adminIds} />
    </div>
  )
}

function NewUserForm({ stages }: { stages: readonly string[] }) {
  const [role, setRole] = useState<'commerce' | 'production'>('production')
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const router = useRouter()

  return (
    <section>
      <h2 className="text-[15px] font-medium tracking-tight text-[var(--color-ink)] mb-3">
        新增账号
      </h2>
      <form
        action={(formData) =>
          start(async () => {
            setError(null)
            const res = await createUserFormAction(formData)
            if (res.ok) {
              const f = document.querySelector<HTMLFormElement>('#new-user-form')
              f?.reset()
              setRole('production')
              router.refresh()
            } else {
              setError(res.error)
            }
          })
        }
        id="new-user-form"
        className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end border border-[var(--color-border)] bg-[var(--color-surface)] p-5 rounded-[2px]"
      >
        <Field label="姓名" className="md:col-span-3">
          <input
            type="text"
            name="name"
            required
            maxLength={32}
            placeholder="王师傅"
            className="w-full bg-transparent border-b border-[var(--color-border-strong)] px-1 py-1.5 text-[14px] text-[var(--color-ink)] focus:outline-none focus:border-[var(--color-ink)]"
          />
        </Field>
        <Field label="角色" className="md:col-span-2">
          <select
            name="role"
            value={role}
            onChange={(e) =>
              setRole(e.currentTarget.value as 'commerce' | 'production')
            }
            className="w-full bg-transparent border-b border-[var(--color-border-strong)] px-1 py-1.5 text-[14px] text-[var(--color-ink)] focus:outline-none focus:border-[var(--color-ink)]"
          >
            <option value="production">生产</option>
            <option value="commerce">商务</option>
          </select>
        </Field>
        <Field
          label="工段"
          className={`md:col-span-3 ${role === 'commerce' ? 'opacity-30 pointer-events-none' : ''}`}
        >
          <select
            name="default_stage"
            disabled={role === 'commerce'}
            className="w-full bg-transparent border-b border-[var(--color-border-strong)] px-1 py-1.5 text-[14px] text-[var(--color-ink)] focus:outline-none focus:border-[var(--color-ink)]"
            defaultValue=""
          >
            <option value="">— 选择工段 —</option>
            {stages.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <Field label="PIN (4 位)" className="md:col-span-2">
          <input
            type="text"
            name="pin"
            inputMode="numeric"
            pattern="\d{4}"
            required
            maxLength={4}
            placeholder="1234"
            className="w-full bg-transparent border-b border-[var(--color-border-strong)] px-1 py-1.5 text-[14px] mono text-[var(--color-ink)] focus:outline-none focus:border-[var(--color-ink)]"
          />
        </Field>
        <div className="md:col-span-2 flex items-end">
          <button
            type="submit"
            disabled={pending}
            className="w-full px-3 py-2 text-[12px] tracking-wider bg-[var(--color-ink)] text-[var(--color-surface)] rounded-[2px] hover:opacity-80 disabled:opacity-60"
          >
            {pending ? '创建中…' : '创建'}
          </button>
        </div>
        {error && (
          <p className="md:col-span-12 text-[12px] text-[var(--color-overdue)]">
            {error}
          </p>
        )}
      </form>
    </section>
  )
}

function Field({
  label,
  children,
  className = '',
}: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <label className={`flex flex-col gap-1 ${className}`}>
      <span className="label">{label}</span>
      {children}
    </label>
  )
}

function UserList({
  users,
  bossId,
  adminIds,
}: {
  users: AppUser[]
  bossId: string
  adminIds: string[]
}) {
  return (
    <section>
      <h2 className="text-[15px] font-medium tracking-tight text-[var(--color-ink)] mb-3">
        员工
      </h2>
      <div className="border border-[var(--color-border)] bg-[var(--color-surface)] rounded-[2px]">
        <table className="sheet w-full text-left text-[13px]">
          <colgroup>
            <col style={{ width: 220 }} />
            <col style={{ width: 100 }} />
            <col style={{ width: 100 }} />
            <col style={{ width: 100 }} />
            <col style={{ minWidth: 220 }} />
          </colgroup>
          <thead>
            <tr className="text-[var(--color-ink-2)]">
              <th className="px-4 py-3 label">姓名</th>
              <th className="px-4 py-3 label">角色</th>
              <th className="px-4 py-3 label">工段</th>
              <th className="px-4 py-3 label">状态</th>
              <th className="px-4 py-3 label text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-8 text-center text-[12px] text-[var(--color-ink-3)]"
                >
                  暂无员工
                </td>
              </tr>
            ) : (
              users.map((u) => (
                <UserRow
                  key={u.id}
                  user={u}
                  bossId={bossId}
                  locked={adminIds.includes(u.id)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function UserRow({
  user,
  bossId,
  locked,
}: {
  user: AppUser
  bossId: string
  // 老板-level account (bootstrap 老板 or a promoted owner): protected from
  // deactivation / 财务 revocation / deletion, so those controls are hidden.
  locked: boolean
}) {
  const [pending, start] = useTransition()
  const [resetting, setResetting] = useState(false)
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  const isBoss = user.id === bossId

  const onToggle = () => {
    start(async () => {
      const res = await setActiveAction(user.id, !user.active)
      if (res.ok) {
        router.refresh()
      } else {
        window.alert(res.error)
      }
    })
  }

  const onToggleFinance = () => {
    start(async () => {
      const res = await setFinanceAction(user.id, !user.isFinance)
      if (res.ok) {
        router.refresh()
      } else {
        window.alert(res.error)
      }
    })
  }

  const onDelete = () => {
    if (
      !window.confirm(
        `确认永久删除「${user.name}」？\n该用户将不能再登录，历史记录中的署名会变为空。`,
      )
    )
      return
    start(async () => {
      const res = await deleteUserAction(user.id)
      if (res.ok) {
        router.refresh()
      } else {
        window.alert(res.error)
      }
    })
  }

  const onResetPin = () => {
    setError(null)
    if (!/^\d{4}$/.test(pin)) {
      setError('PIN 必须为 4 位数字')
      return
    }
    start(async () => {
      const res = await resetPinAction(user.id, pin)
      if (res.ok) {
        setResetting(false)
        setPin('')
      } else {
        setError(res.error ?? '重置失败')
      }
    })
  }

  const dim = user.active ? '' : 'opacity-50'

  return (
    <tr className={`align-middle ${dim}`}>
      <td className="px-4 py-3 text-[14px] font-medium text-[var(--color-ink)]">
        {user.name}
      </td>
      <td className="px-4 py-3 label">
        {isBoss ? '老板' : user.role === 'commerce' ? '商务' : '生产'}
        {user.role === 'commerce' && (isBoss || user.isFinance) && (
          <span className="ml-1.5 text-[10px] tracking-wider text-[var(--color-info)]">
            财务
          </span>
        )}
      </td>
      <td className="px-4 py-3 mono text-[12px]">
        {user.defaultStage ?? '—'}
      </td>
      <td className="px-4 py-3 label">
        {user.active ? (
          <span className="text-[var(--color-success)]">活跃</span>
        ) : (
          <span className="text-[var(--color-ink-3)]">已停用</span>
        )}
      </td>
      <td className="px-4 py-3 text-right">
        {resetting ? (
          <span className="inline-flex items-center gap-2">
            <input
              type="text"
              inputMode="numeric"
              pattern="\d{4}"
              maxLength={4}
              value={pin}
              onChange={(e) => setPin(e.currentTarget.value)}
              placeholder="新 PIN"
              autoFocus
              className="w-[80px] bg-transparent border-b border-[var(--color-border-strong)] px-1 py-0.5 text-[12px] mono text-[var(--color-ink)] focus:outline-none focus:border-[var(--color-ink)]"
            />
            <button
              type="button"
              onClick={onResetPin}
              disabled={pending}
              className="label hover:text-[var(--color-ink)] cursor-pointer disabled:opacity-50"
            >
              保存
            </button>
            <button
              type="button"
              onClick={() => {
                setResetting(false)
                setPin('')
                setError(null)
              }}
              className="label hover:text-[var(--color-ink)] cursor-pointer"
            >
              取消
            </button>
            {error && (
              <span className="text-[11px] text-[var(--color-overdue)]">
                {error}
              </span>
            )}
          </span>
        ) : (
          <span className="inline-flex items-center gap-4">
            <button
              type="button"
              onClick={() => setResetting(true)}
              className="label hover:text-[var(--color-ink)] cursor-pointer"
            >
              重置 PIN
            </button>
            {!locked && user.role === 'commerce' && (
              <button
                type="button"
                onClick={onToggleFinance}
                disabled={pending}
                title="财务可见性 — 支出台账与月度现金流（含工资）"
                className={`label cursor-pointer disabled:opacity-50 ${
                  user.isFinance
                    ? 'hover:text-[var(--color-overdue)]'
                    : 'hover:text-[var(--color-ink)]'
                }`}
              >
                {user.isFinance ? '取消财务' : '设为财务'}
              </button>
            )}
            {!locked && (
              <>
                <button
                  type="button"
                  onClick={onToggle}
                  disabled={pending}
                  className={`label cursor-pointer disabled:opacity-50 ${
                    user.active
                      ? 'hover:text-[var(--color-overdue)]'
                      : 'hover:text-[var(--color-ink)]'
                  }`}
                >
                  {user.active ? '停用' : '启用'}
                </button>
                <button
                  type="button"
                  onClick={onDelete}
                  disabled={pending}
                  className="label cursor-pointer disabled:opacity-50 hover:text-[var(--color-overdue)]"
                >
                  删除
                </button>
              </>
            )}
          </span>
        )}
      </td>
    </tr>
  )
}
