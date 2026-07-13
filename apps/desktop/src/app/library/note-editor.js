import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// NoteEditor — Obsidian-style "live preview" over CodeMirror 6 (the SAME editor engine
// Obsidian itself is built on; @codemirror/* + @lezer/markdown, all MIT). The markdown
// stays plain text on disk, but formatting marks melt away as you read: `# ` disappears
// and the heading renders big, `**bold**` loses its asterisks, `- ` becomes a bullet dot,
// and [[wikilinks]] render as clickable accent-colored links. Put the cursor on a line
// and its raw marks reappear for editing — exactly Obsidian's behavior.
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { StateField } from '@codemirror/state';
import { Decoration, EditorView, keymap, placeholder, ViewPlugin, WidgetType } from '@codemirror/view';
import { IconBold, IconHeading, IconItalic, IconList } from '@tabler/icons-react';
import { useEffect, useImperativeHandle, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { cycleHeading, toggleBold, toggleBulletList, toggleItalic } from './note-format';
const WIKILINK_RE = /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g;
class BulletWidget extends WidgetType {
    eq() {
        return true;
    }
    toDOM() {
        const span = document.createElement('span');
        span.className = 'cm-np-bullet';
        span.textContent = '•';
        return span;
    }
}
class HrWidget extends WidgetType {
    eq() {
        return true;
    }
    toDOM() {
        const span = document.createElement('span');
        span.className = 'cm-np-hr';
        return span;
    }
}
class WikilinkWidget extends WidgetType {
    label;
    target;
    onOpen;
    constructor(label, target, onOpen) {
        super();
        this.label = label;
        this.target = target;
        this.onOpen = onOpen;
    }
    eq(other) {
        return other.label === this.label && other.target === this.target;
    }
    ignoreEvent() {
        return true;
    }
    toDOM() {
        const span = document.createElement('span');
        span.className = 'cm-np-wikilink';
        span.textContent = this.label;
        span.onmousedown = event => {
            event.preventDefault();
            event.stopPropagation();
            this.onOpen(this.target);
        };
        return span;
    }
}
/** Split a markdown table row into trimmed cell strings ("| a | b |" → ["a","b"]). */
function tableCells(line) {
    return line
        .replace(/^\s*\|/, '')
        .replace(/\|\s*$/, '')
        .split('|')
        .map(cell => cell.trim());
}
const TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/;
class TableWidget extends WidgetType {
    header;
    rows;
    constructor(header, rows) {
        super();
        this.header = header;
        this.rows = rows;
    }
    eq(other) {
        return JSON.stringify([this.header, this.rows]) === JSON.stringify([other.header, other.rows]);
    }
    toDOM() {
        const table = document.createElement('table');
        table.className = 'cm-np-table';
        const thead = table.createTHead();
        const hr = thead.insertRow();
        for (const cell of this.header) {
            const th = document.createElement('th');
            th.textContent = cell;
            hr.appendChild(th);
        }
        const tbody = table.createTBody();
        for (const row of this.rows) {
            const tr = tbody.insertRow();
            for (let i = 0; i < this.header.length; i++) {
                tr.insertCell().textContent = row[i] ?? '';
            }
        }
        return table;
    }
}
/** GFM table blocks in the doc: a header row, a `|---|` separator, then body rows.
 *  Returned as whole-line ranges so the caller can block-replace or skip them. */
function findTableBlocks(doc) {
    const blocks = [];
    const total = doc.lines;
    for (let n = 1; n < total; n++) {
        const header = doc.line(n);
        const sep = doc.line(n + 1);
        if (!header.text.includes('|') || !TABLE_SEP_RE.test(sep.text)) {
            continue;
        }
        let last = n + 1;
        const rows = [];
        for (let m = n + 2; m <= total; m++) {
            const body = doc.line(m);
            if (!body.text.includes('|') || body.text.trim() === '') {
                break;
            }
            rows.push(tableCells(body.text));
            last = m;
        }
        blocks.push({ from: header.from, header: tableCells(header.text), rows, to: doc.line(last).to });
        n = last;
    }
    return blocks;
}
function buildDecorations(view, onOpen) {
    const decorations = [];
    const doc = view.state.doc;
    const selection = view.state.selection;
    // Obsidian semantics: an unfocused editor is fully rendered — raw marks only ever
    // show around the caret while you're actually editing.
    const selectionTouches = (from, to) => view.hasFocus && selection.ranges.some(range => range.to >= from && range.from <= to);
    const lineTouches = (pos) => {
        const line = doc.lineAt(pos);
        return selectionTouches(line.from, line.to);
    };
    // Hide a mark plus one trailing space ("# " / "> ") when the cursor is elsewhere.
    const hideMarkWithSpace = (from, to) => {
        const end = doc.sliceString(to, to + 1) === ' ' ? to + 1 : to;
        decorations.push(Decoration.replace({}).range(from, end));
    };
    for (const { from, to } of view.visibleRanges) {
        syntaxTree(view.state).iterate({
            enter: node => {
                const type = node.name;
                if (/^ATXHeading[1-6]$/.test(type)) {
                    const level = Number(type.slice('ATXHeading'.length));
                    const line = doc.lineAt(node.from);
                    decorations.push(Decoration.line({ class: `cm-np-h cm-np-h${level}` }).range(line.from));
                    return;
                }
                if (type === 'HeaderMark') {
                    if (!lineTouches(node.from)) {
                        hideMarkWithSpace(node.from, node.to);
                    }
                    return;
                }
                if (type === 'StrongEmphasis' || type === 'Emphasis') {
                    decorations.push(Decoration.mark({ class: type === 'Emphasis' ? 'cm-np-em' : 'cm-np-strong' }).range(node.from, node.to));
                    return;
                }
                if (type === 'EmphasisMark' || type === 'CodeMark') {
                    const parent = node.node.parent;
                    if (parent && !selectionTouches(parent.from, parent.to)) {
                        decorations.push(Decoration.replace({}).range(node.from, node.to));
                    }
                    return;
                }
                if (type === 'InlineCode') {
                    decorations.push(Decoration.mark({ class: 'cm-np-code' }).range(node.from, node.to));
                    return;
                }
                if (type === 'ListMark') {
                    const mark = doc.sliceString(node.from, node.to);
                    if ((mark === '-' || mark === '*' || mark === '+') && !lineTouches(node.from)) {
                        decorations.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to));
                    }
                    return;
                }
                if (type === 'QuoteMark') {
                    const line = doc.lineAt(node.from);
                    decorations.push(Decoration.line({ class: 'cm-np-quote' }).range(line.from));
                    if (!lineTouches(node.from)) {
                        hideMarkWithSpace(node.from, node.to);
                    }
                    return;
                }
                if (type === 'Link') {
                    decorations.push(Decoration.mark({ class: 'cm-np-link' }).range(node.from, node.to));
                    return;
                }
                if (type === 'LinkMark' || type === 'URL') {
                    const parent = node.node.parent;
                    if (parent?.name === 'Link' && !selectionTouches(parent.from, parent.to)) {
                        decorations.push(Decoration.replace({}).range(node.from, node.to));
                    }
                    return;
                }
                if (type === 'HorizontalRule' && !lineTouches(node.from)) {
                    decorations.push(Decoration.replace({ widget: new HrWidget() }).range(node.from, node.to));
                }
            },
            from,
            to
        });
        // Wikilinks by regex — lezer's markdown grammar doesn't know Obsidian's [[...]].
        const text = doc.sliceString(from, to);
        for (const match of text.matchAll(WIKILINK_RE)) {
            const start = from + (match.index ?? 0);
            const end = start + match[0].length;
            const target = match[1].trim();
            const label = (match[2] ?? target).trim() || target;
            if (!target) {
                continue;
            }
            if (selectionTouches(start, end)) {
                decorations.push(Decoration.mark({ class: 'cm-np-wikilink-src' }).range(start, end));
            }
            else {
                decorations.push(Decoration.replace({ widget: new WikilinkWidget(label, target, onOpen) }).range(start, end));
            }
        }
    }
    // Tables render via a separate StateField (tableField below) — CodeMirror forbids
    // block-replace-across-lines decorations from a ViewPlugin. Here we only DROP the
    // inline decorations that fall inside a rendered table block so they don't collide
    // with the StateField's block widget.
    const renderedTables = findTableBlocks(doc).filter(block => !selectionTouches(block.from, block.to));
    if (renderedTables.length > 0) {
        const inRendered = (pos) => renderedTables.some(block => pos >= block.from && pos <= block.to);
        return Decoration.set(decorations.filter(range => !inRendered(range.from)), true);
    }
    return Decoration.set(decorations, true);
}
/** Table block-replace decorations. In a StateField (not the ViewPlugin) because
 *  CodeMirror only allows line-break-replacing block decorations from state, not
 *  plugins. Recomputes on doc + selection changes so the raw markdown reappears
 *  when the caret enters the table. */
