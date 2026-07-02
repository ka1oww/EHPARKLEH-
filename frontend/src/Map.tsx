import { useEffect, useRef } from 'react'
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
function carparkIcon(state: AvailState, selected: boolean): L.DivIcon {
  const size = selected ? 26 : 18
  return L.divIcon({
    className: '',
    html: `<div class="cp-dot${selected ? ' cp-dot--selected' : ''}" style="background:${availColor(state)}"></div>`,
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

// Google Maps directions deep link (opens the Maps app if installed, else web).
function gmapsDir(lat: number, lon: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`
}

// "Open in Google Maps" action rendered inside a Leaflet popup. Its click stays
// inside the popup (target=_blank), so it never toggles the marker selection.
function gmapsLinkHtml(href: string): string {
  return (
    `<a href="${href}" target="_blank" rel="noopener noreferrer" ` +
    `style="display:inline-flex;align-items:center;gap:4px;margin-top:9px;` +
    `font-size:12px;font-weight:700;color:#4338CA;text-decoration:none">` +
    `Open in Google Maps ↗</a>`
  )
}

function popupHtml(
  title: string,
  distance: number,
  rate: string,
  ledHtml: string,
  mapsHref: string,
): string {
  return (
    `<div style="font-family:Inter,system-ui,sans-serif;min-width:170px">` +
    `<div style="font-family:'Space Grotesk',system-ui,sans-serif;font-weight:600;color:#1E1B4B;margin-bottom:6px">${title}</div>` +
    `${ledHtml}` +
    `<div style="margin-top:7px;font-size:12px;color:#475569">` +
    `<span style="font-family:'Space Mono',monospace;font-weight:700">${distance}m</span> away · ${rate}` +
    `</div>` +
    gmapsLinkHtml(mapsHref) +
    `</div>`
  )
}

function osmPopupHtml(name: string, distance: number, mapsHref: string): string {
  return (
    `<div style="font-family:Inter,system-ui,sans-serif;min-width:150px">` +
    `<div style="font-family:'Space Grotesk',system-ui,sans-serif;font-weight:600;color:#1E1B4B;margin-bottom:4px">${name}</div>` +
    `<div style="font-size:12px;color:#475569"><span style="font-family:'Space Mono',monospace;font-weight:700">${distance}m</span> away</div>` +
    `<div style="font-size:12px;color:#94a3b8;font-style:italic;margin-top:2px">No live lots or rates</div>` +
    gmapsLinkHtml(mapsHref) +
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

export default function Map({
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

  useEffect(() => {
    if (!instanceRef.current && mapRef.current) {
      const map = L.map(mapRef.current, { zoomControl: true }).setView(
        [center.lat, center.lon],
        15,
      )
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        maxZoom: 19,
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

  // Rebuild the clustered parking pins (carparks + de-duped OSM) on any change.
  useEffect(() => {
    const map = instanceRef.current
    const cluster = clusterRef.current
    if (!map || !cluster) return
    cluster.clearLayers()

    const markers: L.Marker[] = []
    // Plain record, not a Map: this component is itself named `Map`, which would
    // shadow the built-in `Map` constructor here.
    const byId: Record<string, L.Marker> = {}

    carparks.forEach((cp, i) => {
      const a = getAvailability(cp.lots_available, cp.total_lots)
      const m = L.marker([cp.lat, cp.lon], {
        icon: carparkIcon(a.state, cp.id === selected),
      })
        .bindPopup(
          popupHtml(
            `${i + 1}. ${cp.address}`,
            cp.distance_m,
            cp.rate.known ? cp.rate.summary : 'Rate unknown',
            ledChipHtml(a.state, a.available, a.total),
            gmapsDir(cp.lat, cp.lon),
          ),
        )
        .on('click', () => onSelect(cp.id === selected ? null : cp.id))
      markers.push(m)
      byId[cp.id] = m
    })

    osmParking.forEach((cp) => {
      const m = L.marker([cp.lat, cp.lon], { icon: pIcon })
        .bindPopup(osmPopupHtml(cp.name, cp.distance_m, gmapsDir(cp.lat, cp.lon)))
        .on('click', () => onSelect(cp.id === selected ? null : cp.id))
      markers.push(m)
      byId[cp.id] = m
    })

    cluster.addLayers(markers)

    const selMarker = selected ? byId[selected] : undefined
    if (selMarker) {
      // Expand any cluster hiding the selected pin, then open its popup.
      cluster.zoomToShowLayer(selMarker, () => selMarker.openPopup())
    } else if (markers.length > 0) {
      const pts: L.LatLngTuple[] = [
        [center.lat, center.lon],
        ...carparks.map((cp) => [cp.lat, cp.lon] as L.LatLngTuple),
        ...osmParking.map((cp) => [cp.lat, cp.lon] as L.LatLngTuple),
      ]
      map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] })
    }
  }, [carparks, osmParking, selected])

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
