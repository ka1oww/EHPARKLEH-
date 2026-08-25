import { getAvailability } from '@/availability'
import { formatLotCount, statusLine, LED_TEXT } from '@/lots'
import { formatStaleCount } from '@/stale'
import type { FeedFreshness } from '@/freshness'

// The detail moment: a full-width gantry board, the way you read a car park
// from the road. One big mono count and, under it, what the count is.
//
// The eyebrow says "LOTS NOW" only when the feed really is now. A recent or
// saved count gets its own wording instead, because a board that claims
// nowness over a stale number is the one thing a parking sign must never do.
const EYEBROW: Record<FeedFreshness, string> = {
  fresh: 'LOTS NOW · LIVE',
  recent: 'LOTS · RECENT UPDATE',
  saved: 'LOTS · SAVED COUNT',
}

interface Props {
  available: number | null
  total: number | null
  freshness?: FeedFreshness
  /** A quiet second line, e.g. the rate summary. */
  note?: string | null
  /** The feed could not be reached: the board reads `~060`, not `060`. */
  stale?: boolean
}

export function GantryHero({ available, total, freshness = 'fresh', note, stale = false }: Props) {
  const a = getAvailability(available, total)

  return (
    <div className="flex items-end justify-between gap-3 rounded-lg bg-board px-4 py-3.5">
      <div className="flex min-w-0 flex-col gap-1">
        <span
          className={`font-data text-[40px] leading-none font-bold tabular-nums ${stale ? 'text-board-muted' : LED_TEXT[a.state]}`}
          role="img"
          aria-label={
            a.state === 'nodata'
              ? 'No live lot data'
              : `${a.available} of ${a.total} lots available, ${a.label}${stale ? ', saved count' : ''}`
          }
        >
          {stale ? formatStaleCount(a.available) : formatLotCount(a.available)}
        </span>
        <span className="board-eyebrow">
          {a.state === 'nodata' ? 'NO LIVE COUNT' : EYEBROW[freshness]}
        </span>
      </div>
      <div className="flex min-w-0 shrink flex-col items-end gap-1 text-right">
        <span className="text-[13px] font-extrabold text-panel">
          {statusLine(a.state, a.available)}
        </span>
        {note && <span className="text-[11px] text-board-muted">{note}</span>}
      </div>
    </div>
  )
}

// The ERP homage: a navy board with amber dot-matrix text. It is a joke that
// only lands if it is rare — ERP charges you, this tells you where you park
// free — so it is reserved for a genuinely notable rate fact and is never
// permanent chrome. Callers pass null far more often than not.
export function ErpStrip({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center rounded-md bg-erp-navy px-3 py-2">
      <span className="dot-matrix text-[11px] text-erp-amber">{text}</span>
    </div>
  )
}
