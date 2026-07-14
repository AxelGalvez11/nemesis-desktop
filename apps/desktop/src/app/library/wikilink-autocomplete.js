// [[ autocomplete for the note editor: typing `[[` opens a CodeMirror completion popup
// listing vault note titles, and accepting one inserts `[[Title]]` (or, if the user already
// has a `|alias` or a closing `]]` after the cursor, just the title — so we don't clobber
// what they've already typed). Scoped entirely by the source function returning `null`
// outside an open, unclosed `[[` — see wikilinkCompletionSource — so normal typing anywhere
// else in the document is never intercepted.
import { EditorSelection } from '@codemirror/state';
/** Matches an unclosed "[[" run up to the cursor, on the current line, stopping at the
 *  first "]" or "|" (so a query is only offered while inside the bare-title segment of a
 *  wikilink — not once an alias or the closing brackets have been typed). */
export const WIKILINK_QUERY_RE = /\[\[[^\]|]*$/;
/** Decide what to insert for a chosen title, given the text immediately after the cursor.
 *  If the wikilink is already closed (or an alias segment follows), only the title is
 *  inserted so the existing `]]` / `|alias]]` tail is left untouched; otherwise the closing
 *  brackets are appended so the link is complete after accepting. */
export function wikilinkApplyText(title, textAfterCursor) {
    const alreadyClosed = textAfterCursor.startsWith(']]') || textAfterCursor.startsWith('|');
    return alreadyClosed ? title : `${title}]]`;
}
function applyWikilink(view, completion, from, to) {
    const after = view.state.sliceDoc(to, to + 2);
    const insert = wikilinkApplyText(completion.label, after);
    view.dispatch({
        changes: { from, insert, to },
        selection: EditorSelection.cursor(from + insert.length),
        userEvent: 'input.complete'
    });
}
/** Build the options list for one query. Exported for direct testing; the source function
 *  below always passes the full target list — CodeMirror's own fuzzy matcher (not us) does
 *  the prefix-biased filtering against `label` as the user keeps typing. */
export function wikilinkOptions(targets) {
    return targets
        .slice()
        .sort((a, b) => a.title.localeCompare(b.title))
        .map(target => ({ apply: applyWikilink, detail: target.folder || undefined, label: target.title }));
}
/** CompletionSource factory (declared with this narrower, synchronous signature — rather
 *  than @codemirror/autocomplete's own `CompletionSource`, which also allows a Promise —
 *  because this source never needs to be async and the concrete return type is what makes
 *  it directly testable without unwrapping a union). Still assignable anywhere a
 *  `CompletionSource` is expected. `getTargets` is called lazily on every keystroke so the
 *  popup always reflects the current vault without rebuilding the editor's extensions. */
export function wikilinkCompletionSource(getTargets) {
    return (context) => {
        const match = context.matchBefore(WIKILINK_QUERY_RE);
        if (!match) {
            return null;
        }
        const options = wikilinkOptions(getTargets());
        if (!options.length) {
            return null;
        }
        return { from: match.from + 2, options };
    };
}
