import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { LatLon } from './types'

// The lazy map and geolocation are irrelevant to these list-state assertions.
const { MapMock } = vi.hoisted(() => ({ MapMock: vi.fn(() => null) }))
vi.mock('./Map', () => ({ default: MapMock }))
vi.mock('./geo', () => ({ getCurrentPosition: vi.fn(() => Promise.reject(new Error('no geo'))) }))

import App from './App'

const okJson = (data: unknown, headerValues: Record<string, string> = {}) => ({
  ok: true,
  status: 200,
  headers: new Headers(headerValues),
  json: async () => data,
})

const liveHeaders = (freshUntil: number) => ({
  'X-EhParkLeh-Availability-State': 'hit',
  'X-EhParkLeh-Availability-Fresh-Until': new Date(freshUntil).toISOString(),
  'X-EhParkLeh-Ev-State': 'disabled',
})

// The list eyebrow splits its count into a <span>, so a plain text match never
// sees the whole sentence; match on normalised element text instead. The
// eyebrow is uppercased in CSS, so its text is still sentence-case here, and it
// names the sort in force rather than assuming "nearest".
const spotsNearby = (n: number, order = 'nearest first') =>
  screen.getByText(
    (_, node) =>
      (node?.textContent ?? '').replace(/\s+/g, ' ').trim() ===
      `${n} spot${n === 1 ? '' : 's'} · ${order}`,
  )

const lastMapProps = () =>
  (MapMock.mock.calls as unknown[][]).at(-1)?.[0] as { osmParking: unknown[] } | undefined

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

// Coordinates default far from `carpark()`'s (1.37, 103.85) so an OSM entry
// isn't accidentally deduped in tests that don't care about that; override
// lat/lon to co-locate one deliberately.
const osm = (id: string, name = id) => ({
  id,
  name,
  lat: 1.3,
  lon: 103.8,
  distance_m: 120,
  source: 'osm',
  fee: null,
  parking_type: null,
  capacity: null,
})

