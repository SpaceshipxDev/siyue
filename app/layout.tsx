import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import './globals.css'
import { EnBoot } from "./_en_boot";
import { BASE_PATH } from '@/lib/base-path'
import { ToastHost } from './_toast'
import { APP_TITLE } from '@/lib/brand'

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
})

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
})

// bump when public/i18n/en.js or en.json changes (cache-bust for browsers)
const EN_V = "1";

export const metadata: Metadata = {
  title: APP_TITLE,
  description: '工段实时进度看板',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="zh-CN"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        {/* English mode for US visitors (sy_lang=en cookie, set by proxy.ts).
            Chinese users: this script finds no cookie and does nothing. */}
        <style>{`html.sy-en-pending body{visibility:hidden}`}</style>
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{if(/(?:^|; )sy_lang=en(?:;|$)/.test(document.cookie)){var h=document.documentElement;h.classList.add('sy-en-pending');var s=document.createElement('script');s.src='" + BASE_PATH + "/i18n/en.js?v=" + EN_V + "';s.setAttribute('data-v','" + EN_V + "');s.async=true;document.head.appendChild(s);}}catch(e){}})()",
          }}
        />
      </head>
      <body className="min-h-full flex flex-col bg-[var(--color-bg)] text-[var(--color-ink)]">
        {children}
        <ToastHost />
        <EnBoot />
      </body>
    </html>
  )
}
