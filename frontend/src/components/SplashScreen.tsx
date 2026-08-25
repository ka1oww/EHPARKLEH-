import { GantryLockup, CheckingLotsChip } from '@/components/GantryLockup'

/**
 * The opening board, per Splash.dc.html: kaya rules top and bottom, the full
 * ERP-gantry lockup, the name in Baloo 2, and the LED chip saying the app is
 * already checking.
 *
 * It sits over the app rather than replacing it, so the screen underneath is
 * built and ready the moment the first counts land. `aria-hidden` keeps it out
 * of the accessibility tree entirely: a screen reader has no use for a loading
 * curtain, and the list below already announces its own loading state.
 */
export function SplashScreen() {
  return (
    <div
      aria-hidden="true"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-background"
    >
      <span className="absolute inset-x-0 top-0 h-2 bg-primary" />
      <GantryLockup size="lg" />
      <span className="font-display text-[34px] leading-none font-extrabold text-link">
        EhParkLeh
      </span>
      <CheckingLotsChip />
      <span className="absolute inset-x-0 bottom-0 h-2 bg-primary" />
    </div>
  )
}
