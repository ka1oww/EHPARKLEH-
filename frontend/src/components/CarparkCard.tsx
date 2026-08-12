import { memo, useState } from 'react'
import { Navigation, Navigation2, Wallet, Tag, Info, Star, Share2, Zap, Droplets, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { AvailabilityChip } from '@/components/AvailabilityChip'
import { parseFreeParking } from '@/rules'
import type { FeedFreshness } from '@/freshness'
import type { ParkingEntry } from '@/types'

interface Props {
  entry: ParkingEntry
  rank: number
  selected: boolean
  onSelect: (id: string) => void
  isFavourite: boolean
  onToggleFavourite: (id: string) => void
  availabilityFreshness?: FeedFreshness
  evFreshness?: FeedFreshness
}

function gmapsHref(lat: number, lon: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`
}

// Waze universal deep link: opens the Waze app (or web) and starts navigation
// to the coordinates. navigate=yes routes immediately.
function wazeHref(lat: number, lon: number): string {
  return `https://www.waze.com/ul?ll=${lat},${lon}&navigate=yes`
}

// Distance is the driver's first signal, so it reads large and near-ink, and
// switches to km past 1000m for glanceability.
function fmtDistance(m: number): string {
  return m >= 1000
    ? `${new Intl.NumberFormat('en-SG', { maximumFractionDigits: 1 }).format(m / 1000)} km`
    : `${m} m`
}

// A navigation deep-link (Google Maps or Waze). Opens in a new tab; its click
// is kept off the card's stretched select button.
function NavLink({ href, label, icon: Icon }: { href: string; label: string; icon: LucideIcon }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="pointer-events-auto inline-flex min-h-11 items-center gap-1 rounded-md px-2.5 py-2 text-xs font-semibold text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {label}
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
      className="pointer-events-auto inline-flex min-h-11 items-center gap-1 rounded-md px-2.5 py-2 text-xs font-semibold text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
        'pointer-events-auto inline-flex size-11 shrink-0 items-center justify-center rounded-md transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active ? 'text-amber-400' : 'text-muted-foreground/50 hover:text-amber-400',
      )}
    >
      <Star className={cn('size-4', active && 'fill-current')} aria-hidden="true" />
    </button>
  )
}

function LiveBadge({ freshness }: { freshness: FeedFreshness }) {
  const label = freshness === 'fresh' ? 'Live' : freshness === 'recent' ? 'Recent' : 'Saved'
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold tracking-wide uppercase',
        freshness === 'fresh'
          ? 'bg-avail-free/12 text-avail-free'
          : freshness === 'recent'
            ? 'bg-amber-500/15 text-amber-700'
            : 'bg-slate-500/12 text-slate-600',
      )}
    >
      <span
        className={cn(
          'size-1.5 rounded-full',
          freshness === 'fresh'
            ? 'led-dot-live bg-avail-free'
            : freshness === 'recent'
              ? 'bg-amber-500'
              : 'bg-slate-400',
        )}
        aria-hidden="true"
      />
      {label}
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
  freshness,
}: {
  available: number | null
  total: number | null
  maxPowerKw: number | null
  freshness: FeedFreshness
}) {
  const hasLive = available !== null && total !== null
  const free = hasLive && available > 0
  const fast = typeof maxPowerKw === 'number' && maxPowerKw >= 43
  const countLabel = hasLive
    ? `${available}/${total} chargers free`
    : total
      ? `EV · ${total} chargers`
      : 'EV charging'
  const label = hasLive && freshness !== 'fresh'
    ? `${countLabel} · ${freshness === 'recent' ? 'recent' : 'saved'}`
    : countLabel
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
    <span className="font-data shrink-0 text-base font-bold tabular-nums text-ink">
      {fmtDistance(m)}
    </span>
  )
}

function FreeSunPhPill({ text }: { text: string }) {
  return (
    <div className="mt-2 inline-flex max-w-full items-start gap-1.5 rounded-md bg-avail-free/10 px-2 py-1 text-xs font-medium text-avail-free">
      <span className="mt-0.5 shrink-0" aria-hidden="true">●</span>
      <span className="min-w-0">{text}</span>
    </div>
  )
}

