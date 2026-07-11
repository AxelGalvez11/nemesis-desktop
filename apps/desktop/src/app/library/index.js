import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Library — the notes vault page. A folder tree (left) over recursive Obsidian-compatible
// Markdown, a prose-styled CodeMirror editor (middle, de-code-ified via .nemesis-prose-editor
// CSS), and a collapsible Outline/Links rail (right). Non-markdown files (PDF/images inline;
// slides/docs open externally) preview in place. Autosaves 800ms after typing.
import { IconChevronRight, IconFilePlus, IconFileText, IconFileTypePdf, IconFolder, IconFolderOpen, IconFolderPlus, IconPaperclip, IconPhoto, IconPresentation, IconX } from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { NoteEditor } from './note-editor';
import { NoteRail } from './note-rail';
import { PdfViewer } from './pdf-viewer';
import { buildIndex, createFolder, loadVaultContents, saveNote, SEED_NOTES, VAULT_DIR } from './vault';
function tabKey(tab) {
    return tab.kind === 'note' ? tab.note.path : tab.file.path;
}
function tabLabel(tab) {
    return tab.kind === 'note' ? tab.note.title : tab.file.name;
}
function countWords(value) {
    return value.trim().match(/\S+/g)?.length ?? 0;
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
    const noteEditorRef = useRef(null);
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
    // Re-read the vault when the window regains focus so files the agent moved,
    // renamed, or created while you were away show up without a manual reload.
    // Debounced so an incidental refocus doesn't hammer the disk.
    useEffect(() => {
        let last = 0;
        const onFocus = () => {
            const now = Date.now();
            if (now - last < 1500) {
                return;
            }
            last = now;
            void refresh();
        };
        window.addEventListener('focus', onFocus);
        return () => window.removeEventListener('focus', onFocus);
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
    // Outline tab entries drive the editor imperatively — scrolling to a line isn't
    // something the editor's props model expresses, so this goes through its ref handle.
    const handleSelectHeading = useCallback((line) => {
        noteEditorRef.current?.scrollToLine(line);
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
    const noteCount = contents.notes.length;
    const fileCount = contents.files.length;
    return (_jsxs("div", { className: "flex h-full min-h-0 bg-(--ui-editor-surface-background)", children: [_jsxs("aside", { className: "flex w-64 shrink-0 flex-col border-r border-(--ui-stroke-tertiary) bg-(--ui-sidebar-surface-background)", children: [_jsxs("div", { className: "flex items-center justify-between gap-3 px-4 pb-3 pt-5", children: [_jsxs("div", { className: "min-w-0", children: [_jsx("h1", { className: "text-lg font-semibold tracking-tight", children: "Library" }), _jsxs("p", { className: "mt-0.5 text-[0.65rem] font-medium tabular-nums text-(--ui-text-tertiary)", children: [noteCount, " note", noteCount === 1 ? '' : 's', " \u00B7 ", fileCount, " file", fileCount === 1 ? '' : 's'] })] }), _jsxs("div", { className: "flex gap-0.5", children: [_jsx(Tip, { label: "New note", children: _jsx(Button, { "aria-label": "New note", className: "transition-transform duration-200 ease-out active:scale-[0.98]", onClick: () => { setCreating('note'); setDraft(''); }, size: "icon-xs", variant: "ghost", children: _jsx(IconFilePlus, {}) }) }), _jsx(Tip, { label: "New folder", children: _jsx(Button, { "aria-label": "New folder", className: "transition-transform duration-200 ease-out active:scale-[0.98]", onClick: () => { setCreating('folder'); setDraft(''); }, size: "icon-xs", variant: "ghost", children: _jsx(IconFolderPlus, {}) }) })] })] }), creating && (_jsxs("div", { className: "mx-3 mb-2 rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) p-2 shadow-sm", children: [_jsx(Input, { autoFocus: true, onChange: event => setDraft(event.target.value), onKeyDown: event => {
                                    if (event.key === 'Enter')
                                        void submitCreate();
                                    if (event.key === 'Escape')
                                        setCreating(null);
                                }, placeholder: creating === 'folder' ? 'Folder name' : 'Note title', value: draft }), targetFolder && _jsxs("p", { className: "px-1 pt-1.5 text-[10px] text-muted-foreground", children: ["in ", targetFolder] })] })), _jsx("nav", { className: "min-h-0 flex-1 overflow-y-auto px-2.5 pb-4", children: _jsx(TreeLevel, { collapsed: collapsed, depth: 0, node: tree, onSelect: next => next && openSelection(next), onToggle: path => setCollapsed(current => {
                                const next = new Set(current);
                                next.has(path) ? next.delete(path) : next.add(path);
                                return next;
                            }), selection: selection }) })] }), _jsxs("main", { className: "flex min-w-0 flex-1 flex-col bg-(--ui-bg-editor)", children: [tabs.length > 0 && (_jsx("div", { className: "flex h-(--titlebar-height) shrink-0 overflow-x-auto overflow-y-hidden border-b border-(--ui-stroke-tertiary) bg-(--ui-sidebar-surface-background) [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", role: "tablist", children: tabs.map((tab, i) => (_jsxs("div", { className: cn('group/tab relative flex h-full min-w-0 max-w-48 shrink-0 cursor-pointer items-center border-r border-(--ui-stroke-quaternary) text-[0.6875rem] font-medium transition-colors duration-200 ease-out', i === activeTab
                                ? 'bg-(--ui-bg-editor) text-foreground'
                                : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'), onClick: () => setActiveTab(i), role: "tab", children: [i === activeTab && _jsx("span", { "aria-hidden": true, className: "absolute inset-x-0 top-0 h-px bg-(--theme-primary)" }), _jsxs("span", { className: "flex min-w-0 items-center gap-1.5 py-2 pl-3 pr-8", children: [tab.kind === 'note' ? _jsx(IconFileText, { className: "shrink-0 opacity-60", size: 13 }) : _jsx(FileGlyph, { kind: tab.file.kind }), _jsx("span", { className: "truncate", children: tabLabel(tab) })] }), _jsx("button", { "aria-label": "Close tab", className: "absolute right-1.5 grid size-5 place-items-center rounded opacity-0 transition-[opacity,color] duration-200 ease-out hover:bg-(--chrome-action-hover) group-hover/tab:opacity-100 group-focus-within/tab:opacity-100", onClick: event => {
                                        event.stopPropagation();
                                        closeTab(i);
                                    }, type: "button", children: _jsx(IconX, { size: 11 }) })] }, tabKey(tab)))) })), selection?.kind === 'note' ? (_jsxs(_Fragment, { children: [_jsx("div", { className: "shrink-0 border-b border-(--ui-stroke-quaternary) px-7 pb-4 pt-6", children: _jsxs("div", { className: "flex items-end justify-between gap-6", children: [_jsxs("div", { className: "min-w-0", children: [_jsxs("div", { className: "mb-2 flex min-w-0 items-center gap-1.5 text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--ui-text-tertiary)", children: [_jsx("span", { children: "Library" }), selection.note.folder.split('/').filter(Boolean).map((part, index) => (_jsxs("span", { className: "contents", children: [_jsx(IconChevronRight, { className: "shrink-0 opacity-50", size: 11 }), _jsx("span", { className: "truncate", children: part })] }, `${part}-${index}`)))] }), _jsx("h2", { className: "truncate text-2xl font-semibold tracking-[-0.025em]", children: selection.note.title })] }), _jsxs("div", { className: "flex shrink-0 items-center gap-2 text-[0.6875rem] text-(--ui-text-tertiary)", children: [_jsxs("span", { className: "tabular-nums", children: [countWords(selection.note.content), " words"] }), _jsx("span", { className: "rounded-full border border-(--ui-stroke-tertiary) bg-(--ui-bg-quaternary) px-2.5 py-1 font-medium", children: saving ? 'Saving…' : 'Saved to disk' })] })] }) }), _jsx("div", { className: "min-h-0 flex-1 overflow-hidden px-7 pb-3", children: _jsx(NoteEditor, { initialValue: selection.note.content, onChange: value => scheduleSave(selection.note, value), onOpenWikilink: target => void openWikilink(target), ref: noteEditorRef }, selection.note.path) })] })) : selection?.kind === 'file' ? (_jsx(FilePreview, { file: selection.file })) : (_jsx(EmptyState, { className: "flex-1", description: "Pick a note on the left, or create one.", title: "No note open" }))] }), activeNote && index && (_jsx(NoteRail, { activeNote: activeNote, index: index, notes: contents.notes, onOpenNote: note => openSelection({ kind: 'note', note }), onSelectHeading: handleSelectHeading }))] }));
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
    return _jsx(Icon, { className: "shrink-0 opacity-60", size: 14 });
}
function TreeLevel({ collapsed, depth, node, onSelect, onToggle, selection }) {
    return (_jsxs("div", { className: cn('space-y-0.5', depth > 0 && 'ml-3 border-l border-(--ui-stroke-quaternary) pl-1.5'), children: [node.folders
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(folder => {
                const isCollapsed = collapsed.has(folder.path);
                return (_jsxs("div", { className: "pb-0.5", children: [_jsxs("button", { className: "group/folder flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[0.68rem] font-semibold uppercase tracking-[0.075em] text-(--ui-text-secondary) transition-[transform,color,background-color] duration-200 ease-out hover:bg-(--ui-row-hover-background) hover:text-foreground active:scale-[0.98]", onClick: () => onToggle(folder.path), type: "button", children: [_jsx(IconChevronRight, { className: cn('shrink-0 transition-transform duration-200 ease-out', !isCollapsed && 'rotate-90'), size: 12 }), isCollapsed ? (_jsx(IconFolder, { className: "shrink-0 text-(--ui-text-tertiary) group-hover/folder:text-(--theme-primary)", size: 14 })) : (_jsx(IconFolderOpen, { className: "shrink-0 text-(--theme-primary)", size: 14 })), _jsx("span", { className: "truncate", children: folder.name })] }), !isCollapsed && (_jsx(TreeLevel, { collapsed: collapsed, depth: depth + 1, node: folder, onSelect: onSelect, onToggle: onToggle, selection: selection }))] }, folder.path));
            }), node.notes
                .slice()
                .sort((a, b) => a.title.localeCompare(b.title))
                .map(note => (_jsxs("button", { className: cn('relative flex w-full items-center gap-2 truncate rounded-lg px-2 py-1.5 text-left text-[0.8125rem] text-(--ui-text-secondary) transition-[transform,color,background-color] duration-200 ease-out before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-transparent hover:bg-(--ui-row-hover-background) hover:text-foreground active:scale-[0.98]', selection?.kind === 'note' && selection.note.path === note.path && 'font-semibold text-foreground before:bg-(--theme-primary)'), onClick: () => onSelect({ kind: 'note', note }), type: "button", children: [_jsx(IconFileText, { className: "shrink-0 opacity-55", size: 14 }), _jsx("span", { className: "truncate", children: note.title })] }, note.path))), node.files
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(file => (_jsxs("button", { className: cn('relative flex w-full items-center gap-2 truncate rounded-lg px-2 py-1.5 text-left text-[0.8125rem] text-(--ui-text-tertiary) transition-[transform,color,background-color] duration-200 ease-out before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-transparent hover:bg-(--ui-row-hover-background) hover:text-foreground active:scale-[0.98]', selection?.kind === 'file' && selection.file.path === file.path && 'font-semibold text-foreground before:bg-(--theme-primary)'), onClick: () => onSelect({ file, kind: 'file' }), type: "button", children: [_jsx(FileGlyph, { kind: file.kind }), _jsx("span", { className: "truncate", children: file.name })] }, file.path)))] }));
}
function fileUrl(path) {
    return `file://${encodeURI(path).replace(/#/g, '%23')}`;
}
function FilePreview({ file }) {
    const url = fileUrl(file.path);
    const openExternal = () => void window.hermesDesktop?.openExternal?.(url);
    const reveal = () => void window.hermesDesktop?.revealPath?.(file.path);
    return (_jsxs("div", { className: "flex min-h-0 flex-1 flex-col bg-(--ui-bg-editor)", children: [_jsxs("div", { className: "flex items-end justify-between gap-4 border-b border-(--ui-stroke-quaternary) px-6 pb-4 pt-6", children: [_jsxs("div", { className: "min-w-0", children: [_jsxs("p", { className: "mb-1.5 text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--ui-text-tertiary)", children: [file.folder || 'Library', " \u00B7 ", file.kind] }), _jsx("h2", { className: "truncate text-xl font-semibold tracking-tight", children: file.name })] }), _jsxs("div", { className: "flex gap-2", children: [_jsx(Button, { onClick: openExternal, size: "sm", variant: "outline", children: "Open in default app" }), _jsx(Button, { onClick: reveal, size: "sm", variant: "outline", children: "Reveal" })] })] }), _jsx("div", { className: "min-h-0 flex-1 px-5 pb-5", children: file.kind === 'pdf' ? (_jsx(PdfViewer, { path: file.path })) : file.kind === 'html' ? (_jsx("iframe", { className: "h-full w-full rounded-lg border border-border bg-white", sandbox: "", src: url, title: file.name })) : file.kind === 'image' ? (_jsx("div", { className: "grid h-full place-items-center rounded-lg border border-border bg-card p-4", children: _jsx("img", { alt: file.name, className: "max-h-full max-w-full object-contain", src: url }) })) : (_jsx(EmptyState, { className: "h-full", description: file.kind === 'slides'
                        ? 'PowerPoint/Keynote files open in their own app — click “Open in default app”.'
                        : 'This file type opens in its own app — click “Open in default app”.', title: file.name })) })] }));
}
