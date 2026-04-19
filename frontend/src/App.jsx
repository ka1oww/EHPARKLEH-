import { useState, useEffect } from 'react'
import Map from './Map'
import './App.css'

const RADIUS_OPTIONS = [250, 500, 1000, 2000]

function AvailBar({ available, total }) {
  if (available === null || total === null || total === 0) {
    return <div className="avail-label" style={{ color: '#bbb' }}>No data</div>
  }
  const pct = available / total
  const colorClass = pct > 0.5 ? 'green' : pct > 0.2 ? 'orange' : 'red'
  return (
    <div className="avail-bar-wrap">
      <div className="avail-bar-bg">
        <div
          className={`avail-bar-fill ${colorClass}`}
          style={{ width: `${Math.round(pct * 100)}%` }}
        />
      </div>
      <div className="avail-label">{available} / {total} lots</div>
    </div>
  )
}

export default function App() {
  const [userLocation, setUserLocation] = useState(null)
  const [mobileTab, setMobileTab] = useState('list')
  const [query, setQuery] = useState('')
  const [radius, setRadius] = useState(500)
  const [carparks, setCarparks] = useState([])
  const [center, setCenter] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState(null)

  useEffect(() => {
    if (!navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(
      pos => setUserLocation({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => {}
    )
  }, [])

  async function search(lat, lon) {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(
        `https://ehparkleh-backend.onrender.com/api/carparks?lat=${lat}&lon=${lon}&radius=${radius}`
      )
      const data = await res.json()
      setCarparks(data)
      setCenter({ lat, lon })
      setSelected(null)
      if (data.length === 0) setError('No HDB carparks found in this area. Try a larger radius.')
    } catch {
      setError('Failed to fetch carparks. Is the backend running?')
    }
    setLoading(false)
  }

  async function handleSearch(e) {
    e.preventDefault()
    if (!query.trim()) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`https://ehparkleh-backend.onrender.com/api/geocode?q=${encodeURIComponent(query)}`)
      if (!res.ok) { setError('Location not found.'); setLoading(false); return }
      const { lat, lon } = await res.json()
      await search(lat, lon)
    } catch {
      setError('Failed to geocode. Is the backend running?')
      setLoading(false)
    }
  }

  function handleNearMe() {
    if (!navigator.geolocation) { setError('Geolocation not supported.'); return }
    navigator.geolocation.getCurrentPosition(
      pos => search(pos.coords.latitude, pos.coords.longitude),
      () => setError('Could not get your location.')
    )
  }

  const filtered = carparks

  return (
    <div className="app">
      <header>
        <h1>EhParkLeh</h1>
        <a
          href="https://buymeacoffee.com/zhehang"
          target="_blank"
          rel="noopener noreferrer"
          className="bmc-btn"
        >
          ☕ Buy me a coffee
        </a>
      </header>

      <div className="search-bar">
        <form onSubmit={handleSearch}>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search an address, e.g. Toa Payoh Hub"
          />
          <button type="submit" className="btn btn-primary">Search</button>
        </form>
        <button onClick={handleNearMe} className="btn btn-nearme">Near Me</button>
      </div>

      <div className="filters">
        <div className="filter-group">
          <span className="filter-label">Radius</span>
          {RADIUS_OPTIONS.map(r => (
            <button
              key={r}
              className={radius === r ? 'active' : ''}
              onClick={() => setRadius(r)}
            >
              {r >= 1000 ? `${r / 1000}km` : `${r}m`}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="mobile-tabs">
        <button className={mobileTab === 'list' ? 'active' : ''} onClick={() => setMobileTab('list')}>List</button>
        <button className={mobileTab === 'map' ? 'active' : ''} onClick={() => setMobileTab('map')}>Map</button>
      </div>

      <div className="main-content">
        <div className={`list ${mobileTab === 'map' ? 'hidden-mobile' : ''}`}>
          {loading && <div className="status">Searching...</div>}
          {!loading && filtered.length === 0 && carparks.length > 0 && (
            <div className="status">No carparks match the current filters.</div>
          )}
          {!loading && filtered.length > 0 && (
            <div className="status">{filtered.length} HDB carpark{filtered.length !== 1 ? 's' : ''} found · HDB only, not all parking shown</div>
          )}
          {filtered.map((cp, i) => (
            <div
              key={cp.id}
              className={`card ${selected === cp.id ? 'selected' : ''}`}
              onClick={() => {
              setSelected(cp.id === selected ? null : cp.id)
              setMobileTab('map')
            }}
            >
              <div className="card-header">
                <span className="rank">{i + 1}</span>
                <span className="card-address">{cp.address}</span>
              </div>

              <div className="card-pills">
                <span className="pill pill-blue">📏 {cp.distance_m}m</span>
                <span className="pill">
                  💰 ${cp.cost_per_30min.toFixed(2)}/30min
                </span>
                {cp.free_parking_info !== 'NO' && (
                  <span className="pill pill-green">Free: {cp.free_parking_info}</span>
                )}
                <span className="pill">{cp.zone}</span>
              </div>

              <AvailBar available={cp.lots_available} total={cp.total_lots} />
              <div className="card-meta">{cp.type}</div>
            </div>
          ))}
        </div>

        <div className={`map-container ${mobileTab === 'list' ? 'hidden-mobile' : ''}`}>
          {center && (
            <div className="map-legend">
              <span><span className="dot dot-blue" /> You</span>
              <span><span className="dot dot-red" /> Destination</span>
              <span><span className="dot dot-green" /> Carpark</span>
              <span><span className="dot dot-amber" /> Selected</span>
            </div>
          )}
          {center ? (
            <Map center={center} carparks={filtered} selected={selected} onSelect={setSelected} userLocation={userLocation} visible={mobileTab === 'map'} />
          ) : (
            <div className="map-placeholder">
              <span className="icon">🗺️</span>
              <p>Search a location to see nearby HDB carparks</p>
              <p style={{fontSize:'12px', color:'#bbb', marginTop:'4px'}}>Note: only HDB carparks are shown, not private or commercial parking</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
