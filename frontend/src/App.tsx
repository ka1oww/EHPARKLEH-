import { useState, useEffect } from 'react'
import { List, Map as MapIcon, Coffee, AlertCircle, Compass } from 'lucide-react'
import Map from './Map'
import { getCurrentPosition } from './geo'
import { cn } from '@/lib/utils'
import { SearchBar } from '@/components/SearchBar'
import { FilterBar } from '@/components/FilterBar'
import { CarparkCard } from '@/components/CarparkCard'
import { Skeleton } from '@/components/ui/skeleton'
import type {
  Carpark,
  OsmParking,
  Suggestion,
  GeocodeResult,
  LatLon,
  ParkingEntry,
} from './types'

// Backend base URL. Override via VITE_API_BASE in frontend/.env; falls back to
// the deployed Render backend so existing builds keep working unchanged.
const API_BASE = import.meta.env.VITE_API_BASE || 'https://ehparkleh-backend.onrender.com'

// Distance (m) below which a live-OSM pin is treated as the same carpark as an
// already-deduped enriched entry, and dropped.
const OSM_DEDUP_M = 60

// Rough great-circle distance in metres.
function metresBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371000
  const p1 = (aLat * Math.PI) / 180
  const p2 = (bLat * Math.PI) / 180
  const dp = ((bLat - aLat) * Math.PI) / 180
  const dl = ((bLon - aLon) * Math.PI) / 180
  const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(x))
}

function MapLegend() {
  const items = [
    { color: '#4338CA', label: 'Destination' },
    { color: '#16a34a', label: 'Free' },
    { color: '#f59e0b', label: 'Filling' },
    { color: '#ef4444', label: 'Full' },
    { color: '#2563EB', label: 'You' },
  ]
  return (
    <div className="pointer-events-none absolute top-3 left-3 z-[400] flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-hairline bg-white/90 px-3 py-2 text-[11px] font-medium text-slate-body shadow-sm backdrop-blur">
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5">
          <span
            className="size-2.5 rounded-full ring-1 ring-white"
            style={{ backgroundColor: it.color }}
          />
          {it.label}
        </span>
      ))}
    </div>
  )
}

