// Unified geolocation helper.
//
// On native (Capacitor iOS/Android) builds it uses the @capacitor/geolocation
// plugin, which prompts for OS-level permission and reads the device GPS. On
// the web (PWA / browser) it falls back to navigator.geolocation, so the
// existing web behaviour is preserved exactly.

import { Capacitor } from '@capacitor/core'
import { Geolocation } from '@capacitor/geolocation'
import type { LatLon } from './types'

const POSITION_OPTS = {
  enableHighAccuracy: true,
  timeout: 10000,
  maximumAge: 0,
}

/**
 * Resolve the device's current position as { lat, lon }.
 *
 * Uses the native Capacitor plugin when running inside the iOS/Android wrapper
 * (it handles the runtime permission request), otherwise the browser API.
 * Rejects if location is unavailable or permission is denied, so callers can
 * surface the same error UX in both environments.
 */
export async function getCurrentPosition(): Promise<LatLon> {
  if (Capacitor.isNativePlatform()) {
    // Ask for permission first so the OS prompt fires before the GPS read.
    try {
      const perm = await Geolocation.checkPermissions()
      if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') {
        await Geolocation.requestPermissions()
      }
    } catch {
      // Some platforms throw if permissions are already settled; ignore and
      // let getCurrentPosition surface the real error below.
    }
    const pos = await Geolocation.getCurrentPosition(POSITION_OPTS)
    return { lat: pos.coords.latitude, lon: pos.coords.longitude }
  }

  // Web fallback: identical to the original navigator.geolocation path.
  return new Promise<LatLon>((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation unsupported'))
      return
    }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      err => reject(err),
      POSITION_OPTS,
    )
  })
}
