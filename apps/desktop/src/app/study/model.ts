// Study page data model: decks + FSRS spaced-repetition scheduling + persistence.
// Scheduling is ts-fsrs (MIT) — the same FSRS algorithm modern Anki defaults to. We
// deliberately embed zero Anki code (AGPL); only the algorithm family is shared, so
// review math stays compatible with the decks students already know.
// v1 persistence is a small localStorage JSON blob (same pattern as store/onboarding);
// the upgrade path is backend/vault storage once Nemesis accounts land.
import { createEmptyCard, fsrs, type Card as FsrsCard, type Grade, Rating } from 'ts-fsrs'

import { clozeIndexes, clozeScheduleKey } from './cloze'
import type { DeckFileCandidate } from './deck-files'

export interface StudyCard {
  id: string
  front: string
  back: string
  tags: string[]
  /** Suspended cards stay in the deck but never enter the review queue (Anki semantics). */
  suspended?: boolean
}

export interface StudyDeck {
  id: string
  name: string
  course?: string
  createdAt: string
  cards: StudyCard[]
  /** Vault deck file (Flashcards/<fileName>) this deck mirrors. Absent = created
   *  in-app by the student; reconcileDeckFiles never touches those. */
  sourceFile?: string
}

/** JSON-safe FSRS card state (Dates serialized to ISO strings). */
export type StoredSchedule = Omit<FsrsCard, 'due' | 'last_review'> & { due: string; last_review?: string }

export interface ReviewEntry {
  /** Schedule key: the card id, or `${cardId}#c${n}` for one cloze slot. */
  cardId: string
  rating: StudyRating
  at: string
}

export type ReviewOrder = 'due' | 'random'

export interface StudySettings {
  /** New cards introduced per day. 0 = unlimited. */
  newPerDay: number
  /** Already-scheduled review cards per day. 0 = unlimited. */
  reviewsPerDay: number
  /** FSRS request_retention: the recall probability targeted when a card comes
   *  due. Higher = shorter intervals = more daily reviews. */
  desiredRetention: number
  /** 'due' studies overdue cards before new ones (today's behavior); 'random'
   *  shuffles the capped queue, stably for the whole day (see buildQueue). */
  order: ReviewOrder
  /** 3D flip animation on the review card (vs. a static reveal below a divider). */
  flip: boolean
  /** Show the "{interval} · {key}" hint under each grade button. */
  showIntervalHints: boolean
}

export const DEFAULT_STUDY_SETTINGS: StudySettings = {
  newPerDay: 20,
  reviewsPerDay: 0,
  desiredRetention: 0.9,
  order: 'due',
  flip: true,
  showIntervalHints: true
}

export interface StudyState {
  version: 1
  decks: StudyDeck[]
  /** Persisted course/group names so an empty section can exist without a deck. */
  sections: string[]
  /** cardId → FSRS schedule. Absent = never studied (new). */
  schedule: Record<string, StoredSchedule>
  /** Append-only review log that feeds the activity heatmap. */
  reviews: ReviewEntry[]
  /** Absent (pre-settings state) or partial (old blobs, mid-migration) →
   *  getSettings() fills the rest from DEFAULT_STUDY_SETTINGS. Never read this
   *  field directly; call getSettings(). */
  settings?: Partial<StudySettings>
}

export type StudyRating = 'again' | 'easy' | 'good' | 'hard'

export interface QueueItem {
  card: StudyCard
  deckId: string
  deckName: string
  isNew: boolean
  /** Schedule/log key: the card id, or `${cardId}#c${n}` for one cloze index. */
  scheduleKey: string
  /** The active {{cN::…}} index this item drills; absent for plain cards. */
  clozeIndex?: number
}

// Bumped to v2 for grouped decks + review activity. Pre-release, so discarding the old
// demo blob is fine; once real student data exists this needs a migration, not a bump.
const STORAGE_KEY = 'nemesis.study.v2'
const QUEUE_LIMIT = 200
// Pre-settings flip toggle lived in its own key (see study/index.tsx); loadState
// migrates it into settings.flip once, then this key is never consulted again.
const LEGACY_FLIP_KEY = 'nemesis.study.flip'

// One FSRS scheduler per desired retention (see StudySettings.desiredRetention),
// rebuilt only when the setting changes — grading and interval previews are hot.
let scheduler = fsrs({ request_retention: DEFAULT_STUDY_SETTINGS.desiredRetention })
let schedulerRetention = DEFAULT_STUDY_SETTINGS.desiredRetention

