// Pins the phone-sync bridge's two pure contracts: the deck snapshot the phone
// renders verbatim (pre-rendered cloze prompts, schedule keys it must echo
// back), and the ingest fold that applies phone grades through gradeCard — the
// same apply path as the desktop grade buttons.
import { describe, expect, it } from 'vitest';
import { renderClozeAnswer, renderClozePrompt } from './cloze';
import { appendToLedger, APPLIED_LEDGER_CAP, appliedLedgerFrom, applyPhoneReviews, buildPhoneDecksPayload } from './phone-sync';
const NOW = new Date('2026-07-17T12:00:00Z');
function fixtureState() {
    return {
        version: 1,
        decks: [
            {
                id: 'deck-1',
                name: 'Cardio',
                course: 'PHCY 1205',
                createdAt: '2026-07-01T00:00:00Z',
                cards: [
                    { id: 'card-a', front: 'Front A', back: 'Back A', tags: [] },
                    { id: 'card-b', front: '{{c1::furosemide}} blocks {{c2::NKCC2}}', back: 'loop diuretic', tags: [] }
                ]
            }
        ],
        sections: [],
        schedule: {},
        reviews: []
    };
}
describe('buildPhoneDecksPayload', () => {
    it('pre-renders plain and cloze cards with the exact schedule keys and desktop renderers', () => {
        const payload = buildPhoneDecksPayload(fixtureState(), NOW);
        expect(payload.v).toBe(1);
        expect(payload.asOf).toBe(NOW.toISOString());
        expect(payload.decks).toHaveLength(1);
        const deck = payload.decks[0];
        expect(deck.id).toBe('deck-1');
        expect(deck.course).toBe('PHCY 1205');
        // 1 plain card + 2 cloze slots = 3 schedule targets, all new.
        expect(deck.stats).toEqual({ due: 3, fresh: 3, total: 3 });
        expect(deck.queue.map(card => card.key)).toEqual(['card-a', 'card-b#c1', 'card-b#c2']);
        const plain = deck.queue[0];
        expect(plain).toMatchObject({ prompt: 'Front A', answer: 'Back A', isNew: true });
        expect(plain.note).toBeUndefined();
        const cloze = deck.queue[1];
        expect(cloze.prompt).toBe(renderClozePrompt('{{c1::furosemide}} blocks {{c2::NKCC2}}', 1));
        expect(cloze.answer).toBe(renderClozeAnswer('{{c1::furosemide}} blocks {{c2::NKCC2}}'));
        expect(cloze.note).toBe('loop diuretic');
    });
    it('is stable across recomputes so the writer can change-detect on the decks array', () => {
        const first = buildPhoneDecksPayload(fixtureState(), NOW);
        const second = buildPhoneDecksPayload(fixtureState(), NOW);
        expect(JSON.stringify(first.decks)).toBe(JSON.stringify(second.decks));
    });
});
describe('applyPhoneReviews', () => {
    const row = (over) => ({
        id: '00000000-0000-0000-0000-000000000001',
        schedule_key: 'card-a',
        grade: 'good',
        reviewed_at: '2026-07-17T09:00:00Z',
        ...over
    });
    it('applies a grade through gradeCard at the phone review time', () => {
        const result = applyPhoneReviews(fixtureState(), [row({})], NOW);
        expect(result.applied).toBe(1);
        expect(result.skipped).toBe(0);
        expect(result.state.schedule['card-a']).toBeDefined();
        expect(result.state.reviews).toHaveLength(1);
        expect(result.state.reviews[0]).toMatchObject({ cardId: 'card-a', rating: 'good' });
        expect(result.state.reviews[0].at).toBe('2026-07-17T09:00:00.000Z');
    });
    it('applies cloze-slot keys and skips keys for cards that no longer exist', () => {
        const result = applyPhoneReviews(fixtureState(), [row({ schedule_key: 'card-b#c2' }), row({ id: '00000000-0000-0000-0000-000000000002', schedule_key: 'card-deleted' })], NOW);
        expect(result.applied).toBe(1);
        expect(result.skipped).toBe(1);
        expect(result.state.schedule['card-b#c2']).toBeDefined();
        expect(result.state.schedule['card-deleted']).toBeUndefined();
    });
    it('skips unknown grades and clamps future timestamps to now', () => {
        const result = applyPhoneReviews(fixtureState(), [row({ grade: 'perfect' }), row({ id: '00000000-0000-0000-0000-000000000003', reviewed_at: '2030-01-01T00:00:00Z' })], NOW);
        expect(result.applied).toBe(1);
        expect(result.skipped).toBe(1);
        expect(result.state.reviews[0].at).toBe(NOW.toISOString());
    });
    it('never mutates the input state', () => {
        const state = fixtureState();
        applyPhoneReviews(state, [row({})], NOW);
        expect(state.schedule).toEqual({});
        expect(state.reviews).toEqual([]);
    });
});
describe('applied-row ledger', () => {
    it('parses persisted ledgers leniently and rejects garbage', () => {
        expect(appliedLedgerFrom(null)).toEqual([]);
        expect(appliedLedgerFrom('not json')).toEqual([]);
        expect(appliedLedgerFrom('{"a":1}')).toEqual([]);
        expect(appliedLedgerFrom('["id-1", 7, "id-2"]')).toEqual(['id-1', 'id-2']);
    });
    it('caps at the most recent entries so it can never grow unbounded', () => {
        const big = Array.from({ length: APPLIED_LEDGER_CAP }, (_, i) => `old-${i}`);
        const next = appendToLedger(big, ['new-1', 'new-2']);
        expect(next).toHaveLength(APPLIED_LEDGER_CAP);
        expect(next[next.length - 1]).toBe('new-2');
        expect(next[0]).toBe('old-2');
    });
});
