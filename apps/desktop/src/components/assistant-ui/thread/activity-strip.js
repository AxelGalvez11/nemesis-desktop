import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// ChatGPT-style thinking preview (student build). While a turn runs, the strip
// shows (1) an INTENT LINE — the model's own first thought sentence(s), readable
// body text that tells the student what it's about to do — and (2) a shimmering
// live status ("Searching PubMed for 'tesamorelin'…", or "Thinking").
// The raw trail (reasoning disclosure + tool rows) is hidden while running
// (styles.css) EXCEPT tool cards waiting on an approval, which must stay
// clickable. Once the turn settles, everything folds into one quiet row —
// "Worked for 21s" / "Thought for 8s" — that expands the full trail on demand.
//
// The strip renders TWICE per message (assistant-message.tsx): a 'header'
// instance above the prose that owns the settled toggle, the turn clock, and
// the trail-collapse attribute — and a 'live' instance below the prose so the
// running status reads as "here's what I said → here's what I'm doing now"
// instead of floating above text that streamed in after it (owner ask, 3×).
import { useAuiState } from '@assistant-ui/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { currentActivityEvent, phraseForActivity } from '@/components/assistant-ui/thread/activity-phrase';
import { contentHasVisibleText } from '@/components/assistant-ui/thread/content';
import { ActivityTimerText } from '@/components/chat/activity-timer-text';
import { Codicon } from '@/components/ui/codicon';
import { cn } from '@/lib/utils';
import { NEMESIS_STUDENT_BUILD } from '@/nemesis';
// Wall-clock per message, module-level so it survives remounts (scrolling a
// message out and back). Old messages restored from disk have no entry and
// fall back to the step-count label.
const TURN_CLOCK = new Map();
/** "Worked for 21s" / "Worked for 1m 2s" — ChatGPT's duration phrasing. */
function formatDuration(totalSeconds) {
    if (totalSeconds < 60) {
        return `${totalSeconds}s`;
    }
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}
// Reasoning that opens by narrating the QUESTION ("The user is asking…", "They
// want…", "So the question is…") is meta-narration, not a plan. ChatGPT's intent
// line reads like a first-person plan ("I'll compare…"); raw DeepSeek CoT usually
// restates the ask instead. Showing that restatement as a headline reads wrong, so
// we suppress it and let the live status line carry the turn. (A dedicated
// plan-writer that always produces a clean first-person line is a backend follow-up.)
const META_NARRATION_RE = /^(the (user|student|person)\b|they'?re? (asking|want)|this (is|question)|so,? the|okay,? (the|so)|the question|hmm\b|let me (think|see|first understand)|we need to (figure|understand))/i;
/** The intent line: the model's opening thought, but ONLY when it reads like a
 *  first-person plan — cleaned of markdown, capped near 170 chars. Empty for
 *  meta-narration and for anything too short to read as a real statement (a
 *  half-word flicker is worse than a beat of plain "Thinking"). */
export function extractIntent(raw) {
    const text = raw
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
    if (text.length < 24 || META_NARRATION_RE.test(text)) {
        return '';
    }
    const sentence = /^.{0,200}?[.!?](?=\s|$)/.exec(text)?.[0] ?? '';
    if (sentence.length >= 24) {
        return sentence;
    }
    // No sentence boundary yet — only show once there's a solid chunk, cut on a word.
    if (text.length < 140) {
        return '';
    }
    const cut = text.slice(0, 170);
    return `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}
export const ActivityStrip = ({ placement = 'header' }) => {
    const [open, setOpen] = useState(false);
    // Bumped when the clock stops so the settled label re-renders with a duration
    // (the settle render itself runs before the effect records `end`).
    const [, setClockTick] = useState(0);
    // Live instance only: 1 Hz re-render so the inline turn timer counts up.
    const [now, setNow] = useState(() => Date.now());
    const ref = useRef(null);
    const messageId = useAuiState(s => s.message.id);
    const running = useAuiState(s => s.message.status?.type === 'running');
    const steps = useAuiState(s => s.message.parts.filter(part => part?.type === 'tool-call').length);
    const hasReasoning = useAuiState(s => s.message.parts.some(part => part?.type === 'reasoning' && typeof part.text === 'string' && part.text.trim().length > 0));
    // The selector returns the phrase STRING (not the event object) so token
    // flushes that don't change the phrase are referentially stable and skip
    // re-rendering. Empty while settled, while the answer itself streams, or in
    // the stock (non-student) build.
    const livePhrase = useAuiState(s => {
        if (!NEMESIS_STUDENT_BUILD || s.message.status?.type !== 'running') {
            return '';
        }
        const event = currentActivityEvent(s.message.parts);
        return event ? phraseForActivity(event) : '';
    });
    // The model's own opening thought — ChatGPT's "I'll scan today's major
    // developments…" line. Derived (never fabricated) from the real reasoning
    // stream; empty for turns that never think out loud.
    const intent = useAuiState(s => {
        if (!NEMESIS_STUDENT_BUILD || s.message.status?.type !== 'running') {
            return '';
        }
        const first = s.message.parts.find(part => part?.type === 'reasoning' && typeof part.text === 'string' && part.text.trim().length > 0);
        return first && first.type === 'reasoning' ? extractIntent(first.text) : '';
    });
    // Once real prose has streamed, the turn's opening thought is old news —
    // showing it BELOW that prose would read as a stale stray sentence, so the
    // live instance drops the intent line and keeps only the status shimmer.
    const hasProse = useAuiState(s => contentHasVisibleText(s.message.content));
    const active = NEMESIS_STUDENT_BUILD && (steps > 0 || hasReasoning);
    // Wall clock: arm on the first running render, freeze on settle. The header
    // instance owns it (exactly one writer per message).
    useEffect(() => {
        if (!NEMESIS_STUDENT_BUILD || placement !== 'header') {
            return;
        }
        const entry = TURN_CLOCK.get(messageId);
        if (running) {
            if (!entry) {
                TURN_CLOCK.set(messageId, { start: Date.now() });
            }
        }
        else if (entry && entry.end === undefined) {
            TURN_CLOCK.set(messageId, { ...entry, end: Date.now() });
            setClockTick(tick => tick + 1);
        }
    }, [messageId, placement, running]);
    // Tick the live row's turn timer once a second. Live-only and while running
    // only — the settled label reads the frozen clock instead.
    useEffect(() => {
        if (placement !== 'live' || !running) {
            return;
        }
        const id = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(id);
    }, [placement, running]);
    // The trail lives in a sibling subtree (MessagePrimitive.Parts), so the collapse is
    // driven by an attribute on the shared message root + a CSS rule in styles.css.
    // Header-owned: its anchor stays mounted through every phase of the turn.
    useEffect(() => {
        if (placement !== 'header') {
            return;
        }
        const root = ref.current?.closest('[data-role="assistant"]');
        if (!root) {
            return;
        }
        if (!active) {
            root.removeAttribute('data-nemesis-activity');
            return;
        }
        root.setAttribute('data-nemesis-activity', running ? 'live' : open ? 'open' : 'collapsed');
    }, [active, open, placement, running]);
    // Branches render different elements (div / button), so the ref is a shared
    // callback rather than a per-element RefObject.
    const attachRef = useCallback((node) => {
        ref.current = node;
    }, []);
    if (placement === 'live') {
        if (!running || !(livePhrase || intent || hasReasoning)) {
            return null;
        }
        // Whole-turn seconds for the inline timer — same clock the settled
        // "Worked for Xs" label reads, so live and settled numbers agree. Null on
        // the very first render if the header effect hasn't armed the clock yet;
        // the timer simply appears on the next tick.
        const clockStart = TURN_CLOCK.get(messageId)?.start;
        const liveSeconds = clockStart !== undefined ? Math.max(0, Math.floor((now - clockStart) / 1000)) : null;
        return (_jsxs("div", { "aria-live": "polite", className: "mt-1.5 mb-1 flex min-w-0 max-w-full flex-col gap-1", "data-slot": "aui_activity-phrase", role: "status", children: [intent && !hasProse && (_jsx("p", { className: "nemesis-intent-line text-[0.875rem] leading-relaxed text-(--ui-text-secondary)", children: intent })), _jsxs("div", { className: "flex min-w-0 max-w-full items-center gap-2", children: [_jsx("span", { "aria-hidden": "true", className: "dither inline-block size-3 shrink-0 rounded-[2px] text-midground/80 animate-pulse" }), _jsx("span", { className: "nemesis-activity-phrase flex min-w-0 text-[length:var(--conversation-tool-font-size)] text-(--ui-text-tertiary)", children: _jsx("span", { className: "shimmer min-w-0 truncate", children: livePhrase || 'Thinking' }) }, livePhrase || 'thinking'), liveSeconds !== null && _jsx(ActivityTimerText, { seconds: liveSeconds })] })] }));
    }
    if (!active || running) {
        // Zero-size anchor keeps the ref attached so the attribute updates on settle.
        return _jsx("button", { "aria-hidden": true, className: "hidden", ref: attachRef, tabIndex: -1, type: "button" });
    }
    const clock = TURN_CLOCK.get(messageId);
    const seconds = clock?.end !== undefined ? Math.max(1, Math.round((clock.end - clock.start) / 1000)) : null;
    const label = open
        ? 'Hide work'
        : seconds !== null
            ? `${steps > 0 ? 'Worked' : 'Thought'} for ${formatDuration(seconds)}`
            : steps > 0
                ? `Worked through ${steps} step${steps === 1 ? '' : 's'}`
                : 'Show thinking';
    return (_jsxs("button", { className: cn('mb-1 flex items-center gap-1 text-[length:var(--conversation-tool-font-size)] text-(--ui-text-tertiary) transition-colors hover:text-foreground'), onClick: () => setOpen(value => !value), ref: attachRef, type: "button", children: [_jsx(Codicon, { name: open ? 'chevron-down' : 'chevron-right', size: "0.8125rem" }), _jsx("span", { children: label })] }));
};
