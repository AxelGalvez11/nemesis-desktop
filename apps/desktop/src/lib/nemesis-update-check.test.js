import { describe, expect, it } from 'vitest';
import { fetchLatestReleaseTag, isNewerVersion, normalizeVersion } from './nemesis-update-check';
describe('normalizeVersion', () => {
    it('strips the tag v prefix and whitespace', () => {
        expect(normalizeVersion('v0.1.0-beta.2')).toBe('0.1.0-beta.2');
        expect(normalizeVersion(' V1.2.3 ')).toBe('1.2.3');
        expect(normalizeVersion('0.1.0')).toBe('0.1.0');
    });
});
describe('isNewerVersion', () => {
    it('orders prerelease numbers numerically, not lexicographically', () => {
        expect(isNewerVersion('0.1.0-beta.2', '0.1.0-beta.1')).toBe(true);
        expect(isNewerVersion('0.1.0-beta.10', '0.1.0-beta.9')).toBe(true);
        expect(isNewerVersion('0.1.0-beta.1', '0.1.0-beta.2')).toBe(false);
    });
    it('ranks a full release above its prereleases', () => {
        expect(isNewerVersion('0.1.0', '0.1.0-beta.9')).toBe(true);
        expect(isNewerVersion('0.1.0-beta.9', '0.1.0')).toBe(false);
    });
    it('compares main versions numerically', () => {
        expect(isNewerVersion('0.2.0', '0.1.9')).toBe(true);
        expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true);
        expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false);
        expect(isNewerVersion('0.1.0', '0.1.1')).toBe(false);
    });
    it('accepts tag-style v prefixes on either side', () => {
        expect(isNewerVersion('v0.1.0-beta.2', '0.1.0-beta.1')).toBe(true);
        expect(isNewerVersion('v0.1.0-beta.1', 'v0.1.0-beta.1')).toBe(false);
    });
    it('never reports garbage as newer (fail-safe: no banner)', () => {
        expect(isNewerVersion('latest', '0.1.0-beta.1')).toBe(false);
        expect(isNewerVersion('', '0.1.0-beta.1')).toBe(false);
        expect(isNewerVersion('0.1.0-beta.2', 'not-a-version')).toBe(false);
    });
});
describe('fetchLatestReleaseTag', () => {
    const okResponse = (body, ok = true) => ({ json: async () => body, ok });
    it('returns the tag from a healthy response', async () => {
        const tag = await fetchLatestReleaseTag(async () => okResponse({ tag_name: 'v0.1.0-beta.2' }));
        expect(tag).toBe('v0.1.0-beta.2');
    });
    it('returns null on HTTP errors, network failures, and missing tags', async () => {
        expect(await fetchLatestReleaseTag(async () => okResponse({ message: 'rate limited' }, false))).toBeNull();
        expect(await fetchLatestReleaseTag(async () => {
            throw new Error('offline');
        })).toBeNull();
        expect(await fetchLatestReleaseTag(async () => okResponse({}))).toBeNull();
        expect(await fetchLatestReleaseTag(async () => okResponse({ tag_name: '  ' }))).toBeNull();
    });
});
