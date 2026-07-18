// Publisher policy tests, all through injected fakes (mission-dispatcher.test.ts
// style): change detection, the 5s quiet rule, the size cap, tombstones, batch
// splitting, state-only-advances-on-2xx, and the vault walker's exclusions.
import test from 'node:test'
import assert from 'node:assert/strict'
import { gcm } from '@noble/ciphers/aes'
import { bytesToUtf8, utf8ToBytes } from '@noble/ciphers/utils'
import { generateVaultKey } from './library-crypto'
import {
  createLibraryPublisher,
  emptyPublisherState,
  walkVaultMarkdown,
  MAX_DOC_BYTES,
  type DerivedDocEntry,
  type LibraryPublisherDeps,
  type PublisherState,
  type VaultFileEntry
} from './library-publisher'

const NOW = 1_800_000_000_000
const TOKEN = `h.${Buffer.from(JSON.stringify({ sub: 'user-1' })).toString('base64')}.s`

type Call = { url: string; rows: Record<string, unknown>[] }

// The E2EE and readable-copy pipelines share one fetchImpl, so most tests that
// care about one pipeline's call shape/count filter to it by URL (same idiom
// as `feedCalls` further down for calendar_feeds).
const e2eeCalls = (calls: Call[]) => calls.filter(c => c.url.includes('/rest/v1/library_documents?'))
const readableCalls = (calls: Call[]) => calls.filter(c => c.url.includes('/rest/v1/readable_library_documents?'))

function makeHarness(overrides?: Partial<LibraryPublisherDeps>) {
  const key = generateVaultKey()
  const calls: Call[] = []
  const logs: string[] = []
  let failNext = 0
  let failUrlSubstring: string | null = null
  let failUrlCount = 0
  const vault = new Map<string, { content: string; mtimeMs: number }>()
  let state: PublisherState | null = null

  const deps: LibraryPublisherDeps = {
    supabaseUrl: 'https://sb.example',
    anonKey: 'anon',
    getAccessToken: async () => TOKEN,
    getVaultKey: async () => key,
    listVaultFiles: async () =>
      [...vault.entries()].map(([relPath, f]) => ({
        relPath,
        mtimeMs: f.mtimeMs,
        size: Buffer.byteLength(f.content, 'utf8')
      })),
    readFileText: async relPath => {
      const f = vault.get(relPath)
      if (!f) throw new Error(`missing ${relPath}`)
      return f.content
    },
    loadState: async () => state,
    saveState: async next => {
      state = next
    },
    now: () => NOW,
    fetchImpl: (async (url: string, init?: RequestInit) => {
      if (failUrlSubstring && failUrlCount > 0 && String(url).includes(failUrlSubstring)) {
        failUrlCount -= 1
        return { ok: false, status: 500, text: async () => '' } as unknown as Response
      }
      if (failNext > 0) {
        failNext -= 1
        return { ok: false, status: 500, text: async () => '' } as unknown as Response
      }
      calls.push({ url: String(url), rows: JSON.parse(String(init?.body)) })
      return { ok: true, status: 201, text: async () => '' } as unknown as Response
    }) as unknown as typeof fetch,
    log: line => {
      logs.push(line)
    },
    ...overrides
  }

  return {
    key,
    calls,
    logs,
    vault,
    getState: () => state,
    setFailNext: (n: number) => {
      failNext = n
    },
    /** Fails only requests whose URL contains `substring`, `n` times — lets a
     * test target one pipeline's upsert (e.g. the readable table) without
     * disturbing the other's. */
    setFailUrl: (substring: string, n = 1) => {
      failUrlSubstring = substring
      failUrlCount = n
    },
    publisher: createLibraryPublisher(deps)
  }
}

// A settled file: modified well before NOW so the quiet rule lets it through.
const settled = (content: string) => ({ content, mtimeMs: NOW - 60_000 })

