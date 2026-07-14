// Regression coverage for the Obsidian-style list auto-continuation wired into the editor's
// keymap (note-editor.tsx): Enter on a bullet/task/numbered line continues the marker, Enter on
// an EMPTY marker line clears it, and Backspace right after a marker removes just the marker.
// These commands themselves ship from @codemirror/lang-markdown — this file is an executable
// spec of the exact behavior our keymap wiring depends on (same EditorState-only style as
// note-format.test.ts), not a reimplementation.
import { deleteMarkupBackward, insertNewlineContinueMarkup, markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorSelection, EditorState } from '@codemirror/state'
import type { StateCommand } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

function state(doc: string, anchor: number, head = anchor): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage })],
    selection: EditorSelection.single(anchor, head)
  })
}

function run(command: StateCommand, from: EditorState) {
  let next = from

  const applied = command({
    dispatch: tr => {
      next = tr.state
    },
    state: from
  })

  return { applied, doc: next.doc.toString(), selection: next.selection.main }
}

describe('list auto-continuation (insertNewlineContinueMarkup)', () => {
  it('continues a bullet marker onto the new line', () => {
    const result = run(insertNewlineContinueMarkup, state('- alpha', 7))

    expect(result.doc).toBe('- alpha\n- ')
    expect(result.selection.from).toBe(10)
  })

  it('continues a numbered marker, incrementing the number', () => {
    const result = run(insertNewlineContinueMarkup, state('1. alpha', 8))

    expect(result.doc).toBe('1. alpha\n2. ')
  })

  it('continues a task marker as an unchecked box, dropping any checked state', () => {
    const result = run(insertNewlineContinueMarkup, state('- [x] done', 10))

    expect(result.doc).toBe('- [x] done\n- [ ] ')
  })

  it('clears the marker instead of continuing when the bullet line is empty', () => {
    // A third, empty item (rather than a tight two-item list) so CodeMirror takes the
    // "clear the marker" branch instead of its tight-list-loosening special case.
    const doc = '- alpha\n- beta\n- '
    const result = run(insertNewlineContinueMarkup, state(doc, doc.length))

    expect(result.doc).toBe('- alpha\n- beta\n')
  })

  it('falls through (does not apply) on a plain paragraph line', () => {
    const result = run(insertNewlineContinueMarkup, state('plain text', 10))

    expect(result.applied).toBe(false)
  })
})

describe('list marker removal (deleteMarkupBackward)', () => {
  it('removes the bullet marker on Backspace right after it', () => {
    const result = run(deleteMarkupBackward, state('- alpha', 2))

    expect(result.doc).toBe('alpha')
    expect(result.selection.from).toBe(0)
  })

  it('falls through (does not apply) mid-word, away from any marker', () => {
    const result = run(deleteMarkupBackward, state('- alpha', 5))

    expect(result.applied).toBe(false)
  })
})
