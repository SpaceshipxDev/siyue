'use client'

// Client-side photo downscale — factory phones shoot 5–12MP HEIC/JPEG; we
// re-encode to a bounded JPEG before upload so ingestion/matching stay fast
// on shop-floor wifi and the matcher sees a consistent input size.
//
// createImageBitmap({imageOrientation:'from-image'}) bakes EXIF rotation in;
// the <img> fallback covers older WeChat webviews (browsers that take that
// path also auto-orient via CSS image-orientation by default).

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' })
    } catch {
      /* fall through */
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('无法读取照片'))
    }
    img.src = url
  })
}

export async function downscaleToJpeg(
  file: File,
  maxSide = 2000,
  quality = 0.82,
): Promise<Blob> {
  const bmp = await loadBitmap(file)
  const w = 'width' in bmp ? bmp.width : 0
  const h = 'height' in bmp ? bmp.height : 0
  if (!w || !h) throw new Error('无法读取照片')
  const scale = Math.min(1, maxSide / Math.max(w, h))
  const cw = Math.round(w * scale)
  const ch = Math.round(h * scale)
  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas unsupported')
  ctx.drawImage(bmp as CanvasImageSource, 0, 0, cw, ch)
  if ('close' in bmp) bmp.close()
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', quality),
  )
  if (!blob) throw new Error('照片压缩失败')
  return blob
}
