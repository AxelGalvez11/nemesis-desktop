import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadVaultContents, VAULT_DIR } from './vault';
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
