import { describe, expect, it } from 'vitest';
import { resolveEmbeddedImageSrc, resolveRelativeImageSrc, toFileUrl } from './image-embed';
describe('toFileUrl', () => {
    it('builds a file:// URL, percent-encoding spaces and special characters', () => {
        expect(toFileUrl('/vault/My Notes/pic.png')).toBe('file:///vault/My%20Notes/pic.png');
    });
    it('escapes a literal "#" so it is not read as a URL fragment', () => {
        expect(toFileUrl('/vault/pic#1.png')).toBe('file:///vault/pic%231.png');
    });
});
describe('resolveRelativeImageSrc', () => {
    it('joins a plain filename against a root note into a file:// URL', () => {
        expect(resolveRelativeImageSrc('pic.png', '', '/vault')).toBe('file:///vault/pic.png');
    });
    it('joins a plain filename against a foldered note', () => {
        expect(resolveRelativeImageSrc('pic.png', 'Cardio', '/vault')).toBe('file:///vault/Cardio/pic.png');
    });
    it('joins a subfolder-relative path', () => {
        expect(resolveRelativeImageSrc('assets/pic.png', 'Cardio', '/vault')).toBe('file:///vault/Cardio/assets/pic.png');
    });
    it('resolves a "../" parent-relative path', () => {
        expect(resolveRelativeImageSrc('../shared/pic.png', 'Cardio', '/vault')).toBe('file:///vault/shared/pic.png');
    });
    it('drops a leading "./"', () => {
        expect(resolveRelativeImageSrc('./pic.png', 'Cardio', '/vault')).toBe('file:///vault/Cardio/pic.png');
    });
    it('file:// wraps an already-absolute filesystem path', () => {
        expect(resolveRelativeImageSrc('/Users/x/pic.png', 'Cardio', '/vault')).toBe('file:///Users/x/pic.png');
    });
    it('passes an http(s) URL through unchanged (no file:// wrapping)', () => {
        expect(resolveRelativeImageSrc('http://example.com/pic.png', 'Cardio', '/vault')).toBe('http://example.com/pic.png');
        expect(resolveRelativeImageSrc('https://example.com/pic.png', '', '/vault')).toBe('https://example.com/pic.png');
    });
    it('passes a data: URL through unchanged', () => {
        expect(resolveRelativeImageSrc('data:image/png;base64,AAAA', '', '/vault')).toBe('data:image/png;base64,AAAA');
    });
    it('trims surrounding whitespace', () => {
        expect(resolveRelativeImageSrc('  pic.png  ', '', '/vault')).toBe('file:///vault/pic.png');
    });
});
describe('resolveEmbeddedImageSrc', () => {
    const files = [
        { name: 'diagram.png', path: '/vault/Cardio/diagram.png' },
        { name: 'Cover.jpg', path: '/vault/Cover.jpg' }
    ];
    it('finds a file by exact name and returns a file:// URL', () => {
        expect(resolveEmbeddedImageSrc('diagram.png', files)).toBe('file:///vault/Cardio/diagram.png');
    });
    it('matches case-insensitively', () => {
        expect(resolveEmbeddedImageSrc('COVER.JPG', files)).toBe('file:///vault/Cover.jpg');
    });
    it('returns null when no file matches', () => {
        expect(resolveEmbeddedImageSrc('missing.png', files)).toBeNull();
    });
    it('returns null for a blank name', () => {
        expect(resolveEmbeddedImageSrc('   ', files)).toBeNull();
    });
});
