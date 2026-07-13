import { describe, expect, it } from 'vitest';
import { deriveRecordingTitle } from './autoname';
const AT = new Date(2026, 6, 11, 14, 30);
const DATE_TAG = AT.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
function pad(text) {
    // Filler that clears MIN_TRANSCRIPT_CHARS without adding lexicon terms or topic words.
    return `${text} ${'and then we said more about it '.repeat(6)}`;
}
describe('deriveRecordingTitle', () => {
    it('returns null for transcripts too short to name confidently', () => {
        expect(deriveRecordingTitle('', AT)).toBeNull();
        expect(deriveRecordingTitle('vancomycin trough levels', AT)).toBeNull();
    });
    it('names by the two most-mentioned pharm terms, title-cased, with the date', () => {
        const transcript = pad('vancomycin dosing today. vancomycin troughs matter. we adjust vancomycin by weight. ' +
            'warfarin interactions come up once. gentamicin is dosed alongside vancomycin sometimes, gentamicin peaks too.');
        expect(deriveRecordingTitle(transcript, AT)).toBe(`Vancomycin & Gentamicin — ${DATE_TAG}`);
    });
    it('uses a single pharm term alone when only one is mentioned', () => {
        const title = deriveRecordingTitle(pad('metoprolol is a beta blocker. metoprolol succinate versus tartrate.'), AT);
        expect(title).toBe(`Metoprolol — ${DATE_TAG}`);
    });
    it('falls back to the opening topic phrase with spoken lead-ins stripped', () => {
        const transcript = pad("Okay so um today we're going to talk about renal clearance calculations for elderly patients. Take notes.");
        expect(deriveRecordingTitle(transcript, AT)).toBe(`Renal clearance calculations for elderly — ${DATE_TAG}`);
    });
    it('returns null when the transcript is long but has no usable topic', () => {
        expect(deriveRecordingTitle('okay so um yeah. '.repeat(20), AT)).toBeNull();
    });
    it('never emits characters unsafe for Library file names', () => {
        const transcript = pad('Chapter 3/4: "dosing" [review] #1 next week covers more chapters of this material');
        const title = deriveRecordingTitle(transcript, AT);
        expect(title).not.toBeNull();
        expect(title).not.toMatch(/[\\/:*?"<>|[\]#^]/);
    });
});
