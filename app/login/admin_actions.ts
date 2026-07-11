'use server'

import { revalidatePath } from 'next/cache'
import type { Stage } from '@/lib/data'
import {
  createUser,
  deleteUser,
  resetUserPin,
  updateUser,
  type Role,
} from '@/lib/db'
import { requireCommerce } from '@/lib/auth'

export type CreateUserResult =
  | { ok: true }
  | { ok: false; error: string }

export async function createUserFormAction(
  formData: FormData,
): Promise<CreateUserResult> {
  await requireCommerce()
  const name = String(formData.get('name') ?? '').trim()
  const pin = String(formData.get('pin') ?? '')
  const role = String(formData.get('role') ?? '') as Role
  const stage = String(formData.get('default_stage') ?? '').trim() as Stage
  if (role !== 'commerce' && role !== 'production') {
    return { ok: false, error: '请选择身份' }
  }
  if (role === 'production' && !stage) {
    return { ok: false, error: '请选择工段' }
  }
  try {
    await createUser({
      name,
      pin,
      role,
      defaultStage: role === 'production' ? stage : undefined,
    })
    revalidatePath('/login')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '创建失败' }
  }
}

export type SetActiveResult = { ok: true } | { ok: false; error: string }

export async function setActiveAction(
  userId: string,
  active: boolean,
): Promise<SetActiveResult> {
  await requireCommerce()
  try {
    await updateUser(userId, { active })
    revalidatePath('/login')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '更新失败' }
  }
}

// Grant / revoke the 财务 flag (支出/月度 tab visibility). Commerce users
// only — the toggle is hidden for production rows in the UI, and the boss
// row rejects revocation at the lib/db level.
export async function setFinanceAction(
  userId: string,
  isFinance: boolean,
): Promise<SetActiveResult> {
  await requireCommerce()
  try {
    await updateUser(userId, { isFinance })
    revalidatePath('/login')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '更新失败' }
  }
}

export async function resetPinAction(
  userId: string,
  pin: string,
): Promise<{ ok: boolean; error?: string }> {
  await requireCommerce()
  try {
    await resetUserPin(userId, pin)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '重置失败' }
  }
}

export type DeleteUserResult = { ok: true } | { ok: false; error: string }

// Hard delete. FK columns (jobs.created_by_user_id, part_stages.by_user_id,
// outsource_blocks.created_by_user_id) are ON DELETE SET NULL per
// migration 0005, so audit history just loses the username — no orphaned
// rows. The 老板 row is rejected at the lib/db level (see deleteUser).
export async function deleteUserAction(
  userId: string,
): Promise<DeleteUserResult> {
  await requireCommerce()
  try {
    await deleteUser(userId)
    revalidatePath('/login')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '删除失败' }
  }
}
