// The relaunch card's whole contract lives in relaunchCardState: silent while
// downloading, actionable card once downloaded, manual fallback ONLY when the
// silent updater can't run AND a newer release provably exists. The old
// floating banner narrated "downloading in the background" and had a "Later"
// button — both removed by owner ask (2026-07-16, Claude Code updater parity).
import { describe, expect, it } from 'vitest';
import { relaunchCardState } from './nemesis-relaunch-card';
describe('relaunchCardState', () => {
    it('is silent while the background download works', () => {
        expect(relaunchCardState('working', 'v0.1.0-beta.17', '0.1.0-beta.16')).toBeNull();
    });
    it('shows the relaunch card once the update is downloaded', () => {
        expect(relaunchCardState('downloaded', 'v0.1.0-beta.17', '0.1.0-beta.16')).toEqual({
            kind: 'relaunch',
            version: '0.1.0-beta.17'
        });
    });
    it('relaunch card works without the GitHub tag (rate-limited fetch)', () => {
        expect(relaunchCardState('downloaded', null, '0.1.0-beta.16')).toEqual({
            kind: 'relaunch',
            version: null
        });
    });
    it('trusts the silent updater over a stale GitHub tag', () => {
        // GitHub still reports the CURRENT version (CDN lag) — downloaded wins.
        expect(relaunchCardState('downloaded', 'v0.1.0-beta.16', '0.1.0-beta.16')?.kind).toBe('relaunch');
    });
    it('falls back to manual download only when the updater cannot run', () => {
        expect(relaunchCardState('error', 'v0.1.0-beta.17', '0.1.0-beta.16')).toEqual({
            kind: 'manual',
            version: '0.1.0-beta.17'
        });
        expect(relaunchCardState('unavailable', 'v0.1.0-beta.17', '0.1.0-beta.16')?.kind).toBe('manual');
    });
    it('never nags without proof of a newer release', () => {
        expect(relaunchCardState('error', null, '0.1.0-beta.16')).toBeNull();
        expect(relaunchCardState('error', 'v0.1.0-beta.16', '0.1.0-beta.16')).toBeNull();
        expect(relaunchCardState('error', 'v0.1.0-beta.15', '0.1.0-beta.16')).toBeNull();
        expect(relaunchCardState('unavailable', 'v0.1.0-beta.17', null)).toBeNull();
    });
    it('ignores malformed tags', () => {
        expect(relaunchCardState('error', 'nightly-build', '0.1.0-beta.16')).toBeNull();
    });
});
