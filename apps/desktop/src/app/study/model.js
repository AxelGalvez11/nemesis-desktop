// Study page data model: decks + FSRS spaced-repetition scheduling + persistence.
// Scheduling is ts-fsrs (MIT) — the same FSRS algorithm modern Anki defaults to. We
// deliberately embed zero Anki code (AGPL); only the algorithm family is shared, so
// review math stays compatible with the decks students already know.
// v1 persistence is a small localStorage JSON blob (same pattern as store/onboarding);
// the upgrade path is backend/vault storage once Nemesis accounts land.
import { createEmptyCard, fsrs, Rating } from 'ts-fsrs';
import { clozeIndexes, clozeScheduleKey } from './cloze';
export const DEFAULT_STUDY_SETTINGS = {
    newPerDay: 20,
    reviewsPerDay: 0,
    desiredRetention: 0.9,
    order: 'due',
    flip: true,
    showIntervalHints: true
};
// Bumped to v2 for grouped decks + review activity. Pre-release, so discarding the old
// demo blob is fine; once real student data exists this needs a migration, not a bump.
const STORAGE_KEY = 'nemesis.study.v2';
const QUEUE_LIMIT = 200;
// Pre-settings flip toggle lived in its own key (see study/index.tsx); loadState
// migrates it into settings.flip once, then this key is never consulted again.
const LEGACY_FLIP_KEY = 'nemesis.study.flip';
// One FSRS scheduler per desired retention (see StudySettings.desiredRetention),
// rebuilt only when the setting changes — grading and interval previews are hot.
let scheduler = fsrs({ request_retention: DEFAULT_STUDY_SETTINGS.desiredRetention });
let schedulerRetention = DEFAULT_STUDY_SETTINGS.desiredRetention;
function schedulerFor(desiredRetention) {
    if (desiredRetention !== schedulerRetention) {
        scheduler = fsrs({ request_retention: desiredRetention });
        schedulerRetention = desiredRetention;
    }
    return scheduler;
}
const RATING = {
    again: Rating.Again,
    easy: Rating.Easy,
    good: Rating.Good,
    hard: Rating.Hard
};
/** JSON round-trips turn the FSRS Dates into strings; ts-fsrs needs real Dates back. */
function revive(stored) {
    return {
        ...stored,
        due: new Date(stored.due),
        last_review: stored.last_review ? new Date(stored.last_review) : undefined
    };
}
function freeze(card) {
    return {
        ...card,
        due: card.due.toISOString(),
        last_review: card.last_review ? card.last_review.toISOString() : undefined
    };
}
function isDue(stored, now) {
    if (!stored) {
        return true; // never studied → new → due
    }
    return new Date(stored.due).getTime() <= now.getTime();
}
/** Local calendar day key (yyyy-mm-dd). Day-based features — daily caps, the
 *  day-stable shuffle, streaks, the heatmap — follow the student's clock, so a
 *  23:30 review belongs to today, not to tomorrow's UTC date. */
export function localDayKey(date) {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}
/** The local calendar day `offset` days from `date` (constructor arithmetic —
 *  safe across month ends and DST shifts, where fixed 24h math drifts). */
function shiftLocalDay(date, offset) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset);
}
function normalizeSections(sections, decks) {
    const names = [];
    const seen = new Set();
    for (const raw of [...(sections ?? []), ...decks.map(deck => deck.course ?? '')]) {
        const name = raw.trim();
        const key = name.toLocaleLowerCase();
        if (name && key !== 'other' && !seen.has(key)) {
            names.push(name);
            seen.add(key);
        }
    }
    return names;
}
/** One-time bridge from the pre-settings flip key into settings.flip. Only that
 *  field is touched — everything else stays absent so getSettings() fills it from
 *  DEFAULT_STUDY_SETTINGS. Never overwrites an already-migrated (explicit) value. */
