/**
 * Background service: publishes the Library vault's markdown files to Supabase
 * as end-to-end encrypted rows (public.library_documents) so the phone can read
 * them. One-way by design — the Mac agent is the only author; the phone never
 * writes library rows (spec: docs/design/nemesis-phone-readonly-sync-2026-07.md
 * in the nemesis repo; wire format: nemesis-phone-sync-format-v1.md there).
 *
 * Runs on its own interval, deliberately NOT inside the mission dispatcher's
 * tick: that tick holds a `busy` gate for a mission's whole runtime (up to
 * 30 min), which would starve publishing exactly when the agent is writing the
 * notes the student wants on their phone.
 *
 * Same DI shape as mission-dispatcher: raw PostgREST via injected fetch, the
 * renderer-pushed Supabase user JWT (RLS `user_id = auth.uid()`), everything
 * else injected so library-publisher.test.ts drives it with fakes.
 *
 * Additive, alongside the encrypted rows: vault notes (decks/calendar are
 * excluded) also get a plaintext mirror in public.readable_library_documents,
 * for server-side features that can't hold the vault key. Same auth, same
 * PostgREST upsert shape, same change-detected file set as the encrypted
 * pipeline — a file that doesn't get resent to library_documents doesn't get
 * resent here either. It rides this same tick, so it inherits the same
 * phone-pairing gate as everything else below (`getVaultKey`): a Mac that has
 * never paired a phone won't populate this table either. A failure writing
 * this mirror is logged and swallowed — it must never break the encrypted
 * publish, which the phone depends on.
 */
import { createHash } from 'node:crypto'
import { encryptDoc, pathHashHex, type DocKind } from './library-crypto'

export const MAX_DOC_BYTES = 262_144 // format v1 cap; bigger files are skipped + logged once
export const QUIET_MS = 5_000 // skip files modified in the last 5s (agent write-bursts settle)
export const UPSERT_BATCH = 20

export type VaultFileEntry = { relPath: string; mtimeMs: number; size: number }

/**
 * A Mac-derived document (deck snapshot, calendar feed) — Phase 2/3 additions.
 * Content arrives ready-made (JSON, not a vault file read), so there's no quiet
 * rule: the collector only ever hands over complete, parsed-and-rebuilt content.
 * Paths are synthetic (`.study/sync/...`, `.derived/...`); the dot prefix keeps
 * them out of the markdown walker's namespace so they can never collide.
 */
export type DerivedDocEntry = { path: string; kind: DocKind; title: string; content: string; mtimeMs: number }

export type PublisherState = {
  v: 1
  files: Record<string, { hash: string }>
  /** sha256 of the last ICS text confirmed upserted into calendar_feeds. */
  calendarFeedHash?: string
}

export type PublishResult = { at: number; published: number; deleted: number; total: number }

export type LibraryPublisherDeps = {
  supabaseUrl: string
  anonKey: string
  getAccessToken: () => Promise<string | null>
  /** null = this Mac isn't paired with a phone; publishing is a no-op. */
  getVaultKey: () => Promise<Buffer | null>
  /** Vault-relative *.md files, dot-dirs/node_modules already excluded. */
  listVaultFiles: () => Promise<VaultFileEntry[]>
  readFileText: (relPath: string) => Promise<string>
  /** Deck snapshots + the calendar doc (Phase 2/3). Absent/empty = notes only. */
  listDerivedDocs?: () => Promise<DerivedDocEntry[]>
  /** Plaintext ICS for the native-calendar feed (owner D3 scoped exception);
   * null = no calendar data yet. Upserted into calendar_feeds on change. */
  getCalendarFeed?: () => Promise<{ ics: string; token: string } | null>
  loadState: () => Promise<PublisherState | null>
  saveState: (state: PublisherState) => Promise<void>
  now?: () => number
  fetchImpl?: typeof fetch
  log?: (line: string) => void
}

export function emptyPublisherState(): PublisherState {
  return { v: 1, files: {} }
}

/** readable_library_documents' title: literally the filename minus its
 * extension. Deliberately NOT library-crypto's titleFromMarkdown (which
 * prefers the first `# ` heading) — this table is a plain server-side
 * mirror, not the phone's note list, and the spec calls for the filename. */
function titleFromFilename(relPath: string): string {
  const base = relPath.split('/').pop() ?? relPath
  return base.replace(/\.md$/i, '')
}

