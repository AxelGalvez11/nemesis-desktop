// The agent→Study bridge. Study decks live in localStorage, which the agent (a separate
// process with file tools) can't reach — so the agent writes DECK FILES into the vault's
// Flashcards folder (see the nemesis-study-decks skill) and the Study page treats that
// folder as the source of truth: every visit (and window refocus) rescans it and
// reconciles decks against the files (model.ts reconcileDeckFiles), so renames, card
// edits, course changes, and deletions the agent makes on disk all land in Study —
// with FSRS review progress preserved for cards whose text survived the edit.
import { parseCardPaste, type ParsedCard } from './import-cards'

export const DECK_DIR = '~/Documents/Nemesis Library/Flashcards'

// Pre-reconcile builds imported each file once and tracked it here. The registry is
// now read-only legacy: adoptLegacyDeckFiles (model.ts) uses it to relink those early
// decks to their files so the first reconcile updates them instead of duplicating them.
const REGISTRY_KEY = 'nemesis.study.deckFiles.v1'

export interface DeckFileCandidate {
  fileName: string
  name: string
  course?: string
  cards: ParsedCard[]
}

function loadRegistry(): Set<string> {
  try {
    const raw = window.localStorage.getItem(REGISTRY_KEY)

    if (raw) {
      const parsed = JSON.parse(raw) as unknown

      if (Array.isArray(parsed)) {
        return new Set(parsed.filter((item): item is string => typeof item === 'string'))
      }
    }
  } catch {
    // corrupted registry → treat as empty (worst case: an early deck shows up twice)
  }

  return new Set()
}

/** File names the legacy import-once flow already brought in (see adoptLegacyDeckFiles). */
export function importedDeckFileNames(): string[] {
  return [...loadRegistry()]
}

/** Every parseable deck file in the vault, no import filter — reconcile's view of the
 *  folder. Returns null when the folder can't be read (no desktop bridge, folder
 *  missing, or any file unreadable): to reconcile, an empty list means "the agent
 *  deleted every deck file" and would remove the linked decks, so a failed scan must
 *  never masquerade as an empty folder. */
export async function scanAllDeckFiles(): Promise<DeckFileCandidate[] | null> {
  const api = window.hermesDesktop

  if (!api?.readDir || !api.readFileText) {
    return null
  }

  let entries: { isDirectory: boolean; name: string; path: string }[]

  try {
    const dir = await api.readDir(DECK_DIR)

    if (dir.error) {
      return null
    }

    entries = dir.entries
  } catch {
    return null
  }

  const out: DeckFileCandidate[] = []

  for (const entry of entries) {
    if (entry.isDirectory || !/\.(tsv|txt|md)$/i.test(entry.name)) {
      continue
    }

    let text = ''

    try {
      const read = await api.readFileText(entry.path)
      text = read.text ?? ''
    } catch {
      // One unreadable file must not look like a deleted deck — abandon the round.
      return null
    }

    // Optional metadata header the skill writes: "# course: Pharmacology"
    const courseMatch = text.match(/^#\s*course:\s*(.+)$/im)
    // Comment lines are metadata, not cards.
    const body = text
      .split(/\r?\n/)
      .filter(line => !line.trim().startsWith('#'))
      .join('\n')
    const cards = parseCardPaste(body)

    out.push({
      cards,
      course: courseMatch?.[1]?.trim(),
      fileName: entry.name,
      name: entry.name.replace(/\.(tsv|txt|md)$/i, '')
    })
  }

  return out
}
