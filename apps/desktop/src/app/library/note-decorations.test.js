// Pure-logic coverage for the task checkbox toggle, plus one full EditorView smoke test
// covering every new decoration (task checkboxes, strikethrough, fenced code, resolved +
// unresolved wikilinks, inline images) mounted together — the only automated net against
// decoration ranges that overlap and crash CodeMirror at construction time (a mistake tsc
// and the pure-function tests below can't see).
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { calloutExtension, findCalloutBlocks, findMathBlocks, isTaskChecked, livePreview, mathBlockExtension, noteMarkdown, noteTheme, tableExtension, toggleTaskChar } from './note-decorations';
describe('isTaskChecked', () => {
    it('is true for "[x]" and "[X]"', () => {
        expect(isTaskChecked('[x]')).toBe(true);
        expect(isTaskChecked('[X]')).toBe(true);
    });
    it('is false for an empty box', () => {
        expect(isTaskChecked('[ ]')).toBe(false);
    });
});
describe('toggleTaskChar', () => {
    it('flips a checked box to a space', () => {
        expect(toggleTaskChar('x')).toBe(' ');
        expect(toggleTaskChar('X')).toBe(' ');
    });
    it('flips an empty box to "x"', () => {
        expect(toggleTaskChar(' ')).toBe('x');
    });
});
describe('note editor extensions mounted together (smoke test)', () => {
    const doc = [
        '# Heading',
        '',
        '- [ ] todo item',
        '- [x] done item',
        '',
        '~~gone~~ still here',
        '',
        '```js',
        'const x = 1',
        '```',
        '',
        'See [[Real Note]] and [[Missing Note]].',
        '',
        '![a diagram](diagram.png)',
        '',
        '![[cover.jpg]]',
        '',
        '![[missing-embed.png]]',
        '',
        '| Drug | Class |',
        '|------|-------|',
        '| **Lisinopril** | [[Pharmacology/ACE inhibitors\\|ACE inhibitors]] |',
        '',
        '> [!solution]- Worked answer',
        '> Step 1: **isolate** x',
        '> Step 2: see [[Real Note]]',
        '> Step 3: so $x = 3$',
        '',
        // Adversarial math: underscore pairs (`_1 + y_`, `_i + b_`) that markdown mis-parses as
        // emphasis, one nested inside **bold** — exactly the ranges that would collide with the math
        // widget's replace and crash CM at construction. Both are valid LaTeX so KaTeX renders them.
        'Inline $x_1 + y_2 = z$ and **bold $a_i + b_j$ end**.',
        '',
        // Currency + a bare number: valid delimiters but no math signal, so both stay literal text.
        'Currency $5 and $10 and $5$ stay literal.',
        '',
        // Enclosing case: a wikilink whose alias holds a formula. The link emits a replace over the
        // whole [[…]] (start OUTSIDE the $…$); math must be suppressed inside it or the two replaces
        // overlap and crash CM at construction. (Images use the same protected-range guard.)
        'Alias math: [[Pharmacology|$K_a$]] and bare [[$x$ notes]].',
        '',
        // A "$" inside a code fence must NOT render as math (code wins).
        '```bash',
        'if [ "$a" = "$b" ]; then echo $x; fi',
        '```',
        '',
        '$$',
        '\\int_0^1 x^2 \\, dx',
        '$$',
        ''
    ].join('\n');
    const IMAGE_CONTEXT = {
        files: [{ name: 'cover.jpg', path: '/vault/Notes/cover.jpg' }],
        noteFolder: 'Notes',
        vaultDir: '/vault'
    };
    function mount(isResolved, imageContext = IMAGE_CONTEXT, onOpen = () => { }) {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const view = new EditorView({
            parent: host,
            state: EditorState.create({
                doc,
                extensions: [
                    noteMarkdown,
                    tableExtension(onOpen, isResolved),
                    calloutExtension(onOpen, isResolved),
                    mathBlockExtension(),
                    livePreview(onOpen, isResolved, () => imageContext),
                    noteTheme
                ]
            })
        });
        return { host, view };
    }
    it('constructs without throwing and renders one checkbox per task line', () => {
        const { view } = mount(target => target === 'Real Note');
        const boxes = view.dom.querySelectorAll('.cm-np-checkbox');
        expect(boxes.length).toBe(2);
        expect(boxes[0].checked).toBe(false);
        expect(boxes[1].checked).toBe(true);
        view.destroy();
    });
    it('does not render a bullet dot on task list lines', () => {
        const { view } = mount(() => false);
        expect(view.dom.querySelector('.cm-np-bullet')).toBeNull();
        view.destroy();
    });
    it('renders the strikethrough run with its markers hidden while unfocused', () => {
        const { view } = mount(() => false);
        const struck = view.dom.querySelector('.cm-np-strike');
        expect(struck).not.toBeNull();
        expect(struck?.textContent).toBe('gone');
        view.destroy();
    });
    it('applies the code-block line class to every line inside the fence', () => {
        const { view } = mount(() => false);
        const codeLines = view.dom.querySelectorAll('.cm-np-codeblock');
        // Two fences of three lines each: the ```js block and the ```bash math-guard block.
        expect(codeLines.length).toBe(6);
        view.destroy();
    });
    it('styles a resolving wikilink differently from an unresolved one', () => {
        const { view } = mount(target => target === 'Real Note');
        const resolved = [...view.dom.querySelectorAll('.cm-np-wikilink')].find(el => el.textContent === 'Real Note');
        const unresolved = view.dom.querySelector('.cm-np-wikilink-unresolved');
        expect(resolved).toBeDefined();
        expect(resolved?.classList.contains('cm-np-wikilink-unresolved')).toBe(false);
        expect(unresolved?.textContent).toBe('Missing Note');
        view.destroy();
    });
    it('toggles the checkbox character in the document when clicked', () => {
        const { view } = mount(() => false);
        const box = view.dom.querySelector('.cm-np-checkbox');
        expect(box).not.toBeNull();
        box?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        expect(view.state.doc.toString()).toContain('- [x] todo item');
        view.destroy();
    });
    it('renders a standard "![alt](path)" image resolved against the note folder', () => {
        const { view } = mount(() => false);
        const images = [...view.dom.querySelectorAll('.cm-np-image')];
        const standard = images.find(img => img.alt === 'a diagram');
        expect(standard?.src).toBe('file:///vault/Notes/diagram.png');
        view.destroy();
    });
    it('renders a resolvable "![[name]]" embed found in the vault file list', () => {
        const { view } = mount(() => false);
        const images = [...view.dom.querySelectorAll('.cm-np-image')];
        const embed = images.find(img => img.src === 'file:///vault/Notes/cover.jpg');
        expect(embed).toBeDefined();
        view.destroy();
    });
    it('leaves an unresolvable "![[name]]" embed as plain text instead of a broken image', () => {
        const { view } = mount(() => false);
        expect(view.dom.textContent).toContain('missing-embed.png');
        const images = [...view.dom.querySelectorAll('.cm-np-image')];
        expect(images.some(img => img.alt === 'missing-embed.png' || img.src.includes('missing-embed'))).toBe(false);
        view.destroy();
    });
    it('renders exactly two images (one path-based, one embed) when one embed is unresolvable', () => {
        const { view } = mount(() => false);
        expect(view.dom.querySelectorAll('.cm-np-image').length).toBe(2);
        view.destroy();
    });
    it('renders inline markdown inside table cells instead of raw marks', () => {
        const { view } = mount(target => target === 'Pharmacology/ACE inhibitors');
        const table = view.dom.querySelector('.cm-np-table');
        expect(table).not.toBeNull();
        const strong = table?.querySelector('.cm-np-strong');
        expect(strong?.textContent).toBe('Lisinopril');
        expect(table?.textContent).not.toContain('**');
        view.destroy();
    });
    it('renders an escaped-pipe wikilink in a table cell as a resolved aliased link', () => {
        const { view } = mount(target => target === 'Pharmacology/ACE inhibitors');
        const link = view.dom.querySelector('.cm-np-table .cm-np-wikilink');
        expect(link?.textContent).toBe('ACE inhibitors');
        expect(link?.classList.contains('cm-np-wikilink-unresolved')).toBe(false);
        expect(view.dom.querySelector('.cm-np-table')?.textContent).not.toContain('\\');
        view.destroy();
    });
    it('opens the real target (no trailing backslash) when a table wikilink is clicked', () => {
        const opened = [];
        const { view } = mount(() => true, IMAGE_CONTEXT, target => opened.push(target));
        const link = view.dom.querySelector('.cm-np-table .cm-np-wikilink');
        link?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        expect(opened).toEqual(['Pharmacology/ACE inhibitors']);
        view.destroy();
    });
    it('renders a "[!solution]-" callout as a collapsed fold-to-reveal card', () => {
        const { view } = mount(target => target === 'Real Note');
        const callout = view.dom.querySelector('.cm-np-callout');
        expect(callout).not.toBeNull();
        const details = callout?.querySelector('details');
        // The "-" fold char means the solution starts hidden (attempt-first).
        expect(details?.open).toBe(false);
        expect(callout?.querySelector('summary')?.textContent).toBe('Worked answer');
        // Body markdown renders (bold melts, wikilink becomes a link) even while collapsed.
        expect(callout?.querySelector('.cm-np-strong')?.textContent).toBe('isolate');
        expect(callout?.querySelector('.cm-np-wikilink')?.textContent).toBe('Real Note');
        expect(callout?.textContent).not.toContain('[!solution]');
        // Inline math inside the callout body renders as KaTeX (worked-solution equations).
        expect(callout?.querySelector('.cm-np-math-inline .katex')).not.toBeNull();
        expect(callout?.textContent).not.toContain('$x = 3$');
        view.destroy();
    });
    it('renders inline "$…$" as KaTeX (underscores and bold-nested math do not crash the mount)', () => {
        const { view } = mount(target => target === 'Real Note');
        // Two real inline equations in the body: "x_1 + y_2 = z" and the one nested inside **bold**
        // (the callout body has its own inline math, asserted separately, so exclude it here).
        const inline = [...view.dom.querySelectorAll('.cm-np-math-inline')].filter(el => !el.closest('.cm-np-callout'));
        expect(inline.length).toBe(2);
        expect(inline.every(el => el.querySelector('.katex') !== null)).toBe(true);
        view.destroy();
    });
    it('renders a "$$…$$" block as a centered KaTeX display', () => {
        const { view } = mount(() => false);
        const display = view.dom.querySelector('.cm-np-math-display');
        expect(display).not.toBeNull();
        expect(display?.querySelector('.katex')).not.toBeNull();
        view.destroy();
    });
    it('leaves currency and bare numbers as plain text, not math', () => {
        const { view } = mount(() => false);
        // "$5 and $10" (space before the closing $) and "$5$" (no math signal) stay literal.
        expect(view.dom.textContent).toContain('$5 and $10 and $5$');
        view.destroy();
    });
    it('does not render a "$" inside a fenced code block as math', () => {
        const { view } = mount(() => false);
        const codeText = [...view.dom.querySelectorAll('.cm-np-codeblock')].map(el => el.textContent).join('\n');
        expect(codeText).toContain('"$a" = "$b"');
        // No inline-math widget swallowed part of the shell line.
        const maths = [...view.dom.querySelectorAll('.cm-np-math')];
        expect(maths.every(el => !(el.textContent ?? '').includes('a" = "'))).toBe(true);
        view.destroy();
    });
    it('does not crash when a wikilink alias contains inline math (enclosing replace)', () => {
        const { view } = mount(target => target === 'Pharmacology');
        // The aliased link renders; the inner "$K_a$" is NOT a separate math widget inside it (which
        // would overlap the link's replace and crash CM). Mounting without throwing is the real check.
        const aliased = [...view.dom.querySelectorAll('.cm-np-wikilink')].find(el => (el.textContent ?? '').includes('K_a'));
        expect(aliased).toBeDefined();
        expect(view.dom.querySelector('.cm-np-wikilink .cm-np-math-inline')).toBeNull();
        view.destroy();
    });
});
describe('findMathBlocks', () => {
    const docOf = (text) => EditorState.create({ doc: text, extensions: [noteMarkdown] }).doc;
    it('parses a single-line "$$…$$" block', () => {
        const blocks = findMathBlocks(docOf('text\n$$E = mc^2$$\nmore'));
        expect(blocks).toHaveLength(1);
        expect(blocks[0].tex).toBe('E = mc^2');
    });
    it('parses the canonical multi-line fenced form', () => {
        const blocks = findMathBlocks(docOf(['$$', '\\int_0^1 x^2 \\, dx', '$$'].join('\n')));
        expect(blocks).toHaveLength(1);
        expect(blocks[0].tex).toBe('\\int_0^1 x^2 \\, dx');
    });
    it('ignores an unclosed "$$" opener', () => {
        expect(findMathBlocks(docOf('$$\nx^2\nno close'))).toHaveLength(0);
    });
    it('does not treat "$$" inside a code fence as a math block', () => {
        expect(findMathBlocks(docOf(['```', '$$', 'x^2', '$$', '```'].join('\n')))).toHaveLength(0);
    });
});
describe('findCalloutBlocks', () => {
    const docOf = (text) => EditorState.create({ doc: text, extensions: [noteMarkdown] }).doc;
    it('parses a collapsed callout with a title and strips the quote markers from the body', () => {
        const blocks = findCalloutBlocks(docOf(['> [!solution]- Steps', '> line one', '> line two', '', 'after'].join('\n')));
        expect(blocks).toHaveLength(1);
        expect(blocks[0].type).toBe('solution');
        expect(blocks[0].collapsed).toBe(true);
        expect(blocks[0].title).toBe('Steps');
        expect(blocks[0].body).toEqual(['line one', 'line two']);
    });
    it('treats a bare "[!type]" (no fold char) and "+" as expanded', () => {
        const bare = findCalloutBlocks(docOf('> [!note] Heads up\n> body'));
        const plus = findCalloutBlocks(docOf('> [!tip]+ Pro tip\n> body'));
        expect(bare[0].collapsed).toBe(false);
        expect(plus[0].collapsed).toBe(false);
    });
    it('ignores a plain blockquote that is not a callout', () => {
        expect(findCalloutBlocks(docOf('> just a quote\n> more quote'))).toHaveLength(0);
    });
});
