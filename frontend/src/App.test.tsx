import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { LatLon } from './types'

// The lazy map and geolocation are irrelevant to these list-state assertions.
const { MapMock } = vi.hoisted(() => ({ MapMock: vi.fn(() => null) }))
vi.mock('./Map', () => ({ default: MapMock }))
vi.mock('./geo', () => ({ getCurrentPosition: vi.fn(() => Promise.reject(new Error('no geo'))) }))

import App from './App'

const okJson = (data: unknown) => ({ ok: true, status: 200, json: async () => data })

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

beforeEach(() => {
  localStorage.clear()
  MapMock.mockClear()
  // A ?lat/lon URL makes App run one search on mount, so we can assert its result state.
  window.history.replaceState(null, '', '/?lat=1.37&lon=103.85')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('App search result states', () => {
  it('shows a neutral empty state (not an error) when a search returns nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson([])),
    )
    render(<App />)
    expect(await screen.findByText(/No spots match here/i)).toBeInTheDocument()
    expect(screen.queryByText(/Can't reach the server/i)).not.toBeInTheDocument()
  })

  it('shows an error banner (not the empty state) when the carparks request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('/api/carparks')) return { ok: false, status: 500, json: async () => ({}) }
        return okJson([])
      }),
    )
    render(<App />)
    expect(await screen.findByText(/Can't reach the server/i)).toBeInTheDocument()
    expect(screen.queryByText(/No spots match here/i)).not.toBeInTheDocument()
  })

  it('only obtains location after the person chooses Near me', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson([])))
    const { getCurrentPosition } = await import('./geo')
    render(<App />)

    expect(getCurrentPosition).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /near me/i }))
    expect(getCurrentPosition).toHaveBeenCalledOnce()
  })

  it('keeps the browser-settings recovery when Near me is denied', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson([])))
    const { getCurrentPosition } = await import('./geo')
    vi.mocked(getCurrentPosition).mockRejectedValueOnce({ code: 1 })
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: /near me/i }))
    expect(await screen.findByText(/Location is blocked for this site/i)).toBeInTheDocument()
  })

  it('keeps the lazy map out of the initial mobile list view', async () => {
    const matchMedia = vi.fn(
      () =>
        ({
          matches: true,
          media: '(max-width: 767.98px)',
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    )
    vi.stubGlobal('matchMedia', matchMedia)
    vi.stubGlobal('fetch', vi.fn(async () => okJson([])))

    render(<App />)

    await screen.findByText(/No spots match here/i)
    expect(matchMedia).toHaveBeenCalledWith('(max-width: 767.98px)')
    expect(MapMock).not.toHaveBeenCalled()
  })

  it('does not refetch OSM when a non-spatial filter changes', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => okJson([]))
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)

    await act(async () => {})
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/parking/osm'))).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: /EV charging/i }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })

    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/carparks'))).toHaveLength(2)
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/parking/osm'))).toHaveLength(1)
    vi.useRealTimers()
  })

  it('does not refetch OSM when a debounced radius change returns to the radius already searched', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => okJson([]))
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)

    await act(async () => {})
    fireEvent.click(screen.getByRole('radio', { name: '1km' }))
    fireEvent.click(screen.getByRole('radio', { name: '500m' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })

    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/carparks'))).toHaveLength(2)
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/parking/osm'))).toHaveLength(1)
    vi.useRealTimers()
  })

  it('does not publish an old filter response during the next debounce', async () => {
    vi.useFakeTimers()
    let resolveOldFilter: ((response: ReturnType<typeof okJson>) => void) | undefined
    let carparkCalls = 0
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (!String(input).includes('/api/carparks')) return Promise.resolve(okJson([]))
      carparkCalls += 1
      if (carparkCalls === 1) return Promise.resolve(okJson([carpark('initial-result', 'Initial result')]))
      return new Promise((resolve) => { resolveOldFilter = resolve })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    await act(async () => {})
    expect(screen.getByText('Initial result')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /EV charging/i }))
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    fireEvent.click(screen.getByRole('button', { name: /Car wash/i }))
    await act(async () => {
      resolveOldFilter?.(okJson([carpark('old-result', 'Old result')]))
      await Promise.resolve()
    })

    expect(screen.queryByText('Old result')).not.toBeInTheDocument()
    expect(screen.getByText(/Finding spots/i)).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('keeps a pending location search when its filters change', async () => {
    vi.useFakeTimers()
    let carparkCalls = 0
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (!String(input).includes('/api/carparks')) return Promise.resolve(okJson([]))
      carparkCalls += 1
      if (carparkCalls === 1) return new Promise(() => {})
      return Promise.resolve(okJson([carpark('filtered-result', 'Filtered result')]))
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)

    await act(async () => {})

    fireEvent.click(screen.getByRole('button', { name: /EV charging/i }))
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })

    const carparkRequests = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/carparks'))
    expect(carparkRequests).toHaveLength(2)
    expect(String(carparkRequests[1][0])).toContain('lat=1.37')
    expect(String(carparkRequests[1][0])).toContain('has_ev=true')
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/parking/osm'))).toHaveLength(2)
    expect(screen.getByText('Filtered result')).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('keeps new-location state when a filter retries the search', async () => {
    vi.useFakeTimers()
    localStorage.setItem(
      'ehparkleh:recent',
      JSON.stringify([{ query: 'Pending place', lat: 1.4, lon: 103.9, ts: 0 }]),
    )
    let destinationCalls = 0
    let resolveRetriedDestination: ((response: ReturnType<typeof okJson>) => void) | undefined
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (!url.includes('/api/carparks')) return Promise.resolve(okJson([]))
      if (url.includes('lat=1.37')) return Promise.resolve(okJson([carpark('current-result', 'Current result')]))
      destinationCalls += 1
      if (destinationCalls === 1) return new Promise(() => {})
      return new Promise((resolve) => { resolveRetriedDestination = resolve })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    await act(async () => {})
    expect(screen.getByText('Current result')).toBeInTheDocument()

    fireEvent.focus(screen.getByRole('combobox', { name: /search a destination/i }))
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Pending place' }))
    fireEvent.click(screen.getByRole('button', { name: /EV charging/i }))
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    await act(async () => {
      resolveRetriedDestination?.(okJson([carpark('destination-result', 'Destination result')]))
      await Promise.resolve()
    })

    expect(screen.getByText('Destination result')).toBeInTheDocument()
    expect(window.location.search).toContain('lat=1.40000')
    expect(JSON.parse(localStorage.getItem('ehparkleh:last') || '{}').center).toEqual({ lat: 1.4, lon: 103.9 })
    vi.useRealTimers()
  })

  it('uses current filters after delayed geocoding', async () => {
    vi.useFakeTimers()
    let resolveGeocode: ((response: ReturnType<typeof okJson>) => void) | undefined
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/geocode')) return new Promise((resolve) => { resolveGeocode = resolve })
      if (!url.includes('/api/carparks')) return Promise.resolve(okJson([]))
      if (url.includes('lat=1.37')) return Promise.resolve(okJson([carpark('current-result', 'Current result')]))
      return Promise.resolve(okJson([carpark('geocoded-result', 'Geocoded result')]))
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    await act(async () => {})
    expect(screen.getByText('Current result')).toBeInTheDocument()

    const searchBox = screen.getByRole('combobox', { name: /search a destination/i })
    fireEvent.change(searchBox, { target: { value: 'Geocoded place' } })
    fireEvent.submit(searchBox.closest('form')!)
    fireEvent.click(screen.getByRole('button', { name: /EV charging/i }))
    await act(async () => {
      resolveGeocode?.(okJson({ lat: 1.4, lon: 103.9 }))
      await Promise.resolve()
    })

    const destinationRequest = fetchMock.mock.calls.find(([url]) => String(url).includes('lat=1.4'))
    expect(String(destinationRequest?.[0])).toContain('has_ev=true')
    expect(screen.getByText('Geocoded result')).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('uses current filters after delayed location lookup', async () => {
    vi.useFakeTimers()
    let resolveLocation: ((location: LatLon) => void) | undefined
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (!url.includes('/api/carparks')) return Promise.resolve(okJson([]))
      if (url.includes('lat=1.37')) return Promise.resolve(okJson([carpark('current-result', 'Current result')]))
      return Promise.resolve(okJson([carpark('nearby-result', 'Nearby result')]))
    })
    vi.stubGlobal('fetch', fetchMock)
    const { getCurrentPosition } = await import('./geo')
    vi.mocked(getCurrentPosition).mockImplementationOnce(
      () => new Promise<LatLon>((resolve) => { resolveLocation = resolve }),
    )
    render(<App />)
    await act(async () => {})
    expect(screen.getByText('Current result')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /near me/i }))
    fireEvent.click(screen.getByRole('button', { name: /EV charging/i }))
    await act(async () => {
      resolveLocation?.({ lat: 1.4, lon: 103.9 })
      await Promise.resolve()
    })

    const destinationRequest = fetchMock.mock.calls.find(([url]) => String(url).includes('lat=1.4'))
    expect(String(destinationRequest?.[0])).toContain('has_ev=true')
    expect(screen.getByText('Nearby result')).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('ignores an older filter response after a newer request starts', async () => {
    vi.useFakeTimers()
    let resolveFirstFilter: ((response: ReturnType<typeof okJson>) => void) | undefined
    let resolveSecondFilter: ((response: ReturnType<typeof okJson>) => void) | undefined
    let carparkCalls = 0
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (!String(input).includes('/api/carparks')) return Promise.resolve(okJson([]))
      carparkCalls += 1
      if (carparkCalls === 1) return Promise.resolve(okJson([]))
      if (carparkCalls === 2) return new Promise((resolve) => { resolveFirstFilter = resolve })
      return new Promise((resolve) => { resolveSecondFilter = resolve })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    await act(async () => {})

    fireEvent.click(screen.getByRole('button', { name: /EV charging/i }))
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    fireEvent.click(screen.getByRole('button', { name: /Car wash/i }))
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })

    await act(async () => {
      resolveSecondFilter?.(okJson([carpark('new-result', 'New result')]))
      await Promise.resolve()
    })
    expect(screen.getByText('New result')).toBeInTheDocument()
    await act(async () => { resolveFirstFilter?.(okJson([carpark('old-result', 'Old result')])) })

    expect(screen.getByText('New result')).toBeInTheDocument()
    expect(screen.queryByText('Old result')).not.toBeInTheDocument()
    vi.useRealTimers()
  })
})
