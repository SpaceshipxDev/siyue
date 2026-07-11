import { notFound } from 'next/navigation'
import { renderToBuffer } from '@react-pdf/renderer'
import QRCode from 'qrcode'
import { requireOutsourceManager } from '@/lib/auth'
import { ensurePartQrToken, getJob } from '@/lib/db'
import { BRAND } from '@/lib/brand'
import { contentDisposition } from '@/lib/content-disposition'
import { TravellerDocPDF, type TravellerPart } from '@/lib/pdf/traveller'
import { logPrint } from '@/lib/print-log'
import { travellerDocNo } from '../../_doc'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(
  req: Request,
  ctx: RouteContext<'/print/traveller/[jobId]/pdf/raw'>,
) {
  const user = await requireOutsourceManager()
  const { jobId } = await ctx.params
  const job = await getJob(jobId)
  if (!job) notFound()

  // Scan-page origin from the request host, not BRAND.domain — same
  // rationale as the 外协单 portal QR: the MES answers on whatever host the
  // reverse proxy owns, and a hardcoded domain would print dead QRs.
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? BRAND.domain
  const proto =
    req.headers.get('x-forwarded-proto') ??
    (host.startsWith('localhost') ? 'http' : 'https')

  const parts: TravellerPart[] = await Promise.all(
    job.components.map(async (component, i) => {
      const token = await ensurePartQrToken(job.id, component.id)
      const scanUrl = token ? `${proto}://${host}/s/${token}` : undefined
      return {
        component,
        docNo: travellerDocNo(job, i),
        qrDataUrl: scanUrl
          ? await QRCode.toDataURL(scanUrl, { margin: 0, width: 256 })
          : undefined,
        scanUrlShort: token ? `${host}/s/${token.slice(0, 6)}…` : undefined,
      }
    }),
  )

  const pdf = await renderToBuffer(TravellerDocPDF({ job, parts }))

  await logPrint({
    kind: 'traveller',
    refId: job.id,
    docNo: job.jobNo,
    jobNo: job.jobNo,
    userName: user.name,
    role: user.role,
  })

  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': contentDisposition(`traveller-${job.jobNo}.pdf`),
      'Cache-Control': 'no-store',
    },
  })
}
