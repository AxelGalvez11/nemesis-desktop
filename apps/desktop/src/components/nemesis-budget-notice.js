import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// Ambient daily-allowance warning (student build). Quietly polls the metering
// proxy and, once today's AI usage crosses 80%, floats one dismissible strip
// above the composer — BEFORE the hard stop, so the raw limit error is never
// the first thing a student learns about budgets (owner ask, 2026-07-14, after
// burning a full day's allowance in one email-setup session). Dismissal is
// remembered per UTC day; the strip escalates its copy at 100%.
import { useEffect, useState } from 'react';
import { XIcon } from '@/lib/icons';
import { NEMESIS_STUDENT_BUILD } from '@/nemesis';
import { fetchUsage } from '@/nemesis-account';
const WARN_RATIO = 0.8;
const POLL_MS = 5 * 60 * 1000;
const DISMISS_KEY = 'nemesis.budget.warned';
function dismissedFor(periodStart) {
    try {
        return window.localStorage.getItem(DISMISS_KEY) === periodStart;
    }
    catch {
        return false;
    }
}
export const NemesisBudgetNotice = () => {
    const [usage, setUsage] = useState(null);
    const [dismissed, setDismissed] = useState(false);
    useEffect(() => {
        if (!NEMESIS_STUDENT_BUILD) {
            return;
        }
        let cancelled = false;
        const poll = async () => {
            const snapshot = await fetchUsage();
            if (!cancelled && snapshot) {
                setUsage(snapshot);
                setDismissed(dismissedFor(snapshot.periodStart));
            }
        };
        void poll();
        const timer = setInterval(() => void poll(), POLL_MS);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, []);
    if (!NEMESIS_STUDENT_BUILD || !usage || usage.dailyLimit <= 0 || dismissed) {
        return null;
    }
    const ratio = usage.used / usage.dailyLimit;
    if (ratio < WARN_RATIO) {
        return null;
    }
    const exhausted = usage.remaining <= 0;
    const pct = Math.min(100, Math.round(ratio * 100));
    const dismiss = () => {
        try {
            window.localStorage.setItem(DISMISS_KEY, usage.periodStart);
        }
        catch {
            // Storage unavailable: the strip just reappears next poll.
        }
        setDismissed(true);
    };
    return (_jsxs("div", { className: "absolute inset-x-0 z-20 mx-auto flex w-fit max-w-[calc(100%-2rem)] items-center gap-2 rounded-full border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) px-3.5 py-1.5 text-xs text-muted-foreground shadow-md", role: "status", style: {
            // Same clearance the scroll-to-bottom control uses: sit just above the
            // (docked or floating) composer rather than under it.
            bottom: 'calc(var(--composer-measured-height) + var(--status-stack-measured-height) + 0.625rem)'
        }, children: [_jsx("span", { children: exhausted
                    ? 'Today’s AI allowance is used up — it resets at midnight UTC.'
                    : `You’ve used ${pct}% of today’s AI allowance.` }), _jsx("button", { "aria-label": "Dismiss allowance notice", className: "grid size-4 place-items-center rounded-full text-muted-foreground transition-colors hover:text-foreground", onClick: dismiss, type: "button", children: _jsx(XIcon, { className: "size-3" }) })] }));
};