beforeEach(() => {
  localStorage.clear()
  MapMock.mockClear()
  // A ?lat/lon URL makes App run one search on mount, so we can assert its result state.
  window.history.replaceState(null, '', '/?lat=1.37&lon=103.85')
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('App search result states', () => {
  it('does not duplicate the initial deep-link search after the filter debounce', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => okJson([]))
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })

    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/carparks'))).toHaveLength(1)
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/parking/osm'))).toHaveLength(1)
    vi.useRealTimers()
  })

  it('publishes primary carpark results without waiting for optional OSM', async () => {
    let resolveOsm: ((response: ReturnType<typeof okJson>) => void) | undefined
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/api/parking/osm')) {
        return new Promise((resolve) => { resolveOsm = resolve })
      }
      return Promise.resolve(okJson([carpark('primary-result', 'Primary result')]))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    expect(await screen.findByText('Primary result')).toBeInTheDocument()
    expect(screen.queryByText(/Finding spots/i)).not.toBeInTheDocument()
    await act(async () => { resolveOsm?.(okJson([])) })
  })

  it('keeps primary results when the optional OSM request fails', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/api/parking/osm')) {
        return Promise.resolve({ ok: false, status: 503, json: async () => ({}) })
      }
      return Promise.resolve(okJson([carpark('fallback-result', 'Fallback result')]))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    expect(await screen.findByText('Fallback result')).toBeInTheDocument()
    expect(screen.queryByText(/Can't reach the server/i)).not.toBeInTheDocument()
    expect(await screen.findByText(/Some map parking spots could not be loaded/i)).toBeInTheDocument()
  })

  it('reports a stale OSM fallback without blocking primary results', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/api/parking/osm')) {
        return Promise.resolve(okJson([], { 'X-EhParkLeh-Osm-State': 'stale' }))
      }
      return Promise.resolve(okJson([carpark('stale-fallback-result', 'Stale fallback result')]))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    expect(await screen.findByText('Stale fallback result')).toBeInTheDocument()
    expect(screen.queryByText(/Can't reach the server/i)).not.toBeInTheDocument()
    expect(await screen.findByText(/Some map parking spots could not be loaded/i)).toBeInTheDocument()
  })

  it('bounds an optional OSM timeout without blocking or removing primary results', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/parking/osm')) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'AbortError')))
        })
      }
      return Promise.resolve(okJson([carpark('timeout-result', 'Timeout result')]))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByText('Timeout result')).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(screen.getByText('Timeout result')).toBeInTheDocument()
    expect(screen.queryByText(/Can't reach the server/i)).not.toBeInTheDocument()
    expect(screen.getByText(/Some map parking spots could not be loaded/i)).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('keeps saved results visible and labelled during a slow live refresh', async () => {
    window.history.replaceState(null, '', '/')
    localStorage.setItem(
      'ehparkleh:last',
      JSON.stringify({
        carparks: [carpark('saved-result', 'Saved result')],
        osmParking: [],
        center: { lat: 1.37, lon: 103.85 },
        ts: 0,
      }),
    )
    let resolvePrimary: ((response: ReturnType<typeof okJson>) => void) | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) =>
        String(input).includes('/api/carparks')
          ? new Promise((resolve) => { resolvePrimary = resolve })
          : Promise.resolve(okJson([])),
      ),
    )

    render(<App />)

    expect(await screen.findByText('Saved result')).toBeInTheDocument()
    expect(screen.getByText('Saved')).toBeInTheDocument()
    expect(screen.getByText(/Refreshing saved spots/i)).toBeInTheDocument()
    await act(async () => { resolvePrimary?.(okJson([carpark('fresh-result', 'Fresh result')])) })
  })

  it('downgrades live results when the feed snapshot deadline passes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-09T11:00:00.000Z'))
    const freshUntil = Date.now() + 1_000
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) =>
        String(input).includes('/api/carparks')
          ? Promise.resolve(okJson([carpark('aging-result', 'Aging result')], liveHeaders(freshUntil)))
          : Promise.resolve(okJson([])),
      ),
    )

    render(<App />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('Live')).toBeInTheDocument()

    await act(async () => { await vi.advanceTimersByTimeAsync(1_001) })
    expect(screen.getByText('Recent')).toBeInTheDocument()
    expect(screen.getByText(/Lot counts are from a recent update/i)).toBeInTheDocument()
    expect(screen.queryByText(/refresh runs/i)).not.toBeInTheDocument()

    await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
    expect(screen.getByText('Saved')).toBeInTheDocument()
  })

  it('labels retained live results saved when the browser goes offline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) =>
        String(input).includes('/api/carparks')
          ? Promise.resolve(okJson([carpark('offline-result', 'Offline result')], liveHeaders(Date.now() + 60_000)))
          : Promise.resolve(okJson([])),
      ),
    )

    render(<App />)
    expect(await screen.findByText('Offline result')).toBeInTheDocument()
    expect(screen.getByText('Live')).toBeInTheDocument()

    act(() => window.dispatchEvent(new Event('offline')))
    expect(screen.getByText('Saved')).toBeInTheDocument()
  })

  it('labels previous live results saved when a later search errors', async () => {
    let primaryCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        if (!String(input).includes('/api/carparks')) return Promise.resolve(okJson([]))
        primaryCalls += 1
        return Promise.resolve(
          primaryCalls === 1
            ? okJson([carpark('retained-result', 'Retained result')], liveHeaders(Date.now() + 60_000))
            : { ok: false, status: 503, headers: new Headers(), json: async () => ({}) },
        )
      }),
    )

    render(<App />)
    expect(await screen.findByText('Retained result')).toBeInTheDocument()
    expect(screen.getByText('Live')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /EV charging/i }))
    expect(await screen.findByText(/Can't reach the server/i)).toBeInTheDocument()
    expect(screen.getByText('Retained result')).toBeInTheDocument()
    expect(screen.getByText('Saved')).toBeInTheDocument()
  })

  it('uses causal-neutral copy for a slow primary request', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) =>
        String(input).includes('/api/carparks')
          ? new Promise(() => {})
          : Promise.resolve(okJson([])),
      ),
    )

    render(<App />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000)
    })

    expect(screen.getByText(/Live parking data is taking longer than usual/i)).toBeInTheDocument()
    expect(screen.queryByText(/Waking the server/i)).not.toBeInTheDocument()
    vi.useRealTimers()
  })

  it('shows a neutral empty state (not an error) when a search returns nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson([])),
    )
    render(<App />)
    expect(await screen.findByText(/No public carpark here leh/i)).toBeInTheDocument()
    expect(screen.queryByText(/Can't reach the server/i)).not.toBeInTheDocument()
  })

  it('keeps the EPL mark decorative, so the app name is announced once', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson([])),
    )
    const { container } = render(<App />)
    await act(async () => {})

    // The header already carries the name as its <h1>; the sidebar lockup
    // repeating it would have a screen reader say "EhParkLeh" twice on every
    // page load, so the board is decorative.
    const heading = screen.getByRole('heading', { level: 1, name: 'EhParkLeh' })
    expect(heading).toBeInTheDocument()
    const lockup = container.querySelector('header div[class*="md:inline-flex"]')
    expect(lockup).toHaveAttribute('aria-hidden', 'true')
    expect(screen.queryByRole('img', { name: /EhParkLeh/i })).not.toBeInTheDocument()
  })

  it('announces the list count as a plain sentence, not the shouted board eyebrow', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('/api/carparks')
          ? okJson([carpark('cp-1', 'Carpark 1')])
          : okJson([]),
      ),
    )
    render(<App />)

    // The eyebrow is uppercased in CSS, and Chrome carries text-transform into
    // the accessibility tree, so the announced sentence has to be its own node.
    const live = await screen.findByText(/1 spot nearby, sorted by nearest first/i)
    expect(live).toHaveAttribute('aria-live', 'polite')
    // ...and the decorative eyebrow must stay out of the tree, or the count is
    // announced twice.
    expect(spotsNearby(1)).toHaveAttribute('aria-hidden', 'true')
  })

  it('widens the search to the largest radius when the empty state offers the nearest', async () => {
    const fetchMock = vi.fn(async () => okJson([]))
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)

    // The default 500m search found nothing, so the offer is on screen.
    expect(await screen.findByText(/Nothing public within 500 m/i)).toBeInTheDocument()
    fetchMock.mockClear()

    fireEvent.click(screen.getByRole('button', { name: /Show nearest/i }))

    // It widens to the selector's largest radius and says so in the copy...
    expect(await screen.findByText(/Nothing public within 2 km/i)).toBeInTheDocument()
    await vi.waitFor(() =>
      expect(
        (fetchMock.mock.calls as unknown[][]).some((c) => String(c[0]).includes('radius=2000')),
      ).toBe(true),
    )
    // ...and stops offering, because there is nothing wider left to reach for.
    expect(screen.queryByRole('button', { name: /Show nearest/i })).not.toBeInTheDocument()
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
    expect(screen.queryByText(/No public carpark here leh/i)).not.toBeInTheDocument()
  })

  it('keeps a submitted no-match distinct from an address-service failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('/api/geocode')
          ? { ok: false, status: 404, json: async () => ({}) }
          : okJson([]),
      ),
    )
    render(<App />)
    await screen.findByText(/No public carpark here leh/i)

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Not a real address' } })
    fireEvent.submit(screen.getByRole('search'))

    expect(await screen.findByText(/Couldn't find that place/i)).toBeInTheDocument()
    expect(screen.queryByText(/Can't reach the server/i)).not.toBeInTheDocument()
  })

  it('reports a submitted address-service failure instead of a no-match', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('/api/geocode')
          ? { ok: false, status: 502, json: async () => ({}) }
          : okJson([]),
      ),
    )
    render(<App />)
    await screen.findByText(/No public carpark here leh/i)

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Toa Payoh' } })
    fireEvent.submit(screen.getByRole('search'))

    expect(await screen.findByText(/Can't reach the server/i)).toBeInTheDocument()
    expect(screen.queryByText(/Couldn't find that place/i)).not.toBeInTheDocument()
  })

  it('only obtains location after the person chooses Near me', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson([])))
    const { getCurrentPosition } = await import('./geo')
    render(<App />)

    expect(getCurrentPosition).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /near me/i }))
    })
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

    await screen.findByText(/No public carpark here leh/i)
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

  it('retries OSM when a filter aborts the still-pending optional request', async () => {
    vi.useFakeTimers()
    let osmCalls = 0
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes('/api/parking/osm')) return Promise.resolve(okJson([]))
      osmCalls += 1
      if (osmCalls > 1) return Promise.resolve(okJson([]))
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('superseded', 'AbortError')))
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)

    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: /EV charging/i }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })

    expect(osmCalls).toBe(2)
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
    // The focused-search row now names the place and says when it was last
    // searched, so the accessible name carries both.
    fireEvent.mouseDown(screen.getByRole('button', { name: /^Pending place/ }))
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

    const destinationRequest = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/api/carparks') && String(url).includes('lat=1.4'),
    )
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

    const destinationRequest = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/api/carparks') && String(url).includes('lat=1.4'),
    )
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

