import { beforeEach, describe, expect, it } from 'vitest'

import { groupByDay, LEDGER_PATH, type LedgerEntry, loadLedger, parseLedger, trustLine } from './activity-ledger'

function entry(ts: string, action = ts, extra: Partial<LedgerEntry> = {}): LedgerEntry {
  return { action, area: 'other', ts, ...extra }
}

// The suite runs under node (no DOM). loadLedger reads window.hermesDesktop, so give
// the tests a minimal window they can stub and restore.
const globalWithWindow = globalThis as { window?: Window & typeof globalThis }

describe('activity ledger parsing', () => {
  beforeEach(() => {
    globalWithWindow.window = globalWithWindow.window ?? ({} as Window & typeof globalThis)
    ;(window as { hermesDesktop?: unknown }).hermesDesktop = undefined
  })

  it('keeps valid JSON Lines while silently skipping malformed lines and entries', () => {
    const parsed = parseLedger(
      [
        JSON.stringify(entry('2026-07-10T12:00:00Z', 'Kept a valid action')),
        '{not json',
        JSON.stringify({ action: 'Missing required fields' }),
        JSON.stringify(entry('2026-07-10T13:00:00Z', 'Also valid', { wrote: ['~/notes.md'] }))
      ].join('\n')
    )

    expect(parsed.map(item => item.action)).toEqual(['Also valid', 'Kept a valid action'])
  })

  it('loads through the desktop bridge, orders newest first, and returns [] on a missing file', async () => {
    // @ts-expect-error — the ledger only needs this one bridge method.
    window.hermesDesktop = {
      readFileText: async (path: string) => ({
        path,
        text: [entry('2026-07-10T10:00:00Z'), entry('2026-07-10T12:00:00Z')]
          .map(item => JSON.stringify(item))
          .join('\n')
      })
    }

    expect((await loadLedger()).map(item => item.ts)).toEqual(['2026-07-10T12:00:00Z', '2026-07-10T10:00:00Z'])

    // @ts-expect-error — the ledger only needs this one bridge method.
    window.hermesDesktop = { readFileText: async () => Promise.reject(new Error('ENOENT')) }
    expect(await loadLedger()).toEqual([])
    expect(LEDGER_PATH).toBe('~/Documents/Nemesis Library/.nemesis/ledger.jsonl')
  })

  it('caps the newest-first result at 500 entries', () => {
    const lines = Array.from({ length: 510 }, (_, index) =>
      JSON.stringify(entry(new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()))
    )

    const parsed = parseLedger(lines.join('\n'))

    expect(parsed).toHaveLength(500)
    expect(parsed[0].ts).toBe(new Date(Date.UTC(2026, 0, 1, 0, 509)).toISOString())
    expect(parsed.at(-1)?.ts).toBe(new Date(Date.UTC(2026, 0, 1, 0, 10)).toISOString())
  })
})

describe('groupByDay', () => {
  it('groups entries and labels today, yesterday, and older dates', () => {
    const now = new Date()
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12)
    const older = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 3, 12)

    const groups = groupByDay([
      entry(now.toISOString(), 'today one'),
      entry(new Date(now.getTime() - 1_000).toISOString(), 'today two'),
      entry(yesterday.toISOString(), 'yesterday'),
      entry(older.toISOString(), 'older')
    ])

    expect(groups.map(group => group.label).slice(0, 2)).toEqual(['Today', 'Yesterday'])
    expect(groups[0].entries.map(item => item.action)).toEqual(['today one', 'today two'])
    expect(groups[2].dayIso).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(groups[2].label).not.toBe('Today')
  })
})

describe('trustLine', () => {
  it('states inactivity exactly and otherwise reports honest sent/submitted counts', () => {
    expect(trustLine([entry('2026-07-10T12:00:00Z')])).toBe('Sent nothing. Submitted nothing.')
    expect(
      trustLine([
        entry('2026-07-10T12:00:00Z', 'sent', { sent: true }),
        entry('2026-07-10T13:00:00Z', 'both', { sent: true, submitted: true })
      ])
    ).toBe('Sent 2 items. Submitted 1 item.')
  })
})