function migrateFlipSetting(settings) {
    if (settings?.flip !== undefined) {
        return settings;
    }
    try {
        const legacy = window.localStorage.getItem(LEGACY_FLIP_KEY);
        return legacy === null ? settings : { ...settings, flip: legacy !== 'off' };
    }
    catch {
        return settings;
    }
}
export function loadState() {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.version === 1 && Array.isArray(parsed.decks)) {
                return {
                    ...parsed,
                    reviews: (parsed.reviews ?? []).filter(review => !review.cardId.startsWith('seed#')),
                    sections: normalizeSections(parsed.sections, parsed.decks),
                    settings: migrateFlipSetting(parsed.settings)
                };
            }
        }
    }
    catch {
        // corrupted blob → fall through to a fresh seeded state
    }
    const decks = seedDecks();
    return {
        version: 1,
        decks,
        sections: normalizeSections([], decks),
        schedule: {},
        reviews: [],
        settings: migrateFlipSetting(undefined)
    };
}
export function saveState(state) {
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }
    catch {
        // quota/private-mode failures are non-fatal; the session keeps working in memory
    }
}
// --- Study settings (daily caps, review order, flip, hints) ------------------
/** Effective settings — always fully populated, even for old/partial blobs.
 *  Callers should never read state.settings directly. */
export function getSettings(state) {
    return { ...DEFAULT_STUDY_SETTINGS, ...state.settings };
}
/** Patch one or more settings fields. Pure — returns a new StudyState. */
export function setSettings(state, patch) {
    return { ...state, settings: { ...getSettings(state), ...patch } };
}
// --- Review queue --------------------------------------------------------------
/** Tiny deterministic string hash (FNV-1a) → a stable pseudo-random rank. */
function hashSeed(key) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) {
        hash ^= key.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}
/** Deterministic per-item order for a local day key: each item's rank comes from
 *  hashing (dayKey, its own schedule key), never from the other cards in the queue —
 *  so grading a card away doesn't reshuffle the rest (a plain Fisher-Yates reseeded
 *  on every shrinking queue would: the same seed applied to an (n-1)-length array
 *  is a different permutation, not "the old one minus a card"). A fresh dayKey
 *  gives every card a fresh rank the next day. */
function orderForDay(items, dayKey) {
    return [...items].sort((a, b) => hashSeed(`${dayKey}:${a.scheduleKey}`) - hashSeed(`${dayKey}:${b.scheduleKey}`));
}
/** New-vs-review split of everything graded on `dayKey` (local yyyy-mm-dd, see
 *  localDayKey). An entry counts as "new" the first time its cardId ever appears
 *  in the log — matching the isNew: !stored rule below — and as a "review" every
 *  time after that. */
function todayActivity(reviews, dayKey) {
    const seenBefore = new Set();
    let newCount = 0;
    let reviewCount = 0;
    for (const entry of reviews) {
        const isFirstEver = !seenBefore.has(entry.cardId);
        seenBefore.add(entry.cardId);
        if (localDayKey(new Date(entry.at)) !== dayKey) {
            continue;
        }
        if (isFirstEver) {
            newCount++;
        }
        else {
            reviewCount++;
        }
    }
    return { newCount, reviewCount };
}
/** A card's schedule slots: the card itself, or one slot per distinct cloze
 *  index — each drilled and scheduled independently (Anki cloze semantics). */
function scheduleTargets(card) {
    const indexes = clozeIndexes(card.front);
    if (!indexes.length) {
        return [{ key: card.id }];
    }
    return indexes.map(index => ({ clozeIndex: index, key: clozeScheduleKey(card.id, index) }));
}
/** Review queue: due reviews first, then new cards (or a day-stable shuffle of
 *  both, in 'random' order), capped by today's new/review daily limits. Pure. */