describe('OSM layer under active filters', () => {
  // OSM has no amenity/category data, so it can never genuinely match a
  // filter. It also isn't refetched on a filter toggle (only carparks are),
  // so these tests reuse the same OSM response across both fetches.
  it('hides OSM entries, and drops them from the count, once a filter narrows the carpark set', async () => {
    vi.useFakeTimers()
    let carparkCalls = 0
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/parking/osm')) return Promise.resolve(okJson([osm('osm-1', 'Open lot')]))
      if (!url.includes('/api/carparks')) return Promise.resolve(okJson([]))
      carparkCalls += 1
      return Promise.resolve(
        okJson(
          carparkCalls === 1
            ? [carpark('cp-1', 'Carpark 1'), carpark('cp-2', 'Carpark 2')]
            : [carpark('cp-1', 'Carpark 1')],
        ),
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    await act(async () => {})

    expect(screen.getByText('Open lot')).toBeInTheDocument()
    expect(spotsNearby(3)).toBeInTheDocument()
    expect(lastMapProps()?.osmParking).toEqual([expect.objectContaining({ id: 'osm-1' })])

    fireEvent.click(screen.getByRole('button', { name: /EV charging/i }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })

    expect(screen.queryByText('Open lot')).not.toBeInTheDocument()
    expect(spotsNearby(1)).toBeInTheDocument()
    expect(lastMapProps()?.osmParking).toEqual([])
    vi.useRealTimers()
  })

  it('restores OSM entries to the list and the count once the filter chip is switched off', async () => {
    vi.useFakeTimers()
    // Car wash, like EV charging, is a server-side amenity filter with no OSM
    // counterpart: the same OSM response is reused across all three fetches
    // because a non-spatial filter change never refetches OSM.
    let carparkCalls = 0
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/parking/osm')) return Promise.resolve(okJson([osm('osm-1', 'Open lot')]))
      if (!url.includes('/api/carparks')) return Promise.resolve(okJson([]))
      carparkCalls += 1
      return Promise.resolve(
        okJson(
          carparkCalls === 2
            ? [carpark('cp-1', 'Carpark 1')]
            : [carpark('cp-1', 'Carpark 1'), carpark('cp-2', 'Carpark 2')],
        ),
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    await act(async () => {})

    expect(screen.getByText('Open lot')).toBeInTheDocument()
    expect(spotsNearby(3)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Car wash/i }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })

    expect(screen.queryByText('Open lot')).not.toBeInTheDocument()
    expect(spotsNearby(1)).toBeInTheDocument()
    expect(lastMapProps()?.osmParking).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: /Car wash/i }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })

    expect(screen.getByText('Open lot')).toBeInTheDocument()
    expect(spotsNearby(3)).toBeInTheDocument()
    expect(lastMapProps()?.osmParking).toEqual([expect.objectContaining({ id: 'osm-1' })])
    // The OSM layer came back from state, not a second network round trip.
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/parking/osm'))).toHaveLength(1)
    vi.useRealTimers()
  })

  it('never resurfaces an OSM pin that a looser search had suppressed, once a filter removes the carpark sitting on it', async () => {
    vi.useFakeTimers()
    let carparkCalls = 0
    const evCarpark = { ...carpark('cp-ev', 'EV carpark'), ev: true, lat: 1.4, lon: 103.9 }
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      // Sits on top of the non-EV carpark below (same coordinates), so the
      // unfiltered dedupe suppresses it from the start.
      if (url.includes('/api/parking/osm')) {
        return Promise.resolve(okJson([{ ...osm('osm-1', 'Suppressed lot'), lat: 1.37, lon: 103.85 }]))
      }
      if (!url.includes('/api/carparks')) return Promise.resolve(okJson([]))
      carparkCalls += 1
      return Promise.resolve(
        okJson(carparkCalls === 1 ? [carpark('cp-non-ev', 'Non-EV carpark'), evCarpark] : [evCarpark]),
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    await act(async () => {})

    // Baseline: the OSM pin sits on the non-EV carpark, so dedupe hides it.
    expect(screen.queryByText('Suppressed lot')).not.toBeInTheDocument()
    expect(spotsNearby(2)).toBeInTheDocument()
    expect(lastMapProps()?.osmParking).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: /EV charging/i }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })

    // The EV filter drops the non-EV carpark the OSM pin was hiding behind.
    // It must stay suppressed, not reappear as an unlabelled "matching" entry.
    expect(screen.queryByText('Suppressed lot')).not.toBeInTheDocument()
    expect(spotsNearby(1)).toBeInTheDocument()
    expect(lastMapProps()?.osmParking).toEqual([])
    vi.useRealTimers()
  })
})

