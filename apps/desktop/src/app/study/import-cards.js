// Paste-import parser for the Study page. Quizlet has no public API (2026) and its
// export is copy-paste text, so this accepts exactly what students can get out of it:
// one card per line, term/definition split by TAB (Quizlet's default), " - " (its
// common custom separator), or a comma as the last resort. Also fine for hand-typed
// lists and CSV-ish exports from other tools.
import { hasClozeMarker } from './cloze';
const LINE_SPLIT = /\r?\n/;
export function parseCardPaste(text) {
    const cards = [];
    for (const rawLine of text.split(LINE_SPLIT)) {
        const line = rawLine.trim();
        if (!line) {
            continue;
        }
        if (hasClozeMarker(line)) {
            // Cloze cards are one-sided — the blank IS the answer, so the back is
            // optional. But a TAB still separates the deletion text from a trailing
            // title/context field (the deck format the skill writes: "<cloze>\t<title>").
            // A literal tab never appears inside a {{cN::…}} marker, so splitting on it
            // is safe; comma and " - " are NOT used to split a cloze line because those
            // routinely occur inside the deletion text and would shred it. Without this
            // split the whole line (title included) became the front, so the title
            // rendered right on the cloze prompt (owner-reported: "…[...]<TAB>Title").
            const tab = line.indexOf('\t');
            const back = tab > 0 ? line.slice(tab + 1).trim() : '';
            cards.push(back ? { back, front: line.slice(0, tab).trim() } : { back: '', front: line });
            continue;
        }
        // Cloze-free line: term/definition on tab / " - " / comma (the cloze case
        // returned above, so parsed.front here can never carry a marker).
        const parsed = splitLine(line);
        if (parsed) {
            cards.push(parsed);
        }
    }
    return cards;
}
function splitLine(line) {
    for (const separator of ['\t', ' - ', ',']) {
        const at = line.indexOf(separator);
        if (at > 0 && at < line.length - separator.length) {
            const front = line.slice(0, at).trim();
            const back = line.slice(at + separator.length).trim();
            if (front && back) {
                return { back, front };
            }
        }
    }
    return null;
}
