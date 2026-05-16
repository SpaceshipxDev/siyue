'use client'

// Premium minimalist star toggle. Bright-yellow filled when pinned (the
// boss's mark) with a darker amber stroke so it reads at any size against
// the warm-paper field. Outline-only when unpinned.
//
// Controlled component: the parent supplies `pinned` and the `onToggle`
// callback (which gets the NEXT desired state). The parent is also
// responsible for firing the server mutate and showing a toast — this
// keeps the same star reusable across the two different pin kinds (per-
// station job_stage_pins and the row-level master-grid pin on jobs.pinned_at).

export function PinStar({
  pinned,
  canPin,
  size = 18,
  label,
  onToggle,
}: {
  pinned: boolean
  /** Whether the current viewer is allowed to flip the pin. Workers see
   * the filled star (read-only) when pinned, nothing when not. */
  canPin: boolean
  size?: number
  /** Tooltip / aria-label override. Defaults to a generic "置顶 / 取消置顶". */
  label?: string
  /** Called on click with the next pin state. Parent runs the mutate. */
  onToggle?: (next: boolean) => void
}) {
  const onClick = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!canPin) return
    onToggle?.(!pinned)
  }

  const finalLabel = label ?? (pinned ? '取消置顶' : '置顶')

  if (!canPin) {
    if (!pinned) {
      return (
        <span
          className="inline-block"
          style={{ width: size, height: size }}
          aria-hidden="true"
        />
      )
    }
    return (
      <span
        className="inline-flex items-center justify-center text-[var(--color-pin,#facc15)]"
        style={{ width: size, height: size }}
        aria-label={finalLabel}
        title={finalLabel}
      >
        <StarGlyph filled size={size} />
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pinned}
      aria-label={finalLabel}
      title={finalLabel}
      className={`pin-star group/star inline-flex items-center justify-center rounded-full transition-colors ${
        pinned
          ? 'text-[var(--color-pin,#facc15)]'
          : 'text-[var(--color-ink-3)] hover:text-[var(--color-pin,#facc15)]'
      }`}
      style={{ width: size + 6, height: size + 6 }}
    >
      <span
        className={`pin-star-glyph inline-flex ${pinned ? 'pin-star-pop' : ''}`}
      >
        <StarGlyph filled={pinned} size={size} />
      </span>
      <style jsx>{`
        .pin-star-glyph {
          transition: transform 160ms cubic-bezier(0.16, 1, 0.3, 1);
        }
        .pin-star:hover .pin-star-glyph {
          transform: scale(1.1);
        }
        .pin-star:active .pin-star-glyph {
          transform: scale(0.92);
        }
        .pin-star-pop {
          animation: pin-star-pop 260ms cubic-bezier(0.16, 1, 0.3, 1);
        }
        @keyframes pin-star-pop {
          0% {
            transform: scale(0.6) rotate(-12deg);
          }
          55% {
            transform: scale(1.22) rotate(6deg);
          }
          100% {
            transform: scale(1) rotate(0);
          }
        }
      `}</style>
    </button>
  )
}

function StarGlyph({ filled, size }: { filled: boolean; size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3.2 14.6 9.05 21 9.78 16.2 14.06 17.5 20.4 12 17.18 6.5 20.4 7.8 14.06 3 9.78 9.4 9.05Z" />
    </svg>
  )
}
