import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRecentSearches } from '@/useRecentSearches'

beforeEach(() => localStorage.clear())

describe('useRecentSearches', () => {
  it('adds entries most-recent-first', () => {
    const { result } = renderHook(() => useRecentSearches())
    act(() => result.current.add('Orchard', 1.3, 103.8))
    act(() => result.current.add('Tampines', 1.35, 103.94))
    expect(result.current.recents.map((r) => r.query)).toEqual(['Tampines', 'Orchard'])
  })

  it('dedupes case-insensitively, moving the repeat to the front', () => {
    const { result } = renderHook(() => useRecentSearches())
    act(() => result.current.add('Orchard', 1.3, 103.8))
    act(() => result.current.add('Tampines', 1.35, 103.94))
    act(() => result.current.add('orchard', 1.3, 103.8))
    expect(result.current.recents.map((r) => r.query)).toEqual(['orchard', 'Tampines'])
    expect(result.current.recents).toHaveLength(2)
  })

  it('ignores blank queries', () => {
    const { result } = renderHook(() => useRecentSearches())
    act(() => result.current.add('   ', 1.3, 103.8))
    expect(result.current.recents).toHaveLength(0)
  })

  it('caps the list at 6 entries', () => {
    const { result } = renderHook(() => useRecentSearches())
    act(() => {
      for (let i = 0; i < 9; i++) result.current.add(`Place ${i}`, 1.3, 103.8)
    })
    expect(result.current.recents).toHaveLength(6)
    expect(result.current.recents[0].query).toBe('Place 8')
  })

  it('clear() empties the list and persists', () => {
    const { result } = renderHook(() => useRecentSearches())
    act(() => result.current.add('Orchard', 1.3, 103.8))
    act(() => result.current.clear())
    expect(result.current.recents).toHaveLength(0)
    expect(localStorage.getItem('ehparkleh:recent')).toBe('[]')
  })
})
