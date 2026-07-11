import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// Usage settings (student build): today's model-token budget for the signed-in
// plan, read live from the metering proxy's /usage endpoint. Read-only — the
// same key→plan→counter the proxy enforces, so it can't disagree with reality.
import { useStore } from '@nanostores/react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { $account, fetchUsage, planLabel } from '@/nemesis-account';
function formatTokens(value) {
    if (value >= 1_000_000) {
        return `${(value / 1_000_000).toFixed(1)}M`;
    }
    if (value >= 1_000) {
        return `${Math.round(value / 1_000)}K`;
    }
    return String(value);
}
export function UsageSettings() {
    const account = useStore($account);
    const [usage, setUsage] = useState(null);
    const [state, setState] = useState('loading');
    const load = () => {
        setState('loading');
        void fetchUsage().then(result => {
            setUsage(result);
            setState(result ? 'ready' : 'error');
        });
    };
    useEffect(() => {
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const pct = usage && usage.dailyLimit > 0 ? Math.min(100, Math.round((usage.used / usage.dailyLimit) * 100)) : 0;
    const planName = usage ? planLabel(usage.plan) : planLabel(account.plan);
    return (_jsxs("div", { className: "mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-8", children: [_jsxs("div", { className: "flex flex-col gap-1", children: [_jsx("span", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-muted-foreground/70", children: "Usage" }), _jsx("h2", { className: "text-lg font-semibold text-foreground", children: "Today's allowance" }), _jsxs("p", { className: "text-sm text-muted-foreground", children: ["Your ", planName, " plan includes a daily amount of AI work. It resets every day at midnight (UTC)."] })] }), state === 'ready' && usage ? (_jsxs("div", { className: "flex flex-col gap-4 rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-5", children: [_jsxs("div", { className: "flex items-baseline justify-between", children: [_jsx("span", { className: "text-sm font-medium text-foreground", children: "Used today" }), _jsxs("span", { className: "text-sm tabular-nums text-muted-foreground", children: [formatTokens(usage.used), " / ", usage.dailyLimit > 0 ? formatTokens(usage.dailyLimit) : 'unlimited'] })] }), _jsx("div", { className: "h-2.5 w-full overflow-hidden rounded-full bg-(--ui-bg-tertiary)", children: _jsx("div", { className: "h-full rounded-full bg-(--theme-primary) transition-[width] duration-500", style: { width: `${pct}%` } }) }), _jsxs("div", { className: "flex items-center justify-between text-xs text-muted-foreground", children: [_jsxs("span", { children: [_jsx("span", { className: "font-semibold text-foreground", children: formatTokens(usage.remaining) }), " left today"] }), _jsx("span", { className: "rounded-full bg-(--theme-primary)/15 px-2 py-0.5 font-semibold text-(--theme-primary)", children: planName })] })] })) : state === 'loading' ? (_jsx("div", { className: "rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-5 text-sm text-muted-foreground", children: "Checking your allowance\u2026" })) : (_jsxs("div", { className: "flex flex-col items-start gap-3 rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-5", children: [_jsx("p", { className: "text-sm text-muted-foreground", children: "Usage isn't available yet \u2014 this needs you to be signed in with an active plan and the metering service running." }), _jsx(Button, { onClick: load, size: "sm", variant: "secondary", children: "Try again" })] })), _jsx("p", { className: "text-xs leading-relaxed text-muted-foreground/70", children: "\u201CAI work\u201D is measured in tokens \u2014 the units the model reads and writes. Heavy tasks (a full research brief, a slide deck) use more than a quick question. Lecture transcription runs on your own Mac and never counts against this." })] }));
}
