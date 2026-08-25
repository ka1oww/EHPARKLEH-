import { cn } from '@/lib/utils'

/**
 * The EPL gantry tile: the app's mark, lifted from FiltersHome.dc.html — a navy
 * ERP board carrying a red warning triangle and white monospace letters. The
 * joke is the homage: an ERP gantry charges you, this one tells you where to
 * park.
 *
 * Drawn inline rather than shipped as a file so it inherits the page's font
 * loading and needs no request of its own. The artboards set it on cream; the
 * app's header bar is kaya green, and navy on kaya is barely a contrast at all,
 * so the board takes a cream hairline to separate it from the bar — the same
 * device Logos take D uses to lift a board off a coloured ground.
 *
 * Decorative: the header already carries "EhParkLeh" as its <h1>, so a label
 * here would only make a screen reader say the name twice.
 */
export function EplMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 56 26"
      className={cn('h-7 w-auto shrink-0', className)}
      aria-hidden="true"
      focusable="false"
    >
      <rect
        x="0.75"
        y="0.75"
        width="54.5"
        height="24.5"
        rx="6.25"
        fill="#1D3A6B"
        stroke="#FFF8EA"
        strokeOpacity="0.9"
        strokeWidth="1.5"
      />
      {/* The restricted-zone triangle, solid as the artboard draws it. */}
      <path d="M12 9 17 17 7 17Z" fill="#C8342A" />
      <text
        x="21"
        y="17.4"
        fill="#FFFFFF"
        fontFamily="'IBM Plex Mono', ui-monospace, SFMono-Regular, monospace"
        fontSize="12"
        fontWeight="700"
        letterSpacing="1.2"
      >
        EPL
      </text>
    </svg>
  )
}
