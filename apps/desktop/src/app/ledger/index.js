import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Codicon } from '@/components/ui/codicon';
import { groupByDay, loadLedger, trustLine } from '@/lib/activity-ledger';
import { cn } from '@/lib/utils';
function formatTimestamp(ts) {
    return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}
function LedgerRow({ entry }) {
    const externalAction = entry.sent === true || entry.submitted === true;
    return (_jsxs("article", { className: cn('grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3 border-l-2 py-3 pl-3 sm:grid-cols-[6.5rem_minmax(0,1fr)] sm:gap-5 sm:pl-4', externalAction ? 'border-l-(--ui-red)' : 'border-l-transparent'), children: [_jsx("time", { className: "pt-0.5 font-mono text-[0.67rem] tabular-nums text-(--ui-text-tertiary)", dateTime: entry.ts, children: formatTimestamp(entry.ts) }), _jsxs("div", { className: "min-w-0", children: [_jsxs("div", { className: "flex flex-wrap items-start gap-2", children: [_jsx("p", { className: "min-w-0 flex-1 text-sm leading-5 text-(--ui-text-primary)", children: entry.action }), _jsx("span", { className: "shrink-0 rounded bg-(--ui-bg-quaternary) px-1.5 py-0.5 text-[0.625rem] font-medium uppercase tracking-[0.06em] text-(--ui-text-tertiary)", children: entry.area })] }), entry.detail && _jsx("p", { className: "mt-1 text-xs leading-relaxed text-(--ui-text-secondary)", children: entry.detail }), entry.wrote?.map(path => (_jsx("p", { className: "mt-1 truncate font-mono text-[0.65rem] leading-4 text-(--ui-text-quaternary)", title: path, children: path }, path))), externalAction && (_jsx("p", { className: "mt-1.5 text-[0.625rem] font-semibold uppercase tracking-[0.08em] text-(--ui-red)", children: [entry.sent && 'Sent', entry.submitted && 'Submitted'].filter(Boolean).join(' · ') }))] })] }));
}
export function LedgerView() {
    const [entries, setEntries] = useState([]);
    const [loaded, setLoaded] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const refresh = useCallback(async (manual = false) => {
        if (manual) {
            setRefreshing(true);
        }
        try {
            setEntries(await loadLedger());
        }
        finally {
            setLoaded(true);
            setRefreshing(false);
        }
    }, []);
    useEffect(() => {
        void refresh();
        const onFocus = () => void refresh();
        window.addEventListener('focus', onFocus);
        return () => window.removeEventListener('focus', onFocus);
    }, [refresh]);
    const groups = useMemo(() => groupByDay(entries), [entries]);
    return (_jsxs("main", { className: "h-full min-h-0 overflow-y-auto bg-(--ui-editor-surface-background)", children: [_jsx("header", { className: "sticky top-0 z-10 border-b border-(--ui-stroke-tertiary) bg-(--ui-editor-surface-background)/95 backdrop-blur", children: _jsxs("div", { className: "mx-auto w-full max-w-[960px] px-5 pb-4 pt-6 sm:px-7", children: [_jsxs("div", { className: "flex items-center justify-between gap-4", children: [_jsxs("div", { children: [_jsx("p", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-(--ui-text-tertiary)", children: "Activity" }), _jsx("h1", { className: "mt-1 text-2xl font-semibold tracking-[-0.025em]", children: "Ledger" })] }), _jsxs(Button, { disabled: refreshing, onClick: () => void refresh(true), size: "sm", variant: "outline", children: [_jsx(Codicon, { name: "refresh", spinning: refreshing }), "Refresh"] })] }), _jsxs("div", { className: "mt-4 flex items-center justify-center gap-2 rounded-lg border border-(--ui-stroke-tertiary) px-4 py-3 text-center text-[0.6875rem] text-(--ui-text-tertiary)", children: [_jsx(Codicon, { className: "shrink-0", name: "shield", size: "0.85rem" }), _jsx("span", { children: trustLine(entries) })] })] }) }), _jsx("div", { className: "mx-auto w-full max-w-[960px] px-5 pb-10 pt-5 sm:px-7", children: !loaded ? (_jsxs("div", { className: "flex items-center justify-center gap-2 py-16 text-xs text-(--ui-text-tertiary)", children: [_jsx(Codicon, { name: "loading", spinning: true }), "Reading the ledger"] })) : groups.length === 0 ? (_jsx("div", { className: "grid min-h-64 place-items-center px-5 text-center", children: _jsx("p", { className: "max-w-md text-sm leading-relaxed text-(--ui-text-secondary)", children: "No actions recorded yet. Every action Nemesis takes will appear here, in plain English." }) })) : (_jsx("div", { className: "space-y-7", children: groups.map(group => (_jsxs("section", { children: [_jsx("h2", { className: "border-b border-(--ui-stroke-tertiary) pb-2 text-xs font-semibold text-(--ui-text-secondary)", children: group.label }), _jsx("div", { className: "divide-y divide-(--ui-stroke-tertiary)", children: group.entries.map((entry, index) => (_jsx(LedgerRow, { entry: entry }, `${entry.ts}:${entry.action}:${index}`))) })] }, group.dayIso))) })) })] }));
}
