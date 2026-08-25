import { describe, it, expect } from 'vitest'
import { priceValue } from '@/pricing'
import type { Carpark, OsmParking, ParkingEntry, ResolvedRate } from '@/types'

// A priced HDB carpark: only `rate` varies across these tests.
function hdb(rate: Partial<ResolvedRate>): ParkingEntry {
  const base: Carpark = {
    id: 'T1',
    name: null,
    address: 'TEST CARPARK',
    lat: 1.3,
    lon: 103.8,
    distance_m: 100,
    lots_available: null,
    total_lots: null,
    type: null,
    category: null,
    rate: {
      known: false,
      summary: 'unknown',
      first_hour: null,
      subsequent_half_hour: null,
      weekday_raw: null,
      saturday_raw: null,
      sunday_ph_raw: null,
      ...rate,
    },
    free_parking_info: null,
    sources: ['hdb'],
    ev: false,
    ev_total: null,
    ev_available: null,
    ev_operators: [],
    ev_max_power_kw: null,
    carwash: false,
    carwash_operator: null,
  }
  return { ...base, source: 'hdb' }
}

function osm(): ParkingEntry {
  const base: OsmParking = {
    id: 'osm-1',
    name: 'OSM LOT',
    lat: 1.3,
    lon: 103.8,
    distance_m: 100,
    source: 'openstreetmap',
    fee: null,
    parking_type: null,
    capacity: null,
  }
  return { ...base, source: 'osm' }
}

describe('priceValue', () => {
  it('compares a flat $/30min carpark against a $/hour carpark in the same unit', () => {
    // Real shapes from the served dataset: most HDB carparks publish only
    // "$0.60 / 30 min" (subsequent_half_hour), while commercial ones publish
    // "$1.00 for 1st hr" (first_hour). $0.60 per half hour is $1.20 per hour,
    // so the commercial carpark is cheaper and must sort first.
    const hdbFlatHalfHour = hdb({ known: true, subsequent_half_hour: 0.6 })
    const hourlyFirstHour = hdb({ known: true, first_hour: 1.0 })

    expect([hdbFlatHalfHour, hourlyFirstHour].sort((a, b) => priceValue(a) - priceValue(b))).toEqual([
      hourlyFirstHour,
      hdbFlatHalfHour,
    ])
  })

  it('doubles a flat half-hour rate to its hourly equivalent', () => {
    // Albert-Centre-style central carpark: $1.20 / 30 min is really $2.40/hr.
    expect(priceValue(hdb({ known: true, subsequent_half_hour: 1.2 }))).toBe(2.4)
    expect(priceValue(hdb({ known: true, subsequent_half_hour: 0.6 }))).toBe(1.2)
  })

  it('uses first_hour as-is when published', () => {
    expect(
      priceValue(hdb({ known: true, first_hour: 2.2, subsequent_half_hour: 1.1 })),
    ).toBe(2.2)
  })

  it('sinks unknown-rate and OSM entries below every priced entry', () => {
    const priced = hdb({ known: true, subsequent_half_hour: 0.6 })
    const unpricedHdb = hdb({ known: true })
    const unknownHdb = hdb({})
    expect(priceValue(unpricedHdb)).toBe(Number.POSITIVE_INFINITY)
    expect(priceValue(unknownHdb)).toBe(Number.POSITIVE_INFINITY)
    expect(priceValue(osm())).toBe(Number.POSITIVE_INFINITY)

    const sorted = [unknownHdb, osm(), priced, unpricedHdb].sort(
      (a, b) => priceValue(a) - priceValue(b),
    )
    expect(sorted[0]).toBe(priced)
    // Stable sort: ties on Infinity keep their original relative order.
    expect(sorted.slice(1)).toEqual([unknownHdb, osm(), unpricedHdb])
  })
})
