'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getVendorByPortalToken, setBlockVendorState } from '@/lib/db'

// Portal server actions — the vendor's three one-tap answers. No session:
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
  // Demo board (/w/demo): taps navigate but never write — there is no row.
  if (token === 'demo') redirect('/w/demo')
  const vendor = token ? await getVendorByPortalToken(token) : undefined
  if (!vendor) redirect('/w/invalid')
  return vendor!
}

function backTo(token: string, blockId: string): never {
  revalidatePath(`/w/${token}`)
  redirect(`/w/${token}#b-${blockId}`)
}

// 确认收到 — goods physically arrived at the vendor's shop. on='0' undoes a
// fat-finger tap.
export async function portalAck(formData: FormData): Promise<void> {
  const token = str(formData, 'token')
  const blockId = str(formData, 'blockId')
  const on = str(formData, 'on') !== '0'
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
  const vendor = await requireVendor(token)
  if (blockId) await setBlockVendorState(vendor.id, blockId, { shipped: on })
  backTo(token, blockId)
}
