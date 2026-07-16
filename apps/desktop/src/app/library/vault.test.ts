import { beforeEach, describe, expect, it, vi } from 'vitest'

import { loadVaultContents, VAULT_DIR } from './vault'

interface FakeEntry {
  isDirectory: boolean
  name: string
  path: string
}

const dir = (name: string, parent: string): FakeEntry => ({ isDirectory: true, name, path: `${parent}/${name}` })
const file = (name: string, parent: string): FakeEntry => ({ isDirectory: false, name, path: `${parent}/${name}` })

// Fake vault. Root holds the three Study-owned folders (hidden from the Library),
// a dot-folder (hidden), a real course folder, and loose files. The course folder
// nests its own "Tests" — Study ownership is root-level only, so that one stays.
const TREE: Record<string, FakeEntry[]> = {
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
}

beforeEach(() => {
  vi.stubGlobal('window', {
    hermesDesktop: {
      readDir: async (path: string) =>
        TREE[path] ? { entries: TREE[path] } : { entries: [], error: 'not found' },
      readFileText: async (path: string) => ({ text: `# ${path}` }),
      writeTextFile: async () => ({ ok: true })
    }
  })
})

describe('loadVaultContents', () => {
  it('hides root-level Study folders (Flashcards, Mindmaps, Tests) and dot-folders', async () => {
    const contents = await loadVaultContents()

    expect(contents.folders).toEqual(['Cardio Notes', 'Cardio Notes/Tests'])

    const titles = contents.notes.map(n => n.title)
    expect(titles).not.toContain('sneaky')
    expect(titles).not.toContain('Antiarrhythmics')
    expect(titles).not.toContain('workspace')
  })

  it('keeps ordinary notes and previewable files, skipping unknown extensions', async () => {
    const contents = await loadVaultContents()

    expect([...contents.notes.map(n => n.title)].sort()).toEqual(['HF', 'Syllabus', 'inner'].sort())
    expect(contents.files).toEqual([{ folder: '', kind: 'image', name: 'anatomy.png', path: `${VAULT_DIR}/anatomy.png` }])
  })

  it('keeps a course-level "Tests" subfolder — only root-level Study folders are owned', async () => {
    const contents = await loadVaultContents()

    expect(contents.folders).toContain('Cardio Notes/Tests')
    expect(contents.notes.map(n => n.title)).toContain('inner')
  })
})
