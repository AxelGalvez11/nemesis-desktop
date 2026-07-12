import { describe, expect, it } from 'vitest';
import { extractIntent } from './activity-strip';
describe('extractIntent', () => {
    it('returns the first full sentence of the reasoning', () => {
        expect(extractIntent("I'll compare the 2025 guideline against the 2017 framework, then separate what changed. After that…")).toBe("I'll compare the 2025 guideline against the 2017 framework, then separate what changed.");
    });
    it('is empty until enough has streamed to read as a statement', () => {
        expect(extractIntent('I')).toBe('');
        expect(extractIntent("I'll che")).toBe('');
    });
    it('suppresses meta-narration that restates the question instead of stating a plan', () => {
        expect(extractIntent('The user is asking a clinical pharmacology question about ACE inhibitors vs ARBs, specifically the cough.')).toBe('');
        expect(extractIntent("They're asking about warfarin interactions, so I should look those up.")).toBe('');
        expect(extractIntent('So the question is really about renal dosing thresholds.')).toBe('');
        expect(extractIntent('Let me think about what they actually need here first.')).toBe('');
    });
    it('still shows a genuine first-person plan', () => {
        expect(extractIntent("I'll compare the two drug classes, then lay out the monitoring. Next step…")).toBe("I'll compare the two drug classes, then lay out the monitoring.");
    });
    it('word-cuts a long run-on (>=140 chars) that has no sentence boundary yet', () => {
        const long = 'I should look at the latest biopharma developments across company releases and regulators and reputable trade reporting before I actually answer this question here';
        const out = extractIntent(long);
        expect(out.endsWith('…')).toBe(true);
        expect(out.length).toBeLessThanOrEqual(174);
        expect(out).not.toMatch(/\s…$/); // trailing space trimmed before the ellipsis
    });
    it('strips markdown and inline code so the line reads as plain prose', () => {
        expect(extractIntent('**First** I will check the `label` for dosing. Then more.')).toBe('First I will check the label for dosing.');
    });
    it('truncates an over-long first sentence to ~170 chars rather than a paragraph', () => {
        const wall = `${'word '.repeat(80)}.`;
        const out = extractIntent(wall);
        expect(out.endsWith('…')).toBe(true);
        expect(out.length).toBeLessThanOrEqual(174);
    });
});