function schedulerFor(desiredRetention: number) {
  if (desiredRetention !== schedulerRetention) {
    scheduler = fsrs({ request_retention: desiredRetention })
    schedulerRetention = desiredRetention
  }

  return scheduler
}

const RATING: Record<StudyRating, Grade> = {
  again: Rating.Again,
  easy: Rating.Easy,
  good: Rating.Good,
  hard: Rating.Hard
}

/** JSON round-trips turn the FSRS Dates into strings; ts-fsrs needs real Dates back. */
function revive(stored: StoredSchedule): FsrsCard {
  return {
    ...stored,
    due: new Date(stored.due),
    last_review: stored.last_review ? new Date(stored.last_review) : undefined
  } as FsrsCard
}

function freeze(card: FsrsCard): StoredSchedule {
  return {
    ...card,
    due: card.due.toISOString(),
    last_review: card.last_review ? card.last_review.toISOString() : undefined
  } as StoredSchedule
}

function isDue(stored: StoredSchedule | undefined, now: Date): boolean {
  if (!stored) {
    return true // never studied → new → due
  }

  return new Date(stored.due).getTime() <= now.getTime()
}

/** Local calendar day key (yyyy-mm-dd). Day-based features — daily caps, the
 *  day-stable shuffle, streaks, the heatmap — follow the student's clock, so a
 *  23:30 review belongs to today, not to tomorrow's UTC date. */
