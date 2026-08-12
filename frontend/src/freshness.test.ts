import { describe, expect, it } from 'vitest'
import {
  liveFeedFreshness,
  nextLiveFeedFreshnessTransition,
  readLiveFeedSnapshot,
} from './freshness'

function headers(values: Record<string, string>) {
  const normalised = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]),
  )
  return { get: (key: string) => normalised[key.toLowerCase()] ?? null }
}

describe('liveFeedFreshness', () => {
  const now = Date.parse('2026-08-09T11:00:00.000Z')

  it('keeps fresh and stale feed states separate', () => {
    const snapshot = readLiveFeedSnapshot(
      headers({
        'X-EhParkLeh-Availability-State': 'stale',
        'X-EhParkLeh-Availability-Fresh-Until': '2026-08-09T10:59:30.000Z',
        'X-EhParkLeh-Ev-State': 'hit',
        'X-EhParkLeh-Ev-Fresh-Until': '2026-08-09T11:00:30.000Z',
      }),
    )
    expect(
      liveFeedFreshness(snapshot, now),
    ).toEqual({ availability: 'recent', ev: 'fresh' })
    expect(nextLiveFeedFreshnessTransition(snapshot, now)).toBe(now + 30_000)
  })

  it('downgrades a hit at its snapshot deadline and eventually marks it saved', () => {
    const freshUntil = now + 30_000
    const snapshot = readLiveFeedSnapshot(
      headers({
        'X-EhParkLeh-Availability-State': 'hit',
        'X-EhParkLeh-Availability-Fresh-Until': new Date(freshUntil).toISOString(),
        'X-EhParkLeh-Ev-State': 'disabled',
      }),
    )

    expect(liveFeedFreshness(snapshot, now).availability).toBe('fresh')
    expect(liveFeedFreshness(snapshot, freshUntil).availability).toBe('recent')
    expect(liveFeedFreshness(snapshot, freshUntil + 120_000).availability).toBe('saved')
  })

  it('ages a successful empty-cache response like a hit', () => {
    const freshUntil = now + 30_000
    const snapshot = readLiveFeedSnapshot(
      headers({
        'X-EhParkLeh-Availability-State': 'empty',
        'X-EhParkLeh-Availability-Fresh-Until': new Date(freshUntil).toISOString(),
        'X-EhParkLeh-Ev-State': 'disabled',
      }),
    )

    expect(liveFeedFreshness(snapshot, now).availability).toBe('fresh')
    expect(nextLiveFeedFreshnessTransition(snapshot, now)).toBe(freshUntil)
    expect(liveFeedFreshness(snapshot, freshUntil).availability).toBe('recent')
    expect(liveFeedFreshness(snapshot, freshUntil + 120_000).availability).toBe('saved')
  })

  it('treats an empty-cache response without a snapshot deadline as saved', () => {
    const snapshot = readLiveFeedSnapshot(
      headers({
        'X-EhParkLeh-Availability-State': 'empty',
        'X-EhParkLeh-Ev-State': 'disabled',
      }),
    )

    expect(liveFeedFreshness(snapshot, now).availability).toBe('saved')
    expect(nextLiveFeedFreshnessTransition(snapshot, now)).toBeNull()
  })

  it('marks an old snapshot saved even when a new response reports the cache stale', () => {
    const snapshot = readLiveFeedSnapshot(
      headers({
        'X-EhParkLeh-Availability-State': 'stale',
        'X-EhParkLeh-Availability-Fresh-Until': '2026-08-09T10:55:00.000Z',
        'X-EhParkLeh-Ev-State': 'stale',
        'X-EhParkLeh-Ev-Fresh-Until': '2026-08-09T10:55:00.000Z',
      }),
    )
    expect(
      liveFeedFreshness(snapshot, now),
    ).toEqual({ availability: 'saved', ev: 'saved' })
  })

  it('treats missing freshness telemetry conservatively', () => {
    expect(liveFeedFreshness(readLiveFeedSnapshot(undefined), now)).toEqual({
      availability: 'saved',
      ev: 'saved',
    })
  })
})
