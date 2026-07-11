// The Academic Object Graph — Nemesis's single source of truth for the student's
// academic (and surrounding) world. One file-backed model the agent writes and
// every "view" (Today command center, the Graph page, a future planner) reads.
//
// Why a file, not app-local state: the agent already writes the student's files
// (notes, decks, calendar.json); the graph is the same contract — it authors
// JSON, the app renders it. It lives beside the vault so it's exportable and
// survives reinstalls, but under a dot-dir so it never shows in the note UI.
//
// Design choices that matter later:
//  - Objects are broad enough for STUDENT LIFE from day one (Project,
//    Application, Contact, Meeting, Credential live alongside Course/Concept/
//    Assignment/Exam), so widening from "academics" to "student life" is adding
//    rows, not migrating a schema.
//  - Every object carries provenance (`confidence` + `source`) so the graph
//    never becomes a confident-looking blend of instructor fact and AI guess.
//  - A `changes` feed powers "what changed since yesterday" without diffing.

export const ACADEMIC_GRAPH_DIR = '~/Documents/Nemesis Library/.nemesis'
export const ACADEMIC_GRAPH_PATH = `${ACADEMIC_GRAPH_DIR}/graph.json`

export type AcademicObjectType =
  | 'announcement'
  | 'application'
  | 'assignment'
  | 'concept'
  | 'contact'
  | 'course'
  | 'credential'
  | 'exam'
  | 'grade'
  | 'lecture'
  | 'meeting'
  | 'professor'
  | 'project'
  | 'semester'
  | 'syllabus'

// Provenance tier — how much to trust a fact. Rendered as a small tag so the
// student can always see instructor-truth vs AI-inference.
export type ConfidenceTier =
  | 'ai-inference' // Nemesis derived it
  | 'course-material' // extracted from a slide/syllabus/reading
  | 'instructor-stated' // the professor said it (announcement/email/lecture)
  | 'student-added' // the student entered it
  | 'unverified' // seen once, not corroborated

export type ObjectStatus = 'at-risk' | 'done' | 'graded' | 'open' | 'submitted' | 'upcoming'

export interface AcademicSource {
  kind: 'email' | 'file' | 'lecture' | 'lms' | 'manual' | 'note' | 'web'
  ref?: string // url, file path, lecture id, message id
  ts?: string // when this was observed (ISO)
}

export interface AcademicRelationship {
  rel: string // e.g. 'requires', 'covers', 'belongs-to', 'depends-on', 'taught-by'
  to: string // target object id
}

export interface AcademicChange {
  ts: string
  objectId: string
  kind: 'created' | 'date-changed' | 'removed' | 'status-changed' | 'updated'
  summary: string
  confidence: ConfidenceTier
}

export interface AcademicObject {
  id: string
  type: AcademicObjectType
  title: string
  course?: string // owning course id (for grouping)
  status?: ObjectStatus
  date?: string // due/exam/posted/meeting date (ISO yyyy-mm-dd[THH:mm])
  confidence: ConfidenceTier
  source?: AcademicSource
  createdAt?: string
  updatedAt?: string
  relationships?: AcademicRelationship[]
  // Type-specific extras: grade weight, mastery %, professor email, rubric, etc.
  fields?: Record<string, unknown>
  history?: { ts: string; change: string }[]
}

export interface AcademicGraph {
  version: number
  student?: { name?: string }
  semester?: { id: string; title: string; start?: string; end?: string }
  objects: AcademicObject[]
  changes: AcademicChange[]
}

export function emptyGraph(): AcademicGraph {
  return { changes: [], objects: [], version: 1 }
}

/** Read the graph. Missing file or malformed JSON → an empty graph (never
 *  throws): a fresh install has no graph yet, and a half-written file must not
 *  crash the home screen. */
export async function loadAcademicGraph(): Promise<AcademicGraph> {
  const api = window.hermesDesktop

  if (!api?.readFileText) {
    return emptyGraph()
  }

  try {
    const result = await api.readFileText(ACADEMIC_GRAPH_PATH)

    if (!result.text) {
      return emptyGraph()
    }

    const parsed = JSON.parse(result.text) as Partial<AcademicGraph>

    return {
      changes: Array.isArray(parsed.changes) ? parsed.changes : [],
      objects: Array.isArray(parsed.objects) ? parsed.objects : [],
      semester: parsed.semester,
      student: parsed.student,
      version: typeof parsed.version === 'number' ? parsed.version : 1
    }
  } catch {
    return emptyGraph()
  }
}