export function localDayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${date.getFullYear()}-${month}-${day}`
}

/** The local calendar day `offset` days from `date` (constructor arithmetic —
 *  safe across month ends and DST shifts, where fixed 24h math drifts). */
function shiftLocalDay(date: Date, offset: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset)
}

function normalizeSections(sections: string[] | undefined, decks: StudyDeck[]): string[] {
  const names: string[] = []
  const seen = new Set<string>()

  for (const raw of [...(sections ?? []), ...decks.map(deck => deck.course ?? '')]) {
    const name = raw.trim()
    const key = name.toLocaleLowerCase()

    if (name && key !== 'other' && !seen.has(key)) {
      names.push(name)
      seen.add(key)
    }
  }

  return names
}

/** One-time bridge from the pre-settings flip key into settings.flip. Only that
 *  field is touched — everything else stays absent so getSettings() fills it from
 *  DEFAULT_STUDY_SETTINGS. Never overwrites an already-migrated (explicit) value. */
function migrateFlipSetting(settings: Partial<StudySettings> | undefined): Partial<StudySettings> | undefined {
  if (settings?.flip !== undefined) {
    return settings
  }

  try {
    const legacy = window.localStorage.getItem(LEGACY_FLIP_KEY)

    return legacy === null ? settings : { ...settings, flip: legacy !== 'off' }
  } catch {
    return settings
  }
}

export function loadState(): StudyState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)

    if (raw) {
      const parsed = JSON.parse(raw) as StudyState

      if (parsed && parsed.version === 1 && Array.isArray(parsed.decks)) {
        return {
          ...parsed,
          reviews: (parsed.reviews ?? []).filter(review => !review.cardId.startsWith('seed#')),
          sections: normalizeSections(parsed.sections, parsed.decks),
          settings: migrateFlipSetting(parsed.settings)
        }
      }
    }
  } catch {
    // corrupted blob → fall through to a fresh empty state
  }

  // Fresh installs start EMPTY (owner decision, beta.5): no demo decks — the
  // page's empty state points at Create/Import, and the agent can build decks
  // from the student's own material.
  return {
    version: 1,
    decks: [],
    sections: normalizeSections([], []),
    schedule: {},
    reviews: [],
    settings: migrateFlipSetting(undefined)
  }
}

export function saveState(state: StudyState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // quota/private-mode failures are non-fatal; the session keeps working in memory
  }
}

// --- Study settings (daily caps, review order, flip, hints) ------------------

/** Effective settings — always fully populated, even for old/partial blobs.
 *  Callers should never read state.settings directly. */
export function getSettings(state: StudyState): StudySettings {
  return { ...DEFAULT_STUDY_SETTINGS, ...state.settings }
}

/** Patch one or more settings fields. Pure — returns a new StudyState. */
export function setSettings(state: StudyState, patch: Partial<StudySettings>): StudyState {
  return { ...state, settings: { ...getSettings(state), ...patch } }
}

// --- Review queue --------------------------------------------------------------

/** Tiny deterministic string hash (FNV-1a) → a stable pseudo-random rank. */
function hashSeed(key: string): number {
  let hash = 0x811c9dc5

  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }

  return hash >>> 0
}

/** Deterministic per-item order for a local day key: each item's rank comes from
 *  hashing (dayKey, its own schedule key), never from the other cards in the queue —
 *  so grading a card away doesn't reshuffle the rest (a plain Fisher-Yates reseeded
 *  on every shrinking queue would: the same seed applied to an (n-1)-length array
 *  is a different permutation, not "the old one minus a card"). A fresh dayKey
 *  gives every card a fresh rank the next day. */
function orderForDay(items: QueueItem[], dayKey: string): QueueItem[] {
  return [...items].sort((a, b) => hashSeed(`${dayKey}:${a.scheduleKey}`) - hashSeed(`${dayKey}:${b.scheduleKey}`))
}

/** New-vs-review split of everything graded on `dayKey` (local yyyy-mm-dd, see
 *  localDayKey). An entry counts as "new" the first time its cardId ever appears
 *  in the log — matching the isNew: !stored rule below — and as a "review" every
 *  time after that. */
function todayActivity(reviews: ReviewEntry[], dayKey: string): { newCount: number; reviewCount: number } {
  const seenBefore = new Set<string>()
  let newCount = 0
  let reviewCount = 0

  for (const entry of reviews) {
    const isFirstEver = !seenBefore.has(entry.cardId)
    seenBefore.add(entry.cardId)

    if (localDayKey(new Date(entry.at)) !== dayKey) {
      continue
    }

    if (isFirstEver) {
      newCount++
    } else {
      reviewCount++
    }
  }

  return { newCount, reviewCount }
}

/** A card's schedule slots: the card itself, or one slot per distinct cloze
 *  index — each drilled and scheduled independently (Anki cloze semantics). */
function scheduleTargets(card: StudyCard): { clozeIndex?: number; key: string }[] {
  const indexes = clozeIndexes(card.front)

  if (!indexes.length) {
    return [{ key: card.id }]
  }

  return indexes.map(index => ({ clozeIndex: index, key: clozeScheduleKey(card.id, index) }))
}

/** Review queue: due reviews first, then new cards (or a day-stable shuffle of
 *  both, in 'random' order), capped by today's new/review daily limits. Pure. */
export function buildQueue(state: StudyState, deckId: null | string, now: Date): QueueItem[] {
  const settings = getSettings(state)
  const dayKey = localDayKey(now)
  const { newCount, reviewCount } = todayActivity(state.reviews, dayKey)

  const dueItems: QueueItem[] = []
  const newItems: QueueItem[] = []

  for (const deck of state.decks) {
    if (deckId && deck.id !== deckId) {
      continue
    }

    for (const card of deck.cards) {
      if (card.suspended) {
        continue
      }

      for (const target of scheduleTargets(card)) {
        const stored = state.schedule[target.key]

        if (!isDue(stored, now)) {
          continue
        }

        const item: QueueItem = {
          card,
          clozeIndex: target.clozeIndex,
          deckId: deck.id,
          deckName: deck.name,
          isNew: !stored,
          scheduleKey: target.key
        }

        ;(item.isNew ? newItems : dueItems).push(item)
      }
    }
  }

  const newCap = settings.newPerDay > 0 ? Math.max(0, settings.newPerDay - newCount) : newItems.length
  const reviewCap = settings.reviewsPerDay > 0 ? Math.max(0, settings.reviewsPerDay - reviewCount) : dueItems.length
  const capped = [...dueItems.slice(0, reviewCap), ...newItems.slice(0, newCap)]
  const ordered = settings.order === 'random' ? orderForDay(capped, dayKey) : capped

  return ordered.slice(0, QUEUE_LIMIT)
}

export interface DeckStats {
  due: number
  fresh: number
  total: number
}

export function deckStats(state: StudyState, deckId: null | string, now: Date): DeckStats {
  let due = 0
  let fresh = 0
  let total = 0

  for (const deck of state.decks) {
    if (deckId && deck.id !== deckId) {
      continue
    }

    for (const card of deck.cards) {
      const targets = scheduleTargets(card)
      total += targets.length

      if (card.suspended) {
        continue
      }

      for (const target of targets) {
        const stored = state.schedule[target.key]

        if (!stored) {
          fresh++
          due++
        } else if (isDue(stored, now)) {
          due++
        }
      }
    }
  }

  return { due, fresh, total }
}

// --- Card management (Anki-style browser/editor backing) -------------------

function mapDeckCards(state: StudyState, deckId: string, map: (cards: StudyCard[]) => StudyCard[]): StudyState {
  return {
    ...state,
    decks: state.decks.map(deck => (deck.id === deckId ? { ...deck, cards: map(deck.cards) } : deck))
  }
}

export function updateCard(state: StudyState, deckId: string, card: StudyCard): StudyState {
  return mapDeckCards(state, deckId, cards => cards.map(existing => (existing.id === card.id ? card : existing)))
}

export function addCard(state: StudyState, deckId: string, front: string, back: string, tags: string[]): StudyState {
  const card: StudyCard = { back, front, id: freshId('card'), tags }

  return mapDeckCards(state, deckId, cards => [...cards, card])
}

/** Drop schedule entries for the given card ids — each card's own key AND any
 *  of its cloze slots (`${id}#c${n}`). Returns a fresh map. */
