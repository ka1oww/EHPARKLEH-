import { describe, it, expect } from 'vitest'
import { freeParkingHeadline, isFree } from '@/rules'

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

describe('freeParkingHeadline', () => {
  it('compacts a day-and-window schedule for the dot-matrix strip', () => {
    expect(freeParkingHeadline('SUN & PH FR 7AM-10.30PM')).toBe('SUN & PH FREE 7AM-10.30PM')
    expect(freeParkingHeadline('SUN FR 1PM-10.30PM')).toBe('SUN FREE 1PM-10.30PM')
  })

  it('handles a days-only schedule', () => {
    expect(freeParkingHeadline('DAILY')).toBe('DAILY FREE')
  })

  it('stays dark when there is nothing notable to say', () => {
    expect(freeParkingHeadline('NO')).toBeNull()
    expect(freeParkingHeadline(null)).toBeNull()
  })

  it('refuses to guess at a shape it cannot shorten confidently', () => {
    expect(freeParkingHeadline('WED TO FRI EXCEPT EVE OF PH FR 7AM-10.30PM')).toBeNull()
    expect(freeParkingHeadline('SEE NOTICE AT ENTRANCE')).toBeNull()
  })
})
