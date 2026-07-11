'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { getVendorByPortalToken, setBlockVendorState } from '@/lib/db'
import { DEMO_COOKIE, DEMO_TOKEN } from './_demo'

// Portal server actions — the vendor's one-tap answers (交期 + 发货 are the
// two the v4 cards render; 收到-ack stays for legacy data). No session:
// identity IS the token, re-verified on every call, and every write is
// additionally scoped by vendor_id inside setBlockVendorState so a forged
// blockId can't cross vendors.
//
// All three take FormData because the portal renders plain <form> elements:
// they must work as native POSTs in decade-old WeChat webviews, JS or no JS.
// Each action ends with redirect() back to the portal (anchored to the card
// that was acted on) — the natural no-JS flow, and with JS a soft refresh.

const REASONS = new Set(['材料未到', '排队中', '图纸问题', '其他'])

function str(fd: FormData, key: string): string {
  const v = fd.get(key)
  return typeof v === 'string' ? v : ''
}

async function requireVendor(token: string) {
  const vendor = token ? await getVendorByPortalToken(token) : undefined
  if (!vendor) redirect('/w/invalid')
  return vendor!
}

function backTo(token: string, blockId: string): never {
  revalidatePath(`/w/${token}`)
  redirect(`/w/${token}#b-${blockId}`)
}

// Demo taps answer for real — into a cookie instead of the DB, so the demo
// board behaves exactly like a live one without touching a single row.
// Empty-string fields mean "cleared" (applyDemoCookie maps them to undefined).
async function demoUpdate(
  blockId: string,
  patch: Partial<Record<'a' | 'p' | 'r' | 's', string>>,
): Promise<never> {
  const jar = await cookies()
  let state: Record<string, Record<string, string>> = {}
  try {
    state = JSON.parse(decodeURIComponent(jar.get(DEMO_COOKIE)?.value ?? '{}'))
  } catch {
    /* fresh */
  }
  state[blockId] = { ...state[blockId], ...patch }
  jar.set(DEMO_COOKIE, encodeURIComponent(JSON.stringify(state)), {
    path: `/w/${DEMO_TOKEN}`,
    maxAge: 60 * 60 * 24,
    sameSite: 'lax',
  })
  redirect(`/w/${DEMO_TOKEN}#b-${blockId}`)
}

// 确认收到 — goods physically arrived at the vendor's shop. on='0' undoes a
// fat-finger tap.
export async function portalAck(formData: FormData): Promise<void> {
  const token = str(formData, 'token')
  const blockId = str(formData, 'blockId')
  const on = str(formData, 'on') !== '0'
  if (token === DEMO_TOKEN) {
    await demoUpdate(blockId, { a: on ? new Date().toISOString() : '' })
  }
  const vendor = await requireVendor(token)
  if (blockId) await setBlockVendorState(vendor.id, blockId, { acked: on })
  backTo(token, blockId)
}

// 交期回复 — the vendor's own committed return date. date='' clears the
// promise (back to 未回复). A promise at/before the required date wipes any
// stale delay reason so the 外协台 never shows "按期 · 材料未到".
export async function portalPromise(formData: FormData): Promise<void> {
  const token = str(formData, 'token')
  const blockId = str(formData, 'blockId')
  const date = str(formData, 'date').trim()
  const expected = str(formData, 'expected').trim()
  if (token === DEMO_TOKEN) {
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(date)
    await demoUpdate(blockId, {
      p: valid ? date : '',
      ...(valid && expected && date <= expected ? { r: '' } : {}),
    })
  }
  const vendor = await requireVendor(token)
  if (blockId) {
    if (!date) {
      await setBlockVendorState(vendor.id, blockId, {
        promisedDate: null,
        delayReason: null,
      })
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const onTime = expected && date <= expected
      await setBlockVendorState(vendor.id, blockId, {
        promisedDate: date,
        ...(onTime ? { delayReason: null } : {}),
      })
    }
  }
  backTo(token, blockId)
}

// 延期原因 — one-tap chip, only offered when the promise is later than the
// required date. Whitelisted so the column never accumulates free text.
export async function portalDelayReason(formData: FormData): Promise<void> {
  const token = str(formData, 'token')
  const blockId = str(formData, 'blockId')
  const reason = str(formData, 'reason').trim()
  if (token === DEMO_TOKEN) {
    await demoUpdate(blockId, { r: REASONS.has(reason) ? reason : '' })
  }
  const vendor = await requireVendor(token)
  if (blockId && REASONS.has(reason)) {
    await setBlockVendorState(vendor.id, blockId, { delayReason: reason })
  }
  backTo(token, blockId)
}

// 已发货 — parts are on their way back to the factory. on='0' undoes.
export async function portalShipped(formData: FormData): Promise<void> {
  const token = str(formData, 'token')
  const blockId = str(formData, 'blockId')
  const on = str(formData, 'on') !== '0'
  if (token === DEMO_TOKEN) {
    await demoUpdate(blockId, { s: on ? new Date().toISOString() : '' })
  }
  const vendor = await requireVendor(token)
  if (blockId) await setBlockVendorState(vendor.id, blockId, { shipped: on })
  backTo(token, blockId)
}
