'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { MUTATED_EVENT } from '@/lib/mutate'

/**
 * 存了就该看见 —— 全站唯一的一处"写完刷新"。
 *
 * 以前这件事是每个页面自己管的: 记一笔人事、改一格工资、开一张外协单, 各自
 * 在 mutate 后面跟一句 router.refresh()。写了的地方好用, 漏了的地方就得人去
 * 按 F5 —— 而漏没漏, 从界面上看不出来, 只有当事人一边录一边刷新。
 *
 * 现在反过来: 任何一次写成功 (lib/mutate 派一个事件), 这里就刷新一次当前页
 * 面。挂在根布局上, 所以每个页面都有, 不存在"这一处忘了写"。
 *
 * 三个细节:
 *   · 合并 —— 300ms 内的多次写只刷一次。批量套用工序是连着三十次写, 刷三十
 *     次页面比不刷还糟。
 *   · 页面在后台就不刷 —— 切回来的时候再补一次, 免得后台标签页一直打服务端。
 *   · router.refresh() 只换服务端那份数据, 不重新挂载组件 —— 正在打字的输入
 *     框、展开的工资条、滚动位置都还在。这正是它和 F5 的区别。
 */
export function AutoRefresh() {
  const router = useRouter()

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let queued = false

    const run = () => {
      timer = null
      if (document.hidden) {
        // 后台标签页先记着, 等切回来一次性补上。
        queued = true
        return
      }
      queued = false
      router.refresh()
    }

    const onMutated = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(run, 300)
    }

    const onVisible = () => {
      if (!document.hidden && queued) run()
    }

    window.addEventListener(MUTATED_EVENT, onMutated)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      if (timer) clearTimeout(timer)
      window.removeEventListener(MUTATED_EVENT, onMutated)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [router])

  return null
}
