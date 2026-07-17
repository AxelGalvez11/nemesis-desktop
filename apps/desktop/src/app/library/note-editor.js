import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
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
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { IconBold, IconHeading, IconItalic, IconList } from '@tabler/icons-react';
import { useEffect, useImperativeHandle, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { livePreview, noteMarkdown, noteTheme, tableExtension } from './note-decorations';
import { cycleHeading, toggleBold, toggleBulletList, toggleItalic } from './note-format';
import { VAULT_DIR } from './vault';
import { wikilinkCompletionSource } from './wikilink-autocomplete';
const EMPTY_IMAGE_CONTEXT = { files: [], noteFolder: '', vaultDir: VAULT_DIR };
export function NoteEditor({ imageContext = EMPTY_IMAGE_CONTEXT, initialValue, isResolved = () => false, notes = [], onChange, onOpenWikilink, ref }) {
    const hostRef = useRef(null);
    const viewRef = useRef(null);
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
                EditorView.lineWrapping,
                noteMarkdown,
                tableExtension(target => onOpenRef.current(target), target => isResolvedRef.current(target)),
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
    const runFormat = (command) => {
        const view = viewRef.current;
        if (view) {
            command(view);
            view.focus();
        }
    };
    return (_jsxs("div", { className: "flex h-full min-h-0 flex-col", children: [_jsx("div", { "aria-label": "Formatting", className: "mx-auto flex w-full max-w-[46rem] shrink-0 items-center gap-0.5 border-b border-(--ui-stroke-tertiary) px-1 py-1", role: "toolbar", children: FORMAT_ACTIONS.map(action => (_jsx(Button, { "aria-label": action.label, 
                    // Keep focus (and the selection) in the editor while the button is clicked.
                    onMouseDown: event => event.preventDefault(), onClick: () => runFormat(action.run), size: "icon-xs", title: action.label, type: "button", variant: "ghost", children: _jsx(action.icon, {}) }, action.label))) }), _jsx("div", { className: "min-h-0 flex-1", ref: hostRef })] }));
}
const FORMAT_ACTIONS = [
    { icon: IconBold, label: 'Bold (⌘B)', run: toggleBold },
    { icon: IconItalic, label: 'Italic (⌘I)', run: toggleItalic },
    { icon: IconHeading, label: 'Heading (cycle H1–H3)', run: cycleHeading },
    { icon: IconList, label: 'Bullet list', run: toggleBulletList }
];
