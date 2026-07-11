// reconcileDeckFiles is what lets the agent reorganize the vault's Flashcards folder
// (rename files, edit cards, change course headers, delete decks) without the Study
// page drifting — and, critically, without torching FSRS review progress. These tests
// pin that contract.
import { describe, expect, it } from 'vitest';
import { adoptLegacyDeckFiles, reconcileDeckFiles } from './model';
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
