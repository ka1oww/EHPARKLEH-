import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import type { Carpark } from './types'
import SmoothWheelZoom from './smoothWheelZoom'

const leaflet = vi.hoisted(() => {
  const map = {
    addHandler: vi.fn(),
    fitBounds: vi.fn(),
    invalidateSize: vi.fn(),
    scrollWheelZoom: { enable: vi.fn() },
    setView: vi.fn((_center?: unknown, _zoom?: number) => map),
  }
  const cluster = {
    addTo: vi.fn(),
    addLayers: vi.fn(),
    clearLayers: vi.fn(),
    zoomToShowLayer: vi.fn((_marker: unknown, done: () => void) => done()),
  }
  cluster.addTo.mockReturnValue(cluster)
  const marker = () => {
    const result = {
      bindPopup: vi.fn(),
      on: vi.fn(),
      openPopup: vi.fn(),
      setIcon: vi.fn(),
    }
    result.bindPopup.mockReturnValue(result)
    result.on.mockReturnValue(result)
    return result
  }
  const circleMarker = () => {
    const result = { addTo: vi.fn(), bindPopup: vi.fn(), remove: vi.fn() }
    result.addTo.mockReturnValue(result)
    result.bindPopup.mockReturnValue(result)
    return result
  }
  return {
    cluster,
    L: {
      circleMarker: vi.fn(circleMarker),
      control: { zoom: vi.fn(() => ({ addTo: vi.fn() })) },
      divIcon: vi.fn((options: unknown) => options),
      latLngBounds: vi.fn((points: unknown) => points),
      map: vi.fn(() => map),
      marker: vi.fn(marker),
      markerClusterGroup: vi.fn(() => cluster),
      tileLayer: vi.fn(() => ({ addTo: vi.fn() })),
      // Imported for its side effect on the map wiring: smoothWheelZoom
      // extends this and registers itself through addHandler.
      Handler: class {
        _map?: unknown
        constructor(map?: unknown) {
          this._map = map
        }
        enable() {}
        disable() {}
      },
      Util: { requestAnimFrame: vi.fn(() => 0), cancelAnimFrame: vi.fn() },
      DomEvent: { stop: vi.fn(), getWheelDelta: vi.fn(() => 0), on: vi.fn(), off: vi.fn() },
    },
    map,
  }
})

vi.mock('leaflet', () => ({ default: leaflet.L }))
vi.mock('leaflet.markercluster', () => ({}))

import Map from './Map'

const carpark = (overrides: Partial<Carpark> = {}): Carpark => ({
  id: 'cp-1',
  name: null,
  address: 'Block 1',
  lat: 1.37,
  lon: 103.85,
  distance_m: 100,
  lots_available: 10,
  total_lots: 20,
  type: 'Multi-storey',
  category: 'HDB',
  rate: {
    known: true,
    summary: '$0.60 per 30 min',
    first_hour: 1.2,
    subsequent_half_hour: 0.6,
    weekday_raw: null,
    saturday_raw: null,
    sunday_ph_raw: null,
  },
  free_parking_info: null,
  sources: [],
  ev: false,
  ev_total: null,
  ev_available: null,
  ev_operators: [],
  ev_max_power_kw: null,
  carwash: false,
  carwash_operator: null,
  ...overrides,
})

const props = (overrides: Partial<React.ComponentProps<typeof Map>> = {}) => ({
  center: { lat: 1.37, lon: 103.85 },
  carparks: [carpark()],
  osmParking: [],
  selected: null,
  onSelect: vi.fn(),
  userLocation: null,
  visible: true,
  ...overrides,
})

describe('Map zoom feel', () => {
  beforeEach(() => vi.clearAllMocks())

  // Google Maps zooms the wheel continuously, cursor-anchored and animated.
  // The debounced stock handler cannot do that, so the map swaps in
  // SmoothWheelZoom under Leaflet's own handler name and turns the built-in
  // off. zoomSnap stays non-zero for pinch settle / fitBounds; touch is not
  // part of this wiring at all (the smooth handler only listens to `wheel`).
  it('creates the map with Google-style smooth wheel zoom wired in', () => {
    render(<Map {...props()} />)

    const options = (leaflet.L.map.mock.calls[0] as unknown[])[1] as Record<string, unknown>
    expect(options.scrollWheelZoom).toBe(false)
    expect(options.smoothWheelZoom).toBe(true)
    expect(options.wheelPxPerZoomLevel).toBe(140)
    expect(options.zoomSnap).toBe(0.25)
    expect(options.zoomDelta).toBe(1)
    // The old debounce knob has no meaning without the debounced handler.
    expect(options.wheelDebounceTime).toBeUndefined()
    expect(options.zoomControl).toBe(false)
  })

  it('enables the smooth handler registered under Leaflet\u2019s scrollWheelZoom name', () => {
    render(<Map {...props()} />)

    expect(leaflet.map.addHandler).toHaveBeenCalledWith('scrollWheelZoom', SmoothWheelZoom)
    expect(leaflet.map.scrollWheelZoom.enable).toHaveBeenCalledTimes(1)
  })
})

