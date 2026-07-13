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
    return (_jsxs("div", { className: "mt-3 flex flex-wrap items-center gap-1.5", "data-slot": "nemesis_message-sources", children: [groups.map(group => (_jsxs("button", { className: SOURCE_CHIP_CLASS_NAME, onClick: () => focusSourceInRail(group.primary.url), title: group.items.map(item => item.title).join('\n'), type: "button", children: [_jsx(SourceFavicon, { domain: group.primary.domain }), _jsx("span", { className: "max-w-[11rem] truncate text-foreground/80", children: group.items.length > 1 ? group.primary.badge : group.primary.title }), group.items.length > 1 && (_jsxs("span", { className: "shrink-0 text-[10px] font-medium text-muted-foreground/55", children: ["+", group.items.length - 1] }))] }, group.primary.url))), _jsxs("button", { className: "inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] leading-none text-muted-foreground transition-colors hover:bg-card hover:text-foreground", onClick: () => focusSourceInRail(sources[0].url), title: "Open the Sources panel", type: "button", children: [_jsx("span", { className: "flex -space-x-1.5", children: groups.slice(0, 3).map(group => (_jsx("span", { className: "rounded-full bg-background ring-2 ring-background", children: _jsx(SourceFavicon, { domain: group.primary.domain }) }, group.primary.url))) }), "Sources"] })] }));
};
