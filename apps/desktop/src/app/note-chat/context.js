// Pure context assembly for the note/card mini-chat. Turns the currently-open
// Library note or Study flashcard into (a) a stable scope key that keys its own
// conversation, and (b) the context the agent turn carries: a `@file:` reference
// for notes (the local agent reads the file itself), or an inline front/back
// block for cards (no per-card file exists). No React, no store — just strings,
// so it unit-tests fast and can't drag the mini-chat into global session state.
import { formatRefValue } from '@/components/assistant-ui/directive-text';
export function scopeKeyForNote(path) {
    return `note:${path}`;
}
export function scopeKeyForCard(deckId, cardKey) {
    return `card:${deckId}:${cardKey}`;
}
function titleFromPath(path) {
    const base = path.split('/').pop() ?? path;
    return base.replace(/\.[^.]+$/i, '');
}
export function assembleNoteContext(note) {
    return {
        scopeKey: scopeKeyForNote(note.path),
        kind: 'note',
        title: titleFromPath(note.path),
        // formatRefValue backtick-quotes paths with spaces so the agent's `@file:`
        // parser (HERMES_DIRECTIVE_RE) reads them intact — same helper the composer
        // uses, so the wire form matches what the backend already understands.
        refs: [`@file:${formatRefValue(note.path)}`],
        inline: ''
    };
}
export function assembleCardContext(item) {
    const cardKey = item.card.id ?? item.card.front;
    const refs = item.sourceFile ? [`@file:${formatRefValue(item.sourceFile)}`] : [];
    const lines = [`Front: ${item.card.front}`, `Back: ${item.card.back}`, `Deck: ${item.deckName}`];
    if (item.card.tags.length)
        lines.push(`Tags: ${item.card.tags.join(', ')}`);
    if (item.clozeIndex !== undefined)
        lines.push(`Cloze index: ${item.clozeIndex}`);
    return {
        scopeKey: scopeKeyForCard(item.deckId, cardKey),
        kind: 'card',
        title: item.deckName,
        refs,
        inline: lines.join('\n')
    };
}
