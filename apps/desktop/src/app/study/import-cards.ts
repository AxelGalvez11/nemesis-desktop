// Paste-import parser for the Study page. Quizlet has no public API (2026) and its
// export is copy-paste text, so this accepts exactly what students can get out of it:
// one card per line, term/definition split by TAB (Quizlet's default), " - " (its
// common custom separator), or a comma as the last resort. Also fine for hand-typed
// lists and CSV-ish exports from other tools.

export interface ParsedCard {
  front: string
  back: string
}

const LINE_SPLIT = /\r?\n/

export function parseCardPaste(text: string): ParsedCard[] {
  const cards: ParsedCard[] = []

  for (const rawLine of text.split(LINE_SPLIT)) {
    const line = rawLine.trim()

    if (!line) {
      continue
    }

    const parsed = splitLine(line)

    if (parsed) {
      cards.push(parsed)
    }
  }

  return cards
}

function splitLine(line: string): ParsedCard | null {
  for (const separator of ['\t', ' - ', ',']) {
    const at = line.indexOf(separator)

    if (at > 0 && at < line.length - separator.length) {
      const front = line.slice(0, at).trim()
      const back = line.slice(at + separator.length).trim()

      if (front && back) {
        return { back, front }
      }
    }
  }

  return null
}
