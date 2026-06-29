// Parse raw LTA/HDB free-parking strings into friendly plain English.
//
// Examples seen in the dataset:
//   "SUN & PH FR 7AM-10.30PM"     -> "Free on Sundays & public holidays, 7am to 10.30pm"
//   "SUN & PH FR 1PM-10.30PM"     -> "Free on Sundays & public holidays, 1pm to 10.30pm"
//   "NO"                          -> not free (handled by caller)
//
// The parser is deliberately forgiving: anything it cannot confidently parse
// is returned title-cased rather than dropped, so we never hide real info.

/** Returns true when a free-parking string actually means "this is free sometimes". */
export function isFree(raw: string | null | undefined): boolean {
  if (!raw) return false
  return raw.trim().toUpperCase() !== 'NO'
}

// "7AM" -> "7am", "10.30PM" -> "10.30pm", "1230PM" -> "12.30pm"
function prettyTime(token: string): string {
  const m = token.trim().toUpperCase().match(/^(\d{1,2})(?:[.:]?(\d{2}))?\s*(AM|PM)$/)
  if (!m) return token.trim().toLowerCase()
  const hour = m[1]
  const mins = m[2]
  const ampm = m[3].toLowerCase()
  return mins ? `${hour}.${mins}${ampm}` : `${hour}${ampm}`
}

const DAY_PHRASES: Record<string, string> = {
  'SUN & PH': 'Sundays & public holidays',
  'SUN&PH': 'Sundays & public holidays',
  'SUN': 'Sundays',
  'SAT': 'Saturdays',
  'SAT & SUN': 'Saturdays & Sundays',
  'PH': 'public holidays',
  'DAILY': 'every day',
}

/**
 * Parse a free-parking string into one friendly sentence.
 * Returns null when the carpark is not free at all.
 */
export function parseFreeParking(raw: string | null | undefined): string | null {
  if (!isFree(raw)) return null
  const text = raw!.trim().toUpperCase()

  // Shape: "<DAYS> FR <START>-<END>"  (FR = "free")
  const m = text.match(/^(.+?)\s+FR\s+([\d.:]+\s*[AP]M)\s*[-–]\s*([\d.:]+\s*[AP]M)$/)
  if (m) {
    const daysKey = m[1].trim()
    const days = DAY_PHRASES[daysKey] ?? toTitle(daysKey)
    const start = prettyTime(m[2])
    const end = prettyTime(m[3])
    return `Free on ${days}, ${start} to ${end}`
  }

  // Days only, no time window.
  if (DAY_PHRASES[text]) {
    return `Free on ${DAY_PHRASES[text]}`
  }

  // Fallback: surface the raw info, just gently cleaned up.
  return `Free: ${toTitle(text)}`
}

function toTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(\w)/g, c => c.toUpperCase())
    .replace(/\bPh\b/g, 'PH')
    .replace(/\bFr\b/g, '')
    .trim()
}
