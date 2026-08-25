import { memo, useState } from 'react'
import { Navigation2, Wallet, Info, Star, Share2, Zap, Droplets, ArrowRight, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { AvailabilityChip } from '@/components/AvailabilityChip'
import { GantryHero, ErpStrip } from '@/components/GantryHero'
import { freeParkingHeadline, parseFreeParking } from '@/rules'
import { isFullHouse } from '@/lots'
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
  /**
   * The live feed could not be reached, so every count on this card is one we
   * last saw rather than one we can vouch for. Writes them `~060`.
   */
  stale?: boolean
}

function gmapsHref(lat: number, lon: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`
}

// Waze universal deep link: opens the Waze app (or web) and starts navigation
// to the coordinates. navigate=yes routes immediately.
function wazeHref(lat: number, lon: number): string {
  return `https://www.waze.com/ul?ll=${lat},${lon}&navigate=yes`
}

// Distance switches to km past 1000m for glanceability.
function fmtDistance(m: number): string {
  return m >= 1000
    ? `${new Intl.NumberFormat('en-SG', { maximumFractionDigits: 1 }).format(m / 1000)} km`
    : `${m} m`
}

// The go-action, in the app's own voice. It is a Google Maps deep link like it
// always was; only what it says changed. Opens in a new tab; its click is kept
// off the card's stretched select button. The component is named for what it
// does rather than what it says, because the copy is the captain's to change.
//
// The reskin left it the one destination on the card that never names itself,
// sitting next to a link that plainly says "Waze" — so drivers read the Google
// link as gone. The eyebrow under the copy names the destination, and the
// accessible name says it too, without touching the captain's wording.
function NavigateCta({ lat, lon }: { lat: number; lon: number }) {
  return (
    <a
      href={gmapsHref(lat, lon)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Confirm ah — navigate with Google Maps"
      onClick={(e) => e.stopPropagation()}
      className="pointer-events-auto inline-flex min-h-11 flex-col items-center justify-center rounded-md bg-primary px-3 py-1 font-display text-sm leading-tight font-extrabold text-primary-foreground transition-colors hover:bg-kaya-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <span className="inline-flex items-center gap-1.5">
        Confirm ah
        <ArrowRight className="size-4" aria-hidden="true" />
      </span>
      <span className="text-[9px] font-bold tracking-[0.12em] opacity-85" aria-hidden="true">
        GOOGLE MAPS
      </span>
    </a>
  )
}

// A secondary navigation deep-link.
function NavLink({ href, label, icon: Icon }: { href: string; label: string; icon: LucideIcon }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="pointer-events-auto inline-flex min-h-11 items-center gap-1 rounded-md px-2.5 py-2 text-xs font-bold text-link transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
      className="pointer-events-auto inline-flex min-h-11 items-center gap-1 rounded-md px-2.5 py-2 text-xs font-bold text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
        active ? 'text-kopi' : 'text-muted-foreground/60 hover:text-kopi',
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
            ? 'bg-kopi/15 text-panel-ink'
            : 'bg-muted text-muted-foreground',
      )}
    >
      <span
        className={cn(
          'size-1.5 rounded-full',
          freshness === 'fresh'
            ? 'led-dot-live bg-avail-free'
            : freshness === 'recent'
              ? 'bg-kopi'
              : 'bg-avail-none',
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
        free ? 'bg-avail-free/12 text-avail-free' : 'bg-kopi/15 text-panel-ink',
      )}
    >
      <Zap className="size-3" aria-hidden="true" />
      {label}
      {fast && ' · fast'}
    </span>
  )
}

function Distance({ m }: { m: number }) {
  return <span className="font-data shrink-0 tabular-nums">{fmtDistance(m)}</span>
}

// The category, as the small caps pill the signboards use: biscuit for the
// public estate carparks, a red-tinted one for the malls.
function CategoryPill({ category }: { category: string }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-[5px] px-2 py-0.5 text-[10px] font-extrabold tracking-[0.05em] uppercase',
        category === 'Mall'
          ? 'bg-bakkwa/12 text-bakkwa'
          : 'bg-panel text-panel-ink',
      )}
    >
      {category}
    </span>
  )
}