export function buildQueue(state, deckId, now) {
    const settings = getSettings(state);
    const dayKey = localDayKey(now);
    const { newCount, reviewCount } = todayActivity(state.reviews, dayKey);
    const dueItems = [];
    const newItems = [];
    for (const deck of state.decks) {
        if (deckId && deck.id !== deckId) {
            continue;
        }
        for (const card of deck.cards) {
            if (card.suspended) {
                continue;
            }
            for (const target of scheduleTargets(card)) {
                const stored = state.schedule[target.key];
                if (!isDue(stored, now)) {
                    continue;
                }
                const item = {
                    card,
                    clozeIndex: target.clozeIndex,
                    deckId: deck.id,
                    deckName: deck.name,
                    isNew: !stored,
                    scheduleKey: target.key
                };
                (item.isNew ? newItems : dueItems).push(item);
            }
        }
    }
    const newCap = settings.newPerDay > 0 ? Math.max(0, settings.newPerDay - newCount) : newItems.length;
    const reviewCap = settings.reviewsPerDay > 0 ? Math.max(0, settings.reviewsPerDay - reviewCount) : dueItems.length;
    const capped = [...dueItems.slice(0, reviewCap), ...newItems.slice(0, newCap)];
    const ordered = settings.order === 'random' ? orderForDay(capped, dayKey) : capped;
    return ordered.slice(0, QUEUE_LIMIT);
}
export function deckStats(state, deckId, now) {
    let due = 0;
    let fresh = 0;
    let total = 0;
    for (const deck of state.decks) {
        if (deckId && deck.id !== deckId) {
            continue;
        }
        for (const card of deck.cards) {
            const targets = scheduleTargets(card);
            total += targets.length;
            if (card.suspended) {
                continue;
            }
            for (const target of targets) {
                const stored = state.schedule[target.key];
                if (!stored) {
                    fresh++;
                    due++;
                }
                else if (isDue(stored, now)) {
                    due++;
                }
            }
        }
    }
    return { due, fresh, total };
}
// --- Card management (Anki-style browser/editor backing) -------------------
function mapDeckCards(state, deckId, map) {
    return {
        ...state,
        decks: state.decks.map(deck => (deck.id === deckId ? { ...deck, cards: map(deck.cards) } : deck))
    };
}
export function updateCard(state, deckId, card) {
    return mapDeckCards(state, deckId, cards => cards.map(existing => (existing.id === card.id ? card : existing)));
}
export function addCard(state, deckId, front, back, tags) {
    const card = { back, front, id: freshId('card'), tags };
    return mapDeckCards(state, deckId, cards => [...cards, card]);
}
/** Drop schedule entries for the given card ids — each card's own key AND any
 *  of its cloze slots (`${id}#c${n}`). Returns a fresh map. */
function pruneCardSchedules(schedule, cardIds) {
    const ids = new Set(cardIds);
    const next = {};
    for (const [key, entry] of Object.entries(schedule)) {
        const at = key.indexOf('#c');
        const baseId = at >= 0 ? key.slice(0, at) : key;
        if (!ids.has(baseId)) {
            next[key] = entry;
        }
    }
    return next;
}
/** Delete a card AND its FSRS schedule (incl. cloze slots) so state doesn't leak. */
export function deleteCard(state, deckId, cardId) {
    const next = mapDeckCards(state, deckId, cards => cards.filter(card => card.id !== cardId));
    return { ...next, schedule: pruneCardSchedules(next.schedule, [cardId]) };
}
export function toggleSuspendCard(state, deckId, cardId) {
    return mapDeckCards(state, deckId, cards => cards.map(card => (card.id === cardId ? { ...card, suspended: !card.suspended } : card)));
}
// --- Deck management ---------------------------------------------------------
/** Delete a deck and its cards' schedules. The review log keeps its history —
 *  streaks and the heatmap don't lie just because a deck was retired. */
export function deleteDeck(state, deckId) {
    const deck = state.decks.find(candidate => candidate.id === deckId);
    if (!deck) {
        return state;
    }
    return {
        ...state,
        decks: state.decks.filter(candidate => candidate.id !== deckId),
        schedule: pruneCardSchedules(state.schedule, deck.cards.map(card => card.id))
    };
}
export function addSection(state, name) {
    const section = name.trim();
    if (!section ||
        section.toLocaleLowerCase() === 'other' ||
        state.sections.some(existing => existing.toLocaleLowerCase() === section.toLocaleLowerCase())) {
        return state;
    }
    return { ...state, sections: [...state.sections, section] };
}
export function assignDeckSection(state, deckId, section) {
    const course = section.trim() || undefined;
    return {
        ...state,
        decks: state.decks.map(deck => (deck.id === deckId ? { ...deck, course } : deck))
    };
}
/** Rename a deck. For file-backed decks pass the renamed vault file name so the
 *  next reconcile matches it instead of treating the old link as deleted — the
 *  caller renames the actual file FIRST (see the Study rename dialog), so state
 *  only changes once the disk rename succeeded. */
