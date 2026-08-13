import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SearchBar } from './SearchBar'

const props = {
  apiBase: 'http://localhost:8000',
  loading: false,
  onSubmit: vi.fn(),
  onPickSuggestion: vi.fn(),
  onNearMe: vi.fn(),
  recents: [],
  onPickRecent: vi.fn(),
  onClearRecents: vi.fn(),
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('SearchBar suggestions', () => {
  it('shows an address-service failure and recovers on retry', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network failed'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ address: 'Toa Payoh Hub', lat: 1.33, lon: 103.85 }],
      })
    vi.stubGlobal('fetch', fetchMock)
    render(<SearchBar {...props} />)

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Toa Payoh' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(screen.getByText('Address service unavailable.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await act(async () => {
      await Promise.resolve()
    })

    expect(screen.getByText('Toa Payoh Hub')).toBeInTheDocument()
    expect(screen.queryByText('Address service unavailable.')).not.toBeInTheDocument()
  })

  it('shows a backend address-service failure', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ detail: 'Address service unavailable' }),
    }))
    render(<SearchBar {...props} />)

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Toa Payoh' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(screen.getByText('Address service unavailable.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.queryByText('No matching addresses found.')).not.toBeInTheDocument()
  })

  it('shows an address-service failure after a timeout', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => (
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'AbortError')))
      })
    )))
    render(<SearchBar {...props} />)

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Toa Payoh' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
      await vi.advanceTimersByTimeAsync(5_000)
    })

    expect(screen.getByText('Address service unavailable.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('keeps a genuine no-match response distinct from failure', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
    }))
    render(<SearchBar {...props} />)

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Not a real address' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(screen.getByText('No matching addresses found.')).toBeInTheDocument()
    expect(screen.queryByText('Address service unavailable.')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  })

  it.each([
    {
      state: 'failure',
      response: { ok: false, status: 502, json: async () => ({}) },
      message: 'Address service unavailable.',
    },
    {
      state: 'no-match',
      response: { ok: true, status: 200, json: async () => [] },
      message: 'No matching addresses found.',
    },
  ])('dismisses the $state popup with Escape', async ({ response, message }) => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
    render(<SearchBar {...props} />)

    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'Toa Payoh' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(screen.getByText(message)).toBeInTheDocument()
    expect(input).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByText(message)).not.toBeInTheDocument()
    expect(input).toHaveAttribute('aria-expanded', 'false')
  })
})
