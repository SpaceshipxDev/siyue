import { requireUser } from '@/lib/auth'
import { PdfLoader } from '@/app/_pdf_loader'

export const dynamic = 'force-dynamic'

export default async function DuizhangPdfLoaderPage(props: {
  searchParams: Promise<{ kind?: string; name?: string; m?: string; sel?: string }>
}) {
  await requireUser()
  const sp = await props.searchParams
  const q = new URLSearchParams()
  if (sp.kind) q.set('kind', sp.kind)
  if (sp.name) q.set('name', sp.name)
  if (sp.m) q.set('m', sp.m)
  // 外协: 只印勾上的那几张单。
  if (sp.sel) q.set('sel', sp.sel)
  return (
    <PdfLoader rawHref={`/duizhang/pdf/raw?${q.toString()}`} title="对账单 PDF" />
  )
}
