// How a lot count is written on a Kopi Signboard gantry board.
//
// This is presentation only: `availability.ts` still decides what the numbers
// mean, and this module decides how they read. Counts are always three mono
// digits (062) so a column of them lines up like a real car-park board, and a
// carpark with nothing left says FULL rather than 000 — the word is what a
// driver actually needs at a glance.

import type { AvailState } from './availability'

/** No live feed: an unlit board, not a zero. */
export const NO_COUNT = '---'

export function formatLotCount(available: number | null): string {
  if (available === null) return NO_COUNT
  if (available <= 0) return 'FULL'
  // Counts past 999 keep every digit; padding is a minimum, not a width.
  return String(available).padStart(3, '0')
}

/** True when the board reads FULL, which is also what fades the row in a list. */
export function isFullHouse(available: number | null): boolean {
  return available !== null && available <= 0
}

// The spoken half of the design's voice. Used only where one carpark is the
// subject — a detail hero or a map popup — never as a column label in a list.
// The plain-English labels in `availability.ts` stay the accessible name.
const STATUS_LINE: Record<AvailState, string> = {
  free: 'steady, got lots',
  some: 'filling up already',
  full: 'almost gone',
  nodata: 'no live count',
}

export function statusLine(state: AvailState, available: number | null): string {
  if (isFullHouse(available)) return 'full house'
  return STATUS_LINE[state]
}

/** Availability colour on a light surface (list rows, cards). */
export const AVAIL_TEXT: Record<AvailState, string> = {
  free: 'text-avail-free',
  some: 'text-avail-some',
  full: 'text-avail-full',
  nodata: 'text-avail-none',
}

/** Availability colour on a lit gantry board, which is dark in both themes. */
export const LED_TEXT: Record<AvailState, string> = {
  free: 'text-led-free',
  some: 'text-led-some',
  full: 'text-led-full',
  nodata: 'text-board-muted',
}

/** Same, as raw hex, for the map pins and popups Leaflet renders as HTML. */
export const LED_HEX: Record<AvailState, string> = {
  free: '#4CE28A',
  some: '#E8A020',
  full: '#FF6157',
  nodata: '#9B957F',
}
