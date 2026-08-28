// 改一下 — the self-serve hook. Identical file in every customer app; only lib/gai.ts differs per app.
//   Mirror (GAI_MIRROR=1): inject the overlay (circle + ask + 上线), served by the console at /_gai/*.
//   Prod  (GAI_HOST set):  one pill that jumps to the same page on the mirror.
// Access comes from lib/gai.ts (yuenong: users.can_gai or boss; shuangderui: everyone). Without access the
// pill still shows — locked — so people see the feature exists and who can open it.
// All runtime env, read per request on the server; nothing is inlined at build time.
import { gaiAccess } from '@/lib/gai'
import { GaiPill } from './_gai_pill'

export async function GaiHook() {
  const mirror = !!process.env.GAI_MIRROR
  const host = process.env.GAI_HOST
  if (!mirror && !host) return null
  const a = await gaiAccess()
  if (!a.user) return null
  if (mirror) {
    return (
      <>
        {/* Inline so it runs during parse, before any app chunk: keyboard/clipboard events inside the 改一下 panel
            never reach the host app's global handlers (spreadsheet-style grids preventDefault digits and space). */}
        <script dangerouslySetInnerHTML={{ __html: `window.__GAI_ALLOWED=${a.allowed ? 'true' : 'false'};(function(){var ts=['keydown','keyup','keypress','beforeinput','input','paste','copy','cut'];for(var i=0;i<ts.length;i++)window.addEventListener(ts[i],function(e){var t=e.target;while(t&&t!==document){if(t.classList&&t.classList.contains('gai')){e.stopImmediatePropagation();return;}t=t.parentNode;}},true);})();` }} />
        <link rel="stylesheet" href="/_gai/gai.css" />
        <script src="/_gai/gai.js" defer />
      </>
    )
  }
  return <GaiPill host={host!} allowed={a.allowed} skip={process.env.GAI_SKIP || ''} bottom={Number(process.env.GAI_BOTTOM) || 18} />
}
