// NoteEditor — Obsidian-style "live preview" over CodeMirror 6 (the SAME editor engine
// Obsidian itself is built on; @codemirror/* + @lezer/markdown, all MIT). The markdown
// stays plain text on disk, but formatting marks melt away as you read: `# ` disappears
// and the heading renders big, `**bold**` loses its asterisks, `- ` becomes a bullet dot,
// and [[wikilinks]] render as clickable accent-colored links. Put the cursor on a line
// and its raw marks reappear for editing — exactly Obsidian's behavior. The decoration
// logic itself (headings/emphasis/tables/checkboxes/wikilinks → CodeMirror decorations)
// lives in note-decorations.ts; this file mounts the EditorView and owns its lifecycle.
import { autocompletion } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { deleteMarkupBackward, insertNewlineContinueMarkup } from '@codemirror/lang-markdown'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap, placeholder } from '@codemirror/view'
import { type Ref, useEffect, useImperativeHandle, useRef } from 'react'

import { livePreview, noteMarkdown, noteTheme, tableExtension, type ImageContext } from './note-decorations'
import { toggleBold, toggleItalic } from './note-format'
import { VAULT_DIR } from './vault'
import { wikilinkCompletionSource, type WikilinkTarget } from './wikilink-autocomplete'

const EMPTY_IMAGE_CONTEXT: ImageContext = { files: [], noteFolder: '', vaultDir: VAULT_DIR }

// Read-only vs editable is one compartment we reconfigure live (see the `editable`
// prop) so the "Edit" toggle in the header flips the note between a calm reading view
// and an editable one without remounting the editor or losing scroll position.
// `readOnly` blocks doc changes; `editable: false` also removes the caret and keeps
// the text selectable (copy still works) — together that's a true read-only note.
function editableExtensions(editable: boolean) {
  return [EditorState.readOnly.of(!editable), EditorView.editable.of(editable)]
}

export interface NoteEditorHandle {
  /** Scroll the editor to a 1-based line number and place the cursor there
   *  (the Outline tab in the right rail drives this). */
  scrollToLine: (line: number) => void
}

export interface NoteEditorProps {
  initialValue: string
  onChange: (value: string) => void
  onOpenWikilink: (target: string) => void
  /** Vault note titles (+folders) for [[ autocomplete. Read through a ref internally, so
   *  passing a fresh array each render doesn't reset the editor. Omitted by callers with
   *  no vault list on hand (e.g. the Recorder's freeform notepad) — autocomplete then
   *  simply offers nothing, everything else about the editor is unaffected. */
  notes?: WikilinkTarget[]
  /** True when a wikilink target resolves to a real note — same rule onOpenWikilink uses
   *  to decide create-vs-open, so a link never renders resolved but fails to open (or vice
   *  versa). Defaults to "nothing resolves" for callers with no vault index on hand. */
  isResolved?: (target: string) => boolean
  /** The editing note's own folder + the vault's file list, for resolving inline image
   *  sources (`![alt](relative/path)` and Obsidian's `![[name]]` embed). Defaults to an
   *  empty vault-root context for callers with no note/vault index on hand — images then
   *  simply don't resolve rather than throwing. */
  imageContext?: ImageContext
  /** Notes open read-only (a calm reading view); the header's "Edit" toggle flips this
   *  to true. Defaults to read-only. */
  editable?: boolean
  ref?: Ref<NoteEditorHandle>
}

export function NoteEditor({
  editable = false,
  imageContext = EMPTY_IMAGE_CONTEXT,
  initialValue,
  isResolved = () => false,
  notes = [],
  onChange,
  onOpenWikilink,
  ref
}: NoteEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const editableCompartment = useRef(new Compartment())
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onOpenRef = useRef(onOpenWikilink)
  onOpenRef.current = onOpenWikilink
  const notesRef = useRef(notes)
  notesRef.current = notes
  const isResolvedRef = useRef(isResolved)
  isResolvedRef.current = isResolved
  const imageContextRef = useRef(imageContext)
  imageContextRef.current = imageContext

  useImperativeHandle(
    ref,
    () => ({
      scrollToLine(line) {
        const view = viewRef.current

        if (!view) {
          return
        }

        const clamped = Math.min(Math.max(line, 1), view.state.doc.lines)
        const pos = view.state.doc.line(clamped).from

        view.dispatch({
          effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 48 }),
          selection: { anchor: pos }
        })
        view.focus()
      }
    }),
    []
  )

  useEffect(() => {
    const host = hostRef.current

    if (!host) {
      return
    }

    const view = new EditorView({
      doc: initialValue,
      extensions: [
        history(),
        keymap.of([
          { key: 'Mod-b', run: toggleBold },
          { key: 'Mod-i', run: toggleItalic }
        ]),
        // Obsidian-style list auto-continuation: Enter on a bullet/task/numbered line
        // continues the marker onto the next line, Enter on an EMPTY marker line clears
        // it instead of continuing forever; Backspace right after a marker removes the
        // marker before falling back to normal character deletion. Both must run ahead
        // of defaultKeymap's plain Enter/Backspace to get first refusal on the keys.
        keymap.of([
          { key: 'Enter', run: insertNewlineContinueMarkup },
          { key: 'Backspace', run: deleteMarkupBackward }
        ]),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        editableCompartment.current.of(editableExtensions(editable)),
        EditorView.lineWrapping,
        noteMarkdown,
        tableExtension(
          target => onOpenRef.current(target),
          target => isResolvedRef.current(target)
        ),
        livePreview(
          target => onOpenRef.current(target),
          target => isResolvedRef.current(target),
          () => imageContextRef.current
        ),
        // [[ autocomplete: the source only fires inside an open "[[", so it never
        // intercepts normal typing anywhere else (see wikilinkCompletionSource).
        autocompletion({ icons: false, override: [wikilinkCompletionSource(() => notesRef.current)] }),
        placeholder('Write. # heading, **bold**, - list, [[link another note]]'),
        noteTheme,
        EditorView.updateListener.of(update => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString())
          }
        })
      ],
      parent: host
    })

    viewRef.current = view

    return () => {
      viewRef.current = null
      view.destroy()
    }
    // The parent remounts this component per note (key={path}); initialValue is
    // intentionally captured once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Flip read-only ⇄ editable in place when the header toggle changes, without
  // tearing down the editor (keeps scroll position and undo history).
  useEffect(() => {
    const view = viewRef.current

    if (!view) {
      return
    }

    view.dispatch({ effects: editableCompartment.current.reconfigure(editableExtensions(editable)) })

    if (editable) {
      view.focus()
    }
  }, [editable])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1" ref={hostRef} />
    </div>
  )
}
