import { describe, expect, it } from 'vitest'

import { isPathWithin, remappedPath } from './nav-remap'

describe('remappedPath', () => {
  it('remaps an exact match (a renamed note)', () => {
    expect(remappedPath('/vault/Old.md', '/vault/Old.md', '/vault/New.md')).toBe('/vault/New.md')
  })

  it('remaps a path nested one level under a renamed folder', () => {
    expect(remappedPath('/vault/OldFolder/Note.md', '/vault/OldFolder', '/vault/NewFolder')).toBe(
      '/vault/NewFolder/Note.md'
    )
  })

  it('remaps a path nested several levels under a renamed folder', () => {
    expect(remappedPath('/vault/OldFolder/sub/deep/Note.md', '/vault/OldFolder', '/vault/NewFolder')).toBe(
      '/vault/NewFolder/sub/deep/Note.md'
    )
  })

  it('returns null for an unrelated path', () => {
    expect(remappedPath('/vault/Other.md', '/vault/Old.md', '/vault/New.md')).toBeNull()
  })

  it('does not false-positive on a sibling folder with a matching prefix', () => {
    // "OldFolderExtra" starts with "OldFolder" as a string, but is not nested under it.
    expect(remappedPath('/vault/OldFolderExtra/Note.md', '/vault/OldFolder', '/vault/NewFolder')).toBeNull()
  })
})

describe('isPathWithin', () => {
  it('is true for the root itself', () => {
    expect(isPathWithin('/vault/Folder', '/vault/Folder')).toBe(true)
  })

  it('is true for a nested path', () => {
    expect(isPathWithin('/vault/Folder/Note.md', '/vault/Folder')).toBe(true)
  })

  it('is false for an unrelated path', () => {
    expect(isPathWithin('/vault/Other.md', '/vault/Folder')).toBe(false)
  })

  it('is false for a sibling with a matching string prefix', () => {
    expect(isPathWithin('/vault/FolderExtra/Note.md', '/vault/Folder')).toBe(false)
  })
})
