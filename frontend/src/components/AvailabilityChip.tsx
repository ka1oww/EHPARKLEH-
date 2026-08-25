import { cn } from '@/lib/utils'
import { getAvailability, type AvailState } from '@/availability'
import { formatLotCount, AVAIL_TEXT, LED_TEXT } from '@/lots'

// The signature element: a car-park gantry board.
//
// Two ways to wear it. `board` is the lit ink panel — a dark sign carrying a
// mono LED count, for the map and for the one carpark a screen is about.
// `plain` is the same count with the board taken away, for a list row, where a
// column of dark panels would fight the cards it sits in.

const STATE_DOT: Record<AvailState, string> = {
  free: 'bg-avail-free',
  some: 'bg-avail-some',
  full: 'bg-avail-full',
  nodata: 'bg-avail-none',
}

interface Props {
  available: number | null
  total: number | null
  /** Show the status word ("Plenty" etc.) beside the board. */
  showLabel?: boolean
  variant?: 'board' | 'plain'
  className?: string
}

export function AvailabilityChip({
  available,
  total,
  showLabel = true,
  variant = 'board',
  className,
}: Props) {
  const a = getAvailability(available, total)
  const count = formatLotCount(a.available)
  // The accessible name stays plain English and keeps the denominator, which
  // the board itself drops — a screen reader has no glance to optimise for.
  const ariaLabel =
    a.state === 'nodata'
      ? 'No live lot data'
      : `${a.available} of ${a.total} lots available, ${a.label}`

  const label = showLabel && (
    <span className="text-xs font-semibold text-muted-foreground">
      {a.state === 'nodata' ? 'No live data' : a.label}
      {a.state !== 'nodata' && a.total !== null && (
        <span className="font-data font-normal text-muted-foreground/70"> · of {a.total}</span>
      )}
    </span>
  )

  if (variant === 'plain') {
    return (
      <div className={cn('inline-flex items-center gap-2.5', className)}>
        <span
          className={cn('font-data text-[17px] font-bold tabular-nums', AVAIL_TEXT[a.state])}
          role="img"
          aria-label={ariaLabel}
        >
          {count}
        </span>
        {label}
      </div>
    )
  }

  return (
    <div className={cn('inline-flex items-center gap-2.5', className)}>
      <div className="gantry" data-state={a.state} role="img" aria-label={ariaLabel}>
        <span
          className={cn(
            'led-dot-live size-2 rounded-full',
            STATE_DOT[a.state],
            a.state !== 'nodata' && 'shadow-[0_0_6px_currentColor]',
          )}
          aria-hidden="true"
        />
        <span className={cn('font-data tabular-nums', LED_TEXT[a.state])}>{count}</span>
        <span className="board-eyebrow" aria-hidden="true">
          LOTS
        </span>
      </div>
      {label}
    </div>
  )
}
