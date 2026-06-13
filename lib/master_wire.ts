import { canSeeCustomerData, type Scope } from './auth'
import { scrubMasterRow } from './dto'
import type { MasterRow } from './master'

// Server→client wire prep for the master grid rows (app/api/master/rows).
//
// The dashboard used to ship all ~660 rows as React Server Component props
// into the client grid — a 3.3MB tree the server SSR-rendered + Flight-
// serialized on a single thread (~2.4s, the measured bottleneck). The grid
// now fetches this JSON instead, so the page render is O(1) and the rows
// stream as a plain cacheable XHR decoupled from the HTML document.
//
// Two concerns handled here:
//  1. Field-level scrubbing (scrubMasterRow) — production scopes lose
//     customer / 工程师 / money, exactly as page.tsx did before props.
//  2. search_haystack strip — the haystack is a lowercased blob of
//     customer / product / contract / 工程师 / notes text the floor must
//     never receive. Scopes that can't see customer data (production, not
//     出货) search 工号 only (isJobNoOnlySearch === !canSeeCustomerData), so
//     they have no use for it AND it's the single largest per-row string.
//     Money/customer scopes keep it (they substring-search it client-side).
export function toMasterWireRows(rows: MasterRow[], scope: Scope): MasterRow[] {
  const customerOk = canSeeCustomerData(scope)
  return rows.map((r) => {
    const scrubbed = scrubMasterRow(r, scope)
    if (customerOk) return scrubbed
    // Drop the haystack for jobNo-only scopes — both a PII fix and a payload
    // win on the mainland↔HK link.
    return scrubbed.searchHaystack ? { ...scrubbed, searchHaystack: '' } : scrubbed
  })
}
