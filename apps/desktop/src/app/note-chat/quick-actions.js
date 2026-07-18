// The prebaked instruction each quick-action appends after the note/card context.
// Fixed v1 set — see docs/design/nemesis-mini-chat-2026-07.md.
const INSTRUCTIONS = {
    explain_simpler: 'Explain this in plainer, simpler terms a student can follow.',
    quiz_me: 'Quiz me on this: ask me 2-3 questions one at a time, waiting for my answer before the next.',
    example: 'Give me one concrete worked example or clinical case that illustrates this.',
    why: 'Explain why this is the case — justify the key claim, or the back of the card.'
};
export const QUICK_ACTIONS = [
    { id: 'explain_simpler', label: () => 'Explain simpler' },
    { id: 'quiz_me', label: () => 'Quiz me' },
    { id: 'example', label: () => 'Give an example' },
    { id: 'why', label: s => (s === 'card' ? 'Why this answer' : 'Why this matters') }
];
// Compose the full turn text: the context refs (@file: lines) and/or the inline
// front/back block, then the action instruction. The agent reads any @file: ref
// itself, so notes stay lean; cards carry their front/back inline.
export function buildQuickActionPrompt(id, ctx) {
    const lead = ctx.refs.length ? `${ctx.refs.join('\n')}\n\n` : '';
    const body = ctx.inline ? `${ctx.inline}\n\n` : '';
    return `${lead}${body}${INSTRUCTIONS[id]}`;
}
