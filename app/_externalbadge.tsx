import {
  blockActivityLabel,
  isBlockClosed,
  vendorById,
  type Component,
  type Vendor,
} from '@/lib/data'

// One line per block under the part name. Reads as "<activity> · <vendor>"
// for live shipments and "已回 · <activity> · <vendor>" once everything's
// back. The activity is the boss's word (外发氧化, 外发CNC, …) — falls
// back to the derived stage label for legacy blocks predating the field.
export function ExternalBadge({
  component,
  vendors,
}: {
  component: Component
  vendors: Vendor[]
}) {
  const blocks = component.outsourceBlocks ?? []
  if (blocks.length === 0) return null
  const open = blocks.filter((b) => !isBlockClosed(b))
  const closed = blocks.filter((b) => isBlockClosed(b))
  return (
    <div className="mt-0.5 flex flex-col leading-tight">
      {open.map((b) => {
        const vendor = vendorById(b.vendorId, vendors)
        return (
          <span
            key={b.id}
            className="text-[10px] tracking-wider text-[var(--color-warning)]"
          >
            {blockActivityLabel(b)} · {vendor?.name ?? b.vendorId}
          </span>
        )
      })}
      {closed.map((b) => {
        const vendor = vendorById(b.vendorId, vendors)
        return (
          <span
            key={b.id}
            className="text-[10px] tracking-wider text-[var(--color-ink-3)]"
          >
            已回 · {blockActivityLabel(b)} · {vendor?.name ?? b.vendorId}
          </span>
        )
      })}
    </div>
  )
}
