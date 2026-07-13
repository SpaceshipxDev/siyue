// caiwu-lab — a self-contained, DB-free, public design preview for the caiwu
// (finance clerk) redesign. Three prototypes over one shared mock dataset.
// Lives entirely under app/caiwu-lab/ so it is trivially deletable and never
// touches /finance until a winner is picked. Reachable without login: see the
// '/caiwu-lab' entry added to PUBLIC_PATHS in proxy.ts (remove when promoting).

import CaiwuLab from './_lab'

export const dynamic = 'force-dynamic'

export default async function CaiwuLabPage({
  searchParams,
}: {
  searchParams: Promise<{ design?: string }>
}) {
  const sp = await searchParams
  return <CaiwuLab initialDesign={sp.design ?? 'huozhang'} />
}