function FreeSunPhPill({ text }: { text: string }) {
  return (
    <div className="mt-2 inline-flex max-w-full items-start gap-1.5 rounded-md bg-avail-free/10 px-2 py-1 text-xs font-semibold text-avail-free">
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
  stale = false,
}: Props) {
  // A stretched, transparent <button> (behind the content) is the select action:
  // it is keyboard-focusable and screen-reader-labelled, and the content layer is
  // pointer-events-none so a tap anywhere falls through to it, while the star /
  // share / directions controls (pointer-events-auto) capture their own taps.
  // This keeps the interactive controls OUT of the button, unlike a role="button"
  // wrapper, which is invalid when it nests other buttons.
  const title = entry.source === 'osm' ? entry.name : entry.address
  // A carpark with nothing left fades back, the way a full board is one you
  // stop reading. It is still selectable, shareable and navigable.
  const full = entry.source === 'hdb' && isFullHouse(entry.lots_available)
  const container = cn(
    'group relative w-full rounded-lg border-[1.5px] bg-card p-3.5 text-left shadow-sm transition-all',
    selected
      ? 'border-primary ring-1 ring-primary shadow-md'
      : 'border-hairline hover:border-primary/40 hover:shadow-md',
  )
  const selectButton = (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`Show ${title} on map`}
      onClick={() => onSelect(entry.id)}
      className="absolute inset-0 z-[1] cursor-pointer rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    />
  )

  if (entry.source === 'osm') {
    return (
      <div className={container}>
        {selectButton}
        <div className="pointer-events-none relative z-[2]">
          <div className="flex items-start gap-3">
            <span
              className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-panel font-display text-sm font-extrabold text-panel-ink"
              aria-hidden="true"
            >
              P
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-1.5">
                <span className="min-w-0 text-[15px] leading-snug font-extrabold break-words text-ink">
                  {entry.name}
                </span>
                <StarButton active={isFavourite} onClick={() => onToggleFavourite(entry.id)} />
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-body">
                <Distance m={entry.distance_m} />
                {entry.fee === 'no' && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="font-semibold text-avail-free">Free</span>
                  </>
                )}
                {entry.parking_type && <CategoryPill category={entry.parking_type} />}
              </div>
              {/* An OSM pin has no feed behind it, so the card says so where the
                  board would otherwise be — in the meta line, which wraps,
                  rather than in the go-row, which truncates. */}
              <span className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <Info className="size-3.5 shrink-0" aria-hidden="true" />
                No live info
              </span>
            </div>
          </div>
          <div className="mt-3 flex items-center justify-end gap-2 border-t border-hairline pt-2.5">
            <div className="flex shrink-0 items-center gap-1">
              <ShareButton name={entry.name} lat={entry.lat} lon={entry.lon} />
              <NavLink href={wazeHref(entry.lat, entry.lon)} label="Waze" icon={Navigation2} />
              <NavigateCta lat={entry.lat} lon={entry.lon} />
            </div>
          </div>
        </div>
      </div>
    )
  }

  const freeText = parseFreeParking(entry.free_parking_info)
  // The dot-matrix strip is a moment, not chrome: it lights up only for a
  // carpark that is genuinely free at some point, and only on the selected
  // card, which is the screen that is about this one carpark.
  const erpHeadline = selected ? freeParkingHeadline(entry.free_parking_info) : null
  const isLive = entry.lots_available !== null

  return (
    <div className={container}>
      {selectButton}
      <div className={cn('pointer-events-none relative z-[2]', full && 'opacity-60')}>
        <div className="flex items-start gap-3">
          <span
            className="font-data mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground tabular-nums"
            aria-hidden="true"
          >
            {rank}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <span className="min-w-0 text-[15px] leading-snug font-extrabold break-words text-ink">
                {entry.address}
              </span>
              <div className="flex shrink-0 items-center gap-1.5">
                <AvailabilityChip
                  available={entry.lots_available}
                  total={entry.total_lots}
                  variant="plain"
                  showLabel={false}
                  stale={stale}
                />
                <StarButton active={isFavourite} onClick={() => onToggleFavourite(entry.id)} />
              </div>
            </div>

            {/* The board shows lots free; the denominator it drops for
                glanceability still belongs on the card, so it sits here. */}
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-body">
              <Distance m={entry.distance_m} />
              {entry.rate.known && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="min-w-0">{entry.rate.summary}</span>
                </>
              )}
              {entry.total_lots !== null && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-data tabular-nums">{entry.total_lots} lots</span>
                </>
              )}
              {entry.type && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{entry.type}</span>
                </>
              )}
              {entry.category && <CategoryPill category={entry.category} />}
            </div>

            {/* The board, at full size, for the carpark the screen is about. */}
            {selected && (
              <div className="mt-3 flex flex-col gap-2">
                <GantryHero
                  available={entry.lots_available}
                  total={entry.total_lots}
                  freshness={availabilityFreshness}
                  note={entry.type}
                  stale={stale}
                />
                {erpHeadline && <ErpStrip text={erpHeadline} />}
              </div>
            )}

            {/* The hero already carries the count's freshness in its eyebrow,
                so the badge would only say it twice on the selected card. */}
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              {isLive && !selected && <LiveBadge freshness={availabilityFreshness} />}
              {entry.ev && (
                <EvBadge
                  available={entry.ev_available}
                  total={entry.ev_total}
                  maxPowerKw={entry.ev_max_power_kw}
                  freshness={evFreshness}
                />
              )}
              {entry.carwash && (
                <span className="inline-flex items-center gap-1 rounded-full bg-erp-chip px-2 py-0.5 text-xs font-semibold text-erp-chip-ink">
                  <Droplets className="size-3" aria-hidden="true" />
                  {entry.carwash_operator && entry.carwash_operator !== 'Self-service'
                    ? entry.carwash_operator
                    : 'Car wash'}
                </span>
              )}
              {!entry.rate.known && (
                <Badge variant="outline" className="gap-1 font-normal text-muted-foreground">
                  <Wallet className="size-3" aria-hidden="true" />
                  Rate unknown
                </Badge>
              )}
            </div>

            {/* "Free on Sundays & PH?" is a top decision factor, so it sits
                right under availability rather than at the bottom of the card.
                On the selected card the ERP strip is already saying it, in the
                shorter form, so the pill stands down rather than repeating it —
                the strip earns its place by being the only voice on the fact. */}
            {freeText && !erpHeadline && <FreeSunPhPill text={freeText} />}
          </div>
        </div>

        {/* The go-row. The carpark type used to sit here, but "Confirm ah" is a
            wide enough action that the label only ever truncated; it reads in
            full on the meta line above instead. */}
        <div className="mt-3 flex items-center justify-end gap-2 border-t border-hairline pt-2.5">
          <div className="flex shrink-0 items-center gap-1">
            <ShareButton name={entry.address} lat={entry.lat} lon={entry.lon} />
            <NavLink href={wazeHref(entry.lat, entry.lon)} label="Waze" icon={Navigation2} />
            <NavigateCta lat={entry.lat} lon={entry.lon} />
          </div>
        </div>
      </div>
    </div>
  )
}

// Memoised: with stable id-based handlers from App, only the two cards whose
// `selected` flips (or whose data/favourite changes) re-render on a selection.
export const CarparkCard = memo(CarparkCardImpl)
