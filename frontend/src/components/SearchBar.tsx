import { useEffect, useRef, useState } from 'react'
import { MapPin, Search, LocateFixed, Loader2, Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { Suggestion } from '@/types'
import type { RecentSearch } from '@/useRecentSearches'

interface Props {
  apiBase: string
  loading: boolean
  /** Geocode a free-text query (Enter / Search button). */
  onSubmit: (query: string) => void
  /** Resolve a picked suggestion straight to coordinates. */
  onPickSuggestion: (s: Suggestion) => void
  onNearMe: () => void
  /** Recent destination searches, shown when the input is empty + focused. */
  recents: RecentSearch[]
  onPickRecent: (r: RecentSearch) => void
  onClearRecents: () => void
}

// Indigo command-bar search with debounced server-side autocomplete.
// Behaviour preserved: debounce 300ms, >=2 chars to query, Enter geocodes,
// picking a suggestion searches its coords directly, click-outside closes.
export function SearchBar({
  apiBase,
  loading,
  onSubmit,
  onPickSuggestion,
  onNearMe,
  recents,
  onPickRecent,
  onClearRecents,
}: Props) {
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [open, setOpen] = useState(false)
  const [activeIdx, setActiveIdx] = useState(-1)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value
    setQuery(val)
    setActiveIdx(-1)
    clearTimeout(debounceRef.current)
    if (val.trim().length < 2) {
      setSuggestions([])
      // Empty field: fall back to showing recents; 1 char: close.
      setOpen(!val.trim() && recents.length > 0)
      return
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`${apiBase}/api/suggestions?q=${encodeURIComponent(val)}`)
        const data: Suggestion[] = await res.json()
        setSuggestions(data)
        setOpen(data.length > 0)
      } catch {
        setSuggestions([])
      }
    }, 300)
  }

  function pick(s: Suggestion) {
    setQuery(s.address)
    setSuggestions([])
    setOpen(false)
    setActiveIdx(-1)
    onPickSuggestion(s)
  }

  function pickRecent(r: RecentSearch) {
    setQuery(r.query)
    setSuggestions([])
    setOpen(false)
    setActiveIdx(-1)
    onPickRecent(r)
  }

  const showRecents = open && !query.trim() && suggestions.length === 0 && recents.length > 0

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (activeIdx >= 0 && suggestions[activeIdx]) {
      pick(suggestions[activeIdx])
      return
    }
    if (!query.trim()) return
    setSuggestions([])
    setOpen(false)
    onSubmit(query)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || suggestions.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => (i + 1) % suggestions.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => (i <= 0 ? suggestions.length - 1 : i - 1))
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <div ref={boxRef} className="relative flex-1">
        <form onSubmit={handleSubmit} className="flex items-center gap-2" role="search">
          <div className="relative flex-1">
            <Search
              className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              value={query}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onFocus={() => {
                if (suggestions.length > 0 || (!query.trim() && recents.length > 0)) setOpen(true)
              }}
              placeholder="Park where? e.g. Toa Payoh Hub"
              autoComplete="off"
              aria-label="Search a destination"
              className={cn(
                'h-11 w-full rounded-xl border border-transparent bg-white pr-3 pl-10 text-sm text-ink shadow-sm',
                'placeholder:text-muted-foreground/80',
                'focus-visible:border-signal focus-visible:ring-2 focus-visible:ring-signal/50 focus-visible:outline-none',
              )}
            />
          </div>
          <Button
            type="submit"
            disabled={loading}
            className="h-11 shrink-0 rounded-xl bg-signal px-4 font-display font-semibold text-accent-foreground hover:bg-signal/90"
          >
            {loading ? <Loader2 className="size-4 animate-spin" /> : 'Search'}
          </Button>
        </form>

        {showRecents && (
          <ul
            className="absolute top-[calc(100%+0.5rem)] right-0 left-0 z-30 overflow-hidden rounded-xl border border-hairline bg-popover py-1 shadow-lg"
            role="listbox"
          >
            <li className="flex items-center justify-between px-3.5 py-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              Recent
              <button
                type="button"
                onMouseDown={onClearRecents}
                className="text-xs font-medium tracking-normal text-muted-foreground normal-case hover:text-foreground"
              >
                Clear
              </button>
            </li>
            {recents.map((r) => (
              <li key={r.query} role="option">
                <button
                  type="button"
                  onMouseDown={() => pickRecent(r)}
                  className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-sm text-slate-body hover:bg-secondary/60"
                >
                  <Clock className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="truncate">{r.query}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {open && suggestions.length > 0 && (
          <ul
            className="absolute top-[calc(100%+0.5rem)] right-0 left-0 z-30 overflow-hidden rounded-xl border border-hairline bg-popover py-1 shadow-lg"
            role="listbox"
          >
            {suggestions.map((s, i) => (
              <li key={i} role="option" aria-selected={i === activeIdx}>
                <button
                  type="button"
                  onMouseDown={() => pick(s)}
                  onMouseEnter={() => setActiveIdx(i)}
                  className={cn(
                    'flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-sm text-slate-body',
                    i === activeIdx ? 'bg-secondary text-foreground' : 'hover:bg-secondary/60',
                  )}
                >
                  <MapPin className="size-4 shrink-0 text-primary" aria-hidden="true" />
                  <span className="truncate">{s.address}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Button
        type="button"
        variant="outline"
        onClick={onNearMe}
        className="h-11 shrink-0 gap-2 rounded-xl border-white/20 bg-white/10 font-medium text-white hover:bg-white/20 hover:text-white"
      >
        <LocateFixed className="size-4" aria-hidden="true" />
        Near me
      </Button>
    </div>
  )
}
