import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// NoteRail — the right sidebar for the active note. Outline is a table of contents
// parsed from its markdown headers (h1–h3); Links is its outgoing [[wikilinks]] +
// relative .md links plus the notes that link back to it. Collapses to a thin strip,
// Obsidian-style, with the collapsed state remembered across sessions.
import { IconLayoutSidebarRightCollapse, IconLayoutSidebarRightExpand, IconLink, IconListTree } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Tip } from '@/components/ui/tooltip';
import { persistBoolean, storedBoolean } from '@/lib/storage';
import { cn } from '@/lib/utils';
import { extractHeadings, extractWikilinks } from './vault';
const COLLAPSED_KEY = 'hermes.desktop.library.rightRailCollapsed';
const RAIL_TABS = [
    { id: 'outline', icon: IconListTree, label: 'Outline' },
    { id: 'links', icon: IconLink, label: 'Links' }
];
const OUTLINE_INDENT = { 1: 'pl-2', 2: 'pl-5', 3: 'pl-8' };
export function NoteRail({ activeNote, index, notes, onCreateUnresolved, onOpenNote, onSelectHeading }) {
    const [collapsed, setCollapsed] = useState(() => storedBoolean(COLLAPSED_KEY, false));
    const [tab, setTab] = useState('outline');
    const toggleCollapsed = () => {
        setCollapsed(current => {
            const next = !current;
            persistBoolean(COLLAPSED_KEY, next);
            return next;
        });
    };
    const headings = useMemo(() => extractHeadings(activeNote.content), [activeNote.content]);
    const outgoing = index.links.get(activeNote.title) ?? [];
    const incoming = index.backlinks.get(activeNote.title) ?? [];
    const unresolved = useMemo(() => extractWikilinks(activeNote.content).filter(target => !notes.some(note => note.title.toLowerCase() === target.toLowerCase())), [activeNote.content, notes]);
    const openByTitle = (title) => {
        const note = notes.find(n => n.title === title);
        if (note) {
            onOpenNote(note);
        }
    };
    return (_jsxs("aside", { className: cn('hidden shrink-0 flex-col border-l border-(--ui-stroke-tertiary) bg-(--ui-sidebar-surface-background) lg:flex', collapsed ? 'w-10' : 'w-64'), children: [_jsxs("div", { className: "flex h-(--titlebar-height) shrink-0 items-center gap-2 border-b border-(--ui-stroke-tertiary) px-2", children: [!collapsed && _jsx(SegmentedControl, { onChange: setTab, options: RAIL_TABS, value: tab }), _jsx(Tip, { label: collapsed ? 'Expand sidebar' : 'Collapse sidebar', children: _jsx(Button, { "aria-label": collapsed ? 'Expand sidebar' : 'Collapse sidebar', className: "ml-auto shrink-0 transition-transform duration-200 ease-out active:scale-[0.98]", onClick: toggleCollapsed, size: "icon-xs", variant: "ghost", children: collapsed ? _jsx(IconLayoutSidebarRightExpand, {}) : _jsx(IconLayoutSidebarRightCollapse, {}) }) })] }), !collapsed && (_jsx(ScrollArea, { className: "min-h-0 flex-1", children: _jsx("div", { className: "flex flex-col gap-3 px-3 pb-4 pt-3", children: tab === 'outline' ? (_jsx(OutlineList, { headings: headings, onSelect: onSelectHeading })) : (_jsxs(_Fragment, { children: [_jsx(LinkGroup, { emptyLabel: "Write [[Note title]] or a relative .md link to connect ideas.", onOpen: openByTitle, title: "Links", titles: outgoing }), _jsx(LinkGroup, { emptyLabel: "Nothing links here yet.", onOpen: openByTitle, title: "Backlinks", titles: incoming }), unresolved.length > 0 && (_jsxs("div", { className: "rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-3 shadow-[inset_0_1px_0_var(--ui-stroke-quaternary)]", children: [_jsxs("div", { className: "mb-2 flex items-center justify-between", children: [_jsx("h3", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-muted-foreground", children: "Unresolved" }), _jsx("span", { className: "text-[0.65rem] tabular-nums text-(--ui-text-quaternary)", children: unresolved.length })] }), _jsx("div", { className: "flex flex-wrap gap-1.5", children: unresolved.map(target => (_jsx(Tip, { label: `Create “${target}”`, children: _jsx("button", { className: "rounded-full border border-dashed border-(--ui-stroke-secondary) px-2.5 py-1 text-[0.6875rem] text-muted-foreground transition-[color,border-color,background-color] duration-200 ease-out hover:border-(--theme-primary)/50 hover:bg-(--ui-bg-primary) hover:text-foreground active:scale-[0.98]", onClick: () => onCreateUnresolved(target), type: "button", children: target }) }, target))) })] }))] })) }) }))] }));
}
function OutlineList({ headings, onSelect }) {
    if (!headings.length) {
        return (_jsxs("div", { className: "rounded-lg border border-dashed border-(--ui-stroke-tertiary) px-3 py-3", children: [_jsx("p", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--ui-text-quaternary)", children: "No headings" }), _jsx("p", { className: "mt-1 text-[0.6875rem] leading-relaxed text-muted-foreground", children: "Add a # heading, ## heading, or ### heading to build a table of contents." })] }));
    }
    return (_jsx("div", { className: "flex flex-col gap-0.5", children: headings.map(heading => (_jsx("button", { className: cn('truncate rounded-lg py-1.5 text-left text-[0.8125rem] text-(--ui-text-secondary) transition-colors duration-200 ease-out hover:bg-(--ui-row-hover-background) hover:text-foreground active:scale-[0.98]', OUTLINE_INDENT[heading.level], heading.level === 1 && 'font-semibold text-foreground'), onClick: () => onSelect(heading.line), type: "button", children: heading.text }, heading.line))) }));
}
function LinkGroup({ emptyLabel, onOpen, title, titles }) {
    return (_jsxs("div", { className: "rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-3 shadow-[inset_0_1px_0_var(--ui-stroke-quaternary)]", children: [_jsxs("div", { className: "mb-2.5 flex items-center justify-between gap-2", children: [_jsx("h3", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-muted-foreground", children: title }), _jsx("span", { className: "rounded-full bg-(--ui-bg-quaternary) px-1.5 py-0.5 text-[0.625rem] font-medium tabular-nums text-(--ui-text-tertiary)", children: titles.length })] }), titles.length ? (_jsx("div", { className: "flex flex-wrap gap-1.5", children: titles.map(target => (_jsx("button", { className: "rounded-full border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) px-2.5 py-1 text-[0.6875rem] text-(--ui-text-secondary) transition-[transform,color,border-color,background-color] duration-200 ease-out hover:border-(--theme-primary)/40 hover:bg-(--ui-bg-primary) hover:text-foreground active:scale-[0.98]", onClick: () => onOpen(target), type: "button", children: target }, target))) })) : (_jsxs("div", { className: "rounded-lg border border-dashed border-(--ui-stroke-tertiary) px-3 py-3", children: [_jsx("p", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--ui-text-quaternary)", children: "None yet" }), _jsx("p", { className: "mt-1 text-[0.6875rem] leading-relaxed text-muted-foreground", children: emptyLabel })] }))] }));
}