describe('App splash', () => {
  it('holds the gantry board over the app while the first search runs', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) =>
        String(input).includes('/api/carparks')
          ? new Promise(() => {})
          : Promise.resolve(okJson([])),
      ),
    )

    render(<App />)
    await act(async () => {})

    expect(screen.getByText('checking lots…')).toBeInTheDocument()

    // ...and hands off to the list's own loading copy rather than sitting on
    // top of a genuinely slow request.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500)
    })
    expect(screen.queryByText('checking lots…')).not.toBeInTheDocument()
    vi.useRealTimers()
  })

  it('comes down as soon as the first results land', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('/api/carparks') ? okJson([carpark('cp-1', 'Carpark 1')]) : okJson([]),
      ),
    )

    render(<App />)
    expect(await screen.findByText('Carpark 1')).toBeInTheDocument()
    await vi.waitFor(() =>
      expect(screen.queryByText('checking lots…')).not.toBeInTheDocument(),
    )
  })
})

describe('App filter status eyebrow', () => {
  it('names every active filter and clears them from the same line', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('/api/carparks') ? okJson([carpark('cp-1', 'Carpark 1')]) : okJson([]),
      ),
    )
    render(<App />)
    await screen.findByText('Carpark 1')

    // Nothing filtered: no eyebrow at all.
    expect(screen.queryByText(/^Showing .* only$/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /EV charging/i }))
    expect(await screen.findByText('Showing EV charging only')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Car wash/i }))
    expect(await screen.findByText('Showing EV charging + car wash only')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^Clear/ }))
    await vi.waitFor(() =>
      expect(screen.queryByText(/^Showing .* only$/)).not.toBeInTheDocument(),
    )
  })
})

