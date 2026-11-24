'use client'

import { useRouter } from 'next/navigation'
import { BASE_PATH } from '@/lib/base-path'

// 返回 —— 回到点进来的那一页。
//
// 从计划点进来的 (链接带着 ?from=plan) 一定回计划, 不靠浏览器记的上一页 ——
// 还是有跳到首页的时候 (于海伟 2026-11-25)。计划自己记着筛选和滚动位置, 回去
// 就是刚才那一栏、那一行。
//
// 以前只看 history.length: 新标签页打开的工单 (Ctrl / 中键点、有的浏览器自己
// 开新窗口) 里只有这一页, 就当没有上一页直接回首页 —— 从计划点进工单, 返回
// 却到了首页 (于海伟 2026-11-25)。现在三步:
//   1. 这个标签页里本站还有上一页 (浏览器支持就问 navigation.canGoBack, 只算
//      本站的页) → 退回去;
//   2. 退不了, 但知道是从本站哪一页点过来的 (新标签页记着来源) → 去那一页;
//   3. 都不知道 → fallback。
export function BackButton({ fallback = '/' }: { fallback?: string }) {
  const router = useRouter()
  const onClick = () => {
    const from = FROM[new URLSearchParams(window.location.search).get('from') ?? '']
    if (from) {
      // 上一页正好就是计划 → 退回去 (连页面状态一起); 不是就直接去计划。
      if (previousPath() === from) router.back()
      else router.push(from)
      return
    }
    const nav = (window as { navigation?: { canGoBack?: boolean } }).navigation
    const canGoBack =
      typeof nav?.canGoBack === 'boolean' ? nav.canGoBack : window.history.length > 1
    if (canGoBack) {
      router.back()
      return
    }
    router.push(referrerPath() ?? fallback)
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 text-[12px] tracking-wider text-[var(--color-ink-2)] hover:text-[var(--color-ink)] transition-colors"
    >
      <span aria-hidden>←</span>
      <span>返回</span>
    </button>
  )
}

// ?from= 认得的几个来处。
const FROM: Record<string, string> = { plan: '/plan' }

/** 这个标签页里上一页的路径 (浏览器支持 navigation 才知道; 不知道是 null)。 */
function previousPath(): string | null {
  try {
    const nav = (
      window as {
        navigation?: { currentEntry?: { index: number }; entries?: () => { url: string | null }[] }
      }
    ).navigation
    const i = nav?.currentEntry?.index
    const prev = typeof i === 'number' && i > 0 ? nav?.entries?.()[i - 1]?.url : null
    if (!prev) return null
    const u = new URL(prev)
    if (u.origin !== window.location.origin) return null
    return u.pathname.slice(BASE_PATH.length) || '/'
  } catch {
    return null
  }
}

/** 从本站哪一页点进来的 (去掉 basePath, 好交给 router); 外站、同一页、登录页不算。 */
function referrerPath(): string | null {
  try {
    if (!document.referrer) return null
    const u = new URL(document.referrer)
    if (u.origin !== window.location.origin) return null
    if (BASE_PATH && !u.pathname.startsWith(BASE_PATH)) return null
    const path = u.pathname.slice(BASE_PATH.length) || '/'
    if (path === window.location.pathname.slice(BASE_PATH.length)) return null
    if (path.startsWith('/login')) return null
    return path + u.search
  } catch {
    return null
  }
}
