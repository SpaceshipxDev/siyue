import { NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { currentUser } from '@/lib/auth'
import {
  DEFAULT_APPEARANCE,
  emptyBalloon,
  sheetVerdict,
  type AppearanceItem,
  type Balloon,
  type BalloonSheet,
} from '@/lib/balloon'
import {
  createBalloonSheet,
  findPartBalloonSheet,
  getBalloonImage,
  getBalloonSheet,
  updateBalloonSheet,
} from '@/lib/balloon-store'
import { extractDrawingDims, type DrawingDim } from '@/lib/gemini'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

// 质量 · 气泡图 (lib/balloon)。
//   POST multipart  file=<图纸图片> title=…   → 新建一张, 顺手识图标好气泡
//   POST json       {action:'detect', id}     → 对这张重新识图 (气泡整套换掉)
// 跟质量其它几张表同一档: 有账号就能建、能识图; 删在 /api/mutate。

const MAX_BYTES = 20 * 1024 * 1024
const IMAGE = /\.(png|jpe?g|webp|bmp|gif)$/i

// 识出来的标注 → 气泡: 紧贴在那段文字的右边、上下居中 (以前放在右上角外面,
// 识图的框本来就有一点偏, 再往外放就偏得更远了), 从上到下、从左到右编号。
function toBalloons(dims: DrawingDim[], samples: number): Balloon[] {
  const sorted = [...dims].sort((a, b) => {
    const ra = Math.floor(a.box[0] / 60)
    const rb = Math.floor(b.box[0] / 60)
    return ra !== rb ? ra - rb : a.box[1] - b.box[1]
  })
  return sorted.map((d, i) => {
    const [ymin, , ymax, xmax] = d.box
    const b = emptyBalloon(i + 1, Math.min(0.99, xmax / 1000 + 0.008), (ymin + ymax) / 2000, samples)
    return { ...b, spec: d.spec, kind: d.kind, nominal: d.nominal, tolUp: d.tolUp, tolDown: d.tolDown }
  })
}

async function detect(sheet: BalloonSheet): Promise<BalloonSheet> {
  const img = await getBalloonImage(sheet)
  if (!img) throw new Error('图纸图片读不到')
  const { dims, appearance } = await extractDrawingDims(img)
  // 外观检验: 图上读出来的那几条, 再兜一条「外观缺陷」(图上很少写, 但每件都要看)。
  const items: AppearanceItem[] = appearance.map((a) => ({ item: a.item, req: a.req, result: '', note: '' }))
  if (!items.some((a) => a.item.includes('缺陷') || /划伤|磕碰/.test(a.req)))
    items.push(...DEFAULT_APPEARANCE.map((a) => ({ ...a })))
  return updateBalloonSheet(
    sheet.id,
    { balloons: toBalloons(dims, sheet.samples), appearance: items },
    sheetVerdict,
  )
}

export async function POST(request: NextRequest) {
  const user = await currentUser()
  if (!user) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  const type = request.headers.get('content-type') ?? ''
  if (type.includes('application/json')) {
    const body = (await request.json().catch(() => null)) as { action?: string; id?: string } | null
    if (!body || body.action !== 'detect' || typeof body.id !== 'string')
      return Response.json({ ok: false, error: 'bad args' }, { status: 400 })
    const sheet = await getBalloonSheet(body.id)
    if (!sheet) return Response.json({ ok: false, error: '这张气泡图不在了' }, { status: 404 })
    try {
      const next = await detect(sheet)
      revalidatePath('/quality')
      return Response.json({ ok: true, sheet: next })
    } catch (e) {
      return Response.json({ ok: false, error: e instanceof Error ? e.message : '识图失败' }, { status: 500 })
    }
  }

  const form = await request.formData()
  const file = form.get('file')
  if (!(file instanceof File)) return Response.json({ ok: false, error: '先选一张图纸图片' }, { status: 400 })
  if (!IMAGE.test(file.name) && !file.type.startsWith('image/'))
    return Response.json(
      { ok: false, error: '图纸要是图片 (截图、扫描件、PNG/JPG)；PDF 先截个图再传' },
      { status: 415 },
    )
  if (file.size > MAX_BYTES) return Response.json({ ok: false, error: '图片过大（上限 20MB）' }, { status: 413 })
  const title = form.get('title')
  const str = (k: string) => {
    const v = form.get(k)
    return typeof v === 'string' ? v.trim().slice(0, 200) : ''
  }
  // 从工单零件那一行建的: 挂上零件; 这个零件已经有一张就直接用那一张。
  const jobId = str('jobId')
  const componentId = str('componentId')
  const existing = await findPartBalloonSheet(jobId, componentId)
  if (existing) return Response.json({ ok: true, id: existing, detected: true })

  let sheet: BalloonSheet
  try {
    sheet = await createBalloonSheet({
      body: file,
      fileName: file.name || 'drawing.png',
      contentType: file.type,
      title: typeof title === 'string' ? title : '',
      jobId,
      componentId,
      jobNo: str('jobNo'),
      customer: str('customer'),
      material: str('material'),
      by: user.name,
      nowIso: new Date().toISOString(),
    })
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : '上传失败' }, { status: 500 })
  }
  // 识图失败不拦 —— 图已经存下了, 进去手点气泡、或者再点一次「自动识别」。
  let detected = true
  try {
    sheet = await detect(sheet)
  } catch {
    detected = false
  }
  revalidatePath('/quality')
  return Response.json({ ok: true, id: sheet.id, detected })
}
