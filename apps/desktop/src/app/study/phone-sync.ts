// Phone-sync study bridge (sync spec Phases 2/3). Lives in the RENDERER on
// purpose: the study state's source of truth is renderer localStorage, and the
// FSRS apply path (model.ts gradeCard) lives here — the spec's hard rule is that
// phone grades and desktop grades flow through the SAME function.
//
// Two jobs share one 30s tick:
//   1. Snapshots DOWN — precompute every deck's due queue + stats into
//      `.study/phone-decks.json`; the main process splits that file into one
//      encrypted `kind: 'deck'` document per deck (see electron/main.ts
//      listPhoneDerivedDocs). Written only when deck content actually changed,
//      so the publisher isn't spammed with no-op republishes.
//   2. Grades UP→APPLIED — pull un-ingested review_events rows (RLS-scoped),
//      fold them through gradeCard, save, then stamp ingested_at. The
//      read-fold-write block is synchronous, so a concurrently open Study page
//      can never interleave a grade into the middle of it; the page reloads via
//      STUDY_STATE_EXTERNAL_CHANGE_EVENT (dispatched synchronously right after
//      the save, before any await, closing the clobber window).
import { restFetch } from '../../nemesis-account'
import { clozeIndexes, clozeScheduleKey, renderClozeAnswer, renderClozePrompt } from './cloze'
import { STUDY_DATA_DIR } from './disk-state'
import {
  buildQueue,
  deckStats,
  gradeCard,
  loadState,
  saveState,
  type DeckStats,
  type StudyRating,
  type StudyState
} from './model'

export const STUDY_STATE_EXTERNAL_CHANGE_EVENT = 'nemesis:study-state-external-change'
export const PHONE_DECKS_FILE = `${STUDY_DATA_DIR}/phone-decks.json`

const TICK_MS = 30_000
const INGEST_LIMIT = 200
const STAMP_BATCH = 50
const GRADES: ReadonlySet<string> = new Set(['again', 'hard', 'good', 'easy'])

// Applied-row ledger: the local, persisted "I already folded this row" record.
// The server-side ingested_at stamp alone is NOT a safe idempotency signal —
// it's written AFTER the local save, so a failed PATCH (or a crash between
// save and stamp) would re-deliver the same rows next tick and gradeCard would
// happily re-run FSRS on them, corrupting schedules. Rows in the ledger are
// never re-applied; their stamp is simply retried.
const APPLIED_LEDGER_KEY = 'nemesis.study.phone-applied.v1'
export const APPLIED_LEDGER_CAP = 5000

/** Parse the persisted ledger (ids of review_events rows already folded). Pure. */
export function appliedLedgerFrom(raw: null | string): string[] {
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : null

    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
  } catch {
    return []
  }
}

/** Append newly applied ids, keeping only the most recent entries. Stamped rows
 *  never return from the pending query, so pruned old ids are harmless. Pure. */
export function appendToLedger(ledger: string[], ids: string[]): string[] {
  return [...ledger, ...ids].slice(-APPLIED_LEDGER_CAP)
}

function loadAppliedLedger(): string[] {
  try {
    return appliedLedgerFrom(window.localStorage.getItem(APPLIED_LEDGER_KEY))
  } catch {
    return []
  }
}

function saveAppliedLedger(ledger: string[]): void {
  try {
    window.localStorage.setItem(APPLIED_LEDGER_KEY, JSON.stringify(ledger))
  } catch {
    // best-effort; worst case a row re-applies once after a localStorage failure
  }
}

export interface PhoneQueueCard {
  /** The model's schedule key — echoed back verbatim in review_events. */
  key: string
  prompt: string
  answer: string
  /** Cloze cards: the back field rides along as extra context. */
  note?: string
  isNew: boolean
}

export interface PhoneDeckSnapshot {
  id: string
  name: string
  course?: string
  stats: DeckStats
  queue: PhoneQueueCard[]
}

export interface PhoneDecksPayload {
  v: 1
  asOf: string
  decks: PhoneDeckSnapshot[]
}

/** One review_events row as the ingester reads it. */
export interface PhoneReviewRow {
  id: string
  schedule_key: string
  grade: string
  reviewed_at: string
}

/** Precompute the phone's study material: per deck, today's queue (due order,
 *  daily caps — exactly what the desktop review surface would show) with
 *  pre-rendered cloze prompts, so the phone ships zero scheduler code. Pure. */
export function buildPhoneDecksPayload(state: StudyState, now: Date): PhoneDecksPayload {
  return {
    v: 1,
    asOf: now.toISOString(),
    decks: state.decks.map(deck => ({
      id: deck.id,
      name: deck.name,
      ...(deck.course ? { course: deck.course } : {}),
      stats: deckStats(state, deck.id, now),
      queue: buildQueue(state, deck.id, now).map(item => {
        const isCloze = item.clozeIndex !== undefined
        const note = isCloze && item.card.back.trim() ? item.card.back : undefined

        return {
          key: item.scheduleKey,
          prompt: isCloze ? renderClozePrompt(item.card.front, item.clozeIndex ?? 0) : item.card.front,
          answer: isCloze ? renderClozeAnswer(item.card.front) : item.card.back,
          ...(note ? { note } : {}),
          isNew: item.isNew
        }
      })
    }))
  }
}