test('first tick publishes every settled file and the phone primitive can open the rows', async () => {
  const h = makeHarness()
  h.vault.set('a.md', settled('# Alpha\nbody'))
  h.vault.set('PHCY 1205/b.md', settled('# Beta\nbody'))

  await h.publisher.tick()

  const e2ee = e2eeCalls(h.calls)
  assert.equal(e2ee.length, 1)
  assert.equal(e2ee[0].rows.length, 2)
  assert.ok(e2ee[0].url.includes('on_conflict=user_id,path_hash'))
  for (const row of e2ee[0].rows) {
    assert.equal(row.user_id, 'user-1')
    assert.equal(row.deleted, false)
    const raw = Buffer.from(String(row.payload), 'base64')
    const opened = bytesToUtf8(
      gcm(Uint8Array.from(h.key), Uint8Array.from(raw.subarray(0, 12)), utf8ToBytes(String(row.path_hash))).decrypt(
        Uint8Array.from(raw.subarray(12))
      )
    )
    assert.equal(JSON.parse(opened).v, 1)
  }
  assert.equal(Object.keys(h.getState()!.files).length, 2)
  assert.deepEqual(h.publisher.lastResult(), { at: NOW, published: 2, deleted: 0, total: 2 })
})

test('an unchanged vault produces zero requests on the next tick', async () => {
  const h = makeHarness()
  h.vault.set('a.md', settled('# Alpha'))
  await h.publisher.tick()
  const before = h.calls.length
  await h.publisher.tick()
  assert.equal(h.calls.length, before)
})

test('quiet rule: a just-written file waits, then publishes once it settles', async () => {
  const h = makeHarness()
  h.vault.set('fresh.md', { content: '# Fresh', mtimeMs: NOW - 2_000 })
  await h.publisher.tick()
  assert.equal(e2eeCalls(h.calls).length, 0)

  h.vault.set('fresh.md', { content: '# Fresh', mtimeMs: NOW - 10_000 })
  await h.publisher.tick()
  assert.equal(e2eeCalls(h.calls).length, 1)
})

test('a quiet-rule skip is not mistaken for a deletion', async () => {
  const h = makeHarness()
  h.vault.set('a.md', settled('# Alpha'))
  await h.publisher.tick()
  // The same file appears freshly modified: it must be neither republished
  // (settling) nor tombstoned (it exists).
  h.vault.set('a.md', { content: '# Alpha v2', mtimeMs: NOW - 1_000 })
  const before = h.calls.length
  await h.publisher.tick()
  assert.equal(h.calls.length, before)
  assert.ok(h.getState()!.files['a.md'])
})

test('files over the size cap are skipped', async () => {
  const h = makeHarness()
  h.vault.set('huge.md', settled('x'.repeat(MAX_DOC_BYTES + 1)))
  h.vault.set('ok.md', settled('# Fits'))
  await h.publisher.tick()
  const e2ee = e2eeCalls(h.calls)
  assert.equal(e2ee.length, 1)
  assert.equal(e2ee[0].rows.length, 1)
  assert.equal(h.getState()!.files['huge.md'], undefined)
})

test('a deleted file becomes a tombstone row and leaves the state', async () => {
  const h = makeHarness()
  h.vault.set('a.md', settled('# Alpha'))
  h.vault.set('b.md', settled('# Beta'))
  await h.publisher.tick()

  h.vault.delete('b.md')
  await h.publisher.tick()

  const e2ee = e2eeCalls(h.calls)
  const tombstones = e2ee[e2ee.length - 1].rows
  assert.equal(tombstones.length, 1)
  assert.equal(tombstones[0].deleted, true)
  assert.equal(tombstones[0].payload, null)
  assert.equal(typeof tombstones[0].path_hash, 'string')
  assert.equal(h.getState()!.files['b.md'], undefined)
  assert.ok(h.getState()!.files['a.md'])
})

