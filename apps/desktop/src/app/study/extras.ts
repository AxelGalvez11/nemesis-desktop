// Study SECTION extras: mind maps and tests. Like deck files (see deck-files.ts), these
// are agent-written plain files in the vault that the Study page treats as read-only
// content — the agent authors them, Study just scans and renders them. Unlike decks,
// there is no reconcile-against-existing-state step: nothing here carries FSRS schedule
// state that could be lost, so every scan simply reflects the folder's current contents.
// A missing folder, missing desktop bridge, or a single unreadable/malformed file all
// degrade to "nothing to show" rather than an error — this is a purely additive feature
// and Study already renders fine with zero mind maps/tests.

import { mirrorTestAttempts } from './disk-state'

export const MINDMAP_DIR = '~/Documents/Nemesis Library/Mindmaps'
export const TEST_DIR = '~/Documents/Nemesis Library/Tests'

export interface MindmapFile {
  fileName: string
  title: string
  /** Trimmed course from the leading `<!-- course: ... -->` comment, or '' when absent. */
  course: string
  /** Outline markdown (headings + nested bullets), with the course comment line stripped. */
  outline: string
}

export interface TestQuestion {
  q: string
  options: string[]
  /** 0-based index into `options`. Always in bounds — see parseTestQuestion. */
  answer: number
  why: string
}

export interface TestFile {
  fileName: string
  title: string
  course: string
  questions: TestQuestion[]
}

const MINDMAP_COURSE_COMMENT = /^\s*<!--\s*course:\s*(.+?)\s*-->\s*\n?/i

/** Parse one mind-map file's raw text. Never throws — a missing/malformed course
 *  comment just means no course (ungrouped), and the whole text becomes the outline. */
export function parseMindmapFile(fileName: string, text: string): MindmapFile {
  const match = text.match(MINDMAP_COURSE_COMMENT)

  return {
    course: match?.[1]?.trim() ?? '',
    fileName,
    outline: match ? text.slice(match[0].length) : text,
    title: fileName.replace(/\.md$/i, '')
  }
}

function parseTestQuestion(raw: unknown): null | TestQuestion {
  if (!raw || typeof raw !== 'object') {
    return null
  }

  const { answer, options, q, why } = raw as Record<string, unknown>

  if (typeof q !== 'string' || !q.trim()) {
    return null
  }

  if (!Array.isArray(options) || options.length < 2 || !options.every(option => typeof option === 'string' && option.trim())) {
    return null
  }

  if (typeof answer !== 'number' || !Number.isInteger(answer) || answer < 0 || answer >= options.length) {
    return null
  }

  return { answer, options, q: q.trim(), why: typeof why === 'string' ? why : '' }
}

/** Parse one test file's raw JSON text. Malformed JSON, a non-object root, or a file
 *  with zero valid questions all return null (skip the file). Individual malformed
 *  questions inside an otherwise-good file are dropped rather than failing the file —
 *  one bad question shouldn't cost the student the other nine. */
export function parseTestFile(fileName: string, text: string): null | TestFile {
  let raw: unknown

  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }

  if (!raw || typeof raw !== 'object') {
    return null
  }

  const { course, questions, title } = raw as Record<string, unknown>

  const parsedQuestions = Array.isArray(questions)
    ? questions.map(parseTestQuestion).filter((question): question is TestQuestion => question !== null)
    : []

  if (!parsedQuestions.length) {
    return null
  }

  return {
    course: typeof course === 'string' ? course.trim() : '',
    fileName,
    questions: parsedQuestions,
    title: typeof title === 'string' && title.trim() ? title.trim() : fileName.replace(/\.json$/i, '')
  }
}

interface ScannableEntry {
  isDirectory: boolean
  name: string
  path: string
}

async function listDir(dir: string): Promise<ScannableEntry[]> {
  const api = window.hermesDesktop

  if (!api?.readDir || !api.readFileText) {
    return []
  }

  try {
    const result = await api.readDir(dir)

    return result.error ? [] : result.entries
  } catch {
    return []
  }
}

/** Every parseable mind-map file in the vault's Mindmaps folder. Re-scan on mount and
 *  window focus (see study/index.tsx) — the agent may add/edit/remove files at any time. */
export async function scanMindmapFiles(): Promise<MindmapFile[]> {
  const api = window.hermesDesktop
  const entries = await listDir(MINDMAP_DIR)

  if (!api?.readFileText) {
    return []
  }

  const out: MindmapFile[] = []

  for (const entry of entries) {
    if (entry.isDirectory || !/\.md$/i.test(entry.name)) {
      continue
    }

    try {
      const read = await api.readFileText(entry.path)
      out.push(parseMindmapFile(entry.name, read.text ?? ''))
    } catch {
      // One unreadable file shouldn't blank the whole scan — skip just that file.
    }
  }

  return out
}

/** Every parseable test file in the vault's Tests folder. Same re-scan cadence as
 *  scanMindmapFiles. */
