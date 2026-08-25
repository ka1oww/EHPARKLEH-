import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CarparkCard } from './CarparkCard'
import type { ParkingEntry } from '@/types'

function hdbEntry(overrides: Partial<Extract<ParkingEntry, { source: 'hdb' }>> = {}): ParkingEntry {
  return {
    source: 'hdb',
    id: 'cp1',
    name: null,
    address: 'BLK 123 TEST STREET',
    lat: 1.37,
    lon: 103.85,
    distance_m: 250,
    lots_available: 40,
    total_lots: 100,
    type: 'Multi-storey',
    category: 'HDB',
    rate: {
      known: true,
      summary: '$0.60/30min',
      first_hour: null,
      subsequent_half_hour: 0.6,
      weekday_raw: null,
      saturday_raw: null,
      sunday_ph_raw: null,
    },
    free_parking_info: null,
    sources: ['hdb'],
    ev: false,
    ev_total: null,
    ev_available: null,
    ev_operators: [],
    ev_max_power_kw: null,
    carwash: false,
    carwash_operator: null,
    ...overrides,
  }
}

const noop = () => {}

describe('CarparkCard', () => {
  it('shows distance in metres under 1 km', () => {
    render(
      <CarparkCard entry={hdbEntry({ distance_m: 250 })} rank={1} selected={false} onSelect={noop} isFavourite={false} onToggleFavourite={noop} />,
    )
    expect(screen.getByText('250 m')).toBeInTheDocument()
  })

  it('formats distance in km past 1000 m', () => {
    render(
      <CarparkCard entry={hdbEntry({ distance_m: 1843 })} rank={1} selected={false} onSelect={noop} isFavourite={false} onToggleFavourite={noop} />,
    )
    expect(screen.getByText('1.8 km')).toBeInTheDocument()
  })

  it('does not add an unnecessary decimal for whole kilometre distances', () => {
    render(
      <CarparkCard entry={hdbEntry({ distance_m: 1000 })} rank={1} selected={false} onSelect={noop} isFavourite={false} onToggleFavourite={noop} />,
    )
    expect(screen.getByText('1 km')).toBeInTheDocument()
  })

  it('calls onSelect with the entry id when the card is activated', () => {
    const onSelect = vi.fn()
    render(
      <CarparkCard entry={hdbEntry({ id: 'cp42' })} rank={1} selected={false} onSelect={onSelect} isFavourite={false} onToggleFavourite={noop} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /show .* on map/i }))
    expect(onSelect).toHaveBeenCalledWith('cp42')
  })

  it('toggles the favourite by id from the star without selecting the card', () => {
    const onSelect = vi.fn()
    const onToggleFavourite = vi.fn()
    render(
      <CarparkCard entry={hdbEntry({ id: 'cp7' })} rank={1} selected={false} onSelect={onSelect} isFavourite={false} onToggleFavourite={onToggleFavourite} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /save carpark/i }))
    expect(onToggleFavourite).toHaveBeenCalledWith('cp7')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('never labels recent or saved lot counts as live', () => {
    const { rerender } = render(
      <CarparkCard entry={hdbEntry()} rank={1} selected={false} onSelect={noop} isFavourite={false} onToggleFavourite={noop} availabilityFreshness="recent" />,
    )
    expect(screen.getByText('Recent')).toBeInTheDocument()
    expect(screen.queryByText('Live')).not.toBeInTheDocument()

    rerender(
      <CarparkCard entry={hdbEntry()} rank={1} selected={false} onSelect={noop} isFavourite={false} onToggleFavourite={noop} availabilityFreshness="saved" />,
    )
    expect(screen.getByText('Saved')).toBeInTheDocument()
    expect(screen.queryByText('Live')).not.toBeInTheDocument()
  })
  it('writes the lot count as three gantry-board digits', () => {
    render(
      <CarparkCard entry={hdbEntry({ lots_available: 62 })} rank={1} selected={false} onSelect={noop} isFavourite={false} onToggleFavourite={noop} />,
    )
    expect(screen.getByText('062')).toBeInTheDocument()
  })

  it('says FULL, and fades the row back, when there are no lots left', () => {
    render(
      <CarparkCard entry={hdbEntry({ lots_available: 0 })} rank={1} selected={false} onSelect={noop} isFavourite={false} onToggleFavourite={noop} />,
    )
    const board = screen.getByText('FULL')
    expect(board).toBeInTheDocument()
    expect(board.closest('.opacity-60')).not.toBeNull()
  })

  it('does not fade a carpark that still has lots', () => {
    render(
      <CarparkCard entry={hdbEntry({ lots_available: 40 })} rank={1} selected={false} onSelect={noop} isFavourite={false} onToggleFavourite={noop} />,
    )
    expect(screen.getByText('040').closest('.opacity-60')).toBeNull()
  })

  it('offers the go-action in the app\u2019s own voice, still deep-linking to Google Maps', () => {
    render(
      <CarparkCard entry={hdbEntry({ lat: 1.37, lon: 103.85 })} rank={1} selected={false} onSelect={noop} isFavourite={false} onToggleFavourite={noop} />,
    )
    const cta = screen.getByRole('link', { name: /Confirm ah/i })
    expect(cta).toHaveAttribute(
      'href',
      'https://www.google.com/maps/dir/?api=1&destination=1.37,103.85',
    )
  })

  it('lights the dot-matrix strip only for a selected carpark that is genuinely free sometimes', () => {
    const free = { free_parking_info: 'SUN & PH FR 7AM-10.30PM' }
    const { rerender } = render(
      <CarparkCard entry={hdbEntry(free)} rank={1} selected={false} onSelect={noop} isFavourite={false} onToggleFavourite={noop} />,
    )
    expect(screen.queryByText('SUN & PH FREE 7AM-10.30PM')).not.toBeInTheDocument()

    rerender(
      <CarparkCard entry={hdbEntry(free)} rank={1} selected onSelect={noop} isFavourite={false} onToggleFavourite={noop} />,
    )
    expect(screen.getByText('SUN & PH FREE 7AM-10.30PM')).toBeInTheDocument()

    rerender(
      <CarparkCard entry={hdbEntry({ free_parking_info: 'NO' })} rank={1} selected onSelect={noop} isFavourite={false} onToggleFavourite={noop} />,
    )
    expect(screen.queryByText(/FREE/)).not.toBeInTheDocument()
  })

  it('raises the gantry hero for the selected carpark, without claiming a stale count is now', () => {
    const { rerender } = render(
      <CarparkCard entry={hdbEntry()} rank={1} selected onSelect={noop} isFavourite={false} onToggleFavourite={noop} availabilityFreshness="fresh" />,
    )
    expect(screen.getByText('LOTS NOW \u00b7 LIVE')).toBeInTheDocument()

    rerender(
      <CarparkCard entry={hdbEntry()} rank={1} selected onSelect={noop} isFavourite={false} onToggleFavourite={noop} availabilityFreshness="saved" />,
    )
    expect(screen.queryByText(/LOTS NOW/)).not.toBeInTheDocument()
    expect(screen.getByText('LOTS \u00b7 SAVED COUNT')).toBeInTheDocument()
  })
})
