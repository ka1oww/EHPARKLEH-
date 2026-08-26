import L from 'leaflet'

// Google-Maps-style wheel zoom, replacing Leaflet's debounced ScrollWheelZoom
// on this map instance (registered under the same handler name, so
// map.scrollWheelZoom.enable()/disable() keeps working for callers).
//
// What was wrong with the built-in path: it batches wheel deltas and waits out
// wheelDebounceTime before applying ONE zoom step per batch, rounded UP to the
// next zoomSnap multiple (`Math.ceil(d3 / snap) * snap`). On a desktop mouse
// that meant ~100ms of dead latency per gesture and abrupt multi-quarter-level
// snaps - nothing moved while the wheel was spinning, then the view lurched.
// Google Maps instead starts moving within a frame and glides.
//
// How this handler works: every wheel event adds its delta to a fractional
// target-zoom accumulator (clamped to the map's limits) anchored at the cursor,
// and a requestAnimationFrame loop eases the map's zoom toward that target -
// so zooming is fine-grained (no rounding), continuous through the whole
// gesture, and animated by construction. The anchor point tracks the cursor,
// which is what keeps Google's "zoom towards where I'm pointing" feel.
//
// Touch is untouched: only `wheel` is observed, so pinch zoom, drag pan and
// everything else on mobile keep their stock Leaflet behaviour. Drag pan also
// keeps its built-in inertia; this handler cancels itself on `dragstart` so a
// mid-gesture grab never fights the easing loop, and likewise on any view
// change it did not cause itself (fitBounds after a refetch, zoomToShowLayer
// on selection, a programmatic setView/flyTo) so the glide never overwrites
// one - its own per-frame setZoomAround is flagged so it cannot self-cancel.

// Time constant of the ease-out glide. ~90ms reads as "instant but smooth",
// which is the Google Maps web feel; larger values lag, smaller ones snap.
const SMOOTH_TAU_MS = 90

// Close enough to the target to stop animating (fractions of a zoom level).
const SETTLE_EPSILON_LEVELS = 0.002

export interface SmoothWheelMapOptions extends L.MapOptions {
  // Master switch consulted by the handler; mirrors the handler name so
  // Leaflet-style option wiring stays possible.
  smoothWheelZoom?: boolean
}

class SmoothWheelZoom extends L.Handler {
  // Leaflet's Handler keeps the map on the underscore-private `_map`; one
  // typed alias instead of sprinkling casts through every method.
  private readonly map: L.Map

  constructor(map: L.Map) {
    super(map)
    this.map = map
  }

  private target: number | null = null
  private pos: L.Point | null = null
  private rafId = 0
  private lastTs = 0
  private savedSnap: number | undefined = undefined
  private internalMove = false

  private readonly onWheel = (e: WheelEvent): void => {
    // Never let the page scroll/zoom because a gesture landed on the map.
    L.DomEvent.stop(e)
    const opts = this.map.options as SmoothWheelMapOptions
    if (!opts.smoothWheelZoom) return
    const delta = L.DomEvent.getWheelDelta(e)
    if (!delta) return
    this.pos = this.map.mouseEventToContainerPoint(e)
    // Linear mapping: pixels of wheel delta per level of zoom. Deliberately
    // not Leaflet's sigmoid - a notch should always be worth the same small
    // fraction of a level, exactly as much as was accumulated, nothing more.
    const pxPerLevel = opts.wheelPxPerZoomLevel ?? 140
    const base = this.target ?? this.map.getZoom()
    this.target = Math.min(
      this.map.getMaxZoom(),
      Math.max(this.map.getMinZoom(), base + delta / pxPerLevel),
    )
    if (!this.rafId) {
      // Stop any in-flight pan/fly animation so the easing loop owns the view.
      ;(this.map as unknown as { _stop: () => void })._stop()
      // zoomSnap is suspended for the glide, but only while one of the
      // handler's own setZoomAround calls is on the stack (see applyZoom):
      // _limitZoom would otherwise round every eased intermediate to the
      // nearest snap step, turning the glide back into a staircase of coarse
      // jumps. Leaving the gaps between frames alone means a concurrent
      // fitBounds/setView still reads the app's real snap.
      this.savedSnap = opts.zoomSnap
      this.lastTs = 0
      this.rafId = L.Util.requestAnimFrame(this.frame, this)
    }
  }

  private readonly onDragStart = (): void => {
    // A grab during the glide hands control back to the driver immediately.
    this.cancel()
  }

  private readonly onExternalMove = (): void => {
    // Fires for every view change, including this handler's own eased frames -
    // only the ones originating elsewhere abort the glide.
    if (this.internalMove) return
    this.cancel()
  }

  // Leaflet's DomEvent listener type is the generic EventHandlerFn (Event);
  // narrow to WheelEvent at this one boundary.
  private readonly domOnWheel = (e: Event): void => {
    this.onWheel(e as WheelEvent)
  }

  addHooks(): void {
    L.DomEvent.on(this.map.getContainer(), 'wheel', this.domOnWheel)
    this.map.on('dragstart', this.onDragStart)
    this.map.on('movestart', this.onExternalMove)
    this.map.on('zoomstart', this.onExternalMove)
  }

  removeHooks(): void {
    this.cancel()
    L.DomEvent.off(this.map.getContainer(), 'wheel', this.domOnWheel)
    this.map.off('dragstart', this.onDragStart)
    this.map.off('movestart', this.onExternalMove)
    this.map.off('zoomstart', this.onExternalMove)
  }

  private cancel(): void {
    if (this.rafId) {
      L.Util.cancelAnimFrame(this.rafId)
      this.rafId = 0
    }
    this.restoreSnap()
    this.target = null
  }

  // The only place the glide writes the view: zoomSnap is dropped and put back
  // around the call itself, and `internalMove` marks the movestart/zoomstart it
  // fires as this handler's own.
  private applyZoom(point: L.Point, next: number): void {
    const opts = this.map.options as SmoothWheelMapOptions
    const snap = opts.zoomSnap
    this.internalMove = true
    opts.zoomSnap = 0
    try {
      this.map.setZoomAround(point, next, { animate: false })
    } finally {
      opts.zoomSnap = snap
      this.internalMove = false
    }
  }

  private restoreSnap(): void {
    if (this.savedSnap !== undefined) {
      ;(this.map.options as SmoothWheelMapOptions).zoomSnap = this.savedSnap
      this.savedSnap = undefined
    }
  }

  private frame(ts: number): void {
    const map = this.map
    if (this.target === null || !this.pos) {
      this.rafId = 0
      return
    }
    // First frame of a glide gets a nominal 16ms step so the zoom starts
    // moving immediately; later frames use their real elapsed time.
    const dt = this.lastTs ? Math.min(ts - this.lastTs, 100) : 16
    this.lastTs = ts

    const current = map.getZoom()
    const remaining = this.target - current
    // Exponential ease-out: fast attack, short glide, like Google Maps.
    const step = remaining * (1 - Math.exp(-dt / SMOOTH_TAU_MS))
    let next = current + step
    if (Math.abs(this.target - next) < SETTLE_EPSILON_LEVELS) next = this.target

    this.applyZoom(this.pos, next)
    // An external view change during that call cancels the glide; nothing
    // further to schedule.
    if (this.rafId === 0) return

    if (next === this.target) {
      this.rafId = 0
      this.target = null
      this.restoreSnap()
    } else {
      this.rafId = L.Util.requestAnimFrame(this.frame, this)
    }
  }
}

export default SmoothWheelZoom