describe('App offline board', () => {
  const liveCarpark = (id: string, address: string, lots: number) => ({
    ...carpark(id, address),
    lots_available: lots,
  })

  it('says it cannot get signal, and tildes every count it can no longer vouch for', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('/api/carparks')
          ? okJson([liveCarpark('cp-1', 'Blk 678A CCK Crescent', 60)], liveHeaders(Date.now() + 60_000))
          : okJson([]),
      ),
    )
    render(<App />)
    await screen.findByText('Blk 678A CCK Crescent')
    // Online, the count is written as a live board reads it.
    expect(screen.getByText('060')).toBeInTheDocument()

    act(() => window.dispatchEvent(new Event('offline')))

    expect(screen.getByText('hais…cannot get signal lah')).toBeInTheDocument()
    expect(screen.getByText('~060')).toBeInTheDocument()
    expect(screen.queryByText('060')).not.toBeInTheDocument()
    expect(
      screen.getByText('Stale counts always say so — we never show an old number as live.'),
    ).toBeInTheDocument()
    // The thin offline strip stands down: the board is now saying it properly.
    expect(screen.queryByText(/You're offline/i)).not.toBeInTheDocument()
  })

  it('retries the same place from Try again', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('/api/carparks')
        ? okJson([liveCarpark('cp-1', 'Blk 678A CCK Crescent', 60)], liveHeaders(Date.now() + 60_000))
        : okJson([]),
    )
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    await screen.findByText('Blk 678A CCK Crescent')

    act(() => window.dispatchEvent(new Event('offline')))
    const before = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/carparks')).length

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/carparks')).length,
      ).toBe(before + 1),
    )
  })
})

