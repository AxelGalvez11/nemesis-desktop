// Study page data model: decks + FSRS spaced-repetition scheduling + persistence.
// Scheduling is ts-fsrs (MIT) — the same FSRS algorithm modern Anki defaults to. We
// deliberately embed zero Anki code (AGPL); only the algorithm family is shared, so
// review math stays compatible with the decks students already know.
// v1 persistence is a small localStorage JSON blob (same pattern as store/onboarding);
// the upgrade path is backend/vault storage once Nemesis accounts land.
import { createEmptyCard, fsrs, type Card as FsrsCard, type Grade, Rating } from 'ts-fsrs'

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
}

/** JSON-safe FSRS card state (Dates serialized to ISO strings). */
export type StoredSchedule = Omit<FsrsCard, 'due' | 'last_review'> & { due: string; last_review?: string }

export interface ReviewEntry {
  cardId: string
  rating: StudyRating
  at: string
}

export interface StudyState {
  version: 1
  decks: StudyDeck[]
  /** cardId → FSRS schedule. Absent = never studied (new). */
  schedule: Record<string, StoredSchedule>
  /** Append-only review log (feeds the future heatmap). */
  reviews: ReviewEntry[]
}

export type StudyRating = 'again' | 'easy' | 'good' | 'hard'

export interface QueueItem {
  card: StudyCard
  deckId: string
  deckName: string
  isNew: boolean
}

// Bumped to v2 for the grouped-decks + heatmap seed. Pre-release, so discarding the old
// demo blob is fine; once real student data exists this needs a migration, not a bump.
const STORAGE_KEY = 'nemesis.study.v2'
const QUEUE_LIMIT = 200

const scheduler = fsrs()

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

export function loadState(): StudyState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)

    if (raw) {
      const parsed = JSON.parse(raw) as StudyState

      if (parsed && parsed.version === 1 && Array.isArray(parsed.decks)) {
        return parsed
      }
    }
  } catch {
    // corrupted blob → fall through to a fresh seeded state
  }

  return { version: 1, decks: seedDecks(), schedule: {}, reviews: seedReviews() }
}

export function saveState(state: StudyState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // quota/private-mode failures are non-fatal; the session keeps working in memory
  }
}

