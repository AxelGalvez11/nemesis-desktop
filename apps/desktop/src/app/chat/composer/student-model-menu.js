import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Nemesis student model picker. Students never see "deepseek" or any model/provider name —
// they choose an ANSWER MODE (Fast vs Thinking) and, when thinking, an effort level. These
// map to the same per-turn fast-mode + reasoning-effort the agent already honors; the actual
// model stays whatever Nemesis provisions. Nemesis provides (and bills for) the AI, so model
// selection is ours, not the student's.
import { useStore } from '@nanostores/react';
import { cn } from '@/lib/utils';
import { $currentFastMode, $currentReasoningEffort, setCurrentFastMode, setCurrentReasoningEffort } from '@/store/session';
const EFFORTS = [
    ['low', 'Light'],
    ['medium', 'Balanced'],
    ['high', 'Deep']
];
export function StudentModelMenu() {
    const fast = useStore($currentFastMode);
    const effort = useStore($currentReasoningEffort) || 'medium';
    const segment = (active) => cn('flex-1 rounded-md px-2 py-1.5 text-sm transition-colors', active ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-accent');
    return (_jsxs("div", { className: "w-64 p-1", children: [_jsx("div", { className: "px-3 pb-1.5 pt-2 text-xs font-medium text-muted-foreground", children: "Answer mode" }), _jsxs("div", { className: "flex gap-1 px-2", children: [_jsx("button", { className: segment(fast), onClick: () => setCurrentFastMode(() => true), type: "button", children: "Fast" }), _jsx("button", { className: segment(!fast), onClick: () => setCurrentFastMode(() => false), type: "button", children: "Thinking" })] }), _jsx("p", { className: "px-3 pb-1 pt-1.5 text-xs text-muted-foreground", children: fast ? 'Quick answers for simple questions.' : 'Reasons step by step — better for hard problems.' }), !fast && (_jsxs(_Fragment, { children: [_jsx("div", { className: "mx-2 my-1.5 border-t border-border" }), _jsx("div", { className: "px-3 pb-1.5 text-xs font-medium text-muted-foreground", children: "Effort" }), _jsx("div", { className: "flex gap-1 px-2 pb-1", children: EFFORTS.map(([value, label]) => (_jsx("button", { className: cn('flex-1 rounded-md px-2 py-1.5 text-xs transition-colors', effort === value ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-accent'), onClick: () => setCurrentReasoningEffort(() => value), type: "button", children: label }, value))) })] }))] }));
}
