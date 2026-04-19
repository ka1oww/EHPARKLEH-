import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

export default function Map({ center, carparks, selected, onSelect, userLocation }) {
  const mapRef = useRef(null)
  const instanceRef = useRef(null)
  const markersRef = useRef([])
  const centerMarkerRef = useRef(null)
  const userMarkerRef = useRef(null)

  useEffect(() => {
    if (!instanceRef.current) {
      instanceRef.current = L.map(mapRef.current).setView([center.lat, center.lon], 15)
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
      radius: 8, color: '#e74c3c', fillColor: '#e74c3c', fillOpacity: 1, weight: 2,
    }).addTo(map).bindPopup('Destination')
  }, [center])

  useEffect(() => {
    const map = instanceRef.current
    if (!map) return

    markersRef.current.forEach(m => m.remove())
    markersRef.current = []

    if (carparks.length === 0) return

    carparks.forEach((cp, i) => {
      const isSelected = cp.id === selected
      const marker = L.circleMarker([cp.lat, cp.lon], {
        radius: isSelected ? 12 : 8,
        color: isSelected ? '#f59e0b' : '#38a169',
        fillColor: isSelected ? '#f59e0b' : '#38a169',
        fillOpacity: 0.9,
        weight: 2,
      })
        .addTo(map)
        .bindPopup(`
          <b>${i + 1}. ${cp.address}</b><br/>
          ${cp.distance_m}m away<br/>
          ${cp.free_parking ? 'Free' : `$${cp.cost_per_30min.toFixed(2)}/30min`}<br/>
          ${cp.lots_available !== null ? `${cp.lots_available}/${cp.total_lots} lots` : 'Availability N/A'}
        `)
        .on('click', () => onSelect(cp.id === selected ? null : cp.id))

      if (isSelected) marker.openPopup()
      markersRef.current.push(marker)
    })

    if (!selected) {
      const allPoints = [
        [center.lat, center.lon],
        ...carparks.map(cp => [cp.lat, cp.lon]),
      ]
      map.fitBounds(L.latLngBounds(allPoints), { padding: [40, 40] })
    } else {
      const cp = carparks.find(c => c.id === selected)
      if (cp) map.setView([cp.lat, cp.lon], Math.max(map.getZoom(), 16))
    }
  }, [carparks, selected])

  useEffect(() => {
    const map = instanceRef.current
    if (!map || !userLocation) return
    if (userMarkerRef.current) userMarkerRef.current.remove()
    userMarkerRef.current = L.circleMarker([userLocation.lat, userLocation.lon], {
      radius: 8, color: '#3d6bce', fillColor: '#3d6bce', fillOpacity: 1, weight: 3,
    }).addTo(map).bindPopup('You are here')
  }, [userLocation])

  return <div ref={mapRef} style={{ height: '100%', width: '100%' }} />
}