describe('Map popup navigation links', () => {
  beforeEach(() => vi.clearAllMocks())

  // The popup's go-action is a Google Maps deep link, but "Confirm ah" alone
  // named no destination while "Waze" beside it did, so it read as missing.
  it('names Google Maps on the popup go-action, alongside Waze', () => {
    render(<Map {...props({ carparks: [carpark({ lat: 1.37, lon: 103.85 })] })} />)

    const html = leaflet.L.marker.mock.results[0].value.bindPopup.mock.calls[0][0] as string
    expect(html).toContain('https://www.google.com/maps/dir/?api=1&destination=1.37,103.85')
    expect(html).toContain('GOOGLE MAPS')
    expect(html).toContain('aria-label="Confirm ah \u2014 navigate with Google Maps"')
    expect(html).toContain('https://www.waze.com/ul?ll=1.37,103.85&navigate=yes')
  })

  it('names Google Maps on an OSM pin popup too', () => {
    render(
      <Map
        {...props({
          carparks: [],
          osmParking: [
            { id: 'osm_1', name: 'Blk 1 Carpark', lat: 1.37, lon: 103.85, distance_m: 90, source: 'osm', fee: null, parking_type: null, capacity: null },
          ],
        })}
      />,
    )

    const html = leaflet.L.marker.mock.results[0].value.bindPopup.mock.calls[0][0] as string
    expect(html).toContain('https://www.google.com/maps/dir/?api=1&destination=1.37,103.85')
    expect(html).toContain('GOOGLE MAPS')
  })
})

describe('Map marker and viewport updates', () => {
  beforeEach(() => vi.clearAllMocks())

  it('keeps a driver-adjusted viewport and cluster when selection or an equivalent refetch changes UI state', () => {
    const first = props()
    const { rerender } = render(<Map {...first} />)
    expect(leaflet.cluster.clearLayers).toHaveBeenCalledTimes(1)
    expect(leaflet.map.fitBounds).toHaveBeenCalledTimes(1)

    // This call stands in for a deliberate pan/zoom by the driver.
    leaflet.map.setView([1.31, 103.82], 16)
    rerender(<Map {...props({ selected: 'cp-1' })} />)
    rerender(<Map {...props({ carparks: [{ ...carpark() }] })} />)

    expect(leaflet.cluster.clearLayers).toHaveBeenCalledTimes(1)
    expect(leaflet.map.fitBounds).toHaveBeenCalledTimes(1)
    expect(leaflet.map.setView).toHaveBeenCalledTimes(2)
  })

  it('updates availability pins without reframing, then frames a genuinely changed spatial result set', () => {
    const { rerender } = render(<Map {...props()} />)
    expect(leaflet.map.fitBounds).toHaveBeenCalledTimes(1)

    rerender(<Map {...props({ carparks: [carpark({ lots_available: 1 })] })} />)
    expect(leaflet.cluster.clearLayers).toHaveBeenCalledTimes(2)
    expect(leaflet.map.fitBounds).toHaveBeenCalledTimes(1)

    rerender(<Map {...props({ carparks: [carpark({ lat: 1.38 })] })} />)
    expect(leaflet.cluster.clearLayers).toHaveBeenCalledTimes(3)
    expect(leaflet.map.fitBounds).toHaveBeenCalledTimes(2)
  })

  it('does not rebuild or reframe an equivalent response whose entries arrive in a different order', () => {
    const first = carpark({ id: 'cp-1', lat: 1.37 })
    const second = carpark({ id: 'cp-2', lat: 1.38 })
    const { rerender } = render(<Map {...props({ carparks: [first, second] })} />)
    expect(leaflet.cluster.clearLayers).toHaveBeenCalledTimes(1)
    expect(leaflet.map.fitBounds).toHaveBeenCalledTimes(1)

    rerender(<Map {...props({ carparks: [second, first] })} />)

    expect(leaflet.cluster.clearLayers).toHaveBeenCalledTimes(1)
    expect(leaflet.map.fitBounds).toHaveBeenCalledTimes(1)
  })
})
