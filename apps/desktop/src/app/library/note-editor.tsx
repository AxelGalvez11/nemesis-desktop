// NoteEditor — Obsidian-style "live preview" over CodeMirror 6 (the SAME editor engine
// Obsidian itself is built on; @codemirror/* + @lezer/markdown, all MIT). The markdown
// stays plain text on disk, but formatting marks melt away as you read: `# ` disappears
// and the heading renders big, `**bold**` loses its asterisks, `- ` becomes a bullet dot,
// and [[wikilinks]] render as clickable accent-colored links. Put the cursor on a line
// and its raw marks reappear for editing — exactly Obsidian's behavior.
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { syntaxTree } from '@codemirror/language'
import type { Extension, Range } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  placeholder,
  ViewPlugin,
  type ViewUpdate,
  WidgetType
} from '@codemirror/view'
import { type Ref, useEffect, useImperativeHandle, useRef } from 'react'

const WIKILINK_RE = /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g

class BulletWidget extends WidgetType {
  eq(): boolean {
    return true
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-np-bullet'
    span.textContent = '•'

    return span
  }
}

class HrWidget extends WidgetType {
  eq(): boolean {
    return true
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-np-hr'

    return span
  }
}

class WikilinkWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly target: string,
    readonly onOpen: (target: string) => void
  ) {
    super()
  }

  eq(other: WikilinkWidget): boolean {
    return other.label === this.label && other.target === this.target
  }

  ignoreEvent(): boolean {
    return true
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-np-wikilink'
    span.textContent = this.label
    span.onmousedown = event => {
      event.preventDefault()
      event.stopPropagation()
      this.onOpen(this.target)
    }

    return span
  }
}

function buildDecorations(view: EditorView, onOpen: (target: string) => void): DecorationSet {
  const decorations: Range<Decoration>[] = []
  const doc = view.state.doc
  const selection = view.state.selection

  // Obsidian semantics: an unfocused editor is fully rendered — raw marks only ever
  // show around the caret while you're actually editing.
  const selectionTouches = (from: number, to: number): boolean =>
    view.hasFocus && selection.ranges.some(range => range.to >= from && range.from <= to)

  const lineTouches = (pos: number): boolean => {
    const line = doc.lineAt(pos)

    return selectionTouches(line.from, line.to)
  }

  // Hide a mark plus one trailing space ("# " / "> ") when the cursor is elsewhere.
  const hideMarkWithSpace = (from: number, to: number) => {
    const end = doc.sliceString(to, to + 1) === ' ' ? to + 1 : to
    decorations.push(Decoration.replace({}).range(from, end))
  }

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      enter: node => {
        const type = node.name

        if (/^ATXHeading[1-6]$/.test(type)) {
          const level = Number(type.slice('ATXHeading'.length))
          const line = doc.lineAt(node.from)
          decorations.push(Decoration.line({ class: `cm-np-h cm-np-h${level}` }).range(line.from))

          return
        }

        if (type === 'HeaderMark') {
          if (!lineTouches(node.from)) {
            hideMarkWithSpace(node.from, node.to)
          }

          return
        }

        if (type === 'StrongEmphasis' || type === 'Emphasis') {
          decorations.push(
            Decoration.mark({ class: type === 'Emphasis' ? 'cm-np-em' : 'cm-np-strong' }).range(node.from, node.to)
          )

          return
        }

        if (type === 'EmphasisMark' || type === 'CodeMark') {
          const parent = node.node.parent

          if (parent && !selectionTouches(parent.from, parent.to)) {
            decorations.push(Decoration.replace({}).range(node.from, node.to))
          }

          return
        }

        if (type === 'InlineCode') {
          decorations.push(Decoration.mark({ class: 'cm-np-code' }).range(node.from, node.to))

          return
        }

        if (type === 'ListMark') {
          const mark = doc.sliceString(node.from, node.to)

          if ((mark === '-' || mark === '*' || mark === '+') && !lineTouches(node.from)) {
            decorations.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to))
          }

          return
        }

        if (type === 'QuoteMark') {
          const line = doc.lineAt(node.from)
          decorations.push(Decoration.line({ class: 'cm-np-quote' }).range(line.from))

          if (!lineTouches(node.from)) {
            hideMarkWithSpace(node.from, node.to)
          }

          return
        }

        if (type === 'Link') {
          decorations.push(Decoration.mark({ class: 'cm-np-link' }).range(node.from, node.to))

          return
        }

        if (type === 'LinkMark' || type === 'URL') {
          const parent = node.node.parent

          if (parent?.name === 'Link' && !selectionTouches(parent.from, parent.to)) {
            decorations.push(Decoration.replace({}).range(node.from, node.to))
          }

          return
        }

        if (type === 'HorizontalRule' && !lineTouches(node.from)) {
          decorations.push(Decoration.replace({ widget: new HrWidget() }).range(node.from, node.to))
        }
      },
      from,
      to
    })

    // Wikilinks by regex — lezer's markdown grammar doesn't know Obsidian's [[...]].
    const text = doc.sliceString(from, to)

    for (const match of text.matchAll(WIKILINK_RE)) {
      const start = from + (match.index ?? 0)
      const end = start + match[0].length
      const target = match[1].trim()
      const label = (match[2] ?? target).trim() || target

      if (!target) {
        continue
      }

      if (selectionTouches(start, end)) {
        decorations.push(Decoration.mark({ class: 'cm-np-wikilink-src' }).range(start, end))
      } else {
        decorations.push(
          Decoration.replace({ widget: new WikilinkWidget(label, target, onOpen) }).range(start, end)
        )
      }
    }
  }

  return Decoration.set(decorations, true)
}