describe('App last-session snapshot', () => {
  // The snapshot a filtered session writes: an EV-filtered carpark subset,
  // the OSM pins that session had hidden, and the filters that produced it.
  const evCarpark = () => ({
    ...carpark('cp-ev', 'EV carpark'),
    ev: true,
    ev_total: 2,
    ev_available: 1,
  })
  const plainCarpark = () => carpark('cp-plain', 'Plain carpark')
  const filteredSnapshot = () => ({
    carparks: [evCarpark()],
    osmParking: [osm('osm-1', 'Open lot')],
    center: { lat: 1.37, lon: 103.85 },
    ts: 0,
    filters: {
      radius: 500,
      category: null,
      freeSunPh: false,
      hasLots: false,
      hasEv: true,
      hasCarwash: false,
    },
  })

  const goOffline = () =>
    Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true })
  const goOnline = () =>
    Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true })

  it('offline cold open restores a filtered snapshot with its chips on, not as the whole picture', async () => {
    window.history.replaceState(null, '', '/')
    localStorage.setItem('ehparkleh:last', JSON.stringify(filteredSnapshot()))
    goOffline()
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      render(<App />)

      expect(await screen.findByText('EV carpark')).toBeInTheDocument()
      expect(screen.queryByText('Plain carpark')).not.toBeInTheDocument()
      // The filter state is restored with the rows, so the board says what it
      // is instead of passing the subset off as everything nearby.
      expect(screen.getByText(/Showing EV charging only/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /EV charging/i })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      // The OSM pins the filtered view deliberately hid stay hidden...
      expect(lastMapProps()?.osmParking).toEqual([])
      // ...so the count matches what a real EV search produced.
      expect(spotsNearby(1)).toBeInTheDocument()
      // Time staleness is still labelled as before.
      expect(screen.getByText('Saved')).toBeInTheDocument()
      // Offline restore never touches the network.
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      goOnline()
    }
  })

  it('online cold open refreshes with the restored filters, not a silent unfiltered swap', async () => {
    window.history.replaceState(null, '', '/')
    localStorage.setItem('ehparkleh:last', JSON.stringify(filteredSnapshot()))
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/parking/osm')) return okJson([osm('osm-1', 'Open lot')])
      if (url.includes('/api/carparks')) {
        return url.includes('has_ev=true') ? okJson([evCarpark()]) : okJson([evCarpark(), plainCarpark()])
      }
      return okJson([])
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    // Exactly one primary request, carrying the restored filter and radius.
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/carparks'))).toHaveLength(1),
    )
    const refreshUrl = String(
      fetchMock.mock.calls.find(([u]) => String(u).includes('/api/carparks'))?.[0],
    )
    expect(refreshUrl).toContain('has_ev=true')
    expect(refreshUrl).toContain('radius=500')

    // And the filter UI survives the refreshed result set.
    expect(await screen.findByText('EV carpark')).toBeInTheDocument()
    expect(screen.getByText(/Showing EV charging only/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /EV charging/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(lastMapProps()?.osmParking).toEqual([])
  })

  it('records the active filters in the snapshot when a filtered search moves to a new place', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/geocode')) return okJson({ lat: 1.4, lon: 103.9, address: 'Bishan' })
      if (url.includes('/api/suggestions')) return okJson([])
      if (url.includes('/api/parking/osm')) return okJson([osm('osm-1', 'Open lot')])
      if (url.includes('/api/carparks')) {
        return url.includes('has_ev=true') ? okJson([evCarpark()]) : okJson([evCarpark(), plainCarpark()])
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    fireEvent.click(screen.getByRole('button', { name: /EV charging/i }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    // New place while the chip is on: the stored subset must carry its filters.
    const box = screen.getAllByRole('combobox')[0]
    fireEvent.change(box, { target: { value: 'Bishan' } })
    fireEvent.submit(box.closest('form')!)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    const snap = JSON.parse(localStorage.getItem('ehparkleh:last') || 'null')
    expect(snap.center).toEqual({ lat: 1.4, lon: 103.9 })
    expect(snap.carparks.map((c: { id: string }) => c.id)).toEqual(['cp-ev'])
    expect(snap.filters).toEqual({
      radius: 500,
      category: null,
      freeSunPh: false,
      hasLots: false,
      hasEv: true,
      hasCarwash: false,
    })
    vi.useRealTimers()
  })

  it('deep-link opens ignore stored snapshot filters entirely', async () => {
    // beforeEach already points the URL at /?lat=&lon=, so this open is a
    // reproducible shared link even though storage holds a filtered snapshot.
    localStorage.setItem('ehparkleh:last', JSON.stringify(filteredSnapshot()))
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('/api/parking/osm')
        ? okJson([])
        : okJson([evCarpark(), plainCarpark()]),
    )
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    expect(await screen.findByText('Plain carpark')).toBeInTheDocument()
    const carparkUrl = String(
      fetchMock.mock.calls.find(([u]) => String(u).includes('/api/carparks'))?.[0],
    )
    expect(carparkUrl).not.toContain('has_ev')
    expect(screen.queryByText(/^Showing .* only$/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /EV charging/i })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('restores a legacy or malformed snapshot without error, as unfiltered', async () => {
    window.history.replaceState(null, '', '/')
    localStorage.setItem(
      'ehparkleh:last',
      JSON.stringify({ ...filteredSnapshot(), filters: 'not-an-object' }),
    )
    goOffline()
    vi.stubGlobal('fetch', vi.fn())

    try {
      render(<App />)

      // Without trustworthy filter data the restore falls back to today's
      // behaviour: unfiltered defaults, no crash.
      expect(await screen.findByText('EV carpark')).toBeInTheDocument()
      expect(screen.queryByText(/^Showing .* only$/)).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: /EV charging/i })).toHaveAttribute(
        'aria-pressed',
        'false',
      )
      expect(lastMapProps()?.osmParking).toHaveLength(1)
      expect(spotsNearby(2)).toBeInTheDocument()
    } finally {
      goOnline()
    }
  })
})

