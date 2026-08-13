import { useState, useEffect, useMemo, useCallback, useRef, lazy, Suspense } from 'react'
import { List, Map as MapIcon, Coffee, AlertCircle, Compass, WifiOff, Loader2 } from 'lucide-react'
import { getCurrentPosition } from './geo'
import { cn } from '@/lib/utils'
import { SearchBar } from '@/components/SearchBar'
import { FilterBar } from '@/components/FilterBar'
import { CarparkCard } from '@/components/CarparkCard'
import { Skeleton } from '@/components/ui/skeleton'
import { useFavourites } from './useFavourites'
import { useRecentSearches } from './useRecentSearches'
import { InstallPrompt } from '@/components/InstallPrompt'
import {
  liveFeedFreshness,
  nextLiveFeedFreshnessTransition,
  readLiveFeedSnapshot,
  SAVED_FEED_FRESHNESS,
  type LiveFeedSnapshot,
} from './freshness'
import type {
  Carpark,
  OsmParking,
  Suggestion,
  GeocodeResult,
  LatLon,
  ParkingEntry,
} from './types'

// Leaflet + the map are code-split: the list is what renders first (and is the
// default mobile tab), so the ~180 KB map bundle is fetched only when a search
// sets a center or the user opens the map tab.
const Map = lazy(() => import('./Map'))
const MOBILE_MEDIA_QUERY = '(max-width: 767.98px)'

// Backend base URL. Override via VITE_API_BASE in frontend/.env; falls back to
// the deployed Render backend so existing builds keep working unchanged.
const API_BASE = import.meta.env.VITE_API_BASE || 'https://ehparkleh-backend.onrender.com'

// Distance (m) below which a live-OSM pin is treated as the same carpark as an
// already-deduped enriched entry, and dropped.
const OSM_DEDUP_M = 60
// OSM is a useful supplemental layer, but primary carpark results must not wait
// for Overpass during a slow or failed request.
const OSM_TIMEOUT_MS = 5_000

function osmSearchKey(lat: number, lon: number, radius: number) {
  return `${lat}:${lon}:${radius}`
}

async function fetchOptionalOsm(url: string, searchSignal: AbortSignal) {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  const timeout = setTimeout(cancel, OSM_TIMEOUT_MS)
  if (searchSignal.aborted) cancel()
  else searchSignal.addEventListener('abort', cancel, { once: true })

  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) return { ok: false as const, data: [] as OsmParking[] }
    return {
      ok: true as const,
      data: (await response.json()) as OsmParking[],
      stale: response.headers.get('X-EhParkLeh-Osm-State') === 'stale',
    }
  } catch {
    return { ok: false as const, data: [] as OsmParking[] }
  } finally {
    clearTimeout(timeout)
    searchSignal.removeEventListener('abort', cancel)
  }
}

// Stable identity so hiding the OSM layer while a filter is active doesn't
// itself churn the `allParking` memo (and the Map's props) every render.
const EMPTY_OSM: OsmParking[] = []

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

type SortKey = 'distance' | 'availability' | 'price'
type SearchFilters = {
  radius: number
  category: string | null
  freeSunPh: boolean
  hasLots: boolean
  hasEv: boolean
  hasCarwash: boolean
}

