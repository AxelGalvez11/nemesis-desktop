/** The first line of `content` containing `query` (case-insensitive), trimmed — or null. */
function firstMatchingLine(content, query) {
    for (const line of content.split('\n')) {
        if (line.toLowerCase().includes(query)) {
            return line.trim();
        }
    }
    return null;
}
/** Search notes by title first, then by body text — case-insensitive substring match, no
 *  operators. Title matches rank first (then alphabetically); a note matching only in its
 *  body follows, also alphabetical. A blank query returns no results (the caller falls back
 *  to the normal folder tree). */
export function searchNotes(notes, rawQuery) {
    const query = rawQuery.trim().toLowerCase();
    if (!query) {
        return [];
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
