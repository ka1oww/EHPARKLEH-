// Extends Vitest's `expect` with jest-dom matchers (toBeInTheDocument, etc.).
import '@testing-library/jest-dom/vitest'

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
