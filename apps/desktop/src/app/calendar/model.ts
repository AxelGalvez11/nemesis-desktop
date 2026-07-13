// Calendar page data model: assignment due dates, exams, and rotation dates for a
// pharmacy student. Events live in a JSON file the AGENT writes directly (rotation
// coordinator dates, LMS due dates it reads off Blackboard/Outlook) — the desktop page
// just renders it and lets the student add/correct entries by hand. Same
// agent-writes-a-file-the-page-reads bridge as study/deck-files.ts and the Recorder's
// Library note, just JSON instead of TSV/Markdown.
export type CalendarEventKind = 'assignment' | 'exam' | 'rotation' | 'class' | 'other'

export interface CalendarEvent {
  id: string
  title: string
  /** ISO calendar date, yyyy-mm-dd — no time zone; always read/compared as a LOCAL date. */
  date: string
  time?: string
  kind: CalendarEventKind
  course?: string
  note?: string
  /** 'agent' events are written by Nemesis and read-only in this UI (see saveCalendarEvents
   *  below). Absent or 'manual' = the student's own entry, freely editable. */
  source?: 'agent' | 'manual'
}

export interface CalendarState {
  events: CalendarEvent[]
}

export const CALENDAR_DIR = '~/Documents/Nemesis Library/School'
export const CALENDAR_FILE = `${CALENDAR_DIR}/calendar.json`

const KINDS: ReadonlySet<string> = new Set(['assignment', 'exam', 'rotation', 'class', 'other'])
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

let idCounter = 0

