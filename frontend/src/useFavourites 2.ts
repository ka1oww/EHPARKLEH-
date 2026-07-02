import { useCallback, useEffect, useState } from 'react'

// Persisted set of saved carpark ids (localStorage). No backend, no new screen:
// a star toggle so the user's saved spots survive a refresh or reopen.
const KEY = 'ehparkleh:favourites'

function load(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}

export function useFavourites() {
  const [favourites, setFavourites] = useState<Set<string>>(load)

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify([...favourites]))
    } catch {
      /* storage unavailable (e.g. private mode): favourites stay in-memory */
    }
  }, [favourites])

  const toggle = useCallback((id: string) => {
    setFavourites((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const isFavourite = useCallback((id: string) => favourites.has(id), [favourites])

  return { favourites, toggle, isFavourite }
}
