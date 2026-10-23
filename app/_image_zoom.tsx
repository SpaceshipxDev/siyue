'use client'

import { useEffect, useState } from 'react'
import { PhotoViewer, type ViewerItem } from './_photo_viewer'

// 点图看大图 —— 全站一处 (于海伟 2026-10-23: 系统里所有图片都能点开放大)。
//
// 挂在根布局上, 在最外层先接住点击: 点到一张图就用「看大图」那个黑底框铺开,
// 不用每个页面各写一遍。几条规矩:
//
//   · 图在按钮里的不管 —— 那是别的动作 (很多已经自己开了看大图)。
//   · 图在链接里的: 链接指着的就是这张图 (新窗口开原图那种), 改成在这里铺开;
//     链到别处的 (点图进工单) 照旧跳。
//   · 别的 (表格行、格子) 点在图上就是看大图, 不再触发那一行的点击。
//   · 太小的 (图标) 不管; 挂了 data-no-zoom 的不管。按着 Ctrl / ⌘ 点照旧。
//
// 同一块里挨着的几张图一起带上, 左右键翻。

function zoomable(img: HTMLImageElement): boolean {
  if (!img.currentSrc && !img.src) return false
  if (img.closest('[data-no-zoom]')) return false
  const w = img.naturalWidth || img.width
  if (w > 0 && w < 24) return false
  return true
}

function nameOf(img: HTMLImageElement): string {
  return img.alt || (img.currentSrc || img.src).split('/').pop()?.split('?')[0] || '图片'
}

export function ImageZoom() {
  const [view, setView] = useState<{ items: ViewerItem[]; start: number } | null>(null)

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return
      const t = e.target
      if (!(t instanceof Element)) return
      const img = t.closest('img')
      if (!img || !zoomable(img)) return
      if (img.closest('button, label, [role="button"], input, select, textarea')) return
      const a = img.closest('a')
      if (a) {
        // 链接指着的就是这张图 (或者另一张图) —— 在这里铺开; 链到页面的照旧跳。
        const href = a.getAttribute('href') ?? ''
        const toImage =
          href === img.getAttribute('src') ||
          /\/api\/img\//.test(href) ||
          /\.(png|jpe?g|webp|gif|bmp)(\?|$)/i.test(href)
        if (!toImage) return
      }
      e.preventDefault()
      e.stopPropagation()
      // 同一块里的几张一起翻: 往上找一层, 里面有好几张能放大的图就带上。
      let box: Element | null = img.parentElement
      let group: HTMLImageElement[] = [img]
      for (let k = 0; box && k < 3; k++, box = box.parentElement) {
        const imgs = [...box.querySelectorAll('img')].filter(
          (x) => zoomable(x) && !x.closest('button'),
        )
        if (imgs.length > 1) {
          group = imgs
          break
        }
      }
      setView({
        items: group.map((x) => ({ url: x.currentSrc || x.src, filename: nameOf(x) })),
        start: Math.max(0, group.indexOf(img)),
      })
    }
    // 捕获阶段挂在 window 上 —— 比页面里的点击先到, 接住了就不往下传。
    window.addEventListener('click', onClick, true)
    return () => window.removeEventListener('click', onClick, true)
  }, [])

  if (!view) return null
  return <PhotoViewer items={view.items} start={view.start} onClose={() => setView(null)} />
}
