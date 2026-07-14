import { describe, expect, it } from 'vitest';
import { searchNotes } from './search';
const note = (title, content, folder = '') => ({
    content,
    folder,
    path: `/vault/${folder ? `${folder}/` : ''}${title}.md`,
    title
});
const NOTES = [
    note('ACE inhibitors', '# ACE inhibitors\n\nLisinopril blocks angiotensin II.\n- Dry cough is common.'),
    note('ARBs', '# ARBs\n\nLosartan, valsartan. No cough side effect.'),
    note('Heart failure', '# Heart failure\n\nUses ACE inhibitors or ARBs, plus diuretics.'),
    // Title has no overlap with its own body — the clean case for a title match whose
    // body doesn't also contain the query (a null snippet).
    note('Beta blockers', 'Metoprolol, carvedilol. Reduces heart rate and afterload.')
];
describe('searchNotes', () => {
    it('returns nothing for a blank query', () => {
        expect(searchNotes(NOTES, '')).toEqual([]);
        expect(searchNotes(NOTES, '   ')).toEqual([]);
    });
    it('matches by title, case-insensitively', () => {
        const hits = searchNotes(NOTES, 'BETA BLOCKERS');
        expect(hits.map(h => h.note.title)).toEqual(['Beta blockers']);
    });
    it('matches by body content when the title does not match', () => {
        const hits = searchNotes(NOTES, 'diuretics');
        expect(hits.map(h => h.note.title)).toEqual(['Heart failure']);
        expect(hits[0].snippet).toBe('Uses ACE inhibitors or ARBs, plus diuretics.');
    });
    it('ranks title matches before body-only matches, each alphabetical', () => {
        // "ACE inhibitors" matches by title; "Heart failure" only matches in its body
        // (it mentions "ACE inhibitors" in prose, so both are body-relevant to "ace").
        const hits = searchNotes(NOTES, 'ace');
        expect(hits.map(h => h.note.title)).toEqual(['ACE inhibitors', 'Heart failure']);
    });
    it('returns the first matching line as the snippet, trimmed', () => {
        const hits = searchNotes(NOTES, 'dry cough');
        expect(hits[0].snippet).toBe('- Dry cough is common.');
    });
    it('gives a title-only match a null snippet when the body does not also contain the query', () => {
        const hits = searchNotes(NOTES, 'beta blockers');
        expect(hits[0].snippet).toBeNull();
    });
    it('excludes notes matching neither title nor body', () => {
        const hits = searchNotes(NOTES, 'nonexistent term');
        expect(hits).toEqual([]);
    });
    it('is a plain substring match with no operators', () => {
        // Quotes/operators are treated as literal characters, not special syntax.
        expect(searchNotes(NOTES, '"cough"')).toEqual([]);
        expect(searchNotes(NOTES, 'cough')).toHaveLength(2);
    });
});
