import { Download, Share, X } from 'lucide-react'
import { useInstallPrompt } from '@/useInstallPrompt'

// A slim, dismissible banner nudging install. Renders the real Install button
// on Chrome/Android and a manual "Add to Home Screen" hint on iOS Safari.
// Shows nothing once installed, dismissed, or where install isn't possible.
export function InstallPrompt() {
  const { installed, dismissed, canPromptInstall, showIOSHint, promptInstall, dismiss } =
    useInstallPrompt()

  if (installed || dismissed) return null
  if (!canPromptInstall && !showIOSHint) return null

  return (
    <div className="shrink-0 border-b border-hairline bg-panel px-4 py-2">
      <div className="mx-auto flex w-full max-w-screen-2xl items-center gap-2 text-sm">
        {canPromptInstall ? (
          <>
            <Download className="size-4 shrink-0 text-primary" aria-hidden="true" />
            <span className="min-w-0 flex-1 font-medium text-ink">
              Install EhParkLeh for faster access, even offline.
            </span>
            <button
              type="button"
              onClick={promptInstall}
              className="min-h-11 shrink-0 rounded-full bg-primary px-4 py-1.5 font-display text-sm font-extrabold text-primary-foreground transition-colors hover:bg-kaya-dark"
            >
              Install
            </button>
          </>
        ) : (
          <>
            <Share className="size-4 shrink-0 text-primary" aria-hidden="true" />
            <span className="min-w-0 flex-1 font-medium text-ink">
              Install: tap <span className="font-semibold">Share</span>, then{' '}
              <span className="font-semibold">Add to Home Screen</span>.
            </span>
          </>
        )}
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss install prompt"
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
