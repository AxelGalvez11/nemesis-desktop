// The agent→Study bridge. Study decks live in localStorage, which the agent (a separate
// process with file tools) can't reach — so the agent writes DECK FILES into the vault's
// Flashcards folder (see the nemesis-study-decks skill) and the Study page auto-imports
// any file it hasn't seen before. "Make me flashcards from this chat" becomes: agent
// writes Flashcards/<Deck>.tsv → the deck appears in Study on next visit.
import { parseCardPaste } from './import-cards';
export const DECK_DIR = '~/Documents/Nemesis Library/Flashcards';
const REGISTRY_KEY = 'nemesis.study.deckFiles.v1';
function loadRegistry() {
    try {
        const raw = window.localStorage.getItem(REGISTRY_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                return new Set(parsed.filter((item) => typeof item === 'string'));
            }
        }
    }
    catch {
        // corrupted registry → treat as empty (worst case: a deck re-imports once)
    }
    return new Set();
}
export function markDeckFileImported(fileName) {
    const registry = loadRegistry();
    registry.add(fileName);
    try {
        window.localStorage.setItem(REGISTRY_KEY, JSON.stringify([...registry]));
    }
    catch {
        // best-effort
    }
}
/** Deck files not yet imported, parsed and ready. Missing folder = no candidates. */
export async function scanDeckFiles() {
    const api = window.hermesDesktop;
    if (!api?.readDir || !api.readFileText) {
        return [];
    }
    let entries;
    try {
        const dir = await api.readDir(DECK_DIR);
        if (dir.error) {
            return [];
        }
        entries = dir.entries;
    }
    catch {
        return [];
    }
    const imported = loadRegistry();
    const out = [];
    for (const entry of entries) {
        if (entry.isDirectory || !/\.(tsv|txt|md)$/i.test(entry.name) || imported.has(entry.name)) {
            continue;
        }
        let text = '';
        try {
            const read = await api.readFileText(entry.path);
            text = read.text ?? '';
        }
        catch {
            continue;
        }
        // Optional metadata header the skill writes: "# course: Pharmacology"
        const courseMatch = text.match(/^#\s*course:\s*(.+)$/im);
        // Comment lines are metadata, not cards.
        const body = text
            .split(/\r?\n/)
            .filter(line => !line.trim().startsWith('#'))
            .join('\n');
        const cards = parseCardPaste(body);
        out.push({
            cards,
            course: courseMatch?.[1]?.trim(),
            fileName: entry.name,
            name: entry.name.replace(/\.(tsv|txt|md)$/i, '')
        });
    }
    return out;
}
