import { describe, expect, it } from 'vitest';
import { assembleCardContext, assembleNoteContext } from './context';
import { buildQuickActionPrompt, QUICK_ACTIONS } from './quick-actions';
describe('note-chat quick actions', () => {
    it('exposes the four fixed actions, with the label adapting to the surface', () => {
        expect(QUICK_ACTIONS.map(a => a.id)).toEqual(['explain_simpler', 'quiz_me', 'example', 'why']);
        const why = QUICK_ACTIONS.find(a => a.id === 'why');
        expect(why.label('card')).toBe('Why this answer');
        expect(why.label('note')).toBe('Why this matters');
    });
    it('note prompt leads with the @file ref, then the instruction', () => {
        const ctx = assembleNoteContext({ path: 'A/b.md', content: '' });
        const p = buildQuickActionPrompt('explain_simpler', ctx);
        expect(p.startsWith('@file:A/b.md')).toBe(true);
        expect(p).toMatch(/explain/i);
        expect(p).toMatch(/simpler|plain/i);
    });
    it('card prompt includes the inline front/back block', () => {
        const ctx = assembleCardContext({ card: { id: 'c', front: 'q', back: 'a', tags: [] }, deckId: 'd', deckName: 'Deck' });
        const p = buildQuickActionPrompt('quiz_me', ctx);
        expect(p).toMatch(/Front: q/);
        expect(p).toMatch(/quiz|ask me/i);
    });
});
