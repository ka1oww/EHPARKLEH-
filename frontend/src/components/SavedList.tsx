import { Star } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getAvailability } from '@/availability'
import { formatLotCount, statusLine, AVAIL_TEXT } from '@/lots'
import { formatLastSeen, formatStaleCount } from '@/stale'
import type { FeedFreshness } from '@/freshness'
import type { SavedCarpark } from '@/useSavedCarparks'

/** The live count for a saved carpark, when the current search happens to hold one. */
export interface LiveCount {
  available: number | null
  total: number | null
}

interface Props {
  saved: SavedCarpark[]
  /** Live counts by carpark id, from the results currently on screen. */
  liveCounts: Record<string, LiveCount>
  freshness: FeedFreshness
  /** When the counts in `liveCounts` were fetched. */
  dataAsOf: number | null
  selectedId: string | null
  onSelect: (id: string) => void
  onUnsave: (id: string) => void
  now?: number
}

// The Saved artboard's nudge card ("usually fills by 9 am") is deliberately not
// here. The app keeps no history of a carpark's day, so any such line would be
// a guess wearing the clothes of a fact. When there is data behind it, it can
// come back.

function SavedRow({
  item,
  live,
  freshness,
  dataAsOf,
  selected,
  onSelect,
  onUnsave,
  now,
}: {
  item: SavedCarpark
  live: LiveCount | undefined
  freshness: FeedFreshness
  dataAsOf: number | null
  selected: boolean
  onSelect: (id: string) => void
  onUnsave: (id: string) => void
  now?: number
}) {
  // A count is "live" only when this search actually returned it and the feed
  // behind it is current. Anything else is a number we once saw, and it is
  // written as one.
  const isLive = live !== undefined && live.available !== null && freshness !== 'saved'
  const available = isLive ? live.available : item.lastLots
  const total = isLive ? live.total : item.lastTotal
  const a = getAvailability(available, total)
  const seenAgo = formatLastSeen(isLive ? dataAsOf : item.lastSeenAt, now, { short: true })

  return (
    <li
      className={cn(
        'relative rounded-lg border-[1.5px] bg-card p-3.5 shadow-sm transition-all',
        selected ? 'border-primary ring-1 ring-primary' : 'border-hairline',
      )}
    >
      <button
        type="button"
        onClick={() => onSelect(item.id)}
        aria-pressed={selected}
        aria-label={`Show ${item.title} on map`}
        className="absolute inset-0 z-[1] cursor-pointer rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      />
      <div className="pointer-events-none relative z-[2] flex flex-col gap-1.5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            <button
              type="button"
              onClick={() => onUnsave(item.id)}
              aria-label={`Remove ${item.title} from saved`}
              className="pointer-events-auto -m-2.5 inline-flex size-11 shrink-0 items-center justify-center rounded-md text-kopi transition-colors hover:text-kaya-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Star className="size-4 fill-current" aria-hidden="true" />
            </button>
            <span className="min-w-0 text-[15px] leading-snug font-extrabold break-words text-ink">
              {item.title}
            </span>
          </div>
          <span
            className={cn(
              'font-data shrink-0 text-[17px] font-bold tabular-nums',
              isLive ? AVAIL_TEXT[a.state] : 'text-avail-none',
            )}
            role="img"
            aria-label={
              a.state === 'nodata'
                ? `${item.title}: no lot count`
                : `${item.title}: ${a.available} of ${a.total} lots, ${isLive ? a.label : 'saved count'}`
            }
          >
            {isLive ? formatLotCount(a.available) : formatStaleCount(a.available)}
          </span>
        </div>
        {item.subLabel && <span className="text-xs text-slate-body">{item.subLabel}</span>}
        <span
          className={cn(
            'text-xs font-bold',
            isLive ? 'text-link' : 'text-muted-foreground',
          )}
        >
          {isLive
            ? `${statusLine(a.state, a.available)} !`
            : seenAgo
              ? `saved count · last seen ${seenAgo}`
              : 'no count saved yet'}
        </span>
      </div>
    </li>
  )
}

export function SavedList({
  saved,
  liveCounts,
  freshness,
  dataAsOf,
  selectedId,
  onSelect,
  onUnsave,
  now,
}: Props) {
  if (saved.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
        <Star className="size-9 text-kopi" aria-hidden="true" />
        <p className="font-display text-xl font-extrabold text-ink">Nothing saved yet</p>
        <p className="max-w-[290px] text-sm leading-relaxed text-slate-body">
          Tap the star on a carpark and it stays here — your usual spots, with their counts, one
          screen away.
        </p>
      </div>
    )
  }

  const anyLive =
    freshness !== 'saved' &&
    saved.some((s) => liveCounts[s.id] !== undefined && liveCounts[s.id].available !== null)

  return (
    <div className="flex flex-col gap-2.5">
      <p className="sr-only" aria-live="polite">
        {saved.length} saved carpark{saved.length === 1 ? '' : 's'}
        {anyLive ? ', with live lot counts' : ', showing saved lot counts'}
      </p>
      <p
        aria-hidden="true"
        className="px-0.5 text-[11px] font-extrabold tracking-[0.1em] text-eyebrow uppercase"
      >
        <span className="font-data tabular-nums">{saved.length}</span> saved ·{' '}
        {anyLive ? 'live lots' : 'saved counts'}
      </p>
      <ul className="flex flex-col gap-2.5">
        {saved.map((item) => (
          <SavedRow
            key={item.id}
            item={item}
            live={liveCounts[item.id]}
            freshness={freshness}
            dataAsOf={dataAsOf}
            selected={selectedId === item.id}
            onSelect={onSelect}
            onUnsave={onUnsave}
            now={now}
          />
        ))}
      </ul>
    </div>
  )
}
