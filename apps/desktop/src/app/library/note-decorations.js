// CodeMirror 6 "live preview" decorations for the note editor: the pure(ish) glue between a
// parsed markdown syntax tree and the rendered widgets/marks (headings, bold/italic, quotes,
// wikilinks, tables, task checkboxes, strikethrough, fenced code). Split out of note-editor.tsx
// so this CodeMirror-heavy layer is independently importable — including by tests — from the
// thin React component that mounts it.
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { StateField } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { Strikethrough, TaskList } from '@lezer/markdown';
import katex from 'katex';
import { onThemeRepaint } from '../../hooks/use-theme-epoch';
import { resolveEmbeddedImageSrc, resolveRelativeImageSrc } from './image-embed';
/** The markdown language config the whole editor runs on — GFM strikethrough (`~~x~~`) and
 *  task lists (`- [ ]`) on top of the CommonMark base. Exported so a test can parse the exact
 *  same grammar this file's decorations expect. */
export const noteMarkdown = markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [Strikethrough, TaskList] });
/** Syntax colors for embedded fenced code, scoped to CODE-token tags only so markdown structure
 *  (headings, bold, links) is untouched and stays owned by the live-preview decorations. The
 *  markdown language is configured with codeLanguages (above) to lazy-load each language's Lezer
 *  grammar; these colors render its tokens. light-dark() adapts to the app's color-scheme, so a
 *  single palette works in both themes. */
const codeHighlightStyle = HighlightStyle.define([
    {
        color: 'light-dark(#8250df, #c297ff)',
        tag: [tags.keyword, tags.modifier, tags.controlKeyword, tags.operatorKeyword, tags.definitionKeyword, tags.moduleKeyword]
    },
    { color: 'light-dark(#0a7b34, #7ee787)', tag: [tags.string, tags.special(tags.string), tags.regexp] },
    { color: 'light-dark(#0550ae, #79c0ff)', tag: [tags.number, tags.bool, tags.null, tags.atom] },
    {
        color: 'light-dark(#6e7781, #8b949e)',
        fontStyle: 'italic',
        tag: [tags.comment, tags.lineComment, tags.blockComment, tags.meta]
    },
    {
        color: 'light-dark(#8250df, #d2a8ff)',
        tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName]
    },
    { color: 'light-dark(#953800, #ffa657)', tag: [tags.typeName, tags.className, tags.namespace, tags.tagName] },
    { color: 'light-dark(#0550ae, #79c0ff)', tag: [tags.propertyName, tags.attributeName] },
    { color: 'light-dark(#953800, #ffa657)', tag: [tags.variableName, tags.definition(tags.variableName)] },
    { color: 'light-dark(#6e7781, #a0a0aa)', tag: [tags.operator, tags.punctuation, tags.separator, tags.bracket] }
]);
/** syntaxHighlighting for fenced code (see codeHighlightStyle). Added to the editor alongside
 *  noteMarkdown; markdown tokens aren't in the style, so only code is colored. */
