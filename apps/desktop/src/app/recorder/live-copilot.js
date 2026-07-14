// Live lecture copilot: while recording, turns the rough on-device transcript into
// running AI notes + "ask next" suggestions. Cost-aware by design (owner-agreed):
// event-driven with a hard 5s floor (never a fixed timer, never fires on silence),
// short rolling transcript window per call, opt-in and OFF by default, tier-gated
// (Max = fastest cadence, Agent Pro = slower cadence, Student/free = not included).
// The transcript is machine-generated and mishears words; the model is instructed
// to silently correct terms from context — audio itself never leaves the Mac.
import { atom } from 'nanostores';
import { $account, llmComplete } from '@/nemesis-account';
import { $liveTranscript, $paused, $recording } from './service';
const ENABLED_STORE = 'nemesis.recorder.copilot.enabled';
const HARD_FLOOR_MS = 5000;
const WINDOW_CHARS = 1400;
const MAX_NOTES = 40;
/** Plan gate: which cadence (if any) a plan gets. Bypass (local dev) tests as Max. */
export function copilotAccess(account) {
    if (account.bypass)
        return { minIntervalMs: 7000, minNewChars: 140 };
    const plan = account.plan.toLowerCase();
    if (plan === 'max')
        return { minIntervalMs: 7000, minNewChars: 140 };
    if (plan === 'pro')
        return { minIntervalMs: 15000, minNewChars: 300 };
    return null;
}
/** Refresh only when there is enough NEW speech AND the interval (>=5s) has passed. */
export function shouldRefresh(now, lastCallAt, newChars, cadence) {
    if (newChars < cadence.minNewChars)
        return false;
    return now - lastCallAt >= Math.max(cadence.minIntervalMs, HARD_FLOOR_MS);
}
export function buildCopilotMessages(windowText, priorNotes) {
    const prior = priorNotes.slice(-6);
    return [
        {
            content: 'You are a live lecture copilot. The transcript below is machine speech-to-text and often ' +
                'misrecognizes technical words — silently infer the intended term from context and use the ' +
                'corrected term in your output. Reply with STRICT JSON only, no prose, no code fences: ' +
                '{"notes": string[], "ask": string[]}. notes = 0-3 short NEW bullet points capturing what was ' +
                'just taught (skip anything already in PRIOR NOTES; return [] if nothing new was said). ' +
                'ask = 0-2 short, specific questions the student could ask next to deepen or clarify.',
            role: 'system'
        },
        {
            content: `PRIOR NOTES:\n${prior.length ? prior.map(note => `- ${note}`).join('\n') : '(none yet)'}\n\nLATEST TRANSCRIPT WINDOW:\n${windowText}`,
            role: 'user'
        }
    ];
}
/** Tolerant JSON extraction (models sometimes wrap JSON in fences or prose). Never throws. */
export function parseCopilotReply(raw) {
    const empty = { ask: [], notes: [] };
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start)
        return empty;
    try {
        const parsed = JSON.parse(raw.slice(start, end + 1));
        const clean = (value, cap) => Array.isArray(value)
            ? value
                .filter((item) => typeof item === 'string')
                .map(item => item.trim())
                .filter(Boolean)
                .slice(0, cap)
            : [];
        return { ask: clean(parsed.ask, 2), notes: clean(parsed.notes, 3) };
    }
    catch {
        return empty;
    }
}
function loadEnabled() {
    try {
        return window.localStorage.getItem(ENABLED_STORE) === '1';
    }
    catch {
        return false;
    }
}
export const $copilotEnabled = atom(loadEnabled());
export const $copilotNotes = atom([]);
export const $copilotAsk = atom([]);
export const $copilotState = atom('idle');
export const $copilotError = atom(null);
export function setCopilotEnabled(enabled) {
    $copilotEnabled.set(enabled);
    try {
        window.localStorage.setItem(ENABLED_STORE, enabled ? '1' : '0');
    }
    catch {
        // preference simply won't persist
    }
}
/** Markdown section folded into the saved lecture note on stop ('' when no notes). */
export function copilotNotesMarkdown() {
    const notes = $copilotNotes.get();
    if (!notes.length)
        return '';
    return `\n## Copilot notes (live)\n\n${notes.map(note => `- ${note}`).join('\n')}\n`;
}
let inFlight = false;
let lastCallAt = 0;
let lastSeenChars = 0;
function resetCopilot() {
    $copilotNotes.set([]);
    $copilotAsk.set([]);
    $copilotError.set(null);
    $copilotState.set('idle');
    lastCallAt = 0;
    lastSeenChars = 0;
}
async function refresh(text) {
    inFlight = true;
    lastCallAt = Date.now();
    lastSeenChars = text.length;
    $copilotState.set('thinking');
    try {
        const raw = await llmComplete(buildCopilotMessages(text.slice(-WINDOW_CHARS), $copilotNotes.get()), {
            maxTokens: 320
        });
        const { ask, notes } = parseCopilotReply(raw);
        if (notes.length) {
            const existing = new Set($copilotNotes.get());
            const merged = [...$copilotNotes.get(), ...notes.filter(note => !existing.has(note))];
            $copilotNotes.set(merged.slice(-MAX_NOTES));
        }
        if (ask.length)
            $copilotAsk.set(ask);
        $copilotError.set(null);
        $copilotState.set('idle');
    }
    catch (error) {
        $copilotError.set(error instanceof Error ? error.message : 'Copilot call failed.');
        $copilotState.set('error');
    }
    finally {
        inFlight = false;
    }
}
/** "Suggest now": on-demand refresh that skips the cadence gate (still one call at a time). */
export function forceCopilotRefresh() {
    if (inFlight || $recording.get() !== 'recording')
        return;
    const text = $liveTranscript.get().join(' ');
    if (!text.trim())
        return;
    void refresh(text);
}
// Wiring is attached on first recorder mount, NOT at module load: in the
// single-chunk production bundle a circular import can leave these stores
// undefined while this module's body runs (beta.2/3 blank-screen bug —
// TypeError 'reading listen' killed the whole renderer before React mounted).
let wired = false;
export function initCopilotWiring() {
    if (wired)
        return;
    wired = true;
    $recording.listen(state => {
        if (state === 'recording')
            resetCopilot();
    });
    $liveTranscript.listen(segments => {
        if (!$copilotEnabled.get() || inFlight)
            return;
        if ($recording.get() !== 'recording' || $paused.get())
            return;
        const cadence = copilotAccess($account.get());
        if (!cadence)
            return;
        const text = segments.join(' ');
        if (!shouldRefresh(Date.now(), lastCallAt, text.length - lastSeenChars, cadence))
            return;
        void refresh(text);
    });
}
