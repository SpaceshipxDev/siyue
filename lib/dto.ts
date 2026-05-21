import type { Job, OutsourceBlock, Vendor } from './data'
import type { StationItem, StationJob } from './db'
import type { MasterRow } from './master'
import type { Scope } from './auth'
import { canSeeCustomerData, canSeeMoney, canSeeVendor } from './auth'

// Field-level scrub keyed off Scope (role + defaultStage). 出货 station heads
// see customer data + customer-facing fields like commerce; vendor info and
// money stay commerce-only. job.notes is intentionally NOT scrubbed — it's a
// shared remarks field everyone (production + commerce) can read and edit.
// Pass the AuthUser straight through — it satisfies the Scope shape.

const REDACTED_VENDOR_ID = '__redacted__'

export function scrubBlock(b: OutsourceBlock, scope: Scope): OutsourceBlock {
  const vendorOk = canSeeVendor(scope)
  const moneyOk = canSeeMoney(scope)
  if (vendorOk && moneyOk) return b
  if (!vendorOk) {
    // No vendor visibility → strip everything (legacy production behavior).
    return {
      ...b,
      vendorId: REDACTED_VENDOR_ID,
      amountCny: 0,
      notes: undefined,
      docNo: undefined,
      createdBy: undefined,
      recipientAddress: undefined,
      recipientContactName: undefined,
      recipientContactPhone: undefined,
    }
  }
  // Vendor visible but no money (PMC, 工程 head): keep vendor + dates +
  // members so they can run the outsource handoff, but blank out prices.
  return {
    ...b,
    amountCny: null,
    members: b.members.map((m) => ({ ...m, unitPriceCny: undefined })),
  }
}

export function scrubJob(job: Job, scope: Scope): Job {
  const customerOk = canSeeCustomerData(scope)
  const moneyOk = canSeeMoney(scope)
  if (customerOk && moneyOk && canSeeVendor(scope)) return job
  return {
    ...job,
    customer: customerOk ? job.customer : '',
    customerId: customerOk ? job.customerId : undefined,
    amountCny: moneyOk ? job.amountCny : undefined,
    contractNo: customerOk ? job.contractNo : undefined,
    batchNo: customerOk ? job.batchNo : undefined,
    engineer: customerOk ? job.engineer : undefined,
    createdBy: moneyOk ? job.createdBy : undefined,
    sourceFileUrl: moneyOk ? job.sourceFileUrl : undefined,
    components: job.components.map((c) => ({
      ...c,
      unitPriceCny: moneyOk ? c.unitPriceCny : undefined,
      lineTotalCny: moneyOk ? c.lineTotalCny : undefined,
      outsourceBlocks: c.outsourceBlocks
        ? c.outsourceBlocks.map((b) => scrubBlock(b, scope))
        : undefined,
    })),
  }
}

export function scrubStationJob(j: StationJob, scope: Scope): StationJob {
  if (canSeeCustomerData(scope)) return j
  return { ...j, customer: '' }
}

export function scrubStationItem(it: StationItem, scope: Scope): StationItem {
  if (canSeeCustomerData(scope)) return it
  return { ...it, customer: '' }
}

export function scrubVendor(v: Vendor, scope: Scope): Vendor {
  if (canSeeVendor(scope)) return v
  return { id: v.id, name: '', notes: undefined, address: undefined }
}

export function scrubVendors(vendors: Vendor[], scope: Scope): Vendor[] {
  if (canSeeVendor(scope)) return vendors
  return vendors.map((v) => scrubVendor(v, scope))
}

// MasterRow has fewer leakable fields than Job since the rollup view does
// not carry vendor names, customer contact, contractNo, etc. — only the
// money + customer-name pair survive from scrubJob's concerns.
export function scrubMasterRow(row: MasterRow, scope: Scope): MasterRow {
  const customerOk = canSeeCustomerData(scope)
  const moneyOk = canSeeMoney(scope)
  if (customerOk && moneyOk) return row
  return {
    ...row,
    customer: customerOk ? row.customer : '',
    amountCny: moneyOk ? row.amountCny : undefined,
    externalSpendCny: moneyOk ? row.externalSpendCny : 0,
    marginCny: moneyOk ? row.marginCny : undefined,
  }
}
