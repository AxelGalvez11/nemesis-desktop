// Global note search — filename match is instant (title contains the query), full-text
// match scans each note's already-in-memory content (loadVaultContents reads every note's
// text upfront, so this needs no extra I/O) and surfaces the first matching line as a
// snippet. Pure and synchronous: the caller (index.tsx) debounces re-running it, not this.
import type { VaultNote } from './vault'

export interface SearchHit {
  note: VaultNote
  /** The first line of the note's content containing the query, trimmed — null when the
   *  note matched by title only and its body doesn't also contain the query. */
  snippet: string | null
}

/** The first line of `content` containing `query` (case-insensitive), trimmed — or null. */
function firstMatchingLine(content: string, query: string): string | null {
  for (const line of content.split('\n')) {
    if (line.toLowerCase().includes(query)) {
      return line.trim()
    }
  }

  return null
}

/** Search notes by title first, then by body text — case-insensitive substring match, no
 *  operators. Title matches rank first (then alphabetically); a note matching only in its
 *  body follows, also alphabetical. A blank query returns no results (the caller falls back
 *  to the normal folder tree). */
export function searchNotes(notes: readonly VaultNote[], rawQuery: string): SearchHit[] {
  const query = rawQuery.trim().toLowerCase()

  if (!query) {
    return []
  }

  const titleHits: SearchHit[] = []
  const bodyHits: SearchHit[] = []

  for (const note of notes) {
    const snippet = firstMatchingLine(note.content, query)

    if (note.title.toLowerCase().includes(query)) {
      titleHits.push({ note, snippet })
    } else if (snippet !== null) {
      bodyHits.push({ note, snippet })
    }
  }

  const byTitle = (a: SearchHit, b: SearchHit) => a.note.title.localeCompare(b.note.title)

  return [...titleHits.sort(byTitle), ...bodyHits.sort(byTitle)]
}
