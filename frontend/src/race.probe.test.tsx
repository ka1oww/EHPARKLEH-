import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { LatLon } from './types'

// Regression tests for the geocode race: the place lookup awaits outside
// runSearch's request-version guard, so a slow older response must never
// republish an older destination over a newer search's results.

const { MapMock } = vi.hoisted(() => ({ MapMock: vi.fn(() => null) }))
vi.mock('./Map', () => ({ default: MapMock }))
vi.mock('./geo', () => ({ getCurrentPosition: vi.fn(() => Promise.reject(new Error('no geo'))) }))

import App from './App'
import { getCurrentPosition } from './geo'

const okJson = (data: unknown) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: async () => data,
})

const carpark = (id: string, address = id) => ({
  id,
  name: null,
  address,
  lat: 1.37,
  lon: 103.85,
  distance_m: 100,
  lots_available: 10,
  total_lots: 20,
  type: 'Multi-storey',
  category: 'HDB',
  rate: { known: false, summary: '', first_hour: null, subsequent_half_hour: null, weekday_raw: null, saturday_raw: null, sunday_ph_raw: null },
  free_parking_info: null,
  sources: [],
  ev: false,
  ev_total: null,
  ev_available: null,
  ev_operators: [],
  ev_max_power_kw: null,
  carwash: false,
  carwash_operator: null,
})

const carparksCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
  (fetchMock.mock.calls as unknown[][]).filter(([url]) => String(url).includes('/api/carparks'))