export default function App() {
  const [userLocation, setUserLocation] = useState<LatLon | null>(null)
  const [mobileTab, setMobileTab] = useState<'list' | 'map'>('list')
  const [radius, setRadius] = useState(500)
  const [category, setCategory] = useState<string | null>(null)
  const [freeNow, setFreeNow] = useState(false)
  const [hasLots, setHasLots] = useState(false)
  const [carparks, setCarparks] = useState<Carpark[]>([])
  const [osmParking, setOsmParking] = useState<OsmParking[]>([])
  const [center, setCenter] = useState<LatLon | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    // Native (Capacitor) or web geolocation; silently ignore failures here.
    getCurrentPosition()
      .then((loc) => setUserLocation(loc))
      .catch(() => {})
  }, [])

  // Re-run the last search whenever a filter changes, so list + map stay in sync.
  useEffect(() => {
    if (center) search(center.lat, center.lon)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [radius, category, freeNow, hasLots])

  async function search(lat: number, lon: number) {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({
        lat: String(lat),
        lon: String(lon),
        radius: String(radius),
      })
      if (category) params.set('category', category)
      if (freeNow) params.set('free_now', 'true')
      if (hasLots) params.set('has_lots', 'true')

      const [hdbRes, osmRes] = await Promise.all([
        fetch(`${API_BASE}/api/carparks?${params.toString()}`),
        fetch(`${API_BASE}/api/parking/osm?lat=${lat}&lon=${lon}&radius=${radius}`),
      ])
      // A non-OK carparks response is a server error, not an empty result: let
      // it fall to the catch so the user sees "can't reach the server" rather
      // than a misleading "no spots found".
      if (!hdbRes.ok) throw new Error(`carparks ${hdbRes.status}`)
      const hdbData: Carpark[] = await hdbRes.json()
      const osmData: OsmParking[] = osmRes.ok ? await osmRes.json() : []
      setCarparks(hdbData)
      setOsmParking(osmData)
      setCenter({ lat, lon })
      setSelected(null)
      if (hdbData.length === 0 && osmData.length === 0) {
        setError('No spots found here. Try a larger radius or fewer filters.')
      }
    } catch {
      setError("Can't reach the server right now. Please try again shortly.")
    }
    setLoading(false)
  }

  async function handleSubmit(query: string) {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${API_BASE}/api/geocode?q=${encodeURIComponent(query)}`)
      if (!res.ok) {
        setError("Couldn't find that place. Try another search.")
        setLoading(false)
        return
      }
      const { lat, lon }: GeocodeResult = await res.json()
      await search(lat, lon)
    } catch {
      setError("Can't reach the server right now. Please try again shortly.")
      setLoading(false)
    }
  }

  function handlePickSuggestion(s: Suggestion) {
    search(s.lat, s.lon)
  }

  function handleNearMe() {
    getCurrentPosition()
      .then((loc) => search(loc.lat, loc.lon))
      .catch(() => setError('Could not get your location. Please allow location access.'))
  }

  function handleSelectEntry(id: string) {
    setSelected(id === selected ? null : id)
    setMobileTab('map')
  }

  // The enriched dataset is already deduped, but the live OSM layer is not, so
  // drop OSM pins that sit on top of an enriched carpark (otherwise dense areas
  // render two markers for one physical carpark).
  const dedupedOsm = osmParking.filter(
    (o) => !carparks.some((c) => metresBetween(o.lat, o.lon, c.lat, c.lon) < OSM_DEDUP_M),
  )

  const allParking: ParkingEntry[] = [
    ...carparks.map((cp): ParkingEntry => ({ ...cp, source: 'hdb' })),
    ...dedupedOsm.map((cp): ParkingEntry => ({ ...cp, source: 'osm' })),
  ].sort((a, b) => a.distance_m - b.distance_m)

  const totalNearby = allParking.length

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Indigo command bar */}
      <header className="z-20 shrink-0 bg-ink text-white shadow-md">
        <div className="mx-auto w-full max-w-screen-2xl px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3">
          <div className="flex items-center justify-between gap-3 pb-3">
            <div className="flex items-center gap-2.5">
              <img src="/brand-car.svg" className="size-8" alt="" />
              <div className="leading-none">
                <h1 className="font-display text-lg font-bold tracking-tight">
                  EhParkLeh
                </h1>
                <span className="text-[11px] font-medium text-signal">
                  Find parking near you
                </span>
              </div>
            </div>
            <a
              href="https://buymeacoffee.com/zhehang"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
            >
              <Coffee className="size-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">Buy me a coffee</span>
              <span className="sm:hidden">Coffee</span>
            </a>
          </div>

          <SearchBar
            apiBase={API_BASE}
            loading={loading}
            onSubmit={handleSubmit}
            onPickSuggestion={handlePickSuggestion}
            onNearMe={handleNearMe}
          />
        </div>
      </header>

      {/* Filter chip row */}
      <div className="z-10 shrink-0 border-b border-hairline bg-surface shadow-sm">
        <div className="mx-auto w-full max-w-screen-2xl px-4">
          <FilterBar
            category={category}
            onCategory={setCategory}
            freeNow={freeNow}
            onFreeNow={setFreeNow}
            hasLots={hasLots}
            onHasLots={setHasLots}
            radius={radius}
            onRadius={setRadius}
          />
        </div>
      </div>

      {error && (
        <div className="shrink-0 bg-destructive/10 px-4 py-2">
          <div className="mx-auto flex w-full max-w-screen-2xl items-center gap-2 text-sm font-medium text-destructive">
            <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
            {error}
          </div>
        </div>
      )}

      {/* Mobile list/map toggle */}
      <div className="shrink-0 border-b border-hairline bg-surface px-4 py-2 md:hidden">
        <div className="mx-auto grid w-full max-w-screen-2xl grid-cols-2 gap-1 rounded-lg bg-secondary p-1">
          {(['list', 'map'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setMobileTab(tab)}
              aria-pressed={mobileTab === tab}
              className={cn(
                'inline-flex items-center justify-center gap-1.5 rounded-md py-1.5 text-sm font-semibold capitalize transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                mobileTab === tab
                  ? 'bg-white text-ink shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {tab === 'list' ? (
                <List className="size-4" aria-hidden="true" />
              ) : (
                <MapIcon className="size-4" aria-hidden="true" />
              )}
              {tab}
            </button>
          ))}
        </div>
      </div>

      {/* Main content: list + map */}
      <main className="mx-auto flex w-full max-w-screen-2xl min-h-0 flex-1 overflow-hidden">
        {/* List */}
        <section
          className={cn(
            'min-h-0 w-full flex-col overflow-y-auto md:flex md:w-[42%] md:max-w-md md:border-r md:border-hairline',
            mobileTab === 'map' ? 'hidden' : 'flex',
          )}
        >
          <div className="flex flex-col gap-2.5 p-4">
            {loading && (
              <>
                <p className="font-data text-xs font-bold tracking-wide text-muted-foreground uppercase">
                  Finding spots…
                </p>
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-28 w-full rounded-xl" />
                ))}
              </>
            )}

            {!loading && totalNearby > 0 && (
              <p className="px-0.5 text-sm font-medium text-slate-body">
                <span className="font-data font-bold text-ink tabular-nums">{totalNearby}</span>{' '}
                spot{totalNearby === 1 ? '' : 's'} nearby
              </p>
            )}

            {!loading && totalNearby === 0 && !error && (
              <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
                <div className="flex size-14 items-center justify-center rounded-2xl bg-secondary">
                  <Compass className="size-7 text-primary" aria-hidden="true" />
                </div>
                <p className="font-display text-base font-semibold text-ink">
                  Where are you parking today?
                </p>
                <p className="max-w-xs text-sm text-muted-foreground">
                  Search a place or tap Near me to see live carpark availability around you.
                </p>
              </div>
            )}

            {!loading &&
              allParking.map((entry) => (
                <CarparkCard
                  key={entry.id}
                  entry={entry}
                  rank={entry.source === 'hdb' ? carparks.indexOf(entry) + 1 : 0}
                  selected={selected === entry.id}
                  onSelect={() => handleSelectEntry(entry.id)}
                />
              ))}
          </div>
        </section>

        {/* Map */}
        <section
          className={cn(
            'relative min-h-0 flex-1',
            mobileTab === 'list' ? 'hidden md:block' : 'block',
          )}
        >
          {center ? (
            <>
              <MapLegend />
              <Map
                center={center}
                carparks={carparks}
                osmParking={dedupedOsm}
                selected={selected}
                onSelect={setSelected}
                userLocation={userLocation}
                visible={mobileTab === 'map'}
              />
            </>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-4 bg-secondary/40 px-6 text-center">
              <img src="/brand-car.svg" className="size-16 opacity-90" alt="" />
              <div>
                <p className="font-display text-lg font-semibold text-ink">
                  Eh, park already?
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Search a place to start.
                </p>
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  )
}
