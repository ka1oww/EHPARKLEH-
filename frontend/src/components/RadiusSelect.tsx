import { cn } from '@/lib/utils'

const RADIUS_OPTIONS = [250, 500, 1000, 2000] as const

/** The widest search this selector offers — what "Show nearest" reaches for. */
export const MAX_RADIUS = RADIUS_OPTIONS[RADIUS_OPTIONS.length - 1]

function fmt(r: number): string {
  return r >= 1000 ? `${r / 1000}km` : `${r}m`
}

interface Props {
  value: number
  onChange: (r: number) => void
  className?: string
}

// Segmented radius selector. The active segment is the kaya signboard.
export function RadiusSelect({ value, onChange, className }: Props) {
  return (
    <div
      role="radiogroup"
      aria-label="Search radius"
      className={cn(
        'inline-flex items-center gap-1 rounded-full border-[1.5px] border-hairline bg-panel/60 p-1',
        className,
      )}
    >
      {RADIUS_OPTIONS.map((r) => {
        const active = value === r
        return (
          <button
            key={r}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(r)}
            className={cn(
              'font-data min-h-11 rounded-full px-3 py-2 text-xs font-bold tabular-nums transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
              active
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {fmt(r)}
          </button>
        )
      })}
    </div>
  )
}
