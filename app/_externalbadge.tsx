import {
  isBlockClosed,
  outsourceLabel,
  vendorById,
  type Component,
  type Vendor,
} from '@/lib/data'

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
            外协 · {outsourceLabel(b.stages)} · {vendor?.name ?? b.vendorId}
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
            已外协 · {outsourceLabel(b.stages)} · {vendor?.name ?? b.vendorId}
          </span>
        )
      })}
    </div>
  )
}
