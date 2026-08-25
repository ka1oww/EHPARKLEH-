// What the filter eyebrow says is in force.
//
// FiltersHome.dc.html writes a single line — "SHOWING EV CHARGING ONLY" — with
// a red Clear beside it. The app can hold more than one filter at a time, so
// the label has to name all of them rather than pick one and quietly lie about
// the rest.

export interface ActiveFilters {
  category: string | null
  freeSunPh: boolean
  hasLots: boolean
  hasEv: boolean
  hasCarwash: boolean
}

/** The active filters, in chip order, or null when nothing is filtered. */
export function activeFilterLabels(f: ActiveFilters): string[] {
  const labels: string[] = []
  if (f.category) labels.push(f.category)
  if (f.freeSunPh) labels.push('free Sun & PH')
  if (f.hasLots) labels.push('has lots')
  if (f.hasEv) labels.push('EV charging')
  if (f.hasCarwash) labels.push('car wash')
  return labels
}

/** "EV charging", or "HDB + EV charging" when several are on. */
export function activeFilterLabel(f: ActiveFilters): string | null {
  const labels = activeFilterLabels(f)
  return labels.length > 0 ? labels.join(' + ') : null
}
