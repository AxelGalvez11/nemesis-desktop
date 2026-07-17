// Global note search — filename match is instant (title contains the query), full-text
// match scans each note's already-in-memory content (loadVaultContents reads every note's
// text upfront, so this needs no extra I/O) and surfaces the first matching line as a
// snippet. Pure and synchronous: the caller (index.tsx) debounces re-running it, not this.
import { extractTags } from './vault';
/** The first line of `content` containing `query` (case-insensitive), trimmed — or null. */
function firstMatchingLine(content, query) {
    for (const line of content.split('\n')) {
        if (line.toLowerCase().includes(query)) {
            return line.trim();
        }
    }
    return null;
}
/** Search notes by title first, then by body text — case-insensitive substring match.
 *  One operator: a query starting with "#" filters by tag ("#cardio" matches notes tagged
 *  cardio or cardio/anything — see vault.ts's extractTags). Title matches rank first (then
 *  alphabetically); a note matching only in its body follows, also alphabetical. A blank
 *  query returns no results (the caller falls back to the normal folder tree). */
export function searchNotes(notes, rawQuery) {
    const query = rawQuery.trim().toLowerCase();
    if (!query) {
        return [];
    }
    if (query.startsWith('#') && query.length > 1) {
        const wanted = query.slice(1);
        return notes
            .filter(note => extractTags(note.content).some(tag => {
            const lower = tag.toLowerCase();
            return lower === wanted || lower.startsWith(`${wanted}/`) || lower.startsWith(wanted);
        }))
            .map(note => ({ note, snippet: firstMatchingLine(note.content, wanted) }))
            .sort((a, b) => a.note.title.localeCompare(b.note.title));
    }
    const titleHits = [];
    const bodyHits = [];
    for (const note of notes) {
        const snippet = firstMatchingLine(note.content, query);
        if (note.title.toLowerCase().includes(query)) {
            titleHits.push({ note, snippet });
        }
        else if (snippet !== null) {
            bodyHits.push({ note, snippet });
        }
    }
    const byTitle = (a, b) => a.note.title.localeCompare(b.note.title);
    return [...titleHits.sort(byTitle), ...bodyHits.sort(byTitle)];
}
