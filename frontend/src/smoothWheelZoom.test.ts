import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import L from 'leaflet'
import SmoothWheelZoom from './smoothWheelZoom'

// The handler is wired to a real Leaflet-shaped surface but driven against a
// fake map + real DOM container, with the rAF loop stepped manually so easing
// behaviour is deterministic. `feel` itself is validated in the browser; these
// tests pin the arithmetic and the wiring that produce the feel.

function makeHarness() {
  const container = document.createElement('div')
  document.body.appendChild(container)

  let zoom = 10
  const zoomCalls: { point: L.Point; zoom: number }[] = []
  const listeners: Record<string, (() => void)[]> = {}
  const map = {
    options: {} as Record<string, unknown>,
    getContainer: () => container,
    getZoom: () => zoom,
    getMinZoom: () => 2,
    getMaxZoom: () => 20,
    mouseEventToContainerPoint: (e: WheelEvent) =>
      new L.Point(e.clientX, e.clientY),
    setZoomAround: vi.fn((point: L.Point, z: number) => {
      zoomCalls.push({ point, zoom: z })
      zoom = z
    }),
    on: (name: string, fn: () => void) => {
      ;(listeners[name] ??= []).push(fn)
    },
    off: (name: string, fn: () => void) => {
      listeners[name] = (listeners[name] ?? []).filter((f) => f !== fn)
    },
    _stop: vi.fn(),
    fire: (name: string) => {
      for (const fn of listeners[name] ?? []) fn()
    },
  }
  // The handler only needs Leaflet's Handler contract (`_map`).
  const handler = new SmoothWheelZoom(map as unknown as L.Map)

  // Manual rAF queue: tests decide when frames run and at what timestamp.
  let queued: ((ts: number) => void) | null = null
  vi.spyOn(L.Util, 'requestAnimFrame').mockImplementation(
    // Preserve Leaflet's contract: fn is bound to context when given.
    ((fn: (ts: number) => void, context?: unknown) => {
      queued = context ? fn.bind(context) : fn
      return 1
    }) as typeof L.Util.requestAnimFrame,
  )
  vi.spyOn(L.Util, 'cancelAnimFrame').mockImplementation(() => {})

  const wheel = (deltaY: number, x = 50, y = 40) => {
    container.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY,
        deltaX: 0,
        deltaMode: 0,
        clientX: x,
        clientY: y,
        bubbles: true,
        cancelable: true,
      }),
    )
  }

  return {
    handler,
    map,
    zoomCalls,
    wheel,
    hasPendingFrame: () => queued !== null,
    runFrame: (ts: number) => {
      const fn = queued
      queued = null
      fn?.(ts)
    },
  }
}

describe('SmoothWheelZoom', () => {
  let harness: ReturnType<typeof makeHarness>

  beforeEach(() => {
    harness = makeHarness()
    harness.handler.enable()
    harness.map.options.smoothWheelZoom = true
    harness.map.options.wheelPxPerZoomLevel = 140
  })

  afterEach(() => {
    harness.handler.disable()
    document.body.textContent = ''
    vi.restoreAllMocks()
  })

  // Requirement: the wheel must never scroll the page - the handler swallows
  // every wheel event over the map, even before any zooming happens.
  it('preventDefaults wheel events so the page never scrolls', () => {
    const prevented = [] as boolean[]
    harness.map.getContainer().addEventListener('wheel', (e) => {
      prevented.push(e.defaultPrevented)
    })
    harness.wheel(-100)
    expect(prevented).toEqual([true])
  })

  // Frames ease asymptotically; keep stepping until the loop settles itself.
  const settle = () => {
    let ts = 16
    while (harness.hasPendingFrame() && ts < 60_000) {
      harness.runFrame(ts)
      ts += 40
    }
  }

  it('accumulates fractional targets without rounding to snap levels', () => {
    // Two modest notches: worth far less than one level together.
    harness.wheel(-100)
    harness.runFrame(16)
    harness.wheel(-100)
    settle()

    // Total target = normalised deltas / pxPerLevel, un-rounded.
    const d = L.DomEvent.getWheelDelta(
      new WheelEvent('wheel', { deltaY: -100, deltaMode: 0 }),
    )
    expect(harness.map.getZoom()).toBeCloseTo(10 + (2 * d) / 140, 5)
  })

  it('eases toward the target over successive frames instead of snapping', () => {
    // deltaY < 0 scrolls up = zoom in. Three levels' worth of normalised delta
    // (jsdom's wheelPxFactor halves the raw delta).
    harness.wheel(-140 * 3 * 2)

    harness.runFrame(32)
    const afterOneFrame = harness.map.getZoom()
    // Partway there after a single frame - gliding, not snapping.
    expect(afterOneFrame).toBeGreaterThan(10)
    expect(afterOneFrame).toBeLessThan(13)

    settle()
    expect(harness.map.getZoom()).toBeCloseTo(13, 2)
    expect(harness.hasPendingFrame()).toBe(false)
  })

  it('zooms around the cursor, tracking the most recent position', () => {
    harness.wheel(-100, 30, 20)
    harness.runFrame(16)
    harness.wheel(-100, 90, 70)

    settle()
    expect(harness.zoomCalls.at(-1)?.point.x).toBe(90)
    expect(harness.zoomCalls.at(-1)?.point.y).toBe(70)
  })

  it('clamps the accumulated target to the map limits', () => {
    harness.wheel(-140 * 999 * 2)
    settle()
    expect(harness.map.getZoom()).toBeCloseTo(20, 5)

    harness.wheel(140 * 999 * 2)
    settle()
    expect(harness.map.getZoom()).toBeCloseTo(2, 5)
  })

  it('cancels the glide when the driver starts dragging', () => {
    harness.wheel(-140 * 3)
    harness.runFrame(16)
    const afterFirstFrame = harness.map.getZoom()

    harness.map.fire('dragstart')
    harness.runFrame(400)

    expect(harness.map.getZoom()).toBe(afterFirstFrame)
    expect(harness.hasPendingFrame()).toBe(false)
  })

  // Leaflet's _limitZoom rounds every setZoom to the nearest zoomSnap step;
  // if the glide ran with the app's 0.25 snap it would staircase instead of
  // easing. The handler must suspend snap mid-glide and put it back after.
  it('suspends zoomSnap while gliding and restores it afterwards', () => {
    harness.map.options.zoomSnap = 0.25

    harness.wheel(-100)
    harness.runFrame(16)
    expect(harness.map.options.zoomSnap).toBe(0)

    settle()
    expect(harness.map.options.zoomSnap).toBe(0.25)

    // Same on the abort path.
    harness.wheel(-100)
    harness.runFrame(16)
    expect(harness.map.options.zoomSnap).toBe(0)
    harness.map.fire('dragstart')
    expect(harness.map.options.zoomSnap).toBe(0.25)
  })

  it('ignores wheel events when disabled', () => {
    harness.handler.disable()
    harness.handler.enable()
    harness.map.options.smoothWheelZoom = false
    harness.wheel(-100)
    expect(harness.hasPendingFrame()).toBe(false)
    expect(harness.map.getZoom()).toBe(10)
  })
})
