'use client'

import { useEffect, type RefObject } from 'react'

// 粘贴图片 —— 鼠标停在哪一格上, Ctrl+V 就贴进哪一格。
//
// 厂里的图片九成来自截图: 客户在微信上发来一张图, 质检在手机上拍一张, 采购
// 截一段聊天记录当凭证。原来的路是: 截图 → 另存为 → 想一个文件名 → 找到那个
// 文件夹 → 点上传 → 在文件框里再找一遍。五步里有四步跟这张图本身没关系。
//
// 为什么按"鼠标停在哪"而不是"先点一下再贴": 这些格子点下去就弹文件选择框,
// 要先点再贴等于多一次误开的文件框。悬停是零成本的 —— 手本来就在往那格移动,
// 移到了直接 Ctrl+V。键盘走位的人也照顾到了: 格子获得焦点时同样接收粘贴。
//
// 只在真的取到图片时才 preventDefault, 所以在输入框里粘贴文字一如既往。
export function usePasteImage(
  ref: RefObject<HTMLElement | null>,
  onImage: (file: File) => void,
  enabled = true,
) {
  useEffect(() => {
    if (!enabled) return
    const onPaste = (e: ClipboardEvent) => {
      // 正在输入框里打字就不抢 —— 剪贴板里图文都有时 (从网页上整段复制),
      // 人在文本框里按 Ctrl+V 要的是那段字, 不是那张图。
      const t = e.target as HTMLElement | null
      if (t && isTyping(t)) return

      const el = ref.current
      if (!el) return
      // 这一格是不是"当前那一格": 鼠标压在它上面, 或者焦点在它里面。
      const hovered =
        typeof el.matches === 'function' && el.matches(':hover')
      const focused = el.contains(document.activeElement)
      if (!hovered && !focused) return

      const file = imageFromClipboard(e.clipboardData)
      if (!file) return
      e.preventDefault()
      onImage(file)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [ref, onImage, enabled])
}

function isTyping(el: HTMLElement): boolean {
  const tag = el.tagName
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable
  )
}

/**
 * 从剪贴板里取出那张图。截图工具放进剪贴板的文件常常没有名字 (或者叫
 * image.png), 一律换成带时间的名字 —— 图纸清单和凭证台账上要认得出这是哪天
 * 贴的哪一张。
 */
export function imageFromClipboard(dt: DataTransfer | null): File | null {
  if (!dt) return null
  const items = Array.from(dt.items ?? [])
  for (const it of items) {
    if (it.kind !== 'file') continue
    const f = it.getAsFile()
    if (!f || !f.type.startsWith('image/')) continue
    return renamePasted(f)
  }
  // 有些浏览器 (以及从文件管理器复制过来的图) 走 files 而不是 items。
  const files = Array.from(dt.files ?? [])
  for (const f of files) {
    if (f.type.startsWith('image/')) return renamePasted(f)
  }
  return null
}

function renamePasted(f: File): File {
  const ext = f.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
  const known = f.name && f.name !== 'image.png' && f.name !== 'blob'
  if (known) return f
  const t = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const name = `粘贴-${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(
    t.getHours(),
  )}${p(t.getMinutes())}${p(t.getSeconds())}.${ext}`
  return new File([f], name, { type: f.type })
}