function livePreview(onOpen: (target: string) => void): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, onOpen)
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged) {
          this.decorations = buildDecorations(update.view, onOpen)
        }
      }
    },
    { decorations: plugin => plugin.decorations }
  )
}

const noteTheme = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    fontFamily: 'var(--dt-font-sans, ui-sans-serif, system-ui, sans-serif)',
    color: 'var(--ui-text-primary)',
    fontSize: '1rem',
    height: '100%'
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.8', overflow: 'auto' },
  '.cm-content': {
    caretColor: 'var(--theme-primary)',
    margin: '0 auto',
    maxWidth: '46rem',
    padding: '1.5rem 0 35vh',
    width: '100%'
  },
  '.cm-line': { padding: '0 0.25rem' },
  '.cm-cursor': { borderLeftColor: 'var(--theme-primary)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'color-mix(in srgb, var(--theme-primary) 18%, transparent)'
  },
  '.cm-np-h': { color: 'var(--ui-text-primary)', fontWeight: '700', letterSpacing: '-0.025em' },
  '.cm-np-h1': { fontSize: '1.85em', lineHeight: '1.25', paddingBottom: '0.12em', paddingTop: '0.7em' },
  '.cm-np-h2': { fontSize: '1.45em', lineHeight: '1.3', paddingBottom: '0.1em', paddingTop: '0.65em' },
  '.cm-np-h3': { fontSize: '1.2em', lineHeight: '1.4', paddingTop: '0.5em' },
  '.cm-np-h4, .cm-np-h5, .cm-np-h6': {
    fontSize: '0.88em',
    letterSpacing: '0.07em',
    paddingTop: '0.45em',
    textTransform: 'uppercase'
  },
  '.cm-np-strong': { fontWeight: '700' },
  '.cm-np-em': { fontStyle: 'italic' },
  '.cm-np-code': {
    backgroundColor: 'var(--ui-bg-quaternary)',
    border: '1px solid var(--ui-stroke-quaternary)',
    borderRadius: '5px',
    fontFamily: 'var(--dt-font-mono, ui-monospace, monospace)',
    fontSize: '0.88em',
    padding: '0.1em 0.34em'
  },
  '.cm-np-quote': {
    backgroundColor: 'var(--ui-bg-quaternary)',
    borderLeft: '3px solid var(--theme-primary)',
    color: 'var(--ui-text-secondary)',
    padding: '0.14em 0.75rem'
  },
  '.cm-np-bullet': {
    color: 'var(--theme-primary)',
    display: 'inline-block',
    fontWeight: '700',
    width: '1ch'
  },
  '.cm-np-wikilink': {
    color: 'var(--theme-primary)',
    cursor: 'pointer',
    fontWeight: '600',
    textDecorationColor: 'color-mix(in srgb, var(--theme-primary) 40%, transparent)',
    textDecorationLine: 'underline',
    textUnderlineOffset: '3px'
  },
  '.cm-np-wikilink:hover': { textDecorationColor: 'var(--theme-primary)' },
  '.cm-np-wikilink-src': { color: 'var(--theme-primary)' },
  '.cm-np-link': { color: 'var(--theme-primary)', textUnderlineOffset: '3px' },
  '.cm-np-hr': {
    borderTop: '1px solid var(--ui-stroke-secondary)',
    display: 'inline-block',
    margin: '0.75em 0',
    verticalAlign: 'middle',
    width: '100%'
  }
})

export interface NoteEditorHandle {
  /** Scroll the editor to a 1-based line number and place the cursor there
   *  (the Outline tab in the right rail drives this). */
  scrollToLine: (line: number) => void
}

export interface NoteEditorProps {
  initialValue: string
  onChange: (value: string) => void
  onOpenWikilink: (target: string) => void
  ref?: Ref<NoteEditorHandle>
}

export function NoteEditor({ initialValue, onChange, onOpenWikilink, ref }: NoteEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onOpenRef = useRef(onOpenWikilink)
  onOpenRef.current = onOpenWikilink

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
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage }),
        livePreview(target => onOpenRef.current(target)),
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

  return <div className="h-full min-h-0" ref={hostRef} />
}
