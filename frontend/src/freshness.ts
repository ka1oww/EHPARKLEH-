export type FeedFreshness = 'fresh' | 'recent' | 'saved'

export interface LiveFeedFreshness {
  availability: FeedFreshness
  ev: FeedFreshness
}

interface FeedSnapshot {
  state: string | null
  freshUntil: number | null
}

export interface LiveFeedSnapshot {
  availability: FeedSnapshot
  ev: FeedSnapshot
}

export const SAVED_FEED_FRESHNESS: LiveFeedFreshness = {
  availability: 'saved',
  ev: 'saved',
}

const RECENT_AFTER_EXPIRY_MS = 2 * 60 * 1000

type HeaderReader = Pick<Headers, 'get'>

function readFeedSnapshot(
  headers: HeaderReader,
  stateHeader: string,
  deadlineHeader: string,
): FeedSnapshot {
  const parsedDeadline = Date.parse(headers.get(deadlineHeader) || '')
  return {
    state: headers.get(stateHeader),
    freshUntil: Number.isFinite(parsedDeadline) ? parsedDeadline : null,
  }
}

export function readLiveFeedSnapshot(
  headers: HeaderReader | undefined,
): LiveFeedSnapshot | null {
  if (!headers) return null
  return {
    availability: readFeedSnapshot(
      headers,
      'X-EhParkLeh-Availability-State',
      'X-EhParkLeh-Availability-Fresh-Until',
    ),
    ev: readFeedSnapshot(
      headers,
      'X-EhParkLeh-Ev-State',
      'X-EhParkLeh-Ev-Fresh-Until',
    ),
  }
}

function feedFreshness(snapshot: FeedSnapshot, now: number): FeedFreshness {
  if (snapshot.state === 'disabled') return 'fresh'
  if (!hasAgeingSnapshot(snapshot) || snapshot.freshUntil === null) return 'saved'
  if (snapshot.state !== 'stale' && now < snapshot.freshUntil) return 'fresh'
  if (now < snapshot.freshUntil + RECENT_AFTER_EXPIRY_MS) return 'recent'
  return 'saved'
}

function hasAgeingSnapshot(snapshot: FeedSnapshot): boolean {
  return snapshot.state === 'hit' || snapshot.state === 'empty' || snapshot.state === 'stale'
}

export function liveFeedFreshness(
  snapshot: LiveFeedSnapshot | null,
  now = Date.now(),
): LiveFeedFreshness {
  if (!snapshot) return SAVED_FEED_FRESHNESS

  return {
    availability: feedFreshness(snapshot.availability, now),
    ev: feedFreshness(snapshot.ev, now),
  }
}

function nextFeedTransition(snapshot: FeedSnapshot, now: number): number | null {
  if (!hasAgeingSnapshot(snapshot) || snapshot.freshUntil === null) return null
  if (snapshot.state !== 'stale' && now < snapshot.freshUntil) return snapshot.freshUntil
  const savedAt = snapshot.freshUntil + RECENT_AFTER_EXPIRY_MS
  return now < savedAt ? savedAt : null
}

export function nextLiveFeedFreshnessTransition(
  snapshot: LiveFeedSnapshot | null,
  now = Date.now(),
): number | null {
  if (!snapshot) return null
  const transitions = [
    nextFeedTransition(snapshot.availability, now),
    nextFeedTransition(snapshot.ev, now),
  ].filter((transition): transition is number => transition !== null)
  return transitions.length > 0 ? Math.min(...transitions) : null
}