describe('App map popup ranks', () => {
  // Popups are numbered from the same sorted order the list shows, so a
  // price/availability sort must renumber the pins the user sees numbered.
  it('hands Map ranks that track the sorted list order', async () => {
    const rate = (firstHour: number) => ({
      known: true,
      summary: `$${firstHour} first hr`,
      first_hour: firstHour,
      subsequent_half_hour: null,
      weekday_raw: null,
      saturday_raw: null,
      sunday_ph_raw: null,
    })
    const dear = { ...carpark('dear', 'Dear block'), distance_m: 100, rate: rate(9) }
    const cheap = { ...carpark('cheap', 'Cheap block'), distance_m: 100, rate: rate(1) }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('/api/carparks') ? okJson([dear, cheap]) : okJson([]),
      ),
    )
    render(<App />)
    await screen.findByText('Dear block')

    // Distance sort with equal distances keeps backend order.
    const ranksBefore = (lastMapProps() ?? {}) as { ranks?: Record<string, number> }
    expect(ranksBefore.ranks).toEqual({ dear: 1, cheap: 2 })

    fireEvent.change(screen.getByRole('combobox', { name: 'Sort' }), {
      target: { value: 'price' },
    })

    // The list reorders (cheapest first) and the pins are renumbered to match.
    const cheapEl = screen.getByText('Cheap block')
    const dearEl = screen.getByText('Dear block')
    expect(cheapEl.compareDocumentPosition(dearEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const ranksAfter = (lastMapProps() ?? {}) as { ranks?: Record<string, number> }
    expect(ranksAfter.ranks).toEqual({ cheap: 1, dear: 2 })
  })
})