test('a failed batch leaves state untouched so the next tick retries', async () => {
  const h = makeHarness()
  h.vault.set('a.md', settled('# Alpha'))
  h.setFailNext(1)
  await h.publisher.tick()
  assert.equal(h.getState(), null) // nothing confirmed, nothing saved

  await h.publisher.tick() // retry succeeds
  assert.equal(e2eeCalls(h.calls).length, 1)
  assert.ok(h.getState()!.files['a.md'])
})

test('changes are split into batches of 20', async () => {
  const h = makeHarness()
  for (let i = 0; i < 45; i++) h.vault.set(`n${i}.md`, settled(`# Note ${i}`))
  await h.publisher.tick()
  assert.deepEqual(
    e2eeCalls(h.calls).map(c => c.rows.length),
    [20, 20, 5]
  )
})

test('no vault key (unpaired) or no token (signed out) → no requests at all', async () => {
  const noKey = makeHarness({ getVaultKey: async () => null })
  noKey.vault.set('a.md', settled('# Alpha'))
  await noKey.publisher.tick()
  assert.equal(noKey.calls.length, 0)

  const noToken = makeHarness({ getAccessToken: async () => null })
  noToken.vault.set('a.md', settled('# Alpha'))
  await noToken.publisher.tick()
  assert.equal(noToken.calls.length, 0)
})

test('walkVaultMarkdown: recurses folders, takes only *.md, never enters dot-dirs or node_modules', async () => {
  const tree: Record<string, { name: string; isDirectory: boolean; isFile: boolean }[]> = {
    '/vault': [
      { name: 'a.md', isDirectory: false, isFile: true },
      { name: 'notes.txt', isDirectory: false, isFile: true },
      { name: 'PHCY 1205', isDirectory: true, isFile: false },
      { name: '.nemesis', isDirectory: true, isFile: false },
      { name: '.obsidian', isDirectory: true, isFile: false },
      { name: 'node_modules', isDirectory: true, isFile: false },
      { name: '.hidden.md', isDirectory: false, isFile: true }
    ],
    '/vault/PHCY 1205': [{ name: 'b.MD', isDirectory: false, isFile: true }]
  }
  const files: VaultFileEntry[] = await walkVaultMarkdown(
    {
      readdir: async dir => {
        if (!(dir in tree)) throw new Error(`unexpected readdir ${dir}`)
        return tree[dir]
      },
      stat: async () => ({ size: 10, mtimeMs: NOW - 60_000 })
    },
    '/vault'
  )
  assert.deepEqual(files.map(f => f.relPath).sort(), ['PHCY 1205/b.MD', 'a.md'])
})

test('emptyPublisherState is the v1 shape', () => {
  assert.deepEqual(emptyPublisherState(), { v: 1, files: {} })
})

// ——— Phase 2/3: derived docs (deck snapshots, calendar) + the ICS feed ———

function openRow(key: Buffer, row: Record<string, unknown>): Record<string, unknown> {
  const raw = Buffer.from(String(row.payload), 'base64')
  return JSON.parse(
    bytesToUtf8(
      gcm(Uint8Array.from(key), Uint8Array.from(raw.subarray(0, 12)), utf8ToBytes(String(row.path_hash))).decrypt(
        Uint8Array.from(raw.subarray(12))
      )
    )
  )
}

function derivedHarness() {
  const derived = new Map<string, DerivedDocEntry>()
  let feed: { ics: string; token: string } | null = null
  const h = makeHarness({
    listDerivedDocs: async () => [...derived.values()],
    getCalendarFeed: async () => feed
  })
  return {
    ...h,
    derived,
    setFeed: (next: { ics: string; token: string } | null) => {
      feed = next
    }
  }
}

