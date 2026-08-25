import { describe, it, expect } from 'vitest'
import { getAvailability, availColor, type AvailState } from '@/availability'

describe('getAvailability', () => {
  it('returns nodata when counts are missing or total is zero', () => {
    expect(getAvailability(null, 100).state).toBe('nodata')
    expect(getAvailability(50, null).state).toBe('nodata')
    expect(getAvailability(0, 0).state).toBe('nodata')
  })

  it('classifies by fraction of lots free', () => {
    expect(getAvailability(50, 100)).toMatchObject({ state: 'free', label: 'Plenty' })
    expect(getAvailability(20, 100)).toMatchObject({ state: 'some', label: 'Filling up' })
    expect(getAvailability(5, 100)).toMatchObject({ state: 'full', label: 'Almost full' })
    expect(getAvailability(0, 100)).toMatchObject({ state: 'full', label: 'No lots' })
  })

  it('treats exactly 40% as "filling up" (threshold is strictly > 0.4)', () => {
    expect(getAvailability(40, 100).state).toBe('some')
  })
})

describe('availColor', () => {
  it('maps every state to a distinct hex colour', () => {
    const states: AvailState[] = ['free', 'some', 'full', 'nodata']
    const colours = states.map(availColor)
    expect(new Set(colours).size).toBe(states.length)
    expect(availColor('free')).toBe('#1C6E4A')
  })
})
