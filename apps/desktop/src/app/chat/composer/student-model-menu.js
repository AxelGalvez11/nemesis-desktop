import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
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
const MODES = [
    { description: 'Fastest answers for quick questions.', label: 'Instant', mode: 'instant' },
    { description: 'Thinks it through first — the everyday default.', label: 'Medium', mode: 'medium' },
    {
        description: 'Deepest reasoning for hard problems. Slower and uses more of your daily allowance.',
        label: 'High',
        mode: 'high'
    }
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
    return (_jsxs("div", { className: "w-72 p-1", children: [_jsx("div", { className: "px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground", children: "Answer mode" }), _jsx("div", { className: "flex flex-col gap-0.5 px-1 pb-1", children: MODES.map(({ description, label, mode }) => (_jsxs("button", { className: cn('flex flex-col items-start gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors', active === mode ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-accent'), onClick: () => applyAnswerMode(mode), type: "button", children: [_jsx("span", { className: "text-sm font-medium", children: label }), _jsx("span", { className: cn('text-xs', active === mode ? 'text-primary-foreground/75' : 'text-muted-foreground'), children: description })] }, mode))) })] }));
}
