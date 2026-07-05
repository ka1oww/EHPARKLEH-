import { useState } from 'react'
import { ArrowUpRight, Navigation, Wallet, Tag, Info, Star, Share2, Zap, Droplets } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { AvailabilityChip } from '@/components/AvailabilityChip'
import { parseFreeParking } from '@/rules'
import type { ParkingEntry } from '@/types'

interface Props {
  entry: ParkingEntry
  rank: number
  selected: boolean
  onSelect: () => void
  isFavourite: boolean
  onToggleFavourite: () => void
}

function gmapsHref(lat: number, lon: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`
}

function DirectionsLink({ lat, lon }: { lat: number; lon: number }) {
  return (
    <a
      href={gmapsHref(lat, lon)}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Navigation className="size-3.5" aria-hidden="true" />
      Directions
      <ArrowUpRight className="size-3" aria-hidden="true" />
    </a>
  )
}

function ShareButton({ name, lat, lon }: { name: string; lat: number; lon: number }) {
  const [copied, setCopied] = useState(false)
  async function share(e: React.MouseEvent) {
    e.stopPropagation()
    const url = `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`
    try {
      if (navigator.share) {
        await navigator.share({ title: name, text: `Park at ${name}`, url })
        return
      }
      await navigator.clipboard.writeText(`${name} — ${url}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* user cancelled the share sheet, or APIs unavailable */
    }
  }
  return (
    <button
      type="button"
      onClick={share}
      aria-label={`Share ${name}`}
      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Share2 className="size-3.5" aria-hidden="true" />
      {copied ? 'Copied' : 'Share'}
    </button>
  )
}

function StarButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      aria-pressed={active}
      aria-label={active ? 'Remove from saved' : 'Save carpark'}
      className={cn(
        'inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active ? 'text-amber-400' : 'text-muted-foreground/40 hover:text-amber-400',
      )}
    >
      <Star className={cn('size-4', active && 'fill-current')} aria-hidden="true" />
    </button>
  )
}

function LiveBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-avail-free/12 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-avail-free uppercase">
      <span className="led-dot-live size-1.5 rounded-full bg-avail-free" aria-hidden="true" />
      Live
    </span>
  )
}

// EV charging badge. Shows the live "N/M free" count when the availability feed
// is up (green when >0 free), else a static "EV charging" pill. A ⚡ + "fast"
// hint marks DC fast chargers (>=43 kW).
function EvBadge({
  available,
  total,
  maxPowerKw,
}: {
  available: number | null
  total: number | null
  maxPowerKw: number | null
}) {
  const hasLive = available !== null && total !== null
  const free = hasLive && available > 0
  const fast = typeof maxPowerKw === 'number' && maxPowerKw >= 43
  const label = hasLive
    ? `${available}/${total} chargers free`
    : total
      ? `EV · ${total} chargers`
      : 'EV charging'
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold',
        free ? 'bg-avail-free/12 text-avail-free' : 'bg-amber-500/15 text-amber-600',
      )}
    >
      <Zap className="size-3" aria-hidden="true" />
      {label}
      {fast && ' · fast'}
    </span>
  )
}

function Distance({ m }: { m: number }) {
  return (
    <span className="font-data shrink-0 text-xs font-bold tabular-nums text-muted-foreground">
      {m}m
    </span>
  )
}

export function CarparkCard({
  entry,
  rank,
  selected,
  onSelect,
  isFavourite,
  onToggleFavourite,
}: Props) {
  // Root is a div with role="button" (not a <button>) so the inner star / share
  // / directions controls are valid, focusable interactive elements.
  const base = cn(
    'group w-full cursor-pointer rounded-xl border bg-card p-3.5 text-left shadow-sm transition-all',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
    selected
      ? 'border-signal ring-1 ring-signal shadow-md'
      : 'border-hairline hover:border-slate-300 hover:shadow-md',
  )
  const rootProps = {
    role: 'button',
    tabIndex: 0,
    'aria-pressed': selected,
    onClick: onSelect,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onSelect()
      }
    },
    className: base,
  }

  if (entry.source === 'osm') {
    return (
      <div {...rootProps}>
        <div className="flex items-start gap-3">
          <span
            className="font-data mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-sm font-bold text-secondary-foreground"
            aria-hidden="true"
          >
            P
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-1.5">
              <span className="font-display text-sm font-semibold leading-snug text-ink">
                {entry.name}
              </span>
              <div className="flex shrink-0 items-center gap-1">
                <Distance m={entry.distance_m} />
                <StarButton active={isFavourite} onClick={onToggleFavourite} />
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {entry.fee === 'no' && (
                <Badge className="bg-avail-free/12 font-medium text-avail-free hover:bg-avail-free/12">
                  Free
                </Badge>
              )}
              {entry.parking_type && (
                <Badge variant="secondary" className="font-medium capitalize">
                  {entry.parking_type}
                </Badge>
              )}
            </div>
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between border-t border-hairline pt-2.5">
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Info className="size-3.5" aria-hidden="true" />
            No live lots or rates here
          </span>
          <div className="flex items-center gap-0.5">
            <ShareButton name={entry.name} lat={entry.lat} lon={entry.lon} />
            <DirectionsLink lat={entry.lat} lon={entry.lon} />
          </div>
        </div>
      </div>
    )
  }

  const freeText = parseFreeParking(entry.free_parking_info)
  const isLive = entry.lots_available !== null

  return (
    <div {...rootProps}>
      <div className="flex items-start gap-3">
        <span
          className="font-data mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground tabular-nums"
          aria-hidden="true"
        >
          {rank}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-1.5">
            <span className="font-display text-sm font-semibold leading-snug text-ink">
              {entry.address}
            </span>
            <div className="flex shrink-0 items-center gap-1">
              <Distance m={entry.distance_m} />
              <StarButton active={isFavourite} onClick={onToggleFavourite} />
            </div>
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <AvailabilityChip available={entry.lots_available} total={entry.total_lots} />
            {isLive && <LiveBadge />}
            {entry.ev && (
              <EvBadge
                available={entry.ev_available}
                total={entry.ev_total}
                maxPowerKw={entry.ev_max_power_kw}
              />
            )}
            {entry.carwash && (
              <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/15 px-2 py-0.5 text-xs font-semibold text-sky-600">
                <Droplets className="size-3" aria-hidden="true" />
                {entry.carwash_operator && entry.carwash_operator !== 'Self-service'
                  ? entry.carwash_operator
                  : 'Car wash'}
              </span>
            )}
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {entry.rate.known ? (
              <Badge variant="secondary" className="gap-1 font-medium">
                <Wallet className="size-3" aria-hidden="true" />
                {entry.rate.summary}
              </Badge>
            ) : (
              <Badge variant="outline" className="gap-1 font-normal text-muted-foreground">
                <Wallet className="size-3" aria-hidden="true" />
                Rate unknown
              </Badge>
            )}
            {entry.category && (
              <Badge variant="outline" className="gap-1 font-medium text-muted-foreground">
                <Tag className="size-3" aria-hidden="true" />
                {entry.category}
              </Badge>
            )}
          </div>

          {freeText && (
            <div className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-avail-free/10 px-2 py-1 text-xs font-medium text-avail-free">
              <span aria-hidden="true">●</span>
              {freeText}
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-hairline pt-2.5">
        <span className="text-xs text-muted-foreground">{entry.type || 'Carpark'}</span>
        <div className="flex items-center gap-0.5">
          <ShareButton name={entry.address} lat={entry.lat} lon={entry.lon} />
          <DirectionsLink lat={entry.lat} lon={entry.lon} />
        </div>
      </div>
    </div>
  )
}
