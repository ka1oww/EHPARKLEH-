import { useCallback, useEffect, useRef, useState } from 'react'

// The saved carparks (localStorage). Round 1 stored a bare set of ids, which
// was enough for a star on a card but not for the Saved artboard: that screen
// lists carparks the current search may not even contain, so each star has to
// carry enough of the carpark with it to be listed on its own — the name, the
// sub-label, where it is, and the last count we actually saw.
//
// A count is never re-published as live from here. `lastSeenAt` travels with
// `lastLots` precisely so the Saved view can say how old the number is, the
// same rule the offline screen follows.

const KEY = 'ehparkleh:favourites'
const VERSION = 2

export interface SavedCarpark {
  id: string
  /** Address (HDB) or name (OSM) — what the card called it when it was saved. */
  title: string
  lat: number | null
  lon: number | null
  /** The quiet second line, e.g. "HDB · $0.60/30min". */
  subLabel: string | null
  savedAt: number
  lastLots: number | null
  lastTotal: number | null
  lastSeenAt: number | null
}

/** What a card knows about a carpark at the moment the star is pressed. */
export interface SavedCarparkInput {
  id: string
  title: string
  lat?: number | null
  lon?: number | null
  subLabel?: string | null
  lots?: number | null
  total?: number | null
}

function record(input: SavedCarparkInput, seenAt: number | null, savedAt: number): SavedCarpark {
  return {
    id: input.id,
    title: input.title,
    lat: input.lat ?? null,
    lon: input.lon ?? null,
    subLabel: input.subLabel ?? null,
    savedAt,
    lastLots: input.lots ?? null,
    lastTotal: input.total ?? null,
    lastSeenAt: input.lots == null ? null : seenAt,
  }
}

function isSameRecord(a: SavedCarpark, b: SavedCarpark): boolean {
  return (
    a.title === b.title &&
    a.lat === b.lat &&
    a.lon === b.lon &&
    a.subLabel === b.subLabel &&
    a.lastLots === b.lastLots &&
    a.lastTotal === b.lastTotal &&
    a.lastSeenAt === b.lastSeenAt
  )
}

// A v1 star was an id and nothing else. Rather than drop it (the person did
// deliberately save that carpark), keep it and let `sync` fill in the rest the
// next time that carpark turns up in a search.
function load(): SavedCarpark[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (Array.isArray(parsed)) {
      const now = Date.now()
      return parsed
        .filter((id): id is string => typeof id === 'string')
        .map((id) => record({ id, title: id }, null, now))
    }
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.items)) {
      return (parsed.items as SavedCarpark[]).filter((it) => it && typeof it.id === 'string')
    }
    return []
  } catch {
    return []
  }
}

export function useSavedCarparks() {
  const [saved, setSaved] = useState<SavedCarpark[]>(load)
  // `sync` runs off render data, so it must not be rebuilt whenever the list
  // changes — that would make the effect calling it fire in a loop.
  const savedRef = useRef(saved)
  savedRef.current = saved

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ version: VERSION, items: saved }))
    } catch {
      /* storage unavailable (e.g. private mode): saves stay in-memory */
    }
  }, [saved])

  const isSaved = useCallback((id: string) => saved.some((s) => s.id === id), [saved])

  const toggle = useCallback((input: SavedCarparkInput, seenAt: number | null = Date.now()) => {
    setSaved((prev) => {
      if (prev.some((s) => s.id === input.id)) return prev.filter((s) => s.id !== input.id)
      return [record(input, seenAt, Date.now()), ...prev]
    })
  }, [])

  const remove = useCallback((id: string) => {
    setSaved((prev) => prev.filter((s) => s.id !== id))
  }, [])

  /**
   * Refresh saved records from whatever the current search actually returned.
   * Only ids already saved are touched, and the list identity is preserved
   * when nothing changed, so this is safe to call from a render effect.
   */
  const sync = useCallback((seen: SavedCarparkInput[], seenAt: number | null) => {
    if (seen.length === 0) return
    const bySeenId = new Map(seen.map((s) => [s.id, s]))
    const prev = savedRef.current
    let changed = false
    const next = prev.map((item) => {
      const fresh = bySeenId.get(item.id)
      if (!fresh) return item
      const merged: SavedCarpark = {
        ...item,
        title: fresh.title || item.title,
        lat: fresh.lat ?? item.lat,
        lon: fresh.lon ?? item.lon,
        subLabel: fresh.subLabel ?? item.subLabel,
        lastLots: fresh.lots ?? item.lastLots,
        lastTotal: fresh.total ?? item.lastTotal,
        lastSeenAt: fresh.lots == null ? item.lastSeenAt : seenAt,
      }
      if (isSameRecord(item, merged)) return item
      changed = true
      return merged
    })
    if (changed) setSaved(next)
  }, [])

  return { saved, isSaved, toggle, remove, sync }
}
