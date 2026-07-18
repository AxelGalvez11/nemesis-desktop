import { describe, expect, it } from 'vitest';
import { assembleCardContext, assembleNoteContext, scopeKeyForCard, scopeKeyForNote } from './context';
describe('note-chat context assembly', () => {
    it('note: scope key, backtick-quoted @file ref, title from filename', () => {
        const ctx = assembleNoteContext({ path: 'Pharmacology/ACE inhibitors.md', content: '# ACE\nbody' });
        expect(ctx.kind).toBe('note');
        expect(ctx.scopeKey).toBe('note:Pharmacology/ACE inhibitors.md');
        expect(ctx.title).toBe('ACE inhibitors');
        // Space in the path -> formatRefValue backtick-quotes it, matching the agent's parser.
        expect(ctx.refs).toEqual(['@file:`Pharmacology/ACE inhibitors.md`']);
        expect(ctx.inline).toBe('');
    });
    it('note: an unspaced path is left unquoted', () => {
        const ctx = assembleNoteContext({ path: 'A/b.md', content: '' });
        expect(ctx.refs).toEqual(['@file:A/b.md']);
    });
    it('card: scope key uses the card id (the real shipping path)', () => {
        const ctx = assembleCardContext({
            card: { id: 'c-1', front: 'What blocks ACE?', back: 'ACE inhibitors', tags: ['cardio'] },
            deckId: 'd1',
            deckName: 'Cardio'
        });
        expect(ctx.kind).toBe('card');
        expect(ctx.scopeKey).toBe('card:d1:c-1');
        expect(ctx.refs).toHaveLength(0);
        expect(ctx.inline).toMatch(/Front: What blocks ACE\?/);
        expect(ctx.inline).toMatch(/Back: ACE inhibitors/);
        expect(ctx.inline).toMatch(/Deck: Cardio/);
        expect(ctx.inline).toMatch(/Tags: cardio/);
    });
    it('card: falls back to the front when a card has no id (defensive branch)', () => {
        const ctx = assembleCardContext({
            card: { front: 'What blocks ACE?', back: 'ACE inhibitors', tags: [] },
            deckId: 'd1',
            deckName: 'Cardio'
        });
        expect(ctx.scopeKey).toBe('card:d1:What blocks ACE?');
    });
    it('card: includes an @file ref when the deck has a source file', () => {
        const ctx = assembleCardContext({
            card: { id: 'c-2', front: 'q', back: 'a', tags: [] },
            deckId: 'd2',
            deckName: 'Immuno',
            sourceFile: 'Flashcards/Immuno.tsv'
        });
        expect(ctx.refs).toEqual(['@file:Flashcards/Immuno.tsv']);
    });
    it('card: adds a cloze index line when present', () => {
        const ctx = assembleCardContext({
            card: { id: 'c-3', front: 'q', back: 'a', tags: [] },
            deckId: 'd3',
            deckName: 'Deck',
            clozeIndex: 2
        });
        expect(ctx.inline).toMatch(/Cloze index: 2/);
    });
    it('scope-key helpers are stable', () => {
        expect(scopeKeyForNote('X/y.md')).toBe('note:X/y.md');
        expect(scopeKeyForCard('deck', 'card')).toBe('card:deck:card');
    });
});
