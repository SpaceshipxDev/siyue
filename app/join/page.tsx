import type { Metadata, Viewport } from 'next'
import { Instrument_Serif } from 'next/font/google'
import { AfterlightJoin } from './_join_client'

// Elegant serif reserved for the brand wordmark + the success headline — the
// premium counterpoint to the clean sans used everywhere else on the page.
const serif = Instrument_Serif({
  weight: '400',
  style: ['normal', 'italic'],
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-afterlight-serif',
})

export const metadata: Metadata = {
  title: 'Afterlight — Get paid for brand campaigns without filming',
  description:
    'Generate AI versions of yourself that sells branded products without you having to film.',
}

export const viewport: Viewport = {
  themeColor: '#08070a',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
}

export default function JoinPage() {
  return (
    <div className={`${serif.variable} min-h-dvh w-full bg-[#08070a]`}>
      <AfterlightJoin />
    </div>
  )
}