function pruneCardSchedules(
  schedule: Record<string, StoredSchedule>,
  cardIds: readonly string[]
): Record<string, StoredSchedule> {
  const ids = new Set(cardIds)
  const next: Record<string, StoredSchedule> = {}

  for (const [key, entry] of Object.entries(schedule)) {
    const at = key.indexOf('#c')
    const baseId = at >= 0 ? key.slice(0, at) : key

    if (!ids.has(baseId)) {
      next[key] = entry
    }
  }

  return next
}

/** Delete a card AND its FSRS schedule (incl. cloze slots) so state doesn't leak. */
export function deleteCard(state: StudyState, deckId: string, cardId: string): StudyState {
  const next = mapDeckCards(state, deckId, cards => cards.filter(card => card.id !== cardId))

  return { ...next, schedule: pruneCardSchedules(next.schedule, [cardId]) }
}

export function toggleSuspendCard(state: StudyState, deckId: string, cardId: string): StudyState {
  return mapDeckCards(state, deckId, cards =>
    cards.map(card => (card.id === cardId ? { ...card, suspended: !card.suspended } : card))
  )
}

// --- Deck management ---------------------------------------------------------

/** Delete a deck and its cards' schedules. The review log keeps its history —
 *  streaks and the heatmap don't lie just because a deck was retired. */
export function deleteDeck(state: StudyState, deckId: string): StudyState {
  const deck = state.decks.find(candidate => candidate.id === deckId)

  if (!deck) {
    return state
  }

  return {
    ...state,
    decks: state.decks.filter(candidate => candidate.id !== deckId),
    schedule: pruneCardSchedules(
      state.schedule,
      deck.cards.map(card => card.id)
    )
  }
}

export function addSection(state: StudyState, name: string): StudyState {
  const section = name.trim()

  if (
    !section ||
    section.toLocaleLowerCase() === 'other' ||
    state.sections.some(existing => existing.toLocaleLowerCase() === section.toLocaleLowerCase())
  ) {
    return state
  }

  return { ...state, sections: [...state.sections, section] }
}

/** Remove a section (owner ask, beta.9). Decks filed under it are NOT deleted —
 *  they drop back to the ungrouped bucket by clearing their course tag. */
export function deleteSection(state: StudyState, name: string): StudyState {
  const target = name.trim().toLocaleLowerCase()

  if (!state.sections.some(existing => existing.toLocaleLowerCase() === target)) {
    return state
  }

  return {
    ...state,
    decks: state.decks.map(deck =>
      (deck.course ?? '').toLocaleLowerCase() === target ? { ...deck, course: undefined } : deck
    ),
    sections: state.sections.filter(existing => existing.toLocaleLowerCase() !== target)
  }
}

export function assignDeckSection(state: StudyState, deckId: string, section: string): StudyState {
  const course = section.trim() || undefined

  return {
    ...state,
    decks: state.decks.map(deck => (deck.id === deckId ? { ...deck, course } : deck))
  }
}

