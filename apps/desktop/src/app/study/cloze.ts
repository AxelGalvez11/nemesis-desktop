// Anki-style cloze deletions for Study cards: {{c1::text}} / {{c1::text::hint}}
// inside card.front. A card with markers is studied one cloze index at a time —
// the active index's spans are blanked to [...] (or [hint]) while every other
// index shows its text — and each distinct index gets its own FSRS schedule
// slot (`${cardId}#c${n}`, see model.ts scheduleTargets). Only the syntax is
// shared with Anki (students' muscle memory and existing decks carry over);
// no Anki code is used — same licensing stance as model.ts.

export interface ClozeSegment {
  /** Literal text between markers, or the inner text of a marker. */
  text: string
  /** Cloze index (the N of {{cN::…}}); absent for literal segments. */
  index?: number
  /** Optional hint ({{cN::text::hint}}), shown inside the blank. */
  hint?: string
}

export interface ParsedCloze {
  segments: ClozeSegment[]
  /** Distinct cloze indexes, ascending. Empty = not a cloze card. */
  indexes: number[]
}

// {{cN::text}} or {{cN::text::hint}}. Non-greedy so several markers on one
// front split correctly; nesting is not supported. Anything that doesn't match
// (unclosed braces, wrong letter) stays literal text — garbage passes through.
const CLOZE_PATTERN = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g
const CLOZE_MARKER = /\{\{c\d+::/

/** Cheap "does this front contain cloze markers?" probe (hot paths). */
export function hasClozeMarker(front: string): boolean {
  return CLOZE_MARKER.test(front)
}

/** Schedule/log key for one cloze slot. Card ids never contain '#'. */
export function clozeScheduleKey(cardId: string, index: number): string {
  return `${cardId}#c${index}`
}

export function parseCloze(front: string): ParsedCloze {
  const segments: ClozeSegment[] = []
  const indexes = new Set<number>()
  let cursor = 0

  CLOZE_PATTERN.lastIndex = 0

  for (let match = CLOZE_PATTERN.exec(front); match; match = CLOZE_PATTERN.exec(front)) {
    if (match.index > cursor) {
      segments.push({ text: front.slice(cursor, match.index) })
    }

    const index = Number(match[1])

    indexes.add(index)
    segments.push({ hint: match[3] || undefined, index, text: match[2] })
    cursor = match.index + match[0].length
  }

  if (cursor < front.length) {
    segments.push({ text: front.slice(cursor) })
  }

  return { indexes: [...indexes].sort((a, b) => a - b), segments }
}

/** Distinct cloze indexes in a card front (empty = plain card). */
export function clozeIndexes(front: string): number[] {
  return hasClozeMarker(front) ? parseCloze(front).indexes : []
}

/** The study prompt for one cloze index: that index's spans become [...] (or
 *  [hint]); every other index shows its text revealed; literals pass through. */
export function renderClozePrompt(front: string, activeIndex: number): string {
  return parseCloze(front)
    .segments.map(segment => {
      if (segment.index === undefined || segment.index !== activeIndex) {
        return segment.text
      }

      return segment.hint ? `[${segment.hint}]` : '[...]'
    })
    .join('')
}

/** The answer text: every cloze marker replaced by its revealed text. */
export function renderClozeAnswer(front: string): string {
  return parseCloze(front)
    .segments.map(segment => segment.text)
    .join('')
}