export function freshId(prefix: string): string {
  idCounter += 1

  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`
}

function cleanText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function sanitizeEvent(raw: unknown): CalendarEvent | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }

  const value = raw as Record<string, unknown>
  const id = cleanText(value.id)
  const title = cleanText(value.title)
  const date = typeof value.date === 'string' ? value.date.trim() : ''
  const kind = typeof value.kind === 'string' && KINDS.has(value.kind) ? (value.kind as CalendarEventKind) : null

  if (!id || !title || !DATE_KEY_RE.test(date) || !kind) {
    return null
  }

  const source = value.source === 'agent' || value.source === 'manual' ? value.source : undefined

  return {
    course: cleanText(value.course),
    date,
    id,
    kind,
    note: cleanText(value.note),
    source,
    time: cleanText(value.time),
    title
  }
}

/** Parse calendar.json text into a validated event list. A malformed entry drops just
 *  that entry instead of failing the whole file — an agent's partial write or a typo in a
 *  hand-edited file shouldn't blank the page. */
export function parseCalendarEvents(text: string): CalendarEvent[] {
  try {
    const parsed = JSON.parse(text) as unknown
    const list = parsed && typeof parsed === 'object' ? (parsed as { events?: unknown }).events : undefined

    return Array.isArray(list) ? list.map(sanitizeEvent).filter((event): event is CalendarEvent => event !== null) : []
  } catch {
    return []
  }
}

/** Read the agent-writable calendar file. A missing file, an unavailable desktop bridge,
 *  or malformed JSON all resolve to an empty list — this page must never hard-fail just
 *  because Nemesis hasn't written anything yet. */
export async function loadCalendarState(): Promise<CalendarState> {
  const api = window.hermesDesktop

  if (!api?.readFileText) {
    return { events: [] }
  }

  try {
    const read = await api.readFileText(CALENDAR_FILE)

    return { events: parseCalendarEvents(read.text ?? '') }
  } catch {
    return { events: [] }
  }
}

async function writeCalendarState(state: CalendarState): Promise<void> {
  const api = window.hermesDesktop

  if (!api?.writeTextFile) {
    throw new Error('Saving is unavailable in this build.')
  }

  await api.makeDir?.(CALENDAR_DIR)
  await api.writeTextFile(CALENDAR_FILE, JSON.stringify({ events: state.events }, null, 2))
}

/** Persist a manual add/edit/delete. `localEvents` is the editor's full list with that
 *  change already applied. Agent events are always taken FRESH from disk rather than from
 *  `localEvents` — so a manual save can never clobber an agent write/edit/delete that
 *  happened concurrently, even though the page merged agent events into its own state for
 *  display. Manual events are taken from `localEvents`, which is the student's source of
 *  truth. The UI only lets a student edit/delete their own (non-agent) events. */
export async function saveCalendarEvents(localEvents: CalendarEvent[]): Promise<CalendarState> {
  const disk = await loadCalendarState()
  const agentEvents = disk.events.filter(event => event.source === 'agent')
  const manualEvents = localEvents.filter(event => event.source !== 'agent')
  const next: CalendarState = { events: [...agentEvents, ...manualEvents] }
  await writeCalendarState(next)

  return next
}

// --- Date helpers -------------------------------------------------------------------
// Event `date` fields are plain "yyyy-mm-dd" with no time zone. Always parse/format them
// as LOCAL dates: `new Date("yyyy-mm-dd")` parses as UTC midnight, which renders as the
// PREVIOUS day in any negative UTC-offset timezone — that would put half of the US on the
// wrong day for every event.

export function parseDateKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number)

  return new Date(year, (month || 1) - 1, day || 1)
}

export function dateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}

// --- View-switching date math ---------------------------------------------------------
// Day/Week/Month/Year navigation all step a single `cursor: Date` anchor (see index.tsx).
// Month/year steps clamp the day-of-month into the target month's range instead of
// letting the Date constructor roll over — `new Date(y, 1, 31)` in a non-leap year
// silently becomes March 3, which would turn "next month" from Jan 31 into March.

export function addDays(date: Date, delta: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta)
}

export function addWeeks(date: Date, delta: number): Date {
  return addDays(date, delta * 7)
}

export function addMonths(date: Date, delta: number): Date {
  const first = new Date(date.getFullYear(), date.getMonth() + delta, 1)
  const lastDayOfTarget = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()

  return new Date(first.getFullYear(), first.getMonth(), Math.min(date.getDate(), lastDayOfTarget))
}

export function addYears(date: Date, delta: number): Date {
  return addMonths(date, delta * 12)
}

/** The Sunday that starts `date`'s week — matches monthGrid's Sunday-first layout. */
export function startOfWeek(date: Date): Date {
  return addDays(date, -date.getDay())
}

export interface MonthDay {
  date: Date
  key: string
  inMonth: boolean
  isToday: boolean
}

/** A 6x7 Sunday-first grid covering `month`, padded with adjacent-month days so every
 *  week row is full — the standard month-calendar layout. */
export function monthGrid(year: number, month: number, today: Date): MonthDay[] {
  const first = new Date(year, month, 1)
  const start = new Date(year, month, 1 - first.getDay())
  const todayKey = dateKey(today)
  const days: MonthDay[] = []

  for (let i = 0; i < 42; i++) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
    days.push({ date, inMonth: date.getMonth() === month, isToday: dateKey(date) === todayKey, key: dateKey(date) })
  }

  return days
}

/** 7 consecutive days (Sun–Sat) covering `anchor`'s week — the Week view's columns.
 *  `inMonth` is always true here (the field is meaningless outside the month grid); it's
 *  kept so week days share MonthDay's shape instead of introducing a near-duplicate type. */
export function weekGrid(anchor: Date, today: Date): MonthDay[] {
  const start = startOfWeek(anchor)
  const todayKey = dateKey(today)

  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(start, i)

    return { date, inMonth: true, isToday: dateKey(date) === todayKey, key: dateKey(date) }
  })
}

/** Group events by date key for O(1) lookup while rendering the grid; each day's events
 *  are time-sorted (undated-time events sort first). */
export function eventsByDate(events: CalendarEvent[]): Map<string, CalendarEvent[]> {
  const map = new Map<string, CalendarEvent[]>()

  for (const event of events) {
    const list = map.get(event.date) ?? []
    list.push(event)
    map.set(event.date, list)
  }

  for (const list of map.values()) {
    list.sort((a, b) => (a.time ?? '').localeCompare(b.time ?? ''))
  }

  return map
}

/** Upcoming events from `from` through `from + days`, soonest first — the Agenda list. */
export function upcomingEvents(events: CalendarEvent[], from: Date, days: number): CalendarEvent[] {
  const fromKey = dateKey(from)
  const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + days)
  const toKey = dateKey(to)

  return events
    .filter(event => event.date >= fromKey && event.date <= toKey)
    .sort((a, b) => (a.date === b.date ? (a.time ?? '').localeCompare(b.time ?? '') : a.date.localeCompare(b.date)))
}

/** Events on exactly `date`: timed events first (soonest first), then untimed — the Day
 *  view's timeline order. The opposite of eventsByDate's untimed-first sort, which is
 *  tuned for the month grid's cramped chips instead. */
export function dayEvents(events: CalendarEvent[], date: Date): CalendarEvent[] {
  const key = dateKey(date)
  const onDate = events.filter(event => event.date === key)
  const timed = onDate.filter(event => event.time).sort((a, b) => (a.time ?? '').localeCompare(b.time ?? ''))
  const untimed = onDate.filter(event => !event.time)

  return [...timed, ...untimed]
}
