import Link from 'next/link'

export type MobileNavKey = 'scan' | 'history' | 'ingest'

const ITEMS: { key: MobileNavKey; label: string; href: string }[] = [
  { key: 'scan', label: '报工', href: '/p' },
  { key: 'history', label: '历史', href: '/orders' },
  { key: 'ingest', label: '录入', href: '/ingest' },
]

export function MobileNav({ current, authenticated }: { current: MobileNavKey; authenticated: boolean }) {
  const items = authenticated ? ITEMS : ITEMS.slice(0, 1)
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-surface)_94%,transparent)] backdrop-blur-xl pb-[env(safe-area-inset-bottom)] md:hidden">
      <div className={`mx-auto grid h-16 max-w-md px-3 ${authenticated ? 'grid-cols-3' : 'grid-cols-1'}`}>
        {items.map((item) => {
          const active = item.key === current
          return (
            <Link key={item.key} href={item.href} aria-current={active ? 'page' : undefined}
              className={`flex items-center justify-center text-[14px] font-semibold ${active ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-3)]'}`}>
              {item.label}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
