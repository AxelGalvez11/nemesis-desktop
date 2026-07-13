import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { bulletToggleChanges, headingCycleChanges, inlineToggleSpec } from './note-format'

// Same grammar the real editor runs (note-editor.tsx), so syntax-tree lookups match.
function state(doc: string, anchor: number, head = anchor): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage })],
    selection: EditorSelection.single(anchor, head)
  })
}

function applyInline(from: EditorState, mark: '*' | '**') {
  const next = from.update(inlineToggleSpec(from, mark))

  return { doc: next.state.doc.toString(), selection: next.state.selection.main, state: next.state }
}

describe('inline bold/italic toggle', () => {
  it('wraps a selection in bold markers and keeps the text selected', () => {
    const result = applyInline(state('hello world', 0, 5), '**')

    expect(result.doc).toBe('**hello** world')
    expect([result.selection.from, result.selection.to]).toEqual([2, 7])
  })

  it('unwraps bold when the caret sits inside an existing **…** run', () => {
    const result = applyInline(state('**bold** text', 4), '**')

    expect(result.doc).toBe('bold text')
    expect(result.selection.from).toBe(2)
  })

  it('also unwraps the __underscore__ spelling of bold', () => {
    expect(applyInline(state('__bold__ text', 4), '**').doc).toBe('bold text')
  })

  it('bolds the word under the caret when nothing is selected', () => {
    expect(applyInline(state('hello world', 2), '**').doc).toBe('**hello** world')
  })

  it('inserts an empty marker pair with the caret inside when there is no word', () => {
    const result = applyInline(state('', 0), '**')

    expect(result.doc).toBe('****')
    expect(result.selection.from).toBe(2)
  })

  it('italicizes with single markers', () => {
    expect(applyInline(state('note taking', 0, 4), '*').doc).toBe('*note* taking')
  })

  it('stacks italic inside bold instead of stripping a star', () => {
    expect(applyInline(state('**bold**', 4), '*').doc).toBe('***bold***')
  })

  it('round-trips: toggling bold twice restores the original text', () => {
    const once = applyInline(state('dose response', 0, 4), '**')
    const twice = applyInline(once.state, '**')

    expect(once.doc).toBe('**dose** response')
    expect(twice.doc).toBe('dose response')
  })

  it('shrinks past selection whitespace so markers hug the text', () => {
    expect(applyInline(state('a word here', 1, 7), '**').doc).toBe('a **word** here')
  })
})

describe('heading cycle', () => {
  function cycle(doc: string, pos = 0): string {
    const from = state(doc, pos)

    return from.update({ changes: headingCycleChanges(from) }).state.doc.toString()
  }

  it('cycles plain → # → ## → ### → plain', () => {
    expect(cycle('title')).toBe('# title')
    expect(cycle('# title')).toBe('## title')
    expect(cycle('## title')).toBe('### title')
    expect(cycle('### title')).toBe('title')
  })
})

describe('bullet list toggle', () => {
  function toggle(doc: string, anchor: number, head: number): string {
    const from = state(doc, anchor, head)

    return from.update({ changes: bulletToggleChanges(from) }).state.doc.toString()
  }

  it('bullets every selected line, skipping blanks', () => {
    expect(toggle('alpha\n\nbeta', 0, 10)).toBe('- alpha\n\n- beta')
  })

  it('un-bullets when every selected line is already a bullet', () => {
    expect(toggle('- alpha\n- beta', 0, 14)).toBe('alpha\nbeta')
  })

  it('completes a mixed selection instead of stripping it', () => {
    expect(toggle('- alpha\nbeta', 0, 12)).toBe('- alpha\n- beta')
  })
})
