// Extends Vitest's `expect` with jest-dom matchers (toBeInTheDocument, etc.).
import '@testing-library/jest-dom/vitest'

// Node 22+ can expose a global `localStorage` that is unavailable without
// --localstorage-file, which shadows jsdom's and breaks `localStorage.clear()`.
// Install a deterministic in-memory Storage on both globals so tests don't
// depend on which localStorage wins.
;(() => {
  const store = new Map<string, string>()
  const storage = {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    removeItem: (k: string) => {
      store.delete(k)
    },
    setItem: (k: string, v: string) => {
      store.set(k, String(v))
    },
  } as Storage
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: storage })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { configurable: true, writable: true, value: storage })
  }
})()

// jsdom doesn't implement matchMedia; stub it so components that read media
// queries (e.g. the install prompt's standalone check) render under test.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList
}
