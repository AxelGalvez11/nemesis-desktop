import { describe, expect, it } from 'vitest'

import { type NavHistory, recordNavVisit } from './index'

const note = (path: string) => ({ kind: 'note' as const, note: { content: '', folder: '', path, title: path } })

describe('recordNavVisit', () => {
  it('appends a new visit and advances the cursor', () => {
    let h: NavHistory = { pos: -1, stack: [] }
    h = recordNavVisit(h, note('a'))
    h = recordNavVisit(h, note('b'))

    expect(h.stack.map(t => (t.kind === 'note' ? t.note.path : ''))).toEqual(['a', 'b'])
    expect(h.pos).toBe(1)
  })

  it('ignores a repeat of the current entry (no duplicate visits)', () => {
    let h: NavHistory = { pos: -1, stack: [] }
    h = recordNavVisit(h, note('a'))
    const same = recordNavVisit(h, note('a'))

    expect(same).toBe(h)
  })

  it('truncates the forward stack when visiting after going back', () => {
    let h: NavHistory = { pos: -1, stack: [] }
    h = recordNavVisit(h, note('a'))
    h = recordNavVisit(h, note('b'))
    h = recordNavVisit(h, note('c'))
    // simulate two Back presses landing the cursor on 'a'
    h = { ...h, pos: 0 }
    h = recordNavVisit(h, note('d'))

    expect(h.stack.map(t => (t.kind === 'note' ? t.note.path : ''))).toEqual(['a', 'd'])
    expect(h.pos).toBe(1)
  })
})
