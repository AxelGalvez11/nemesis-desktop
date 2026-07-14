// CodeMirror 6 "live preview" decorations for the note editor: the pure(ish) glue between a
// parsed markdown syntax tree and the rendered widgets/marks (headings, bold/italic, quotes,
// wikilinks, tables, task checkboxes, strikethrough, fenced code). Split out of note-editor.tsx
// so this CodeMirror-heavy layer is independently importable — including by tests — from the
// thin React component that mounts it.
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { StateField } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import { Strikethrough, TaskList } from '@lezer/markdown';
import { resolveEmbeddedImageSrc, resolveRelativeImageSrc } from './image-embed';
/** The markdown language config the whole editor runs on — GFM strikethrough (`~~x~~`) and
 *  task lists (`- [ ]`) on top of the CommonMark base. Exported so a test can parse the exact
 *  same grammar this file's decorations expect. */
export const noteMarkdown = markdown({ base: markdownLanguage, extensions: [Strikethrough, TaskList] });
// Negative lookbehind excludes an Obsidian image embed's "![[...]]" — without it, this would
// ALSO match the "[[...]]" tail of an embed, producing a second, overlapping decoration
// alongside IMAGE_EMBED_RE's own (see buildDecorations' image-embed scan below).
const WIKILINK_RE = /(?<!!)\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g;
const IMAGE_EMBED_RE = /!\[\[([^\]|#\n]+)(?:[^\]\n]*)?\]\]/g;
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
    resolved;
    onOpen;
    constructor(label, target, resolved, onOpen) {
        super();
        this.label = label;
        this.target = target;
        this.resolved = resolved;
        this.onOpen = onOpen;
    }
    eq(other) {
        return other.label === this.label && other.target === this.target && other.resolved === this.resolved;
    }
    ignoreEvent() {
        return true;
    }
    toDOM() {
        const span = document.createElement('span');
        span.className = this.resolved ? 'cm-np-wikilink' : 'cm-np-wikilink cm-np-wikilink-unresolved';
        span.textContent = this.label;
        span.onmousedown = event => {
            event.preventDefault();
            event.stopPropagation();
            this.onOpen(this.target);
        };
        return span;
    }
}
class ImageWidget extends WidgetType {
    src;
    alt;
    constructor(src, alt) {
        super();
        this.src = src;
        this.alt = alt;
    }
    eq(other) {
        return other.src === this.src && other.alt === this.alt;
    }
    toDOM() {
        const img = document.createElement('img');
        img.src = this.src;
        img.alt = this.alt;
        img.className = 'cm-np-image';
        return img;
    }
}
/** Given a task's checkbox marker text ("[ ]" / "[x]" / "[X]"), whether it's checked. */
export function isTaskChecked(marker) {
    return /^\[[xX]\]$/.test(marker);
}
/** The character that belongs inside "[ ]"/"[x]" after a click toggles it. */
export function toggleTaskChar(current) {
    return /[xX]/.test(current) ? ' ' : 'x';
}
class CheckboxWidget extends WidgetType {
    checked;
    charPos;
    constructor(checked, 
    /** Document position of the single character between the brackets. */
    charPos) {
        super();
        this.checked = checked;
        this.charPos = charPos;
    }
    eq(other) {
        return other.checked === this.checked && other.charPos === this.charPos;
    }
    ignoreEvent() {
        return true;
    }
    toDOM(view) {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.className = 'cm-np-checkbox';
        box.checked = this.checked;
        box.setAttribute('aria-label', this.checked ? 'Mark task not done' : 'Mark task done');
        box.onmousedown = event => {
            event.preventDefault();
            event.stopPropagation();
            view.dispatch({
                changes: { from: this.charPos, insert: toggleTaskChar(view.state.sliceDoc(this.charPos, this.charPos + 1)), to: this.charPos + 1 }
            });
        };
        return box;
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
function buildDecorations(view, onOpen, isResolved, getImageContext) {
    const image = getImageContext();
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
                if (type === 'Strikethrough') {
                    decorations.push(Decoration.mark({ class: 'cm-np-strike' }).range(node.from, node.to));
                    return;
                }
                if (type === 'EmphasisMark' || type === 'CodeMark' || type === 'StrikethroughMark') {
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
                if (type === 'FencedCode') {
                    const first = doc.lineAt(node.from).number;
                    const last = doc.lineAt(node.to).number;
                    for (let n = first; n <= last; n++) {
                        decorations.push(Decoration.line({ class: 'cm-np-codeblock' }).range(doc.line(n).from));
                    }
                    return;
                }
                if (type === 'TaskMarker') {
                    const marker = doc.sliceString(node.from, node.to);
                    decorations.push(Decoration.replace({ widget: new CheckboxWidget(isTaskChecked(marker), node.from + 1) }).range(node.from, node.to));
                    return;
                }
                if (type === 'ListMark') {
                    const mark = doc.sliceString(node.from, node.to);
                    if (mark !== '-' && mark !== '*' && mark !== '+') {
                        return;
                    }
                    if (node.node.parent?.getChild('Task')) {
                        // Task list items show only the checkbox widget — no separate bullet dot.
                        hideMarkWithSpace(node.from, node.to);
                    }
                    else if (!lineTouches(node.from)) {
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
                if (type === 'Image') {
                    // Standard "![alt](path)" — Obsidian's "![[name]]" embed is regex-matched below,
                    // same reason wikilinks are (lezer's grammar doesn't know that syntax).
                    if (!selectionTouches(node.from, node.to)) {
                        const urlNode = node.node.getChild('URL');
                        const rawUrl = urlNode ? doc.sliceString(urlNode.from, urlNode.to) : '';
                        const src = rawUrl ? resolveRelativeImageSrc(rawUrl, image.noteFolder, image.vaultDir) : null;
                        if (src) {
                            const altMatch = /^!\[([^\]]*)\]/.exec(doc.sliceString(node.from, node.to));
                            decorations.push(Decoration.replace({ widget: new ImageWidget(src, altMatch?.[1] ?? '') }).range(node.from, node.to));
                        }
                    }
                    // Skip descending into the URL/LinkMark/LinkTitle children — the widget above
                    // already replaces the whole node, and none of those children have their own
                    // decoration outside a Link parent (the LinkMark/URL branch checks `parent?.name
                    // === 'Link'` specifically), so this is a belt-and-suspenders skip, not a fix for
                    // an actual collision.
                    return false;
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
                decorations.push(Decoration.replace({ widget: new WikilinkWidget(label, target, isResolved(target), onOpen) }).range(start, end));
            }
        }
        // Obsidian image embeds ("![[name]]") — also regex-matched; resolved vault-wide by
        // filename (image.files), unlike "![alt](path)" which resolves against the note's folder.
        for (const match of text.matchAll(IMAGE_EMBED_RE)) {
            const start = from + (match.index ?? 0);
            const end = start + match[0].length;
            const name = match[1].trim();
            if (!name || selectionTouches(start, end)) {
                continue;
            }
            const src = resolveEmbeddedImageSrc(name, image.files);
            if (src) {
                decorations.push(Decoration.replace({ widget: new ImageWidget(src, name) }).range(start, end));
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
export const tableField = StateField.define({
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
/** The live-preview ViewPlugin. `isResolved` classifies a wikilink target as resolved
 *  (styled like a normal link) or not (muted/dashed) — see index.tsx's resolvable set,
 *  built by the same rule openWikilink uses to decide whether a click creates a note. */
export function livePreview(onOpen, isResolved, getImageContext) {
    return ViewPlugin.fromClass(class {
        decorations;
        constructor(view) {
            this.decorations = buildDecorations(view, onOpen, isResolved, getImageContext);
        }
        update(update) {
            if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged) {
                this.decorations = buildDecorations(update.view, onOpen, isResolved, getImageContext);
            }
        }
    }, { decorations: plugin => plugin.decorations });
}
export const noteTheme = EditorView.theme({
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
    '.cm-np-strike': { color: 'var(--ui-text-tertiary)', textDecorationLine: 'line-through' },
    '.cm-np-code': {
        backgroundColor: 'var(--ui-bg-quaternary)',
        border: '1px solid var(--ui-stroke-quaternary)',
        borderRadius: '5px',
        fontFamily: 'var(--dt-font-mono, ui-monospace, monospace)',
        fontSize: '0.88em',
        padding: '0.1em 0.34em'
    },
    '.cm-np-codeblock': {
        backgroundColor: 'var(--ui-bg-quaternary)',
        fontFamily: 'var(--dt-font-mono, ui-monospace, monospace)',
        fontSize: '0.88em'
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
    '.cm-np-checkbox': {
        cursor: 'pointer',
        marginRight: '0.45em',
        verticalAlign: 'middle'
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
    '.cm-np-wikilink-unresolved': {
        color: 'var(--ui-text-tertiary)',
        fontWeight: '500',
        textDecorationColor: 'var(--ui-stroke-secondary)',
        textDecorationStyle: 'dashed'
    },
    '.cm-np-wikilink-unresolved:hover': { textDecorationColor: 'var(--ui-text-tertiary)' },
    '.cm-np-wikilink-src': { color: 'var(--theme-primary)' },
    '.cm-np-link': { color: 'var(--theme-primary)', textUnderlineOffset: '3px' },
    '.cm-np-hr': {
        borderTop: '1px solid var(--ui-stroke-secondary)',
        display: 'inline-block',
        margin: '0.75em 0',
        verticalAlign: 'middle',
        width: '100%'
    },
    '.cm-np-image': {
        borderRadius: '8px',
        display: 'block',
        height: 'auto',
        margin: '0.5em 0',
        maxWidth: '100%'
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
    },
    '.cm-tooltip.cm-tooltip-autocomplete': {
        backgroundColor: 'var(--ui-bg-elevated)',
        border: '1px solid var(--ui-stroke-secondary)',
        borderRadius: '8px',
        boxShadow: '0 8px 24px color-mix(in srgb, black 20%, transparent)',
        overflow: 'hidden'
    },
    '.cm-tooltip-autocomplete ul': { fontFamily: 'inherit', maxHeight: '16em' },
    '.cm-tooltip-autocomplete ul li': { padding: '0.3em 0.7em' },
    '.cm-tooltip-autocomplete ul li[aria-selected]': {
        backgroundColor: 'var(--theme-primary)',
        color: 'var(--dt-primary-foreground)'
    },
    '.cm-completionDetail': { color: 'var(--ui-text-tertiary)', fontStyle: 'normal', marginLeft: '0.6em' }
});
