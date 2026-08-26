import { memo, useEffect, useMemo, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import SmoothWheelZoom from './smoothWheelZoom'
import { getAvailability, type AvailState } from './availability'
import { formatLotCount, statusLine, LED_HEX } from './lots'
import type { FeedFreshness } from './freshness'
import type { Carpark, OsmParking, LatLon } from './types'

const pIcon = L.divIcon({
  className: '',
  html: '<div class="p-marker">P</div>',
  iconSize: [22, 22],
  iconAnchor: [11, 11],
})

// The basemap follows the system theme. Same style, same attribution, same
// domain authentication — only the ink changes.
const TILE_LIGHT = 'https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}.png'
const TILE_DARK = 'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}.png'

function prefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

function tileUrl(dark: boolean): string {
  return dark ? TILE_DARK : TILE_LIGHT
}

// Desktop wheel zoom feel, matched to Google Maps web.
//
// Leaflet's built-in ScrollWheelZoom batches wheel deltas, waits out
// wheelDebounceTime (40ms default; this app had 100ms for trackpad batching),
// then applies one step per batch rounded UP to the next zoomSnap multiple.
// Reproduced on a live map, that read as: a single mouse notch did nothing for
// ~110ms and then snapped a quarter level; six quick notches produced just two
// dead jumps (+0.5 each) with a 320ms dead gap in the middle of the gesture.
// Google Maps instead starts zooming within a frame and glides continuously.
//
// The fix is SmoothWheelZoom (see smoothWheelZoom.ts), registered here under
// Leaflet's own `scrollWheelZoom` handler name: it eases a fractional target
// zoom toward the cursor with requestAnimationFrame - no debounce, no rounding,
// animated by construction. The knobs below feed it:
//
//  * scrollWheelZoom false turns off the built-in debounced handler so only
//    the smooth one is listening.
//  * wheelPxPerZoomLevel 140 is now LINEAR pixels of wheel delta per level of
//    zoom (it fed a sigmoid in stock Leaflet). A standard notch (~33px of
//    normalised delta on macOS Chrome) is therefore worth ~0.24 levels, in the
//    Google Maps band of roughly three to five notches per level.
//  * smoothWheelZoom true is the handler's own master switch.
//
// Kept as-is:
//  * zoomSnap 0.25 still governs touch-pinch settle and fitBounds snapping -
//    non-zero snap keeps tiles crisp after a pinch. The wheel path no longer
//    goes through snap arithmetic at all, which is exactly the point.
//  * zoomDelta 1 keeps the +/- control and keyboard moving whole levels.
//  * Drag pan keeps Leaflet's built-in inertia (on by default).
//  * Touch behaviour is untouched: the smooth handler observes only `wheel`,
//    so pinch/drag on mobile run their stock Leaflet paths.
const ZOOM_FEEL = {
  scrollWheelZoom: false,
  smoothWheelZoom: true,
  wheelPxPerZoomLevel: 140,
  zoomSnap: 0.25,
  zoomDelta: 1,
} as const

const KAYA = '#1C6E4A'
const ERP_NAVY = '#1D3A6B'

// Carpark pin as a gantry board on a short post — the count you would read off
// the sign at the entrance, planted at the carpark. It is a divIcon, not a
// vector circleMarker, so it can live inside a marker cluster (markercluster
// cannot cluster circleMarkers).
//
// The board carries the number itself, which is what makes it readable without
// relying on colour: the previous dot pins needed a per-state shape glyph to be
// colour-blind safe, and "062" against "FULL" needs no such crutch.
const PIN_W = 48
const PIN_H = 38

function carparkIcon(state: AvailState, available: number | null, selected: boolean): L.DivIcon {
  return L.divIcon({
    className: '',
    html:
      `<div class="cp-board${selected ? ' cp-board--selected' : ''}">` +
      `<div class="gantry" data-state="${state}" style="color:${LED_HEX[state]}">${formatLotCount(available)}</div>` +
      `<div class="cp-board__post"></div>` +
      `</div>`,
    iconSize: [PIN_W, PIN_H],
    // The post tip is the carpark, so the pin hangs above its own coordinates.
    iconAnchor: [PIN_W / 2, PIN_H],
  })
}

// Cluster bubble themed to the app (kaya fill, cream ring, mono count).
function clusterIcon(cluster: L.MarkerCluster): L.DivIcon {
  const n = cluster.getChildCount()
  const size = n < 10 ? 34 : n < 100 ? 40 : 46
  return L.divIcon({
    className: '',
    html: `<div class="ehp-cluster" style="width:${size}px;height:${size}px">${n}</div>`,
    iconSize: [size, size],
  })
}

// The gantry board, as the popup's hero. Same rule as the card hero: the
// eyebrow only says the count is NOW when the feed really is now.
const POPUP_EYEBROW: Record<FeedFreshness, string> = {
  fresh: 'LOTS NOW &middot; LIVE',
  recent: 'LOTS &middot; RECENT UPDATE',
  saved: 'LOTS &middot; SAVED COUNT',
}

function boardHtml(
  state: AvailState,
  available: number | null,
  total: number | null,
  freshness: FeedFreshness,
): string {
  const eyebrow = state === 'nodata' ? 'NO LIVE COUNT' : POPUP_EYEBROW[freshness]
  const denominator =
    state === 'nodata' ? '' : `<div style="font-size:11px;color:#9B957F">of ${total} lots</div>`
  return (
    `<div style="display:flex;align-items:flex-end;justify-content:space-between;gap:10px;` +
    `background:#2A2320;border-radius:9px;padding:10px 12px">` +
    `<div>` +
    `<div style="font-family:'IBM Plex Mono',monospace;font-weight:700;font-size:28px;line-height:1;` +
    `color:${LED_HEX[state]}">${formatLotCount(available)}</div>` +
    `<div style="font-size:9px;font-weight:700;letter-spacing:.14em;color:#9B957F;margin-top:4px">${eyebrow}</div>` +
    `</div>` +
    `<div style="text-align:right">` +
    `<div style="font-size:12px;font-weight:800;color:#F6E7C6">${statusLine(state, available)}</div>` +
    denominator +
    `</div>` +
    `</div>`
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

// The go-action and Waze, rendered inside a Leaflet popup. Clicks stay inside
// the popup (target=_blank), so they never toggle the marker selection. Both
// keep a 44px hit target, the same as everywhere else in the app.
//
// "Confirm ah" is a Google Maps deep link and always was, but it is the only
// destination on the card or popup that does not say whose map it opens, while
// "Waze" right beside it does — which is why it read as a missing Google link.
// The eyebrow under the copy names the destination without spending the app's
// voice on it, in the same 9px tracked style the boards use for their eyebrows.
function navLinksHtml(lat: number, lon: number): string {
  return (
    `<div style="display:flex;align-items:center;gap:8px;margin-top:10px">` +
    `<a href="${gmapsDir(lat, lon)}" target="_blank" rel="noopener noreferrer" ` +
    `aria-label="Confirm ah — navigate with Google Maps" ` +
    `style="display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;min-height:44px;` +
    `border-radius:10px;background:${KAYA};color:#FFF8EA;text-decoration:none;` +
    `font-family:'Baloo 2',system-ui,sans-serif;font-weight:800;font-size:15px;line-height:1.1">` +
    `<span>Confirm ah &rarr;</span>` +
    `<span style="font-size:9px;font-weight:700;letter-spacing:.12em;opacity:.85">GOOGLE MAPS</span>` +
    `</a>` +
    `<a href="${wazeDir(lat, lon)}" target="_blank" rel="noopener noreferrer" ` +
    `style="display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 12px;` +
    `border-radius:10px;border:2px solid var(--link);color:var(--link);text-decoration:none;` +
    `font-family:'Baloo 2',system-ui,sans-serif;font-weight:800;font-size:14px">Waze</a>` +
    `</div>`
  )
}

function popupHtml(
  title: string,
  distance: number,
  rate: string,
  boardHtmlMarkup: string,
  lat: number,
  lon: number,
): string {
  return (
    `<div style="font-family:Overpass,system-ui,sans-serif;min-width:210px">` +
    `<div style="font-weight:800;font-size:15px;color:var(--ink);margin-bottom:8px">${esc(title)}</div>` +
    `${boardHtmlMarkup}` +
    `<div style="margin-top:8px;font-size:12px;color:var(--slate)">` +
    `<span style="font-family:'IBM Plex Mono',monospace;font-weight:700">${distance}m</span> away &middot; ${esc(rate)}` +
    `</div>` +
    navLinksHtml(lat, lon) +
    `</div>`
  )
}

function osmPopupHtml(name: string, distance: number, lat: number, lon: number): string {
  return (
    `<div style="font-family:Overpass,system-ui,sans-serif;min-width:200px">` +
    `<div style="font-weight:800;font-size:15px;color:var(--ink);margin-bottom:4px">${esc(name)}</div>` +
    `<div style="font-size:12px;color:var(--slate)"><span style="font-family:'IBM Plex Mono',monospace;font-weight:700">${distance}m</span> away</div>` +
    `<div style="font-size:12px;color:var(--eyebrow);margin-top:2px">No live lots or rates</div>` +
    navLinksHtml(lat, lon) +
    `</div>`
  )
}

interface MapProps {
  center: LatLon
  carparks: Carpark[]
  osmParking?: OsmParking[]
  // List rank per carpark id (1-based, position in the sorted list the user
  // sees). Popups carry the same number as the list card; backend distance
  // order disagrees with it under price/availability sort.
  ranks?: Record<string, number>
  selected: string | null
  onSelect: (id: string | null) => void
  userLocation: LatLon | null
  visible: boolean
  availabilityFreshness?: FeedFreshness
}

interface MarkerMeta {
  marker: L.Marker
  kind: 'hdb' | 'osm'
  state?: AvailState
  available?: number | null
}

// API responses are freshly allocated even when their marker-relevant content
// is unchanged. Use values, rather than array identity, to avoid rebuilding a
// large Leaflet cluster group for an equivalent response. Popup numbering is
// marker-relevant too: it must track the rank the list currently shows, so a
// re-sort joins an availability refresh as a rebuild trigger.
function markerSignature(
  carparks: Carpark[],
  osmParking: OsmParking[],
  availabilityFreshness: FeedFreshness,
  ranks: Record<string, number>,
): string {
  return [
    availabilityFreshness,
    ...carparks.map((cp) => [
      'h', cp.id, cp.lat, cp.lon, cp.address, cp.distance_m, cp.lots_available,
      cp.total_lots, cp.rate.known, cp.rate.summary, ranks[cp.id] ?? '',
    ].join(',')).sort(),
    ...osmParking.map((cp) => ['o', cp.id, cp.lat, cp.lon, cp.name, cp.distance_m].join(',')).sort(),
  ].join('|')
}

// Only the destination and primary result coordinates determine whether
// framing results is useful. Availability or popup-copy changes should refresh
// pins, not move the driver — and the supplemental OSM layer must not either:
// it can arrive seconds after the primary response, and refitting then would
// yank a driver who is already panning. OSM pins therefore never take part in
// this signature or in any fit it triggers.
function spatialSignature(center: LatLon, carparks: Carpark[]): string {
  return [
    center.lat,
    center.lon,
    ...carparks.map((cp) => `h:${cp.id}:${cp.lat}:${cp.lon}`).sort(),
  ].join('|')
}

function Map({
  center,
  carparks,
  osmParking = [],
  ranks = {},
  selected,
  onSelect,
  userLocation,
  visible,
  availabilityFreshness = 'fresh',
}: MapProps) {
  const mapRef = useRef<HTMLDivElement>(null)
  const instanceRef = useRef<L.Map | null>(null)
  const tilesRef = useRef<L.TileLayer | null>(null)
  const clusterRef = useRef<L.MarkerClusterGroup | null>(null)
  const centerMarkerRef = useRef<L.CircleMarker | null>(null)
  const userMarkerRef = useRef<L.CircleMarker | null>(null)
  // Marker lookup for cheap selection styling, the last-fitted spatial
  // signature (so we frame only a genuinely changed result set), the
  // previously-selected id, and a live mirror of `selected` so marker click
  // handlers read it without being rebuilt on every selection change.
  const metaRef = useRef<Record<string, MarkerMeta>>({})
  const lastFitRef = useRef<string>('')
  const prevSelRef = useRef<string | null>(null)
  const selectedRef = useRef<string | null>(selected)
  selectedRef.current = selected
  const currentMarkerSignature = useMemo(
    () => markerSignature(carparks, osmParking, availabilityFreshness, ranks),
    [availabilityFreshness, carparks, osmParking, ranks],
  )
  const currentSpatialSignature = useMemo(
    () => spatialSignature(center, carparks),
    [center, carparks],
  )

  useEffect(() => {
    if (!instanceRef.current && mapRef.current) {
      // The legend sits top-left over the map, which is where Leaflet parks its
      // zoom control by default — one covered the other. Desktop.dc.html draws
      // the +/- buttons in the top-right corner, so that is where they go, and
      // both are usable again.
      const map = L.map(mapRef.current, { zoomControl: false, ...ZOOM_FEEL }).setView(
        [center.lat, center.lon],
        15,
      )
      // Swap in the Google-style wheel zoom under Leaflet's own handler name,
      // so enable()/disable() semantics stay stock for any caller.
      map.addHandler('scrollWheelZoom', SmoothWheelZoom)
      map.scrollWheelZoom.enable()
      L.control.zoom({ position: 'topright' }).addTo(map)
      // Stadia Maps "Alidade Smooth": a muted basemap so the gantry boards pop.
      // Authenticated by domain (localhost for dev, the production origin
      // registered in the Stadia dashboard) — no key in the bundle. Within
      // their tile-usage terms, unlike the OSMF community server. The night
      // board draws the map as a dark surface, so the dark variant of the same
      // style follows the system theme; a lit board on a white map at 1am is
      // the one thing the design is emphatic about not doing.
      const tiles = L.tileLayer(tileUrl(prefersDark()), {
        attribution:
          '&copy; <a href="https://stadiamaps.com/" target="_blank" rel="noopener">Stadia Maps</a> ' +
          '&copy; <a href="https://openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> ' +
          '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
        maxZoom: 20,
      }).addTo(map)
      tilesRef.current = tiles
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

  // Follow a live theme switch, so the map does not stay bright after the
  // phone rolls into its night appearance under a session already open.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent) => tilesRef.current?.setUrl(tileUrl(e.matches))
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const map = instanceRef.current
    if (!map) return
    if (centerMarkerRef.current) centerMarkerRef.current.remove()
    centerMarkerRef.current = L.circleMarker([center.lat, center.lon], {
      radius: 8,
      color: '#FFF8EA',
      fillColor: KAYA,
      fillOpacity: 1,
      weight: 3,
    })
      .addTo(map)
      .bindPopup('Destination')
  }, [center])

  // Build the clustered parking pins (carparks + de-duped OSM). A semantic
  // signature, rather than response-array identity, keeps equivalent refetches
  // from tearing down hundreds of Leaflet markers. Selection is separate.
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
        icon: carparkIcon(a.state, a.available, cp.id === sel),
        title,
      })
        .bindPopup(
          popupHtml(
            `${ranks[cp.id] ?? i + 1}. ${cp.address}`,
            cp.distance_m,
            cp.rate.known ? cp.rate.summary : 'Rate unknown',
            boardHtml(a.state, a.available, a.total, availabilityFreshness),
            cp.lat,
            cp.lon,
          ),
        )
        .on('click', () => onSelect(cp.id === selectedRef.current ? null : cp.id))
      markers.push(m)
      meta[cp.id] = { marker: m, kind: 'hdb', state: a.state, available: a.available }
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

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMarkerSignature])

  // Deliberately frame a new spatial result set. This is intentionally separate
  // from marker construction: selection, sort, loading/error/offline banners,
  // and availability-only refreshes retain the driver's manual viewport. So do
  // late-arriving OSM pins: the supplemental layer fills in up to
  // OSM_TIMEOUT_MS after the primary results, and refitting when it lands
  // would snap the viewport back mid-pan. Only destination + primary result
  // changes trigger a fit (OSM pins still render into the rebuilt cluster).
  useEffect(() => {
    const map = instanceRef.current
    if (!map || lastFitRef.current === currentSpatialSignature) return
    lastFitRef.current = currentSpatialSignature
    if (carparks.length > 0) {
      const pts: L.LatLngTuple[] = [
        [center.lat, center.lon],
        ...carparks.map((cp) => [cp.lat, cp.lon] as L.LatLngTuple),
      ]
      map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] })
    } else {
      // A changed result set with no primary results: still follow the
      // destination rather than leaving the map on the previous place.
      map.setView([center.lat, center.lon], 15)
    }
  }, [carparks, center, currentSpatialSignature])

  // Selection: restyle just the affected pins and open the selected popup,
  // instead of rebuilding the whole layer.
  useEffect(() => {
    const cluster = clusterRef.current
    if (!cluster) return
    const meta = metaRef.current
    const prev = prevSelRef.current
    if (prev && prev !== selected) {
      const pm = meta[prev]
      if (pm?.kind === 'hdb' && pm.state) {
        pm.marker.setIcon(carparkIcon(pm.state, pm.available ?? null, false))
      }
    }
    if (selected) {
      const sm = meta[selected]
      if (sm) {
        if (sm.kind === 'hdb' && sm.state) {
          sm.marker.setIcon(carparkIcon(sm.state, sm.available ?? null, true))
        }
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
      color: '#FFF8EA',
      fillColor: ERP_NAVY,
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
