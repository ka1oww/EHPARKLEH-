import { describe, it, expect } from 'vitest'
import { isFree } from '@/rules'

describe('isFree', () => {
  it('is false for missing values or an explicit "NO"', () => {
    expect(isFree(null)).toBe(false)
    expect(isFree(undefined)).toBe(false)
    expect(isFree('')).toBe(false)
    expect(isFree('NO')).toBe(false)
    expect(isFree(' no ')).toBe(false)
  })

  it('is true when there is an actual free-parking schedule', () => {
    expect(isFree('SUN & PH FR 7AM-10.30PM')).toBe(true)
  })
})
