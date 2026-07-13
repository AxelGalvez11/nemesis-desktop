// Markdown formatting commands for the note editor — Cmd+B / Cmd+I and the slim
// toolbar both land here. Toggles are syntax-tree-aware, not string-guessing: bold
// looks for an enclosing StrongEmphasis node (so it unwraps `__x__` as happily as
// `**x**`), italic for Emphasis, and toggling italic inside bold correctly stacks to
// `***x***` instead of eating a star. The spec builders are pure EditorState → spec
// functions so they unit-test headlessly; the exported Commands are thin dispatchers.
import { syntaxTree } from '@codemirror/language';
import { EditorSelection } from '@codemirror/state';
const NODE_FOR_MARK = { '*': 'Emphasis', '**': 'StrongEmphasis' };
/** The Emphasis/StrongEmphasis node fully containing [from, to], if any. */
function enclosingEmphasis(state, from, to, nodeName) {
    let node = syntaxTree(state).resolveInner(from, from === to ? 0 : 1);
    while (node) {
        if (node.name === nodeName && node.from <= from && node.to >= to) {
            return node;
        }
        node = node.parent;
    }
    return null;
}
export function inlineToggleSpec(state, mark) {
    return state.changeByRange(range => {
        const wrapped = enclosingEmphasis(state, range.from, range.to, NODE_FOR_MARK[mark]);
        const emphasisMarks = wrapped?.getChildren('EmphasisMark') ?? [];
        if (wrapped && emphasisMarks.length >= 2) {
            // Unwrap: delete the opening and closing marker runs, keep the selection on
            // the same text by shifting positions past each deleted region.
            const open = emphasisMarks[0];
            const close = emphasisMarks[emphasisMarks.length - 1];
            const mapPos = (pos) => pos -
                Math.min(Math.max(0, pos - open.from), open.to - open.from) -
                Math.min(Math.max(0, pos - close.from), close.to - close.from);
            return {
                changes: [
                    { from: open.from, to: open.to },
                    { from: close.from, to: close.to }
                ],
                range: EditorSelection.range(mapPos(range.anchor), mapPos(range.head))
            };
        }
        let { from, to } = range;
        if (from === to) {
            const word = state.wordAt(from);
            if (word) {
                from = word.from;
                to = word.to;
            }
            else {
                // Nothing to wrap — insert the marker pair and park the caret inside it.
                return {
                    changes: { from, insert: mark + mark },
                    range: EditorSelection.cursor(from + mark.length)
                };
            }
        }
        // Markdown emphasis breaks when the markers hug whitespace — shrink to the text.
        const text = state.sliceDoc(from, to);
        from += text.length - text.trimStart().length;
        to -= text.length - text.trimEnd().length;
        if (from >= to) {
            return { range };
        }
        return {
            changes: [
                { from, insert: mark },
                { from: to, insert: mark }
            ],
            range: EditorSelection.range(from + mark.length, to + mark.length)
        };
    });
}
/** Every line any selection range touches, without duplicates, in document order. */
function selectedLines(state, ranges) {
    const lines = new Map();
    for (const range of ranges) {
        for (let pos = range.from; pos <= range.to;) {
            const line = state.doc.lineAt(pos);
            lines.set(line.from, { from: line.from, text: line.text });
            pos = line.to + 1;
        }
    }
    return [...lines.values()].sort((a, b) => a.from - b.from);
}
const HEADING_RE = /^(#{1,6})\s+/;
const BULLET_RE = /^(\s*)([-*+])\s+/;
/** Cycle each selected line: plain → # → ## → ### → plain. */
export function headingCycleChanges(state) {
    return selectedLines(state, state.selection.ranges).map(line => {
        const match = HEADING_RE.exec(line.text);
        const level = match ? match[1].length : 0;
        const next = level >= 3 ? '' : `${'#'.repeat(level + 1)} `;
        return match ? { from: line.from, insert: next, to: line.from + match[0].length } : { from: line.from, insert: next };
    });
}
/** Bullet all selected lines, or un-bullet them when every non-empty line already is. */
export function bulletToggleChanges(state) {
    const lines = selectedLines(state, state.selection.ranges).filter(line => line.text.trim().length > 0);
    const allBulleted = lines.length > 0 && lines.every(line => BULLET_RE.test(line.text));
    return lines.flatMap((line) => {
        const match = BULLET_RE.exec(line.text);
        if (allBulleted && match) {
            return [{ from: line.from + match[1].length, to: line.from + match[0].length }];
        }
        return match ? [] : [{ from: line.from, insert: '- ' }];
    });
}
function dispatchSpec(view, spec) {
    view.dispatch(spec, { scrollIntoView: true, userEvent: 'input' });
    return true;
}
export const toggleBold = view => dispatchSpec(view, inlineToggleSpec(view.state, '**'));
export const toggleItalic = view => dispatchSpec(view, inlineToggleSpec(view.state, '*'));
export const cycleHeading = view => dispatchSpec(view, { changes: headingCycleChanges(view.state) });
export const toggleBulletList = view => dispatchSpec(view, { changes: bulletToggleChanges(view.state) });