/** Review queue: due reviews first, then new cards, capped. Pure. */
export function buildQueue(state: StudyState, deckId: null | string, now: Date): QueueItem[] {
  const queue: QueueItem[] = []

  for (const deck of state.decks) {
    if (deckId && deck.id !== deckId) {
      continue
    }

    for (const card of deck.cards) {
      if (card.suspended) {
        continue
      }

      const stored = state.schedule[card.id]

      if (isDue(stored, now)) {
        queue.push({ card, deckId: deck.id, deckName: deck.name, isNew: !stored })
      }
    }
  }

  queue.sort((a, b) => (a.isNew ? 1 : 0) - (b.isNew ? 1 : 0))

  return queue.slice(0, QUEUE_LIMIT)
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
      total++

      if (card.suspended) {
        continue
      }

      const stored = state.schedule[card.id]

      if (!stored) {
        fresh++
        due++
      } else if (isDue(stored, now)) {
        due++
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

/** Delete a card AND its FSRS schedule so state doesn't leak. */
export function deleteCard(state: StudyState, deckId: string, cardId: string): StudyState {
  const next = mapDeckCards(state, deckId, cards => cards.filter(card => card.id !== cardId))
  const schedule = { ...next.schedule }
  delete schedule[cardId]

  return { ...next, schedule }
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

  const schedule = { ...state.schedule }

  for (const card of deck.cards) {
    delete schedule[card.id]
  }

  return { ...state, decks: state.decks.filter(candidate => candidate.id !== deckId), schedule }
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
  const days = new Set(state.reviews.map(review => review.at.slice(0, 10)))
  const todayMs = new Date(`${todayIso.slice(0, 10)}T00:00:00.000Z`).getTime()

  // Current streak: consecutive days ending today (or yesterday, so an unstudied
  // "today so far" doesn't zero the streak before the student sits down).
  let currentStreak = 0
  let cursor = todayMs

  if (!days.has(new Date(cursor).toISOString().slice(0, 10))) {
    cursor -= DAY
  }

  while (days.has(new Date(cursor).toISOString().slice(0, 10))) {
    currentStreak++
    cursor -= DAY
  }

  // Longest streak across all history.
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
    if (days.has(new Date(todayMs - i * DAY).toISOString().slice(0, 10))) {
      learned++
    }
  }

  const cutoff = new Date(todayMs - 30 * DAY).toISOString()
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

/** Grade a card → next state (immutable: returns a new StudyState). */
export function gradeCard(state: StudyState, cardId: string, rating: StudyRating, now: Date): StudyState {
  const stored = state.schedule[cardId]
  const current = stored ? revive(stored) : createEmptyCard(now)
  const outcome = scheduler.repeat(current, now)[RATING[rating]]

  return {
    ...state,
    schedule: { ...state.schedule, [cardId]: freeze(outcome.card) },
    reviews: [...state.reviews, { cardId, rating, at: now.toISOString() }]
  }
}

export interface DeckGroup {
  course: string
  decks: StudyDeck[]
  stats: DeckStats
}

/** Group decks by course (the "folder"). Ungrouped decks fall under "Other". Pure. */
export function groupDecks(state: StudyState, now: Date): DeckGroup[] {
  const byCourse = new Map<string, StudyDeck[]>()

  for (const deck of state.decks) {
    const key = deck.course?.trim() || 'Other'
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
    .sort((a, b) => (b.stats.due - a.stats.due) || a.course.localeCompare(b.course))
}

export interface HeatCell {
  date: string
  count: number
  /** 0 (none) … 4 (most) — intensity bucket for coloring. */
  level: number
}

/** GitHub-style contribution grid: review counts per day for the last `weeks` weeks,
 *  laid out oldest→newest, each column a Sun-anchored week. Pure. */
export function reviewHeatmap(state: StudyState, todayIso: string, weeks = 18): { cells: HeatCell[]; total: number } {
  const perDay = new Map<string, number>()

  for (const review of state.reviews) {
    const day = review.at.slice(0, 10) // UTC calendar day from the ISO timestamp
    perDay.set(day, (perDay.get(day) ?? 0) + 1)
  }

  // Work entirely in UTC so the per-day keys (UTC) and cell dates (UTC) always agree,
  // regardless of the machine's timezone. Anchor on the UTC Sunday that starts the window.
  const DAY = 86_400_000
  const todayUtc = new Date(`${todayIso.slice(0, 10)}T00:00:00.000Z`)
  // End the grid on this week's Saturday (so today is always in the last column, GitHub-style)
  // and start `weeks` Sundays back — columns stay Sun→Sat aligned.
  const endMs = todayUtc.getTime() + (6 - todayUtc.getUTCDay()) * DAY
  const startMs = endMs - (weeks * 7 - 1) * DAY

  const cells: HeatCell[] = []
  let total = 0

  for (let i = 0; i < weeks * 7; i++) {
    const iso = new Date(startMs + i * DAY).toISOString().slice(0, 10)
    const count = perDay.get(iso) ?? 0
    total += count
    cells.push({ count, date: iso, level: count === 0 ? 0 : count < 5 ? 1 : count < 12 ? 2 : count < 25 ? 3 : 4 })
  }

  return { cells, total }
}

/** Interval each grade would schedule, humanized — the hint row under the grade buttons. */
export function previewIntervals(state: StudyState, cardId: string, now: Date): Record<StudyRating, string> {
  const stored = state.schedule[cardId]
  const current = stored ? revive(stored) : createEmptyCard(now)
  const outcome = scheduler.repeat(current, now)

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

/** Demo decks across two courses so the page (and its grouping) teaches itself on first open.
 *  Application-level pharm cards, not "what is X" filler. */
function seedDecks(): StudyDeck[] {
  const card = (front: string, back: string, tags: string[]): StudyCard => ({ id: freshId('card'), front, back, tags })

  const cardio: StudyDeck = {
    id: freshId('deck'),
    name: 'Cardio pharm essentials',
    course: 'Pharmacology',
    createdAt: new Date().toISOString(),
    cards: [
      card(
        'A patient on lisinopril develops a persistent dry cough. What is the mechanism, and what class do you switch to?',
        'ACE inhibition lets bradykinin accumulate in the airways → cough. Switch to an ARB (e.g. losartan): blocks AT1 directly, spares bradykinin degradation.',
        ['ace-inhibitors', 'adverse-effects']
      ),
      card(
        'Why are ACE inhibitors contraindicated in pregnancy?',
        'Fetal renal toxicity (oligohydramnios, renal dysgenesis) — all RAAS blockers are contraindicated.',
        ['ace-inhibitors', 'contraindications']
      ),
      card(
        'What two labs do you check after starting an ACE inhibitor, and why?',
        'Potassium (hyperkalemia risk) and serum creatinine (efferent-arteriole dilation can drop GFR, especially with renal artery stenosis).',
        ['ace-inhibitors', 'monitoring']
      ),
      card(
        'Furosemide vs hydrochlorothiazide: site of action and the classic electrolyte signature of each.',
        'Furosemide — thick ascending limb (Na-K-2Cl); potent, causes hypokalemia + hypocalcemia. HCTZ — distal tubule (Na-Cl); milder, hypokalemia + HYPERcalcemia.',
        ['diuretics']
      ),
      card(
        'A heart-failure patient on spironolactone and lisinopril has K⁺ 6.1. Which drug interaction explains it?',
        'Both raise potassium: aldosterone antagonism (spironolactone) + reduced aldosterone via ACE inhibition. Additive hyperkalemia — hold/adjust and recheck.',
        ['heart-failure', 'interactions']
      ),
      card(
        'Metoprolol is preferred over propranolol in an asthmatic patient who needs a beta blocker. Why?',
        'Metoprolol is β1-selective at usual doses — less β2 bronchoconstriction. Propranolol is non-selective and can trigger bronchospasm.',
        ['beta-blockers']
      ),
      card(
        'Which statin adverse effect do you screen for when a patient reports new diffuse muscle pain, and with what lab?',
        'Myopathy/rhabdomyolysis — check creatine kinase (CK). Risk rises with interacting CYP3A4 inhibitors (e.g. clarithromycin) and high-intensity dosing.',
        ['statins', 'monitoring']
      ),
      card(
        'Warfarin patient starts TMP-SMX for a UTI. What happens to the INR and why?',
        'INR rises — TMP-SMX inhibits CYP2C9 (warfarin metabolism) and displaces protein binding. Bleeding risk: monitor INR closely or pick another agent.',
        ['anticoagulants', 'interactions']
      )
    ]
  }

  const antimicrobials: StudyDeck = {
    id: freshId('deck'),
    name: 'Antimicrobial pearls',
    course: 'Infectious disease',
    createdAt: new Date().toISOString(),
    cards: [
      card(
        'Why is vancomycin trough (or AUC) monitoring required, and what toxicity does it guard against?',
        'Narrow therapeutic window — nephrotoxicity (and, classically, ototoxicity). AUC/MIC ≥ 400 targets efficacy while limiting kidney injury.',
        ['vancomycin', 'monitoring']
      ),
      card(
        'A patient on ciprofloxacin should avoid taking it with what common products, and why?',
        'Di/trivalent cations — antacids, calcium, iron, dairy — chelate fluoroquinolones and slash absorption. Separate doses by 2-6 hours.',
        ['fluoroquinolones', 'interactions']
      ),
      card(
        'Which antibiotic class carries a disulfiram-like reaction with alcohol, and name the prototype.',
        'Nitroimidazoles — metronidazole. Alcohol → flushing, nausea, tachycardia. Counsel to avoid alcohol during and 3 days after.',
        ['metronidazole', 'counseling']
      ),
      card(
        'Cell-wall synthesis inhibitor vs protein-synthesis inhibitor: which bucket do beta-lactams vs macrolides fall in?',
        'Beta-lactams (penicillins, cephalosporins) inhibit cell-wall synthesis. Macrolides (azithromycin) bind the 50S ribosome to block protein synthesis.',
        ['mechanisms']
      )
    ]
  }

  return [cardio, antimicrobials]
}

/** Demo review history so the activity heatmap isn't blank on first open — a realistic
 *  (deterministic) scatter over the last ~12 weeks. These are demo entries tied to no real
 *  card; the student's real reviews append here as they study, and the grid always counts
 *  the true contents of `reviews`. Clearing/rebuilding decks does not remove them until the
 *  student studies for real. */
function seedReviews(): ReviewEntry[] {
  const out: ReviewEntry[] = []
  const today = new Date()

  for (let daysAgo = 84; daysAgo >= 1; daysAgo--) {
    const date = new Date(today)
    date.setDate(today.getDate() - daysAgo)
    const weekend = date.getDay() === 0 || date.getDay() === 6
    // Deterministic pseudo-organic intensity (no RNG): weekdays busier, some rest days.
    const wobble = ((daysAgo * 2654435761) % 97) / 97
    const base = weekend ? 4 : 13
    const count = Math.max(0, Math.round(base * wobble * 1.7) - (wobble < 0.22 ? base : 0))

    for (let i = 0; i < count; i++) {
      const at = new Date(date)
      at.setHours(9 + (i % 12), (i * 7) % 60, 0, 0)
      out.push({ at: at.toISOString(), cardId: `seed#${daysAgo}#${i}`, rating: wobble > 0.6 ? 'good' : 'hard' })
    }
  }

  return out
}
