import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extractTypedLinks, loadVaultContents, VAULT_DIR } from './vault';
const dir = (name, parent) => ({ isDirectory: true, name, path: `${parent}/${name}` });
const file = (name, parent) => ({ isDirectory: false, name, path: `${parent}/${name}` });
// Fake vault. Root holds the three Study-owned folders (hidden from the Library),
// a dot-folder (hidden), a real course folder, and loose files. The course folder
// nests its own "Tests" — Study-owned names are hidden at ANY depth, so it hides too.
const TREE = {
    [VAULT_DIR]: [
        dir('Cardio Notes', VAULT_DIR),
        dir('Flashcards', VAULT_DIR),
        dir('Mindmaps', VAULT_DIR),
        dir('Tests', VAULT_DIR),
        dir('.obsidian', VAULT_DIR),
        file('Syllabus.md', VAULT_DIR),
        file('anatomy.png', VAULT_DIR),
        file('junk.xyz', VAULT_DIR)
    ],
    [`${VAULT_DIR}/Cardio Notes`]: [
        file('HF.md', `${VAULT_DIR}/Cardio Notes`),
        dir('Tests', `${VAULT_DIR}/Cardio Notes`)
    ],
    [`${VAULT_DIR}/Cardio Notes/Tests`]: [file('inner.md', `${VAULT_DIR}/Cardio Notes/Tests`)],
    [`${VAULT_DIR}/Flashcards`]: [file('sneaky.md', `${VAULT_DIR}/Flashcards`)],
    [`${VAULT_DIR}/Mindmaps`]: [file('Antiarrhythmics.md', `${VAULT_DIR}/Mindmaps`)],
    [`${VAULT_DIR}/.obsidian`]: [file('workspace.md', `${VAULT_DIR}/.obsidian`)]
};
beforeEach(() => {
    vi.stubGlobal('window', {
        hermesDesktop: {
            readDir: async (path) => TREE[path] ? { entries: TREE[path] } : { entries: [], error: 'not found' },
            readFileText: async (path) => ({ text: `# ${path}` }),
            writeTextFile: async () => ({ ok: true })
        }
    });
});
describe('loadVaultContents', () => {
    it('hides Study folders (Flashcards, Mindmaps, Tests) and dot-folders', async () => {
        const contents = await loadVaultContents();
        expect(contents.folders).toEqual(['Cardio Notes']);
        const titles = contents.notes.map(n => n.title);
        expect(titles).not.toContain('sneaky');
        expect(titles).not.toContain('Antiarrhythmics');
        expect(titles).not.toContain('workspace');
    });
    it('keeps ordinary notes and previewable files, skipping unknown extensions', async () => {
        const contents = await loadVaultContents();
        expect([...contents.notes.map(n => n.title)].sort()).toEqual(['HF', 'Syllabus'].sort());
        expect(contents.files).toEqual([{ folder: '', kind: 'image', name: 'anatomy.png', path: `${VAULT_DIR}/anatomy.png` }]);
    });
    it('hides Study-owned folder names at any depth, not just the vault root', async () => {
        const contents = await loadVaultContents();
        expect(contents.folders).not.toContain('Cardio Notes/Tests');
        expect(contents.notes.map(n => n.title)).not.toContain('inner');
    });
});
describe('extractTypedLinks', () => {
    it('extracts a typed link from a ## Related bullet', () => {
        const content = '# Note\n\n## Related\n- Prerequisite of: [[Beta blockers]]\n';
        expect(extractTypedLinks(content)).toEqual([{ prefix: 'Prerequisite of', target: 'Beta blockers', type: 'prerequisite-of' }]);
    });
    it('flags an invented relationship word with type null', () => {
        const content = '## Related\n- Causes: [[Warfarin]]\n';
        expect(extractTypedLinks(content)).toEqual([{ prefix: 'Causes', target: 'Warfarin', type: null }]);
    });
    it('does not return an untyped bullet (no relationship word before the link)', () => {
        const content = '## Related\n- [[Tirzepatide]] — same drug family\n';
        expect(extractTypedLinks(content)).toEqual([]);
    });
    it('also parses a ## Connections section', () => {
        const content = '## Connections\n- Part of: [[GLP-1 receptor agonists]]\n';
        expect(extractTypedLinks(content)).toEqual([{ prefix: 'Part of', target: 'GLP-1 receptor agonists', type: 'part-of' }]);
    });
    it('stops at the next ## heading and ignores bullets outside Related/Connections', () => {
        const content = '## Related\n- Related to: [[Semaglutide]]\n\n## Evidence\n- Contrasts with: [[Placebo]]\n';
        expect(extractTypedLinks(content)).toEqual([{ prefix: 'Related to', target: 'Semaglutide', type: 'related-to' }]);
    });
    it('accepts the "Example of" alias as applied-in', () => {
        const content = '## Related\n- Example of: [[ACE inhibitors]]\n';
        expect(extractTypedLinks(content)[0]?.type).toBe('applied-in');
    });
    it('trims the target to the note title before any alias/heading suffix', () => {
        const content = '## Related\n- Applied in: [[Heart failure|HFrEF]]\n';
        expect(extractTypedLinks(content)).toEqual([{ prefix: 'Applied in', target: 'Heart failure', type: 'applied-in' }]);
    });
    it('returns no typed links when there is no Related/Connections section', () => {
        const content = '# Note\n\nJust prose with [[Something]] mentioned inline.\n';
        expect(extractTypedLinks(content)).toEqual([]);
    });
});
