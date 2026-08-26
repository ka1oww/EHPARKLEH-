// Price sorting for the merged carpark list.
//
// `first_hour` is a per-HOUR price while `subsequent_half_hour` is per
// HALF-HOUR, so they are only comparable once they share a unit. The list
// sorts by what the first hour costs: carparks that publish a first-hour rate
// use it directly; flat "$X / 30 min" carparks (most HDB/URA ones, which have
// no separate first-hour field) cost twice that per hour. Anything without a
// usable price returns Infinity so unknowns sink below every priced entry.

import type { ParkingEntry } from './types'

export function priceValue(e: ParkingEntry): number {
  if (e.source !== 'hdb' || !e.rate.known) return Number.POSITIVE_INFINITY
  if (e.rate.first_hour != null) return e.rate.first_hour
  const halfHour = e.rate.subsequent_half_hour
  if (halfHour != null) return halfHour * 2
  return Number.POSITIVE_INFINITY
}
