// Issuer of the printed paperwork (chops, addresses, return contact).
// 思跃 (siyue.ai) is the *software* — a small, clear footer credit on every doc.
// The domain is the curiosity hook: a viewer reads the name 思跃, sees the
// homophone domain siyue.ai beside it, and it's short enough to retype from
// paper into a browser. Kept quiet so it never obstructs the factory's paperwork.
//
// De-identification hook: every factory-identifying field falls back to the
// real production values, but can be overridden via NEXT_PUBLIC_BRAND_* env
// vars at build time. A production build sets NONE of these, so the values are
// byte-for-byte identical to before. A *demo* build (separate deployment) sets
// them to a fictional shop so prospects never see the real factory's name,
// address, phone, doc-number prefix, or "our salesperson" label. NEXT_PUBLIC_*
// so the same constant is correct in both server (PDF/prompt) and client
// (header/footer) bundles.
const env = process.env

export const BRAND = {
  legalName: env.NEXT_PUBLIC_BRAND_LEGAL_NAME || '杭州越侬模型科技有限公司',
  shortName: env.NEXT_PUBLIC_BRAND_SHORT_NAME || '越侬模型',
  code: env.NEXT_PUBLIC_BRAND_CODE || 'YNMX',
  address: env.NEXT_PUBLIC_BRAND_ADDRESS || '杭州市富阳区同登路中交智能物联科技园6栋',
  receivingContact: {
    name: env.NEXT_PUBLIC_BRAND_CONTACT_NAME || '王雪梅',
    phone: env.NEXT_PUBLIC_BRAND_CONTACT_PHONE || '15551519971',
  },
  // The label for OUR salesperson on an order. The real install says 越侬商务;
  // a demo relabels it to a neutral 商务 so the field never names the factory.
  commerceLabel: env.NEXT_PUBLIC_BRAND_COMMERCE_LABEL || '越侬商务',
  software: '思跃 MES',
  domain: 'siyue.ai',
  softwareCredit: '思跃 MES · siyue.ai',
} as const

// Browser tab title / nav wordmark, derived so it flips with the brand too.
export const APP_TITLE = `${BRAND.shortName} · ${BRAND.software}`

// Format used on real factory docs: YNMX-yy-m-d-NNN. Month and day are NOT
// zero-padded (matches samples like `YNMX-26-4-9-094`); only NNN is.
export function formatDocNo(
  date: Date,
  seq: number,
  code: string = BRAND.code,
): string {
  const yy = String(date.getFullYear()).slice(-2)
  const m = date.getMonth() + 1
  const d = date.getDate()
  const nnn = String(seq).padStart(3, '0')
  return `${code}-${yy}-${m}-${d}-${nnn}`
}

export function docNoDayPrefix(date: Date, code: string = BRAND.code): string {
  const yy = String(date.getFullYear()).slice(-2)
  const m = date.getMonth() + 1
  const d = date.getDate()
  return `${code}-${yy}-${m}-${d}-`
}
