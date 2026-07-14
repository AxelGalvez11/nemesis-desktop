import { CompletionContext } from '@codemirror/autocomplete';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { wikilinkApplyText, wikilinkCompletionSource, wikilinkOptions } from './wikilink-autocomplete';
const TARGETS = [
    { folder: '', title: 'Zebra' },
    { folder: 'Cardio', title: 'ACE inhibitors' },
    { folder: '', title: 'ARBs' }
];
function state(doc) {
    return EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
}
// CompletionContext's constructor is public specifically for testing sources headlessly —
// no EditorView needed (see @codemirror/autocomplete's own doc comment on the constructor).
function contextAt(doc, pos, explicit = false) {
    return new CompletionContext(state(doc), pos, explicit);
}
describe('wikilinkOptions', () => {
    it('sorts targets by title and carries the folder as detail', () => {
        const options = wikilinkOptions(TARGETS);
        expect(options.map(o => o.label)).toEqual(['ACE inhibitors', 'ARBs', 'Zebra']);
        expect(options.find(o => o.label === 'ACE inhibitors')?.detail).toBe('Cardio');
        expect(options.find(o => o.label === 'Zebra')?.detail).toBeUndefined();
    });
});
describe('wikilinkApplyText', () => {
    it('appends closing brackets when nothing follows the cursor', () => {
        expect(wikilinkApplyText('ARBs', '')).toBe('ARBs]]');
    });
    it('appends closing brackets when the cursor is mid-paragraph, not inside a link', () => {
        expect(wikilinkApplyText('ARBs', ' rest of the sentence')).toBe('ARBs]]');
    });
    it('omits the brackets when the link is already closed', () => {
        expect(wikilinkApplyText('ARBs', ']] and more')).toBe('ARBs');
    });
    it('omits the brackets when an alias segment follows', () => {
        expect(wikilinkApplyText('ARBs', '|my alias]]')).toBe('ARBs');
    });
});
describe('wikilinkCompletionSource', () => {
    const source = wikilinkCompletionSource(() => TARGETS);
    it('returns null with no "[[" before the cursor', () => {
        expect(source(contextAt('hello world', 5))).toBeNull();
    });
    it('returns null once the link is already closed', () => {
        const doc = '[[ARBs]] more text';
        expect(source(contextAt(doc, doc.length))).toBeNull();
    });
    it('offers every target right after typing "[["', () => {
        const doc = 'See [[';
        const result = source(contextAt(doc, doc.length));
        expect(result).not.toBeNull();
        expect(result?.from).toBe(doc.length);
        expect(result?.options.map(o => o.label)).toEqual(['ACE inhibitors', 'ARBs', 'Zebra']);
    });
    it('keeps offering options while a partial title is typed, anchored after "[["', () => {
        const doc = '[[AR';
        const result = source(contextAt(doc, doc.length));
        expect(result?.from).toBe(2);
        expect(result?.options.length).toBe(3);
    });
    it('still triggers when editing the title of an already-aliased link', () => {
        // Cursor sits right after "Ti", before the existing "|alias]]" tail.
        const doc = '[[Ti|alias]]';
        const cursor = 4;
        const result = source(contextAt(doc, cursor));
        expect(result).not.toBeNull();
        expect(result?.from).toBe(2);
    });
});
describe('wikilink completion apply (end-to-end dispatch)', () => {
    function mountView(doc, pos) {
        const host = document.createElement('div');
        document.body.appendChild(host);
        return new EditorView({ parent: host, state: EditorState.create({ doc, selection: { anchor: pos } }) });
    }
    // wikilinkOptions always sets `apply` to our function, never a string — this just gives
    // the test a properly typed call site instead of asserting that on every call.
    function applyCompletion(completion, view, from, to) {
        if (typeof completion.apply === 'function') {
            completion.apply(view, completion, from, to);
        }
    }
    it('inserts the closing brackets and places the cursor after them', () => {
        const doc = 'See [[AR';
        const view = mountView(doc, doc.length);
        const [completion] = wikilinkOptions([{ folder: '', title: 'ARBs' }]);
        applyCompletion(completion, view, 6, doc.length);
        expect(view.state.doc.toString()).toBe('See [[ARBs]]');
        expect(view.state.selection.main.from).toBe('See [[ARBs]]'.length);
        view.destroy();
    });
    it('preserves an existing alias tail instead of duplicating the closing brackets', () => {
        const doc = '[[Ti|my alias]]';
        const view = mountView(doc, 4);
        const [completion] = wikilinkOptions([{ folder: '', title: 'Title' }]);
        applyCompletion(completion, view, 2, 4);
        expect(view.state.doc.toString()).toBe('[[Title|my alias]]');
        view.destroy();
    });
});
