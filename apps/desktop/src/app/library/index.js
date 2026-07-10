import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Library — the notes vault page. A folder tree (left) over recursive Obsidian-compatible
// Markdown, a prose-styled CodeMirror editor (middle, de-code-ified via .nemesis-prose-editor
// CSS), and a Links/Backlinks rail. Non-markdown files (PDF/images inline; slides/docs open
// externally) preview in place. Autosaves 800ms after typing.
import { IconFileText, IconFileTypePdf, IconPaperclip, IconPhoto, IconPresentation, IconX } from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { NoteEditor } from './note-editor';
import { PdfViewer } from './pdf-viewer';
import { buildIndex, createFolder, extractWikilinks, loadVaultContents, saveNote, SEED_NOTES, VAULT_DIR } from './vault';
function tabKey(tab) {
    return tab.kind === 'note' ? tab.note.path : tab.file.path;
}
function tabLabel(tab) {
    return tab.kind === 'note' ? tab.note.title : tab.file.name;
}
function buildTree(contents) {
    const root = { files: [], folders: [], name: '', notes: [], path: '' };
    const nodeFor = (folder) => {
        if (!folder) {
            return root;
        }
        let node = root;
        for (const part of folder.split('/')) {
            const next = node.folders.find(child => child.name === part);
            if (next) {
                node = next;
            }
            else {
                const created = { files: [], folders: [], name: part, notes: [], path: node.path ? `${node.path}/${part}` : part };
                node.folders.push(created);
                node = created;
            }
        }
        return node;
    };
    for (const folder of contents.folders) {
        nodeFor(folder);
    }
    for (const note of contents.notes) {
        nodeFor(note.folder).notes.push(note);
    }
    for (const file of contents.files) {
        nodeFor(file.folder).files.push(file);
    }
    return root;
}
export function LibraryView() {
    const [contents, setContents] = useState(null);
    const [error, setError] = useState(null);
    // Obsidian-style tabs: every opened note/file gets (or refocuses) a tab.
    const [tabs, setTabs] = useState([]);
    const [activeTab, setActiveTab] = useState(0);
    const [collapsed, setCollapsed] = useState(new Set());
    const [creating, setCreating] = useState(null);
    const [draft, setDraft] = useState('');
    const [saving, setSaving] = useState(false);
    const [searchParams] = useSearchParams();
    const saveTimer = useRef(null);
    const refresh = useCallback(async () => {
        try {
            let loaded = await loadVaultContents();
            if (!loaded.notes.length && !loaded.files.length) {
                for (const seed of SEED_NOTES) {
                    await saveNote(seed.title, seed.content);
                }
                loaded = await loadVaultContents();
            }
            setContents(loaded);
            setError(null);
            return loaded;
        }
        catch (err) {
            setError(err instanceof Error ? err.message : 'Could not open the Library folder.');
            return null;
        }
    }, []);
    const openSelection = useCallback((next) => {
        const key = tabKey(next);
        setTabs(current => {
            const existing = current.findIndex(tab => tabKey(tab) === key);
            if (existing >= 0) {
                setActiveTab(existing);
                return current;
            }
            setActiveTab(current.length);
            return [...current, next];
        });
    }, []);
    const closeTab = useCallback((index) => {
        setTabs(current => current.filter((_, i) => i !== index));
        setActiveTab(current => (index < current ? current - 1 : Math.max(0, Math.min(current, tabs.length - 2))));
    }, [tabs.length]);
    useEffect(() => {
        void (async () => {
            const loaded = await refresh();
            if (loaded && tabs.length === 0 && loaded.notes[0]) {
                openSelection({ kind: 'note', note: loaded.notes[0] });
            }
        })();
        return () => {
            if (saveTimer.current) {
                clearTimeout(saveTimer.current);
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [refresh]);
    const tree = useMemo(() => (contents ? buildTree(contents) : null), [contents]);
    const index = useMemo(() => (contents ? buildIndex(contents.notes) : null), [contents]);
    // Deep links from the Graph page: /library?note=Title opens a note,
    // /library?create=note lands with the new-note field already open.
    useEffect(() => {
        const requested = searchParams.get('note');
        if (requested && contents) {
            const note = contents.notes.find(n => n.title === requested);
            if (note) {
                openSelection({ kind: 'note', note });
            }
        }
        if (searchParams.get('create') === 'note') {
            setCreating('note');
            setDraft('');
        }
    }, [contents, openSelection, searchParams]);
    // Tabs hold snapshots; always render the freshest note object from `contents`
    // so switching back to a tab shows the edits made since it was opened.
    const selection = useMemo(() => {
        const tab = tabs[activeTab];
        if (!tab) {
            return null;
        }
        if (tab.kind === 'note' && contents) {
            const fresh = contents.notes.find(note => note.path === tab.note.path);
            return { kind: 'note', note: fresh ?? tab.note };
        }
        return tab;
    }, [activeTab, contents, tabs]);
    const activeNote = selection?.kind === 'note' ? selection.note : null;
    const scheduleSave = useCallback((note, content) => {
        setContents(current => current
            ? { ...current, notes: current.notes.map(n => (n.path === note.path ? { ...n, content } : n)) }
            : current);
        if (saveTimer.current) {
            clearTimeout(saveTimer.current);
        }
        saveTimer.current = setTimeout(() => {
            setSaving(true);
            void saveNote(note.title, content, note.folder).finally(() => setSaving(false));
        }, 800);
    }, []);
    const targetFolder = selection?.kind === 'note' ? selection.note.folder : selection?.kind === 'file' ? selection.file.folder : '';
    // Click a [[wikilink]] in the editor: open the note if it exists, create it if not —
    // the Obsidian affordance that makes links feel alive.
    const openWikilink = useCallback(async (target) => {
        const loaded = contents ?? (await refresh());
        if (!loaded) {
            return;
        }
        const existing = loaded.notes.find(n => n.title.toLowerCase() === target.toLowerCase());
        if (existing) {
            openSelection({ kind: 'note', note: existing });
            return;
        }
        await saveNote(target, `# ${target}\n\n`);
        const after = await refresh();
        const created = after?.notes.find(n => n.title.toLowerCase() === target.toLowerCase());
        if (created) {
            openSelection({ kind: 'note', note: created });
        }
    }, [contents, openSelection, refresh]);
    const submitCreate = useCallback(async () => {
        const name = draft.trim();
        if (!name) {
            return;
        }
        if (creating === 'folder') {
            await createFolder(targetFolder ? `${targetFolder}/${name}` : name);
        }
        else {
            await saveNote(name, `# ${name}\n\n`, targetFolder);
        }
        setDraft('');
        const mode = creating;
        setCreating(null);
        const loaded = await refresh();
        if (mode === 'note' && loaded) {
            const note = loaded.notes.find(n => n.title === name && n.folder === targetFolder);
            if (note) {
                openSelection({ kind: 'note', note });
            }
        }
    }, [creating, draft, openSelection, refresh, targetFolder]);
    if (error) {
        return _jsx(EmptyState, { className: "h-full", description: `${error} (${VAULT_DIR})`, title: "Library unavailable" });
    }
    if (!contents || !tree) {
        return _jsx(EmptyState, { className: "h-full", description: "Opening your vault\u2026", title: "Library" });
    }
    const outgoing = activeNote && index ? (index.links.get(activeNote.title) ?? []) : [];
    const incoming = activeNote && index ? (index.backlinks.get(activeNote.title) ?? []) : [];
    const unresolved = activeNote
        ? extractWikilinks(activeNote.content).filter(target => !contents.notes.some(note => note.title.toLowerCase() === target.toLowerCase()))
        : [];
    return (_jsxs("div", { className: "flex h-full min-h-0", children: [_jsxs("aside", { className: "flex w-64 shrink-0 flex-col border-r border-border", children: [_jsxs("div", { className: "flex items-center justify-between gap-2 px-4 pb-2 pt-5", children: [_jsx("h1", { className: "text-lg font-semibold", children: "Library" }), _jsxs("div", { className: "flex gap-1", children: [_jsx(Button, { className: "h-7 px-2 text-xs", onClick: () => { setCreating('note'); setDraft(''); }, size: "sm", variant: "outline", children: "+ Note" }), _jsx(Button, { className: "h-7 px-2 text-xs", onClick: () => { setCreating('folder'); setDraft(''); }, size: "sm", variant: "outline", children: "+ Folder" })] })] }), creating && (_jsxs("div", { className: "px-3 pb-2", children: [_jsx(Input, { autoFocus: true, onChange: event => setDraft(event.target.value), onKeyDown: event => {
                                    if (event.key === 'Enter')
                                        void submitCreate();
                                    if (event.key === 'Escape')
                                        setCreating(null);
                                }, placeholder: creating === 'folder' ? 'Folder name' : 'Note title', value: draft }), targetFolder && _jsxs("p", { className: "px-1 pt-1 text-[10px] text-muted-foreground", children: ["in ", targetFolder] })] })), _jsx("nav", { className: "min-h-0 flex-1 overflow-y-auto px-2 pb-4", children: _jsx(TreeLevel, { collapsed: collapsed, depth: 0, node: tree, onSelect: next => next && openSelection(next), onToggle: path => setCollapsed(current => {
                                const next = new Set(current);
                                next.has(path) ? next.delete(path) : next.add(path);
                                return next;
                            }), selection: selection }) })] }), _jsxs("main", { className: "flex min-w-0 flex-1 flex-col", children: [tabs.length > 0 && (_jsx("div", { className: "flex shrink-0 items-end gap-0.5 overflow-x-auto border-b border-border px-2 pt-2", children: tabs.map((tab, i) => (_jsxs("div", { className: cn('group/tab flex max-w-[13rem] shrink-0 cursor-pointer items-center gap-1 rounded-t-md border border-b-0 px-2.5 py-1.5 text-xs transition-colors', i === activeTab
                                ? 'border-border bg-card text-foreground'
                                : 'border-transparent text-muted-foreground hover:text-foreground'), onClick: () => setActiveTab(i), children: [_jsx("span", { className: "truncate", children: tabLabel(tab) }), _jsx("button", { "aria-label": "Close tab", className: "rounded p-0.5 opacity-0 transition-opacity hover:bg-accent group-hover/tab:opacity-100", onClick: event => {
                                        event.stopPropagation();
                                        closeTab(i);
                                    }, type: "button", children: _jsx(IconX, { size: 11 }) })] }, tabKey(tab)))) })), selection?.kind === 'note' ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: "flex items-center justify-between px-5 pb-1 pt-5", children: [_jsx("h2", { className: "truncate text-base font-medium", children: selection.note.title }), _jsx("span", { className: "text-xs text-muted-foreground", children: saving ? 'Saving…' : 'Saved to disk' })] }), _jsx("div", { className: "min-h-0 flex-1 overflow-hidden px-6 pb-3", children: _jsx(NoteEditor, { initialValue: selection.note.content, onChange: value => scheduleSave(selection.note, value), onOpenWikilink: target => void openWikilink(target) }, selection.note.path) })] })) : selection?.kind === 'file' ? (_jsx(FilePreview, { file: selection.file })) : (_jsx(EmptyState, { className: "flex-1", description: "Pick a note on the left, or create one.", title: "No note open" }))] }), activeNote && (_jsxs("aside", { className: "hidden w-56 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border px-4 pb-4 pt-5 lg:flex", children: [_jsx(LinkGroup, { emptyLabel: "Write [[Note title]] to connect ideas.", onOpen: title => {
                            const note = contents.notes.find(n => n.title === title);
                            if (note)
                                openSelection({ kind: 'note', note });
                        }, title: "Links", titles: outgoing }), _jsx(LinkGroup, { emptyLabel: "Nothing links here yet.", onOpen: title => {
                            const note = contents.notes.find(n => n.title === title);
                            if (note)
                                openSelection({ kind: 'note', note });
                        }, title: "Backlinks", titles: incoming }), unresolved.length > 0 && (_jsxs("div", { children: [_jsx("h3", { className: "pb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground", children: "Unresolved" }), _jsx("div", { className: "flex flex-wrap gap-1.5", children: unresolved.map(target => (_jsx("span", { className: "rounded-md border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground", children: target }, target))) })] }))] }))] }));
}
function FileGlyph({ kind }) {
    const Icon = kind === 'pdf'
        ? IconFileTypePdf
        : kind === 'html'
            ? IconPresentation
            : kind === 'slides'
                ? IconPresentation
                : kind === 'image'
                    ? IconPhoto
                    : kind === 'doc'
                        ? IconFileText
                        : IconPaperclip;
    return _jsx(Icon, { className: "-mt-px mr-1.5 inline shrink-0 opacity-70", size: 14 });
}
function TreeLevel({ collapsed, depth, node, onSelect, onToggle, selection }) {
    const pad = { paddingLeft: `${depth * 12 + 8}px` };
    return (_jsxs(_Fragment, { children: [node.folders
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(folder => {
                const isCollapsed = collapsed.has(folder.path);
                return (_jsxs("div", { children: [_jsxs("button", { className: "flex w-full items-center gap-1 rounded-md py-1 pr-2 text-left text-sm text-foreground hover:bg-accent", onClick: () => onToggle(folder.path), style: pad, type: "button", children: [_jsx("span", { className: cn('inline-block transition-transform', !isCollapsed && 'rotate-90'), children: "\u25B8" }), _jsx("span", { className: "truncate", children: folder.name })] }), !isCollapsed && (_jsx(TreeLevel, { collapsed: collapsed, depth: depth + 1, node: folder, onSelect: onSelect, onToggle: onToggle, selection: selection }))] }, folder.path));
            }), node.notes
                .slice()
                .sort((a, b) => a.title.localeCompare(b.title))
                .map(note => (_jsx("button", { className: cn('block w-full truncate rounded-md py-1.5 pr-2 text-left text-sm hover:bg-accent', selection?.kind === 'note' && selection.note.path === note.path && 'bg-accent text-accent-foreground'), onClick: () => onSelect({ kind: 'note', note }), style: pad, type: "button", children: note.title }, note.path))), node.files
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(file => (_jsxs("button", { className: cn('block w-full truncate rounded-md py-1.5 pr-2 text-left text-sm text-muted-foreground hover:bg-accent', selection?.kind === 'file' && selection.file.path === file.path && 'bg-accent text-accent-foreground'), onClick: () => onSelect({ file, kind: 'file' }), style: pad, type: "button", children: [_jsx(FileGlyph, { kind: file.kind }), file.name] }, file.path)))] }));
}
function fileUrl(path) {
    return `file://${encodeURI(path).replace(/#/g, '%23')}`;
}
function FilePreview({ file }) {
    const url = fileUrl(file.path);
    const openExternal = () => void window.hermesDesktop?.openExternal?.(url);
    const reveal = () => void window.hermesDesktop?.revealPath?.(file.path);
    return (_jsxs("div", { className: "flex min-h-0 flex-1 flex-col", children: [_jsxs("div", { className: "flex items-center justify-between gap-2 px-5 pb-2 pt-5", children: [_jsx("h2", { className: "truncate text-base font-medium", children: file.name }), _jsxs("div", { className: "flex gap-2", children: [_jsx(Button, { onClick: openExternal, size: "sm", variant: "outline", children: "Open in default app" }), _jsx(Button, { onClick: reveal, size: "sm", variant: "outline", children: "Reveal" })] })] }), _jsx("div", { className: "min-h-0 flex-1 px-5 pb-5", children: file.kind === 'pdf' ? (_jsx(PdfViewer, { path: file.path })) : file.kind === 'html' ? (_jsx("iframe", { className: "h-full w-full rounded-lg border border-border bg-white", sandbox: "", src: url, title: file.name })) : file.kind === 'image' ? (_jsx("div", { className: "grid h-full place-items-center rounded-lg border border-border bg-card p-4", children: _jsx("img", { alt: file.name, className: "max-h-full max-w-full object-contain", src: url }) })) : (_jsx(EmptyState, { className: "h-full", description: file.kind === 'slides'
                        ? 'PowerPoint/Keynote files open in their own app — click “Open in default app”.'
                        : 'This file type opens in its own app — click “Open in default app”.', title: file.name })) })] }));
}
function LinkGroup({ emptyLabel, onOpen, title, titles }) {
    return (_jsxs("div", { children: [_jsx("h3", { className: "pb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground", children: title }), titles.length ? (_jsx("div", { className: "flex flex-wrap gap-1.5", children: titles.map(target => (_jsx("button", { className: "rounded-md border border-border px-2 py-0.5 text-xs hover:bg-accent", onClick: () => onOpen(target), type: "button", children: target }, target))) })) : (_jsx("p", { className: "text-xs text-muted-foreground", children: emptyLabel }))] }));
}
