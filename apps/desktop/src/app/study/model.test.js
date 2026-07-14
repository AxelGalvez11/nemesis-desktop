// reconcileDeckFiles is what lets the agent reorganize the vault's Flashcards folder
// (rename files, edit cards, change course headers, delete decks) without the Study
// page drifting — and, critically, without torching FSRS review progress. These tests
// pin that contract.
import { beforeEach, describe, expect, it } from 'vitest';
import { adoptLegacyDeckFiles, buildQueue, deckStats, DEFAULT_STUDY_SETTINGS, deleteCard, getSettings, gradeCard, LEECH_TAG, loadState, localDayKey, reconcileDeckFiles, renameDeck, reviewHeatmap, saveState, setSettings, undoLastGrade } from './model';
function card(id, front, back, extra = {}) {
    return { back, front, id, tags: [], ...extra };
}
function deck(overrides) {
    return { cards: [], createdAt: '2026-07-01T00:00:00.000Z', ...overrides };
}
function state(decks, overrides = {}) {
    return { decks, reviews: [], schedule: {}, sections: [], version: 1, ...overrides };
}
function candidate(fileName, cards, course) {
    return { cards, course, fileName, name: fileName.replace(/\.(tsv|txt|md)$/i, '') };
}
// Only the schedule KEY matters to reconcile; the FSRS payload is opaque to it.
function scheduled() {
    return { due: '2026-07-09T00:00:00.000Z' };
}
// Day-based features key on the LOCAL calendar (localDayKey), so these tests
// build instants with the local Date constructor — a hardcoded UTC string
// would land on different days depending on the machine's timezone.
describe('localDayKey', () => {
    it('keys a 23:30 local time to that local calendar date, not the next UTC day', () => {
        expect(localDayKey(new Date(2026, 6, 10, 23, 30))).toBe('2026-07-10');
    });
    it('pads single-digit months and days', () => {
        expect(localDayKey(new Date(2026, 0, 5, 8, 0))).toBe('2026-01-05');
    });
});
describe('reviewHeatmap', () => {
    const todayIso = new Date(2026, 5, 10, 18, 30).toISOString();
    it('renders exactly 52 rolling weeks and ends on today without future padding', () => {
        const result = reviewHeatmap(state([]), todayIso);
        expect(result.cells).toHaveLength(52 * 7);
        expect(result.cells[0]?.date).toBe('2025-06-12');
        expect(result.cells.at(-1)?.date).toBe('2026-06-10');
    });
    it('keeps reviews on both ends of the rolling window and excludes the day before it', () => {
        const result = reviewHeatmap(state([], {
            reviews: [
                { at: new Date(2025, 5, 11, 23, 59).toISOString(), cardId: 'too-old', rating: 'good' },
                { at: new Date(2025, 5, 12, 0, 1).toISOString(), cardId: 'first', rating: 'good' },
                { at: new Date(2026, 5, 10, 23, 59).toISOString(), cardId: 'today', rating: 'easy' }
            ]
        }), todayIso);
        expect(result.total).toBe(2);
        expect(result.cells[0]?.count).toBe(1);
        expect(result.cells.at(-1)?.count).toBe(1);
    });
    it('counts a 23:30 local review toward that local day, not the next UTC day', () => {
        const result = reviewHeatmap(state([], { reviews: [{ at: new Date(2026, 5, 10, 23, 30).toISOString(), cardId: 'late', rating: 'good' }] }), new Date(2026, 5, 10, 23, 45).toISOString());
        expect(result.cells.at(-1)?.date).toBe('2026-06-10');
        expect(result.cells.at(-1)?.count).toBe(1);
    });
});
describe('reconcileDeckFiles', () => {
    it('imports a new deck file with fresh ids and files it under its course', () => {
        const before = state([]);
        const after = reconcileDeckFiles(before, [
            candidate('Renal pharm.tsv', [{ back: 'loop diuretic', front: 'furosemide' }], 'Pharmacology')
        ]);
        expect(after).not.toBe(before);
        expect(after.decks).toHaveLength(1);
        const added = after.decks[0];
        expect(added.sourceFile).toBe('Renal pharm.tsv');
        expect(added.name).toBe('Renal pharm');
        expect(added.course).toBe('Pharmacology');
        expect(added.cards).toHaveLength(1);
        expect(added.cards[0].id).toBeTruthy();
        expect(after.sections).toContain('Pharmacology');
    });
    it('skips files with no parseable cards, like the old import', () => {
        const before = state([]);
        expect(reconcileDeckFiles(before, [candidate('Empty.tsv', [])])).toBe(before);
    });
    it('returns the same reference when files already match the decks', () => {
        const linked = deck({
            cards: [card('card-a', 'Q1', 'A1')],
            course: 'Pharmacology',
            id: 'deck-1',
            name: 'Cardio',
            sourceFile: 'Cardio.tsv'
        });
        const before = state([linked], { sections: ['Pharmacology'] });
        const after = reconcileDeckFiles(before, [candidate('Cardio.tsv', [{ back: 'A1', front: 'Q1' }], 'Pharmacology')]);
        expect(after).toBe(before);
    });
    it('relinks a renamed file to its deck and keeps the review schedule', () => {
        const linked = deck({
            cards: [card('card-a', 'Q1', 'A1'), card('card-b', 'Q2', 'A2')],
            course: 'Pharmacology',
            id: 'deck-1',
            name: 'Cardio',
            sourceFile: 'Cardio.tsv'
        });
        const before = state([linked], { schedule: { 'card-a': scheduled() }, sections: ['Pharmacology'] });
        const after = reconcileDeckFiles(before, [
            candidate('Cardio essentials.tsv', [
                { back: 'A1', front: 'Q1' },
                { back: 'A2', front: 'Q2' }
            ], 'Pharmacology')
        ]);
        expect(after.decks).toHaveLength(1);
        expect(after.decks[0].id).toBe('deck-1');
        expect(after.decks[0].name).toBe('Cardio essentials');
        expect(after.decks[0].sourceFile).toBe('Cardio essentials.tsv');
        expect(after.decks[0].cards.map(c => c.id)).toEqual(['card-a', 'card-b']);
        expect(after.schedule['card-a']).toBeDefined();
    });
    it('rename with card edits keeps surviving ids and prunes the dropped ones', () => {
        const linked = deck({
            cards: [card('card-a', 'Q1', 'A1'), card('card-b', 'Q2', 'A2'), card('card-c', 'Q3', 'A3')],
            id: 'deck-1',
            name: 'Old name',
            sourceFile: 'Old name.tsv'
        });
        const before = state([linked], { schedule: { 'card-a': scheduled(), 'card-c': scheduled() } });
        const after = reconcileDeckFiles(before, [
            candidate('New name.tsv', [
                { back: 'A1', front: 'Q1' },
                { back: 'A2', front: 'Q2' },
                { back: 'A8', front: 'Q8' }
            ])
        ]);
        expect(after.decks).toHaveLength(1);
        expect(after.decks[0].id).toBe('deck-1');
        expect(after.decks[0].sourceFile).toBe('New name.tsv');
        expect(after.decks[0].cards.slice(0, 2).map(c => c.id)).toEqual(['card-a', 'card-b']);
        expect(after.decks[0].cards[2].id).not.toBe('card-c');
        expect(after.schedule['card-a']).toBeDefined();
        expect(after.schedule['card-c']).toBeUndefined();
    });
    it('treats a mostly-different new file as delete + fresh import, not a rename', () => {
        const linked = deck({
            cards: [card('card-a', 'Q1', 'A1'), card('card-b', 'Q2', 'A2'), card('card-c', 'Q3', 'A3')],
            id: 'deck-1',
            name: 'Old name',
            sourceFile: 'Old name.tsv'
        });
        const before = state([linked], { schedule: { 'card-a': scheduled() } });
        const after = reconcileDeckFiles(before, [
            candidate('Fresh.tsv', [
                { back: 'A1', front: 'Q1' },
                { back: 'A5', front: 'Q5' },
                { back: 'A6', front: 'Q6' },
                { back: 'A7', front: 'Q7' }
            ])
        ]);
        expect(after.decks).toHaveLength(1);
        expect(after.decks[0].id).not.toBe('deck-1');
        expect(after.decks[0].sourceFile).toBe('Fresh.tsv');
        expect(after.schedule['card-a']).toBeUndefined();
    });
    it('a changed course header regroups the deck and keeps the old section around', () => {
        const linked = deck({
            cards: [card('card-a', 'Q1', 'A1')],
            course: 'Pharmacology',
            id: 'deck-1',
            name: 'Cardio',
            sourceFile: 'Cardio.tsv'
        });
        const before = state([linked], { sections: ['Pharmacology'] });
        const after = reconcileDeckFiles(before, [
            candidate('Cardio.tsv', [{ back: 'A1', front: 'Q1' }], 'Infectious disease')
        ]);
        expect(after.decks[0].course).toBe('Infectious disease');
        expect(after.decks[0].id).toBe('deck-1');
        expect(after.sections).toContain('Infectious disease');
        // Manually-added (now empty) sections survive reconcile.
        expect(after.sections).toContain('Pharmacology');
    });
    it('edited cards keep ids for unchanged text and prune removed schedules', () => {
        const linked = deck({
            cards: [card('card-keep', 'Q1', 'A1'), card('card-drop', 'Q2', 'A2')],
            id: 'deck-1',
            name: 'Cardio',
            sourceFile: 'Cardio.tsv'
        });
        const before = state([linked], { schedule: { 'card-drop': scheduled(), 'card-keep': scheduled() } });
        const after = reconcileDeckFiles(before, [
            candidate('Cardio.tsv', [
                { back: 'A1', front: 'Q1' },
                { back: 'A3', front: 'Q3' }
            ])
        ]);
        const cards = after.decks[0].cards;
        expect(cards).toHaveLength(2);
        expect(cards[0].id).toBe('card-keep');
        expect(cards[1].id).not.toBe('card-drop');
        expect(after.schedule['card-keep']).toBeDefined();
        expect(after.schedule['card-drop']).toBeUndefined();
        expect(after.schedule[cards[1].id]).toBeUndefined();
    });
    it('matches card text case-insensitively and trimmed, adopting the file text', () => {
        const linked = deck({
            cards: [card('card-a', '  LISINOPRIL ', 'ACE inhibitor', { suspended: true, tags: ['bp'] })],
            id: 'deck-1',
            name: 'Cardio',
            sourceFile: 'Cardio.tsv'
        });
        const before = state([linked], { schedule: { 'card-a': scheduled() } });
        const after = reconcileDeckFiles(before, [
            candidate('Cardio.tsv', [{ back: 'ACE inhibitor', front: 'lisinopril' }])
        ]);
        const updated = after.decks[0].cards[0];
        expect(updated.id).toBe('card-a');
        expect(updated.front).toBe('lisinopril');
        // In-app card state rides along with the id.
        expect(updated.suspended).toBe(true);
        expect(updated.tags).toEqual(['bp']);
        expect(after.schedule['card-a']).toBeDefined();
    });
    it('a deleted file removes its deck and prunes the schedule, sparing user decks', () => {
        const linked = deck({
            cards: [card('card-a', 'Q1', 'A1')],
            id: 'deck-file',
            name: 'Cardio',
            sourceFile: 'Cardio.tsv'
        });
        const mine = deck({ cards: [card('card-mine', 'Q9', 'A9')], id: 'deck-mine', name: 'My own deck' });
        const before = state([linked, mine], {
            reviews: [{ at: '2026-07-08T12:00:00.000Z', cardId: 'card-a', rating: 'good' }],
            schedule: { 'card-a': scheduled(), 'card-mine': scheduled() }
        });
        const after = reconcileDeckFiles(before, []);
        expect(after.decks).toHaveLength(1);
        expect(after.decks[0]).toBe(mine);
        expect(after.schedule['card-a']).toBeUndefined();
        expect(after.schedule['card-mine']).toBeDefined();
        // Review history stays — streaks and the heatmap don't lie (deleteDeck semantics).
        expect(after.reviews).toHaveLength(1);
    });
    it('never touches decks created in-app, even when a file shares their name', () => {
        const mine = deck({ cards: [card('card-mine', 'Q1', 'A1')], id: 'deck-mine', name: 'Cardio' });
        const before = state([mine]);
        const after = reconcileDeckFiles(before, [candidate('Cardio.tsv', [{ back: 'A1', front: 'Q1' }])]);
        expect(after.decks).toHaveLength(2);
        expect(after.decks[0]).toBe(mine);
        expect(after.decks[0].sourceFile).toBeUndefined();
        expect(after.decks[1].sourceFile).toBe('Cardio.tsv');
        expect(after.decks[1].cards[0].id).not.toBe('card-mine');
    });
});
describe('adoptLegacyDeckFiles', () => {
    it('relinks a pre-reconcile imported deck to its file by the import default name', () => {
        const early = deck({ cards: [card('card-a', 'Q1', 'A1')], id: 'deck-1', name: 'Cardio' });
        const before = state([early]);
        const after = adoptLegacyDeckFiles(before, ['Cardio.tsv']);
        expect(after).not.toBe(before);
        expect(after.decks[0].sourceFile).toBe('Cardio.tsv');
        expect(after.decks[0].id).toBe('deck-1');
    });
    it('returns the same reference when there is nothing to adopt', () => {
        const mine = deck({ id: 'deck-1', name: 'Something else' });
        const before = state([mine]);
        expect(adoptLegacyDeckFiles(before, ['Cardio.tsv'])).toBe(before);
        expect(adoptLegacyDeckFiles(before, [])).toBe(before);
    });
    it('skips files already linked to a deck', () => {
        const linked = deck({ id: 'deck-1', name: 'Cardio', sourceFile: 'Cardio.tsv' });
        const twin = deck({ id: 'deck-2', name: 'Cardio' });
        const before = state([linked, twin]);
        const after = adoptLegacyDeckFiles(before, ['Cardio.tsv']);
        expect(after).toBe(before);
        expect(after.decks[1].sourceFile).toBeUndefined();
    });
});
// Study settings: caps/order/flip/hints, persisted as StudyState.settings and
// always read back through getSettings() so old and partial blobs default cleanly.
describe('getSettings', () => {
    it('returns the defaults when state has no settings at all', () => {
        const before = state([]);
        expect(getSettings(before)).toEqual(DEFAULT_STUDY_SETTINGS);
    });
    it('merges a partial settings object over the defaults', () => {
        const before = state([], { settings: { newPerDay: 5 } });
        const settings = getSettings(before);
        expect(settings.newPerDay).toBe(5);
        expect(settings.reviewsPerDay).toBe(DEFAULT_STUDY_SETTINGS.reviewsPerDay);
        expect(settings.order).toBe(DEFAULT_STUDY_SETTINGS.order);
        expect(settings.flip).toBe(DEFAULT_STUDY_SETTINGS.flip);
        expect(settings.showIntervalHints).toBe(DEFAULT_STUDY_SETTINGS.showIntervalHints);
    });
});
describe('setSettings', () => {
    it('patches one field and preserves the rest, immutably', () => {
        const before = state([], { settings: { newPerDay: 5, order: 'random' } });
        const after = setSettings(before, { reviewsPerDay: 10 });
        expect(after).not.toBe(before);
        expect(getSettings(after)).toEqual({
            ...DEFAULT_STUDY_SETTINGS,
            newPerDay: 5,
            order: 'random',
            reviewsPerDay: 10
        });
    });
});
describe('loadState settings migration', () => {
    beforeEach(() => {
        window.localStorage.clear();
    });
    it('tolerates a saved blob with no settings field at all (pre-existing users)', () => {
        saveState(state([deck({ id: 'd1', name: 'Deck' })]));
        expect(getSettings(loadState())).toEqual(DEFAULT_STUDY_SETTINGS);
    });
    it('migrates the legacy flip key when no blob exists yet', () => {
        window.localStorage.setItem('nemesis.study.flip', 'off');
        expect(getSettings(loadState()).flip).toBe(false);
    });
    it('migrates the legacy flip key into an existing blob missing settings', () => {
        saveState(state([deck({ id: 'd1', name: 'Deck' })]));
        window.localStorage.setItem('nemesis.study.flip', 'off');
        expect(getSettings(loadState()).flip).toBe(false);
    });
    it('never lets the legacy key override an explicitly stored setting', () => {
        saveState(state([], { settings: { flip: true } }));
        window.localStorage.setItem('nemesis.study.flip', 'off');
        expect(getSettings(loadState()).flip).toBe(true);
    });
});
describe('buildQueue daily caps', () => {
    // Local-constructed dates: the caps count "today" by the LOCAL calendar.
    const now = new Date(2026, 6, 10, 12, 0);
    it('caps new and review cards independently per day', () => {
        const newCards = ['n1', 'n2', 'n3'].map(id => card(id, `Q-${id}`, `A-${id}`));
        const reviewCards = ['r1', 'r2', 'r3'].map(id => card(id, `Q-${id}`, `A-${id}`));
        const testDeck = deck({ cards: [...newCards, ...reviewCards], id: 'd1', name: 'Deck' });
        const before = state([testDeck], {
            schedule: { r1: scheduled(), r2: scheduled(), r3: scheduled() },
            settings: { newPerDay: 2, reviewsPerDay: 1 }
        });
        const queue = buildQueue(before, null, now);
        expect(queue.filter(item => item.isNew)).toHaveLength(2);
        expect(queue.filter(item => !item.isNew)).toHaveLength(1);
    });
    it('counts cards already studied today against the new-card cap, even once rescheduled out of the due set', () => {
        const studiedToday = ['done1', 'done2'].map(id => card(id, `Q-${id}`, `A-${id}`));
        const waiting = ['w1', 'w2', 'w3'].map(id => card(id, `Q-${id}`, `A-${id}`));
        const testDeck = deck({ cards: [...studiedToday, ...waiting], id: 'd1', name: 'Deck' });
        const future = { due: new Date(2026, 6, 11).toISOString() };
        const before = state([testDeck], {
            reviews: [
                { at: new Date(2026, 6, 10, 9, 0).toISOString(), cardId: 'done1', rating: 'good' },
                { at: new Date(2026, 6, 10, 10, 0).toISOString(), cardId: 'done2', rating: 'good' }
            ],
            schedule: { done1: future, done2: future },
            settings: { newPerDay: 3 }
        });
        const queue = buildQueue(before, null, now);
        expect(queue.map(item => item.card.id)).toEqual(['w1']);
    });
    it('counts a same-day repeat review as a review, not a second "new" slot', () => {
        const testDeck = deck({ cards: [card('r1', 'Q', 'A'), card('n1', 'Q2', 'A2')], id: 'd1', name: 'Deck' });
        const future = { due: new Date(2026, 6, 11).toISOString() };
        const before = state([testDeck], {
            reviews: [
                { at: new Date(2026, 6, 10, 8, 0).toISOString(), cardId: 'r1', rating: 'again' },
                { at: new Date(2026, 6, 10, 9, 0).toISOString(), cardId: 'r1', rating: 'good' }
            ],
            schedule: { r1: future },
            settings: { newPerDay: 2 }
        });
        const queue = buildQueue(before, null, now);
        // r1's two reviews today are 1 new + 1 review, leaving 1 of the 2 new slots for
        // n1 — a buggy "every log entry is new" count would leave 0 and drop n1.
        expect(queue.map(item => item.card.id)).toEqual(['n1']);
    });
    it('a review just before local midnight counts toward THAT day, so the next morning starts fresh', () => {
        const lateCard = card('late1', 'Q', 'A');
        const waiting = card('w1', 'Q2', 'A2');
        const testDeck = deck({ cards: [lateCard, waiting], id: 'd1', name: 'Deck' });
        const before = state([testDeck], {
            reviews: [{ at: new Date(2026, 6, 9, 23, 30).toISOString(), cardId: 'late1', rating: 'good' }],
            schedule: { late1: { due: new Date(2026, 6, 20).toISOString() } },
            settings: { newPerDay: 1 }
        });
        // Next local morning: yesterday's 23:30 grade must NOT eat today's new slot.
        // (The old UTC keying pushed a late-evening review into "tomorrow" for
        // students west of UTC, silently halving their next-day new cards.)
        const queue = buildQueue(before, null, new Date(2026, 6, 10, 8, 0));
        expect(queue.map(item => item.card.id)).toEqual(['w1']);
    });
    it('treats a cap of 0 as unlimited for both new and review counts', () => {
        const newCards = Array.from({ length: 5 }, (_, i) => card(`n${i}`, `Q${i}`, `A${i}`));
        const reviewCards = Array.from({ length: 5 }, (_, i) => card(`r${i}`, `Q${i}`, `A${i}`));
        const schedule = {};
        for (const c of reviewCards) {
            schedule[c.id] = scheduled();
        }
        const testDeck = deck({ cards: [...newCards, ...reviewCards], id: 'd1', name: 'Deck' });
        const before = state([testDeck], { schedule, settings: { newPerDay: 0, reviewsPerDay: 0 } });
        const queue = buildQueue(before, null, now);
        expect(queue).toHaveLength(10);
    });
});
describe('buildQueue review order', () => {
    function dueSet(n) {
        const cards = Array.from({ length: n }, (_, i) => card(`c${i}`, `Q${i}`, `A${i}`));
        const schedule = {};
        for (const c of cards) {
            schedule[c.id] = scheduled();
        }
        return { deck: deck({ cards, id: 'd1', name: 'Deck' }), schedule };
    }
    // 2026-07-12/13 (not -10/-11) are picked deliberately: verified to hash-order
    // these 6 ids into a genuinely mixed permutation, not a coincidental identity
    // or pure-reverse order that would make the "differs from due order" /
    // "differs from the other day" assertions below vacuously true. Times are
    // local-constructed because the day-stable shuffle keys on the LOCAL day —
    // the hash inputs stay the exact strings '2026-07-12'/'2026-07-13'.
    it('is deterministic within the same local day', () => {
        const { deck: testDeck, schedule } = dueSet(6);
        const before = state([testDeck], { schedule, settings: { order: 'random' } });
        const morning = buildQueue(before, null, new Date(2026, 6, 12, 1, 0));
        const evening = buildQueue(before, null, new Date(2026, 6, 12, 23, 0));
        expect(morning.map(item => item.card.id)).toEqual(evening.map(item => item.card.id));
    });
    it('shuffles relative to due-first order, without dropping or duplicating cards', () => {
        const { deck: testDeck, schedule } = dueSet(6);
        const now = new Date(2026, 6, 12, 12, 0);
        const dueOrder = buildQueue(state([testDeck], { schedule, settings: { order: 'due' } }), null, now).map(item => item.card.id);
        const randomOrder = buildQueue(state([testDeck], { schedule, settings: { order: 'random' } }), null, now).map(item => item.card.id);
        expect([...randomOrder].sort()).toEqual([...dueOrder].sort());
        expect(randomOrder).not.toEqual(dueOrder);
    });
    it('reorders independently of which other cards are present (no reshuffle on grading)', () => {
        const { deck: testDeck, schedule } = dueSet(6);
        const now = new Date(2026, 6, 12, 12, 0);
        const before = state([testDeck], { schedule, settings: { order: 'random' } });
        const full = buildQueue(before, null, now).map(item => item.card.id);
        // Simulate the first card being graded away (its schedule moves to the future,
        // dropping it from today's due set) — the relative order of the rest must be
        // unchanged, not a fresh shuffle of the smaller set.
        const gradedId = full[0];
        const afterGrading = state([testDeck], {
            schedule: { ...schedule, [gradedId]: { due: new Date(2026, 6, 13).toISOString() } },
            settings: { order: 'random' }
        });
        const remaining = buildQueue(afterGrading, null, now).map(item => item.card.id);
        expect(remaining).toEqual(full.slice(1));
    });
    it('reshuffles on a different local day', () => {
        const { deck: testDeck, schedule } = dueSet(6);
        const before = state([testDeck], { schedule, settings: { order: 'random' } });
        const day1 = buildQueue(before, null, new Date(2026, 6, 12, 12, 0)).map(item => item.card.id);
        const day2 = buildQueue(before, null, new Date(2026, 6, 13, 12, 0)).map(item => item.card.id);
        expect(day2).not.toEqual(day1);
    });
});
// Cloze cards ({{c1::…}} in the front) become one queue/schedule item per
// distinct index, keyed `${cardId}#c${n}` — grading one index never moves its
// siblings. Plain cards keep the bare card id (nothing changes for them).
describe('cloze scheduling', () => {
    const now = new Date(2026, 6, 10, 12, 0);
    function clozeDeck() {
        return deck({
            cards: [card('cz', 'The {{c1::thick ascending limb}} pump is {{c2::Na-K-2Cl}}', '')],
            id: 'd1',
            name: 'Deck'
        });
    }
    it('expands a cloze card into one queue item per distinct index', () => {
        const queue = buildQueue(state([clozeDeck()]), null, now);
        expect(queue.map(item => item.scheduleKey)).toEqual(['cz#c1', 'cz#c2']);
        expect(queue.map(item => item.clozeIndex)).toEqual([1, 2]);
        expect(queue.every(item => item.isNew && item.card.id === 'cz')).toBe(true);
    });
    it('keeps plain cards on their bare card id', () => {
        const queue = buildQueue(state([deck({ cards: [card('p1', 'Q', 'A')], id: 'd1', name: 'Deck' })]), null, now);
        expect(queue.map(item => item.scheduleKey)).toEqual(['p1']);
        expect(queue[0].clozeIndex).toBeUndefined();
    });
    it('grading one cloze slot leaves its siblings untouched', () => {
        const after = gradeCard(state([clozeDeck()]), 'cz#c1', 'good', now);
        expect(after.schedule['cz#c1']).toBeDefined();
        expect(after.schedule['cz#c2']).toBeUndefined();
        // c1 is rescheduled into the future; only c2 stays in the queue.
        const queue = buildQueue(after, null, now);
        expect(queue.map(item => item.scheduleKey)).toEqual(['cz#c2']);
    });
    it('deckStats counts cloze slots individually', () => {
        const withPlain = deck({
            cards: [card('cz', '{{c1::A}} vs {{c2::B}}', ''), card('p1', 'Q', 'A')],
            id: 'd1',
            name: 'Deck'
        });
        expect(deckStats(state([withPlain]), null, now)).toEqual({ due: 3, fresh: 3, total: 3 });
    });
    it('deleteCard prunes every cloze slot schedule', () => {
        const before = state([clozeDeck()], { schedule: { 'cz#c1': scheduled(), 'cz#c2': scheduled() } });
        const after = deleteCard(before, 'd1', 'cz');
        expect(after.schedule).toEqual({});
    });
});
describe('undoLastGrade', () => {
    const now = new Date(2026, 6, 10, 12, 0);
    function plainDeck() {
        return deck({ cards: [card('c1', 'Q', 'A')], id: 'd1', name: 'Deck' });
    }
    it('restores a never-studied card to unscheduled and pops the log entry', () => {
        const before = state([plainDeck()]);
        const graded = gradeCard(before, 'c1', 'good', now);
        expect(graded.schedule.c1).toBeDefined();
        expect(graded.reviews).toHaveLength(1);
        const undone = undoLastGrade(graded, { scheduleKey: 'c1' });
        expect(undone.schedule.c1).toBeUndefined();
        expect(undone.reviews).toHaveLength(0);
        // Counts recover: the card is new + due again, exactly as before the grade.
        expect(deckStats(undone, null, now)).toEqual(deckStats(before, null, now));
        expect(buildQueue(undone, null, now).map(item => item.scheduleKey)).toEqual(['c1']);
    });
    it('restores the previous schedule snapshot for a re-graded card', () => {
        const first = gradeCard(state([plainDeck()]), 'c1', 'good', now);
        const snapshot = first.schedule.c1;
        const second = gradeCard(first, 'c1', 'again', new Date(now.getTime() + 60_000));
        const undone = undoLastGrade(second, { previous: snapshot, scheduleKey: 'c1' });
        expect(undone.schedule.c1).toEqual(snapshot);
        expect(undone.reviews).toHaveLength(1);
    });
    it('refuses when the last log entry belongs to a different card', () => {
        const first = gradeCard(state([deck({ cards: [card('c1', 'Q', 'A'), card('c2', 'Q2', 'A2')], id: 'd1', name: 'Deck' })]), 'c1', 'good', now);
        const second = gradeCard(first, 'c2', 'good', now);
        expect(undoLastGrade(second, { scheduleKey: 'c1' })).toBe(second);
    });
});
describe('leech auto-suspend', () => {
    const now = new Date(2026, 6, 10, 12, 0);
    // A realistic Review-state FSRS payload one lapse away from the threshold:
    // grading 'again' increments lapses to 8 and must trip the leech rule.
    function nearLeechSchedule(lapses) {
        return {
            difficulty: 6,
            due: new Date(2026, 6, 9).toISOString(),
            elapsed_days: 1,
            lapses,
            last_review: new Date(2026, 6, 8).toISOString(),
            learning_steps: 0,
            reps: 12,
            scheduled_days: 1,
            stability: 2,
            state: 2
        };
    }
    it('suspends and tags the card on its 8th lapse', () => {
        const before = state([deck({ cards: [card('c1', 'Q', 'A')], id: 'd1', name: 'Deck' })], {
            schedule: { c1: nearLeechSchedule(7) }
        });
        const after = gradeCard(before, 'c1', 'again', now);
        const suspect = after.decks[0].cards[0];
        expect(suspect.suspended).toBe(true);
        expect(suspect.tags).toContain(LEECH_TAG);
        // Suspended cards drop out of the queue immediately.
        expect(buildQueue(after, null, new Date(now.getTime() + 60 * 60_000))).toHaveLength(0);
    });
    it('a lapsed cloze slot suspends its parent card', () => {
        const before = state([deck({ cards: [card('cz', '{{c1::A}} and {{c2::B}}', '')], id: 'd1', name: 'Deck' })], {
            schedule: { 'cz#c1': nearLeechSchedule(7) }
        });
        const after = gradeCard(before, 'cz#c1', 'again', now);
        expect(after.decks[0].cards[0].suspended).toBe(true);
        expect(after.decks[0].cards[0].tags).toContain(LEECH_TAG);
    });
    it('does not re-suspend an unsuspended old leech on a successful review', () => {
        const before = state([deck({ cards: [card('c1', 'Q', 'A', { tags: [LEECH_TAG] })], id: 'd1', name: 'Deck' })], {
            schedule: { c1: nearLeechSchedule(9) }
        });
        const after = gradeCard(before, 'c1', 'good', now);
        expect(after.decks[0].cards[0].suspended).toBeUndefined();
        expect(after.decks[0].cards[0].tags).toEqual([LEECH_TAG]);
    });
});
describe('desired retention', () => {
    const now = new Date(2026, 6, 10, 12, 0);
    it('defaults to 90%', () => {
        expect(getSettings(state([])).desiredRetention).toBe(0.9);
    });
    it('higher retention schedules the same card sooner (shorter interval)', () => {
        const reviewCard = {
            difficulty: 5,
            due: new Date(2026, 6, 9).toISOString(),
            elapsed_days: 10,
            lapses: 0,
            last_review: new Date(2026, 5, 30).toISOString(),
            learning_steps: 0,
            reps: 3,
            scheduled_days: 10,
            stability: 10,
            state: 2
        };
        const base = state([deck({ cards: [card('c1', 'Q', 'A')], id: 'd1', name: 'Deck' })], {
            schedule: { c1: reviewCard }
        });
        const relaxed = gradeCard(setSettings(base, { desiredRetention: 0.8 }), 'c1', 'good', now);
        const strict = gradeCard(setSettings(base, { desiredRetention: 0.95 }), 'c1', 'good', now);
        const relaxedDue = new Date(relaxed.schedule.c1.due).getTime();
        const strictDue = new Date(strict.schedule.c1.due).getTime();
        expect(strictDue).toBeLessThan(relaxedDue);
        expect(strictDue).toBeGreaterThan(now.getTime());
    });
});
describe('renameDeck', () => {
    it('renames an in-app deck and leaves the others alone', () => {
        const mine = deck({ id: 'd1', name: 'Old name' });
        const other = deck({ id: 'd2', name: 'Untouched' });
        const after = renameDeck(state([mine, other]), 'd1', 'New name');
        expect(after.decks[0].name).toBe('New name');
        expect(after.decks[0].sourceFile).toBeUndefined();
        expect(after.decks[1]).toBe(other);
    });
    it('retargets the source file for a file-backed rename', () => {
        const linked = deck({ id: 'd1', name: 'Cardio', sourceFile: 'Cardio.tsv' });
        const after = renameDeck(state([linked]), 'd1', 'Cardio essentials', 'Cardio essentials.tsv');
        expect(after.decks[0].name).toBe('Cardio essentials');
        expect(after.decks[0].sourceFile).toBe('Cardio essentials.tsv');
    });
});
