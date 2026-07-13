import { describe, expect, it } from 'vitest'

import type { StoredSchedule } from './model'
import { deckRetentionCurve } from './retention'

const NOW = new Date('2026-07-11T12:00:00.000Z')

function schedule(stability: number, lastReview = NOW.toISOString()): StoredSchedule {
  return {
    due: '2026-07-12T12:00:00.000Z',
    last_review: lastReview,
    stability
  } as StoredSchedule
}

describe('deckRetentionCurve', () => {
  it('returns no curve for an empty or new-only deck', () => {
    expect(deckRetentionCurve([], NOW)).toEqual([])
    expect(deckRetentionCurve([{ due: NOW.toISOString() } as StoredSchedule], NOW)).toEqual([])
  })

  it('is monotonically non-increasing over time', () => {
    const curve = deckRetentionCurve(
      [schedule(5, '2026-07-09T12:00:00.000Z'), schedule(20, '2026-07-10T12:00:00.000Z')],
      NOW
    )

    for (let index = 1; index < curve.length; index++) {
      expect(curve[index].retention).toBeLessThanOrEqual(curve[index - 1].retention)
    }
  })

  it('decays more slowly for a high-stability deck', () => {
    const lowStability = deckRetentionCurve([schedule(2)], NOW)
    const highStability = deckRetentionCurve([schedule(20)], NOW)

    expect(highStability.at(-1)?.retention).toBeGreaterThan(lowStability.at(-1)?.retention ?? 1)
  })

  it('caps day-zero retention at one', () => {
    const curve = deckRetentionCurve([schedule(10, '2026-07-12T12:00:00.000Z')], NOW)

    expect(curve[0].retention).toBeLessThanOrEqual(1)
  })
})
