import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// NoteRail — the right sidebar for the active note. Outline is a table of contents
// parsed from its markdown headers (h1–h3); Links is its outgoing [[wikilinks]] +
// relative .md links plus the notes that link back to it, and its #tags. Show/hide
// works like the LEFT sidebar: the parent (index.tsx) owns the open state and
// unmounts the rail entirely, so the editor reclaims the full width.
import { IconArrowLeft, IconArrowUpRight, IconFileText, IconHash, IconLayoutSidebarRightCollapse, IconLink, IconListTree, IconPlus } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { buildResolvableTitleSet, isWikilinkResolved } from './links';
import { extractHeadings, extractTags, extractTypedLinks, extractWikilinks } from './vault';
const RAIL_TABS = [
    { id: 'outline', icon: IconListTree, label: 'Outline' },
    { id: 'links', icon: IconLink, label: 'Links' }
];
const OUTLINE_INDENT = { 1: 'pl-2', 2: 'pl-5', 3: 'pl-8' };
export function NoteRail({ activeNote, index, notes, onCollapse, onCreateUnresolved, onOpenNote, onSearchTag, onSelectHeading }) {
    const [tab, setTab] = useState('outline');
    const headings = useMemo(() => extractHeadings(activeNote.content), [activeNote.content]);
    const tags = useMemo(() => extractTags(activeNote.content), [activeNote.content]);
    const outgoing = index.links.get(activeNote.title) ?? [];
    const incoming = index.backlinks.get(activeNote.title) ?? [];
    // Same folder-aware resolution rule the editor uses — a [[folder/Title]] link to a
    // real note is resolved, not "unresolved with a path for a name".
    const unresolved = useMemo(() => {
        const resolvable = buildResolvableTitleSet(notes);
        return extractWikilinks(activeNote.content).filter(target => !isWikilinkResolved(target, resolvable));
    }, [activeNote.content, notes]);
    // Library Brain phase 2's link grammar (skills/nemesis-notes/SKILL.md): a "## Related"
    // bullet with a leading "word:" that isn't one of the five allowed relationship types.
    const offGrammarLinks = useMemo(() => extractTypedLinks(activeNote.content).filter(link => link.type === null), [activeNote.content]);
    const openByTitle = (title) => {
        const note = notes.find(n => n.title === title);
        if (note) {
            onOpenNote(note);
        }
    };
    return (_jsxs("aside", { className: "hidden w-64 shrink-0 flex-col border-l border-(--ui-stroke-tertiary) bg-(--ui-sidebar-surface-background) lg:flex", children: [_jsxs("div", { className: "flex h-(--titlebar-height) shrink-0 items-center gap-2 border-b border-(--ui-stroke-tertiary) px-2", children: [_jsx(SegmentedControl, { onChange: setTab, options: RAIL_TABS, value: tab }), _jsx(Tip, { label: "Hide note panel", children: _jsx(Button, { "aria-label": "Hide note panel", className: "ml-auto shrink-0 transition-transform duration-200 ease-out active:scale-[0.98]", onClick: onCollapse, size: "icon-xs", variant: "ghost", children: _jsx(IconLayoutSidebarRightCollapse, {}) }) })] }), _jsx(ScrollArea, { className: "min-h-0 flex-1", children: _jsx("div", { className: "flex flex-col gap-4 px-3 pb-4 pt-3", children: tab === 'outline' ? (_jsx(OutlineList, { headings: headings, onSelect: onSelectHeading })) : (_jsxs(_Fragment, { children: [_jsx(RailSection, { count: outgoing.length, emptyLabel: "Write [[Note title]] or a relative .md link to connect ideas.", title: "Links", children: outgoing.map(title => (_jsx(NoteRow, { icon: _jsx(IconArrowUpRight, { size: 13 }), label: title, onClick: () => openByTitle(title) }, title))) }), _jsx(RailSection, { count: incoming.length, emptyLabel: "Nothing links here yet.", title: "Backlinks", children: incoming.map(title => (_jsx(NoteRow, { icon: _jsx(IconArrowLeft, { size: 13 }), label: title, onClick: () => openByTitle(title) }, title))) }), tags.length > 0 && (_jsx(RailSection, { count: tags.length, emptyLabel: "", title: "Tags", children: _jsx("div", { className: "flex flex-wrap gap-1.5 px-1 pt-0.5", children: tags.map(tag => (_jsx(Tip, { label: `Show notes tagged #${tag}`, children: _jsxs("button", { className: "flex items-center gap-0.5 rounded-md bg-(--ui-bg-quaternary) px-1.5 py-0.5 text-[0.6875rem] font-medium text-(--ui-text-secondary) transition-colors duration-200 ease-out hover:bg-(--ui-row-hover-background) hover:text-foreground active:scale-[0.98]", onClick: () => onSearchTag(tag), type: "button", children: [_jsx(IconHash, { className: "opacity-55", size: 11 }), tag] }) }, tag))) }) })), unresolved.length > 0 && (_jsx(RailSection, { count: unresolved.length, emptyLabel: "", title: "Unresolved", children: unresolved.map(target => {
                                    const slash = target.lastIndexOf('/');
                                    const name = slash >= 0 ? target.slice(slash + 1) : target;
                                    const folder = slash >= 0 ? target.slice(0, slash) : '';
                                    return (_jsx(Tip, { label: `Create “${target}”`, children: _jsxs("button", { className: "group flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-200 ease-out hover:bg-(--ui-row-hover-background) active:scale-[0.98]", onClick: () => onCreateUnresolved(target), type: "button", children: [_jsxs("span", { className: "min-w-0 flex-1", children: [_jsx("span", { className: "block truncate text-[0.8125rem] text-muted-foreground group-hover:text-foreground", children: name }), folder && (_jsx("span", { className: "block truncate text-[0.625rem] text-(--ui-text-quaternary)", children: folder }))] }), _jsx(IconPlus, { className: "shrink-0 opacity-0 transition-opacity duration-200 group-hover:opacity-60", size: 13 })] }) }, target));
                                }) })), offGrammarLinks.length > 0 && (_jsxs(RailSection, { count: offGrammarLinks.length, emptyLabel: "", title: "Off-grammar links", children: [_jsx("p", { className: "px-2 pb-1 text-[0.6875rem] leading-relaxed text-(--ui-text-quaternary)", children: "Only the five grammar words resolve as typed relationships \u2014 see nemesis-notes." }), offGrammarLinks.map((link, i) => (_jsxs("div", { className: "flex min-w-0 items-center gap-1.5 px-2 py-1", children: [_jsx("span", { className: "truncate text-[0.8125rem] text-(--ui-text-secondary)", children: link.prefix }), _jsx("span", { className: "shrink-0 text-(--ui-text-quaternary)", children: '→' }), _jsxs("span", { className: "min-w-0 flex-1 truncate text-[0.8125rem] text-muted-foreground", children: ["[[", link.target, "]]"] })] }, `${link.prefix}::${link.target}::${i}`)))] }))] })) }) })] }));
}
function OutlineList({ headings, onSelect }) {
    if (!headings.length) {
        return (_jsxs("div", { className: "rounded-lg border border-dashed border-(--ui-stroke-tertiary) px-3 py-3", children: [_jsx("p", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--ui-text-quaternary)", children: "No headings" }), _jsx("p", { className: "mt-1 text-[0.6875rem] leading-relaxed text-muted-foreground", children: "Add a # heading, ## heading, or ### heading to build a table of contents." })] }));
    }
    return (_jsx("div", { className: "flex flex-col gap-0.5", children: headings.map(heading => (_jsx("button", { className: cn('truncate rounded-lg py-1.5 text-left text-[0.8125rem] text-(--ui-text-secondary) transition-colors duration-200 ease-out hover:bg-(--ui-row-hover-background) hover:text-foreground active:scale-[0.98]', OUTLINE_INDENT[heading.level], heading.level === 1 && 'font-semibold text-foreground'), onClick: () => onSelect(heading.line), type: "button", children: heading.text }, heading.line))) }));
}
/** One titled group in the Links tab — heading + count, then full-width rows (not pills:
 *  long note titles and folder paths truncate instead of overflowing the rail). */
function RailSection({ children, count, emptyLabel, title }) {
    return (_jsxs("div", { className: "min-w-0", children: [_jsxs("div", { className: "mb-1 flex items-center justify-between gap-2 px-2", children: [_jsx("h3", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-muted-foreground", children: title }), _jsx("span", { className: "text-[0.65rem] tabular-nums text-(--ui-text-quaternary)", children: count })] }), count > 0 ? (_jsx("div", { className: "flex flex-col gap-0.5", children: children })) : (_jsx("p", { className: "px-2 py-1 text-[0.6875rem] leading-relaxed text-(--ui-text-quaternary)", children: emptyLabel }))] }));
}
function NoteRow({ icon, label, onClick }) {
    return (_jsxs("button", { className: "group flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-200 ease-out hover:bg-(--ui-row-hover-background) active:scale-[0.98]", onClick: onClick, type: "button", children: [_jsx("span", { className: "shrink-0 text-(--ui-text-quaternary) transition-colors duration-200 group-hover:text-(--ui-text-secondary)", children: icon }), _jsx("span", { className: "min-w-0 flex-1 truncate text-[0.8125rem] text-(--ui-text-secondary) transition-colors duration-200 group-hover:text-foreground", children: label }), _jsx(IconFileText, { className: "shrink-0 opacity-0 transition-opacity duration-200 group-hover:opacity-40", size: 13 })] }));
}
