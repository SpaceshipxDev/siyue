import 'server-only'
import { revalidatePath } from 'next/cache'
import { parseWorkbook } from './xlsx'
import { extractWorkbookImages, annotateSheetWithImages } from './xlsx-images'
import { extractJobFromXlsx } from './gemini'
import { fillParsedJob, setPartImageUrlDirect, type NewJobInput } from './db'
import { uploadComponentImageWithRetry } from './component-image'

/*
 * End-to-end import pipeline:
 *   xlsx bytes
 *     → parseWorkbook            (sheet aoa)
 *     → extractWorkbookImages    (image bytes + cell anchors)
 *     → annotateSheetWithImages  (`<<IMG:imgN>>` markers in aoa cells)
 *     → extractJobFromXlsx       (Gemini → parts with imageRef per row)
 *     → fillParsedJob            (persist parts WITHOUT images, status→draft)
 *     → uploadComponentImage     (each ref → public URL, in background chunks)
 *     → setPartImageUrlDirect    (patch each part as its image lands)
 *
 * Shared by /api/ingest (fresh upload) and /api/retry-parse (re-run on stored
 * source file) so both code paths see the same image-resolution semantics.
 *
 * Why parts land in 'draft' BEFORE images upload:
 * the master uploader's poll timeout is 45s (see app/_import_status.tsx) and
 * a workbook with ~100 embedded photos pushes total Supabase upload time well
 * past that. By flipping status as soon as Gemini returns we let 商务 start
 * editing immediately while thumbnails fill in progressively as each chunk
 * lands. revalidatePath on every chunk so the open import page picks up the
 * new image_urls without a manual refresh.
 */

// Tuned to keep Supabase happy without leaving the upload bandwidth idle.
// At 8 concurrent ~50KB PNGs the bottleneck is connection setup, not body
// bytes; pushing higher only adds tail latency once Supabase starts queueing.
const IMAGE_UPLOAD_CONCURRENCY = 8

export async function runExtraction(args: {
  jobId: string
  fileName: string
  buf: ArrayBuffer
  t0?: number
}): Promise<void> {
  const { jobId, fileName, buf } = args
  const t0 = args.t0 ?? Date.now()

  const tParse = Date.now()
  const wb = parseWorkbook(buf, fileName)
  // Both of these are synchronous and CPU-heavy (sheet decode, then zip +
  // image decode), and this process serves the whole factory on one thread —
  // back to back they hold the event loop for the length of both, which is
  // what the floor feels as 上传时系统卡住. Yielding between them doesn't
  // make either faster, but it lets everyone else's requests through in the
  // gap instead of queueing behind the pair.
  await new Promise((r) => setImmediate(r))
  const { anchors, images } = extractWorkbookImages(buf)
  const sheets = wb.sheets.map((s) => ({
    name: s.name,
    aoa: annotateSheetWithImages(s.name, s.aoa, anchors),
  }))
  const imageRefs = [...images.keys()]
  console.log('[extract] parsed workbook', {
    jobId,
    fileName,
    sheetNames: wb.sheetNames,
    rowsPerSheet: wb.sheets.map((s) => ({ name: s.name, rows: s.rows, cols: s.cols })),
    imageRefs,
    anchorCount: anchors.length,
    ms: Date.now() - tParse,
  })

  const tGemini = Date.now()
  const extracted = await extractJobFromXlsx({ fileName, sheets, imageRefs })
  console.log('[extract] gemini extracted', {
    jobId,
    fileName,
    parts: extracted.components.length,
    withImageRef: extracted.components.filter((c) => c.imageRef).length,
    ms: Date.now() - tGemini,
  })

  // Group imageRef → EVERY part using it, synchronously, before any upload.
  // Excel/WPS store a copy-pasted picture once and anchor it in many rows, so
  // the same ref legitimately belongs to several parts (five identical 零件
  // rows sharing one 图纸). Each ref's bytes upload once — under the first
  // part's key — and the resulting URL is stamped onto every part in the
  // group. Grouping serially here also keeps the upload queue race-free.
  const pendingUploads: { partIndexes: number[]; imageRef: string }[] = []
  const partsByRef = new Map<string, number[]>()
  extracted.components.forEach((c, i) => {
    const ref = c.imageRef
    if (!ref || !images.has(ref)) return
    const group = partsByRef.get(ref)
    if (group) group.push(i)
    else {
      const fresh = [i]
      partsByRef.set(ref, fresh)
      pendingUploads.push({ partIndexes: fresh, imageRef: ref })
    }
  })

  // Drop imageRef from each part — fillParsedJob expects clean components.
  // imageUrl stays undefined; the background pass below patches each row as
  // its upload completes.
  const componentsWithoutImages: NewJobInput['components'] = extracted.components.map(
    (c) => {
      const { imageRef: _imageRef, ...rest } = c
      void _imageRef
      return rest
    },
  )

  const tFill = Date.now()
  await fillParsedJob(jobId, { ...extracted, components: componentsWithoutImages })
  console.log('[extract] filled draft (no images yet)', {
    jobId,
    fileName,
    parts: componentsWithoutImages.length,
    pendingImages: pendingUploads.length,
    ms: Date.now() - tFill,
    totalSoFarMs: Date.now() - t0,
  })

  // Surface the editable draft NOW. The user gets the parts list, can rename
  // fields, prune stages, etc. while images trickle in below.
  revalidatePath('/')
  revalidatePath(`/import/${jobId}`)

  if (pendingUploads.length === 0) {
    return
  }

  // Background image-upload pass — chunked Promise.all so ~100 uploads don't
  // all hammer Supabase at once but also don't crawl serially. After every
  // chunk we revalidate the import page so the open editor swaps in new
  // thumbnails as they land.
  const tImages = Date.now()
  let uploaded = 0
  let failed = 0
  // 图上传成功了, 但那一行零件已经不在 — 记下来, 别混进 failed。
  let dropped = 0
  for (let i = 0; i < pendingUploads.length; i += IMAGE_UPLOAD_CONCURRENCY) {
    const chunk = pendingUploads.slice(i, i + IMAGE_UPLOAD_CONCURRENCY)
    await Promise.all(
      chunk.map(async ({ partIndexes, imageRef }) => {
        const img = images.get(imageRef)
        if (!img) return
        const componentId = `p${partIndexes[0] + 1}`
        try {
          const imageUrl = await uploadComponentImageWithRetry({
            jobId,
            componentId,
            bytes: img.bytes,
            mime: img.mime,
            fallbackName: `${imageRef}.${img.ext}`,
            skipStaleCheck: true,
          })
          for (const partIndex of partIndexes) {
            // A miss means the 零件行 was deleted while its photo uploaded —
            // count it as dropped rather than reporting a clean success.
            const hit = await setPartImageUrlDirect(
              `${jobId}:p${partIndex + 1}`,
              imageUrl,
            )
            if (hit) uploaded += 1
            else dropped += 1
          }
        } catch (err) {
          failed += partIndexes.length
          console.error('[extract] image upload failed after retries', {
            jobId,
            componentId,
            imageRef,
            err: err instanceof Error ? err.message : String(err),
          })
        }
      }),
    )
    revalidatePath(`/import/${jobId}`)
  }
  console.log('[extract] images attached', {
    jobId,
    fileName,
    uploaded,
    failed,
    dropped,
    ms: Date.now() - tImages,
    totalMs: Date.now() - t0,
  })
}
