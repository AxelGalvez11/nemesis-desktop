import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// Inline source pills — ChatGPT-style receipts directly under an assistant answer,
// built from the citations named in THAT answer's text (PMIDs, links, trial ids, DOIs).
// Sources from the same site collapse into ONE chip (favicon + site name + "+N"), the
// way ChatGPT clusters same-claim citations, and the row ends with a stacked-favicon
// "Sources" affordance that opens the right-rail Sources panel. The rail stays the
// whole-chat view (it also digs through tool traffic); this is the per-answer receipt.
import { useMemo } from 'react';
import { SOURCE_CHIP_CLASS_NAME, SourceFavicon, sourcesFromText } from '@/app/right-sidebar/sources';
import { NEMESIS_STUDENT_BUILD } from '@/nemesis';
import { focusSourceInRail } from '@/store/source-focus';
/** Cluster citations by site so four PubMed papers read as one calm "PubMed +3"
 *  chip instead of four near-identical pills. Order follows first appearance. */
function groupByDomain(sources) {
    const groups = new Map();
    for (const source of sources) {
        const key = source.domain || source.url;
        const existing = groups.get(key);
        if (existing) {
            existing.items.push(source);
        }
        else {
            groups.set(key, { items: [source], primary: source });
        }
    }
    return [...groups.values()];
}
export const MessageSources = ({ text }) => {
    const sources = useMemo(() => (text ? sourcesFromText(text) : []), [text]);
    const groups = useMemo(() => groupByDomain(sources), [sources]);
    if (!NEMESIS_STUDENT_BUILD || groups.length === 0) {
        return null;
    }
    // ONE footer pill (owner call 2026-07-16): inline chips inside the answer are
    // the per-claim receipts now (markdown-text renders citation links as chips),
    // so the foot carries a single stacked-favicon "Sources · N" into the rail.
    return (_jsx("div", { className: "mt-3 flex flex-wrap items-center gap-1.5", "data-slot": "nemesis_message-sources", children: _jsxs("button", { className: SOURCE_CHIP_CLASS_NAME, onClick: () => focusSourceInRail(sources[0].url), title: groups.map(group => group.primary.title).join('\n'), type: "button", children: [_jsx("span", { className: "flex -space-x-1.5", children: groups.slice(0, 3).map(group => (_jsx("span", { className: "rounded-full bg-background ring-2 ring-background", children: _jsx(SourceFavicon, { domain: group.primary.domain }) }, group.primary.url))) }), _jsx("span", { className: "text-foreground/80", children: "Sources" }), _jsx("span", { className: "shrink-0 text-[10px] font-medium text-muted-foreground/55", children: sources.length })] }) }));
};
