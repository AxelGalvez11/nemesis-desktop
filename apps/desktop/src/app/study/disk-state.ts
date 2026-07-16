// Agent-readable study performance, mirrored to disk.
//
// localStorage stays the app's synchronous source of truth, but every save also
// mirrors the full blob into `~/Documents/Nemesis Library/.study/` as plain JSON:
//
//   state.json          — the whole StudyState (decks/cards, FSRS schedule with
//                         stability·difficulty·due·reps·lapses, review log, settings)
//   test-attempts.json  — per-test attempt history (date, score, total, missed
//                         question indices + what was picked)
//
// Two consumers: the AGENT reads these files to see mastery and build material
// for weak spots (never writes them — the app owns both), and a fresh install
// restores from them when localStorage is empty, so review history survives
// reinstalls. The Library hides dot-folders, so `.study/` never shows as notes.
// Writes are debounced and best-effort: a missing bridge (tests, plain browser)
// or a failed write must never break studying.
import type { TestAttemptsStore } from './extras'
import type { StudyState } from './model'

export const STUDY_DATA_DIR = '~/Documents/Nemesis Library/.study'
export const STUDY_STATE_FILE = `${STUDY_DATA_DIR}/state.json`
export const TEST_ATTEMPTS_FILE = `${STUDY_DATA_DIR}/test-attempts.json`

const MIRROR_DEBOUNCE_MS = 1500
const MIRROR_VERSION = 1

interface MirrorEnvelope<T> {
  data: T
  updatedAt: string
  version: number
}

function bridge() {
  const api = typeof window === 'undefined' ? undefined : window.hermesDesktop

  if (!api?.writeTextFile || !api.makeDir) {
    return null
  }

  return api as typeof api & {
    makeDir: NonNullable<typeof api.makeDir>
    writeTextFile: NonNullable<typeof api.writeTextFile>
  }
}

const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>()
let dirReady = false

async function writeNow(path: string, text: string): Promise<void> {
  const api = bridge()

  if (!api) {
    return
  }

  try {
    if (!dirReady) {
      await api.makeDir(STUDY_DATA_DIR)
      dirReady = true
    }

    await api.writeTextFile(path, text)
  } catch {
    // Mirror is best-effort; localStorage still holds the truth.
  }
}

function scheduleMirror(path: string, serialize: () => string): void {
  if (!bridge()) {
    return
  }

  const existing = pendingWrites.get(path)

  if (existing) {
    clearTimeout(existing)
  }

  pendingWrites.set(
    path,
    setTimeout(() => {
      pendingWrites.delete(path)
      void writeNow(path, serialize())
    }, MIRROR_DEBOUNCE_MS)
  )
}

function envelope<T>(data: T): string {
  const wrapped: MirrorEnvelope<T> = { data, updatedAt: new Date().toISOString(), version: MIRROR_VERSION }

  return JSON.stringify(wrapped, null, 2)
}

export function mirrorStudyState(state: StudyState): void {
  scheduleMirror(STUDY_STATE_FILE, () => envelope(state))
}

export function mirrorTestAttempts(store: TestAttemptsStore): void {
  scheduleMirror(TEST_ATTEMPTS_FILE, () => envelope(store))
}

async function readEnvelope<T>(path: string, looksValid: (data: unknown) => data is T): Promise<T | null> {
  const api = bridge()

  if (!api) {
    return null
  }

  try {
    const read = await api.readFileText(path)

    if (!read.text) {
      return null
    }

    const parsed: unknown = JSON.parse(read.text)
    const data = (parsed as Partial<MirrorEnvelope<unknown>>)?.data

    return looksValid(data) ? data : null
  } catch {
    return null
  }
}

function looksLikeStudyState(data: unknown): data is StudyState {
  const candidate = data as Partial<StudyState> | null

  return Boolean(candidate && Array.isArray(candidate.decks) && typeof candidate.schedule === 'object')
}

function looksLikeAttemptsStore(data: unknown): data is TestAttemptsStore {
  return Boolean(data) && typeof data === 'object' && !Array.isArray(data)
}

/** Disk copy of the study state, or null (no bridge, no file, unparseable). */
export function readDiskStudyState(): Promise<null | StudyState> {
  return readEnvelope(STUDY_STATE_FILE, looksLikeStudyState)
}

/** Disk copy of the test-attempt history, or null. */
export function readDiskTestAttempts(): Promise<null | TestAttemptsStore> {
  return readEnvelope(TEST_ATTEMPTS_FILE, looksLikeAttemptsStore)
}
