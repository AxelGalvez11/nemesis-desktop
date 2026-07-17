// Library vault: plain Markdown files in ~/Documents/Nemesis Library, read and written
// through the existing hardened fs IPC (window.hermesDesktop) — Obsidian-compatible by
// construction (a student can point Obsidian at the same folder). Wiki-links use the
// Obsidian syntax family: [[Title]], [[Title|alias]], [[Title#heading]].
// The link index built here also feeds the Graph page (node = note, edge = wikilink).
import { keysForNote } from './links'

export const VAULT_DIR = '~/Documents/Nemesis Library'

export interface VaultNote {
  /** Title = file name without .md (the wikilink target). */
  title: string
  path: string
  content: string
  /** Folder relative to the vault root ('' = root). */
  folder: string
}

export type VaultFileKind = 'pdf' | 'slides' | 'doc' | 'image' | 'html' | 'other'

export interface VaultFile {
  name: string
  path: string
  folder: string
  kind: VaultFileKind
}

export interface VaultContents {
  notes: VaultNote[]
  files: VaultFile[]
  /** All folder paths present (relative to root), for the tree. */
  folders: string[]
}

function fileKind(name: string): null | VaultFileKind {
  const ext = name.toLowerCase().split('.').pop() ?? ''

  if (ext === 'pdf') return 'pdf'
  if (ext === 'html' || ext === 'htm') return 'html'
  if (ext === 'pptx' || ext === 'ppt' || ext === 'key') return 'slides'
  if (ext === 'docx' || ext === 'doc' || ext === 'pages') return 'doc'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image'

  return null
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
    // "[[target\|alias]]" (the escaped-pipe form wikilinks take inside markdown
    // tables) leaves a trailing backslash on the captured target — strip it.
    const target = match[1].replace(/\\$/, '').trim()

    if (target && !seen.has(target.toLowerCase())) {
      seen.add(target.toLowerCase())
      targets.push(target)
    }
  }

  return targets
}

const MD_LINK = /\[[^\]]*\]\(([^)]+)\)/g

/** Extract relative ".md" link targets ("[label](Note.md)" / "[label](folder/Note.md)")
 *  from markdown, as bare titles (matches VaultNote.title — the same key wikilinks
 *  resolve by). Absolute URLs, mailto/tel links, and protocol-relative links are skipped;
 *  only vault-relative markdown links count as a note-to-note connection. */