export async function scanTestFiles(): Promise<TestFile[]> {
  const api = window.hermesDesktop
  const entries = await listDir(TEST_DIR)

  if (!api?.readFileText) {
    return []
  }

  const out: TestFile[] = []

  for (const entry of entries) {
    if (entry.isDirectory || !/\.json$/i.test(entry.name)) {
      continue
    }

    try {
      const read = await api.readFileText(entry.path)
      const parsed = parseTestFile(entry.name, read.text ?? '')

      if (parsed) {
        out.push(parsed)
      }
    } catch {
      // Unreadable file — same silent skip as a malformed one.
    }
  }

  return out
}

// --- Section grouping (mirrors model.ts's groupDecks) -------------------------------
// A small, deliberate duplication rather than exporting this out of model.ts: model.ts
// carries the 29 reconcile/queue/settings tests this whole branch is pinned against, and
// this rule is ~6 lines that rarely changes. Keep both in sync by hand if either moves.

function canonicalSection(course: string, sections: string[]): string {
  const trimmed = course.trim()
  const normalized = trimmed.toLocaleLowerCase()

  if (!trimmed || normalized === 'other') {
    return 'Other'
  }

  const known = sections.find(section => section.trim().toLocaleLowerCase() === normalized)

  return known?.trim() ?? trimmed
}

export interface StudyExtrasSection {
  course: string
  mindmaps: MindmapFile[]
  tests: TestFile[]
}

/** Bucket mind maps/tests by their canonical section name, so the Study page can render
 *  their rows under the same headings as decks — including a section that has extras but
 *  no decks at all (a course-less deck list shouldn't hide a mind map for that course). */
export function groupExtras(sections: string[], mindmaps: MindmapFile[], tests: TestFile[]): Map<string, StudyExtrasSection> {
  const byCourse = new Map<string, StudyExtrasSection>()

  const bucket = (course: string): StudyExtrasSection => {
    const key = canonicalSection(course, sections)
    const existing = byCourse.get(key)

    if (existing) {
      return existing
    }

    const created: StudyExtrasSection = { course: key, mindmaps: [], tests: [] }
    byCourse.set(key, created)

    return created
  }

  for (const mindmap of mindmaps) {
    bucket(mindmap.course).mindmaps.push(mindmap)
  }

  for (const test of tests) {
    bucket(test.course).tests.push(test)
  }

  return byCourse
}

// --- Test attempts (localStorage persistence) ----------------------------------------

/** One missed question inside an attempt: which question and what was picked
 *  (both indices into the test file's arrays) — the agent turns repeat misses
 *  into targeted flashcards. */
export interface TestAttemptMiss {
  q: number
  selected: number
}

export interface TestAttempt {
  date: string
  misses?: TestAttemptMiss[]
  score: number
  total: number
}

export interface TestAttemptRecord {
  attempts: TestAttempt[]
}

export type TestAttemptsStore = Record<string, TestAttemptRecord>

const TEST_ATTEMPTS_KEY = 'nemesis.study.tests.v1'

function isTestAttempt(value: unknown): value is TestAttempt {
  if (!value || typeof value !== 'object') {
    return false
  }

  const { date, score, total } = value as Record<string, unknown>

  return typeof date === 'string' && typeof score === 'number' && typeof total === 'number'
}

/** Load persisted test attempts, tolerating a missing/corrupted/legacy-shaped blob. */
export function loadTestAttempts(): TestAttemptsStore {
  try {
    const raw = window.localStorage.getItem(TEST_ATTEMPTS_KEY)

    if (!raw) {
      return {}
    }

    const parsed = JSON.parse(raw) as unknown

    if (!parsed || typeof parsed !== 'object') {
      return {}
    }

    const store: TestAttemptsStore = {}

    for (const [fileName, record] of Object.entries(parsed as Record<string, unknown>)) {
      const attempts = record && typeof record === 'object' ? (record as { attempts?: unknown }).attempts : undefined

      if (!Array.isArray(attempts)) {
        continue
      }

      const valid = attempts.filter(isTestAttempt)

      if (valid.length) {
        store[fileName] = { attempts: valid }
      }
    }

    return store
  } catch {
    return {}
  }
}

export function saveTestAttempts(store: TestAttemptsStore): void {
  try {
    window.localStorage.setItem(TEST_ATTEMPTS_KEY, JSON.stringify(store))
  } catch {
    // Best-effort persistence — same as saveState in model.ts.
  }

  // Agent-readable copy (and reinstall restore) — see disk-state.ts.
  mirrorTestAttempts(store)
}

/** Append one attempt for a test file. Pure — returns a new store. */
export function recordAttempt(store: TestAttemptsStore, fileName: string, attempt: TestAttempt): TestAttemptsStore {
  const existing = store[fileName]?.attempts ?? []

  return { ...store, [fileName]: { attempts: [...existing, attempt] } }
}

function scoreRatio(attempt: TestAttempt): number {
  return attempt.total > 0 ? attempt.score / attempt.total : 0
}

/** Highest-scoring attempt (by score/total ratio), or null for an empty list. */
export function bestAttempt(attempts: TestAttempt[]): null | TestAttempt {
  return attempts.length ? attempts.reduce((best, attempt) => (scoreRatio(attempt) > scoreRatio(best) ? attempt : best)) : null
}

/** Most recent attempt (by ISO date string), or null for an empty list. */
export function lastAttempt(attempts: TestAttempt[]): null | TestAttempt {
  return attempts.length ? attempts.reduce((last, attempt) => (attempt.date > last.date ? attempt : last)) : null
}