describe('App saved carparks', () => {
  it('keeps a starred carpark, lists it with a live count, and survives a reload', async () => {
    const starred = { ...carpark('cp-678a', 'Blk 678A CCK Crescent'), lots_available: 62 }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('/api/carparks')
          ? okJson([starred], liveHeaders(Date.now() + 60_000))
          : okJson([]),
      ),
    )
    const { unmount } = render(<App />)
    await screen.findByText('Blk 678A CCK Crescent')

    fireEvent.click(screen.getByRole('button', { name: /save carpark/i }))
    fireEvent.click(screen.getByRole('button', { name: 'saved' }))

    expect(screen.getByText('Blk 678A CCK Crescent')).toBeInTheDocument()
    expect(screen.getByText('062')).toBeInTheDocument()
    expect(screen.getByText('steady, got lots !')).toBeInTheDocument()

    // The star is what persists, not the search that happened to be on screen.
    const stored = JSON.parse(localStorage.getItem('ehparkleh:favourites') || 'null')
    expect(stored.items.map((i: { id: string }) => i.id)).toEqual(['cp-678a'])
    expect(stored.items[0].title).toBe('Blk 678A CCK Crescent')

    unmount()
    render(<App />)
    fireEvent.click(screen.getAllByRole('button', { name: 'saved' })[0])
    expect(await screen.findByText('Blk 678A CCK Crescent')).toBeInTheDocument()
  })

  it('offers an empty Saved view rather than an invented one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson([])))
    render(<App />)
    await screen.findByText(/No public carpark here leh/i)

    fireEvent.click(screen.getByRole('button', { name: 'saved' }))
    expect(screen.getByText('Nothing saved yet')).toBeInTheDocument()
    // The hint names the exact gesture, in the captain's words.
    expect(screen.getByText('Tap the star on the carpark to save it.')).toBeInTheDocument()
    // No prediction, ever, from a list with no history behind it.
    expect(screen.queryByText(/usually fills/i)).not.toBeInTheDocument()
  })
})

describe('App desktop rail', () => {
  it('closes the rail with the nearest carpark that actually has a lot', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('/api/carparks')
          ? okJson(
              [
                { ...carpark('cp-full', 'Lot One MSCP'), lots_available: 0, distance_m: 80 },
                { ...carpark('cp-free', 'Blk 611A CCK Street 62'), lots_available: 104, distance_m: 610 },
              ],
              liveHeaders(Date.now() + 60_000),
            )
          : okJson([]),
      ),
    )
    render(<App />)
    await screen.findByText('Lot One MSCP')

    // The nearest carpark is full, so the bar names the nearest one that is not.
    const bar = screen.getByRole('button', { name: /Nearest with lots/i })
    expect(bar).toHaveTextContent('Blk 611A CCK Street 62')
    expect(bar).toHaveTextContent('610 m')
  })

  it('says so plainly when nothing nearby is reporting a free lot', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('/api/carparks')
          ? okJson([{ ...carpark('cp-full', 'Lot One MSCP'), lots_available: 0 }], liveHeaders(Date.now() + 60_000))
          : okJson([]),
      ),
    )
    render(<App />)
    await screen.findByText('Lot One MSCP')

    expect(
      screen.getByText('No carpark here is reporting a free lot right now.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Nearest with lots/i })).not.toBeInTheDocument()
  })
})

describe('App mobile header', () => {
  it('gives the mobile bar the wordmark alone, and keeps the full lockup for the sidebar', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('/api/carparks') ? okJson([carpark('cp-1', 'Carpark 1')]) : okJson([]),
      ),
    )
    const { container } = render(<App />)
    await screen.findByText('Carpark 1')
    // The splash wears a lockup of its own, so let it come down before
    // counting what the header itself carries.
    await vi.waitFor(() =>
      expect(screen.queryByText('checking lots…')).not.toBeInTheDocument(),
    )

    // Mobile shows the name as real display type, and hands the job to the
    // sidebar lockup from md up.
    const heading = screen.getByRole('heading', { level: 1, name: 'EhParkLeh' })
    expect(heading.className).toMatch(/font-display/)
    expect(heading.className).toMatch(/md:sr-only/)

    // Nothing else rides in the mobile bar beside it: no EPL tile...
    const marks = Array.from(container.querySelectorAll('header svg')).filter(
      (svg) => svg.getAttribute('viewBox') === '0 0 56 26',
    )
    expect(marks).toHaveLength(0)

    // ...and no tagline, which now exists in exactly one place: the
    // desktop-only lockup.
    const taglines = screen.getAllByText('GOT LOT ANOT ??')
    expect(taglines).toHaveLength(1)
    const lockup = taglines[0].closest('div[class*="md:inline-flex"]')
    expect(lockup).not.toBeNull()
    expect(lockup?.className).toMatch(/(^|\s)hidden(\s|$)/)
  })
})
