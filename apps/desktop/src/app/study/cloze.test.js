// Cloze parsing/rendering contract: Anki's {{cN::text}} / {{cN::text::hint}}
// syntax, one prompt per index, garbage passes through untouched. The queue
// expansion side (one schedule slot per index) is pinned in model.test.ts.
import { describe, expect, it } from 'vitest';
import { clozeIndexes, clozeScheduleKey, hasClozeMarker, parseCloze, renderClozeAnswer, renderClozePrompt } from './cloze';
import { parseCardPaste } from './import-cards';
describe('parseCloze', () => {
    it('splits literals and markers, collecting distinct indexes ascending', () => {
        const { indexes, segments } = parseCloze('The {{c2::thick ascending limb}} pump is {{c1::Na-K-2Cl}}');
        expect(indexes).toEqual([1, 2]);
        expect(segments).toEqual([
            { text: 'The ' },
            { hint: undefined, index: 2, text: 'thick ascending limb' },
            { text: ' pump is ' },
            { hint: undefined, index: 1, text: 'Na-K-2Cl' }
        ]);
    });
    it('reports a duplicated index once', () => {
        expect(parseCloze('{{c1::A}} then {{c1::B}}').indexes).toEqual([1]);
    });
    it('parses hints', () => {
        const { segments } = parseCloze('{{c1::furosemide::loop diuretic}}');
        expect(segments).toEqual([{ hint: 'loop diuretic', index: 1, text: 'furosemide' }]);
    });
    it('treats an empty hint as no hint', () => {
        expect(parseCloze('{{c1::A::}}').segments[0].hint).toBeUndefined();
    });
    it('passes garbage through as literal text (no nesting, no partial markers)', () => {
        for (const junk of ['plain text', '{{c1:broken}', '{{x1::nope}}', 'ends {{c1::open']) {
            const { indexes, segments } = parseCloze(junk);
            expect(indexes).toEqual([]);
            expect(segments).toEqual([{ text: junk }]);
        }
    });
    it('allows multiline deletion text', () => {
        const { indexes } = parseCloze('{{c1::line one\nline two}}');
        expect(indexes).toEqual([1]);
    });
});
describe('renderClozePrompt / renderClozeAnswer', () => {
    const front = '{{c1::Lisinopril}} causes cough via {{c2::bradykinin::peptide}} buildup';
    it('blanks only the active index and reveals the others', () => {
        expect(renderClozePrompt(front, 1)).toBe('[...] causes cough via bradykinin buildup');
        expect(renderClozePrompt(front, 2)).toBe('Lisinopril causes cough via [peptide] buildup');
    });
    it('blanks every span of a repeated index at once', () => {
        expect(renderClozePrompt('{{c1::A}} then {{c1::B}}', 1)).toBe('[...] then [...]');
    });
    it('reveals everything in the answer', () => {
        expect(renderClozeAnswer(front)).toBe('Lisinopril causes cough via bradykinin buildup');
    });
    it('returns garbage unchanged', () => {
        expect(renderClozeAnswer('{{c1:broken}')).toBe('{{c1:broken}');
    });
});
describe('helpers', () => {
    it('hasClozeMarker spots markers cheaply', () => {
        expect(hasClozeMarker('{{c1::x}}')).toBe(true);
        expect(hasClozeMarker('{{c12::x')).toBe(true);
        expect(hasClozeMarker('no markers')).toBe(false);
        expect(hasClozeMarker('{{d1::x}}')).toBe(false);
    });
    it('clozeIndexes is empty for plain fronts', () => {
        expect(clozeIndexes('plain')).toEqual([]);
        expect(clozeIndexes('{{c3::x}} {{c1::y}}')).toEqual([1, 3]);
    });
    it('clozeScheduleKey formats the per-index slot key', () => {
        expect(clozeScheduleKey('card-abc', 2)).toBe('card-abc#c2');
    });
});
// Import rule: a front carrying {{cN::…}} keeps the WHOLE line (back optional) —
// the separators splitLine hunts for (tab, " - ", comma) may sit inside markers.
describe('parseCardPaste with cloze lines', () => {
    it('keeps a separator-free cloze line whole with an empty back', () => {
        expect(parseCardPaste('{{c1::Furosemide}} blocks Na-K-2Cl')).toEqual([
            { back: '', front: '{{c1::Furosemide}} blocks Na-K-2Cl' }
        ]);
    });
    it('does not shred a cloze whose text contains a comma', () => {
        const line = 'ACE inhibitors cause {{c1::cough, angioedema}}';
        expect(parseCardPaste(line)).toEqual([{ back: '', front: line }]);
    });
    it('keeps a cloze line whole for a " - " separator (only TAB splits clozes)', () => {
        const line = '{{c1::metoprolol}} - beta-1 selective';
        expect(parseCardPaste(line)).toEqual([{ back: '', front: line }]);
    });
    it('splits a cloze line on a TAB, peeling the trailing title to the back', () => {
        // The deck format the skill writes: "<cloze text>\t<title>". A tab never
        // occurs inside a marker, so the title must NOT bleed onto the cloze prompt.
        expect(parseCardPaste('Neutrophils use {{c1::NETosis}} (extruding NETs)\tNeutrophil effector functions.')).toEqual([
            { back: 'Neutrophil effector functions.', front: 'Neutrophils use {{c1::NETosis}} (extruding NETs)' }
        ]);
    });
    it('a cloze line with a trailing tab but no title after it stays whole', () => {
        expect(parseCardPaste('{{c1::furosemide}} blocks NKCC2\t')).toEqual([
            { back: '', front: '{{c1::furosemide}} blocks NKCC2' }
        ]);
    });
    it('leaves plain lines and cloze-free splitting untouched', () => {
        expect(parseCardPaste('term\tdefinition')).toEqual([{ back: 'definition', front: 'term' }]);
        // A marker only in the BACK is not a cloze card; the split stands.
        expect(parseCardPaste('plain front\t{{c1::in back}}')).toEqual([
            { back: '{{c1::in back}}', front: 'plain front' }
        ]);
    });
});
