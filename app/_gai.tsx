// 改一下 — the self-serve hook.
//   On the Tokyo mirror (GAI_MIRROR=1): load the overlay (circle + ask + 上线) served by the console at /_gai/*.
//   On prod (GAI_HOST set): a single pill that jumps to the same page on the mirror. Nothing else changes.
// Both are runtime env, read on the server per request; nothing is inlined at build time.
// GAI_SKIP (optional regex source) = paths where the pill must never show (login, vendor portal, print views).
import { GaiPill } from './_gai_pill'

export function GaiHook() {
  if (process.env.GAI_MIRROR) {
    return (
      <>
        <link rel="stylesheet" href="/_gai/overlay.css" />
        <script src="/_gai/overlay.js" defer />
      </>
    )
  }
  const host = process.env.GAI_HOST
  if (!host) return null
  return <GaiPill host={host} skip={process.env.GAI_SKIP || ''} />
}
