import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

const { MapMock } = vi.hoisted(() => ({ MapMock: vi.fn(() => null) }))
vi.mock('./Map', () => ({ default: MapMock }))
vi.mock('./geo', () => ({ getCurrentPosition: vi.fn(() => Promise.reject(new Error('no geo'))) }))

import App from './App'

const okJson = (data: unknown, headerValues: Record<string, string> = {}) => ({
  ok: true, status: 200, headers: new Headers(headerValues), json: async () => data,
})
const carpark = (id: string, address = id) => ({
  id, name: null, address, lat: 1.37, lon: 103.85, distance_m: 100,
  lots_available: 10, total_lots: 20, type: 'Multi-storey', category: 'HDB',
  rate: { known: false, summary: '', first_hour: null, subsequent_half_hour: null, weekday_raw: null, saturday_raw: null, sunday_ph_raw: null },
  free_parking_info: null, sources: [], ev: false, ev_total: null, ev_available: null,
  ev_operators: [], ev_max_power_kw: null, carwash: false, carwash_operator: null,
})
const osm = (id: string, name = id) => ({
  id, name, lat: 1.3, lon: 103.8, distance_m: 120, source: 'osm',
  fee: null, parking_type: null, capacity: null,
})
const spotsNearby = (n: number, order = 'nearest first') =>
  screen.getByText((_, node) =>
    (node?.textContent ?? '').replace(/\s+/g, ' ').trim() === `${n} spot${n === 1 ? '' : 's'} · ${order}`)
const lastMapProps = () =>
  (MapMock.mock.calls as unknown[][]).at(-1)?.[0] as { osmParking: unknown[] } | undefined

const evCarpark = () => ({ ...carpark('cp-ev', 'EV carpark'), ev: true, ev_total: 2, ev_available: 1 })
const snapWith = (filters: unknown) => ({
  carparks: [evCarpark()], osmParking: [osm('osm-1', 'Open lot')],
  center: { lat: 1.37, lon: 103.85 }, ts: 0, filters,
})
const evFilters = { radius: 500, category: null, freeSunPh: false, hasLots: false, hasEv: true, hasCarwash: false }
const goOffline = () => Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true })
const goOnline = () => Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true })

beforeEach(() => { localStorage.clear(); MapMock.mockClear(); window.history.replaceState(null, '', '/') })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); goOnline() })

describe('OX adversarial probes', () => {
  it('T1 online restore issues exactly one /api/carparks even AFTER the 250ms debounce window', async () => {
    localStorage.setItem('ehparkleh:last', JSON.stringify(snapWith(evFilters)))
    vi.useFakeTimers()
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/parking/osm')) return okJson([osm('osm-1')])
      return okJson([evCarpark()])
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    const cp = fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.includes('/api/carparks'))
    const om = fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.includes('/api/parking/osm'))
    expect({ carparks: cp.length, osm: om.length }).toEqual({ carparks: 1, osm: 1 })
    vi.useRealTimers()
  })

  it('T2 offline restore fires NO doomed request after the debounce window either', async () => {
    localStorage.setItem('ehparkleh:last', JSON.stringify(snapWith(evFilters)))
    goOffline()
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(fetchMock).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('T3 offline: clearing the restored chip must not resurrect the hidden OSM pins', async () => {
    localStorage.setItem('ehparkleh:last', JSON.stringify(snapWith(evFilters)))
    goOffline()
    const fetchMock = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    expect(await screen.findByText('EV carpark')).toBeInTheDocument()
    expect(lastMapProps()?.osmParking).toEqual([])
    // User taps the restored EV chip off to see everything. Offline, no new data can arrive.
    fireEvent.click(screen.getByRole('button', { name: /EV charging/i }))
    await act(async () => { await new Promise((r) => setTimeout(r, 400)) })
    // The rows on screen are still the EV subset: OSM pins must stay hidden and
    // the count must not claim a picture no search produced.
    expect(lastMapProps()?.osmParking).toEqual([])
    expect(spotsNearby(1)).toBeInTheDocument()
  })

  it('T4 truthy-but-not-true malformed filter values fall back to defaults', async () => {
    localStorage.setItem('ehparkleh:last', JSON.stringify(
      snapWith({ radius: '2000', category: 42, freeSunPh: 'yes', hasLots: 1, hasEv: 'true', hasCarwash: {} })))
    goOffline()
    vi.stubGlobal('fetch', vi.fn())
    render(<App />)
    expect(await screen.findByText('EV carpark')).toBeInTheDocument()
    expect(screen.queryByText(/^Showing .* only$/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /EV charging/i })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('radio', { name: '500m' })).toHaveAttribute('aria-checked', 'true')
  })

  it('T5 legacy snapshot with NO filters key restores unfiltered, offline, without error', async () => {
    const legacy = snapWith(undefined) as Record<string, unknown>
    delete legacy.filters
    localStorage.setItem('ehparkleh:last', JSON.stringify(legacy))
    goOffline()
    vi.stubGlobal('fetch', vi.fn())
    render(<App />)
    expect(await screen.findByText('EV carpark')).toBeInTheDocument()
    expect(screen.queryByText(/^Showing .* only$/)).not.toBeInTheDocument()
    expect(lastMapProps()?.osmParking).toHaveLength(1)
    expect(spotsNearby(2)).toBeInTheDocument()
  })

  it('T6 a non-default restored radius reaches both the request and the radius control', async () => {
    localStorage.setItem('ehparkleh:last', JSON.stringify(snapWith({ ...evFilters, radius: 2000 })))
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('/api/parking/osm') ? okJson([]) : okJson([evCarpark()]))
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    expect(await screen.findByText('EV carpark')).toBeInTheDocument()
    const url = String(fetchMock.mock.calls.find(([u]) => String(u).includes('/api/carparks'))?.[0])
    expect(url).toContain('radius=2000')
    expect(screen.getByRole('radio', { name: '2km' })).toHaveAttribute('aria-checked', 'true')
  })

  it('T7 half a deep link (?lat only) still restores the snapshot filters', async () => {
    window.history.replaceState(null, '', '/?lat=1.37')
    localStorage.setItem('ehparkleh:last', JSON.stringify(snapWith(evFilters)))
    goOffline()
    vi.stubGlobal('fetch', vi.fn())
    render(<App />)
    expect(await screen.findByText('EV carpark')).toBeInTheDocument()
    expect(screen.getByText(/Showing EV charging only/i)).toBeInTheDocument()
  })

  it('T8 a tampered category string is restored verbatim into the filter eyebrow and the query', async () => {
    localStorage.setItem('ehparkleh:last', JSON.stringify(snapWith({ ...evFilters, hasEv: false, category: 'NOT-A-REAL-CATEGORY' })))
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('/api/parking/osm') ? okJson([]) : okJson([evCarpark()]))
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    expect(await screen.findByText('EV carpark')).toBeInTheDocument()
    const url = String(fetchMock.mock.calls.find(([u]) => String(u).includes('/api/carparks'))?.[0])
    // Documents the behaviour: unvalidated storage text becomes a live filter + UI copy.
    expect(url).toContain('category=NOT-A-REAL-CATEGORY')
    expect(screen.getByText(/Showing NOT-A-REAL-CATEGORY only/i)).toBeInTheDocument()
  })
})