const tableField = StateField.define({
    create: state => buildTableDecorations(state),
    provide: field => EditorView.decorations.from(field),
    update(value, tr) {
        return tr.docChanged || tr.selection ? buildTableDecorations(tr.state) : value;
    }
});
function buildTableDecorations(state) {
    const doc = state.doc;
    const ranges = [];
    for (const block of findTableBlocks(doc)) {
        const touched = state.selection.ranges.some(r => r.to >= block.from && r.from <= block.to);
        if (!touched) {
            ranges.push(Decoration.replace({ block: true, widget: new TableWidget(block.header, block.rows) }).range(block.from, block.to));
        }
    }
    return Decoration.set(ranges, true);
}
function livePreview(onOpen) {
    return ViewPlugin.fromClass(class {
        decorations;
        constructor(view) {
            this.decorations = buildDecorations(view, onOpen);
        }
        update(update) {
            if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged) {
                this.decorations = buildDecorations(update.view, onOpen);
            }
        }
    }, { decorations: plugin => plugin.decorations });
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
    },
    '.cm-np-table': {
        borderCollapse: 'collapse',
        fontSize: '0.9em',
        margin: '0.5em 0',
        width: '100%'
    },
    '.cm-np-table th, .cm-np-table td': {
        border: '1px solid var(--ui-stroke-tertiary)',
        padding: '0.35em 0.6em',
        textAlign: 'left',
        verticalAlign: 'top'
    },
    '.cm-np-table th': {
        backgroundColor: 'var(--ui-bg-quaternary)',
        fontWeight: '600'
    },
    '.cm-np-table tbody tr:nth-child(even)': {
        backgroundColor: 'color-mix(in srgb, var(--ui-bg-quaternary) 45%, transparent)'
    }
});
export function NoteEditor({ initialValue, onChange, onOpenWikilink, ref }) {
    const hostRef = useRef(null);
    const viewRef = useRef(null);
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const onOpenRef = useRef(onOpenWikilink);
    onOpenRef.current = onOpenWikilink;
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
                keymap.of([...defaultKeymap, ...historyKeymap]),
                EditorView.lineWrapping,
                markdown({ base: markdownLanguage }),
                tableField,
                livePreview(target => onOpenRef.current(target)),
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
