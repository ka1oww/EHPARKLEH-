// Shared API types for the EhParkLeh frontend.
//
// These mirror the FastAPI/Pydantic response models in backend/main.py.
// Fields the backend marks Optional are `| null` (FastAPI serialises a missing
// optional as null), and a few legacy display fields the UI reads are typed as
// optional so behaviour stays identical during the TypeScript migration.

export interface LatLon {
  lat: number
  lon: number
}

/** /api/suggestions item. */
export interface Suggestion {
  address: string
  lat: number
  lon: number
}

/** /api/geocode result. */
export interface GeocodeResult {
  lat: number
  lon: number
  address: string
}

/** Resolved, plain-English-ish rate summary (backend ResolvedRate). */
export interface ResolvedRate {
  known: boolean
  summary: string
  first_hour: number | null
  subsequent_half_hour: number | null
  weekday_raw: string | null
  saturday_raw: string | null
  sunday_ph_raw: string | null
}

/** /api/carparks item (backend Carpark model). */
export interface Carpark {
  id: string
  name: string | null
  address: string
  lat: number
  lon: number
  distance_m: number
  lots_available: number | null
  total_lots: number | null
  type: string | null
  category: string | null
  rate: ResolvedRate
  free_parking_info: string | null
  sources: string[]
  // Legacy display fields read by the existing UI. Kept optional so behaviour
  // is preserved verbatim during the migration.
  cost_per_30min?: number
  free_parking?: boolean
  zone?: string
}

/** /api/parking/osm item (backend OsmParking model). */
export interface OsmParking {
  id: string
  name: string
  lat: number
  lon: number
  distance_m: number
  source: string
  fee: string | null
  parking_type: string | null
  capacity: string | null
}

/** Discriminated union used by the merged list rendering in App.
 * The `source` literal is the discriminant: 'hdb' for gov carparks, 'osm' for
 * OpenStreetMap parking. */
export type ParkingEntry =
  | (Carpark & { source: 'hdb' })
  | (OsmParking & { source: 'osm' })
