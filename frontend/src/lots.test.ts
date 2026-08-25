import { describe, it, expect } from 'vitest'
import { formatLotCount, isFullHouse, statusLine, NO_COUNT } from './lots'

describe('formatLotCount', () => {
  it('pads a count to three gantry-board digits', () => {
    expect(formatLotCount(62)).toBe('062')
    expect(formatLotCount(8)).toBe('008')
    expect(formatLotCount(104)).toBe('104')
  })

  it('says FULL rather than 000 when nothing is left', () => {
    expect(formatLotCount(0)).toBe('FULL')
  })

  it('keeps every digit of a count past 999', () => {
    expect(formatLotCount(1024)).toBe('1024')
  })

  it('leaves the board unlit when there is no live count', () => {
    expect(formatLotCount(null)).toBe(NO_COUNT)
  })
})

describe('isFullHouse', () => {
  it('is true only for a live count of zero', () => {
    expect(isFullHouse(0)).toBe(true)
    expect(isFullHouse(1)).toBe(false)
    expect(isFullHouse(null)).toBe(false)
  })
})

describe('statusLine', () => {
  it('speaks Singlish about one carpark', () => {
    expect(statusLine('free', 62)).toBe('steady, got lots')
    expect(statusLine('some', 8)).toBe('filling up already')
    expect(statusLine('full', 2)).toBe('almost gone')
  })

  it('calls a carpark with nothing left a full house', () => {
    expect(statusLine('full', 0)).toBe('full house')
  })

  it('does not invent a status without a live count', () => {
    expect(statusLine('nodata', null)).toBe('no live count')
  })
})
