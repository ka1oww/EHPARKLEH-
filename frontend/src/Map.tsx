import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { getAvailability, availColor, type AvailState } from './availability'
import type { Carpark, OsmParking, LatLon } from './types'

const pIcon = L.divIcon({
  className: '',
  html: '<div class="p-marker">P</div>',
  iconSize: [22, 22],
  iconAnchor: [11, 11],
})

const INDIGO = '#4338CA'
const SIGNAL = '#22D3EE'
const USER_BLUE = '#2563EB'

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

function popupHtml(title: string, distance: number, rate: string, ledHtml: string): string {
  return (
    `<div style="font-family:Inter,system-ui,sans-serif;min-width:170px">` +
    `<div style="font-family:'Space Grotesk',system-ui,sans-serif;font-weight:600;color:#1E1B4B;margin-bottom:6px">${title}</div>` +
    `${ledHtml}` +
    `<div style="margin-top:7px;font-size:12px;color:#475569">` +
    `<span style="font-family:'Space Mono',monospace;font-weight:700">${distance}m</span> away · ${rate}` +
    `</div></div>`
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
  const markersRef = useRef<L.CircleMarker[]>([])
  const osmMarkersRef = useRef<L.Marker[]>([])
  const centerMarkerRef = useRef<L.CircleMarker | null>(null)
  const userMarkerRef = useRef<L.CircleMarker | null>(null)

  useEffect(() => {
    if (!instanceRef.current && mapRef.current) {
      instanceRef.current = L.map(mapRef.current, { zoomControl: true }).setView(
        [center.lat, center.lon],
        15,
      )
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        maxZoom: 19,
      }).addTo(instanceRef.current)
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

  useEffect(() => {
    const map = instanceRef.current
    if (!map) return

    markersRef.current.forEach((m) => m.remove())
    markersRef.current = []

    if (carparks.length === 0) return

    carparks.forEach((cp, i) => {
      const isSelected = cp.id === selected
      const a = getAvailability(cp.lots_available, cp.total_lots)
      const fill = availColor(a.state)
      const marker = L.circleMarker([cp.lat, cp.lon], {
        radius: isSelected ? 12 : 8,
        color: isSelected ? SIGNAL : '#fff',
        fillColor: fill,
        fillOpacity: 0.95,
        weight: isSelected ? 3 : 2,
      })
        .addTo(map)
        .bindPopup(
          popupHtml(
            `${i + 1}. ${cp.address}`,
            cp.distance_m,
            cp.rate.known ? cp.rate.summary : 'Rate unknown',
            ledChipHtml(a.state, a.available, a.total),
          ),
        )
        .on('click', () => onSelect(cp.id === selected ? null : cp.id))

      if (isSelected) marker.openPopup()
      markersRef.current.push(marker)
    })

    if (!selected) {
      const allPoints: L.LatLngTuple[] = [
        [center.lat, center.lon],
        ...carparks.map((cp) => [cp.lat, cp.lon] as L.LatLngTuple),
      ]
      map.fitBounds(L.latLngBounds(allPoints), { padding: [40, 40] })
    } else {
      const cp = carparks.find((c) => c.id === selected)
      if (cp) map.setView([cp.lat, cp.lon], Math.max(map.getZoom(), 16))
    }
  }, [carparks, selected])

  useEffect(() => {
    const map = instanceRef.current
    if (!map) return
    osmMarkersRef.current.forEach((m) => m.remove())
    osmMarkersRef.current = []
    osmParking.forEach((cp) => {
      const marker = L.marker([cp.lat, cp.lon], { icon: pIcon })
        .addTo(map)
        .bindPopup(
          `<div style="font-family:Inter,system-ui,sans-serif;min-width:150px">` +
            `<div style="font-family:'Space Grotesk',system-ui,sans-serif;font-weight:600;color:#1E1B4B;margin-bottom:4px">${cp.name}</div>` +
            `<div style="font-size:12px;color:#475569"><span style="font-family:'Space Mono',monospace;font-weight:700">${cp.distance_m}m</span> away</div>` +
            `<div style="font-size:12px;color:#94a3b8;font-style:italic;margin-top:2px">No live lots or rates</div>` +
            `</div>`,
        )
        .on('click', () => onSelect(cp.id === selected ? null : cp.id))
      osmMarkersRef.current.push(marker)
    })
  }, [osmParking])

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