function CarparkCardImpl({
  entry,
  rank,
  selected,
  onSelect,
  isFavourite,
  onToggleFavourite,
  availabilityFreshness = 'fresh',
  evFreshness = 'fresh',
}: Props) {
  // A stretched, transparent <button> (behind the content) is the select action:
  // it is keyboard-focusable and screen-reader-labelled, and the content layer is
  // pointer-events-none so a tap anywhere falls through to it, while the star /
  // share / directions controls (pointer-events-auto) capture their own taps.
  // This keeps the interactive controls OUT of the button, unlike a role="button"
  // wrapper, which is invalid when it nests other buttons.
  const title = entry.source === 'osm' ? entry.name : entry.address
  const container = cn(
    'group relative w-full rounded-xl border bg-card p-3.5 text-left shadow-sm transition-all',
    selected
      ? 'border-signal ring-1 ring-signal shadow-md'
      : 'border-hairline hover:border-slate-300 hover:shadow-md',
  )
  const selectButton = (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`Show ${title} on map`}
      onClick={() => onSelect(entry.id)}
      className="absolute inset-0 z-[1] cursor-pointer rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    />
  )

  if (entry.source === 'osm') {
    return (
      <div className={container}>
        {selectButton}
        <div className="pointer-events-none relative z-[2]">
          <div className="flex items-start gap-3">
            <span
              className="font-data mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-sm font-bold text-secondary-foreground"
              aria-hidden="true"
            >
              P
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-1.5">
                <span className="min-w-0 font-display text-sm font-semibold leading-snug break-words text-ink">
                  {entry.name}
                </span>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Distance m={entry.distance_m} />
                  <StarButton active={isFavourite} onClick={() => onToggleFavourite(entry.id)} />
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
          <div className="mt-3 flex items-center justify-between gap-2 border-t border-hairline pt-2.5">
            <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <Info className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">No live info</span>
            </span>
            <div className="flex shrink-0 items-center gap-0.5">
              <ShareButton name={entry.name} lat={entry.lat} lon={entry.lon} />
              <NavLink href={gmapsHref(entry.lat, entry.lon)} label="Maps" icon={Navigation} />
              <NavLink href={wazeHref(entry.lat, entry.lon)} label="Waze" icon={Navigation2} />
            </div>
          </div>
        </div>
      </div>
    )
  }

  const freeText = parseFreeParking(entry.free_parking_info)
  const isLive = entry.lots_available !== null

  return (
    <div className={container}>
      {selectButton}
      <div className="pointer-events-none relative z-[2]">
        <div className="flex items-start gap-3">
          <span
            className="font-data mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground tabular-nums"
            aria-hidden="true"
          >
            {rank}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-1.5">
              <span className="min-w-0 font-display text-sm font-semibold leading-snug break-words text-ink">
                {entry.address}
              </span>
              <div className="flex shrink-0 items-center gap-1.5">
                <Distance m={entry.distance_m} />
                <StarButton active={isFavourite} onClick={() => onToggleFavourite(entry.id)} />
              </div>
            </div>

            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <AvailabilityChip available={entry.lots_available} total={entry.total_lots} />
              {isLive && <LiveBadge freshness={availabilityFreshness} />}
              {entry.ev && (
                <EvBadge
                  available={entry.ev_available}
                  total={entry.ev_total}
                  maxPowerKw={entry.ev_max_power_kw}
                  freshness={evFreshness}
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

            {/* "Free on Sundays & PH?" is a top decision factor, so it sits
                right under availability rather than at the bottom of the card. */}
            {freeText && <FreeSunPhPill text={freeText} />}

            <div className="mt-2.5 flex flex-wrap items-start gap-1.5">
              {entry.rate.known ? (
                // Some (OneMotoring) rate summaries carry a long parenthetical
                // note, so this badge wraps instead of overflowing the card.
                <Badge
                  variant="secondary"
                  className="max-w-full items-start justify-start gap-1 text-left font-medium whitespace-normal"
                >
                  <Wallet className="mt-px size-3 shrink-0" aria-hidden="true" />
                  <span className="min-w-0">{entry.rate.summary}</span>
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
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between gap-2 border-t border-hairline pt-2.5">
          <span className="min-w-0 truncate text-xs text-muted-foreground">{entry.type || 'Carpark'}</span>
          <div className="flex shrink-0 items-center gap-0.5">
            <ShareButton name={entry.address} lat={entry.lat} lon={entry.lon} />
            <NavLink href={gmapsHref(entry.lat, entry.lon)} label="Maps" icon={Navigation} />
            <NavLink href={wazeHref(entry.lat, entry.lon)} label="Waze" icon={Navigation2} />
          </div>
        </div>
      </div>
    </div>
  )
}

// Memoised: with stable id-based handlers from App, only the two cards whose
// `selected` flips (or whose data/favourite changes) re-render on a selection.
export const CarparkCard = memo(CarparkCardImpl)