beforeEach(() => {
  localStorage.clear()
  MapMock.mockClear()
  // No deep link, no snapshot: the app starts on its welcome screen.
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('geocode race against a newer search', () => {
  it('a late geocode response does not clobber a completed Near me search', async () => {
    let resolveGeocode: ((response: ReturnType<typeof okJson>) => void) | undefined
    let resolveLocation: ((location: { lat: number; lon: number }) => void) | undefined
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/geocode')) {
        return new Promise((resolve) => { resolveGeocode = resolve })
      }
      if (!url.includes('/api/carparks')) return Promise.resolve(okJson([]))
      if (url.includes('lat=1.37')) {
        return Promise.resolve(okJson([carpark('nearme-result', 'Near me result')]))
      }
      return Promise.resolve(okJson([carpark('geocoded-result', 'Geocoded result')]))
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.mocked(getCurrentPosition).mockImplementationOnce(
      () =>
        new Promise<LatLon>((resolve) => {
          resolveLocation = resolve
        }),
    )

    render(<App />)

    // The person submits a place search; the lookup hangs.
    const searchBox = screen.getByRole('combobox')
    fireEvent.change(searchBox, { target: { value: 'Slow place' } })
    fireEvent.submit(screen.getByRole('search'))

    // While it pends, they tap Near me and results arrive.
    fireEvent.click(screen.getByRole('button', { name: /near me/i }))
    await act(async () => {
      resolveLocation?.({ lat: 1.37, lon: 103.85 })
      await Promise.resolve()
    })
    expect(await screen.findByText('Near me result')).toBeInTheDocument()

    // The stale geocode finally resolves: it must be discarded, not win.
    await act(async () => {
      resolveGeocode?.(okJson({ lat: 1.4, lon: 103.9 }))
      await Promise.resolve()
    })

    expect(screen.getByText('Near me result')).toBeInTheDocument()
    expect(screen.queryByText('Geocoded result')).not.toBeInTheDocument()
    expect(
      carparksCalls(fetchMock).some(([url]) => String(url).includes('lat=1.4')),
    ).toBe(false)
  })

  it('a late geolocation fix does not clobber a newer place search', async () => {
    let resolveLocation: ((location: { lat: number; lon: number }) => void) | undefined
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/geocode')) {
        return Promise.resolve(okJson({ lat: 1.43, lon: 103.93 }))
      }
      if (!url.includes('/api/carparks')) return Promise.resolve(okJson([]))
      if (url.includes('lat=1.37')) {
        return Promise.resolve(okJson([carpark('nearme-result', 'Near me result')]))
      }
      return Promise.resolve(okJson([carpark('geocoded-result', 'Geocoded result')]))
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.mocked(getCurrentPosition).mockImplementationOnce(
      () =>
        new Promise<LatLon>((resolve) => {
          resolveLocation = resolve
        }),
    )

    render(<App />)

    // Near me is tapped first, but the GPS fix hangs.
    fireEvent.click(screen.getByRole('button', { name: /near me/i }))

    // Impatient, they type a destination instead; its results land.
    const searchBox = screen.getByRole('combobox')
    fireEvent.change(searchBox, { target: { value: 'Somewhere else' } })
    fireEvent.submit(screen.getByRole('search'))
    expect(await screen.findByText('Geocoded result')).toBeInTheDocument()

    // The stale GPS fix finally resolves: it must be discarded, not searched.
    await act(async () => {
      resolveLocation?.({ lat: 1.37, lon: 103.85 })
      await Promise.resolve()
    })

    expect(screen.getByText('Geocoded result')).toBeInTheDocument()
    expect(screen.queryByText('Near me result')).not.toBeInTheDocument()
    expect(
      carparksCalls(fetchMock).some(([url]) => String(url).includes('lat=1.37')),
    ).toBe(false)
  })

  it('a failed Near me tap clears the loading board it took over', async () => {
    let resolveGeocode: ((response: ReturnType<typeof okJson>) => void) | undefined
    let rejectLocation: ((err: unknown) => void) | undefined
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/geocode')) {
        return new Promise((resolve) => { resolveGeocode = resolve })
      }
      if (!url.includes('/api/carparks')) return Promise.resolve(okJson([]))
      return Promise.resolve(okJson([carpark('geocoded-result', 'Geocoded result')]))
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.mocked(getCurrentPosition).mockImplementationOnce(
      () =>
        new Promise<LatLon>((_resolve, reject) => {
          rejectLocation = reject
        }),
    )

    render(<App />)

    // A place search is pending...
    const searchBox = screen.getByRole('combobox')
    fireEvent.change(searchBox, { target: { value: 'Slow place' } })
    fireEvent.submit(screen.getByRole('search'))
    expect(await screen.findByText('Finding spots…')).toBeInTheDocument()

    // ...when Near me takes the destination over, then fails outright.
    fireEvent.click(screen.getByRole('button', { name: /near me/i }))
    await act(async () => {
      rejectLocation?.({ code: 1 })
      await Promise.resolve()
    })

    // The superseded geocode is no longer allowed to publish its completion,
    // so the Near me tap has to put the board down itself.
    await act(async () => {
      resolveGeocode?.(okJson({ lat: 1.4, lon: 103.9 }))
      await Promise.resolve()
    })

    expect(screen.queryByText('Finding spots…')).not.toBeInTheDocument()
    expect(screen.queryByText('Refreshing saved spots…')).not.toBeInTheDocument()
    expect(screen.getByText(/Location is blocked for this site/)).toBeInTheDocument()
  })

  it('two rapid submissions resolve in favour of the newest query', async () => {
    const resolveGeocodes: Array<(response: ReturnType<typeof okJson>) => void> = []
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/geocode')) {
        return new Promise((resolve) => { resolveGeocodes.push(resolve) })
      }
      if (!url.includes('/api/carparks')) return Promise.resolve(okJson([]))
      if (url.includes('lat=1.41')) {
        return Promise.resolve(okJson([carpark('older-result', 'Older result')]))
      }
      return Promise.resolve(okJson([carpark('newer-result', 'Newer result')]))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    const searchBox = screen.getByRole('combobox')
    fireEvent.change(searchBox, { target: { value: 'First place' } })
    fireEvent.submit(screen.getByRole('search'))
    fireEvent.change(searchBox, { target: { value: 'Second place' } })
    fireEvent.submit(screen.getByRole('search'))
    expect(resolveGeocodes.length).toBe(2)

    // The OLDER lookup resolves first: it must lose to the newer submission.
    await act(async () => {
      resolveGeocodes[0](okJson({ lat: 1.41, lon: 103.91 }))
      await Promise.resolve()
    })

    expect(screen.queryByText('Older result')).not.toBeInTheDocument()
    expect(
      carparksCalls(fetchMock).some(([url]) => String(url).includes('lat=1.41')),
    ).toBe(false)

    await act(async () => {
      resolveGeocodes[1](okJson({ lat: 1.42, lon: 103.92 }))
      await Promise.resolve()
    })

    expect(await screen.findByText('Newer result')).toBeInTheDocument()
    expect(screen.queryByText('Older result')).not.toBeInTheDocument()
  })
})
