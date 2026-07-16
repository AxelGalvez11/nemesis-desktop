import { jsx as _jsx } from "react/jsx-runtime";
// Nemesis student model picker. Students never see "deepseek" or any model/provider name —
// they choose one of THREE answer modes (owner ask, 2026-07-14): Instant / Medium / High.
// These map to the per-turn fast-mode + reasoning-effort the agent already honors
// (Instant = fast mode on; Medium/High = thinking with that effort). The actual model
// stays whatever Nemesis provisions — Nemesis provides (and bills for) the AI, so model
// selection is ours, not the student's.
import { useStore } from '@nanostores/react';
import { cn } from '@/lib/utils';
import { $currentFastMode, $currentReasoningEffort, setCurrentFastMode, setCurrentReasoningEffort } from '@/store/session';
export function currentAnswerMode(fast, effort) {
    if (fast) {
        return 'instant';
    }
    return effort === 'high' ? 'high' : 'medium';
}
export function answerModeLabel(mode) {
    return mode === 'instant' ? 'Instant' : mode === 'high' ? 'High' : 'Medium';
}
// Labels only — no explanations (owner call 2026-07-16: the box read too big).
const MODES = [
    { label: 'Instant', mode: 'instant' },
    { label: 'Medium', mode: 'medium' },
    { label: 'High', mode: 'high' }
];
function applyAnswerMode(mode) {
    if (mode === 'instant') {
        setCurrentFastMode(() => true);
        return;
    }
    setCurrentFastMode(() => false);
    setCurrentReasoningEffort(() => (mode === 'high' ? 'high' : 'medium'));
}
export function StudentModelMenu() {
    const fast = useStore($currentFastMode);
    const effort = useStore($currentReasoningEffort) || 'medium';
    const active = currentAnswerMode(fast, effort);
    return (_jsx("div", { className: "w-32 p-1", children: _jsx("div", { className: "flex flex-col gap-0.5", children: MODES.map(({ label, mode }) => (_jsx("button", { className: cn('rounded-md px-2.5 py-1.5 text-left text-sm font-medium transition-colors', active === mode ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-accent'), onClick: () => applyAnswerMode(mode), type: "button", children: label }, mode))) }) }));
}
