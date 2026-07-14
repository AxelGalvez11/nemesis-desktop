// Pure-logic coverage for the task checkbox toggle, plus one full EditorView smoke test
// covering every new decoration (task checkboxes, strikethrough, fenced code, resolved +
// unresolved wikilinks, inline images) mounted together — the only automated net against
// decoration ranges that overlap and crash CodeMirror at construction time (a mistake tsc
// and the pure-function tests below can't see).
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { isTaskChecked, livePreview, noteMarkdown, noteTheme, tableField, toggleTaskChar } from './note-decorations';
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
        ''
    ].join('\n');
    const IMAGE_CONTEXT = {
        files: [{ name: 'cover.jpg', path: '/vault/Notes/cover.jpg' }],
        noteFolder: 'Notes',
        vaultDir: '/vault'
    };
    function mount(isResolved, imageContext = IMAGE_CONTEXT) {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const view = new EditorView({
            parent: host,
            state: EditorState.create({
                doc,
                extensions: [noteMarkdown, tableField, livePreview(() => { }, isResolved, () => imageContext), noteTheme]
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
        // ```js / const x = 1 / ``` — three fenced lines.
        expect(codeLines.length).toBe(3);
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
});
