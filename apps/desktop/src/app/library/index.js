import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Library — the notes vault page. A folder tree (left) over recursive Obsidian-compatible
// Markdown, a prose-styled CodeMirror editor (middle, de-code-ified via .nemesis-prose-editor
// CSS), and a Links/Backlinks rail. Non-markdown files (PDF/images inline; slides/docs open
// externally) preview in place. Autosaves 800ms after typing.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CodeEditor } from '@/components/chat/code-editor';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { buildIndex, createFolder, extractWikilinks, loadVaultContents, saveNote, SEED_NOTES, VAULT_DIR } from './vault';
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
    const [selection, setSelection] = useState(null);
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
    useEffect(() => {
        void (async () => {
            const loaded = await refresh();
            if (loaded && !selection && loaded.notes[0]) {
                setSelection({ kind: 'note', note: loaded.notes[0] });
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
    // Deep link from the Graph page: /library?note=Title
    useEffect(() => {
        const requested = searchParams.get('note');
        if (requested && contents) {
            const note = contents.notes.find(n => n.title === requested);
            if (note) {
                setSelection({ kind: 'note', note });
            }
        }
    }, [contents, searchParams]);
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
                setSelection({ kind: 'note', note });
            }
        }
    }, [creating, draft, refresh, targetFolder]);
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
                                }, placeholder: creating === 'folder' ? 'Folder name' : 'Note title', value: draft }), targetFolder && _jsxs("p", { className: "px-1 pt-1 text-[10px] text-muted-foreground", children: ["in ", targetFolder] })] })), _jsx("nav", { className: "min-h-0 flex-1 overflow-y-auto px-2 pb-4", children: _jsx(TreeLevel, { collapsed: collapsed, depth: 0, node: tree, onSelect: setSelection, onToggle: path => setCollapsed(current => {
                                const next = new Set(current);
                                next.has(path) ? next.delete(path) : next.add(path);
                                return next;
                            }), selection: selection }) })] }), _jsx("main", { className: "flex min-w-0 flex-1 flex-col", children: selection?.kind === 'note' ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: "flex items-center justify-between px-5 pb-1 pt-5", children: [_jsx("h2", { className: "truncate text-base font-medium", children: selection.note.title }), _jsx("span", { className: "text-xs text-muted-foreground", children: saving ? 'Saving…' : 'Saved to disk' })] }), _jsx("div", { className: "nemesis-prose-editor min-h-0 flex-1 px-6 pb-3", children: _jsx(CodeEditor, { filePath: selection.note.path, initialValue: selection.note.content, onChange: value => scheduleSave(selection.note, value) }, selection.note.path) })] })) : selection?.kind === 'file' ? (_jsx(FilePreview, { file: selection.file })) : (_jsx(EmptyState, { className: "flex-1", description: "Pick a note on the left, or create one.", title: "No note open" })) }), activeNote && (_jsxs("aside", { className: "hidden w-56 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border px-4 pb-4 pt-5 lg:flex", children: [_jsx(LinkGroup, { emptyLabel: "Write [[Note title]] to connect ideas.", onOpen: title => {
                            const note = contents.notes.find(n => n.title === title);
                            if (note)
                                setSelection({ kind: 'note', note });
                        }, title: "Links", titles: outgoing }), _jsx(LinkGroup, { emptyLabel: "Nothing links here yet.", onOpen: title => {
                            const note = contents.notes.find(n => n.title === title);
                            if (note)
                                setSelection({ kind: 'note', note });
                        }, title: "Backlinks", titles: incoming }), unresolved.length > 0 && (_jsxs("div", { children: [_jsx("h3", { className: "pb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground", children: "Unresolved" }), _jsx("div", { className: "flex flex-wrap gap-1.5", children: unresolved.map(target => (_jsx("span", { className: "rounded-md border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground", children: target }, target))) })] }))] }))] }));
}
const FILE_ICON = { doc: '📄', image: '🖼', other: '📎', pdf: '📕', slides: '📊' };
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
                .map(file => (_jsxs("button", { className: cn('block w-full truncate rounded-md py-1.5 pr-2 text-left text-sm text-muted-foreground hover:bg-accent', selection?.kind === 'file' && selection.file.path === file.path && 'bg-accent text-accent-foreground'), onClick: () => onSelect({ file, kind: 'file' }), style: pad, type: "button", children: [FILE_ICON[file.kind], " ", file.name] }, file.path)))] }));
}
function fileUrl(path) {
    return `file://${encodeURI(path).replace(/#/g, '%23')}`;
}
function FilePreview({ file }) {
    const url = fileUrl(file.path);
    const openExternal = () => void window.hermesDesktop?.openExternal?.(url);
    const reveal = () => void window.hermesDesktop?.revealPath?.(file.path);
    return (_jsxs("div", { className: "flex min-h-0 flex-1 flex-col", children: [_jsxs("div", { className: "flex items-center justify-between gap-2 px-5 pb-2 pt-5", children: [_jsx("h2", { className: "truncate text-base font-medium", children: file.name }), _jsxs("div", { className: "flex gap-2", children: [_jsx(Button, { onClick: openExternal, size: "sm", variant: "outline", children: "Open in default app" }), _jsx(Button, { onClick: reveal, size: "sm", variant: "outline", children: "Reveal" })] })] }), _jsx("div", { className: "min-h-0 flex-1 px-5 pb-5", children: file.kind === 'pdf' ? (_jsx("iframe", { className: "h-full w-full rounded-lg border border-border bg-white", src: url, title: file.name })) : file.kind === 'image' ? (_jsx("div", { className: "grid h-full place-items-center rounded-lg border border-border bg-card p-4", children: _jsx("img", { alt: file.name, className: "max-h-full max-w-full object-contain", src: url }) })) : (_jsx(EmptyState, { className: "h-full", description: file.kind === 'slides'
                        ? 'PowerPoint/Keynote files open in their own app — click “Open in default app”.'
                        : 'This file type opens in its own app — click “Open in default app”.', title: `${FILE_ICON[file.kind]} ${file.name}` })) })] }));
}
function LinkGroup({ emptyLabel, onOpen, title, titles }) {
    return (_jsxs("div", { children: [_jsx("h3", { className: "pb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground", children: title }), titles.length ? (_jsx("div", { className: "flex flex-wrap gap-1.5", children: titles.map(target => (_jsx("button", { className: "rounded-md border border-border px-2 py-0.5 text-xs hover:bg-accent", onClick: () => onOpen(target), type: "button", children: target }, target))) })) : (_jsx("p", { className: "text-xs text-muted-foreground", children: emptyLabel }))] }));
}
