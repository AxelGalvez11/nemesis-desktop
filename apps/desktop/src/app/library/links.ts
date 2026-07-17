// Wikilink resolution + rename cascade — pure logic shared by the editor's live-preview
// styling (resolved vs. unresolved [[links]]), the click/create-on-click behavior
// (index.tsx's openWikilink), and the note-rename cascade. Kept in one file specifically so
// "does this wikilink resolve" can never drift between what's rendered and what clicking
// actually does — every caller goes through the same key-normalization rule below.

export interface LinkableNote {
  title: string
  /** '' for root notes. */
  folder: string
}

function normalizeWikilinkKey(value: string): string {
  return value.trim().toLowerCase()
}

/** The lookup keys a note is reachable by: its bare title, plus its folder-qualified
 *  "folder/Title" path when it's not a root note (matches the two forms the agent and the
 *  editor both write — see vault.ts's SEED_NOTES and index.tsx's openWikilink). */
export function keysForNote(note: LinkableNote): string[] {
  const keys = [normalizeWikilinkKey(note.title)]

  if (note.folder) {
    keys.push(normalizeWikilinkKey(`${note.folder}/${note.title}`))
  }

  return keys
}

/** Every key a wikilink target can resolve by, across the whole vault — pass to the editor
 *  so it can style a link as resolved/unresolved without re-scanning the note list on
 *  every keystroke. */
export function buildResolvableTitleSet(notes: readonly LinkableNote[]): Set<string> {
  const set = new Set<string>()

  for (const note of notes) {
    for (const key of keysForNote(note)) {
      set.add(key)
    }
  }

  return set
}

/** Whether a wikilink target resolves, given a set built by buildResolvableTitleSet. */
export function isWikilinkResolved(target: string, resolvable: ReadonlySet<string>): boolean {
  return resolvable.has(normalizeWikilinkKey(target))
}

/** Find the note a wikilink target actually points at (bare title or folder-qualified),
 *  or undefined if it doesn't resolve — the same rule buildResolvableTitleSet indexes. */
export function findLinkedNote<T extends LinkableNote>(target: string, notes: readonly T[]): T | undefined {
  const wanted = normalizeWikilinkKey(target)

  return notes.find(note => keysForNote(note).includes(wanted))
}

const WIKILINK_FULL_RE = /\[\[([^\]|#]+)(#[^\]|]*)?(\|[^\]]*)?\]\]/g

/** Rewrite every wikilink in `content` that targets `oldTitle` (exact title match,
 *  case-insensitive) so it targets `newTitle` instead — preserving any folder-path prefix,
 *  "#heading" anchor, and "|alias" tail untouched. Covers [[Old]], [[Old|alias]],
 *  [[Old#heading]], [[dir/Old]], and combinations; a link to a DIFFERENT title that merely
 *  starts with oldTitle (e.g. [[Older]]) is left alone. Pure — the caller is responsible for
 *  finding which notes changed and writing them back. */
export function rewriteWikilinks(content: string, oldTitle: string, newTitle: string): string {
  const wantedTitle = normalizeWikilinkKey(oldTitle)

  return content.replace(WIKILINK_FULL_RE, (full, rawTarget: string, heading = '', alias = '') => {
    const slash = rawTarget.lastIndexOf('/')
    const path = slash >= 0 ? rawTarget.slice(0, slash + 1) : ''
    const title = slash >= 0 ? rawTarget.slice(slash + 1) : rawTarget

    if (normalizeWikilinkKey(title) !== wantedTitle) {
      return full
    }

    return `[[${path}${newTitle}${heading}${alias}]]`
  })
}