// More live lots first; entries without live data (OSM / unknown) sink.
function availValue(e: ParkingEntry): number {
  return e.source === 'hdb' && e.lots_available != null ? e.lots_available : -1
}
// Cheaper first; unknown rate / OSM sink to the bottom.
function priceValue(e: ParkingEntry): number {
  if (e.source === 'hdb' && e.rate.known) {
    return e.rate.first_hour ?? e.rate.subsequent_half_hour ?? Number.POSITIVE_INFINITY
  }
  return Number.POSITIVE_INFINITY
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

function MapFallback() {
  return (
    <div className="flex h-full items-center justify-center bg-secondary/40">
      <Loader2 className="size-6 animate-spin text-primary" aria-hidden="true" />
    </div>
  )
}

// CSS alone can hide the map on mobile, but would still mount it (and start the
// lazy import) behind the list. Keep it out of the mobile list-first path until
// the person deliberately chooses the Map tab. Desktop keeps the split view.
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(MOBILE_MEDIA_QUERY).matches)

  useEffect(() => {
    const media = window.matchMedia(MOBILE_MEDIA_QUERY)
    const update = () => setIsMobile(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  return isMobile
}

export default function App() {
  const isMobile = useIsMobile()
  const [userLocation, setUserLocation] = useState<LatLon | null>(null)
  const [mobileTab, setMobileTab] = useState<'list' | 'map'>('list')
  const [radius, setRadius] = useState(500)
  const [category, setCategory] = useState<string | null>(null)
  const [freeSunPh, setFreeSunPh] = useState(false)
  const [hasLots, setHasLots] = useState(false)
  const [hasEv, setHasEv] = useState(false)
  const [hasCarwash, setHasCarwash] = useState(false)
  const [carparks, setCarparks] = useState<Carpark[]>([])
  const [carparksAreUnfiltered, setCarparksAreUnfiltered] = useState(true)
  const [osmParking, setOsmParking] = useState<OsmParking[]>([])
  const [osmUnavailable, setOsmUnavailable] = useState(false)
  const [center, setCenter] = useState<LatLon | null>(null)
  const [loading, setLoading] = useState(false)
  const [preserveResultsWhileLoading, setPreserveResultsWhileLoading] = useState(false)
  // A long request can be Render startup, empty application caches, network
  // variance, or another dependency. Keep the delayed copy causal-neutral.
  const [slowLoad, setSlowLoad] = useState(false)
  const [feedSnapshot, setFeedSnapshot] = useState<LiveFeedSnapshot | null>(null)
  const [freshnessNow, setFreshnessNow] = useState(() => Date.now())
  const [retainedResultsSaved, setRetainedResultsSaved] = useState(true)
  const [error, setError] = useState('')
  // Whether a search has run yet, so "0 results" reads as a neutral empty state
  // ("try a larger radius") rather than the initial "where are you parking" prompt.
  const [searched, setSearched] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [sort, setSort] = useState<SortKey>('distance')
  const { isFavourite, toggle: toggleFavourite } = useFavourites()
  const { recents, add: addRecent, clear: clearRecents } = useRecentSearches()
  const [online, setOnline] = useState(() => navigator.onLine)
  const feedFreshness = useMemo(
    () =>
      !online || retainedResultsSaved
        ? SAVED_FEED_FRESHNESS
        : liveFeedFreshness(feedSnapshot, freshnessNow),
    [feedSnapshot, freshnessNow, online, retainedResultsSaved],
  )
  const nextFreshnessTransition = useMemo(
    () =>
      !online || retainedResultsSaved
        ? null
        : nextLiveFeedFreshnessTransition(feedSnapshot, freshnessNow),
    [feedSnapshot, freshnessNow, online, retainedResultsSaved],
  )

  // In-flight request controller (so a newer search cancels an older one) and
  // the filter-change debounce timer.
  const abortRef = useRef<AbortController | null>(null)
  // Aborting saves work, but a response can still finish between an await and
  // abort. Only the newest request is allowed to publish state.
  const requestVersionRef = useRef(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const filterEffectReadyRef = useRef(false)
  // Live search inputs let debounced work use the current place and filters,
  // never stale captures. Track OSM freshness separately because it depends
  // only on location and radius, while new-location work also carries URL,
  // snapshot, and selection-reset responsibilities.
  const centerRef = useRef<LatLon | null>(center)
  centerRef.current = center
  const searchCenterRef = useRef<LatLon | null>(null)
  const searchFiltersRef = useRef<SearchFilters>({
    radius,
    category,
    freeSunPh,
    hasLots,
    hasEv,
    hasCarwash,
  })
  searchFiltersRef.current = { radius, category, freeSunPh, hasLots, hasEv, hasCarwash }
  const lastOsmSearchKeyRef = useRef<string | null>(null)
  const pendingOsmRef = useRef(false)
  const pendingNewLocationRef = useRef(false)
  const invalidateCurrentSearch = useCallback(() => {
    abortRef.current?.abort()
    requestVersionRef.current += 1
  }, [])

  // Core fetch. `newLocation` searches a fresh place (fetch OSM too, save the
  // snapshot + shareable URL, clear selection). Filter toggles pass
  // newLocation:false and only refetch carparks (OSM depends solely on
  // lat/lon/radius), unless the radius itself changed.
  const runSearch = useCallback(
    async (
      lat: number,
      lon: number,
      opts?: { includeOsm?: boolean; newLocation?: boolean; preserveResults?: boolean },
    ) => {
      const filters = searchFiltersRef.current
      const includeOsm = opts?.includeOsm ?? true
      const newLocation = opts?.newLocation ?? true
      const preserveResults = opts?.preserveResults ?? false
      searchCenterRef.current = { lat, lon }
      // A new-location search cancels any pending filter/radius refetch, so a
      // stale debounced request can't fire afterwards and snap back to the old
      // place (which would also leave the URL and data disagreeing).
      if (newLocation) {
        clearTimeout(debounceRef.current)
        pendingOsmRef.current = true
        pendingNewLocationRef.current = true
      }
      invalidateCurrentSearch()
      const ac = new AbortController()
      abortRef.current = ac
      const requestVersion = requestVersionRef.current
      setPreserveResultsWhileLoading(preserveResults)
      setLoading(true)
      setError('')
      if (includeOsm) setOsmUnavailable(false)
      try {
        const params = new URLSearchParams({
          lat: String(lat),
          lon: String(lon),
          radius: String(filters.radius),
        })
        if (filters.category) params.set('category', filters.category)
        if (filters.freeSunPh) params.set('free_sun_ph', 'true')
        if (filters.hasLots) params.set('has_lots', 'true')
        if (filters.hasEv) params.set('has_ev', 'true')
        if (filters.hasCarwash) params.set('has_carwash', 'true')

        const osmPromise = includeOsm
          ? fetchOptionalOsm(
              `${API_BASE}/api/parking/osm?lat=${lat}&lon=${lon}&radius=${filters.radius}`,
              ac.signal,
            )
          : undefined
        const response = await fetch(`${API_BASE}/api/carparks?${params.toString()}`, {
          signal: ac.signal,
        })
        // A non-OK carparks response is a server error, not an empty result: let
        // it fall to the catch so the user sees "can't reach the server" rather
        // than a misleading empty state.
        if (!response.ok) throw new Error(`carparks ${response.status}`)
        const hdbData: Carpark[] = await response.json()
        const responseSnapshot = readLiveFeedSnapshot(response.headers)

        // `AbortController` is best-effort once a response has resolved. This
        // guard prevents an older response from winning a rapid filter race.
        if (requestVersion !== requestVersionRef.current) return

        setCarparks(hdbData)
        setFeedSnapshot(responseSnapshot)
        setFreshnessNow(Date.now())
        setRetainedResultsSaved(false)
        setCarparksAreUnfiltered(
          filters.category === null &&
            !filters.freeSunPh &&
            !filters.hasLots &&
            !filters.hasEv &&
            !filters.hasCarwash,
        )
        if (includeOsm) {
          // Never mix OSM pins from the previous place/radius with the newly
          // published primary results. The optional layer fills in separately.
          setOsmParking([])
        }
        setCenter({ lat, lon })
        setSearched(true)
        if (newLocation) {
          setSelected(null)
          pendingNewLocationRef.current = false
          try {
            localStorage.setItem(
              'ehparkleh:last',
              JSON.stringify({ carparks: hdbData, osmParking: [], center: { lat, lon }, ts: Date.now() }),
            )
          } catch {
            /* storage unavailable */
          }
          // Reflect the search in the URL so results are shareable + survive refresh.
          try {
            const sp = new URLSearchParams(window.location.search)
            sp.set('lat', lat.toFixed(5))
            sp.set('lon', lon.toFixed(5))
            window.history.replaceState(null, '', `${window.location.pathname}?${sp.toString()}`)
          } catch {
            /* history unavailable */
          }
        }

        if (osmPromise) {
          void osmPromise.then((osmResult) => {
            if (
              ac.signal.aborted ||
              requestVersion !== requestVersionRef.current
            ) return
            pendingOsmRef.current = false
            if (!osmResult.ok) {
              setOsmUnavailable(true)
              return
            }
            setOsmUnavailable(osmResult.stale)
            setOsmParking(osmResult.data)
            lastOsmSearchKeyRef.current = osmSearchKey(lat, lon, filters.radius)
            if (newLocation) {
              try {
                localStorage.setItem(
                  'ehparkleh:last',
                  JSON.stringify({
                    carparks: hdbData,
                    osmParking: osmResult.data,
                    center: { lat, lon },
                    ts: Date.now(),
                  }),
                )
              } catch {
                /* storage unavailable */
              }
            }
          })
        }
      } catch (err) {
        // A superseded request was aborted on purpose; keep the loading state for
        // the newer request that replaced it.
        if ((err as { name?: string })?.name === 'AbortError' || requestVersion !== requestVersionRef.current) return
        setRetainedResultsSaved(true)
        setError("Can't reach the server right now. Please try again shortly.")
      } finally {
        if (!ac.signal.aborted && requestVersion === requestVersionRef.current) {
          setLoading(false)
          setPreserveResultsWhileLoading(false)
        }
      }
    },
    [invalidateCurrentSearch],
  )

  // Track connectivity for the offline banner.
  useEffect(() => {
    const on = () => {
      setFreshnessNow(Date.now())
      setOnline(true)
    }
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  useEffect(() => {
    if (nextFreshnessTransition === null) return
    const timer = window.setTimeout(
      () => setFreshnessNow(Date.now()),
      Math.max(0, nextFreshnessTransition - Date.now() + 1),
    )
    return () => window.clearTimeout(timer)
  }, [nextFreshnessTransition])

  // Use a truthful generic message when the primary request runs long. The
  // browser cannot identify a platform wake until a response arrives.
  useEffect(() => {
    if (!loading) {
      setSlowLoad(false)
      return
    }
    const t = setTimeout(() => setSlowLoad(true), 4000)
    return () => clearTimeout(t)
  }, [loading])

  // Initial location on cold open: a shared URL (?lat=&lon=) wins so links are
  // reproducible; otherwise restore the last snapshot (esp. useful offline),
  // refreshing it in the background when online.
  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search)
      const qlat = parseFloat(sp.get('lat') ?? '')
      const qlon = parseFloat(sp.get('lon') ?? '')
      if (Number.isFinite(qlat) && Number.isFinite(qlon)) {
        runSearch(qlat, qlon)
        return
      }
      const snap = JSON.parse(localStorage.getItem('ehparkleh:last') || 'null')
      if (snap?.center) {
        setCarparks(snap.carparks || [])
        setOsmParking(snap.osmParking || [])
        setFeedSnapshot(null)
        setRetainedResultsSaved(true)
        setCenter(snap.center)
        setSearched(true)
        if (navigator.onLine) {
          runSearch(snap.center.lat, snap.center.lon, { preserveResults: true })
        }
      }
    } catch {
      /* ignore malformed snapshot / URL */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-run the last search when a filter or the radius changes, so list + map
  // stay in sync. Debounced so rapid chip toggling issues one request, and OSM
  // is refetched only when its location or radius inputs actually change.
  useEffect(() => {
    // The location-restoration effect directly starts the first search. Do not
    // schedule the same unchanged filters again 250 ms later.
    if (!filterEffectReadyRef.current) {
      filterEffectReadyRef.current = true
      return
    }
    const target = searchCenterRef.current ?? centerRef.current
    if (!target) return
    // OSM depends only on lat/lon/radius. Compare that full key with the last
    // successful optional response, so an aborted OSM request is retried while
    // reverting a rapid radius change to a known key creates no extra request.
    pendingOsmRef.current =
      pendingNewLocationRef.current ||
      osmSearchKey(target.lat, target.lon, radius) !== lastOsmSearchKeyRef.current
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      const c = searchCenterRef.current ?? centerRef.current
      if (!c) return
      runSearch(c.lat, c.lon, {
        includeOsm: pendingOsmRef.current,
        newLocation: pendingNewLocationRef.current,
      })
    }, 250)
    return () => clearTimeout(debounceRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [radius, category, freeSunPh, hasLots, hasEv, hasCarwash])

  async function handleSubmit(query: string) {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${API_BASE}/api/geocode?q=${encodeURIComponent(query)}`)
      if (!res.ok) {
        setRetainedResultsSaved(true)
        setError(
          res.status === 404
            ? "Couldn't find that place. Try another search."
            : "Can't reach the server right now. Please try again shortly.",
        )
        setLoading(false)
        return
      }
      const { lat, lon }: GeocodeResult = await res.json()
      await runSearch(lat, lon)
      addRecent(query, lat, lon)
    } catch {
      setRetainedResultsSaved(true)
      setError("Can't reach the server right now. Please try again shortly.")
      setLoading(false)
    }
  }

  function handlePickSuggestion(s: Suggestion) {
    runSearch(s.lat, s.lon)
    addRecent(s.address, s.lat, s.lon)
  }

  function handleNearMe() {
    setError('')
    getCurrentPosition()
      .then((loc) => {
        setUserLocation(loc)
        const inSG = loc.lat >= 1.13 && loc.lat <= 1.5 && loc.lon >= 103.55 && loc.lon <= 104.15
        if (!inSG) {
          setError('You seem to be outside Singapore. Search a place instead to see carparks there.')
          return
        }
        return runSearch(loc.lat, loc.lon)
      })
      .catch((err: unknown) => {
        const denied = (err as { code?: number } | null)?.code === 1
        setError(
          denied
            ? 'Location is blocked for this site. Allow it in your browser settings, then tap Near me again.'
            : "Couldn't get your location. Try again, or search a place instead.",
        )
      })
  }

  // Stable handler passed to memoised CarparkCard / Map: toggles the selected id.
  const handleSelectEntry = useCallback((id: string) => {
    setSelected((prev) => (prev === id ? null : id))
    setMobileTab('map')
  }, [])

  const anyFilterActive = category !== null || freeSunPh || hasLots || hasEv || hasCarwash
  const invalidateFilterSearch = useCallback((changes: Partial<SearchFilters>) => {
    searchFiltersRef.current = { ...searchFiltersRef.current, ...changes }
    clearTimeout(debounceRef.current)
    invalidateCurrentSearch()
  }, [invalidateCurrentSearch])
  const handleCategory = useCallback((nextCategory: string | null) => {
    if (nextCategory === category) return
    invalidateFilterSearch({ category: nextCategory })
    setCategory(nextCategory)
  }, [category, invalidateFilterSearch])
  const handleFreeSunPh = useCallback((nextFreeSunPh: boolean) => {
    if (nextFreeSunPh === freeSunPh) return
    invalidateFilterSearch({ freeSunPh: nextFreeSunPh })
    setFreeSunPh(nextFreeSunPh)
  }, [freeSunPh, invalidateFilterSearch])
  const handleHasLots = useCallback((nextHasLots: boolean) => {
    if (nextHasLots === hasLots) return
    invalidateFilterSearch({ hasLots: nextHasLots })
    setHasLots(nextHasLots)
  }, [hasLots, invalidateFilterSearch])
  const handleHasEv = useCallback((nextHasEv: boolean) => {
    if (nextHasEv === hasEv) return
    invalidateFilterSearch({ hasEv: nextHasEv })
    setHasEv(nextHasEv)
  }, [hasEv, invalidateFilterSearch])
  const handleHasCarwash = useCallback((nextHasCarwash: boolean) => {
    if (nextHasCarwash === hasCarwash) return
    invalidateFilterSearch({ hasCarwash: nextHasCarwash })
    setHasCarwash(nextHasCarwash)
  }, [hasCarwash, invalidateFilterSearch])
  const handleRadius = useCallback((nextRadius: number) => {
    if (nextRadius === radius) return
    invalidateFilterSearch({ radius: nextRadius })
    setRadius(nextRadius)
  }, [invalidateFilterSearch, radius])
  const resetFilters = useCallback(() => {
    if (!anyFilterActive) return
    invalidateFilterSearch({
      category: null,
      freeSunPh: false,
      hasLots: false,
      hasEv: false,
      hasCarwash: false,
    })
    setCategory(null)
    setFreeSunPh(false)
    setHasLots(false)
    setHasEv(false)
    setHasCarwash(false)
  }, [anyFilterActive, invalidateFilterSearch])

  // The enriched dataset is already deduped, but the live OSM layer is not, so
  // drop OSM pins that sit on top of an enriched carpark (otherwise dense areas
  // render two markers for one physical carpark). Memoised so its identity is
  // stable across unrelated re-renders (selection, sort, banners).
  const dedupedOsm = useMemo(
    () =>
      osmParking.filter(
        (o) => !carparks.some((c) => metresBetween(o.lat, o.lon, c.lat, c.lon) < OSM_DEDUP_M),
      ),
    [osmParking, carparks],
  )

  // OSM entries carry no amenity or category data of their own, so they can
  // never genuinely match `has_ev` / `has_carwash` / `category` / `free_sun_ph`
  // / `has_lots` — those are all server-side filters on `carparks`, and any of
  // them can shrink that set. Deduping against a shrunk set would also
  // un-suppress OSM pins that were only hidden because the carpark sitting on
  // top of them survived the previous (looser) filter. Dropping the OSM layer
  // entirely while any filter is active fixes both: nothing is shown as
  // matching a filter it has no data for, and a filter toggle can only ever
  // remove unverified pins, never add them back.
  const visibleOsm = anyFilterActive || !carparksAreUnfiltered ? EMPTY_OSM : dedupedOsm

  const allParking: ParkingEntry[] = useMemo(
    () => [
      ...carparks.map((cp): ParkingEntry => ({ ...cp, source: 'hdb' })),
      ...visibleOsm.map((cp): ParkingEntry => ({ ...cp, source: 'osm' })),
    ],
    [carparks, visibleOsm],
  )

  const sortedParking = useMemo(
    () =>
      [...allParking].sort((a, b) => {
        if (sort === 'availability') return availValue(b) - availValue(a)
        if (sort === 'price') return priceValue(a) - priceValue(b)
        return a.distance_m - b.distance_m
      }),
    [allParking, sort],
  )

  const totalNearby = allParking.length

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Indigo command bar */}
      <header className="z-20 shrink-0 bg-ink text-white shadow-md">
        <div className="mx-auto w-full max-w-screen-2xl px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3">
          <div className="flex items-center justify-between gap-3 pb-3">
            <div className="flex items-center gap-2.5">
              <img src="/brand-car.svg" className="size-11" alt="" />
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
              className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
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
            recents={recents}
            onPickRecent={(r) => {
              runSearch(r.lat, r.lon)
              addRecent(r.query, r.lat, r.lon)
            }}
            onClearRecents={clearRecents}
          />
        </div>
      </header>

      {/* Filter chip row */}
      <div className="z-10 shrink-0 border-b border-hairline bg-surface shadow-sm">
        <div className="mx-auto w-full max-w-screen-2xl px-4">
          <FilterBar
            category={category}
            onCategory={handleCategory}
            freeSunPh={freeSunPh}
            onFreeSunPh={handleFreeSunPh}
            hasLots={hasLots}
            onHasLots={handleHasLots}
            hasEv={hasEv}
            onHasEv={handleHasEv}
            hasCarwash={hasCarwash}
            onHasCarwash={handleHasCarwash}
            radius={radius}
            onRadius={handleRadius}
            anyFilterActive={anyFilterActive}
            onReset={resetFilters}
          />
        </div>
      </div>

      {!online && (
        <div className="shrink-0 bg-amber-500/15 px-4 py-2" role="status">
          <div className="mx-auto flex w-full max-w-screen-2xl items-center gap-2 text-sm font-medium text-amber-700">
            <WifiOff className="size-4 shrink-0" aria-hidden="true" />
            You're offline: showing your last results.
          </div>
        </div>
      )}
      {error && (
        <div className="shrink-0 bg-destructive/10 px-4 py-2" role="alert">
          <div className="mx-auto flex w-full max-w-screen-2xl items-center gap-2 text-sm font-medium text-destructive">
            <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
            {error}
          </div>
        </div>
      )}
      {searched && feedFreshness.availability !== 'fresh' && carparks.some((cp) => cp.lots_available !== null) && (
        <div className="shrink-0 bg-amber-500/15 px-4 py-2" role="status">
          <div className="mx-auto w-full max-w-screen-2xl text-sm font-medium text-amber-800">
            {feedFreshness.availability === 'recent'
              ? 'Lot counts are from a recent update and may be out of date.'
              : 'Showing saved lot counts. They may be out of date.'}
          </div>
        </div>
      )}
      {searched && osmUnavailable && (
        <div className="shrink-0 bg-secondary/70 px-4 py-2" role="status">
          <div className="mx-auto flex w-full max-w-screen-2xl items-center gap-2 text-sm font-medium text-muted-foreground">
            <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
            Some map parking spots could not be loaded. Main carpark results are still available.
          </div>
        </div>
      )}

      <InstallPrompt />

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
                'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md py-2 text-sm font-semibold capitalize transition-colors',
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
          aria-label="Carpark list"
          className={cn(
            'min-h-0 w-full flex-col overflow-y-auto md:flex md:w-[42%] md:max-w-md md:border-r md:border-hairline',
            mobileTab === 'map' ? 'hidden' : 'flex',
          )}
        >
          <div className="flex flex-col gap-2.5 p-4">
            {loading && (
              <>
                <p
                  className="font-data text-xs font-bold tracking-wide text-muted-foreground uppercase"
                  role="status"
                  aria-live="polite"
                >
                  {slowLoad
                    ? 'Live parking data is taking longer than usual…'
                    : preserveResultsWhileLoading
                      ? 'Refreshing saved spots…'
                      : 'Finding spots…'}
                </p>
                {!preserveResultsWhileLoading &&
                  [0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-28 w-full rounded-xl" />
                  ))}
              </>
            )}

            {(!loading || preserveResultsWhileLoading) && totalNearby > 0 && (
              <div className="flex items-center justify-between gap-2 px-0.5">
                <p className="text-sm font-medium text-slate-body" aria-live="polite">
                  <span className="font-data font-bold text-ink tabular-nums">{totalNearby}</span>{' '}
                  spot{totalNearby === 1 ? '' : 's'} nearby
                </p>
                <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  Sort
                  <select
                    value={sort}
                    onChange={(e) => setSort(e.target.value as SortKey)}
                    className="min-h-9 rounded-md border border-hairline bg-white px-2 py-1.5 text-xs font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="distance">Distance</option>
                    <option value="availability">Availability</option>
                    <option value="price">Price</option>
                  </select>
                </label>
              </div>
            )}

            {/* Never searched yet: the welcome prompt. */}
            {!loading && !searched && totalNearby === 0 && !error && (
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

            {/* Searched, but nothing matched: a neutral empty state, not an error. */}
            {!loading && searched && totalNearby === 0 && !error && (
              <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
                <div className="flex size-14 items-center justify-center rounded-2xl bg-secondary">
                  <Compass className="size-7 text-primary" aria-hidden="true" />
                </div>
                <p className="font-display text-base font-semibold text-ink">
                  No spots match here
                </p>
                <p className="max-w-xs text-sm text-muted-foreground">
                  Try a larger search radius{anyFilterActive ? ', or clear your filters' : ''}.
                </p>
                {anyFilterActive && (
                  <button
                    type="button"
                    onClick={resetFilters}
                    className="mt-1 inline-flex min-h-11 items-center rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Clear filters
                  </button>
                )}
              </div>
            )}

            {(!loading || preserveResultsWhileLoading) &&
              sortedParking.map((entry, i) => (
                <CarparkCard
                  key={entry.id}
                  entry={entry}
                  rank={i + 1}
                  selected={selected === entry.id}
                  onSelect={handleSelectEntry}
                  isFavourite={isFavourite(entry.id)}
                  onToggleFavourite={toggleFavourite}
                  availabilityFreshness={feedFreshness.availability}
                  evFreshness={feedFreshness.ev}
                />
              ))}
          </div>
        </section>

        {/* Map */}
        <section
          aria-label="Map of nearby carparks"
          className={cn(
            'relative min-h-0 flex-1',
            mobileTab === 'list' ? 'hidden md:block' : 'block',
          )}
        >
          {center ? (
            <>
              {!isMobile || mobileTab === 'map' ? (
                <>
                  <MapLegend />
                  <Suspense fallback={<MapFallback />}>
                    <Map
                      center={center}
                      carparks={carparks}
                      osmParking={visibleOsm}
                      selected={selected}
                      onSelect={setSelected}
                      userLocation={userLocation}
                      visible={mobileTab === 'map'}
                      availabilityFreshness={feedFreshness.availability}
                    />
                  </Suspense>
                </>
              ) : null}
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
