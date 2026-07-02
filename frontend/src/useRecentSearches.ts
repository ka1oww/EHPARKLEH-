import { useCallback, useEffect, useState } from 'react'

// Recent destination searches (localStorage), mirroring useFavourites.
// Powers the SearchBar dropdown when the input is empty.
export interface RecentSearch {
  query: string
  lat: number
  lon: number
  ts: number
}

const KEY = 'ehparkleh:recent'
const MAX = 6

function load(): RecentSearch[] {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as RecentSearch[]) : []
  } catch {
    return []
  }
}

export function useRecentSearches() {
  const [recents, setRecents] = useState<RecentSearch[]>(load)

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(recents))
    } catch {
      /* storage unavailable (e.g. private mode) */
    }
  }, [recents])

  const add = useCallback((query: string, lat: number, lon: number) => {
    const q = query.trim()
    if (!q) return
    setRecents((prev) => {
      const deduped = prev.filter((r) => r.query.toLowerCase() !== q.toLowerCase())
      return [{ query: q, lat, lon, ts: Date.now() }, ...deduped].slice(0, MAX)
    })
  }, [])

  const clear = useCallback(() => setRecents([]), [])

  return { recents, add, clear }
}
