import { describe, expect, it } from 'vitest';
import { isCitationHref, linkifyCitations } from './citation-chips';
describe('linkifyCitations', () => {
    it('turns a parenthesized PMID into a labeled PubMed link, dropping the parens', () => {
        expect(linkifyCitations('reduced liver fat (PMID: 38858523).')).toBe('reduced liver fat [PubMed](https://pubmed.ncbi.nlm.nih.gov/38858523/).');
    });
    it('splits a multi-citation parenthetical into one chip per source', () => {
        expect(linkifyCitations('(PMID: 39318607, PMID: 40291085)')).toBe('[PubMed](https://pubmed.ncbi.nlm.nih.gov/39318607/) [PubMed](https://pubmed.ncbi.nlm.nih.gov/40291085/)');
    });
    it('links bare PMIDs and NCT trial ids', () => {
        expect(linkifyCitations('see PMID 37385280 and NCT04881760')).toBe('see [PubMed](https://pubmed.ncbi.nlm.nih.gov/37385280/) and [Trial](https://clinicaltrials.gov/study/NCT04881760)');
    });
    it('never rewrites code spans or fenced blocks', () => {
        const fenced = '```\nPMID: 12345678\n```';
        const inline = 'run `PMID: 12345678` locally';
        expect(linkifyCitations(fenced)).toBe(fenced);
        expect(linkifyCitations(inline)).toBe(inline);
    });
    it('leaves citation-free text untouched (fast path)', () => {
        const text = 'no citations here, just prose with numbers 123456.';
        expect(linkifyCitations(text)).toBe(text);
    });
});
describe('isCitationHref', () => {
    it('matches PubMed, ClinicalTrials, and DOI targets only', () => {
        expect(isCitationHref('https://pubmed.ncbi.nlm.nih.gov/38858523/')).toBe(true);
        expect(isCitationHref('https://clinicaltrials.gov/study/NCT04881760')).toBe(true);
        expect(isCitationHref('https://doi.org/10.1056/NEJMoa2301972')).toBe(true);
        expect(isCitationHref('https://example.com/pubmed')).toBe(false);
        expect(isCitationHref(undefined)).toBe(false);
    });
});