/** Fold phone grades into study state through the one true apply path. Grades
 *  for cards deleted since the phone's snapshot are counted as skipped (still
 *  stamped by the caller — gradeCard would otherwise mint orphan schedule
 *  entries). Reviews anchor to the phone's review time, clamped so clock skew
 *  can't schedule from the future. Pure. */
export function applyPhoneReviews(
  state: StudyState,
  rows: PhoneReviewRow[],
  now: Date
): { state: StudyState; applied: number; skipped: number } {
  const validKeys = new Set<string>()

  for (const deck of state.decks) {
    for (const card of deck.cards) {
      const indexes = clozeIndexes(card.front)

      if (indexes.length) {
        for (const index of indexes) validKeys.add(clozeScheduleKey(card.id, index))
      } else {
        validKeys.add(card.id)
      }
    }
  }

  let next = state
  let applied = 0
  let skipped = 0

  for (const row of rows) {
    if (!GRADES.has(row.grade) || !validKeys.has(row.schedule_key)) {
      skipped++
      continue
    }

    const reviewedAt = new Date(row.reviewed_at)
    const when = Number.isFinite(reviewedAt.getTime()) && reviewedAt.getTime() < now.getTime() ? reviewedAt : now

    next = gradeCard(next, row.schedule_key, row.grade as StudyRating, when)
    applied++
  }

  return { applied, skipped, state: next }
}

function looksLikeReviewRow(row: unknown): row is PhoneReviewRow {
  const candidate = row as Partial<PhoneReviewRow> | null

  return Boolean(
    candidate &&
      typeof candidate.id === 'string' &&
      typeof candidate.schedule_key === 'string' &&
      typeof candidate.grade === 'string' &&
      typeof candidate.reviewed_at === 'string'
  )
}

let running = false

/** Start the background bridge; returns a stop function. Idempotent — a second
 *  call while running is a no-op (the shell mounts this exactly once). Runs even
 *  when signed out: snapshots are local-only, and restFetch no-ops the ingest. */
export function startPhoneStudySync(): () => void {
  if (running) {
    return () => {}
  }

  running = true
  let busy = false
  let lastDecksJson: null | string = null

  const writeSnapshots = async (state: StudyState): Promise<void> => {
    const payload = buildPhoneDecksPayload(state, new Date())
    // Change detection ignores asOf — otherwise every tick would look "new" and
    // the publisher would re-encrypt identical decks forever.
    const decksJson = JSON.stringify(payload.decks)

    if (decksJson === lastDecksJson) {
      return
    }

    const api = window.hermesDesktop

    if (!api?.writeTextFile || !api.makeDir) {
      return
    }

    try {
      await api.makeDir(STUDY_DATA_DIR)
      await api.writeTextFile(PHONE_DECKS_FILE, JSON.stringify(payload))
      lastDecksJson = decksJson
    } catch {
      // best-effort: the next tick retries
    }
  }

  const ingest = async (): Promise<void> => {
    const res = await restFetch(
      `review_events?select=id,schedule_key,grade,reviewed_at&ingested_at=is.null&order=reviewed_at.asc&limit=${INGEST_LIMIT}`
    )

    if (!res?.ok) {
      return
    }

    let rows: unknown

    try {
      rows = await res.json()
    } catch {
      return
    }

    const valid = Array.isArray(rows) ? rows.filter(looksLikeReviewRow) : []

    if (!valid.length) {
      return
    }

    // The ledger splits fetched rows into never-seen (fold them) and
    // already-applied-but-unstamped (just retry their stamp).
    const ledger = loadAppliedLedger()
    const applied = new Set(ledger)
    const fresh = valid.filter(row => !applied.has(row.id))

    if (fresh.length) {
      // Synchronous read-fold-write-notify: no await from loadState through the
      // ledger save and event dispatch, so an open Study page can neither
      // interleave a grade nor clobber the fold with a stale in-memory state.
      // The ledger write shares that synchronous block, so a crash at any later
      // point can never make these rows fold twice.
      const folded = applyPhoneReviews(loadState(), fresh, new Date())
      saveState(folded.state)
      saveAppliedLedger(
        appendToLedger(
          ledger,
          fresh.map(row => row.id)
        )
      )
      try {
        window.dispatchEvent(new Event(STUDY_STATE_EXTERNAL_CHANGE_EVENT))
      } catch {
        // no-op outside a browser context
      }
    }

    // Stamp everything fetched (fresh rows just folded + leftovers whose stamp
    // failed before), in URL-safe chunks, and STOP on the first failure — the
    // next tick re-fetches them, the ledger blocks re-application, and the
    // stamp gets retried until the server confirms.
    const ids = valid.map(row => encodeURIComponent(row.id))
    for (let i = 0; i < ids.length; i += STAMP_BATCH) {
      const stamped = await restFetch(`review_events?id=in.(${ids.slice(i, i + STAMP_BATCH).join(',')})`, {
        body: JSON.stringify({ ingested_at: new Date().toISOString() }),
        headers: { Prefer: 'return=minimal' },
        method: 'PATCH'
      })

      if (!stamped?.ok) {
        return
      }
    }
  }

  const tick = async (): Promise<void> => {
    if (busy) {
      return
    }

    busy = true

    try {
      await ingest()
      await writeSnapshots(loadState())
    } catch {
      // transient (network, bridge) — the next tick retries
    } finally {
      busy = false
    }
  }

  void tick()
  const timer = setInterval(() => {
    void tick()
  }, TICK_MS)

  return () => {
    clearInterval(timer)
    running = false
  }
}
