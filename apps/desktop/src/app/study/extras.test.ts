// Mind maps and tests are agent-written files Study only reads — these tests pin the
// two parsers' tolerance rules (what's optional, what gets silently skipped) and the
// attempt-persistence helpers the Test mode score display depends on.
import { beforeEach, describe, expect, it } from 'vitest'

import {
  bestAttempt,
  groupExtras,
  lastAttempt,
  loadTestAttempts,
  parseMindmapFile,
  parseTestFile,
  recordAttempt,
  saveTestAttempts,
  scanMindmapFiles,
  scanTestFiles,
  type TestAttempt,
  type TestAttemptsStore
} from './extras'

describe('parseMindmapFile', () => {
  it('reads the course from a leading HTML comment', () => {
    const file = parseMindmapFile(
      'Cardiac Physiology.md',
      '<!-- course: Pharmacology -->\n# Cardiac cycle\n- Systole\n- Diastole'
    )

    expect(file.course).toBe('Pharmacology')
    expect(file.title).toBe('Cardiac Physiology')
    expect(file.outline).toBe('# Cardiac cycle\n- Systole\n- Diastole')
  })

  it('defaults to an empty (ungrouped) course when the comment is absent', () => {
    const file = parseMindmapFile('Loose notes.md', '# Cardiac cycle\n- Systole\n- Diastole')

    expect(file.course).toBe('')
    expect(file.outline).toBe('# Cardiac cycle\n- Systole\n- Diastole')
  })

  it('trims whitespace around the course name and tolerates leading blank lines', () => {
    const file = parseMindmapFile('X.md', '\n  <!--   course:   Infectious disease   -->  \n# Root')

    expect(file.course).toBe('Infectious disease')
    expect(file.outline).toBe('# Root')
  })
})

describe('parseTestFile', () => {
  const goodQuestion = { answer: 1, options: ['ACE inhibitor', 'Beta blocker'], q: 'Class of lisinopril?', why: 'RAAS blockade.' }

  it('parses a well-formed test file', () => {
    const file = parseTestFile('Renal.json', JSON.stringify({ course: 'Pharmacology', questions: [goodQuestion], title: 'Renal pharm' }))

    expect(file).not.toBeNull()
    expect(file?.course).toBe('Pharmacology')
    expect(file?.title).toBe('Renal pharm')
    expect(file?.questions).toHaveLength(1)
    expect(file?.questions[0]).toEqual({ answer: 1, options: goodQuestion.options, q: goodQuestion.q, why: goodQuestion.why })
  })

  it('skips malformed JSON entirely', () => {
    expect(parseTestFile('bad.json', '{ this is not json')).toBeNull()
  })

  it('tolerates a missing why and a missing course', () => {
    const file = parseTestFile('X.json', JSON.stringify({ questions: [{ answer: 0, options: ['A', 'B'], q: 'Q?' }] }))

    expect(file).not.toBeNull()
    expect(file?.course).toBe('')
    expect(file?.questions[0].why).toBe('')
    // No title in the JSON → falls back to the file name.
    expect(file?.title).toBe('X')
  })

  it('rejects an out-of-bounds answer index (too high) and drops just that question', () => {
    const bad = { answer: 2, options: ['A', 'B'], q: 'Bad index' }
    const file = parseTestFile('X.json', JSON.stringify({ questions: [bad, goodQuestion] }))

    expect(file?.questions).toHaveLength(1)
    expect(file?.questions[0].q).toBe(goodQuestion.q)
  })

  it('rejects a negative answer index', () => {
    const bad = { answer: -1, options: ['A', 'B'], q: 'Negative index' }
    const file = parseTestFile('X.json', JSON.stringify({ questions: [bad, goodQuestion] }))

    expect(file?.questions).toHaveLength(1)
  })

  it('drops questions missing required fields (q, options) without failing the file', () => {
    const missingQ = { answer: 0, options: ['A', 'B'] }
    const oneOption = { answer: 0, options: ['A'], q: 'Only one option' }
    const file = parseTestFile('X.json', JSON.stringify({ questions: [missingQ, oneOption, goodQuestion] }))

    expect(file?.questions).toHaveLength(1)
    expect(file?.questions[0].q).toBe(goodQuestion.q)
  })

  it('returns null when every question is malformed (nothing usable survives)', () => {
    const bad = { answer: 5, options: ['A', 'B'], q: 'Bad' }

    expect(parseTestFile('X.json', JSON.stringify({ questions: [bad] }))).toBeNull()
  })

  it('returns null for a non-object JSON root (e.g. a bare array or string)', () => {
    expect(parseTestFile('X.json', JSON.stringify(['not', 'an', 'object']))).toBeNull()
    expect(parseTestFile('X.json', JSON.stringify('just a string'))).toBeNull()
  })
})

