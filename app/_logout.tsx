'use client'

import { useTransition } from 'react'
import { logoutAction } from './login/actions'

export function LogoutButton({ name }: { name: string }) {
  const [pending, start] = useTransition()
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await logoutAction()
        })
      }
      className="label hover:text-[var(--color-overdue)] cursor-pointer disabled:opacity-50"
      title={`退出 ${name}`}
    >
      {pending ? '退出中…' : '退出'}
    </button>
  )
}