// ---------------------------------------------------------------------------
// Pure query helpers — the views compose these; no I/O, easy to unit test.
// ---------------------------------------------------------------------------

const DUE_TYPES: ReadonlySet<AcademicObjectType> = new Set(['assignment', 'exam', 'application'])

function parseDate(value?: string): null | number {
  if (!value) {
    return null
  }

  const ms = Date.parse(value)

  return Number.isNaN(ms) ? null : ms
}

export function objectsByType(graph: AcademicGraph, type: AcademicObjectType): AcademicObject[] {
  return graph.objects.filter(object => object.type === type)
}

export function courseTitle(graph: AcademicGraph, courseId?: string): string {
  if (!courseId) {
    return ''
  }

  return graph.objects.find(object => object.id === courseId && object.type === 'course')?.title ?? courseId
}

/** Open deadlines (assignments, exams, applications) within `withinDays`,
 *  soonest first. Done/submitted/graded items drop out. */
export function dueSoon(graph: AcademicGraph, withinDays: number, now = Date.now()): AcademicObject[] {
  const horizon = now + withinDays * 86_400_000

  return graph.objects
    .filter(object => DUE_TYPES.has(object.type))
    .filter(object => object.status !== 'done' && object.status !== 'submitted' && object.status !== 'graded')
    .filter(object => {
      const ms = parseDate(object.date)

      return ms != null && ms >= now - 86_400_000 && ms <= horizon
    })
    .sort((a, b) => (parseDate(a.date) ?? 0) - (parseDate(b.date) ?? 0))
}

/** Changes newer than `sinceDays`, newest first. Powers "what changed". */
export function recentChanges(graph: AcademicGraph, sinceDays: number, now = Date.now()): AcademicChange[] {
  const cutoff = now - sinceDays * 86_400_000

  return [...graph.changes]
    .filter(change => {
      const ms = parseDate(change.ts)

      return ms == null || ms >= cutoff
    })
    .sort((a, b) => (parseDate(b.ts) ?? 0) - (parseDate(a.ts) ?? 0))
}

/** Events (lectures, meetings) dated on `dayIso` (yyyy-mm-dd), earliest first. */
export function eventsOnDay(graph: AcademicGraph, dayIso: string): AcademicObject[] {
  return graph.objects
    .filter(object => object.type === 'lecture' || object.type === 'meeting')
    .filter(object => (object.date ?? '').slice(0, 10) === dayIso)
    .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))
}

export interface ScoredTask {
  object: AcademicObject
  score: number
  reason: string
}

/** A deliberately-simple next-action scorer (the full adaptive planner is a
 *  later engine). Ranks open deadlines by urgency × grade-weight × knowledge
 *  gap so Today can say "do THIS next, and why". Reads mastery from an object's
 *  `fields.mastery` (0–100) when present. */
export function scoreNextAction(graph: AcademicGraph, now = Date.now()): null | ScoredTask {
  const candidates = dueSoon(graph, 14, now)

  if (candidates.length === 0) {
    return null
  }

  let best: null | ScoredTask = null

  for (const object of candidates) {
    const ms = parseDate(object.date) ?? now
    const daysLeft = Math.max(0.25, (ms - now) / 86_400_000)
    const urgency = 1 / daysLeft
    const weight = typeof object.fields?.weight === 'number' ? (object.fields.weight as number) : 10
    const masteryRaw = typeof object.fields?.mastery === 'number' ? (object.fields.mastery as number) : 60
    const gap = Math.max(0.1, (100 - masteryRaw) / 100)
    const score = urgency * (weight / 10) * gap

    if (!best || score > best.score) {
      const whenDays = Math.round(daysLeft)
      const bits = [
        object.type === 'exam' ? `exam in ${whenDays} day${whenDays === 1 ? '' : 's'}` : `due in ${whenDays} day${whenDays === 1 ? '' : 's'}`
      ]

      if (typeof object.fields?.mastery === 'number') {
        bits.push(`mastery ${Math.round(masteryRaw)}%`)
      }

      best = { object, reason: bits.join(' · '), score }
    }
  }

  return best
}

/** Objects with a mastery field, weakest first — feeds the Study readiness read. */
export function weakConcepts(graph: AcademicGraph, limit = 5): AcademicObject[] {
  return graph.objects
    .filter(object => object.type === 'concept' && typeof object.fields?.mastery === 'number')
    .sort((a, b) => (a.fields!.mastery as number) - (b.fields!.mastery as number))
    .slice(0, limit)
}
