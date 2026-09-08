import { renderToBuffer } from '@react-pdf/renderer'
import { contentDisposition } from '@/lib/content-disposition'
import { DuizhangPDF } from '@/lib/pdf/duizhang'
import { DUIZHANG_TITLE } from '@/lib/duizhang'
import { loadDuizhang } from '../../_load'

// 对账单 PDF 的字节。取数和页面同一条路 (loadDuizhang), 权限也一样。

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams
  const { user, sheet, todayStr } = await loadDuizhang({
    kind: sp.get('kind') ?? undefined,
    name: sp.get('name') ?? undefined,
    m: sp.get('m') ?? undefined,
  })
  if (!sheet) {
    return new Response('请先选择对账对象', { status: 400 })
  }

  const pdf = await renderToBuffer(
    DuizhangPDF({ sheet, preparedBy: user.name, todayStr }),
  )
  const name = `${sheet.party}-${DUIZHANG_TITLE[sheet.kind]}-${sheet.from.slice(0, 7)}.pdf`

  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': contentDisposition(name),
      'Cache-Control': 'no-store',
    },
  })
}