/** Rename a deck. For file-backed decks pass the renamed vault file name so the
 *  next reconcile matches it instead of treating the old link as deleted — the
 *  caller renames the actual file FIRST (see the Study rename dialog), so state
 *  only changes once the disk rename succeeded. */
export function renameDeck(state: StudyState, deckId: string, name: string, sourceFile?: string): StudyState {
  return {
    ...state,
    decks: state.decks.map(deck =>
      deck.id === deckId ? { ...deck, name, ...(sourceFile ? { sourceFile } : {}) } : deck
    )
  }
}

// --- Deck-file reconcile (agent-managed decks) --------------------------------
// The vault's Flashcards folder is the source of truth for agent-written decks:
// the agent renames, edits, and deletes deck files while organizing, and Study
// mirrors that here — without losing FSRS review progress, because cards keep
// their ids (the schedule key) whenever their text survives the file edit.

/** Keep in sync with the deck-file extension filter in deck-files.ts. */
const DECK_FILE_EXTENSION = /\.(tsv|txt|md)$/i

/** A vanished file and a new file that share at least half their cards are the
 *  same deck, renamed — relink it instead of wiping its review history. */
const RENAME_OVERLAP_MIN = 0.5

/** Cards match across file edits by text, not id (case-insensitive, trimmed). */
function cardKey(front: string, back: string): string {
  return `${front.trim().toLocaleLowerCase()}\u0000${back.trim().toLocaleLowerCase()}`
}

