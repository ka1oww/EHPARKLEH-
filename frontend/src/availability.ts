// Shared availability logic for the gantry-board lot counter.
//
// Turns raw (available, total) lot counts into a colour-coded state so the
// CarparkCard, the Leaflet map popup, and any other surface stay consistent.

export type AvailState = 'free' | 'some' | 'full' | 'nodata'

export interface Availability {
  state: AvailState
  /** Short status word, e.g. "Plenty", "Filling up". */
  label: string
  /** Lots free, or null when there's no live data. */
  available: number | null
  total: number | null
}

/**
 * Classify availability from live lot counts.
 *
 * Thresholds preserved from the original UI:
 *   > 40% free -> plenty, > 10% -> filling up, else almost full / no lots.
 */
export function getAvailability(
  available: number | null,
  total: number | null,
): Availability {
  if (available === null || total === null || total === 0) {
    return { state: 'nodata', label: 'No live data', available: null, total: null }
  }
  const pct = available / total
  if (pct > 0.4) return { state: 'free', label: 'Plenty', available, total }
  if (pct > 0.1) return { state: 'some', label: 'Filling up', available, total }
  if (available > 0) return { state: 'full', label: 'Almost full', available, total }
  return { state: 'full', label: 'No lots', available, total }
}

/** Hex colour for the map marker matching the availability state. */
export function availColor(state: AvailState): string {
  switch (state) {
    case 'free':
      return '#1C6E4A'
    case 'some':
      return '#E8A020'
    case 'full':
      return '#C8342A'
    default:
      return '#98917F'
  }
}
