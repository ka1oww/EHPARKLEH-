import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSavedCarparks } from '@/useSavedCarparks'

const KEY = 'ehparkleh:favourites'

const stored = () => JSON.parse(localStorage.getItem(KEY) || 'null')

const cck = {
  id: 'cp-678a',
  title: 'Blk 678A CCK Crescent',
  lat: 1.38,
  lon: 103.74,
  subLabel: 'HDB · $0.60/30min',
  lots: 62,
  total: 300,
}

beforeEach(() => localStorage.clear())

describe('useSavedCarparks', () => {
  it('saves a carpark with enough of itself to be listed on its own', () => {
    const { result } = renderHook(() => useSavedCarparks())
    act(() => result.current.toggle(cck, 1_700_000_000_000))

    expect(result.current.isSaved('cp-678a')).toBe(true)
    expect(result.current.saved[0]).toMatchObject({
      id: 'cp-678a',
      title: 'Blk 678A CCK Crescent',
      subLabel: 'HDB · $0.60/30min',
      lastLots: 62,
      lastTotal: 300,
      lastSeenAt: 1_700_000_000_000,
    })
  })

  it('persists across a remount', () => {
    const first = renderHook(() => useSavedCarparks())
    act(() => first.result.current.toggle(cck))
    expect(stored().version).toBe(2)

    const second = renderHook(() => useSavedCarparks())
    expect(second.result.current.isSaved('cp-678a')).toBe(true)
    expect(second.result.current.saved[0].title).toBe('Blk 678A CCK Crescent')
  })

  it('toggles a saved carpark back off, and remove() drops it too', () => {
    const { result } = renderHook(() => useSavedCarparks())
    act(() => result.current.toggle(cck))
    act(() => result.current.toggle(cck))
    expect(result.current.saved).toHaveLength(0)

    act(() => result.current.toggle(cck))
    act(() => result.current.remove('cp-678a'))
    expect(result.current.saved).toHaveLength(0)
    expect(stored().items).toEqual([])
  })

  it('keeps stars saved under the round-1 id-only format', () => {
    localStorage.setItem(KEY, JSON.stringify(['cp-legacy']))
    const { result } = renderHook(() => useSavedCarparks())

    expect(result.current.isSaved('cp-legacy')).toBe(true)
    // Nothing is invented for it: no count, and no claim about when one was seen.
    expect(result.current.saved[0].lastLots).toBeNull()
    expect(result.current.saved[0].lastSeenAt).toBeNull()
  })

  it('fills a saved record in from a later search, and dates the count it saw', () => {
    localStorage.setItem(KEY, JSON.stringify(['cp-678a']))
    const { result } = renderHook(() => useSavedCarparks())

    act(() => result.current.sync([cck, { id: 'cp-other', title: 'Somewhere else' }], 1_700_000_000_000))

    expect(result.current.saved[0]).toMatchObject({
      title: 'Blk 678A CCK Crescent',
      subLabel: 'HDB · $0.60/30min',
      lastLots: 62,
      lastSeenAt: 1_700_000_000_000,
    })
    // A carpark that was never starred does not join the list by being searched.
    expect(result.current.saved).toHaveLength(1)
  })

  it('leaves the list identity alone when a sync changes nothing', () => {
    const { result } = renderHook(() => useSavedCarparks())
    act(() => result.current.toggle(cck, 1_700_000_000_000))
    const before = result.current.saved

    act(() => result.current.sync([cck], 1_700_000_000_000))
    expect(result.current.saved).toBe(before)
  })
})
