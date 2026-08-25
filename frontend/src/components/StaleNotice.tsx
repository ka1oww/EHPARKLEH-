import { formatLastSeen } from '@/stale'

/**
 * The offline / stale-data board, per Offline.dc.html.
 *
 * It appears when the live feed cannot be reached and there are still saved
 * results on screen — the moment where a parking app is most tempted to keep
 * quiet and let an old number pass for a live one. This says the opposite, out
 * loud, and the counts below it wear a tilde to match.
 */
export function StaleNotice({
  lastSeenAt,
  now,
  onRetry,
  retrying = false,
}: {
  lastSeenAt: number | null
  now?: number
  onRetry: () => void
  retrying?: boolean
}) {
  const ago = formatLastSeen(lastSeenAt, now)

  return (
    <section
      role="status"
      className="flex flex-col items-center gap-4 rounded-lg border-[1.5px] border-hairline bg-card px-6 py-7 text-center"
    >
      <span
        className="flex size-[86px] items-center justify-center rounded-[22px] bg-board"
        aria-hidden="true"
      >
        <span className="font-data text-2xl font-bold tracking-[0.2em] text-led-full">- - -</span>
      </span>
      <h2 className="font-display text-[23px] leading-tight font-extrabold text-ink">
        hais…cannot get signal lah
      </h2>
      <p className="max-w-[300px] text-sm leading-relaxed text-slate-body">
        Can't check live lots right now.{' '}
        {ago ? (
          <>
            Showing what we knew from <b className="font-bold text-ink">{ago}</b> — counts may have
            moved.
          </>
        ) : (
          <>Showing the last counts we saved — they may have moved.</>
        )}
      </p>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="inline-flex h-[50px] w-full items-center justify-center gap-2 rounded-lg bg-primary font-display text-base font-extrabold text-primary-foreground transition-colors hover:bg-kaya-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70"
      >
        {retrying ? 'Trying…' : 'Try again'}
      </button>
    </section>
  )
}

/** The promise the offline screen closes on, kept at the foot of the list. */
export function StaleFootnote() {
  return (
    <p className="rounded-lg bg-muted px-4 py-3 text-center text-xs leading-relaxed text-slate-body">
      Stale counts always say so — we never show an old number as live.
    </p>
  )
}
