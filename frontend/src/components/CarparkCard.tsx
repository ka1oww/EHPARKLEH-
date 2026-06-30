import { ArrowUpRight, Navigation, Wallet, Tag, Info } from 'lucide-react'
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

function Distance({ m }: { m: number }) {
  return (
    <span className="font-data shrink-0 text-xs font-bold tabular-nums text-muted-foreground">
      {m}m
    </span>
  )
}

export function CarparkCard({ entry, rank, selected, onSelect }: Props) {
  const base = cn(
    'group w-full cursor-pointer rounded-xl border bg-card p-3.5 text-left shadow-sm transition-all',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
    selected
      ? 'border-signal ring-1 ring-signal shadow-md'
      : 'border-hairline hover:border-slate-300 hover:shadow-md',
  )

  if (entry.source === 'osm') {
    return (
      <button type="button" onClick={onSelect} aria-pressed={selected} className={base}>
        <div className="flex items-start gap-3">
          <span
            className="font-data mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-sm font-bold text-secondary-foreground"
            aria-hidden="true"
          >
            P
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <span className="font-display text-sm font-semibold leading-snug text-ink">
                {entry.name}
              </span>
              <Distance m={entry.distance_m} />
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
          <DirectionsLink lat={entry.lat} lon={entry.lon} />
        </div>
      </button>
    )
  }

  const freeText = parseFreeParking(entry.free_parking_info)

  return (
    <button type="button" onClick={onSelect} aria-pressed={selected} className={base}>
      <div className="flex items-start gap-3">
        <span
          className="font-data mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground tabular-nums"
          aria-hidden="true"
        >
          {rank}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <span className="font-display text-sm font-semibold leading-snug text-ink">
              {entry.address}
            </span>
            <Distance m={entry.distance_m} />
          </div>

          <AvailabilityChip
            available={entry.lots_available}
            total={entry.total_lots}
            className="mt-2.5"
          />

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
        <DirectionsLink lat={entry.lat} lon={entry.lon} />
      </div>
    </button>
  )
}
