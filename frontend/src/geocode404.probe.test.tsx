import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

// Regression tests for geocode-failure trust state: a failed place lookup is
// not a feed failure, so results already on screen must keep their live
// presentation — no offline board, no saved-count demotion.

const { MapMock } = vi.hoisted(() => ({ MapMock: vi.fn(() => null) }))
vi.mock('./Map', () => ({ default: MapMock }))

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
  // A ?lat/lon URL publishes healthy live results on mount.
  window.history.replaceState(null, '', '/?lat=1.37&lon=103.85')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('a failed geocode does not corrupt trust state', () => {
  it('keeps live results live after a neutral geocode 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/api/geocode')) {
          return { ok: false, status: 404, json: async () => ({}) }
        }
        if (!url.includes('/api/carparks')) return okJson([])
        return okJson([carpark('live-result', 'Live result')], liveHeaders(Date.now() + 60_000))
      }),
    )

    render(<App />)
    expect(await screen.findByText('Live result')).toBeInTheDocument()

    fireEvent.change(screen.getByRole('combobox', { name: /search a destination/i }), { target: { value: 'Not a real place' } })
    fireEvent.submit(screen.getByRole('search'))

    expect(await screen.findByText(/Couldn't find that place/i)).toBeInTheDocument()
    expect(screen.getByText('Live result')).toBeInTheDocument()
    // The offline/stale board must not appear over healthy online results.
    expect(screen.queryByText(/cannot get signal lah/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Can't reach the server/i)).not.toBeInTheDocument()
  })

  it('keeps live results live after the geocode request itself fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/api/geocode')) throw new TypeError('network down')
        if (!url.includes('/api/carparks')) return okJson([])
        return okJson([carpark('live-result', 'Live result')], liveHeaders(Date.now() + 60_000))
      }),
    )

    render(<App />)
    expect(await screen.findByText('Live result')).toBeInTheDocument()

    fireEvent.change(screen.getByRole('combobox', { name: /search a destination/i }), { target: { value: 'Somewhere' } })
    fireEvent.submit(screen.getByRole('search'))

    expect(await screen.findByText(/Can't reach the server/i)).toBeInTheDocument()
    expect(screen.getByText('Live result')).toBeInTheDocument()
    // A lookup failure says nothing about the feed: no stale demotion.
    expect(screen.queryByText(/cannot get signal lah/i)).not.toBeInTheDocument()
  })
})
