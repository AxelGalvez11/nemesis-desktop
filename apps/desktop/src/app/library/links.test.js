import { describe, expect, it } from 'vitest';
import { buildResolvableTitleSet, findLinkedNote, isWikilinkResolved, linkTypeForPrefix, rewriteWikilinks } from './links';
const NOTES = [
    { folder: '', title: 'Heart failure' },
    { folder: 'Cardio', title: 'ACE inhibitors' },
    { folder: 'Cardio/Drugs', title: 'ARBs' }
];
describe('buildResolvableTitleSet + isWikilinkResolved', () => {
    const resolvable = buildResolvableTitleSet(NOTES);
    it('resolves a root note by its bare title, case-insensitively', () => {
        expect(isWikilinkResolved('Heart failure', resolvable)).toBe(true);
        expect(isWikilinkResolved('HEART FAILURE', resolvable)).toBe(true);
    });
    it('resolves a foldered note by its bare title too', () => {
        expect(isWikilinkResolved('ACE inhibitors', resolvable)).toBe(true);
    });
    it('resolves a foldered note by its folder-qualified path', () => {
        expect(isWikilinkResolved('Cardio/ACE inhibitors', resolvable)).toBe(true);
        expect(isWikilinkResolved('cardio/ace inhibitors', resolvable)).toBe(true);
    });
    it('resolves a nested-folder note by its full path', () => {
        expect(isWikilinkResolved('Cardio/Drugs/ARBs', resolvable)).toBe(true);
    });
    it('does not resolve a note that does not exist', () => {
        expect(isWikilinkResolved('Nonexistent', resolvable)).toBe(false);
    });
    it('does not resolve a similar-but-different title', () => {
        expect(isWikilinkResolved('Heart failure symptoms', resolvable)).toBe(false);
    });
});
describe('linkTypeForPrefix', () => {
    it('maps each of the five grammar prefixes to its type', () => {
        expect(linkTypeForPrefix('Prerequisite of')).toBe('prerequisite-of');
        expect(linkTypeForPrefix('Part of')).toBe('part-of');
        expect(linkTypeForPrefix('Related to')).toBe('related-to');
        expect(linkTypeForPrefix('Contrasts with')).toBe('contrasts-with');
        expect(linkTypeForPrefix('Applied in')).toBe('applied-in');
    });
    it('accepts "Example of" as an alias of applied-in', () => {
        expect(linkTypeForPrefix('Example of')).toBe('applied-in');
    });
    it('is case-insensitive and tolerates a trailing colon or surrounding whitespace', () => {
        expect(linkTypeForPrefix('PREREQUISITE OF:')).toBe('prerequisite-of');
        expect(linkTypeForPrefix('  related to  ')).toBe('related-to');
    });
    it('returns null for an invented prefix', () => {
        expect(linkTypeForPrefix('Causes')).toBeNull();
        expect(linkTypeForPrefix('See also')).toBeNull();
    });
});
describe('findLinkedNote', () => {
    it('finds a note by bare title', () => {
        expect(findLinkedNote('ace inhibitors', NOTES)?.title).toBe('ACE inhibitors');
    });
    it('finds a note by folder-qualified path', () => {
        expect(findLinkedNote('Cardio/ACE inhibitors', NOTES)?.title).toBe('ACE inhibitors');
    });
    it('returns undefined for an unresolved target', () => {
        expect(findLinkedNote('Missing', NOTES)).toBeUndefined();
    });
});
describe('rewriteWikilinks', () => {
    it('rewrites a bare [[Old]] link', () => {
        expect(rewriteWikilinks('See [[Old]] for more.', 'Old', 'New')).toBe('See [[New]] for more.');
    });
    it('rewrites [[Old|alias]], preserving the alias', () => {
        expect(rewriteWikilinks('[[Old|display text]]', 'Old', 'New')).toBe('[[New|display text]]');
    });
    it('rewrites [[Old#heading]], preserving the heading anchor', () => {
        expect(rewriteWikilinks('[[Old#Dosing]]', 'Old', 'New')).toBe('[[New#Dosing]]');
    });
    it('rewrites [[dir/Old]], preserving the folder path', () => {
        expect(rewriteWikilinks('[[Cardio/Old]]', 'Old', 'New')).toBe('[[Cardio/New]]');
    });
    it('rewrites a combined [[dir/Old#heading|alias]] link, preserving every other segment', () => {
        expect(rewriteWikilinks('[[Cardio/Old#Dosing|see here]]', 'Old', 'New')).toBe('[[Cardio/New#Dosing|see here]]');
    });
    it('does NOT match a title that merely starts with the old title', () => {
        expect(rewriteWikilinks('[[Older]] and [[Oldest]]', 'Old', 'New')).toBe('[[Older]] and [[Oldest]]');
    });
    it('matches case-insensitively but always outputs the canonical new title', () => {
        expect(rewriteWikilinks('[[OLD]] and [[old|x]]', 'Old', 'New')).toBe('[[New]] and [[New|x]]');
    });
    it('rewrites every occurrence in a longer note, leaving unrelated text untouched', () => {
        const content = '# Notes\n\n[[Old]] causes X. See also [[Old|the drug]] and [[Unrelated]].';
        const expected = '# Notes\n\n[[New]] causes X. See also [[New|the drug]] and [[Unrelated]].';
        expect(rewriteWikilinks(content, 'Old', 'New')).toBe(expected);
    });
    it('is a no-op when the title does not appear at all', () => {
        const content = 'Nothing to see here, just [[Other Note]].';
        expect(rewriteWikilinks(content, 'Old', 'New')).toBe(content);
    });
});
