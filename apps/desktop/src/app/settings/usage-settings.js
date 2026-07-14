import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// Account & usage settings (student build). One page answers "who am I signed in
// as, what plan am I on, and how much AI have I used" — account status from the
// live subscription read, today's allowance from the metering proxy's /usage
// endpoint, and a 7-day view read straight from the student's own usage counters
// (RLS-scoped). All read-only; subscription changes open in the browser.
import { useStore } from '@nanostores/react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { $account, BILLING_URL, fetchUsage, fetchWeeklyUsage, getTrialTiming, planLabel, refreshEntitlement, signOut, trialCountdownLabel } from '@/nemesis-account';
function formatTokens(value) {
    if (value >= 1_000_000) {
        return `${(value / 1_000_000).toFixed(1)}M`;
    }
    if (value >= 1_000) {
        return `${Math.round(value / 1_000)}K`;
    }
    return String(value);
}
/** The last 7 UTC days (oldest first), each with that day's used tokens (0 when
 *  the student didn't use Nemesis that day — the table only has rows for active
 *  days). */
function fillWeek(rows, now = Date.now()) {
    const byDay = new Map(rows.map(row => [row.periodStart, row.used]));
    return Array.from({ length: 7 }, (_, index) => {
        const day = new Date(now - (6 - index) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        return { periodStart: day, used: byDay.get(day) ?? 0 };
    });
}
function dayLetter(isoDate) {
    const day = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
    return ['S', 'M', 'T', 'W', 'T', 'F', 'S'][day] ?? '';
}
export function UsageSettings() {
    const account = useStore($account);
    const [usage, setUsage] = useState(null);
    const [state, setState] = useState('loading');
    const [week, setWeek] = useState(null);
    const [refreshingPlan, setRefreshingPlan] = useState(false);
    const load = () => {
        setState('loading');
        void fetchUsage().then(result => {
            setUsage(result);
            setState(result ? 'ready' : 'error');
        });
        void fetchWeeklyUsage().then(rows => {
            setWeek(rows ? fillWeek(rows) : null);
        });
    };
    useEffect(() => {
        load();
    }, []);
    const pct = usage && usage.dailyLimit > 0 ? Math.min(100, Math.round((usage.used / usage.dailyLimit) * 100)) : 0;
    const planName = usage ? planLabel(usage.plan) : planLabel(account.plan);
    const trialTiming = getTrialTiming(account);
    const planDetail = trialTiming && !trialTiming.expired
        ? `${trialCountdownLabel(trialTiming.daysRemaining)} · ${new Date(trialTiming.end).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`
        : account.plan === 'free'
            ? 'No active plan — upgrade for the full study engine.'
            : account.periodEnd
                ? `Renews ${new Date(account.periodEnd).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`
                : account.planStatus || 'Active';
    const weekTotal = week ? week.reduce((sum, day) => sum + day.used, 0) : 0;
    const weekMax = week ? Math.max(1, ...week.map(day => day.used)) : 1;
    return (_jsxs("div", { className: "mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-8", children: [_jsxs("div", { className: "flex flex-col gap-1", children: [_jsx("span", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-muted-foreground/70", children: "Account & usage" }), _jsx("h2", { className: "text-lg font-semibold text-foreground", children: "Your account" }), _jsx("p", { className: "text-sm text-muted-foreground", children: "Your plan, this week's AI work, and today's allowance \u2014 all in one place." })] }), _jsxs("div", { className: "flex flex-col gap-3 rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-5", children: [_jsxs("div", { className: "flex items-center justify-between gap-3", children: [_jsxs("div", { className: "min-w-0", children: [_jsx("div", { className: "truncate text-sm font-medium text-foreground", children: account.bypass ? 'Offline mode — not signed in' : account.email || 'Signed in' }), _jsx("div", { className: "pt-0.5 text-xs text-muted-foreground", children: account.bypass ? 'Local development' : planDetail })] }), _jsx("span", { className: "shrink-0 rounded-full bg-(--theme-primary)/15 px-2.5 py-1 text-[11px] font-semibold text-(--theme-primary)", children: trialTiming && !trialTiming.expired ? `${planLabel(account.plan)} trial` : `${planLabel(account.plan)} plan` })] }), !account.bypass && (_jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [_jsx(Button, { onClick: () => void window.hermesDesktop?.openExternal?.(BILLING_URL), size: "sm", variant: "secondary", children: account.plan === 'free' ? 'Choose a plan' : 'Manage subscription' }), _jsx(Button, { disabled: refreshingPlan, onClick: () => {
                                    setRefreshingPlan(true);
                                    void refreshEntitlement().finally(() => {
                                        setRefreshingPlan(false);
                                        load();
                                    });
                                }, size: "sm", variant: "outline", children: refreshingPlan ? 'Checking…' : 'Refresh plan' }), _jsx(Button, { onClick: () => void signOut(), size: "sm", variant: "ghost", children: "Sign out" })] }))] }), _jsxs("div", { className: "flex flex-col gap-3 rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-5", children: [_jsxs("div", { className: "flex items-baseline justify-between", children: [_jsx("span", { className: "text-sm font-medium text-foreground", children: "This week" }), _jsx("span", { className: "text-sm tabular-nums text-muted-foreground", children: week ? `${formatTokens(weekTotal)} tokens over 7 days` : 'Not available yet' })] }), week ? (_jsx("div", { "aria-label": "AI usage for the last 7 days", className: "flex items-end gap-2", role: "img", children: week.map(day => (_jsxs("div", { className: "flex flex-1 flex-col items-center gap-1", children: [_jsx("div", { className: "flex h-16 w-full items-end overflow-hidden rounded-md bg-(--ui-bg-tertiary)", children: _jsx("div", { className: "w-full rounded-md bg-(--theme-primary)/80 transition-[height] duration-500", style: { height: `${Math.max(day.used > 0 ? 6 : 0, Math.round((day.used / weekMax) * 100))}%` }, title: `${day.periodStart}: ${formatTokens(day.used)} tokens` }) }), _jsx("span", { className: "text-[10px] text-muted-foreground/70", children: dayLetter(day.periodStart) })] }, day.periodStart))) })) : (_jsx("p", { className: "text-xs text-muted-foreground", children: "Weekly usage appears after your first AI request while signed in." }))] }), state === 'ready' && usage ? (_jsxs("div", { className: "flex flex-col gap-4 rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-5", children: [_jsxs("div", { className: "flex items-baseline justify-between", children: [_jsx("span", { className: "text-sm font-medium text-foreground", children: "Used today" }), _jsxs("span", { className: "text-sm tabular-nums text-muted-foreground", children: [formatTokens(usage.used), " / ", usage.dailyLimit > 0 ? formatTokens(usage.dailyLimit) : 'unlimited'] })] }), _jsx("div", { className: "h-2.5 w-full overflow-hidden rounded-full bg-(--ui-bg-tertiary)", children: _jsx("div", { className: "h-full rounded-full bg-(--theme-primary) transition-[width] duration-500", style: { width: `${pct}%` } }) }), _jsxs("div", { className: "flex items-center justify-between text-xs text-muted-foreground", children: [_jsxs("span", { children: [_jsx("span", { className: "font-semibold text-foreground", children: formatTokens(usage.remaining) }), " left today \u00B7 resets at midnight (UTC)"] }), _jsx("span", { className: "rounded-full bg-(--theme-primary)/15 px-2 py-0.5 font-semibold text-(--theme-primary)", children: planName })] })] })) : state === 'loading' ? (_jsx("div", { className: "rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-5 text-sm text-muted-foreground", children: "Checking your allowance\u2026" })) : (_jsxs("div", { className: "flex flex-col items-start gap-3 rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-5", children: [_jsx("p", { className: "text-sm text-muted-foreground", children: "Today's allowance isn't available yet \u2014 this needs you to be signed in with an active plan and the metering service reachable." }), _jsx(Button, { onClick: load, size: "sm", variant: "secondary", children: "Try again" })] })), _jsx("p", { className: "text-xs leading-relaxed text-muted-foreground/70", children: "\u201CAI work\u201D is measured in tokens \u2014 the units the model reads and writes. Heavy tasks (a full research brief, a slide deck) use more than a quick question. Lecture transcription runs on your own Mac and never counts against this." })] }));
}
