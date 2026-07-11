export const LEDGER_PATH = '~/Documents/Nemesis Library/.nemesis/ledger.jsonl'

export interface LedgerEntry {
  ts: string
  action: string
  detail?: string
  area: 'files' | 'study' | 'calendar' | 'email' | 'browse' | 'graph' | 'chat' | 'other'
  wrote?: string[]
  sent?: boolean
  submitted?: boolean
}

export interface LedgerDay {
  dayIso: string
  label: string
  entries: LedgerEntry[]
}

const LEDGER_AREAS: ReadonlySet<LedgerEntry['area']> = new Set([
  'files',
  'study',
  'calendar',
  'email',
  'browse',
  'graph',
  'chat',
  'other'
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseEntry(value: unknown): LedgerEntry | null {
  if (!isRecord(value)) {
    return null
  }

  const { action, area, detail, sent, submitted, ts, wrote } = value

  if (
    typeof ts !== 'string' ||
    !Number.isFinite(Date.parse(ts)) ||
    typeof action !== 'string' ||
    typeof area !== 'string' ||
    !LEDGER_AREAS.has(area as LedgerEntry['area']) ||
    (detail !== undefined && typeof detail !== 'string') ||
    (wrote !== undefined && (!Array.isArray(wrote) || !wrote.every(path => typeof path === 'string'))) ||
    (sent !== undefined && typeof sent !== 'boolean') ||
    (submitted !== undefined && typeof submitted !== 'boolean')
  ) {
    return null
  }

  return {
    action,
    area: area as LedgerEntry['area'],
    ...(detail === undefined ? {} : { detail }),
    ...(sent === undefined ? {} : { sent }),
    ...(submitted === undefined ? {} : { submitted }),
    ts,
    ...(wrote === undefined ? {} : { wrote })
  }
}

/** Parse a JSON Lines ledger defensively. A partially-written or malformed line
 * never hides the valid actions around it. */
export function parseLedger(text: string): LedgerEntry[] {
  const entries: LedgerEntry[] = []

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue
    }

    try {
      const entry = parseEntry(JSON.parse(line) as unknown)

      if (entry) {
        entries.push(entry)
      }
    } catch {
      // JSONL is append-only; tolerate a malformed or half-written line.
    }
  }

  return entries.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, 500)
}

/** Missing bridge/file, read errors, and malformed content all degrade to the
 * valid entries we can recover (or an empty ledger). */
export async function loadLedger(): Promise<LedgerEntry[]> {
  if (typeof window === 'undefined' || !window.hermesDesktop?.readFileText) {
    return []
  }

  try {
    const result = await window.hermesDesktop.readFileText(LEDGER_PATH)

    return parseLedger(result.text)
  } catch {
    return []
  }
}

function localDayIso(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}

export function groupByDay(entries: LedgerEntry[]): LedgerDay[] {
  const now = new Date()
  const todayIso = localDayIso(now)
  const yesterdayIso = localDayIso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
  const groups = new Map<string, LedgerDay>()

  for (const entry of entries) {
    const date = new Date(entry.ts)
    const dayIso = localDayIso(date)

    const label =
      dayIso === todayIso
        ? 'Today'
        : dayIso === yesterdayIso
          ? 'Yesterday'
          : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

    const group = groups.get(dayIso)

    if (group) {
      group.entries.push(entry)
    } else {
      groups.set(dayIso, { dayIso, entries: [entry], label })
    }
  }

  return [...groups.values()]
}

function countLine(verb: 'Sent' | 'Submitted', count: number): string {
  return count === 0 ? `${verb} nothing.` : `${verb} ${count} ${count === 1 ? 'item' : 'items'}.`
}

export function trustLine(entries: LedgerEntry[]): string {
  const sent = entries.filter(entry => entry.sent === true).length
  const submitted = entries.filter(entry => entry.submitted === true).length

  return `${countLine('Sent', sent)} ${countLine('Submitted', submitted)}`
}
