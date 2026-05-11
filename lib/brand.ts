// Issuer of the printed paperwork (chops, addresses, return contact).
// 思跃 is the *software* — kept as a small footer credit on docs.
export const BRAND = {
  legalName: '杭州越侬模型科技有限公司',
  shortName: '越侬模型',
  code: 'YNMX',
  address: '杭州市富阳区一号楼11号7幢越侬模型',
  receivingContact: { name: '王雪梅', phone: '15551519971' },
  software: '思跃 MES',
} as const

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
