import { useState, useEffect, useRef } from 'react'
import Map from './Map'
import './App.css'
import { parseFreeParking } from './rules'
import type {
  Carpark,
  OsmParking,
  Suggestion,
  GeocodeResult,
  LatLon,
  ParkingEntry,
} from './types'

const RADIUS_OPTIONS = [250, 500, 1000, 2000]

// Category filter chips, mapped to the backend `category` query param.
// null = "All" (no category filter).
const CATEGORY_CHIPS: { label: string; value: string | null }[] = [
  { label: 'All', value: null },
  { label: 'HDB', value: 'HDB' },
  { label: 'Malls', value: 'Mall' },
  { label: 'Street', value: 'Street' },
  { label: 'Private', value: 'Private' },
]

// Backend base URL. Override via VITE_API_BASE in frontend/.env; falls back to
// the deployed Render backend so existing builds keep working unchanged.
const API_BASE = import.meta.env.VITE_API_BASE || 'https://ehparkleh-backend.onrender.com'

/** Availability badge using --free / --some / --full tokens. */
function AvailBadge({ available, total }: { available: number | null; total: number | null }) {
  if (available === null || total === null || total === 0) {
    return (
      <div className="avail-badge nodata">
        <span className="dot-pulse" /> No live data
      </div>
    )
  }
  const pct = available / total
  const cls = pct > 0.4 ? 'free' : pct > 0.1 ? 'some' : 'full'
  const word = pct > 0.4 ? 'Plenty' : pct > 0.1 ? 'Filling up' : available > 0 ? 'Almost full' : 'No lots'
  return (
    <div className={`avail-badge ${cls}`}>
      <span className="dot-pulse" /> {word} · {available}/{total} lots
    </div>
  )
}

