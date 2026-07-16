import { memo, useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import { getAvailability, availColor, type AvailState } from './availability'
import type { Carpark, OsmParking, LatLon } from './types'

const pIcon = L.divIcon({
  className: '',
  html: '<div class="p-marker">P</div>',
  iconSize: [22, 22],
  iconAnchor: [11, 11],
})

const INDIGO = '#4338CA'
const USER_BLUE = '#2563EB'

// Carpark pin as a coloured dot (a divIcon, not a vector circleMarker, so it can
// live inside a marker cluster — markercluster cannot cluster circleMarkers).
// The per-state class adds a shape glyph (ring / bar / centre dot) so the pins
// are distinguishable without relying on colour alone (colour-blind safe).
function carparkIcon(state: AvailState, selected: boolean): L.DivIcon {
  const size = selected ? 26 : 18
  return L.divIcon({
    className: '',
    html: `<div class="cp-dot cp-dot--${state}${selected ? ' cp-dot--selected' : ''}" style="background:${availColor(state)}"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

// Cluster bubble themed to the app (indigo fill, cyan ring, mono count).
function clusterIcon(cluster: L.MarkerCluster): L.DivIcon {
  const n = cluster.getChildCount()
  const size = n < 10 ? 34 : n < 100 ? 40 : 46
  return L.divIcon({
    className: '',
    html: `<div class="ehp-cluster" style="width:${size}px;height:${size}px">${n}</div>`,
    iconSize: [size, size],
  })
}

// LED-style availability chip rendered inside Leaflet popups.
function ledChipHtml(state: AvailState, available: number | null, total: number | null): string {
  const dot = availColor(state)
  const text =
    state === 'nodata' ? 'NO DATA' : `${available} <span style="opacity:.55">/ ${total}</span> LOTS`
  return (
    `<span class="led-popup-chip">` +
    `<span style="width:7px;height:7px;border-radius:999px;background:${dot};box-shadow:0 0 5px ${dot}"></span>` +
    `<span style="opacity:.55">P</span>` +
    `<span style="color:${dot}">${text}</span>` +
    `</span>`
  )
}

// Escape user-influenced text before it goes into a popup's innerHTML. OSM
// parking names (served live from Overpass) are editable by anyone on
// openstreetmap.org, so they are an untrusted, stored-XSS vector without this.
const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}
function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ESC[c])
}

// Navigation deep links (open the app if installed, else web).
function gmapsDir(lat: number, lon: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`
}
function wazeDir(lat: number, lon: number): string {
  return `https://www.waze.com/ul?ll=${lat},${lon}&navigate=yes`
}

// Google Maps + Waze actions rendered inside a Leaflet popup. Clicks stay inside
// the popup (target=_blank), so they never toggle the marker selection.
function navLinksHtml(lat: number, lon: number): string {
  const link = (href: string, text: string) =>
    `<a href="${href}" target="_blank" rel="noopener noreferrer" ` +
    `style="display:inline-flex;align-items:center;gap:4px;` +
    `font-size:12px;font-weight:700;color:#4338CA;text-decoration:none">${text} ↗</a>`
  return (
    `<div style="display:flex;gap:14px;margin-top:9px">` +
    link(gmapsDir(lat, lon), 'Google Maps') +
    link(wazeDir(lat, lon), 'Waze') +
    `</div>`
  )
}

function popupHtml(
  title: string,
  distance: number,
  rate: string,
  ledHtml: string,
  lat: number,
  lon: number,
): string {
  return (
    `<div style="font-family:Inter,system-ui,sans-serif;min-width:170px">` +
    `<div style="font-family:'Space Grotesk',system-ui,sans-serif;font-weight:600;color:#1E1B4B;margin-bottom:6px">${esc(title)}</div>` +
    `${ledHtml}` +
    `<div style="margin-top:7px;font-size:12px;color:#475569">` +
    `<span style="font-family:'Space Mono',monospace;font-weight:700">${distance}m</span> away · ${esc(rate)}` +
    `</div>` +
    navLinksHtml(lat, lon) +
    `</div>`
  )
}

function osmPopupHtml(name: string, distance: number, lat: number, lon: number): string {
  return (
    `<div style="font-family:Inter,system-ui,sans-serif;min-width:150px">` +
    `<div style="font-family:'Space Grotesk',system-ui,sans-serif;font-weight:600;color:#1E1B4B;margin-bottom:4px">${esc(name)}</div>` +
    `<div style="font-size:12px;color:#475569"><span style="font-family:'Space Mono',monospace;font-weight:700">${distance}m</span> away</div>` +
    `<div style="font-size:12px;color:#94a3b8;font-style:italic;margin-top:2px">No live lots or rates</div>` +
    navLinksHtml(lat, lon) +
    `</div>`
  )
}

interface MapProps {
  center: LatLon
  carparks: Carpark[]
  osmParking?: OsmParking[]
  selected: string | null
  onSelect: (id: string | null) => void
  userLocation: LatLon | null
  visible: boolean
}

interface MarkerMeta {
  marker: L.Marker
  kind: 'hdb' | 'osm'
  state?: AvailState
}

function Map({
  center,
  carparks,
  osmParking = [],
  selected,
  onSelect,
  userLocation,
  visible,
}: MapProps) {
  const mapRef = useRef<HTMLDivElement>(null)
  const instanceRef = useRef<L.Map | null>(null)
  const clusterRef = useRef<L.MarkerClusterGroup | null>(null)
  const centerMarkerRef = useRef<L.CircleMarker | null>(null)
  const userMarkerRef = useRef<L.CircleMarker | null>(null)
  // Marker lookup for cheap selection styling, the last-fitted center (so we
  // only re-fit on a genuinely new search), the previously-selected id, and a
  // live mirror of `selected` so marker click handlers read it without being
  // rebuilt on every selection change.
  const metaRef = useRef<Record<string, MarkerMeta>>({})
  const lastFitRef = useRef<string>('')
  const prevSelRef = useRef<string | null>(null)
  const selectedRef = useRef<string | null>(selected)
  selectedRef.current = selected

  useEffect(() => {
    if (!instanceRef.current && mapRef.current) {
      const map = L.map(mapRef.current, { zoomControl: true }).setView(
        [center.lat, center.lon],
        15,
      )
      // Stadia Maps "Alidade Smooth": a light, muted basemap so the coloured
      // parking pins pop. Authenticated by domain (localhost for dev, the
      // production origin registered in the Stadia dashboard) — no key in the
      // bundle. Within their tile-usage terms, unlike the OSMF community server.
      L.tileLayer('https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}.png', {
        attribution:
          '&copy; <a href="https://stadiamaps.com/" target="_blank" rel="noopener">Stadia Maps</a> ' +
          '&copy; <a href="https://openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> ' +
          '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
        maxZoom: 20,
      }).addTo(map)
      // One cluster group holds all parking pins: it clusters dense areas and
      // only renders markers in/near the viewport (viewport culling).
      clusterRef.current = L.markerClusterGroup({
        chunkedLoading: true,
        showCoverageOnHover: false,
        maxClusterRadius: 50,
        spiderfyOnMaxZoom: true,
        iconCreateFunction: clusterIcon,
      }).addTo(map)
      instanceRef.current = map
    }
  }, [])

  useEffect(() => {
    const map = instanceRef.current
    if (!map) return
    if (centerMarkerRef.current) centerMarkerRef.current.remove()
    centerMarkerRef.current = L.circleMarker([center.lat, center.lon], {
      radius: 8,
      color: '#fff',
      fillColor: INDIGO,
      fillOpacity: 1,
      weight: 3,
    })
      .addTo(map)
      .bindPopup('Destination')
  }, [center])

  // Build the clustered parking pins (carparks + de-duped OSM). Runs only when
  // the data or center changes — NOT on selection (that is handled separately),
  // so tapping a pin no longer tears down and rebuilds all 400+ markers.
  useEffect(() => {
    const map = instanceRef.current
    const cluster = clusterRef.current
    if (!map || !cluster) return
    cluster.clearLayers()

    const markers: L.Marker[] = []
    // Plain record, not a Map: this component is itself named `Map`, which would
    // shadow the built-in `Map` constructor here.
    const meta: Record<string, MarkerMeta> = {}
    const sel = selectedRef.current

    carparks.forEach((cp, i) => {
      const a = getAvailability(cp.lots_available, cp.total_lots)
      const title = `${cp.address} — ${a.state === 'nodata' ? 'no live lot data' : `${a.available}/${a.total} lots`}`
      const m = L.marker([cp.lat, cp.lon], {
        icon: carparkIcon(a.state, cp.id === sel),
        title,
      })
        .bindPopup(
          popupHtml(
            `${i + 1}. ${cp.address}`,
            cp.distance_m,
            cp.rate.known ? cp.rate.summary : 'Rate unknown',
            ledChipHtml(a.state, a.available, a.total),
            cp.lat,
            cp.lon,
          ),
        )
        .on('click', () => onSelect(cp.id === selectedRef.current ? null : cp.id))
      markers.push(m)
      meta[cp.id] = { marker: m, kind: 'hdb', state: a.state }
    })

    osmParking.forEach((cp) => {
      const m = L.marker([cp.lat, cp.lon], { icon: pIcon, title: cp.name })
        .bindPopup(osmPopupHtml(cp.name, cp.distance_m, cp.lat, cp.lon))
        .on('click', () => onSelect(cp.id === selectedRef.current ? null : cp.id))
      markers.push(m)
      meta[cp.id] = { marker: m, kind: 'osm' }
    })

    cluster.addLayers(markers)
    metaRef.current = meta

    // Fit bounds only on a genuinely new search (a new center), so toggling
    // filters or re-fetching at the same place keeps the user's pan/zoom.
    const sig = `${center.lat},${center.lon}`
    if (lastFitRef.current !== sig) {
      lastFitRef.current = sig
      if (markers.length > 0) {
        const pts: L.LatLngTuple[] = [
          [center.lat, center.lon],
          ...carparks.map((cp) => [cp.lat, cp.lon] as L.LatLngTuple),
          ...osmParking.map((cp) => [cp.lat, cp.lon] as L.LatLngTuple),
        ]
        map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] })
      } else {
        // A new search with no results: still follow to the destination rather
        // than leaving the map on the previous place.
        map.setView([center.lat, center.lon], 15)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carparks, osmParking, center])

  // Selection: restyle just the affected pins and open the selected popup,
  // instead of rebuilding the whole layer.
  useEffect(() => {
    const cluster = clusterRef.current
    if (!cluster) return
    const meta = metaRef.current
    const prev = prevSelRef.current
    if (prev && prev !== selected) {
      const pm = meta[prev]
      if (pm?.kind === 'hdb' && pm.state) pm.marker.setIcon(carparkIcon(pm.state, false))
    }
    if (selected) {
      const sm = meta[selected]
      if (sm) {
        if (sm.kind === 'hdb' && sm.state) sm.marker.setIcon(carparkIcon(sm.state, true))
        // Expand any cluster hiding the selected pin, then open its popup.
        cluster.zoomToShowLayer(sm.marker, () => sm.marker.openPopup())
      }
    }
    prevSelRef.current = selected
  }, [selected])

  useEffect(() => {
    const map = instanceRef.current
    if (!map || !visible) return
    setTimeout(() => map.invalidateSize(), 50)
  }, [visible])

  useEffect(() => {
    const map = instanceRef.current
    if (!map || !userLocation) return
    if (userMarkerRef.current) userMarkerRef.current.remove()
    userMarkerRef.current = L.circleMarker([userLocation.lat, userLocation.lon], {
      radius: 7,
      color: '#fff',
      fillColor: USER_BLUE,
      fillOpacity: 1,
      weight: 3,
    })
      .addTo(map)
      .bindPopup('You are here')
  }, [userLocation])

  return <div ref={mapRef} style={{ height: '100%', width: '100%' }} />
}

// Memoised so unrelated App state (sort, loading, banners) no longer re-renders
// the map; it only updates when center / carparks / selection actually change.
export default memo(Map)
