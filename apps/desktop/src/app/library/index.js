import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Library — the notes vault page. Plain Obsidian-compatible Markdown on disk, edited with
// the SAME CodeMirror editor the app already ships (language auto-detected from the .md
// path), plus a wikilink/backlink rail computed by vault.ts. Autosaves 800ms after typing.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CodeEditor } from '@/components/chat/code-editor';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { buildIndex, extractWikilinks, loadVault, saveNote, SEED_NOTES, VAULT_DIR } from './vault';
export function LibraryView() {
    const [notes, setNotes] = useState(null);
    const [error, setError] = useState(null);
    const [activeTitle, setActiveTitle] = useState(null);
    const [draftTitle, setDraftTitle] = useState('');
    const [creating, setCreating] = useState(false);
    const [saving, setSaving] = useState(false);
    const saveTimer = useRef(null);
    const refresh = useCallback(async () => {
        try {
            let loaded = await loadVault();
            if (!loaded.length) {
                // First run: seed the vault so Library + Graph demonstrate themselves.
                for (const seed of SEED_NOTES) {
                    await saveNote(seed.title, seed.content);
                }
                loaded = await loadVault();
            }
            setNotes(loaded);
            setError(null);
            setActiveTitle(current => current ?? loaded[0]?.title ?? null);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : 'Could not open the Library folder.');
        }
    }, []);
    useEffect(() => {
        void refresh();
        return () => {
            if (saveTimer.current) {
                clearTimeout(saveTimer.current);
            }
        };
    }, [refresh]);
    const index = useMemo(() => (notes ? buildIndex(notes) : null), [notes]);
    const active = notes?.find(note => note.title === activeTitle) ?? null;
    const scheduleSave = useCallback((title, content) => {
        // Keep the in-memory copy current so links/backlinks track while typing.
        setNotes(current => current ? current.map(note => (note.title === title ? { ...note, content } : note)) : current);
        if (saveTimer.current) {
            clearTimeout(saveTimer.current);
        }
        saveTimer.current = setTimeout(() => {
            setSaving(true);
            void saveNote(title, content).finally(() => setSaving(false));
        }, 800);
    }, []);
    const createNote = useCallback(async () => {
        const title = draftTitle.trim();
        if (!title) {
            return;
        }
        await saveNote(title, `# ${title}\n\n`);
        setDraftTitle('');
        setCreating(false);
        await refresh();
        setActiveTitle(title);
    }, [draftTitle, refresh]);
    if (error) {
        return _jsx(EmptyState, { className: "h-full", description: `${error} (${VAULT_DIR})`, title: "Library unavailable" });
    }
    if (!notes) {
        return _jsx(EmptyState, { className: "h-full", description: "Opening your vault\u2026", title: "Library" });
    }
    const outgoing = active && index ? (index.links.get(active.title) ?? []) : [];
    const incoming = active && index ? (index.backlinks.get(active.title) ?? []) : [];
    const unresolved = active
        ? extractWikilinks(active.content).filter(target => !notes.some(note => note.title.toLowerCase() === target.toLowerCase()))
        : [];
    return (_jsxs("div", { className: "flex h-full min-h-0", children: [_jsxs("aside", { className: "flex w-60 shrink-0 flex-col border-r border-border", children: [_jsxs("div", { className: "flex items-center justify-between gap-2 px-4 pb-2 pt-5", children: [_jsx("h1", { className: "text-lg font-semibold", children: "Library" }), _jsx(Button, { onClick: () => setCreating(open => !open), size: "sm", variant: "outline", children: "New" })] }), _jsxs("p", { className: "px-4 pb-2 text-xs text-muted-foreground", children: [notes.length, " notes \u00B7 your own Markdown files"] }), creating && (_jsx("div", { className: "flex gap-1 px-3 pb-2", children: _jsx(Input, { autoFocus: true, onChange: event => setDraftTitle(event.target.value), onKeyDown: event => {
                                if (event.key === 'Enter') {
                                    void createNote();
                                }
                            }, placeholder: "Note title", value: draftTitle }) })), _jsx("nav", { className: "min-h-0 flex-1 overflow-y-auto px-2 pb-4", children: notes.map(note => (_jsx("button", { className: cn('block w-full truncate rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent', note.title === activeTitle && 'bg-accent text-accent-foreground'), onClick: () => setActiveTitle(note.title), type: "button", children: note.title }, note.path))) })] }), _jsx("main", { className: "flex min-w-0 flex-1 flex-col", children: active ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: "flex items-center justify-between px-5 pb-1 pt-5", children: [_jsx("h2", { className: "truncate text-base font-medium", children: active.title }), _jsx("span", { className: "text-xs text-muted-foreground", children: saving ? 'Saving…' : 'Saved to disk' })] }), _jsx("div", { className: "min-h-0 flex-1 px-3 pb-3", children: _jsx(CodeEditor, { filePath: active.path, initialValue: active.content, onChange: value => scheduleSave(active.title, value) }, active.path) })] })) : (_jsx(EmptyState, { className: "flex-1", description: "Pick a note on the left, or create one.", title: "No note open" })) }), _jsxs("aside", { className: "hidden w-56 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border px-4 pb-4 pt-5 lg:flex", children: [_jsx(LinkGroup, { emptyLabel: "No links yet \u2014 write [[Note title]] to connect ideas.", onOpen: setActiveTitle, title: "Links", titles: outgoing }), _jsx(LinkGroup, { emptyLabel: "Nothing links here yet.", onOpen: setActiveTitle, title: "Backlinks", titles: incoming }), unresolved.length > 0 && (_jsxs("div", { children: [_jsx("h3", { className: "pb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground", children: "Unresolved" }), _jsx("div", { className: "flex flex-wrap gap-1.5", children: unresolved.map(target => (_jsx("span", { className: "rounded-md border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground", children: target }, target))) })] }))] })] }));
}
function LinkGroup({ emptyLabel, onOpen, title, titles }) {
    return (_jsxs("div", { children: [_jsx("h3", { className: "pb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground", children: title }), titles.length ? (_jsx("div", { className: "flex flex-wrap gap-1.5", children: titles.map(target => (_jsx("button", { className: "rounded-md border border-border px-2 py-0.5 text-xs hover:bg-accent", onClick: () => onOpen(target), type: "button", children: target }, target))) })) : (_jsx("p", { className: "text-xs text-muted-foreground", children: emptyLabel }))] }));
}