describe('scanMindmapFiles / scanTestFiles', () => {
  const originalDesktop = window.hermesDesktop

  beforeEach(() => {
    window.hermesDesktop = originalDesktop
  })

  it('returns [] when there is no desktop bridge at all', async () => {
    // @ts-expect-error — simulating the web/no-bridge environment.
    delete window.hermesDesktop

    expect(await scanMindmapFiles()).toEqual([])
    expect(await scanTestFiles()).toEqual([])
  })

  it('returns [] when the folder is missing (readDir reports an error)', async () => {
    // @ts-expect-error — partial bridge is enough for this scanner.
    window.hermesDesktop = {
      readDir: async () => ({ entries: [], error: 'ENOENT' }),
      readFileText: async () => ({ path: '', text: '' })
    }

    expect(await scanMindmapFiles()).toEqual([])
  })

  it('scans, reads, and parses every matching file in the folder', async () => {
    const files: Record<string, string> = {
      '/vault/Mindmaps/Cardio.md': '<!-- course: Pharmacology -->\n# Root',
      '/vault/Mindmaps/notes.txt': 'ignored — not .md'
    }

    // @ts-expect-error — partial bridge is enough for this scanner.
    window.hermesDesktop = {
      readDir: async () => ({
        entries: [
          { isDirectory: false, name: 'Cardio.md', path: '/vault/Mindmaps/Cardio.md' },
          { isDirectory: false, name: 'notes.txt', path: '/vault/Mindmaps/notes.txt' },
          { isDirectory: true, name: 'Sub', path: '/vault/Mindmaps/Sub' }
        ]
      }),
      readFileText: async (path: string) => ({ path, text: files[path] ?? '' })
    }

    const result = await scanMindmapFiles()

    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('Cardio')
    expect(result[0].course).toBe('Pharmacology')
  })
})

describe('groupExtras', () => {
  it('matches an extra to a known section case-insensitively', () => {
    const groups = groupExtras(
      ['Pharmacology'],
      [{ course: 'pharmacology', fileName: 'a.md', outline: '', title: 'a' }],
      []
    )

    expect(groups.get('Pharmacology')?.mindmaps).toHaveLength(1)
  })

  it('creates a section for a course with extras but no matching deck section', () => {
    const groups = groupExtras([], [], [{ course: 'Biochem', fileName: 'a.json', questions: [], title: 'a' }])

    expect(groups.has('Biochem')).toBe(true)
  })

  it('buckets an empty/absent course under "Other"', () => {
    const groups = groupExtras([], [{ course: '', fileName: 'a.md', outline: '', title: 'a' }], [])

    expect(groups.get('Other')?.mindmaps).toHaveLength(1)
  })
})

describe('test attempt persistence', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('loadTestAttempts returns {} when nothing is stored', () => {
    expect(loadTestAttempts()).toEqual({})
  })

  it('loadTestAttempts tolerates a corrupted blob', () => {
    window.localStorage.setItem('nemesis.study.tests.v1', '{ not json')

    expect(loadTestAttempts()).toEqual({})
  })

  it('loadTestAttempts drops malformed attempt entries but keeps valid ones', () => {
    window.localStorage.setItem(
      'nemesis.study.tests.v1',
      JSON.stringify({
        'bad.json': { attempts: [{ date: '2026-07-01', score: 'oops', total: 10 }] },
        'good.json': { attempts: [{ date: '2026-07-01', score: 8, total: 10 }] }
      })
    )

    const store = loadTestAttempts()

    expect(store['good.json'].attempts).toHaveLength(1)
    expect(store['bad.json']).toBeUndefined()
  })

  it('saveTestAttempts + loadTestAttempts round-trips', () => {
    const store: TestAttemptsStore = { 'x.json': { attempts: [{ date: '2026-07-01T00:00:00.000Z', score: 4, total: 5 }] } }
    saveTestAttempts(store)

    expect(loadTestAttempts()).toEqual(store)
  })

  it('recordAttempt appends immutably without mutating the input store', () => {
    const before: TestAttemptsStore = { 'x.json': { attempts: [{ date: 'd1', score: 1, total: 2 }] } }
    const attempt: TestAttempt = { date: 'd2', score: 2, total: 2 }
    const after = recordAttempt(before, 'x.json', attempt)

    expect(after).not.toBe(before)
    expect(before['x.json'].attempts).toHaveLength(1)
    expect(after['x.json'].attempts).toHaveLength(2)
    expect(after['x.json'].attempts[1]).toEqual(attempt)
  })

  it('recordAttempt creates a new entry for a file with no prior attempts', () => {
    const after = recordAttempt({}, 'new.json', { date: 'd1', score: 3, total: 3 })

    expect(after['new.json'].attempts).toHaveLength(1)
  })
})

describe('bestAttempt / lastAttempt', () => {
  it('returns null for an empty list', () => {
    expect(bestAttempt([])).toBeNull()
    expect(lastAttempt([])).toBeNull()
  })

  it('bestAttempt picks the highest score/total ratio, not the highest raw score', () => {
    const attempts: TestAttempt[] = [
      { date: 'd1', score: 9, total: 20 },
      { date: 'd2', score: 4, total: 5 }
    ]

    expect(bestAttempt(attempts)).toEqual({ date: 'd2', score: 4, total: 5 })
  })

  it('lastAttempt picks the most recent date regardless of score', () => {
    const attempts: TestAttempt[] = [
      { date: '2026-07-01T00:00:00.000Z', score: 10, total: 10 },
      { date: '2026-07-05T00:00:00.000Z', score: 1, total: 10 }
    ]

    expect(lastAttempt(attempts)).toEqual({ date: '2026-07-05T00:00:00.000Z', score: 1, total: 10 })
  })
})
