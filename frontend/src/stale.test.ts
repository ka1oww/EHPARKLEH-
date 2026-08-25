import { describe, it, expect } from 'vitest'
import { formatLastSeen, formatStaleCount } from './stale'

describe('formatStaleCount', () => {
  it('marks a count we could not refresh with a tilde', () => {
    expect(formatStaleCount(60)).toBe('~060')
    expect(formatStaleCount(1043)).toBe('~1043')
  })

  it('still says FULL rather than ~000, because full is full', () => {
    expect(formatStaleCount(0)).toBe('~FULL')
  })

  it('leaves an unlit board unlit', () => {
    expect(formatStaleCount(null)).toBe('---')
  })
})

describe('formatLastSeen', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0)
  const agoMs = (ms: number) => now - ms

  it('writes minutes the way the offline artboard does', () => {
    expect(formatLastSeen(agoMs(12 * 60_000), now)).toBe('12 minutes ago')
    expect(formatLastSeen(agoMs(60_000), now)).toBe('1 minute ago')
  })

  it('shortens for a card row', () => {
    expect(formatLastSeen(agoMs(12 * 60_000), now, { short: true })).toBe('12 min ago')
    expect(formatLastSeen(agoMs(3 * 3_600_000), now, { short: true })).toBe('3 hr ago')
  })

  it('rolls up to hours and days', () => {
    expect(formatLastSeen(agoMs(3 * 3_600_000), now)).toBe('3 hours ago')
    expect(formatLastSeen(agoMs(2 * 86_400_000), now)).toBe('2 days ago')
  })

  it('says just now under a minute', () => {
    expect(formatLastSeen(agoMs(5_000), now)).toBe('just now')
  })

  it('claims no age it does not have', () => {
    expect(formatLastSeen(null, now)).toBeNull()
    expect(formatLastSeen(undefined, now)).toBeNull()
    // A clock that moved backwards must not produce "-3 minutes ago".
    expect(formatLastSeen(now + 60_000, now)).toBeNull()
  })
})
