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

describe('SearchBar focused view', () => {
  const recents = [
    { query: 'CCK MRT', lat: 1.38, lon: 103.74, ts: Date.now() - 12 * 60_000 },
    { query: 'Lot One', lat: 1.385, lon: 103.745, ts: Date.now() - 26 * 3_600_000 },
  ]

  it('opens on focus with a RECENT section, each row dated', () => {
    render(<SearchBar {...props} recents={recents} />)

    fireEvent.focus(screen.getByRole('combobox'))

    expect(screen.getByText('Recent')).toBeInTheDocument()
    expect(screen.getByText('CCK MRT')).toBeInTheDocument()
    expect(screen.getByText('searched 12 minutes ago')).toBeInTheDocument()
    expect(screen.getByText('searched 1 day ago')).toBeInTheDocument()
  })

  it('stacks SUGGESTIONS under RECENT, so a typed query never hides where you have been', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ address: 'Yew Tee MRT', lat: 1.397, lon: 103.747 }],
    }))
    render(<SearchBar {...props} recents={recents} />)

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'yew tee' } })
    // In flight, the LED chip says the app is checking rather than the list
    // blinking out — the same chip the splash wears.
    expect(screen.getByText('checking lots…')).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(screen.getByText('Recent')).toBeInTheDocument()
    expect(screen.getByText('Suggestions')).toBeInTheDocument()
    expect(screen.getByText('Yew Tee MRT')).toBeInTheDocument()
    expect(screen.queryByText('checking lots…')).not.toBeInTheDocument()
  })

  it('runs the keyboard over recents and suggestions as one list', async () => {
    vi.useFakeTimers()
    const onPickRecent = vi.fn()
    const onPickSuggestion = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ address: 'Yew Tee MRT', lat: 1.397, lon: 103.747 }],
    }))
    render(
      <SearchBar {...props} recents={recents} onPickRecent={onPickRecent} onPickSuggestion={onPickSuggestion} />,
    )

    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'yew tee' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    // Two recents, then the suggestion: the third press lands on the suggestion.
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.submit(input.closest('form')!)

    expect(onPickSuggestion).toHaveBeenCalledWith({ address: 'Yew Tee MRT', lat: 1.397, lon: 103.747 })
    expect(onPickRecent).not.toHaveBeenCalled()
  })
})