test('derived docs publish with their own kind + title and change-detect on content', async () => {
  const h = derivedHarness()
  h.derived.set('.study/sync/deck/deck-1', {
    path: '.study/sync/deck/deck-1',
    kind: 'deck',
    title: 'Cardio Exam 2',
    content: JSON.stringify({ v: 1, id: 'deck-1', queue: [] }),
    mtimeMs: NOW - 60_000
  })

  await h.publisher.tick()
  assert.equal(h.calls.length, 1)
  const opened = openRow(h.key, h.calls[0].rows[0])
  assert.equal(opened.kind, 'deck')
  assert.equal(opened.title, 'Cardio Exam 2')
  assert.equal(opened.path, '.study/sync/deck/deck-1')
  assert.equal(JSON.parse(String(opened.content)).id, 'deck-1')

  // Unchanged content → no new request; changed content → republished.
  await h.publisher.tick()
  assert.equal(h.calls.length, 1)
  h.derived.set('.study/sync/deck/deck-1', {
    ...h.derived.get('.study/sync/deck/deck-1')!,
    content: JSON.stringify({ v: 1, id: 'deck-1', queue: [{ key: 'c1' }] })
  })
  await h.publisher.tick()
  assert.equal(h.calls.length, 2)
})

test('a derived doc that disappears from its source is tombstoned', async () => {
  const h = derivedHarness()
  h.derived.set('.derived/calendar', {
    path: '.derived/calendar',
    kind: 'calendar',
    title: 'Calendar',
    content: JSON.stringify({ v: 1, events: [] }),
    mtimeMs: NOW - 60_000
  })
  await h.publisher.tick()
  h.derived.clear()

  await h.publisher.tick()
  const last = h.calls[h.calls.length - 1]
  assert.equal(last.rows.length, 1)
  assert.equal(last.rows[0].deleted, true)
  assert.equal(last.rows[0].payload, null)
  assert.equal(Object.keys(h.getState()!.files).length, 0)
})