export default function App() {
  const [userLocation, setUserLocation] = useState<LatLon | null>(null)
  const [mobileTab, setMobileTab] = useState<'list' | 'map'>('list')
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const searchBoxRef = useRef<HTMLFormElement>(null)
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
    if (!navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(
      pos => setUserLocation({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => {}
    )
  }, [])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target as Node)) {
        setShowSuggestions(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Re-run the last search whenever a filter changes, so list + map stay in sync.
  useEffect(() => {
    if (center) search(center.lat, center.lon)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [radius, category, freeNow, hasLots])

  function handleQueryChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value
    setQuery(val)
    clearTimeout(debounceRef.current)
    if (val.trim().length < 2) { setSuggestions([]); setShowSuggestions(false); return }
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/suggestions?q=${encodeURIComponent(val)}`)
        const data: Suggestion[] = await res.json()
        setSuggestions(data)
        setShowSuggestions(data.length > 0)
      } catch { setSuggestions([]) }
    }, 300)
  }

  async function handleSuggestionClick(s: Suggestion) {
    setQuery(s.address)
    setSuggestions([])
    setShowSuggestions(false)
    await search(s.lat, s.lon)
  }

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
      const hdbData: Carpark[] = await hdbRes.json()
      const osmData: OsmParking[] = osmRes.ok ? await osmRes.json() : []
      setCarparks(hdbData)
      setOsmParking(osmData)
      setCenter({ lat, lon })
      setSelected(null)
      if (hdbData.length === 0 && osmData.length === 0) {
        setError('Aiyah, no lots leh. Try a bigger radius or fewer filters?')
      }
    } catch {
      setError('Cannot reach the backend leh. Try again in a bit?')
    }
    setLoading(false)
  }

  async function handleSearch(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!query.trim()) return
    setSuggestions([])
    setShowSuggestions(false)
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${API_BASE}/api/geocode?q=${encodeURIComponent(query)}`)
      if (!res.ok) { setError('Cannot find that place. Try another search?'); setLoading(false); return }
      const { lat, lon }: GeocodeResult = await res.json()
      await search(lat, lon)
    } catch {
      setError('Cannot reach the backend leh. Try again in a bit?')
      setLoading(false)
    }
  }

  function handleNearMe() {
    if (!navigator.geolocation) { setError('Your browser cannot do location leh.'); return }
    navigator.geolocation.getCurrentPosition(
      pos => search(pos.coords.latitude, pos.coords.longitude),
      () => setError('Cannot get your location. Allow location access?')
    )
  }

  const filtered = carparks
  const allParking: ParkingEntry[] = [
    ...carparks.map((cp): ParkingEntry => ({ ...cp, source: 'hdb' })),
    ...osmParking.map((cp): ParkingEntry => ({ ...cp, source: 'osm' })),
  ].sort((a, b) => a.distance_m - b.distance_m)

  const totalNearby = allParking.length

  return (
    <div className="app">
      <header>
        <div className="brand">
          <img src="/brand-car.svg" className="brand-mark" alt="" />
          <div className="brand-text">
            <h1>EhParkLeh</h1>
            <span className="brand-tagline">Eh, park here lah</span>
          </div>
        </div>
        <a
          href="https://buymeacoffee.com/zhehang"
          target="_blank"
          rel="noopener noreferrer"
          className="bmc-btn"
        >
          ☕ Buy me kopi
        </a>
      </header>

      <div className="search-bar">
        <form onSubmit={handleSearch} ref={searchBoxRef} style={{ position: 'relative' }}>
          <input
            value={query}
            onChange={handleQueryChange}
            onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
            placeholder="Park where? e.g. Toa Payoh Hub"
            autoComplete="off"
          />
          {showSuggestions && (
            <ul className="suggestions-dropdown">
              {suggestions.map((s, i) => (
                <li key={i} onMouseDown={() => handleSuggestionClick(s)}>
                  {s.address}
                </li>
              ))}
            </ul>
          )}
          <button type="submit" className="btn btn-primary">Search</button>
        </form>
        <button onClick={handleNearMe} className="btn btn-nearme">Near Me</button>
      </div>

      <div className="filters">
        {CATEGORY_CHIPS.map(c => (
          <button
            key={c.label}
            className={`chip ${category === c.value ? 'active' : ''}`}
            onClick={() => setCategory(c.value)}
          >
            {c.label}
          </button>
        ))}
        <span className="chip-divider" />
        <button
          className={`chip chip-toggle ${freeNow ? 'active' : ''}`}
          onClick={() => setFreeNow(v => !v)}
        >
          🆓 Free now
        </button>
        <button
          className={`chip chip-toggle ${hasLots ? 'active' : ''}`}
          onClick={() => setHasLots(v => !v)}
        >
          ✅ Has lots
        </button>
        <span className="chip-divider" />
        {RADIUS_OPTIONS.map(r => (
          <button
            key={r}
            className={`chip ${radius === r ? 'active' : ''}`}
            onClick={() => setRadius(r)}
          >
            {r >= 1000 ? `${r / 1000}km` : `${r}m`}
          </button>
        ))}
      </div>

      {error && <div className="error">{error}</div>}

      <div className="mobile-tabs">
        <button className={mobileTab === 'list' ? 'active' : ''} onClick={() => setMobileTab('list')}>List</button>
        <button className={mobileTab === 'map' ? 'active' : ''} onClick={() => setMobileTab('map')}>Map</button>
      </div>

      <div className="main-content">
        <div className={`list ${mobileTab === 'map' ? 'hidden-mobile' : ''}`}>
          {loading && <div className="status">Finding spots for you…</div>}
          {!loading && totalNearby > 0 && (
            <div className="status">
              Steady, {totalNearby} spot{totalNearby === 1 ? '' : 's'} near you
            </div>
          )}
          {allParking.map((cp) => (
            cp.source === 'osm' ? (
              <div
                key={cp.id}
                className={`card ${selected === cp.id ? 'selected' : ''}`}
                onClick={() => { setSelected(cp.id === selected ? null : cp.id); setMobileTab('map') }}
              >
                <div className="card-header">
                  <span className="rank-osm">P</span>
                  <span className="card-address">{cp.name}</span>
                </div>
                <div className="card-pills">
                  <span className="pill pill-teal">📏 {cp.distance_m}m</span>
                  {cp.fee === 'no' && <span className="pill pill-free">Free</span>}
                  {cp.parking_type && <span className="pill">{cp.parking_type}</span>}
                </div>
                <div className="card-footer">
                  <span className="card-meta osm-note">No live lots or rates here</span>
                  <a
                    href={`https://www.google.com/maps/dir/?api=1&destination=${cp.lat},${cp.lon}`}
                    target="_blank" rel="noopener noreferrer"
                    className="gmaps-btn" onClick={e => e.stopPropagation()}
                  >Directions ↗</a>
                </div>
              </div>
            ) : (
              (() => {
                const freeText = parseFreeParking(cp.free_parking_info)
                return (
                  <div
                    key={cp.id}
                    className={`card ${selected === cp.id ? 'selected' : ''}`}
                    onClick={() => { setSelected(cp.id === selected ? null : cp.id); setMobileTab('map') }}
                  >
                    <div className="card-header">
                      <span className="rank">{carparks.indexOf(cp) + 1}</span>
                      <span className="card-address">{cp.address}</span>
                    </div>
                    <AvailBadge available={cp.lots_available} total={cp.total_lots} />
                    <div className="card-pills">
                      <span className="pill pill-teal">📏 {cp.distance_m}m</span>
                      {cp.rate.known
                        ? <span className="pill pill-coral">💰 {cp.rate.summary}</span>
                        : <span className="pill">💰 Rate unknown</span>}
                      {cp.category && <span className="pill">{cp.category}</span>}
                    </div>
                    {freeText && <div className="card-pills"><span className="pill pill-free">🆓 {freeText}</span></div>}
                    <div className="card-footer">
                      <span className="card-meta">{cp.type || 'Carpark'}</span>
                      <a
                        href={`https://www.google.com/maps/dir/?api=1&destination=${cp.lat},${cp.lon}`}
                        target="_blank" rel="noopener noreferrer"
                        className="gmaps-btn" onClick={e => e.stopPropagation()}
                      >Directions ↗</a>
                    </div>
                  </div>
                )
              })()
            )
          ))}
        </div>

        <div className={`map-container ${mobileTab === 'list' ? 'hidden-mobile' : ''}`}>
          {center && (
            <div className="map-legend">
              <span><span className="dot dot-blue" /> You</span>
              <span><span className="dot dot-red" /> Destination</span>
              <span><span className="dot dot-green" /> Carpark</span>
              <span><span className="dot dot-amber" /> Selected</span>
              <span><span className="dot dot-grey" /> Other</span>
            </div>
          )}
          {center ? (
            <Map center={center} carparks={filtered} osmParking={osmParking} selected={selected} onSelect={setSelected} userLocation={userLocation} visible={mobileTab === 'map'} />
          ) : (
            <div className="map-placeholder">
              <img src="/brand-car.svg" alt="" />
              <p>Eh, where you parking today?<br />Search a place to start.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
