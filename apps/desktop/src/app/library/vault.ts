// Library vault: plain Markdown files in ~/Documents/Nemesis Library, read and written
// through the existing hardened fs IPC (window.hermesDesktop) — Obsidian-compatible by
// construction (a student can point Obsidian at the same folder). Wiki-links use the
// Obsidian syntax family: [[Title]], [[Title|alias]], [[Title#heading]].
// The link index built here also feeds the Graph page (node = note, edge = wikilink).

export const VAULT_DIR = '~/Documents/Nemesis Library'

export interface VaultNote {
  /** Title = file name without .md (the wikilink target). */
  title: string
  path: string
  content: string
}

export interface VaultIndex {
  notes: VaultNote[]
  /** title → titles it links to (resolved, existing notes only). */
  links: Map<string, string[]>
  /** title → titles that link TO it. */
  backlinks: Map<string, string[]>
}

const WIKILINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g

/** Extract raw wikilink targets from markdown (deduped, order kept). */
export function extractWikilinks(markdown: string): string[] {
  const seen = new Set<string>()
  const targets: string[] = []

  for (const match of markdown.matchAll(WIKILINK)) {
    const target = match[1].trim()

    if (target && !seen.has(target.toLowerCase())) {
      seen.add(target.toLowerCase())
      targets.push(target)
    }
  }

  return targets
}

/** Build the link/backlink index. Pure. */
export function buildIndex(notes: VaultNote[]): VaultIndex {
  const byLower = new Map(notes.map(note => [note.title.toLowerCase(), note.title]))
  const links = new Map<string, string[]>()
  const backlinks = new Map<string, string[]>(notes.map(note => [note.title, []]))

  for (const note of notes) {
    const resolved = extractWikilinks(note.content)
      .map(target => byLower.get(target.toLowerCase()))
      .filter((title): title is string => Boolean(title) && title !== note.title)
    links.set(note.title, resolved)

    for (const target of resolved) {
      backlinks.get(target)?.push(note.title)
    }
  }

  return { backlinks, links, notes }
}

function bridge() {
  const api = window.hermesDesktop

  if (!api?.readDir || !api.readFileText || !api.writeTextFile) {
    throw new Error('File access is unavailable in this build.')
  }

  return api as typeof api & {
    readDir: NonNullable<typeof api.readDir>
    writeTextFile: NonNullable<typeof api.writeTextFile>
  }
}

export async function loadVault(): Promise<VaultNote[]> {
  const api = bridge()
  const dir = await api.readDir(VAULT_DIR)

  if (dir.error) {
    throw new Error(dir.error)
  }

  const files = dir.entries.filter(entry => !entry.isDirectory && entry.name.toLowerCase().endsWith('.md'))
  const notes: VaultNote[] = []

  for (const file of files) {
    const read = await api.readFileText(file.path)
    notes.push({ content: read.text ?? '', path: file.path, title: file.name.replace(/\.md$/i, '') })
  }

  return notes.sort((a, b) => a.title.localeCompare(b.title))
}

export async function saveNote(title: string, content: string): Promise<string> {
  const api = bridge()
  const safe = title.replace(/[/\\:]/g, '-').trim() || 'Untitled'
  const result = await api.writeTextFile(`${VAULT_DIR}/${safe}.md`, content)

  return result.path
}

/** First-run seed: linked pharm notes so the Library (and Graph) teach themselves. */
export const SEED_NOTES: { title: string; content: string }[] = [
  {
    title: 'ACE inhibitors',
    content:
      '# ACE inhibitors\n\nLisinopril, enalapril. Block angiotensin I → II; raise bradykinin.\n\n- **Dry cough** — bradykinin buildup; switch to [[ARBs]] if intolerable.\n- **Angioedema** — rare, serious; stop immediately.\n- Contraindicated in pregnancy (fetal renal toxicity) — like all RAAS blockers.\n- Monitor potassium + creatinine after starting (see [[Hyperkalemia]]).\n\nOften paired with [[Diuretics]] in [[Heart failure]].\n'
  },
  {
    title: 'ARBs',
    content:
      '# ARBs\n\nLosartan, valsartan. Block the AT1 receptor directly — same RAAS effect as [[ACE inhibitors]] but bradykinin is untouched, so no cough.\n\n- Same pregnancy contraindication and [[Hyperkalemia]] risk.\n- First swap when an ACE-inhibitor cough is intolerable.\n'
  },
  {
    title: 'Diuretics',
    content:
      '# Diuretics\n\n- **Furosemide** (loop): thick ascending limb, potent; hypokalemia + hypOcalcemia.\n- **HCTZ** (thiazide): distal tubule, milder; hypokalemia + hypERcalcemia.\n- **Spironolactone**: aldosterone antagonist — potassium-sparing; watch [[Hyperkalemia]] with [[ACE inhibitors]].\n\nCore of congestion control in [[Heart failure]].\n'
  },
  {
    title: 'Heart failure',
    content:
      '# Heart failure\n\nGuideline-directed therapy touches almost every cardio class:\n\n1. [[ACE inhibitors]] or [[ARBs]] (or ARNI)\n2. Beta blocker (bisoprolol, carvedilol, metoprolol succinate)\n3. [[Diuretics]] for congestion\n4. Spironolactone — mind [[Hyperkalemia]]\n'
  },
  {
    title: 'Hyperkalemia',
    content:
      '# Hyperkalemia\n\nK⁺ > 5.0-5.5. Drug causes to know cold:\n\n- [[ACE inhibitors]] / [[ARBs]] (less aldosterone)\n- Spironolactone (see [[Diuretics]])\n- TMP-SMX, NSAIDs\n\nThe classic exam combo: ACE inhibitor + spironolactone in [[Heart failure]].\n'
  },
  {
    title: 'Warfarin interactions',
    content:
      '# Warfarin interactions\n\nNarrow index; INR moves with CYP2C9.\n\n- TMP-SMX → INR **up** (2C9 inhibition + protein-binding displacement).\n- Rifampin → INR **down** (induction).\n- Amiodarone → INR **up**.\n\nNot RAAS-linked, but shares the "monitor potassium/INR after any change" reflex from [[ACE inhibitors]].\n'
  }
]
