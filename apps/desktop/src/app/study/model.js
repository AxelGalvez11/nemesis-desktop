// Study page data model: decks + FSRS spaced-repetition scheduling + persistence.
// Scheduling is ts-fsrs (MIT) — the same FSRS algorithm modern Anki defaults to. We
// deliberately embed zero Anki code (AGPL); only the algorithm family is shared, so
// review math stays compatible with the decks students already know.
// v1 persistence is a small localStorage JSON blob (same pattern as store/onboarding);
// the upgrade path is backend/vault storage once Nemesis accounts land.
import { createEmptyCard, fsrs, Rating } from 'ts-fsrs';
// Bumped to v2 for grouped decks + review activity. Pre-release, so discarding the old
// demo blob is fine; once real student data exists this needs a migration, not a bump.
const STORAGE_KEY = 'nemesis.study.v2';
const QUEUE_LIMIT = 200;
const scheduler = fsrs();
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
export function loadState() {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.version === 1 && Array.isArray(parsed.decks)) {
                return {
                    ...parsed,
                    reviews: (parsed.reviews ?? []).filter(review => !review.cardId.startsWith('seed#')),
                    sections: normalizeSections(parsed.sections, parsed.decks)
                };
            }
        }
    }
    catch {
        // corrupted blob → fall through to a fresh seeded state
    }
    const decks = seedDecks();
    return { version: 1, decks, sections: normalizeSections([], decks), schedule: {}, reviews: [] };
}
export function saveState(state) {
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }
    catch {
        // quota/private-mode failures are non-fatal; the session keeps working in memory
    }
}
/** Review queue: due reviews first, then new cards, capped. Pure. */
export function buildQueue(state, deckId, now) {
    const queue = [];
    for (const deck of state.decks) {
        if (deckId && deck.id !== deckId) {
            continue;
        }
        for (const card of deck.cards) {
            if (card.suspended) {
                continue;
            }
            const stored = state.schedule[card.id];
            if (isDue(stored, now)) {
                queue.push({ card, deckId: deck.id, deckName: deck.name, isNew: !stored });
            }
        }
    }
    queue.sort((a, b) => (a.isNew ? 1 : 0) - (b.isNew ? 1 : 0));
    return queue.slice(0, QUEUE_LIMIT);
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
            total++;
            if (card.suspended) {
                continue;
            }
            const stored = state.schedule[card.id];
            if (!stored) {
                fresh++;
                due++;
            }
            else if (isDue(stored, now)) {
                due++;
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
/** Delete a card AND its FSRS schedule so state doesn't leak. */
export function deleteCard(state, deckId, cardId) {
    const next = mapDeckCards(state, deckId, cards => cards.filter(card => card.id !== cardId));
    const schedule = { ...next.schedule };
    delete schedule[cardId];
    return { ...next, schedule };
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
    const schedule = { ...state.schedule };
    for (const card of deck.cards) {
        delete schedule[card.id];
    }
    return { ...state, decks: state.decks.filter(candidate => candidate.id !== deckId), schedule };
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
    const unchanged = removedIds.length === 0 && cards.length === existing.length && cards.every((card, index) => card === existing[index]);
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
    let schedule = state.schedule;
    if (prunedIds.length) {
        schedule = { ...schedule };
        for (const id of prunedIds) {
            delete schedule[id];
        }
    }
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
    const days = new Set(state.reviews.map(review => review.at.slice(0, 10)));
    const todayMs = new Date(`${todayIso.slice(0, 10)}T00:00:00.000Z`).getTime();
    // Current streak: consecutive days ending today (or yesterday, so an unstudied
    // "today so far" doesn't zero the streak before the student sits down).
    let currentStreak = 0;
    let cursor = todayMs;
    if (!days.has(new Date(cursor).toISOString().slice(0, 10))) {
        cursor -= DAY;
    }
    while (days.has(new Date(cursor).toISOString().slice(0, 10))) {
        currentStreak++;
        cursor -= DAY;
    }
    // Longest streak across all history.
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
        if (days.has(new Date(todayMs - i * DAY).toISOString().slice(0, 10))) {
            learned++;
        }
    }
    const cutoff = new Date(todayMs - 30 * DAY).toISOString();
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
/** Grade a card → next state (immutable: returns a new StudyState). */
export function gradeCard(state, cardId, rating, now) {
    const stored = state.schedule[cardId];
    const current = stored ? revive(stored) : createEmptyCard(now);
    const outcome = scheduler.repeat(current, now)[RATING[rating]];
    return {
        ...state,
        schedule: { ...state.schedule, [cardId]: freeze(outcome.card) },
        reviews: [...state.reviews, { cardId, rating, at: now.toISOString() }]
    };
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
        .sort((a, b) => (b.stats.due - a.stats.due) || a.course.localeCompare(b.course));
}
/** GitHub-style contribution grid: review counts per day for the last `weeks` weeks,
 *  laid out oldest→newest, each column a Sun-anchored week. Pure. */
export function reviewHeatmap(state, todayIso, weeks = 53) {
    const perDay = new Map();
    for (const review of state.reviews) {
        const day = review.at.slice(0, 10); // UTC calendar day from the ISO timestamp
        perDay.set(day, (perDay.get(day) ?? 0) + 1);
    }
    // Work entirely in UTC so the per-day keys (UTC) and cell dates (UTC) always agree,
    // regardless of the machine's timezone. Anchor on the UTC Sunday that starts the window.
    const DAY = 86_400_000;
    const todayUtc = new Date(`${todayIso.slice(0, 10)}T00:00:00.000Z`);
    // End the grid on this week's Saturday (so today is always in the last column, GitHub-style)
    // and start `weeks` Sundays back — columns stay Sun→Sat aligned.
    const endMs = todayUtc.getTime() + (6 - todayUtc.getUTCDay()) * DAY;
    const startMs = endMs - (weeks * 7 - 1) * DAY;
    const cells = [];
    let total = 0;
    for (let i = 0; i < weeks * 7; i++) {
        const iso = new Date(startMs + i * DAY).toISOString().slice(0, 10);
        const count = perDay.get(iso) ?? 0;
        total += count;
        cells.push({ count, date: iso, level: count === 0 ? 0 : count < 5 ? 1 : count < 12 ? 2 : count < 25 ? 3 : 4 });
    }
    return { cells, total };
}
/** Interval each grade would schedule, humanized — the hint row under the grade buttons. */
export function previewIntervals(state, cardId, now) {
    const stored = state.schedule[cardId];
    const current = stored ? revive(stored) : createEmptyCard(now);
    const outcome = scheduler.repeat(current, now);
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
