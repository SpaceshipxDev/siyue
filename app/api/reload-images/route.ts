import { NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { currentUser, canEditProductionFields } from '@/lib/auth'
import { getJob, setPartImageUrlDirect } from '@/lib/db'
import { downloadSourceFile } from '@/lib/source-file'
import { parseWorkbook } from '@/lib/xlsx'
import { extractWorkbookImages, annotateSheetWithImages } from '@/lib/xlsx-images'
import { extractJobFromXlsx } from '@/lib/gemini'
import { uploadComponentImageWithRetry } from '@/lib/component-image'
import { errMessage } from '@/lib/err'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/*
 * 重新读取图片 — 只补图, 别的一个字不动。
 *
 * 导入的时候图片没读出来 (表格里的图有好几种存法, 换个软件导出就换一种), 这
 * 张工单就此一张图都没有。重新导入会多出一张单, 重跑解析会把已经改过的零件
 * 行冲掉 —— 都不是办法。
 *
 * 这条路只做一件事: 拿原始文件重新认一遍图, 按 图号 / 零件名 对回现有的零件
 * 行, 给还没有图的那几行补上。已经有图的一律不碰 (可能是人手传的), 零件行的
 * 名称、数量、工艺、工序一个都不改。
 */
export async function POST(request: NextRequest) {
  const user = await currentUser()
  if (!user || !canEditProductionFields(user)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const body = (await request.json().catch(() => null)) as
    | { jobId?: string }
    | null
  const jobId = body?.jobId
  if (!jobId) {
    return Response.json({ ok: false, error: 'missing jobId' }, { status: 400 })
  }

  const job = await getJob(jobId)
  if (!job) {
    return Response.json({ ok: false, error: '找不到这张工单' }, { status: 404 })
  }
  if (!job.sourceFileUrl) {
    return Response.json(
      { ok: false, error: '这张工单没有存原始文件，只能手动传图' },
      { status: 400 },
    )
  }

  try {
    const fileName = job.sourceFile ?? 'unknown.xlsx'
    const buf = await downloadSourceFile(job.sourceFileUrl)
    const wb = parseWorkbook(buf, fileName)
    const { anchors, images } = extractWorkbookImages(buf)
    if (images.size === 0) {
      return Response.json({
        ok: true,
        attached: 0,
        found: 0,
        message: '原始文件里没找到图片',
      })
    }
    const sheets = wb.sheets.map((s) => ({
      name: s.name,
      aoa: annotateSheetWithImages(s.name, s.aoa, anchors),
    }))
    const extracted = await extractJobFromXlsx({
      fileName,
      sheets,
      imageRefs: [...images.keys()],
    })

    // 对回现有的零件行 — 先按 图号, 再按 零件名, 都对不上就按第几行。名称和
    // 数量一律以库里的为准, 这条路只写 image_url。
    const parts = job.components ?? []
    const byPartNo = new Map<string, string>()
    const byName = new Map<string, string>()
    for (const c of parts) {
      const pn = (c.partNo ?? '').trim()
      const nm = (c.name ?? '').trim()
      if (pn && !byPartNo.has(pn)) byPartNo.set(pn, c.id)
      if (nm && !byName.has(nm)) byName.set(nm, c.id)
    }
    const hasImage = new Set(
      parts.filter((c) => c.imageUrl).map((c) => c.id),
    )

    // imageRef → 要补图的那几个零件行
    const targetsByRef = new Map<string, string[]>()
    extracted.components.forEach((c, i) => {
      const ref = c.imageRef
      if (!ref || !images.has(ref)) return
      const pn = (c.partNo ?? '').trim()
      const nm = (c.name ?? '').trim()
      const componentId =
        (pn && byPartNo.get(pn)) ||
        (nm && byName.get(nm)) ||
        parts[i]?.id ||
        undefined
      if (!componentId) return
      if (hasImage.has(componentId)) return // 已经有图的不碰
      const list = targetsByRef.get(ref)
      if (list) {
        if (!list.includes(componentId)) list.push(componentId)
      } else targetsByRef.set(ref, [componentId])
    })

    let attached = 0
    for (const [ref, componentIds] of targetsByRef) {
      const img = images.get(ref)
      if (!img) continue
      try {
        const imageUrl = await uploadComponentImageWithRetry({
          jobId,
          componentId: componentIds[0],
          bytes: img.bytes,
          mime: img.mime,
          fallbackName: `${ref}.${img.ext}`,
          skipStaleCheck: true,
        })
        for (const componentId of componentIds) {
          const hit = await setPartImageUrlDirect(
            `${jobId}:${componentId}`,
            imageUrl,
          )
          if (hit) attached += 1
        }
      } catch (err) {
        console.error('[reload-images] upload failed', {
          jobId,
          ref,
          err: errMessage(err),
        })
      }
    }

    revalidatePath(`/jobs/${jobId}`)
    revalidatePath('/')
    return Response.json({ ok: true, attached, found: images.size })
  } catch (err) {
    const message = errMessage(err)
    console.error('[reload-images] failed', { jobId, message })
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}
