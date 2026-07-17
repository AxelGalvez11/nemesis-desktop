import { jsx as _jsx } from "react/jsx-runtime";
// NoteEditor — Obsidian-style "live preview" over CodeMirror 6 (the SAME editor engine
// Obsidian itself is built on; @codemirror/* + @lezer/markdown, all MIT). The markdown
// stays plain text on disk, but formatting marks melt away as you read: `# ` disappears
// and the heading renders big, `**bold**` loses its asterisks, `- ` becomes a bullet dot,
// and [[wikilinks]] render as clickable accent-colored links. Put the cursor on a line
// and its raw marks reappear for editing — exactly Obsidian's behavior. The decoration
// logic itself (headings/emphasis/tables/checkboxes/wikilinks → CodeMirror decorations)
// lives in note-decorations.ts; this file mounts the EditorView and owns its lifecycle.
import { autocompletion } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { deleteMarkupBackward, insertNewlineContinueMarkup } from '@codemirror/lang-markdown';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { useEffect, useImperativeHandle, useRef } from 'react';
import { calloutExtension, codeHighlighting, livePreview, mathBlockExtension, mermaidExtension, noteMarkdown, noteTheme, tableExtension } from './note-decorations';
import { toggleBold, toggleItalic } from './note-format';
import { VAULT_DIR } from './vault';
import { wikilinkCompletionSource } from './wikilink-autocomplete';
const EMPTY_IMAGE_CONTEXT = { files: [], noteFolder: '', vaultDir: VAULT_DIR };
// Read-only vs editable is one compartment we reconfigure live (see the `editable`
// prop) so the "Edit" toggle in the header flips the note between a calm reading view
// and an editable one without remounting the editor or losing scroll position.
// `readOnly` blocks doc changes; `editable: false` also removes the caret and keeps
// the text selectable (copy still works) — together that's a true read-only note.
function editableExtensions(editable) {
    return [EditorState.readOnly.of(!editable), EditorView.editable.of(editable)];
}
export function NoteEditor({ editable = false, imageContext = EMPTY_IMAGE_CONTEXT, initialValue, isResolved = () => false, notes = [], onChange, onOpenWikilink, ref }) {
    const hostRef = useRef(null);
    const viewRef = useRef(null);
    const editableCompartment = useRef(new Compartment());
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const onOpenRef = useRef(onOpenWikilink);
    onOpenRef.current = onOpenWikilink;
    const notesRef = useRef(notes);
    notesRef.current = notes;
    const isResolvedRef = useRef(isResolved);
    isResolvedRef.current = isResolved;
    const imageContextRef = useRef(imageContext);
    imageContextRef.current = imageContext;
    useImperativeHandle(ref, () => ({
        scrollToLine(line) {
            const view = viewRef.current;
            if (!view) {
                return;
            }
            const clamped = Math.min(Math.max(line, 1), view.state.doc.lines);
            const pos = view.state.doc.line(clamped).from;
            view.dispatch({
                effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 48 }),
                selection: { anchor: pos }
            });
            view.focus();
        }
    }), []);
    useEffect(() => {
        const host = hostRef.current;
        if (!host) {
            return;
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
                codeHighlighting,
                tableExtension(target => onOpenRef.current(target), target => isResolvedRef.current(target)),
                calloutExtension(target => onOpenRef.current(target), target => isResolvedRef.current(target)),
                mathBlockExtension(),
                mermaidExtension(),
                livePreview(target => onOpenRef.current(target), target => isResolvedRef.current(target), () => imageContextRef.current),
                // [[ autocomplete: the source only fires inside an open "[[", so it never
                // intercepts normal typing anywhere else (see wikilinkCompletionSource).
                autocompletion({ icons: false, override: [wikilinkCompletionSource(() => notesRef.current)] }),
                placeholder('Write. # heading, **bold**, - list, [[link another note]]'),
                noteTheme,
                EditorView.updateListener.of(update => {
                    if (update.docChanged) {
                        onChangeRef.current(update.state.doc.toString());
                    }
                })
            ],
            parent: host
        });
        viewRef.current = view;
        return () => {
            viewRef.current = null;
            view.destroy();
        };
        // The parent remounts this component per note (key={path}); initialValue is
        // intentionally captured once per mount.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    // Flip read-only ⇄ editable in place when the header toggle changes, without
    // tearing down the editor (keeps scroll position and undo history).
    useEffect(() => {
        const view = viewRef.current;
        if (!view) {
            return;
        }
        view.dispatch({ effects: editableCompartment.current.reconfigure(editableExtensions(editable)) });
        if (editable) {
            view.focus();
        }
    }, [editable]);
    return (_jsx("div", { className: "flex h-full min-h-0 flex-col", children: _jsx("div", { className: "min-h-0 flex-1", ref: hostRef }) }));
}
