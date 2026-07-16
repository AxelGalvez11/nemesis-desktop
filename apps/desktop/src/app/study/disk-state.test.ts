import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  mirrorTestAttempts,
  readDiskStudyState,
  readDiskTestAttempts,
  STUDY_STATE_FILE,
  TEST_ATTEMPTS_FILE
} from './disk-state'
import type { TestAttemptsStore } from './extras'
import type { StudyState } from './model'

const files = new Map<string, string>()

function stubBridge() {
  vi.stubGlobal('window', {
    hermesDesktop: {
      makeDir: async () => ({ path: '' }),
      readDir: async () => ({ entries: [] }),
      readFileText: async (path: string) => ({ text: files.get(path) ?? '' }),
      writeTextFile: async (path: string, text: string) => {
        files.set(path, text)

        return { ok: true }
      }
    }
  })
}

const EMPTY_STATE: StudyState = { decks: [], reviews: [], schedule: {}, sections: [], version: 1 }

beforeEach(() => {
  files.clear()
  vi.useFakeTimers()
  stubBridge()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('disk mirror', () => {
  it('debounces writes and lands the LAST store as a versioned envelope', async () => {
    const first: TestAttemptsStore = { 'a.json': { attempts: [{ date: '2026-07-16', score: 1, total: 4 }] } }
    const second: TestAttemptsStore = {
      'a.json': { attempts: [{ date: '2026-07-16', misses: [{ q: 2, selected: 1 }], score: 3, total: 4 }] }
    }

    mirrorTestAttempts(first)
    mirrorTestAttempts(second)
    expect(files.has(TEST_ATTEMPTS_FILE)).toBe(false)

    await vi.advanceTimersByTimeAsync(2000)

    const written = JSON.parse(files.get(TEST_ATTEMPTS_FILE) ?? 'null') as {
      data: TestAttemptsStore
      version: number
    }
    expect(written.version).toBe(1)
    expect(written.data).toEqual(second)
  })
})

describe('disk restore reads', () => {
  it('returns the mirrored study state from a valid envelope', async () => {
    files.set(STUDY_STATE_FILE, JSON.stringify({ data: EMPTY_STATE, updatedAt: 'x', version: 1 }))

    expect(await readDiskStudyState()).toEqual(EMPTY_STATE)
  })

  it('returns null for a missing, corrupted, or wrong-shaped file', async () => {
    expect(await readDiskStudyState()).toBeNull()

    files.set(STUDY_STATE_FILE, 'not json at all')
    expect(await readDiskStudyState()).toBeNull()

    files.set(TEST_ATTEMPTS_FILE, JSON.stringify({ data: [1, 2, 3], updatedAt: 'x', version: 1 }))
    expect(await readDiskTestAttempts()).toBeNull()
  })
})
