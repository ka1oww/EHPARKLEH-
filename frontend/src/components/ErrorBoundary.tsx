import { Component, type ReactNode } from 'react'

import { EplMark } from '@/components/EplMark'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
}

// Catches render/lifecycle errors anywhere below it so an unexpected throw shows
// a friendly, on-brand fallback instead of a blank white screen. Error
// boundaries must be class components, even in React 19.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: unknown) {
    // No analytics backend to report to; surface it for debugging.
    console.error('EhParkLeh hit an unexpected error:', error)
  }

  render() {
    if (!this.state.hasError) return this.props.children

    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-background px-6 text-center">
        {/* The gantry board, larger than the header wears it. Logos take E
            calls for the mark as "a moment" on screens that are otherwise
            empty, and a crash screen is exactly one of those. */}
        <EplMark className="h-12 opacity-90" />
        <div>
          <p className="font-display text-lg font-semibold text-ink">Eh, something broke.</p>
          <p className="mt-1 max-w-xs text-sm text-muted-foreground">
            The app hit an unexpected error. A reload usually sorts it out.
          </p>
        </div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="inline-flex min-h-11 items-center rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Reload
        </button>
      </div>
    )
  }
}