export function extractRelativeMdLinks(markdown: string): string[] {
  const seen = new Set<string>()
  const targets: string[] = []

  for (const match of markdown.matchAll(MD_LINK)) {
    const raw = match[1].trim().split('#')[0]

    if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) {
      continue // absolute URL / mailto: / protocol-relative — not a vault note
    }

    if (!raw.toLowerCase().endsWith('.md')) {
      continue
    }

    const fileName = raw.split('/').pop() ?? ''
    let target = fileName.replace(/\.md$/i, '')

    try {
      target = decodeURIComponent(target)
    } catch {
      // Malformed percent-escape — fall back to the raw text.
    }

    if (target && !seen.has(target.toLowerCase())) {
      seen.add(target.toLowerCase())
      targets.push(target)
    }
  }

  return targets
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/
// A tag starts with a letter so "#1" (a number) and "# Heading" (space) never count.
const INLINE_TAG_RE = /(^|[\s(])#([A-Za-z][\w/-]*)/g

/** Extract a note's tags (deduped, order kept): frontmatter `tags:` (inline list,
 *  comma string, or a `- item` block) plus Obsidian-style inline #tags in the body.
 *  Inline tags inside fenced code blocks don't count (a Python "#comment" isn't a tag). */
export function extractTags(markdown: string): string[] {
  const seen = new Set<string>()
  const tags: string[] = []

  const add = (raw: string) => {
    const tag = raw.trim().replace(/^['"]|['"]$/g, '').replace(/^#/, '').trim()

    if (tag && !seen.has(tag.toLowerCase())) {
      seen.add(tag.toLowerCase())
      tags.push(tag)
    }
  }

  const fm = FRONTMATTER_RE.exec(markdown)
  let body = markdown

  if (fm) {
    body = markdown.slice(fm[0].length)
    const lines = fm[1].split('\n')

    for (let i = 0; i < lines.length; i++) {
      const match = /^tags?\s*:\s*(.*)$/i.exec(lines[i])

      if (!match) {
        continue
      }

      const inline = match[1].trim().replace(/^\[|\]$/g, '')

      if (inline) {
        inline.split(',').forEach(add)
      } else {
        for (let j = i + 1; j < lines.length; j++) {
          const item = /^\s*-\s*(.+)$/.exec(lines[j])

          if (!item) {
            break
          }

          add(item[1])
        }
      }

      break
    }
  }

  let fenceChar: null | string = null

  for (const line of body.split('\n')) {
    const fence = FENCE.exec(line.trim())

    if (fence) {
      fenceChar = fenceChar === fence[1][0] ? null : (fenceChar ?? fence[1][0])

      continue
    }

    if (fenceChar) {
      continue
    }

    for (const match of line.matchAll(INLINE_TAG_RE)) {
      add(match[2])
    }
  }

  return tags
}

export interface NoteHeading {
  /** ATX heading level — the Outline tab is a table of contents for h1–h3 only. */
  level: 1 | 2 | 3
  text: string
  /** 1-based line number in the note's content, so the editor can scroll there. */
  line: number
}

const ATX_HEADING = /^(#{1,3})\s+(.+?)\s*#*\s*$/
const FENCE = /^(`{3,}|~{3,})/

/** Table of contents: h1–h3 ATX headings ("# ", "## ", "### ") in document order.
 *  Headings inside fenced code blocks don't count (a Python "# comment" isn't a section). */
export function extractHeadings(markdown: string): NoteHeading[] {
  const headings: NoteHeading[] = []
  let fenceChar: null | string = null

  markdown.split('\n').forEach((raw, index) => {
    const fence = FENCE.exec(raw.trim())

    if (fence) {
      fenceChar = fenceChar === fence[1][0] ? null : (fenceChar ?? fence[1][0])

      return
    }

    if (fenceChar) {
      return
    }

    const match = ATX_HEADING.exec(raw)

    if (match) {
      headings.push({ level: match[1].length as 1 | 2 | 3, line: index + 1, text: match[2].trim() })
    }
  })

  return headings
}

/** Build the link/backlink index. Pure. Links come from both [[wikilinks]] and
 *  relative ".md" markdown links; backlinks are simply the reverse of that graph.
 *  Targets resolve by the SAME rule the editor styles/opens them with (links.ts's
 *  keysForNote): bare title OR folder-qualified "folder/Title" — an index that only
 *  knew bare titles dropped folder-qualified links and mislabeled them unresolved. */
export function buildIndex(notes: VaultNote[]): VaultIndex {
  const byLower = new Map<string, string>()

  for (const note of notes) {
    for (const key of keysForNote(note)) {
      byLower.set(key, note.title)
    }
  }

  const links = new Map<string, string[]>()
  const backlinks = new Map<string, string[]>(notes.map(note => [note.title, []]))

  for (const note of notes) {
    const rawTargets = [...extractWikilinks(note.content), ...extractRelativeMdLinks(note.content)]
    const seen = new Set<string>()
    const resolved: string[] = []

    for (const raw of rawTargets) {
      const title = byLower.get(raw.toLowerCase())

      if (title && title !== note.title && !seen.has(title)) {
        seen.add(title)
        resolved.push(title)
      }
    }

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

const MAX_DEPTH = 5

/** Folders owned by the Study page (agent-authored decks, mind-map outlines, practice
 *  tests), hidden at ANY depth — the Library is for notes and school files only, and
 *  surfacing the same markdown here again would show e.g. a mind map as a raw note. */
const STUDY_DIRS = new Set(['flashcards', 'mindmaps', 'tests'])

async function walk(
  api: ReturnType<typeof bridge>,
  dirPath: string,
  rel: string,
  depth: number,
  out: VaultContents
): Promise<void> {
  if (depth > MAX_DEPTH) {
    return
  }

  const dir = await api.readDir(dirPath)

  if (dir.error) {
    return
  }

  for (const entry of dir.entries) {
    const folderRel = rel ? `${rel}/${entry.name}` : entry.name

    if (entry.isDirectory) {
      if (entry.name.startsWith('.') || STUDY_DIRS.has(entry.name.toLowerCase())) {
        continue
      }

      out.folders.push(folderRel)
      await walk(api, entry.path, folderRel, depth + 1, out)
    } else if (entry.name.toLowerCase().endsWith('.md')) {
      const read = await api.readFileText(entry.path)
      out.notes.push({ content: read.text ?? '', folder: rel, path: entry.path, title: entry.name.replace(/\.md$/i, '') })
    } else {
      const kind = fileKind(entry.name)

      if (kind) {
        out.files.push({ folder: rel, kind, name: entry.name, path: entry.path })
      }
    }
  }
}

/** Recursively load notes, previewable files, and folders from the vault. */
export async function loadVaultContents(): Promise<VaultContents> {
  const api = bridge()
  const out: VaultContents = { files: [], folders: [], notes: [] }
  await walk(api, VAULT_DIR, '', 0, out)
  out.notes.sort((a, b) => a.title.localeCompare(b.title))

  return out
}

/** Notes-only (recursive) — the Graph page and backlink index consume this. */
export async function loadVault(): Promise<VaultNote[]> {
  return (await loadVaultContents()).notes
}

/** Notes directly inside one vault folder (non-recursive, no PDF/image scan) — cheaper
 *  than loadVaultContents() when a caller only needs one folder, e.g. the Recorder
 *  matching saved recordings back to their auto-saved Lectures notes. */
export async function loadFolderNotes(folder: string): Promise<VaultNote[]> {
  const api = bridge()
  const dirPath = folder ? `${VAULT_DIR}/${folder}` : VAULT_DIR
  const dir = await api.readDir(dirPath)

  if (dir.error) {
    return []
  }

  const reads = dir.entries
    .filter(entry => !entry.isDirectory && entry.name.toLowerCase().endsWith('.md'))
    .map(async entry => {
      const read = await api.readFileText(entry.path)

      return { content: read.text ?? '', folder, path: entry.path, title: entry.name.replace(/\.md$/i, '') }
    })

  return Promise.all(reads)
}

export async function saveNote(title: string, content: string, folder = ''): Promise<string> {
  const api = bridge()
  const safe = title.replace(/[/\\:]/g, '-').trim() || 'Untitled'
  const prefix = folder ? `${VAULT_DIR}/${folder}` : VAULT_DIR
  const result = await api.writeTextFile(`${prefix}/${safe}.md`, content)

  return result.path
}

/** Create a folder in the vault (via the mkdir IPC). Returns silently if unsupported. */
export async function createFolder(folder: string): Promise<void> {
  const safe = folder.replace(/[\\:]/g, '-').replace(/^\/+|\/+$/g, '').trim()

  if (!safe) {
    return
  }

  await window.hermesDesktop?.makeDir?.(`${VAULT_DIR}/${safe}`)
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
