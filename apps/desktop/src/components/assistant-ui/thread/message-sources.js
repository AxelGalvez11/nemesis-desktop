import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// Inline source pills — PharmaOrb-style chips directly under an assistant answer,
// built from the citations named in THAT answer's text (PMIDs, links, trial ids, DOIs).
// The right-sidebar Sources rail stays the whole-chat view (it also digs through tool
// traffic); this is the per-answer receipt.
import { useMemo } from 'react';
import { sourcesFromText } from '@/app/right-sidebar/sources';
import { NEMESIS_STUDENT_BUILD } from '@/nemesis';
export const MessageSources = ({ text }) => {
    const sources = useMemo(() => (text ? sourcesFromText(text) : []), [text]);
    if (!NEMESIS_STUDENT_BUILD || sources.length === 0) {
        return null;
    }
    return (_jsx("div", { className: "mt-3 flex flex-wrap gap-1.5", "data-slot": "nemesis_message-sources", children: sources.map(source => (_jsxs("button", { className: "inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-foreground/85 transition-colors hover:border-(--theme-primary) hover:text-foreground", onClick: () => void window.hermesDesktop?.openExternal?.(source.url), title: `${source.title}\n${source.url}`, type: "button", children: [_jsx("span", { className: "text-[10px] font-semibold uppercase tracking-wide text-(--theme-primary)", children: source.badge }), _jsx("span", { className: "max-w-[14rem] truncate text-muted-foreground", children: source.title })] }, source.url))) }));
};
