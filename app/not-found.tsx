// 404 inside the root layout (Next's built-in not-found skips the layout, which also dropped the 改一下 panel).
import Link from 'next/link'

export default function NotFound() {
  return (
    <main style={{ minHeight: '70vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, color: '#6e6e73', fontSize: 15 }}>
      <div>这一页不存在了</div>
      <Link href="/" style={{ color: '#1d1d1f', textDecoration: 'underline', textUnderlineOffset: 3 }}>回到首页</Link>
    </main>
  )
}
