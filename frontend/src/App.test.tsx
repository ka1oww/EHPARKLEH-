import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'

// The lazy map and geolocation are irrelevant to these list-state assertions.
vi.mock('./Map', () => ({ default: () => null }))
vi.mock('./geo', () => ({ getCurrentPosition: vi.fn(() => Promise.reject(new Error('no geo'))) }))

import App from './App'

const okJson = (data: unknown) => ({ ok: true, status: 200, json: async () => data })

beforeEach(() => {
  localStorage.clear()
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
})