export function renameDeck(state, deckId, name, sourceFile) {
    return {
        ...state,
        decks: state.decks.map(deck => deck.id === deckId ? { ...deck, name, ...(sourceFile ? { sourceFile } : {}) } : deck)
    };
}
// --- Deck-file reconcile (agent-managed decks) --------------------------------
// The vault's Flashcards folder is the source of truth for agent-written decks:
// the agent renames, edits, and deletes deck files while organizing, and Study
// mirrors that here — without losing FSRS review progress, because cards keep
// their ids (the schedule key) whenever their text survives the file edit.
/** Keep in sync with the deck-file extension filter in deck-files.ts. */
const DECK_FILE_EXTENSION = /\.(tsv|txt|md)$/i;
/** A vanished file and a new file that share at least half their cards are the
 *  same deck, renamed — relink it instead of wiping its review history. */
const RENAME_OVERLAP_MIN = 0.5;
/** Cards match across file edits by text, not id (case-insensitive, trimmed). */
function cardKey(front, back) {
    return `${front.trim().toLocaleLowerCase()}\u0000${back.trim().toLocaleLowerCase()}`;
}
/** Shared-card fraction (0..1) between a deck and a candidate, multiset-aware. */
function renameScore(deck, candidate) {
    if (!deck.cards.length || !candidate.cards.length) {
        return 0;
    }
    const counts = new Map();
    for (const card of deck.cards) {
        const key = cardKey(card.front, card.back);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let shared = 0;
    for (const card of candidate.cards) {
        const key = cardKey(card.front, card.back);
        const left = counts.get(key) ?? 0;
        if (left > 0) {
            counts.set(key, left - 1);
            shared++;
        }
    }
    return shared / Math.max(deck.cards.length, candidate.cards.length);
}
/** File cards → deck cards. Text-matched cards keep their StudyCard (id, tags,
 *  suspended — and therefore their schedule entry); file text wins on case or
 *  whitespace drift; new cards get fresh ids; dropped cards are reported so the
 *  caller can prune their schedules. Returns the same array when nothing changed. */
function reconcileCards(existing, parsed) {
    const pool = new Map();
    for (const card of existing) {
        const key = cardKey(card.front, card.back);
        const queue = pool.get(key);
        if (queue) {
            queue.push(card);
        }
        else {
            pool.set(key, [card]);
        }
    }
    const cards = parsed.map((entry) => {
        const match = pool.get(cardKey(entry.front, entry.back))?.shift();
        if (!match) {
            return { back: entry.back, front: entry.front, id: freshId('card'), tags: [] };
        }
        return match.front === entry.front && match.back === entry.back
            ? match
            : { ...match, back: entry.back, front: entry.front };
    });
    const removedIds = [...pool.values()].flat().map(card => card.id);
    const unchanged = removedIds.length === 0 &&
        cards.length === existing.length &&
        cards.every((card, index) => card === existing[index]);
    return { cards: unchanged ? existing : cards, removedIds };
}
/** Reconcile agent-managed decks against the vault's deck files. Pure.
 *  - candidate with a linked deck (`sourceFile`) → update name/course/cards in place
 *  - candidate with no linked deck → relink a renamed deck when the cards overlap,
 *    else import it fresh (skipping files with no parseable cards, like the old import)
 *  - linked deck whose file is gone → remove it and prune its cards' schedules
 *  - decks without `sourceFile` (made in-app) are never touched
 *  Returns the same state reference when the files already match, so callers can
 *  skip persistence. */
export function reconcileDeckFiles(state, candidates) {
    const byFile = new Map(candidates.map(candidate => [candidate.fileName, candidate]));
    const linkedFiles = new Set();
    for (const deck of state.decks) {
        if (deck.sourceFile) {
            linkedFiles.add(deck.sourceFile);
        }
    }
    const decks = [];
    const orphans = [];
    const prunedIds = [];
    let changed = false;
    for (const deck of state.decks) {
        if (!deck.sourceFile) {
            decks.push(deck);
            continue;
        }
        const candidate = byFile.get(deck.sourceFile);
        if (!candidate) {
            // File gone — deleted, unless a new file below claims it as a rename.
            orphans.push(deck);
            continue;
        }
        const { cards, removedIds } = reconcileCards(deck.cards, candidate.cards);
        const course = candidate.course?.trim() || undefined;
        if (cards === deck.cards && deck.name === candidate.name && deck.course === course) {
            decks.push(deck);
            continue;
        }
        decks.push({ ...deck, cards, course, name: candidate.name });
        prunedIds.push(...removedIds);
        changed = true;
    }
    for (const candidate of candidates) {
        if (linkedFiles.has(candidate.fileName)) {
            continue;
        }
        let renamedAt = -1;
        let bestScore = 0;
        for (let index = 0; index < orphans.length; index++) {
            const score = renameScore(orphans[index], candidate);
            if (score > bestScore) {
                bestScore = score;
                renamedAt = index;
            }
        }
        if (renamedAt >= 0 && bestScore >= RENAME_OVERLAP_MIN) {
            const [renamed] = orphans.splice(renamedAt, 1);
            const { cards, removedIds } = reconcileCards(renamed.cards, candidate.cards);
            decks.push({
                ...renamed,
                cards,
                course: candidate.course?.trim() || undefined,
                name: candidate.name,
                sourceFile: candidate.fileName
            });
            prunedIds.push(...removedIds);
            changed = true;
            continue;
        }
        if (!candidate.cards.length) {
            continue;
        }
        decks.push({
            cards: candidate.cards.map(card => ({ back: card.back, front: card.front, id: freshId('card'), tags: [] })),
            course: candidate.course?.trim() || undefined,
            createdAt: new Date().toISOString(),
            id: freshId('deck'),
            name: candidate.name,
            sourceFile: candidate.fileName
        });
        changed = true;
    }
    for (const deck of orphans) {
        prunedIds.push(...deck.cards.map(card => card.id));
        changed = true;
    }
    if (!changed) {
        return state;
    }
    const schedule = prunedIds.length ? pruneCardSchedules(state.schedule, prunedIds) : state.schedule;
    // Same section rules as everywhere else: new courses appear, manually-added
    // (now empty) sections stay. The review log keeps its history — see deleteDeck.
    return { ...state, decks, schedule, sections: normalizeSections(state.sections, decks) };
}
/** One-time bridge for decks imported before `sourceFile` existed: the legacy
 *  import-once registry knows which file names were auto-imported, so relink each
 *  to the (still unlinked) deck carrying that import's default name. Without this,
 *  the first reconcile would see every already-imported file as brand new and
 *  duplicate the deck. Pure; returns the same reference when nothing to adopt. */
export function adoptLegacyDeckFiles(state, importedFileNames) {
    let decks = state.decks;
    let changed = false;
    for (const fileName of importedFileNames) {
        if (decks.some(deck => deck.sourceFile === fileName)) {
            continue;
        }
        const name = fileName.replace(DECK_FILE_EXTENSION, '');
        const at = decks.findIndex(deck => !deck.sourceFile && deck.name === name);
        if (at < 0) {
            continue;
        }
        decks = decks.map((deck, index) => (index === at ? { ...deck, sourceFile: fileName } : deck));
        changed = true;
    }
    return changed ? { ...state, decks } : state;
}
export function studyMotivation(state, todayIso, windowDays = 90) {
    const DAY = 86_400_000;
    const days = new Set(state.reviews.map(review => localDayKey(new Date(review.at))));
    const today = new Date(todayIso);
    // Current streak: consecutive local days ending today (or yesterday, so an
    // unstudied "today so far" doesn't zero the streak before the student sits down).
    let currentStreak = 0;
    let offset = days.has(localDayKey(today)) ? 0 : -1;
    while (days.has(localDayKey(shiftLocalDay(today, offset)))) {
        currentStreak++;
        offset--;
    }
    // Longest streak across all history. Keys are local calendar dates; parsing
    // them at UTC midnight is a pure calendar trick — consecutive dates sit
    // exactly one DAY apart in that mapping, whatever the machine's timezone.
    const sorted = [...days].sort();
    let longestStreak = 0;
    let run = 0;
    let previous = Number.NaN;
    for (const day of sorted) {
        const ms = new Date(`${day}T00:00:00.000Z`).getTime();
        run = ms - previous === DAY ? run + 1 : 1;
        previous = ms;
        longestStreak = Math.max(longestStreak, run);
    }
    let learned = 0;
    for (let i = 0; i < windowDays; i++) {
        if (days.has(localDayKey(shiftLocalDay(today, -i)))) {
            learned++;
        }
    }
    const cutoff = shiftLocalDay(today, -30).toISOString();
    const recent = state.reviews.filter(review => review.at >= cutoff);
    const retentionPct = recent.length
        ? Math.round((recent.filter(review => review.rating !== 'again').length / recent.length) * 100)
        : null;
    return {
        currentStreak,
        daysLearnedPct: Math.round((learned / windowDays) * 100),
        longestStreak,
        retentionPct
    };
}
// Anki leech semantics: a card that keeps lapsing is wasting review time. Once
// its lapse count reaches the threshold it is auto-suspended and tagged so the
// student rewrites (or re-learns) it before it re-enters the queue. Suspension
// is per-card here, so a leeched cloze slot parks its whole parent card.
const LEECH_LAPSES = 8;
export const LEECH_TAG = 'leech';
function applyLeech(state, scheduleKey) {
    const at = scheduleKey.indexOf('#c');
    const cardId = at >= 0 ? scheduleKey.slice(0, at) : scheduleKey;
    return {
        ...state,
        decks: state.decks.map(deck => {
            const card = deck.cards.find(candidate => candidate.id === cardId);
            if (!card || card.suspended) {
                return deck;
            }
            return {
                ...deck,
                cards: deck.cards.map(candidate => candidate.id === cardId
                    ? {
                        ...candidate,
                        suspended: true,
                        tags: candidate.tags.includes(LEECH_TAG) ? candidate.tags : [...candidate.tags, LEECH_TAG]
                    }
                    : candidate)
            };
        })
    };
}
/** Grade a card (or one cloze slot) → next state (immutable). `scheduleKey` is
 *  the queue item's schedule key (QueueItem.scheduleKey). A lapse that crosses
 *  the leech threshold auto-suspends + tags the card (see applyLeech). */
export function gradeCard(state, scheduleKey, rating, now) {
    const stored = state.schedule[scheduleKey];
    const current = stored ? revive(stored) : createEmptyCard(now);
    const outcome = schedulerFor(getSettings(state).desiredRetention).repeat(current, now)[RATING[rating]];
    const next = {
        ...state,
        schedule: { ...state.schedule, [scheduleKey]: freeze(outcome.card) },
        reviews: [...state.reviews, { cardId: scheduleKey, rating, at: now.toISOString() }]
    };
    // Only a real lapse (one that increments the count) can newly cross the
    // threshold — re-grading an unsuspended old leech as Good must not re-park it.
    return outcome.card.lapses > current.lapses && outcome.card.lapses >= LEECH_LAPSES
        ? applyLeech(next, scheduleKey)
        : next;
}
/** Reverse the most recent gradeCard: restore the pre-grade schedule snapshot
 *  and pop that review-log entry. Deliberately session-only — the snapshot lives
 *  in component state, never in the persisted blob, so it cannot survive a
 *  reload. Leech suspension is not reverted (matching Anki, where unsuspending
 *  is an explicit act in the browser). */
export function undoLastGrade(state, undo) {
    const last = state.reviews.at(-1);
    if (!last || last.cardId !== undo.scheduleKey) {
        return state; // something else was graded since the snapshot — refuse quietly
    }
    const schedule = { ...state.schedule };
    if (undo.previous) {
        schedule[undo.scheduleKey] = undo.previous;
    }
    else {
        delete schedule[undo.scheduleKey];
    }
    return { ...state, reviews: state.reviews.slice(0, -1), schedule };
}
/** Group decks by course (the "folder"). Ungrouped decks fall under "Other". Pure. */
export function groupDecks(state, now) {
    const byCourse = new Map();
    const canonicalNames = new Map();
    for (const section of state.sections) {
        const name = section.trim();
        if (name) {
            byCourse.set(name, []);
            canonicalNames.set(name.toLocaleLowerCase(), name);
        }
    }
    for (const deck of state.decks) {
        const course = deck.course?.trim();
        const normalized = course?.toLocaleLowerCase();
        const key = !course || normalized === 'other' ? 'Other' : (canonicalNames.get(course.toLocaleLowerCase()) ?? course);
        const list = byCourse.get(key) ?? [];
        list.push(deck);
        byCourse.set(key, list);
    }
    return [...byCourse.entries()]
        .map(([course, decks]) => ({
        course,
        decks,
        stats: decks.reduce((sum, deck) => {
            const s = deckStats(state, deck.id, now);
            return { due: sum.due + s.due, fresh: sum.fresh + s.fresh, total: sum.total + s.total };
        }, { due: 0, fresh: 0, total: 0 })
    }))
        .sort((a, b) => b.stats.due - a.stats.due || a.course.localeCompare(b.course));
}
/** Rolling GitHub-style contribution window: exactly `weeks` weeks ending today,
 *  laid out oldest→newest. The view supplies blank leading cells to keep the
 *  dates aligned with Sunday-anchored columns. Pure. */
export function reviewHeatmap(state, todayIso, weeks = 52) {
    const perDay = new Map();
    for (const review of state.reviews) {
        const day = localDayKey(new Date(review.at)); // the student's calendar day
        perDay.set(day, (perDay.get(day) ?? 0) + 1);
    }
    // Work entirely in the machine's LOCAL calendar so the per-day keys and cell
    // dates always agree with the daily caps and streaks (localDayKey everywhere).
    // Do not pad forward to Saturday: the rolling window ends on today, so no
    // future cells displace an older month.
    const today = new Date(todayIso);
    const dayCount = weeks * 7;
    const cells = [];
    let total = 0;
    for (let i = dayCount - 1; i >= 0; i--) {
        const iso = localDayKey(shiftLocalDay(today, -i));
        const count = perDay.get(iso) ?? 0;
        total += count;
        cells.push({ count, date: iso, level: count === 0 ? 0 : count < 5 ? 1 : count < 12 ? 2 : count < 25 ? 3 : 4 });
    }
    return { cells, total };
}
/** Interval each grade would schedule, humanized — the hint row under the grade buttons. */
export function previewIntervals(state, scheduleKey, now) {
    const stored = state.schedule[scheduleKey];
    const current = stored ? revive(stored) : createEmptyCard(now);
    const outcome = schedulerFor(getSettings(state).desiredRetention).repeat(current, now);
    const label = (grade) => humanizeGap(outcome[grade].card.due.getTime() - now.getTime());
    return {
        again: label(Rating.Again),
        easy: label(Rating.Easy),
        good: label(Rating.Good),
        hard: label(Rating.Hard)
    };
}
function humanizeGap(ms) {
    const minutes = Math.max(1, Math.round(ms / 60_000));
    if (minutes < 60) {
        return `${minutes}m`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
        return `${hours}h`;
    }
    const days = Math.round(hours / 24);
    if (days < 31) {
        return `${days}d`;
    }
    return `${Math.round(days / 30)}mo`;
}
let idCounter = 0;
export function freshId(prefix) {
    idCounter += 1;
    return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}
/** Demo decks across two courses so the page (and its grouping) teaches itself on first open.
 *  Application-level pharm cards, not "what is X" filler. */
function seedDecks() {
    const card = (front, back, tags) => ({ id: freshId('card'), front, back, tags });
    const cardio = {
        id: freshId('deck'),
        name: 'Cardio pharm essentials',
        course: 'Pharmacology',
        createdAt: new Date().toISOString(),
        cards: [
            card('A patient on lisinopril develops a persistent dry cough. What is the mechanism, and what class do you switch to?', 'ACE inhibition lets bradykinin accumulate in the airways → cough. Switch to an ARB (e.g. losartan): blocks AT1 directly, spares bradykinin degradation.', ['ace-inhibitors', 'adverse-effects']),
            card('Why are ACE inhibitors contraindicated in pregnancy?', 'Fetal renal toxicity (oligohydramnios, renal dysgenesis) — all RAAS blockers are contraindicated.', ['ace-inhibitors', 'contraindications']),
            card('What two labs do you check after starting an ACE inhibitor, and why?', 'Potassium (hyperkalemia risk) and serum creatinine (efferent-arteriole dilation can drop GFR, especially with renal artery stenosis).', ['ace-inhibitors', 'monitoring']),
            card('Furosemide vs hydrochlorothiazide: site of action and the classic electrolyte signature of each.', 'Furosemide — thick ascending limb (Na-K-2Cl); potent, causes hypokalemia + hypocalcemia. HCTZ — distal tubule (Na-Cl); milder, hypokalemia + HYPERcalcemia.', ['diuretics']),
            card('A heart-failure patient on spironolactone and lisinopril has K⁺ 6.1. Which drug interaction explains it?', 'Both raise potassium: aldosterone antagonism (spironolactone) + reduced aldosterone via ACE inhibition. Additive hyperkalemia — hold/adjust and recheck.', ['heart-failure', 'interactions']),
            card('Metoprolol is preferred over propranolol in an asthmatic patient who needs a beta blocker. Why?', 'Metoprolol is β1-selective at usual doses — less β2 bronchoconstriction. Propranolol is non-selective and can trigger bronchospasm.', ['beta-blockers']),
            card('Which statin adverse effect do you screen for when a patient reports new diffuse muscle pain, and with what lab?', 'Myopathy/rhabdomyolysis — check creatine kinase (CK). Risk rises with interacting CYP3A4 inhibitors (e.g. clarithromycin) and high-intensity dosing.', ['statins', 'monitoring']),
            card('Warfarin patient starts TMP-SMX for a UTI. What happens to the INR and why?', 'INR rises — TMP-SMX inhibits CYP2C9 (warfarin metabolism) and displaces protein binding. Bleeding risk: monitor INR closely or pick another agent.', ['anticoagulants', 'interactions'])
        ]
    };
    const antimicrobials = {
        id: freshId('deck'),
        name: 'Antimicrobial pearls',
        course: 'Infectious disease',
        createdAt: new Date().toISOString(),
        cards: [
            card('Why is vancomycin trough (or AUC) monitoring required, and what toxicity does it guard against?', 'Narrow therapeutic window — nephrotoxicity (and, classically, ototoxicity). AUC/MIC ≥ 400 targets efficacy while limiting kidney injury.', ['vancomycin', 'monitoring']),
            card('A patient on ciprofloxacin should avoid taking it with what common products, and why?', 'Di/trivalent cations — antacids, calcium, iron, dairy — chelate fluoroquinolones and slash absorption. Separate doses by 2-6 hours.', ['fluoroquinolones', 'interactions']),
            card('Which antibiotic class carries a disulfiram-like reaction with alcohol, and name the prototype.', 'Nitroimidazoles — metronidazole. Alcohol → flushing, nausea, tachycardia. Counsel to avoid alcohol during and 3 days after.', ['metronidazole', 'counseling']),
            card('Cell-wall synthesis inhibitor vs protein-synthesis inhibitor: which bucket do beta-lactams vs macrolides fall in?', 'Beta-lactams (penicillins, cephalosporins) inhibit cell-wall synthesis. Macrolides (azithromycin) bind the 50S ribosome to block protein synthesis.', ['mechanisms'])
        ]
    };
    return [cardio, antimicrobials];
}
