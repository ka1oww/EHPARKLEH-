import { cn } from '@/lib/utils'

// The full ERP-gantry lockup from Splash.dc.html: a navy board carrying two
// red restricted-zone triangles, the segmented E·P·L tiles, and the amber
// dot-matrix tagline underneath.
//
// EplMark is the same joke compressed into a header-sized tile; this is the
// version with room to breathe, used on the splash and at the top of the
// desktop sidebar. Drawn in markup rather than as an SVG so the letter tiles
// use the same IBM Plex Mono the rest of the boards do.
//
// The board is a lit sign, so — like the gantry boards — it keeps its navy in
// both themes rather than inverting at night.
//
// Decorative throughout: the splash sets "EhParkLeh" as real text beside it,
// and the sidebar's <h1> carries the name, so a label here would only make a
// screen reader say it twice.

const TILE_FILL = '#0F2547'
const TILE_EDGE = '#3A5688'

type Size = 'sm' | 'lg'

const SIZES = {
  lg: {
    board: 'gap-3.5 rounded-2xl px-[26px] py-[22px]',
    row: 'gap-3',
    tiles: 'gap-[7px]',
    tile: 'rounded-md px-[9px] py-1.5 text-[26px]',
    triangle: { borderLeftWidth: 11, borderRightWidth: 11, borderBottomWidth: 19 },
    tagline: 'text-[14px]',
    shadow: 'shadow-[0_12px_30px_rgba(29,58,107,0.35)]',
  },
  sm: {
    board: 'gap-1.5 rounded-xl px-3.5 py-2.5',
    row: 'gap-2',
    tiles: 'gap-[5px]',
    tile: 'rounded-[5px] px-1.5 py-[3px] text-base',
    triangle: { borderLeftWidth: 7, borderRightWidth: 7, borderBottomWidth: 12 },
    tagline: 'text-[9px]',
    shadow: 'shadow-[0_3px_10px_rgba(29,58,107,0.3)]',
  },
} satisfies Record<Size, unknown>

function Triangle({ size }: { size: Size }) {
  const t = SIZES[size].triangle
  return (
    <span
      aria-hidden="true"
      className="block size-0 border-solid"
      style={{
        borderStyle: 'solid',
        borderColor: 'transparent',
        borderBottomColor: 'var(--bakkwa)',
        borderLeftWidth: t.borderLeftWidth,
        borderRightWidth: t.borderRightWidth,
        borderBottomWidth: t.borderBottomWidth,
        borderTopWidth: 0,
      }}
    />
  )
}

export function GantryLockup({ size = 'lg', className }: { size?: Size; className?: string }) {
  const s = SIZES[size]
  return (
    <div
      aria-hidden="true"
      className={cn(
        'inline-flex flex-col items-center bg-erp-navy',
        s.board,
        s.shadow,
        className,
      )}
    >
      <div className={cn('flex items-center', s.row)}>
        <Triangle size={size} />
        <div className={cn('flex', s.tiles)}>
          {['E', 'P', 'L'].map((letter) => (
            <span
              key={letter}
              className={cn(
                'font-data leading-none font-bold text-white border-[1.5px]',
                s.tile,
              )}
              style={{ background: TILE_FILL, borderColor: TILE_EDGE }}
            >
              {letter}
            </span>
          ))}
        </div>
        <Triangle size={size} />
      </div>
      <span className={cn('dot-matrix text-erp-amber', s.tagline)}>GOT LOT ANOT ??</span>
    </div>
  )
}

// The LED status chip: a green pill light and a mono line, the way a gantry
// board says it is still thinking. The splash wears it while the first search
// runs; the search panel wears the same one while suggestions are in flight,
// because it is the same statement — the app is checking, nothing is wrong.
export function CheckingLotsChip({
  label = 'checking lots…',
  className,
}: {
  label?: string
  className?: string
}) {
  return (
    <span
      className={cn(
        'font-data inline-flex items-center gap-2 rounded-full bg-muted px-4 py-2 text-[13px] font-bold text-ink',
        className,
      )}
    >
      <span className="led-dot-live size-2 shrink-0 rounded-full bg-led-free" aria-hidden="true" />
      {label}
    </span>
  )
}
