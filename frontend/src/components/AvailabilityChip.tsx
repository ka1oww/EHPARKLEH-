import { cn } from '@/lib/utils'
import { getAvailability, type AvailState } from '@/availability'

// The signature element: a garage-entrance LED counter.
// A dark rounded chip with mono text like `P · 42 LOTS`, colour-coded by
// availability (emerald / amber / red), evoking a car-park gantry display.

const STATE_DOT: Record<AvailState, string> = {
  free: 'bg-avail-free',
  some: 'bg-avail-some',
  full: 'bg-avail-full',
  nodata: 'bg-slate-400',
}

// Lighter shades than the marker dots: this text sits on the dark LED chip, so
// it must clear WCAG AA contrast (the saturated -600 shades do not on near-black).
const STATE_TEXT: Record<AvailState, string> = {
  free: 'text-emerald-400',
  some: 'text-amber-300',
  full: 'text-red-400',
  nodata: 'text-slate-300',
}

interface Props {
  available: number | null
  total: number | null
  /** Show the status word ("Plenty" etc.) beside the chip. */
  showLabel?: boolean
  className?: string
}

export function AvailabilityChip({ available, total, showLabel = true, className }: Props) {
  const a = getAvailability(available, total)

  return (
    <div className={cn('inline-flex items-center gap-2.5', className)}>
      <div
        className="inline-flex items-center gap-2 rounded-lg bg-led px-2.5 py-1.5 shadow-sm ring-1 ring-white/5"
        role="img"
        aria-label={
          a.state === 'nodata'
            ? 'No live lot data'
            : `${a.available} of ${a.total} lots available, ${a.label}`
        }
      >
        <span
          className={cn(
            'led-dot-live size-2 rounded-full',
            STATE_DOT[a.state],
            a.state !== 'nodata' && 'shadow-[0_0_6px_currentColor]',
          )}
          aria-hidden="true"
        />
        <span className="font-data text-[11px] font-bold tracking-[0.12em] text-white/85">
          P
        </span>
        <span className="text-white/40" aria-hidden="true">
          ·
        </span>
        <span className={cn('font-data text-[13px] font-bold tabular-nums', STATE_TEXT[a.state])}>
          {a.state === 'nodata' ? 'NO DATA' : `${a.available} LOTS`}
        </span>
      </div>
      {showLabel && (
        <span className="text-xs font-medium text-muted-foreground">
          {a.state === 'nodata' ? 'No live data' : a.label}
          {a.state !== 'nodata' && a.total !== null && (
            <span className="font-data text-muted-foreground/70"> · of {a.total}</span>
          )}
        </span>
      )}
    </div>
  )
}