export const codeHighlighting = syntaxHighlighting(codeHighlightStyle);
// Negative lookbehind excludes an Obsidian image embed's "![[...]]" — without it, this would
// ALSO match the "[[...]]" tail of an embed, producing a second, overlapping decoration
// alongside IMAGE_EMBED_RE's own (see buildDecorations' image-embed scan below).
const WIKILINK_RE = /(?<!!)\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g;
const IMAGE_EMBED_RE = /!\[\[([^\]|#\n]+)(?:[^\]\n]*)?\]\]/g;
// Obsidian callout header: `> [!type]` with an optional fold char (`-` = collapsed by
// default, `+`/none = expanded) and an optional title. Subsequent `>` lines are the body.
// This is the "hide the worked solution until you've attempted it" primitive: the agent
// writes `> [!solution]- Steps` and the note renders it as a fold-to-reveal card.
const CALLOUT_HEAD_RE = /^\s*>\s*\[!([A-Za-z][\w-]*)\]([-+]?)\s?(.*)$/;
const QUOTE_LINE_RE = /^\s*>/;
// Inline math: `$…$`. Space-delimited (open `$` not before whitespace, close `$` not after
// whitespace) so "$5 and $10" in prose isn't consumed; `$$…$$` display math is a block (see
// findMathBlocks), so a doubled `$` is excluded here. Content still needs a math signal:
const INLINE_MATH_RE = /(?<![\\$])\$(?![\s$])((?:[^$\n\\]|\\.)+?)(?<![\s\\])\$(?!\$)/g;
// …a letter, backslash, or operator char — what separates `$3x + 2$` / `$\frac12$` (render)
// from `$5` / `$5$` (currency / bare number, left as plain text).
const MATH_SIGNAL_RE = /[A-Za-z\\^_{}]/;
// A fenced code delimiter line (``` or ~~~), so `$$` inside a code fence isn't treated as math.
const CODE_FENCE_RE = /^\s*(```|~~~)/;
// A fenced code block tagged `mermaid` (```mermaid) — rendered as a diagram, not a code block.
const MERMAID_FENCE_RE = /^\s*(`{3,}|~{3,})\s*mermaid\s*$/i;
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
/** A KaTeX-rendered equation — inline (`$…$`, a <span>) or display (`$$…$$`, a centered
 *  <div>). Renders with the same options the chat's markdown uses (see lib/katex-memo.ts) so
 *  an equation looks the same in a note as in a message. eq() keeps the DOM stable across
 *  rebuilds so KaTeX only re-runs when the LaTeX actually changes. */
class MathWidget extends WidgetType {
    tex;
    display;
    constructor(tex, display) {
        super();
        this.tex = tex;
        this.display = display;
    }
    eq(other) {
        return other.tex === this.tex && other.display === this.display;
    }
    ignoreEvent() {
        return true;
    }
    toDOM() {
        const el = document.createElement(this.display ? 'div' : 'span');
        el.className = this.display ? 'cm-np-math cm-np-math-display' : 'cm-np-math cm-np-math-inline';
        try {
            // innerHTML is safe here: the markup is produced by katex.renderToString, which emits
            // trusted HTML/MathML by design, and trust:false blocks the injection-capable commands
            // (\href javascript:, \htmlData, …). The LaTeX is the user's own note text. (Routing it
            // through DOMPurify would strip KaTeX's MathML and break rendering.) throwOnError:false
            // renders invalid LaTeX as inline red text instead of throwing — a throw here would
            // abort the whole decoration build and blank the note.
            el.innerHTML = katex.renderToString(this.tex, {
                displayMode: this.display,
                errorColor: '#e5484d',
                strict: 'ignore',
                throwOnError: false,
                trust: false
            });
        }
        catch {
            el.classList.add('cm-np-math-error');
            el.textContent = this.display ? `$$${this.tex}$$` : `$${this.tex}$`;
        }
        return el;
    }
}
let mermaidPromise = null;
let mermaidThemeApplied = null;
/** Lazy-load mermaid on first diagram — it's heavy (d3/dagre), so a note with no diagrams never
 *  pays for it. Matches how the chat's mermaid embed loads it. */
function loadMermaid() {
    mermaidPromise ??= import('mermaid').then(module => module.default);
    return mermaidPromise;
}
function applyMermaidTheme(mermaid, dark) {
    const theme = dark ? 'dark' : 'default';
    if (theme === mermaidThemeApplied) {
        return;
    }
    mermaid.initialize({ fontFamily: 'inherit', securityLevel: 'strict', startOnLoad: false, theme });
    mermaidThemeApplied = theme;
}
function isDarkMode() {
    return typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
}
function safeRequestMeasure(view) {
    try {
        view.requestMeasure();
    }
    catch {
        // The view was torn down between the async render and now — nothing to measure.
    }
}
/** A ```mermaid fenced block rendered as a diagram. Mermaid renders ASYNCHRONOUSLY, so the widget
 *  shows the raw source synchronously, then swaps in the SVG when render resolves (and calls
 *  view.requestMeasure so CodeMirror re-measures the height change). Re-renders on a dark/light
 *  flip via onThemeRepaint — theme changes don't produce CM transactions, so the StateField never
 *  rebuilds for them and this subscription is the only re-theme path. On any error (or invalid
 *  syntax mid-edit) it falls back to the raw source, never a broken diagram. securityLevel:'strict'
 *  + innerHTML is safe the same way KaTeX's is (mermaid sanitizes labels, drops click handlers). */
class MermaidWidget extends WidgetType {
    code;
    unsub = null;
    destroyed = false;
    constructor(code) {
        super();
        this.code = code;
    }
    eq(other) {
        // Code alone — NOT theme. A theme flip is handled by the onThemeRepaint subscription; folding
        // it into eq() would never fire (no transaction) and would rebuild the DOM on every edit.
        return other.code === this.code;
    }
    ignoreEvent() {
        return true;
    }
    toDOM(view) {
        const wrap = document.createElement('div');
        wrap.className = 'cm-np-mermaid';
        const showSource = (errored) => {
            wrap.innerHTML = '';
            const pre = document.createElement('pre');
            pre.className = errored ? 'cm-np-mermaid-src cm-np-mermaid-error' : 'cm-np-mermaid-src';
            pre.textContent = this.code;
            wrap.appendChild(pre);
        };
        // Raw-source placeholder until the async render resolves (also the error fallback).
        showSource(false);
        let token = 0;
        let renderedDark = null;
        const render = (force) => {
            const dark = isDarkMode();
            // onThemeRepaint fires on ANY <html> class/style mutation (CSS var churn, scroll locks…),
            // not only a dark flip — so re-render only when the resolved dark state actually changed.
            if (!force && dark === renderedDark) {
                return;
            }
            renderedDark = dark;
            const mine = ++token;
            void (async () => {
                try {
                    const mermaid = await loadMermaid();
                    applyMermaidTheme(mermaid, dark);
                    const { svg } = await mermaid.render(`cm-mmd-${Math.random().toString(36).slice(2)}`, this.code);
                    if (this.destroyed || mine !== token) {
                        return;
                    }
                    wrap.innerHTML = svg;
                    safeRequestMeasure(view);
                }
                catch {
                    if (this.destroyed || mine !== token) {
                        return;
                    }
                    showSource(true);
                    safeRequestMeasure(view);
                }
            })();
        };
        render(true);
        this.unsub = onThemeRepaint(() => render(false));
        return wrap;
    }
    destroy() {
        this.destroyed = true;
        this.unsub?.();
        this.unsub = null;
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
/** Split a markdown table row into trimmed cell strings ("| a | b |" → ["a","b"]).
 *  An escaped pipe ("\|" — Obsidian's wikilink-alias-in-a-table syntax) is cell
 *  CONTENT, not a cell boundary, so the split only breaks on unescaped pipes. */
function tableCells(line) {
    return line
        .replace(/^\s*\|/, '')
        .replace(/(?<!\\)\|\s*$/, '')
        .split(/(?<!\\)\|/)
        .map(cell => cell.trim());
}
const TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/;
// One alternative per inline construct, tried in this order at each position:
// `code`, [[wikilink]], **strong**, *em*, ~~strike~~, [text](url), $math$. Code comes first so a
// `$` inside inline code isn't read as a math delimiter. Group 9 = the math body (no delimiters).
const INLINE_TOKEN_RE = /`([^`\n]+)`|(?<!!)\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]|\*\*((?:[^*\n]|\*(?!\*))+)\*\*|\*([^*\n]+)\*|~~([^~\n]+)~~|\[([^\]\n]+)\]\(([^)\n]+)\)|\$(?![\s$])((?:[^$\n\\]|\\.)+?)(?<![\s\\])\$(?!\$)/g;
/** Render one table cell's markdown into `parent` — the same inline constructs the
 *  live-preview pass handles in body text (which the table's block widget replaces,
 *  so cells must re-render them here). Recurses so `**bold [[links]]**` nest. */
function appendInlineMarkdown(parent, text, onOpen, isResolved) {
    const styled = (className, inner) => {
        const span = document.createElement('span');
        span.className = className;
        if (inner !== undefined) {
            appendInlineMarkdown(span, inner, onOpen, isResolved);
        }
        parent.appendChild(span);
        return span;
    };
    let last = 0;
    for (const match of text.matchAll(INLINE_TOKEN_RE)) {
        const start = match.index ?? 0;
        if (start > last) {
            parent.appendChild(document.createTextNode(text.slice(last, start)));
        }
        if (match[1] !== undefined) {
            styled('cm-np-code').textContent = match[1];
        }
        else if (match[2] !== undefined) {
            const target = match[2].replace(/\\$/, '').trim();
            const label = (match[3] ?? target).trim() || target;
            const link = styled(isResolved(target) ? 'cm-np-wikilink' : 'cm-np-wikilink cm-np-wikilink-unresolved');
            link.textContent = label;
            link.onmousedown = event => {
                event.preventDefault();
                event.stopPropagation();
                onOpen(target);
            };
        }
        else if (match[4] !== undefined) {
            styled('cm-np-strong', match[4]);
        }
        else if (match[5] !== undefined) {
            styled('cm-np-em', match[5]);
        }
        else if (match[6] !== undefined) {
            styled('cm-np-strike', match[6]);
        }
        else if (match[9] !== undefined) {
            // Inline math in a cell/callout body. Same signal guard as the body pass — bare numbers /
            // currency stay literal — and the same trusted KaTeX render (see MathWidget for why
            // innerHTML is safe here).
            if (MATH_SIGNAL_RE.test(match[9])) {
                const span = styled('cm-np-math cm-np-math-inline');
                try {
                    span.innerHTML = katex.renderToString(match[9], {
                        displayMode: false,
                        errorColor: '#e5484d',
                        strict: 'ignore',
                        throwOnError: false,
                        trust: false
                    });
                }
                catch {
                    span.classList.add('cm-np-math-error');
                    span.textContent = `$${match[9]}$`;
                }
            }
            else {
                parent.appendChild(document.createTextNode(match[0]));
            }
        }
        else {
            const link = styled('cm-np-link');
            link.textContent = match[7];
            link.title = match[8];
        }
        last = start + match[0].length;
    }
    if (last < text.length) {
        parent.appendChild(document.createTextNode(text.slice(last)));
    }
}
class TableWidget extends WidgetType {
    header;
    rows;
    onOpen;
    isResolved;
    constructor(header, rows, onOpen, isResolved) {
        super();
        this.header = header;
        this.rows = rows;
        this.onOpen = onOpen;
        this.isResolved = isResolved;
    }
    eq(other) {
        return JSON.stringify([this.header, this.rows]) === JSON.stringify([other.header, other.rows]);
    }
    fillCell(cell, raw) {
        // The row split kept "\|" escaped; inside the cell it's a plain pipe again
        // (which is how "[[target\|alias]]" becomes a normal aliased wikilink).
        appendInlineMarkdown(cell, raw.replace(/\\\|/g, '|'), this.onOpen, this.isResolved);
    }
    toDOM() {
        const table = document.createElement('table');
        table.className = 'cm-np-table';
        const thead = table.createTHead();
        const hr = thead.insertRow();
        for (const cell of this.header) {
            const th = document.createElement('th');
            this.fillCell(th, cell);
            hr.appendChild(th);
        }
        const tbody = table.createTBody();
        for (const row of this.rows) {
            const tr = tbody.insertRow();
            for (let i = 0; i < this.header.length; i++) {
                this.fillCell(tr.insertCell(), row[i] ?? '');
            }
        }
        return table;
    }
}
/** Obsidian callout → a fold-to-reveal card. The summary (type or title) is always shown;
 *  the body collapses when the header uses `-`. Native <details> owns the open/close so no
 *  CodeMirror state is needed; eq() keeps the same DOM across rebuilds so a user's toggle
 *  survives edits elsewhere in the note. ignoreEvent lets the summary click through to the
 *  browser's own fold rather than the editor. */
class CalloutWidget extends WidgetType {
    type;
    title;
    collapsed;
    body;
    onOpen;
    isResolved;
    constructor(type, title, collapsed, body, onOpen, isResolved) {
        super();
        this.type = type;
        this.title = title;
        this.collapsed = collapsed;
        this.body = body;
        this.onOpen = onOpen;
        this.isResolved = isResolved;
    }
    eq(other) {
        return (this.type === other.type &&
            this.title === other.title &&
            this.collapsed === other.collapsed &&
            this.body.length === other.body.length &&
            this.body.every((line, i) => line === other.body[i]));
    }
    ignoreEvent() {
        return true;
    }
    toDOM() {
        const wrap = document.createElement('div');
        wrap.className = `cm-np-callout cm-np-callout-${this.type}`;
        const details = document.createElement('details');
        details.open = !this.collapsed;
        const summary = document.createElement('summary');
        summary.className = 'cm-np-callout-title';
        summary.textContent = this.title || `${this.type.charAt(0).toUpperCase()}${this.type.slice(1)}`;
        details.appendChild(summary);
        const bodyEl = document.createElement('div');
        bodyEl.className = 'cm-np-callout-body';
        for (const line of this.body) {
            const row = document.createElement('div');
            row.className = 'cm-np-callout-line';
            appendInlineMarkdown(row, line, this.onOpen, this.isResolved);
            bodyEl.appendChild(row);
        }
        details.appendChild(bodyEl);
        wrap.appendChild(details);
        return wrap;
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
/** Obsidian callout blocks: a `> [!type]±? title` header line plus the run of `>` lines
 *  under it. Whole-line ranges so the caller can block-replace them (exported for tests). */
export function findCalloutBlocks(doc) {
    const blocks = [];
    const total = doc.lines;
    for (let n = 1; n <= total; n++) {
        const head = doc.line(n);
        const match = CALLOUT_HEAD_RE.exec(head.text);
        if (!match) {
            continue;
        }
        const body = [];
        let last = n;
        for (let m = n + 1; m <= total; m++) {
            const line = doc.line(m);
            if (!QUOTE_LINE_RE.test(line.text)) {
                break;
            }
            // Strip the leading `>` and one optional space so the body reads as plain markdown.
            body.push(line.text.replace(/^\s*>\s?/, ''));
            last = m;
        }
        blocks.push({
            body,
            collapsed: match[2] === '-',
            from: head.from,
            title: match[3].trim(),
            to: doc.line(last).to,
            type: match[1].toLowerCase()
        });
        n = last;
    }
    return blocks;
}
/** Display-math blocks (`$$ … $$`) — either all on one line (`$$E=mc^2$$`) or the canonical
 *  fenced form (a `$$` line, body lines, a closing `$$`). Whole-line ranges so the caller can
 *  block-replace them (exported for tests). A `$$` inside a ``` code fence is skipped. */
export function findMathBlocks(doc) {
    const blocks = [];
    const total = doc.lines;
    let inFence = false;
    let n = 1;
    while (n <= total) {
        const line = doc.line(n);
        const trimmed = line.text.trim();
        if (CODE_FENCE_RE.test(line.text)) {
            inFence = !inFence;
            n++;
            continue;
        }
        if (inFence || !trimmed.startsWith('$$')) {
            n++;
            continue;
        }
        const afterOpen = trimmed.slice(2);
        // Single line: "$$ … $$" with a real closing "$$" after the opener.
        if (afterOpen.trimEnd().length > 2 && afterOpen.trimEnd().endsWith('$$')) {
            const tex = afterOpen.trimEnd().slice(0, -2).trim();
            if (tex) {
                blocks.push({ from: line.from, tex, to: line.to });
            }
            n++;
            continue;
        }
        // Multi-line: opener line (usually a bare "$$"), body lines, then a line ending in "$$".
        const texLines = afterOpen.trim() ? [afterOpen.trim()] : [];
        let last = n;
        let closed = false;
        for (let m = n + 1; m <= total; m++) {
            const body = doc.line(m).text;
            if (body.trim().endsWith('$$')) {
                const inner = body.trim().slice(0, -2);
                if (inner.trim()) {
                    texLines.push(inner);
                }
                last = m;
                closed = true;
                break;
            }
            texLines.push(body);
        }
        if (closed) {
            const tex = texLines.join('\n').trim();
            if (tex) {
                blocks.push({ from: line.from, tex, to: doc.line(last).to });
            }
            n = last + 1;
            continue;
        }
        n++;
    }
    return blocks;
}
/** ```mermaid fenced blocks — the fence line, body (the diagram source), and closing fence.
 *  Whole-line ranges so the caller can block-replace them (exported for tests). */
export function findMermaidBlocks(doc) {
    const blocks = [];
    const total = doc.lines;
    let n = 1;
    while (n <= total) {
        const open = MERMAID_FENCE_RE.exec(doc.line(n).text);
        if (!open) {
            n++;
            continue;
        }
        const closeRe = open[1][0] === '`' ? /^\s*`{3,}\s*$/ : /^\s*~{3,}\s*$/;
        const codeLines = [];
        let last = n;
        let closed = false;
        for (let m = n + 1; m <= total; m++) {
            const bodyLine = doc.line(m).text;
            if (closeRe.test(bodyLine)) {
                last = m;
                closed = true;
                break;
            }
            codeLines.push(bodyLine);
        }
        if (closed) {
            const code = codeLines.join('\n').trim();
            if (code) {
                blocks.push({ code, from: doc.line(n).from, to: doc.line(last).to });
            }
            n = last + 1;
        }
        else {
            n++;
        }
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
    const mathInline = [];
    for (const { from, to } of view.visibleRanges) {
        const text = doc.sliceString(from, to);
        // Ranges an inline `$…$` must NOT fire inside: code (a `$` in `inline code`/a ``` fence is
        // literal — think `if [ "$a" = "$b" ]`), plus wikilinks and images whose alias/label holds a
        // formula (`[[ACE|$K_i$]]`, `![$x$](d.png)`). Each of those emits its OWN replace over the whole
        // construct; a math replace nested inside would be a second, overlapping replace and crash CM.
        // Collected across the tree pass + regex scans below; the math scan runs LAST so all are known.
        const protectedRanges = [];
        const insideProtected = (pos) => protectedRanges.some(range => pos >= range.from && pos < range.to);
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
                    protectedRanges.push({ from: node.from, to: node.to });
                    decorations.push(Decoration.mark({ class: 'cm-np-code' }).range(node.from, node.to));
                    return;
                }
                if (type === 'FencedCode') {
                    protectedRanges.push({ from: node.from, to: node.to });
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
                    protectedRanges.push({ from: node.from, to: node.to });
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
        for (const match of text.matchAll(WIKILINK_RE)) {
            const start = from + (match.index ?? 0);
            const end = start + match[0].length;
            protectedRanges.push({ from: start, to: end });
            // A "\|"-escaped alias pipe (table syntax) leaves a trailing backslash on the
            // captured target — strip it so the link resolves to the real note.
            const target = match[1].replace(/\\$/, '').trim();
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
            protectedRanges.push({ from: start, to: end });
            if (!name || selectionTouches(start, end)) {
                continue;
            }
            const src = resolveEmbeddedImageSrc(name, image.files);
            if (src) {
                decorations.push(Decoration.replace({ widget: new ImageWidget(src, name) }).range(start, end));
            }
        }
        // Inline math (`$…$`) — LAST, so every protected range (code, wikilinks, images) is known.
        // Skipped inside those (their replace would collide) and inside `code`; bare numbers/currency
        // fail the signal check. Widgets are appended (and colliding markdown decos dropped) after the
        // loop; see below.
        for (const match of text.matchAll(INLINE_MATH_RE)) {
            const start = from + (match.index ?? 0);
            const end = start + match[0].length;
            if (insideProtected(start) || !MATH_SIGNAL_RE.test(match[1]) || selectionTouches(start, end)) {
                continue;
            }
            mathInline.push({ from: start, tex: match[1], to: end });
        }
    }
    // Tables AND callouts render via separate StateFields (below) — CodeMirror forbids
    // block-replace-across-lines decorations from a ViewPlugin. Here we only DROP the
    // inline/line decorations that fall inside a rendered block so they don't collide
    // with the StateField's block widget (e.g. the per-line quote styling on callout lines).
    const renderedBlocks = [
        ...findTableBlocks(doc),
        ...findCalloutBlocks(doc),
        ...findMathBlocks(doc),
        ...findMermaidBlocks(doc)
    ].filter(block => !selectionTouches(block.from, block.to));
    const inRendered = (pos) => renderedBlocks.some(block => pos >= block.from && pos <= block.to);
    const insideMath = (pos) => mathInline.some(math => pos >= math.from && pos < math.to);
    // Drop any block-covered decoration AND any markdown deco that fell inside an inline-math span
    // (e.g. lezer parsing `x_1` as emphasis) — the latter would otherwise be a second decoration
    // overlapping the math widget's replace and crash CodeMirror at set construction.
    const kept = decorations.filter(range => !inRendered(range.from) && !insideMath(range.from));
    for (const math of mathInline) {
        if (!inRendered(math.from)) {
            kept.push(Decoration.replace({ widget: new MathWidget(math.tex, false) }).range(math.from, math.to));
        }
    }
    return Decoration.set(kept, true);
}
/** Table block-replace decorations. In a StateField (not the ViewPlugin) because
 *  CodeMirror only allows line-break-replacing block decorations from state, not
 *  plugins. Recomputes on doc + selection changes so the raw markdown reappears
 *  when the caret enters the table. A function (not a bare field) because the
 *  cell renderer needs the same wikilink open/resolve callbacks livePreview gets. */
export function tableExtension(onOpen, isResolved) {
    const build = (state) => buildTableDecorations(state, onOpen, isResolved);
    return StateField.define({
        create: build,
        provide: field => EditorView.decorations.from(field),
        update(value, tr) {
            return tr.docChanged || tr.selection ? build(tr.state) : value;
        }
    });
}
function buildTableDecorations(state, onOpen, isResolved) {
    const doc = state.doc;
    const ranges = [];
    for (const block of findTableBlocks(doc)) {
        const touched = state.selection.ranges.some(r => r.to >= block.from && r.from <= block.to);
        if (!touched) {
            ranges.push(Decoration.replace({ block: true, widget: new TableWidget(block.header, block.rows, onOpen, isResolved) }).range(block.from, block.to));
        }
    }
    return Decoration.set(ranges, true);
}
/** Callout block-replace decorations. Same StateField requirement as tables (block
 *  decorations across line breaks can't come from a ViewPlugin). The caret entering the
 *  callout reverts it to raw `> [!type]` markdown for editing. */
export function calloutExtension(onOpen, isResolved) {
    const build = (state) => buildCalloutDecorations(state, onOpen, isResolved);
    return StateField.define({
        create: build,
        provide: field => EditorView.decorations.from(field),
        update(value, tr) {
            return tr.docChanged || tr.selection ? build(tr.state) : value;
        }
    });
}
function buildCalloutDecorations(state, onOpen, isResolved) {
    const doc = state.doc;
    const ranges = [];
    for (const block of findCalloutBlocks(doc)) {
        const touched = state.selection.ranges.some(r => r.to >= block.from && r.from <= block.to);
        if (!touched) {
            ranges.push(Decoration.replace({
                block: true,
                widget: new CalloutWidget(block.type, block.title, block.collapsed, block.body, onOpen, isResolved)
            }).range(block.from, block.to));
        }
    }
    return Decoration.set(ranges, true);
}
/** Display-math (`$$ … $$`) block-replace decorations. Same StateField requirement as tables
 *  and callouts (block decorations across line breaks can't come from a ViewPlugin). The caret
 *  entering the block reverts it to raw `$$` markdown for editing; no link callbacks needed. */
export function mathBlockExtension() {
    return StateField.define({
        create: buildMathBlockDecorations,
        provide: field => EditorView.decorations.from(field),
        update(value, tr) {
            return tr.docChanged || tr.selection ? buildMathBlockDecorations(tr.state) : value;
        }
    });
}
function buildMathBlockDecorations(state) {
    const doc = state.doc;
    const ranges = [];
    for (const block of findMathBlocks(doc)) {
        const touched = state.selection.ranges.some(r => r.to >= block.from && r.from <= block.to);
        if (!touched) {
            ranges.push(Decoration.replace({ block: true, widget: new MathWidget(block.tex, true) }).range(block.from, block.to));
        }
    }
    return Decoration.set(ranges, true);
}
/** ```mermaid diagram block-replace decorations. Same StateField requirement as tables/callouts/
 *  math (block decorations across line breaks can't come from a ViewPlugin). The caret entering
 *  the block reverts it to the raw ```mermaid source for editing. */
export function mermaidExtension() {
    return StateField.define({
        create: buildMermaidDecorations,
        provide: field => EditorView.decorations.from(field),
        update(value, tr) {
            return tr.docChanged || tr.selection ? buildMermaidDecorations(tr.state) : value;
        }
    });
}
function buildMermaidDecorations(state) {
    const doc = state.doc;
    const ranges = [];
    for (const block of findMermaidBlocks(doc)) {
        const touched = state.selection.ranges.some(r => r.to >= block.from && r.from <= block.to);
        if (!touched) {
            ranges.push(Decoration.replace({ block: true, widget: new MermaidWidget(block.code) }).range(block.from, block.to));
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
    '.cm-np-callout': {
        backgroundColor: 'color-mix(in srgb, var(--theme-primary) 5%, var(--ui-bg-quaternary))',
        border: '1px solid var(--ui-stroke-tertiary)',
        borderLeft: '3px solid var(--theme-primary)',
        borderRadius: '8px',
        margin: '0.7em 0',
        overflow: 'hidden'
    },
    '.cm-np-callout summary': {
        color: 'var(--theme-primary)',
        cursor: 'pointer',
        fontWeight: '650',
        letterSpacing: '0.01em',
        listStyle: 'none',
        padding: '0.5em 0.85em',
        userSelect: 'none'
    },
    '.cm-np-callout summary::-webkit-details-marker': { display: 'none' },
    '.cm-np-callout summary::before': {
        content: '"▸"',
        display: 'inline-block',
        fontSize: '0.85em',
        marginRight: '0.55em',
        transition: 'transform 120ms ease'
    },
    '.cm-np-callout details[open] summary::before': { transform: 'rotate(90deg)' },
    '.cm-np-callout-body': {
        borderTop: '1px solid var(--ui-stroke-quaternary)',
        color: 'var(--ui-text-secondary)',
        padding: '0.55em 0.85em 0.7em'
    },
    '.cm-np-callout-line': { minHeight: '1.2em' },
    '.cm-np-math-inline': { padding: '0 0.1em' },
    '.cm-np-math-display': {
        display: 'block',
        margin: '0.7em 0',
        overflowX: 'auto',
        overflowY: 'hidden',
        textAlign: 'center'
    },
    '.cm-np-math-error': {
        color: 'var(--ui-text-tertiary)',
        fontFamily: 'var(--dt-font-mono, ui-monospace, monospace)',
        fontSize: '0.9em'
    },
    '.cm-np-mermaid': {
        display: 'flex',
        justifyContent: 'center',
        margin: '0.7em 0',
        overflowX: 'auto'
    },
    '.cm-np-mermaid svg': { height: 'auto', maxWidth: '100%' },
    '.cm-np-mermaid-src': {
        color: 'var(--ui-text-tertiary)',
        fontFamily: 'var(--dt-font-mono, ui-monospace, monospace)',
        fontSize: '0.85em',
        margin: '0',
        padding: '0.4em 0.6em',
        whiteSpace: 'pre-wrap'
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