test('calendar feed upserts once per ICS text and remembers the confirmed hash', async () => {
  const h = derivedHarness()
  h.setFeed({ ics: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', token: 'a'.repeat(64) })

  await h.publisher.tick()
  const feedCalls = () => h.calls.filter(call => call.url.includes('calendar_feeds'))
  assert.equal(feedCalls().length, 1)
  assert.ok(feedCalls()[0].url.includes('on_conflict=user_id'))
  assert.deepEqual(feedCalls()[0].rows[0], {
    user_id: 'user-1',
    token: 'a'.repeat(64),
    ics: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'
  })
  assert.equal(h.getState()!.calendarFeedHash?.length, 64)

  // Same text → no re-upsert. New text → one more.
  await h.publisher.tick()
  assert.equal(feedCalls().length, 1)
  h.setFeed({ ics: 'BEGIN:VCALENDAR\r\nX\r\nEND:VCALENDAR\r\n', token: 'a'.repeat(64) })
  await h.publisher.tick()
  assert.equal(feedCalls().length, 2)
})

test('a failed feed upsert leaves the hash unsaved so the next tick retries', async () => {
  const h = derivedHarness()
  h.setFeed({ ics: 'ICS-1', token: 'b'.repeat(64) })
  h.setFailNext(1)

  await h.publisher.tick()
  assert.equal(h.getState()?.calendarFeedHash, undefined)

  await h.publisher.tick()
  assert.equal(h.calls.filter(call => call.url.includes('calendar_feeds')).length, 1)
  assert.equal(h.getState()!.calendarFeedHash?.length, 64)
})

test('a regenerated feed token re-upserts even when the ICS text is unchanged', async () => {
  const h = derivedHarness()
  h.setFeed({ ics: 'SAME-ICS', token: 'c'.repeat(64) })
  await h.publisher.tick()
  h.setFeed({ ics: 'SAME-ICS', token: 'd'.repeat(64) })
  await h.publisher.tick()

  const feedCalls = h.calls.filter(call => call.url.includes('calendar_feeds'))
  assert.equal(feedCalls.length, 2)
  assert.equal(feedCalls[1].rows[0].token, 'd'.repeat(64))
})

// ——— Additive plaintext mirror: readable_library_documents ———
// Same auth, same batching, same changed/removed sets as the encrypted
// pipeline above; the one new behavior worth proving on its own is failure
// isolation (a broken readable-copy upsert must never cost the E2EE publish
// its confirmed state).

test('a changed note also gets a plaintext row in readable_library_documents', async () => {
  const h = makeHarness()
  h.vault.set('PHCY 1205/b.md', settled('# Beta\nbody'))

  await h.publisher.tick()

  const rc = readableCalls(h.calls)
  assert.equal(rc.length, 1)
  assert.ok(rc[0].url.includes('on_conflict=user_id,path'))
  assert.deepEqual(rc[0].rows, [
    {
      user_id: 'user-1',
      path: 'PHCY 1205/b.md',
      kind: 'note',
      title: 'b',
      content: '# Beta\nbody',
      deleted: false
    }
  ])
})

test('an unchanged file produces no new readable-copy request on the next tick', async () => {
  const h = makeHarness()
  h.vault.set('a.md', settled('# Alpha'))
  await h.publisher.tick()
  const before = readableCalls(h.calls).length
  await h.publisher.tick()
  assert.equal(readableCalls(h.calls).length, before)
})

test('a deleted note becomes a readable tombstone: {user_id, path, deleted:true, content:null}', async () => {
  const h = makeHarness()
  h.vault.set('a.md', settled('# Alpha'))
  h.vault.set('b.md', settled('# Beta'))
  await h.publisher.tick()

  h.vault.delete('b.md')
  await h.publisher.tick()

  const rc = readableCalls(h.calls)
  const tombstone = rc[rc.length - 1]
  assert.deepEqual(tombstone.rows, [{ user_id: 'user-1', path: 'b.md', deleted: true, content: null }])
})

test('readable-copy changes are also split into batches of 20', async () => {
  const h = makeHarness()
  for (let i = 0; i < 45; i++) h.vault.set(`n${i}.md`, settled(`# Note ${i}`))
  await h.publisher.tick()
  assert.deepEqual(
    readableCalls(h.calls).map(c => c.rows.length),
    [20, 20, 5]
  )
})

test('decks and calendar never reach the readable table (notes only)', async () => {
  const h = derivedHarness()
  h.derived.set('.study/sync/deck/deck-1', {
    path: '.study/sync/deck/deck-1',
    kind: 'deck',
    title: 'Cardio Exam 2',
    content: JSON.stringify({ v: 1, id: 'deck-1', queue: [] }),
    mtimeMs: NOW - 60_000
  })
  h.vault.set('a.md', settled('# Alpha'))

  await h.publisher.tick()
  const rc = readableCalls(h.calls)
  assert.equal(rc.length, 1) // the note only, not the deck
  assert.deepEqual(
    rc[0].rows.map(r => r.path),
    ['a.md']
  )

  // The deck's source disappears — its tombstone must not reach this table either.
  h.derived.clear()
  await h.publisher.tick()
  assert.equal(readableCalls(h.calls).length, 1) // unchanged: no new readable call
})

test('a failed readable-copy upsert is logged but never stops the E2EE publish from confirming', async () => {
  const h = makeHarness()
  h.setFailUrl('readable_library_documents', 1)
  h.vault.set('a.md', settled('# Alpha'))

  await h.publisher.tick()

  // E2EE side: fully confirmed, exactly as if the readable table didn't exist.
  assert.equal(e2eeCalls(h.calls).length, 1)
  assert.ok(h.getState()!.files['a.md'])
  assert.deepEqual(h.publisher.lastResult(), { at: NOW, published: 1, deleted: 0, total: 1 })

  // Readable side: attempted, failed, logged — not silently retried, since
  // state (incl. the hash-sweep) only ever advances off the E2EE loop.
  assert.equal(readableCalls(h.calls).length, 0)
  assert.ok(h.logs.some(line => line.includes('readable-copy publish failed')))
})
