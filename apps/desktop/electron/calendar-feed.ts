/**
 * Calendar half of phone-sync Phase 2: turns the agent-written School/calendar.json
 * into (a) the encrypted `kind: 'calendar'` library document the phone's in-app
 * agenda reads, and (b) a plaintext ICS feed for the iPhone's built-in Calendar app
 * (owner decision D3 — the ONE scoped plaintext exception: dates + titles only).
 *
 * The event shape mirrors src/app/calendar/model.ts (the renderer owns the file
 * format; this is the main-process re-implementation of its lenient parser, kept
 * in sync by hand like the other electron/src twins). HARD RULE enforced here:
 * `note` fields NEVER enter the ICS output — they stay inside the encrypted doc.
 */

export type CalendarEventKind = 'assignment' | 'class' | 'exam' | 'other' | 'rotation'

export type CalendarFeedEvent = {
  id: string
  title: string
  /** yyyy-mm-dd, no timezone — always treated as a LOCAL date. */
  date: string
  time?: string
  kind: CalendarEventKind
  course?: string
  note?: string
}

const KINDS: ReadonlySet<string> = new Set(['assignment', 'exam', 'rotation', 'class', 'other'])
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/
// Range-checked: a malformed agent-written time ("25:99") falls back to an
// all-day event instead of emitting an invalid DTSTART.
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)/

/** Default event window published to the phone + ICS: a week of history for
 * context, half a year ahead for planning. */
export const WINDOW_PAST_DAYS = 7
export const WINDOW_FUTURE_DAYS = 180

function cleanText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Lenient parse of calendar.json text: malformed entries drop individually,
 * malformed JSON drops the whole list — same posture as the renderer's parser. */
export function parseCalendarFeedEvents(text: string): CalendarFeedEvent[] {
  let list: unknown
  try {
    const parsed = JSON.parse(text) as unknown
    list = parsed && typeof parsed === 'object' ? (parsed as { events?: unknown }).events : undefined
  } catch {
    return []
  }
  if (!Array.isArray(list)) return []

  const out: CalendarFeedEvent[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const value = raw as Record<string, unknown>
    const id = cleanText(value.id)
    const title = cleanText(value.title)
    const date = typeof value.date === 'string' ? value.date.trim() : ''
    const kind = typeof value.kind === 'string' && KINDS.has(value.kind) ? (value.kind as CalendarEventKind) : null
    if (!id || !title || !DATE_KEY_RE.test(date) || !kind) continue
    out.push({
      course: cleanText(value.course),
      date,
      id,
      kind,
      note: cleanText(value.note),
      time: cleanText(value.time),
      title
    })
  }
  return out
}

function localDateKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function shiftedKey(now: Date, deltaDays: number): string {
  return localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + deltaDays))
}

/** The publish window, sorted soonest-first (date, then time). */
export function windowedEvents(events: CalendarFeedEvent[], now: Date): CalendarFeedEvent[] {
  const from = shiftedKey(now, -WINDOW_PAST_DAYS)
  const to = shiftedKey(now, WINDOW_FUTURE_DAYS)
  return events
    .filter(event => event.date >= from && event.date <= to)
    .sort((a, b) => (a.date === b.date ? (a.time ?? '').localeCompare(b.time ?? '') : a.date.localeCompare(b.date)))
}

/** Plaintext content of the encrypted `kind: 'calendar'` library document. The
 * phone renders the agenda from this (notes included — they're ciphertext on
 * the wire); feedUrl lets it offer the native-calendar subscription. */
export function buildCalendarDocContent(
  events: CalendarFeedEvent[],
  feedUrl: null | string,
  asOfIso: string
): string {
  return JSON.stringify({ v: 1, asOf: asOfIso, feedUrl, events })
}

// --- ICS rendering (RFC 5545, the minimal profile calendar apps accept) --------

/** Escape a text value for ICS: backslash, semicolon, comma, and newlines. */
function icsEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
}

/** Fold lines longer than 75 octets (75 chars is close enough for our ASCII-ish
 * summaries; multibyte over-folding is harmless) with CRLF + single space. */
function icsFold(line: string): string {
  if (line.length <= 75) return line
  const parts: string[] = []
  let rest = line
  parts.push(rest.slice(0, 75))
  rest = rest.slice(75)
  while (rest.length > 74) {
    parts.push(` ${rest.slice(0, 74)}`)
    rest = rest.slice(74)
  }
  if (rest) parts.push(` ${rest}`)
  return parts.join('\r\n')
}

function basicDate(dateKey: string): string {
  return dateKey.replace(/-/g, '')
}

function nextDayKey(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  return localDateKey(new Date(y, (m || 1) - 1, (d || 1) + 1))
}

/** UTC basic format for DTSTAMP. */
function utcStamp(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`
}

/**
 * Render the ICS feed. Titles, dates/times, kind + course only — the scoped
 * plaintext exception. `note` is deliberately unread here. Timed events render
 * as FLOATING local times (student's phone and Mac share a timezone; floating
 * avoids VTIMEZONE machinery), untimed events as all-day. `stamp` should be the
 * calendar file's mtime so unchanged data renders byte-identical (the publisher
 * change-detects on the text).
 */
export function renderIcs(events: CalendarFeedEvent[], stamp: Date): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Nemesis//Study Agent//EN',
    'CALSCALE:GREGORIAN',
    'X-WR-CALNAME:Nemesis — School'
  ]
  const dtstamp = utcStamp(stamp)

  for (const event of events) {
    const summary = event.course ? `${event.title} (${event.course})` : event.title
    lines.push('BEGIN:VEVENT')
    lines.push(icsFold(`UID:${icsEscape(event.id)}@nemesis-sync`))
    lines.push(`DTSTAMP:${dtstamp}`)
    lines.push(icsFold(`SUMMARY:${icsEscape(summary)}`))
    lines.push(icsFold(`CATEGORIES:${icsEscape(event.kind)}`))
    const timeMatch = event.time ? TIME_RE.exec(event.time) : null
    if (timeMatch) {
      const hh = timeMatch[1].padStart(2, '0')
      const mm = timeMatch[2]
      lines.push(`DTSTART:${basicDate(event.date)}T${hh}${mm}00`)
      lines.push('DURATION:PT1H')
    } else {
      lines.push(`DTSTART;VALUE=DATE:${basicDate(event.date)}`)
      lines.push(`DTEND;VALUE=DATE:${basicDate(nextDayKey(event.date))}`)
    }
    lines.push('END:VEVENT')
  }

  lines.push('END:VCALENDAR')
  return `${lines.join('\r\n')}\r\n`
}
