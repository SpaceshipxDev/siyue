import type { Metadata } from 'next'
import { Sheet } from '../_sheet'

// /x/demo — the public, zero-login sandbox. Everything runs client-side
// against localStorage: paste your own WPS rows, tap stages, nothing touches
// the database. This is the link for TikTok clips and prospect factories —
// a boss can onboard himself before we've ever spoken to him.

export const metadata: Metadata = {
  title: '思跃 · 把排产表粘贴进来,全厂实时同一张表',
  description:
    '从 WPS / Excel 复制零件行,粘贴即成生产表:工序打✓报工、交期自动变红、图片直接拖入。免登录试用。',
}

export default function XDemoPage() {
  return <Sheet mode="demo" me={null} />
}
