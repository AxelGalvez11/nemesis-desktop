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
  type LibraryPublisherDeps,
  type PublisherState,
  type VaultFileEntry
} from './library-publisher'

const NOW = 1_800_000_000_000
const TOKEN = `h.${Buffer.from(JSON.stringify({ sub: 'user-1' })).toString('base64')}.s`

type Call = { url: string; rows: Record<string, unknown>[] }

function makeHarness(overrides?: Partial<LibraryPublisherDeps>) {
  const key = generateVaultKey()
  const calls: Call[] = []
  let failNext = 0
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
      if (failNext > 0) {
        failNext -= 1
        return { ok: false, status: 500, text: async () => '' } as unknown as Response
      }
      calls.push({ url: String(url), rows: JSON.parse(String(init?.body)) })
      return { ok: true, status: 201, text: async () => '' } as unknown as Response
    }) as unknown as typeof fetch,
    log: () => {},
    ...overrides
  }

  return {
    key,
    calls,
    vault,
    getState: () => state,
    setFailNext: (n: number) => {
      failNext = n
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

  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].rows.length, 2)
  assert.ok(h.calls[0].url.includes('on_conflict=user_id,path_hash'))
  for (const row of h.calls[0].rows) {
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
  assert.equal(h.calls.length, 0)

  h.vault.set('fresh.md', { content: '# Fresh', mtimeMs: NOW - 10_000 })
  await h.publisher.tick()
  assert.equal(h.calls.length, 1)
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
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].rows.length, 1)
  assert.equal(h.getState()!.files['huge.md'], undefined)
})

test('a deleted file becomes a tombstone row and leaves the state', async () => {
  const h = makeHarness()
  h.vault.set('a.md', settled('# Alpha'))
  h.vault.set('b.md', settled('# Beta'))
  await h.publisher.tick()

  h.vault.delete('b.md')
  await h.publisher.tick()

  const tombstones = h.calls[h.calls.length - 1].rows
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
  assert.equal(h.calls.length, 1)
  assert.ok(h.getState()!.files['a.md'])
})

test('changes are split into batches of 20', async () => {
  const h = makeHarness()
  for (let i = 0; i < 45; i++) h.vault.set(`n${i}.md`, settled(`# Note ${i}`))
  await h.publisher.tick()
  assert.deepEqual(
    h.calls.map(c => c.rows.length),
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