export function createLibraryPublisher(deps: LibraryPublisherDeps) {
  const doFetch = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  let timer: ReturnType<typeof setInterval> | null = null
  let busy = false
  let lastResult: PublishResult | null = null
  const oversizeWarned = new Set<string>()

  const userIdFromToken = (token: string): string =>
    JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8')).sub

  const upsert = async (token: string, rows: Record<string, unknown>[]) => {
    const res = await doFetch(
      `${deps.supabaseUrl}/rest/v1/library_documents?on_conflict=user_id,path_hash`,
      {
        method: 'POST',
        headers: {
          apikey: deps.anonKey,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify(rows)
      }
    )
    if (!res.ok) throw new Error(`postgrest ${res.status} on library_documents`)
  }

  /** Same PostgREST upsert shape as `upsert` above, pointed at the plaintext
   * mirror table instead. Kept as a separate function (rather than a
   * parameterized table name) so the E2EE `upsert` above stays byte-for-byte
   * untouched. */
  const upsertReadable = async (token: string, rows: Record<string, unknown>[]) => {
    const res = await doFetch(`${deps.supabaseUrl}/rest/v1/readable_library_documents?on_conflict=user_id,path`, {
      method: 'POST',
      headers: {
        apikey: deps.anonKey,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(rows)
    })
    if (!res.ok) throw new Error(`postgrest ${res.status} on readable_library_documents`)
  }

  async function tick(): Promise<void> {
    if (busy) return
    busy = true
    try {
      const key = await deps.getVaultKey()
      if (!key) return
      const token = await deps.getAccessToken()
      if (!token) return
      const userId = userIdFromToken(token)

      const state = (await deps.loadState()) ?? emptyPublisherState()
      const files = await deps.listVaultFiles()
      const seen = new Set<string>()

      // Which files changed since the last confirmed publish?
      const changed: {
        relPath: string
        mtimeMs: number
        hash: string
        content: string
        kind?: DocKind
        title?: string
      }[] = []
      for (const file of files) {
        if (file.size > MAX_DOC_BYTES) {
          if (!oversizeWarned.has(file.relPath)) {
            oversizeWarned.add(file.relPath)
            log(`[phone-sync] skipping ${file.relPath}: over the ${Math.round(MAX_DOC_BYTES / 1024)}KB sync cap`)
          }
          continue
        }
        // Quiet rule: the agent writes in bursts; let a file settle before upload.
        // It stays in `seen` so it isn't mistaken for a deletion meanwhile.
        seen.add(file.relPath)
        if (now() - file.mtimeMs < QUIET_MS) continue
        const content = await deps.readFileText(file.relPath)
        const hash = createHash('sha256').update(content, 'utf8').digest('hex')
        if (state.files[file.relPath]?.hash === hash) continue
        changed.push({ relPath: file.relPath, mtimeMs: file.mtimeMs, hash, content })
      }

      // Mac-derived docs (deck snapshots, the calendar doc) ride the same
      // pipeline: hash change-detection, tombstone-on-absence, encrypted batches.
      // No quiet rule — their content arrives complete by construction.
      const derived = deps.listDerivedDocs ? await deps.listDerivedDocs() : []
      for (const doc of derived) {
        if (Buffer.byteLength(doc.content, 'utf8') > MAX_DOC_BYTES) {
          if (!oversizeWarned.has(doc.path)) {
            oversizeWarned.add(doc.path)
            log(`[phone-sync] skipping ${doc.path}: over the ${Math.round(MAX_DOC_BYTES / 1024)}KB sync cap`)
          }
          continue
        }
        seen.add(doc.path)
        const hash = createHash('sha256').update(doc.content, 'utf8').digest('hex')
        if (state.files[doc.path]?.hash === hash) continue
        changed.push({
          relPath: doc.path,
          mtimeMs: doc.mtimeMs,
          hash,
          content: doc.content,
          kind: doc.kind,
          title: doc.title
        })
      }

      // Docs that vanished (files from disk, derived docs from their source)
      // since we last published them.
      const removed = Object.keys(state.files).filter(relPath => !seen.has(relPath))

      const nextFiles = { ...state.files }
      let published = 0
      let deleted = 0

      for (let i = 0; i < changed.length; i += UPSERT_BATCH) {
        const batch = changed.slice(i, i + UPSERT_BATCH)
        const rows = batch.map(entry => ({
          user_id: userId,
          deleted: false,
          ...encryptDoc(
            key,
            entry.relPath,
            entry.content,
            new Date(entry.mtimeMs).toISOString(),
            entry.kind ? { kind: entry.kind, title: entry.title } : undefined
          )
        }))
        await upsert(token, rows)
        // State advances only after the server confirmed the batch — a failed
        // request leaves these files marked dirty for the next tick.
        for (const entry of batch) nextFiles[entry.relPath] = { hash: entry.hash }
        published += batch.length
      }

      for (let i = 0; i < removed.length; i += UPSERT_BATCH) {
        const batch = removed.slice(i, i + UPSERT_BATCH)
        const rows = batch.map(relPath => ({
          user_id: userId,
          path_hash: pathHashHex(key, relPath),
          payload: null,
          deleted: true
        }))
        await upsert(token, rows)
        for (const relPath of batch) delete nextFiles[relPath]
        deleted += batch.length
      }

      // Additive plaintext mirror (readable_library_documents): notes only —
      // decks/calendar are Mac-derived docs and are always dot-path-prefixed
      // (see walkVaultMarkdown's exclusion), so filtering them out here can
      // never accidentally drop or misfile a real note. Rides the same
      // `changed`/`removed` sets the encrypted loops above already computed,
      // so it inherits the quiet rule, the size cap, and the hash-sweep for
      // free — a file whose hash didn't change isn't resent to this table
      // either. Wrapped in its own try/catch: this table is a bonus, and a
      // failure here (network blip, table not migrated yet, whatever) must
      // never stop the encrypted publish above from confirming its state —
      // that publish is what the phone depends on.
      try {
        const changedNotes = changed.filter(entry => entry.kind === undefined)
        for (let i = 0; i < changedNotes.length; i += UPSERT_BATCH) {
          const batch = changedNotes.slice(i, i + UPSERT_BATCH)
          const rows = batch.map(entry => ({
            user_id: userId,
            path: entry.relPath.normalize('NFC'),
            kind: 'note',
            title: titleFromFilename(entry.relPath),
            content: entry.content,
            deleted: false
          }))
          await upsertReadable(token, rows)
        }

        const removedNotes = removed.filter(relPath => !relPath.startsWith('.'))
        for (let i = 0; i < removedNotes.length; i += UPSERT_BATCH) {
          const batch = removedNotes.slice(i, i + UPSERT_BATCH)
          const rows = batch.map(relPath => ({
            user_id: userId,
            path: relPath.normalize('NFC'),
            deleted: true,
            content: null
          }))
          await upsertReadable(token, rows)
        }
      } catch (error) {
        log(
          `[phone-sync] readable-copy publish failed, E2EE publish unaffected: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }

      // Native-calendar ICS feed (plaintext by owner-scoped exception): its own
      // row in calendar_feeds, refreshed only when the rendered text changed.
      // Failures log-and-retry next tick without disturbing the doc pipeline.
      let calendarFeedHash = state.calendarFeedHash
      const feed = deps.getCalendarFeed ? await deps.getCalendarFeed() : null
      if (feed) {
        // The token is part of the hash so a regenerated token re-uploads even
        // when the ICS text itself hasn't changed (stale-URL guard).
        const icsHash = createHash('sha256').update(`${feed.token}\n${feed.ics}`, 'utf8').digest('hex')
        if (icsHash !== calendarFeedHash) {
          const res = await doFetch(`${deps.supabaseUrl}/rest/v1/calendar_feeds?on_conflict=user_id`, {
            method: 'POST',
            headers: {
              apikey: deps.anonKey,
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              Prefer: 'resolution=merge-duplicates,return=minimal'
            },
            body: JSON.stringify([{ user_id: userId, token: feed.token, ics: feed.ics }])
          })
          if (res.ok) {
            calendarFeedHash = icsHash
            log('[phone-sync] calendar feed refreshed')
          } else {
            log(`[phone-sync] calendar feed upsert failed (${res.status}); retrying next tick`)
          }
        }
      }

      const dirty = published > 0 || deleted > 0 || calendarFeedHash !== state.calendarFeedHash
      if (dirty) {
        await deps.saveState({
          v: 1,
          files: nextFiles,
          ...(calendarFeedHash ? { calendarFeedHash } : {})
        })
      }
      lastResult = { at: now(), published, deleted, total: files.length + derived.length }
      if (published || deleted) {
        log(`[phone-sync] published ${published}, tombstoned ${deleted} (${files.length + derived.length} docs tracked)`)
      }
    } catch (error) {
      // Transient network/auth failure — swallow so the interval keeps ticking;
      // state only ever advances on confirmed batches, so the next tick retries.
      log(`[phone-sync] tick failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      busy = false
    }
  }

  return {
    tick,
    lastResult: () => lastResult,
    start(intervalMs: number) {
      if (timer) return
      timer = setInterval(() => {
        void tick()
      }, intervalMs)
    },
    stop() {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    }
  }
}

/**
 * Real-fs walker for the vault, injected as `listVaultFiles` by main.ts.
 * Policy lives here (and is tested with a fake fs): *.md only, dot-prefixed
 * entries (.nemesis, .obsidian, …) and node_modules are never traversed — the
 * vault's internal state, portals.json and friends stay off the wire.
 */
export type WalkerFs = {
  readdir: (absDir: string) => Promise<{ name: string; isDirectory: boolean; isFile: boolean }[]>
  stat: (absPath: string) => Promise<{ size: number; mtimeMs: number }>
}

export async function walkVaultMarkdown(fsLike: WalkerFs, root: string): Promise<VaultFileEntry[]> {
  const out: VaultFileEntry[] = []
  const walk = async (relDir: string): Promise<void> => {
    let entries: { name: string; isDirectory: boolean; isFile: boolean }[]
    try {
      entries = await fsLike.readdir(relDir ? `${root}/${relDir}` : root)
    } catch {
      return // vault (or a subfolder) missing/unreadable — publish what's reachable
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.isDirectory) {
        await walk(rel)
      } else if (entry.isFile && /\.md$/i.test(entry.name)) {
        try {
          const stat = await fsLike.stat(`${root}/${rel}`)
          out.push({ relPath: rel, mtimeMs: stat.mtimeMs, size: stat.size })
        } catch {
          // raced a deletion — the tombstone pass picks it up next tick
        }
      }
    }
  }
  await walk('')
  return out
}
