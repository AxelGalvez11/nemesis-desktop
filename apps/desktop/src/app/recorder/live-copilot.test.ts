import { describe, expect, it } from 'vitest'

import { buildCopilotMessages, copilotAccess, parseCopilotReply, shouldRefresh } from './live-copilot'

describe('copilotAccess', () => {
  it('gives Max the fast cadence', () => {
    expect(copilotAccess({ plan: 'max' })).toEqual({ minIntervalMs: 7000, minNewChars: 140 })
  })

  it('gives Agent Pro a slower cadence', () => {
    expect(copilotAccess({ plan: 'pro' })).toEqual({ minIntervalMs: 15000, minNewChars: 300 })
  })

  it('excludes Student, free, and unknown plans', () => {
    expect(copilotAccess({ plan: 'plus' })).toBeNull()
    expect(copilotAccess({ plan: 'free' })).toBeNull()
    expect(copilotAccess({ plan: 'anything-else' })).toBeNull()
  })

  it('treats local-dev bypass as Max for testing', () => {
    expect(copilotAccess({ bypass: true, plan: 'free' })).not.toBeNull()
  })
})

describe('shouldRefresh', () => {
  const cadence = { minIntervalMs: 7000, minNewChars: 140 }

  it('fires when enough new speech has landed after the interval', () => {
    expect(shouldRefresh(20_000, 10_000, 200, cadence)).toBe(true)
  })

  it('never fires on silence or tiny additions', () => {
    expect(shouldRefresh(60_000, 0, 0, cadence)).toBe(false)
    expect(shouldRefresh(60_000, 0, 139, cadence)).toBe(false)
  })

  it('respects the interval even with lots of new speech', () => {
    expect(shouldRefresh(12_000, 10_000, 5000, cadence)).toBe(false)
  })

  it('enforces the hard 5s floor even for aggressive cadences', () => {
    expect(shouldRefresh(3000, 0, 5000, { minIntervalMs: 1000, minNewChars: 10 })).toBe(false)
    expect(shouldRefresh(5000, 0, 5000, { minIntervalMs: 1000, minNewChars: 10 })).toBe(true)
  })
})

describe('parseCopilotReply', () => {
  it('parses clean JSON', () => {
    expect(parseCopilotReply('{"notes":["Beta blockers lower heart rate"],"ask":["Which are cardioselective?"]}')).toEqual({
      ask: ['Which are cardioselective?'],
      notes: ['Beta blockers lower heart rate']
    })
  })

  it('extracts JSON wrapped in fences or prose', () => {
    const raw = 'Sure! ```json\n{"notes":["A"],"ask":[]}\n``` hope that helps'
    expect(parseCopilotReply(raw)).toEqual({ ask: [], notes: ['A'] })
  })

  it('caps notes at 3 and ask at 2, drops blanks and non-strings', () => {
    const raw = JSON.stringify({ ask: ['q1', 'q2', 'q3'], notes: ['a', '', 'b', 42, 'c', 'd'] })
    expect(parseCopilotReply(raw)).toEqual({ ask: ['q1', 'q2'], notes: ['a', 'b', 'c'] })
  })

  it('returns empty on garbage instead of throwing', () => {
    expect(parseCopilotReply('no json here')).toEqual({ ask: [], notes: [] })
    expect(parseCopilotReply('{broken')).toEqual({ ask: [], notes: [] })
    expect(parseCopilotReply('')).toEqual({ ask: [], notes: [] })
  })
})

describe('buildCopilotMessages', () => {
  it('demands strict JSON, includes prior notes tail and the transcript window', () => {
    const messages = buildCopilotMessages('today we cover warfarin dosing', ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7'])
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toContain('STRICT JSON')
    expect(messages[0].content).toContain('misrecognizes')
    expect(messages[1].content).toContain('warfarin dosing')
    expect(messages[1].content).toContain('- n7')
    expect(messages[1].content).not.toContain('- n1')
  })
})
