import { describe, it, expect } from 'vitest'
import { activeFilterLabel } from './filterLabel'

const none = {
  category: null,
  freeSunPh: false,
  hasLots: false,
  hasEv: false,
  hasCarwash: false,
}

describe('activeFilterLabel', () => {
  it('is null when nothing is filtered, so no eyebrow is shown', () => {
    expect(activeFilterLabel(none)).toBeNull()
  })

  it('names the single active filter', () => {
    expect(activeFilterLabel({ ...none, hasEv: true })).toBe('EV charging')
    expect(activeFilterLabel({ ...none, category: 'HDB' })).toBe('HDB')
  })

  it('names every active filter, in chip order, rather than only the first', () => {
    expect(activeFilterLabel({ ...none, category: 'HDB', hasEv: true, hasCarwash: true })).toBe(
      'HDB + EV charging + car wash',
    )
  })
})
