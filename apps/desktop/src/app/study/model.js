// Study page data model: decks + FSRS spaced-repetition scheduling + persistence.
// Scheduling is ts-fsrs (MIT) — the same FSRS algorithm modern Anki defaults to. We
// deliberately embed zero Anki code (AGPL); only the algorithm family is shared, so
// review math stays compatible with the decks students already know.
// v1 persistence is a small localStorage JSON blob (same pattern as store/onboarding);
// the upgrade path is backend/vault storage once Nemesis accounts land.
import { createEmptyCard, fsrs, Rating } from 'ts-fsrs';
const STORAGE_KEY = 'nemesis.study.v1';
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
export function loadState() {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.version === 1 && Array.isArray(parsed.decks)) {
                return parsed;
            }
        }
    }
    catch {
        // corrupted blob → fall through to a fresh seeded state
    }
    return { version: 1, decks: [seedDeck()], schedule: {}, reviews: [] };
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
/** Demo deck so the page teaches itself on first open. Application-level pharm cards, not "what is X" filler. */
function seedDeck() {
    const card = (front, back, tags) => ({ id: freshId('card'), front, back, tags });
    return {
        id: freshId('deck'),
        name: 'Cardio pharm essentials (demo)',
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
}
