import { useCallback, useEffect, useState } from 'react'

// PWA install affordance. Chrome/Android fire `beforeinstallprompt`, which we
// capture to drive a custom Install button. iOS Safari has no such event, so we
// detect it and surface a manual "Add to Home Screen" hint instead. Both are
// hidden once the app is already running standalone, and dismissal is sticky.

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const DISMISS_KEY = 'ehparkleh:install-dismissed'

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari exposes its own standalone flag.
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  )
}

function isIOS(): boolean {
  const ua = window.navigator.userAgent
  const iPhoneiPad = /iphone|ipad|ipod/i.test(ua)
  // iPadOS 13+ masquerades as macOS; detect it via touch support.
  const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
  return iPhoneiPad || iPadOS
}

function isSafari(): boolean {
  const ua = window.navigator.userAgent
  // Chrome/Firefox/Edge on iOS can't install PWAs, so only real Safari qualifies.
  return /safari/i.test(ua) && !/crios|fxios|edgios|chrome|android/i.test(ua)
}

export function useInstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null)
  const [installed, setInstalled] = useState(isStandalone)
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1'
    } catch {
      return false
    }
  })

  useEffect(() => {
    function onBeforeInstall(e: Event) {
      e.preventDefault() // stop Chrome's default mini-infobar; we prompt on demand
      setDeferred(e as BeforeInstallPromptEvent)
    }
    function onInstalled() {
      setInstalled(true)
      setDeferred(null)
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  const promptInstall = useCallback(async () => {
    if (!deferred) return
    await deferred.prompt()
    try {
      await deferred.userChoice
    } catch {
      /* user dismissed */
    }
    setDeferred(null) // a prompt can only be used once
  }, [deferred])

  const dismiss = useCallback(() => {
    setDismissed(true)
    try {
      localStorage.setItem(DISMISS_KEY, '1')
    } catch {
      /* storage unavailable */
    }
  }, [])

  return {
    installed,
    dismissed,
    // Chrome/Android: a real install prompt is ready.
    canPromptInstall: !!deferred,
    // iOS Safari: no prompt event, so show the manual Share -> Add hint.
    showIOSHint: !installed && !deferred && isIOS() && isSafari(),
    promptInstall,
    dismiss,
  }
}
