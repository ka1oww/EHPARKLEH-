// How the app writes a number it can no longer vouch for.
//
// The Offline artboard is emphatic about one rule: a count we could not
// refresh is never printed as if it were live. It gets a tilde and a
// last-seen time, and the screen says so in words. These helpers are the only
// place that wording is decided, so the list, the saved view and the offline
// panel cannot drift apart on it.

import { formatLotCount, NO_COUNT } from './lots'

/** A count we last saw some time ago: `~060`, never `060`. */
export function formatStaleCount(available: number | null): string {
  const count = formatLotCount(available)
  return count === NO_COUNT ? count : `~${count}`
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`
}

/**
 * "12 minutes ago" — or "12 min ago" in `short` form, which is what the
 * artboard writes on a card row where the long phrase would wrap.
 *
 * A future or unknown timestamp yields null rather than a nonsense age: the
 * caller then simply omits the clause instead of claiming an age it does not
 * have.
 */
export function formatLastSeen(
  ts: number | null | undefined,
  now: number = Date.now(),
  opts: { short?: boolean } = {},
): string | null {
  if (ts == null || !Number.isFinite(ts)) return null
  const delta = now - ts
  if (delta < 0) return null
  if (delta < MINUTE) return 'just now'
  const short = opts.short ?? false
  if (delta < HOUR) {
    const mins = Math.floor(delta / MINUTE)
    return short ? `${mins} min ago` : `${plural(mins, 'minute')} ago`
  }
  if (delta < DAY) {
    const hours = Math.floor(delta / HOUR)
    return short ? `${hours} hr ago` : `${plural(hours, 'hour')} ago`
  }
  const days = Math.floor(delta / DAY)
  return `${plural(days, 'day')} ago`
}