/** Shared-card fraction (0..1) between a deck and a candidate, multiset-aware. */
function renameScore(deck: StudyDeck, candidate: DeckFileCandidate): number {
  if (!deck.cards.length || !candidate.cards.length) {
    return 0
  }

  const counts = new Map<string, number>()

  for (const card of deck.cards) {
    const key = cardKey(card.front, card.back)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  let shared = 0

  for (const card of candidate.cards) {
    const key = cardKey(card.front, card.back)
    const left = counts.get(key) ?? 0

    if (left > 0) {
      counts.set(key, left - 1)
      shared++
    }
  }

  return shared / Math.max(deck.cards.length, candidate.cards.length)
}

/** File cards → deck cards. Text-matched cards keep their StudyCard (id, tags,
 *  suspended — and therefore their schedule entry); file text wins on case or
 *  whitespace drift; new cards get fresh ids; dropped cards are reported so the
 *  caller can prune their schedules. Returns the same array when nothing changed. */
function reconcileCards(
  existing: StudyCard[],
  parsed: readonly { back: string; front: string }[]
): { cards: StudyCard[]; removedIds: string[] } {
  const pool = new Map<string, StudyCard[]>()

  for (const card of existing) {
    const key = cardKey(card.front, card.back)
    const queue = pool.get(key)

    if (queue) {
      queue.push(card)
    } else {
      pool.set(key, [card])
    }
  }

  const cards = parsed.map((entry): StudyCard => {
    const match = pool.get(cardKey(entry.front, entry.back))?.shift()

    if (!match) {
      return { back: entry.back, front: entry.front, id: freshId('card'), tags: [] }
    }

    return match.front === entry.front && match.back === entry.back
      ? match
      : { ...match, back: entry.back, front: entry.front }
  })

  const removedIds = [...pool.values()].flat().map(card => card.id)

  const unchanged =
    removedIds.length === 0 &&
    cards.length === existing.length &&
    cards.every((card, index) => card === existing[index])

  return { cards: unchanged ? existing : cards, removedIds }
}

/** Reconcile agent-managed decks against the vault's deck files. Pure.
 *  - candidate with a linked deck (`sourceFile`) → update name/course/cards in place
 *  - candidate with no linked deck → relink a renamed deck when the cards overlap,
 *    else import it fresh (skipping files with no parseable cards, like the old import)
 *  - linked deck whose file is gone → remove it and prune its cards' schedules
 *  - decks without `sourceFile` (made in-app) are never touched
 *  Returns the same state reference when the files already match, so callers can
 *  skip persistence. */
export function reconcileDeckFiles(state: StudyState, candidates: DeckFileCandidate[]): StudyState {
  const byFile = new Map(candidates.map(candidate => [candidate.fileName, candidate]))
  const linkedFiles = new Set<string>()

  for (const deck of state.decks) {
    if (deck.sourceFile) {
      linkedFiles.add(deck.sourceFile)
    }
  }

  const decks: StudyDeck[] = []
  const orphans: StudyDeck[] = []
  const prunedIds: string[] = []
  let changed = false

  for (const deck of state.decks) {
    if (!deck.sourceFile) {
      decks.push(deck)

      continue
    }

    const candidate = byFile.get(deck.sourceFile)

    if (!candidate) {
      // File gone — deleted, unless a new file below claims it as a rename.
      orphans.push(deck)

      continue
    }

    const { cards, removedIds } = reconcileCards(deck.cards, candidate.cards)
    const course = candidate.course?.trim() || undefined

    if (cards === deck.cards && deck.name === candidate.name && deck.course === course) {
      decks.push(deck)

      continue
    }

    decks.push({ ...deck, cards, course, name: candidate.name })
    prunedIds.push(...removedIds)
    changed = true
  }

  for (const candidate of candidates) {
    if (linkedFiles.has(candidate.fileName)) {
      continue
    }

    let renamedAt = -1
    let bestScore = 0

    for (let index = 0; index < orphans.length; index++) {
      const score = renameScore(orphans[index], candidate)

      if (score > bestScore) {
        bestScore = score
        renamedAt = index
      }
    }

    if (renamedAt >= 0 && bestScore >= RENAME_OVERLAP_MIN) {
      const [renamed] = orphans.splice(renamedAt, 1)
      const { cards, removedIds } = reconcileCards(renamed.cards, candidate.cards)

      decks.push({
        ...renamed,
        cards,
        course: candidate.course?.trim() || undefined,
        name: candidate.name,
        sourceFile: candidate.fileName
      })
      prunedIds.push(...removedIds)
      changed = true

      continue
    }

    if (!candidate.cards.length) {
      continue
    }

    decks.push({
      cards: candidate.cards.map(card => ({ back: card.back, front: card.front, id: freshId('card'), tags: [] })),
      course: candidate.course?.trim() || undefined,
      createdAt: new Date().toISOString(),
      id: freshId('deck'),
      name: candidate.name,
      sourceFile: candidate.fileName
    })
    changed = true
  }

  for (const deck of orphans) {
    prunedIds.push(...deck.cards.map(card => card.id))
    changed = true
  }

  if (!changed) {
    return state
  }

  const schedule = prunedIds.length ? pruneCardSchedules(state.schedule, prunedIds) : state.schedule

  // Same section rules as everywhere else: new courses appear, manually-added
  // (now empty) sections stay. The review log keeps its history — see deleteDeck.
  return { ...state, decks, schedule, sections: normalizeSections(state.sections, decks) }
}

/** One-time bridge for decks imported before `sourceFile` existed: the legacy
 *  import-once registry knows which file names were auto-imported, so relink each
 *  to the (still unlinked) deck carrying that import's default name. Without this,
 *  the first reconcile would see every already-imported file as brand new and
 *  duplicate the deck. Pure; returns the same reference when nothing to adopt. */
export function adoptLegacyDeckFiles(state: StudyState, importedFileNames: string[]): StudyState {
  let decks = state.decks
  let changed = false

  for (const fileName of importedFileNames) {
    if (decks.some(deck => deck.sourceFile === fileName)) {
      continue
    }

    const name = fileName.replace(DECK_FILE_EXTENSION, '')
    const at = decks.findIndex(deck => !deck.sourceFile && deck.name === name)

    if (at < 0) {
      continue
    }

    decks = decks.map((deck, index) => (index === at ? { ...deck, sourceFile: fileName } : deck))
    changed = true
  }

  return changed ? { ...state, decks } : state
}

// --- Motivational stats (streaks + retention) -------------------------------

export interface StudyMotivation {
  currentStreak: number
  longestStreak: number
  /** % of the last `windowDays` with at least one review. */
  daysLearnedPct: number
  /** % of graded reviews that were NOT "again" over the last 30 days (retention proxy). */
  retentionPct: null | number
}

export function studyMotivation(state: StudyState, todayIso: string, windowDays = 90): StudyMotivation {
  const DAY = 86_400_000
  const days = new Set(state.reviews.map(review => localDayKey(new Date(review.at))))
  const today = new Date(todayIso)

  // Current streak: consecutive local days ending today (or yesterday, so an
  // unstudied "today so far" doesn't zero the streak before the student sits down).
  let currentStreak = 0
  let offset = days.has(localDayKey(today)) ? 0 : -1

  while (days.has(localDayKey(shiftLocalDay(today, offset)))) {
    currentStreak++
    offset--
  }

  // Longest streak across all history. Keys are local calendar dates; parsing
  // them at UTC midnight is a pure calendar trick — consecutive dates sit
  // exactly one DAY apart in that mapping, whatever the machine's timezone.
  const sorted = [...days].sort()
  let longestStreak = 0
  let run = 0
  let previous = Number.NaN

  for (const day of sorted) {
    const ms = new Date(`${day}T00:00:00.000Z`).getTime()
    run = ms - previous === DAY ? run + 1 : 1
    previous = ms
    longestStreak = Math.max(longestStreak, run)
  }

  let learned = 0

  for (let i = 0; i < windowDays; i++) {
    if (days.has(localDayKey(shiftLocalDay(today, -i)))) {
      learned++
    }
  }

  const cutoff = shiftLocalDay(today, -30).toISOString()
  const recent = state.reviews.filter(review => review.at >= cutoff)

  const retentionPct = recent.length
    ? Math.round((recent.filter(review => review.rating !== 'again').length / recent.length) * 100)
    : null

  return {
    currentStreak,
    daysLearnedPct: Math.round((learned / windowDays) * 100),
    longestStreak,
    retentionPct
  }
}

// Anki leech semantics: a card that keeps lapsing is wasting review time. Once
// its lapse count reaches the threshold it is auto-suspended and tagged so the
// student rewrites (or re-learns) it before it re-enters the queue. Suspension
// is per-card here, so a leeched cloze slot parks its whole parent card.
const LEECH_LAPSES = 8
export const LEECH_TAG = 'leech'

function applyLeech(state: StudyState, scheduleKey: string): StudyState {
  const at = scheduleKey.indexOf('#c')
  const cardId = at >= 0 ? scheduleKey.slice(0, at) : scheduleKey

  return {
    ...state,
    decks: state.decks.map(deck => {
      const card = deck.cards.find(candidate => candidate.id === cardId)

      if (!card || card.suspended) {
        return deck
      }

      return {
        ...deck,
        cards: deck.cards.map(candidate =>
          candidate.id === cardId
            ? {
                ...candidate,
                suspended: true,
                tags: candidate.tags.includes(LEECH_TAG) ? candidate.tags : [...candidate.tags, LEECH_TAG]
              }
            : candidate
        )
      }
    })
  }
}

/** Grade a card (or one cloze slot) → next state (immutable). `scheduleKey` is
 *  the queue item's schedule key (QueueItem.scheduleKey). A lapse that crosses
 *  the leech threshold auto-suspends + tags the card (see applyLeech). */
export function gradeCard(state: StudyState, scheduleKey: string, rating: StudyRating, now: Date): StudyState {
  const stored = state.schedule[scheduleKey]
  const current = stored ? revive(stored) : createEmptyCard(now)
  const outcome = schedulerFor(getSettings(state).desiredRetention).repeat(current, now)[RATING[rating]]

  const next: StudyState = {
    ...state,
    schedule: { ...state.schedule, [scheduleKey]: freeze(outcome.card) },
    reviews: [...state.reviews, { cardId: scheduleKey, rating, at: now.toISOString() }]
  }

  // Only a real lapse (one that increments the count) can newly cross the
  // threshold — re-grading an unsuspended old leech as Good must not re-park it.
  return outcome.card.lapses > current.lapses && outcome.card.lapses >= LEECH_LAPSES
    ? applyLeech(next, scheduleKey)
    : next
}

export interface GradeUndo {
  /** The graded queue item's schedule key (card id or cloze slot). */
  scheduleKey: string
  /** Schedule entry before the grade; absent = the card had never been studied. */
  previous?: StoredSchedule
}

/** Reverse the most recent gradeCard: restore the pre-grade schedule snapshot
 *  and pop that review-log entry. Deliberately session-only — the snapshot lives
 *  in component state, never in the persisted blob, so it cannot survive a
 *  reload. Leech suspension is not reverted (matching Anki, where unsuspending
 *  is an explicit act in the browser). */
export function undoLastGrade(state: StudyState, undo: GradeUndo): StudyState {
  const last = state.reviews.at(-1)

  if (!last || last.cardId !== undo.scheduleKey) {
    return state // something else was graded since the snapshot — refuse quietly
  }

  const schedule = { ...state.schedule }

  if (undo.previous) {
    schedule[undo.scheduleKey] = undo.previous
  } else {
    delete schedule[undo.scheduleKey]
  }

  return { ...state, reviews: state.reviews.slice(0, -1), schedule }
}

export interface DeckGroup {
  course: string
  decks: StudyDeck[]
  stats: DeckStats
}

/** Group decks by course (the "folder"). Ungrouped decks fall under "Other". Pure. */
export function groupDecks(state: StudyState, now: Date): DeckGroup[] {
  const byCourse = new Map<string, StudyDeck[]>()
  const canonicalNames = new Map<string, string>()

  for (const section of state.sections) {
    const name = section.trim()

    if (name) {
      byCourse.set(name, [])
      canonicalNames.set(name.toLocaleLowerCase(), name)
    }
  }

  for (const deck of state.decks) {
    const course = deck.course?.trim()
    const normalized = course?.toLocaleLowerCase()
    const key = !course || normalized === 'other' ? 'Other' : (canonicalNames.get(course.toLocaleLowerCase()) ?? course)
    const list = byCourse.get(key) ?? []
    list.push(deck)
    byCourse.set(key, list)
  }

  return [...byCourse.entries()]
    .map(([course, decks]) => ({
      course,
      decks,
      stats: decks.reduce(
        (sum, deck) => {
          const s = deckStats(state, deck.id, now)

          return { due: sum.due + s.due, fresh: sum.fresh + s.fresh, total: sum.total + s.total }
        },
        { due: 0, fresh: 0, total: 0 }
      )
    }))
    .sort((a, b) => b.stats.due - a.stats.due || a.course.localeCompare(b.course))
}

export interface HeatCell {
  date: string
  count: number
  /** 0 (none) … 4 (most) — intensity bucket for coloring. */
  level: number
}

/** Rolling GitHub-style contribution window: exactly `weeks` weeks ending today,
 *  laid out oldest→newest. The view supplies blank leading cells to keep the
 *  dates aligned with Sunday-anchored columns. Pure. */
export function reviewHeatmap(state: StudyState, todayIso: string, weeks = 52): { cells: HeatCell[]; total: number } {
  const perDay = new Map<string, number>()

  for (const review of state.reviews) {
    const day = localDayKey(new Date(review.at)) // the student's calendar day
    perDay.set(day, (perDay.get(day) ?? 0) + 1)
  }

  // Work entirely in the machine's LOCAL calendar so the per-day keys and cell
  // dates always agree with the daily caps and streaks (localDayKey everywhere).
  // Do not pad forward to Saturday: the rolling window ends on today, so no
  // future cells displace an older month.
  const today = new Date(todayIso)
  const dayCount = weeks * 7

  const cells: HeatCell[] = []
  let total = 0

  for (let i = dayCount - 1; i >= 0; i--) {
    const iso = localDayKey(shiftLocalDay(today, -i))
    const count = perDay.get(iso) ?? 0
    total += count
    cells.push({ count, date: iso, level: count === 0 ? 0 : count < 5 ? 1 : count < 12 ? 2 : count < 25 ? 3 : 4 })
  }

  return { cells, total }
}

/** Interval each grade would schedule, humanized — the hint row under the grade buttons. */
export function previewIntervals(state: StudyState, scheduleKey: string, now: Date): Record<StudyRating, string> {
  const stored = state.schedule[scheduleKey]
  const current = stored ? revive(stored) : createEmptyCard(now)
  const outcome = schedulerFor(getSettings(state).desiredRetention).repeat(current, now)

  const label = (grade: Grade): string => humanizeGap(outcome[grade].card.due.getTime() - now.getTime())

  return {
    again: label(Rating.Again),
    easy: label(Rating.Easy),
    good: label(Rating.Good),
    hard: label(Rating.Hard)
  }
}

function humanizeGap(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))

  if (minutes < 60) {
    return `${minutes}m`
  }

  const hours = Math.round(minutes / 60)

  if (hours < 24) {
    return `${hours}h`
  }

  const days = Math.round(hours / 24)

  if (days < 31) {
    return `${days}d`
  }

  return `${Math.round(days / 30)}mo`
}

let idCounter = 0

export function freshId(prefix: string): string {
  idCounter += 1

  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`
}

