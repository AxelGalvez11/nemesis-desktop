import { describe, expect, it } from 'vitest';
import { looksLikeArtifact } from './artifact-utils';
describe('looksLikeArtifact — "Made by Nemesis" gatekeeper', () => {
    it('accepts real deliverable files', () => {
        for (const value of [
            '~/Documents/Nemesis Library/Exports/ACE inhibitor cough.html',
            '/Users/x/Documents/Nemesis Library/Exports/report.pdf',
            '~/Documents/Nemesis Library/Exports/handout.docx',
            '~/Documents/Nemesis Library/Exports/slides.pptx',
            'data:image/png;base64,iVBORw0KG',
            'https://cdn.example.com/generated.png',
        ]) {
            expect(looksLikeArtifact(value)).toBe(true);
        }
    });
    it('rejects build/machinery files and malformed junk (the recurring bugs)', () => {
        for (const value of [
            '/Users/x/app/dist/main.chunk.js', // build artifact — was leaking in
            '/Users/x/app/src/index.ts',
            '/Users/x/app/styles.css',
            '/Users/x/.nemesis/graph.json',
            '/Users/x/thing.map',
            ':', // the malformed ":" entry
            '/foo/bar', // absolute path, no extension — no longer accepted
            'just some prose text',
        ]) {
            expect(looksLikeArtifact(value)).toBe(false);
        }
    });
    it('rejects multi-line tool output (a whole-vault listing is not one artifact)', () => {
        expect(looksLikeArtifact('/a/report.pdf\n/b/notes.md')).toBe(false);
    });
});
