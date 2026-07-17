import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Library — the notes vault page. A folder tree (left) over recursive Obsidian-compatible
// Markdown, a prose-styled CodeMirror editor (middle, de-code-ified via .nemesis-prose-editor
// CSS), and a collapsible Outline/Links rail (right). Non-markdown files (PDF/images inline;
// slides/docs open externally) preview in place. Autosaves 800ms after typing.
import { IconArrowLeft, IconArrowRight, IconChevronRight, IconFilePlus, IconFileText, IconFileTypePdf, IconFolder, IconFolderOpen, IconFolderPlus, IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand, IconLayoutSidebarRightExpand, IconPaperclip, IconPencil, IconPhoto, IconPresentation, IconSparkles, IconTrash, IconX } from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { SearchField } from '@/components/ui/search-field';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { NEMESIS_STUDENT_BUILD } from '@/nemesis';
import { seedComposerDraft } from '@/store/composer';
import { getRememberedSessionId } from '@/store/session';
import { NEW_CHAT_ROUTE, sessionRoute } from '../routes';
import { buildResolvableTitleSet, findLinkedNote, isWikilinkResolved, rewriteWikilinks } from './links';
import { isPathWithin, remappedPath } from './nav-remap';
import { NoteEditor } from './note-editor';
import { NoteRail } from './note-rail';
import { PdfViewer } from './pdf-viewer';
import { RenameDialog } from './rename-dialog';
import { searchNotes } from './search';
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
const SIDEBAR_KEY = 'nemesis.library.sidebar.v1';
// Outline/Links rail visibility — owned here (not by NoteRail) so hiding it unmounts
// the rail and the editor reclaims the width, exactly like the left sidebar.
const RAIL_KEY = 'nemesis.library.rail.v1';
// Folder-tree expansion, persisted. Folders start COLLAPSED (empty set) so a big vault
// opens tidy; only folders the student explicitly opened stay open across sessions.
const EXPANDED_KEY = 'nemesis.library.expanded.v1';
export function recordNavVisit(current, next) {
    const atCursor = current.pos >= 0 ? current.stack[current.pos] : undefined;
    if (atCursor && tabKey(atCursor) === tabKey(next)) {
        return current;
    }
    const stack = [...current.stack.slice(0, current.pos + 1), next].slice(-60);
    return { pos: stack.length - 1, stack };
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
                const created = {
                    files: [],
                    folders: [],
                    name: part,
                    notes: [],
                    path: node.path ? `${node.path}/${part}` : part
                };
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
    const [expanded, setExpanded] = useState(() => {
        try {
            const raw = window.localStorage.getItem(EXPANDED_KEY);
            return new Set(raw ? JSON.parse(raw) : []);
        }
        catch {
            return new Set();
        }
    });
    const [creating, setCreating] = useState(null);
    const [draft, setDraft] = useState('');
    const [saving, setSaving] = useState(false);
    const [renameTarget, setRenameTarget] = useState(null);
    const [deleteTarget, setDeleteTarget] = useState(null);
    // Global search: the input's live value vs. the debounced value actually used to filter,
    // so typing feels instant while re-filtering doesn't run on every keystroke.
    const [searchInput, setSearchInput] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const searchDebounceRef = useRef(null);
    const [searchParams] = useSearchParams();
    const saveTimer = useRef(null);
    // The note+content behind the currently-pending debounced save, if any — so a rename can
    // flush it to disk first instead of letting a stale write recreate the old filename after
    // the file has already moved.
    const pendingSaveRef = useRef(null);
    const noteEditorRef = useRef(null);
    // Folder-tree sidebar visibility (persisted) + browser-style visit history.
    const [sidebarOpen, setSidebarOpen] = useState(() => {
        try {
            return window.localStorage.getItem(SIDEBAR_KEY) !== '0';
        }
        catch {
            return true;
        }
    });
    const [railOpen, setRailOpen] = useState(() => {
        try {
            return window.localStorage.getItem(RAIL_KEY) !== '0';
        }
        catch {
            return true;
        }
    });
    const [nav, setNavState] = useState({ pos: -1, stack: [] });
    const navRef = useRef(nav);
    navRef.current = nav;
    // Latest active-tab index, read inside setTabs updaters where the closed-over
    // `activeTab` would be stale (openInPlace needs to know which tab to swap).
    const activeTabRef = useRef(activeTab);
    activeTabRef.current = activeTab;
    // Set while a back/forward jump re-opens an entry, so the jump itself
    // doesn't get recorded as a fresh visit.
    const navigatingRef = useRef(false);
    const setSidebar = useCallback((open) => {
        setSidebarOpen(open);
        try {
            window.localStorage.setItem(SIDEBAR_KEY, open ? '1' : '0');
        }
        catch {
            // persistence is best-effort
        }
    }, []);
    const setRail = useCallback((open) => {
        setRailOpen(open);
        try {
            window.localStorage.setItem(RAIL_KEY, open ? '1' : '0');
        }
        catch {
            // persistence is best-effort
        }
    }, []);
    const startCreating = useCallback((mode) => {
        setSidebar(true);
        setCreating(mode);
        setDraft('');
    }, [setSidebar]);
    // Debounced global search: the input updates immediately, the query that actually
    // drives filtering lags by 150ms so fast typing doesn't re-filter on every keystroke.
    const onSearchChange = useCallback((value) => {
        setSearchInput(value);
        if (searchDebounceRef.current) {
            clearTimeout(searchDebounceRef.current);
        }
        searchDebounceRef.current = setTimeout(() => setSearchQuery(value), 150);
    }, []);
    const clearSearch = useCallback(() => {
        if (searchDebounceRef.current) {
            clearTimeout(searchDebounceRef.current);
            searchDebounceRef.current = null;
        }
        setSearchInput('');
        setSearchQuery('');
    }, []);
    const recordVisit = useCallback((next) => {
        if (navigatingRef.current) {
            return;
        }
        setNavState(current => recordNavVisit(current, next));
    }, []);
    const refresh = useCallback(async () => {
        try {
            let loaded = await loadVaultContents();
            // Student build: a fresh Library stays EMPTY — the agent fills it with the
            // student's real material. Demo seeds read as mystery leftover notes on a
            // fresh install (owner report, beta.14: "restarted fresh, still showed ACE
            // inhibitors"). Dev builds keep the seeds so Library/Graph demo themselves.
            if (!NEMESIS_STUDENT_BUILD && !loaded.notes.length && !loaded.files.length) {
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
        recordVisit(next);
    }, [recordVisit]);
    // Follow a link (a [[wikilink]] in a note, a rail backlink, or back/forward) WITHOUT
    // spawning a new tab: swap the ACTIVE tab's content in place — the browser/Obsidian
    // model the owner asked for. Only the sidebar tree opens fresh tabs (openSelection).
    // If the target is already open in another tab, focus that instead of duplicating.
    const openInPlace = useCallback((next) => {
        const key = tabKey(next);
        setTabs(current => {
            const existing = current.findIndex(tab => tabKey(tab) === key);
            if (existing >= 0) {
                setActiveTab(existing);
                return current;
            }
            const idx = activeTabRef.current;
            if (idx < 0 || idx >= current.length) {
                setActiveTab(current.length);
                return [...current, next];
            }
            // Keep the same tab index; replace only its content.
            return current.map((tab, i) => (i === idx ? next : tab));
        });
        recordVisit(next);
    }, [recordVisit]);
    // Back/forward over the visit history — navigates IN PLACE (same tab) so it stays
    // consistent with link-following, without recording the jump as a new visit.
    const goHistory = useCallback((delta) => {
        const { pos, stack } = navRef.current;
        const target = stack[pos + delta];
        if (!target) {
            return;
        }
        navigatingRef.current = true;
        openInPlace(target);
        navigatingRef.current = false;
        setNavState({ pos: pos + delta, stack });
    }, [openInPlace]);
    // Cmd+N = new note, Cmd+[ / Cmd+] = back / forward (skipped while typing in
    // the editor, where CodeMirror owns bracket shortcuts for indentation).
    useEffect(() => {
        const onKey = (event) => {
            if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) {
                return;
            }
            const inEditor = event.target instanceof HTMLElement && Boolean(event.target.closest('.cm-editor'));
            if (event.key === 'n') {
                event.preventDefault();
                startCreating('note');
            }
            else if (event.key === '[' && !inEditor) {
                event.preventDefault();
                goHistory(-1);
            }
            else if (event.key === ']' && !inEditor) {
                event.preventDefault();
                goHistory(1);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [goHistory, startCreating]);
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
            if (searchDebounceRef.current) {
                clearTimeout(searchDebounceRef.current);
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
    // Every title/path a [[wikilink]] can resolve to — feeds both the editor's
    // resolved-vs-unresolved link styling and (via isWikilinkResolved) openWikilink below,
    // so the two never disagree about whether a given link would create a new note.
    const resolvable = useMemo(() => buildResolvableTitleSet(contents?.notes ?? []), [contents]);
    // Non-empty only while actively searching — the sidebar swaps the folder tree for this
    // flat list (see the `searchQuery.trim()` branch below).
    const searchHits = useMemo(() => (searchQuery.trim() ? searchNotes(contents?.notes ?? [], searchQuery) : []), [contents, searchQuery]);
    const isSearching = searchQuery.trim().length > 0;
    // Vault images only — an Obsidian "![[name]]" embed should resolve to a picture, not a
    // stray PDF/slide deck that happens to share a name.
    const imageFiles = useMemo(() => (contents?.files ?? []).filter(file => file.kind === 'image'), [contents]);
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
            startCreating('note');
        }
    }, [contents, openSelection, searchParams, startCreating]);
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
    const navigate = useNavigate();
    // Library's one line to the agent: land in the CURRENT conversation (owner
    // call — no new session per click), pre-filling the composer with whatever
    // is open so the request lands anchored.
    const askAgent = useCallback(() => {
        const lastSession = getRememberedSessionId();
        if (selection?.kind === 'note') {
            seedComposerDraft(`About my note "${selection.note.title}": `, lastSession);
        }
        else if (selection?.kind === 'file') {
            seedComposerDraft(`About "${selection.file.name}" in my Library: `, lastSession);
        }
        navigate(lastSession ? sessionRoute(lastSession) : NEW_CHAT_ROUTE);
    }, [navigate, selection]);
    const scheduleSave = useCallback((note, content) => {
        setContents(current => current ? { ...current, notes: current.notes.map(n => (n.path === note.path ? { ...n, content } : n)) } : current);
        if (saveTimer.current) {
            clearTimeout(saveTimer.current);
        }
        pendingSaveRef.current = { content, note };
        saveTimer.current = setTimeout(() => {
            setSaving(true);
            pendingSaveRef.current = null;
            void saveNote(note.title, content, note.folder).finally(() => setSaving(false));
        }, 800);
    }, []);
    // Write out a still-pending debounced save right now, instead of waiting for its timer.
    // Used before a rename so the file being moved has the latest keystrokes on disk.
    const flushPendingSave = useCallback(async () => {
        const pending = pendingSaveRef.current;
        if (!pending) {
            return;
        }
        if (saveTimer.current) {
            clearTimeout(saveTimer.current);
            saveTimer.current = null;
        }
        pendingSaveRef.current = null;
        setSaving(true);
        try {
            await saveNote(pending.note.title, pending.content, pending.note.folder);
        }
        finally {
            setSaving(false);
        }
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
        // Obsidian-style targets: plain [[Title]] or path-qualified
        // [[Folder/Title]] (the agent writes the latter into Home.md). Resolve
        // both (same rule the editor's resolved/unresolved styling uses — see
        // `resolvable` above); a missing path-qualified note is created IN its
        // folder rather than as a root note with a slash jammed into the name.
        const existing = findLinkedNote(target, loaded.notes);
        if (existing) {
            openInPlace({ kind: 'note', note: existing });
            return;
        }
        const slash = target.lastIndexOf('/');
        const folder = slash > 0 ? target.slice(0, slash) : '';
        const title = slash > 0 ? target.slice(slash + 1) : target;
        if (folder) {
            await createFolder(folder);
        }
        await saveNote(title, `# ${title}\n\n`, folder);
        const after = await refresh();
        const created = after?.notes.find(n => n.title.toLowerCase() === title.toLowerCase() && (!folder || n.folder.toLowerCase() === folder.toLowerCase()));
        if (created) {
            openInPlace({ kind: 'note', note: created });
        }
    }, [contents, openInPlace, refresh]);
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
    // After a rename, point any open tab (or nav-history entry) that was showing the
    // old path at the freshly-loaded note/file — otherwise it'd keep rendering a stale
    // snapshot under an identity (`.path`) that no longer exists on disk.
    const remapOpenTabs = useCallback((oldPath, newPath, refreshed) => {
        const remap = (tab) => {
            const mapped = remappedPath(tabKey(tab), oldPath, newPath);
            if (mapped === null) {
                return tab;
            }
            if (tab.kind === 'note') {
                const fresh = refreshed.notes.find(n => n.path === mapped);
                return fresh ? { kind: 'note', note: fresh } : tab;
            }
            const fresh = refreshed.files.find(f => f.path === mapped);
            return fresh ? { file: fresh, kind: 'file' } : tab;
        };
        setTabs(current => current.map(remap));
        setNavState(current => ({ ...current, stack: current.stack.map(remap) }));
    }, []);
    // Rename a note or folder on disk, then (for a note) cascade [[Old]] → [[New]] across
    // every other note that links to it, then bring open tabs/history along.
    const renameFsEntry = useCallback(async (target, rawNewName) => {
        const api = window.hermesDesktop;
        if (!api?.renamePath) {
            throw new Error('Rename is not available in this build.');
        }
        // Flush ANY still-pending autosave first — unconditionally, not just for the note
        // being renamed. Two ways a stale timer bites otherwise: (1) renaming folder/note X
        // while a DIFFERENT open note still has a pending save — its 800ms timer can fire
        // AFTER the wikilink cascade below rewrites it on disk, silently reverting that
        // rewrite back to the old title; (2) renaming a note whose OWN edit hasn't flushed
        // yet — the file that gets moved would be missing the latest keystrokes. Flushing
        // first (before reading `contents` for the cascade, and before the rename itself)
        // closes both.
        await flushPendingSave();
        if (target.kind === 'folder') {
            const safeFolderName = rawNewName.replace(/[/\\:]/g, '-').trim();
            if (!safeFolderName) {
                throw new Error('Folder name cannot be empty.');
            }
            const renamed = await api.renamePath(target.path, safeFolderName);
            const refreshed = await refresh();
            if (refreshed) {
                remapOpenTabs(target.path, renamed.path, refreshed);
            }
            return;
        }
        const safeTitle = rawNewName.replace(/[/\\:]/g, '-').trim() || 'Untitled';
        const oldPath = target.note.path;
        const oldTitle = target.note.title;
        const renamed = await api.renamePath(oldPath, `${safeTitle}.md`);
        // Cascade the title change into every OTHER note's wikilinks (the renamed note's
        // own content is untouched — only its filename changed).
        if (contents && api.writeTextFile) {
            for (const other of contents.notes) {
                if (other.path === oldPath) {
                    continue;
                }
                const rewritten = rewriteWikilinks(other.content, oldTitle, safeTitle);
                if (rewritten !== other.content) {
                    await api.writeTextFile(other.path, rewritten);
                }
            }
        }
        const refreshed = await refresh();
        if (refreshed) {
            remapOpenTabs(oldPath, renamed.path, refreshed);
        }
    }, [contents, flushPendingSave, refresh, remapOpenTabs]);
    const submitRename = useCallback((name) => (renameTarget ? renameFsEntry(renameTarget, name) : Promise.resolve()), [renameFsEntry, renameTarget]);
    // Move a note or folder to the OS Trash, close any tabs it was open in, and drop it
    // (and anything nested under it) from the visit history.
    const deleteFsEntry = useCallback(async () => {
        if (!deleteTarget) {
            return;
        }
        const trash = window.hermesDesktop?.trashPath;
        if (!trash) {
            throw new Error('Moving to Trash is unavailable in this build.');
        }
        const path = deleteTarget.kind === 'note' ? deleteTarget.note.path : deleteTarget.path;
        // Cancel (not flush!) a pending autosave for whatever's being deleted — a note being
        // edited right now, or a note inside a folder being deleted. If its 800ms timer were
        // left to fire after the trash call, it would silently recreate the file we just
        // deleted with its last-known content.
        if (pendingSaveRef.current && isPathWithin(pendingSaveRef.current.note.path, path)) {
            if (saveTimer.current) {
                clearTimeout(saveTimer.current);
                saveTimer.current = null;
            }
            pendingSaveRef.current = null;
        }
        const ok = await trash(path);
        if (!ok) {
            throw new Error('Could not move this to Trash.');
        }
        await refresh();
        const isDeleted = (tab) => isPathWithin(tabKey(tab), path);
        const activeTabItem = tabs[activeTab];
        const nextTabs = tabs.filter(tab => !isDeleted(tab));
        if (nextTabs.length !== tabs.length) {
            setTabs(nextTabs);
            const stillThere = activeTabItem && !isDeleted(activeTabItem)
                ? nextTabs.findIndex(tab => tabKey(tab) === tabKey(activeTabItem))
                : -1;
            setActiveTab(stillThere >= 0 ? stillThere : Math.max(0, Math.min(activeTab, nextTabs.length - 1)));
        }
        setNavState(current => ({ ...current, stack: current.stack.filter(tab => !isDeleted(tab)) }));
    }, [activeTab, deleteTarget, refresh, tabs]);
    if (error) {
        return _jsx(EmptyState, { className: "h-full", description: `${error} (${VAULT_DIR})`, title: "Library unavailable" });
    }
    if (!contents || !tree) {
        return _jsx(EmptyState, { className: "h-full", description: "Opening your vault\u2026", title: "Library" });
    }
    const noteCount = contents.notes.length;
    const fileCount = contents.files.length;
    return (_jsxs("div", { className: "flex h-full min-h-0 bg-(--ui-editor-surface-background)", children: [sidebarOpen && (_jsxs("aside", { className: "flex w-64 shrink-0 flex-col border-r border-(--ui-stroke-tertiary) bg-(--ui-sidebar-surface-background)", children: [_jsxs("div", { className: "flex items-center justify-between gap-3 px-4 pb-3 pt-5", children: [_jsxs("div", { className: "min-w-0", children: [_jsx("h1", { className: "text-lg font-semibold tracking-tight", children: "Library" }), _jsxs("p", { className: "mt-0.5 text-[0.65rem] font-medium tabular-nums text-(--ui-text-tertiary)", children: [noteCount, " note", noteCount === 1 ? '' : 's', " \u00B7 ", fileCount, " file", fileCount === 1 ? '' : 's'] })] }), _jsxs("div", { className: "flex gap-0.5", children: [_jsx(Tip, { label: "New note (\u2318N)", children: _jsx(Button, { "aria-label": "New note", className: "transition-transform duration-200 ease-out active:scale-[0.98]", onClick: () => startCreating('note'), size: "icon-xs", variant: "ghost", children: _jsx(IconFilePlus, {}) }) }), _jsx(Tip, { label: "New folder", children: _jsx(Button, { "aria-label": "New folder", className: "transition-transform duration-200 ease-out active:scale-[0.98]", onClick: () => startCreating('folder'), size: "icon-xs", variant: "ghost", children: _jsx(IconFolderPlus, {}) }) }), _jsx(Tip, { label: "Hide file list", children: _jsx(Button, { "aria-label": "Hide file list", className: "transition-transform duration-200 ease-out active:scale-[0.98]", onClick: () => setSidebar(false), size: "icon-xs", variant: "ghost", children: _jsx(IconLayoutSidebarLeftCollapse, {}) }) })] })] }), creating && (_jsxs("div", { className: "mx-3 mb-2 rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) p-2 shadow-sm", children: [_jsx(Input, { autoFocus: true, onChange: event => setDraft(event.target.value), onKeyDown: event => {
                                    if (event.key === 'Enter') {
                                        void submitCreate();
                                    }
                                    if (event.key === 'Escape') {
                                        setCreating(null);
                                    }
                                }, placeholder: creating === 'folder' ? 'Folder name' : 'Note title', value: draft }), targetFolder && _jsxs("p", { className: "px-1 pt-1.5 text-[10px] text-muted-foreground", children: ["in ", targetFolder] })] })), _jsx("div", { className: "px-3 pb-2", children: _jsx(SearchField, { "aria-label": "Search notes", containerClassName: "w-full rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) px-2 opacity-100", inputClassName: "w-full", onChange: onSearchChange, onClear: clearSearch, placeholder: "Search notes\u2026", value: searchInput }) }), _jsx("nav", { className: "min-h-0 flex-1 overflow-y-auto px-2.5 pb-4", children: isSearching ? (_jsx(SearchResults, { hits: searchHits, onSelect: note => openSelection({ kind: 'note', note }) })) : (_jsx(TreeLevel, { depth: 0, expanded: expanded, node: tree, onRequestDelete: setDeleteTarget, onRequestRename: setRenameTarget, onSelect: next => next && openSelection(next), onToggle: path => setExpanded(current => {
                                const next = new Set(current);
                                next.has(path) ? next.delete(path) : next.add(path);
                                try {
                                    window.localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
                                }
                                catch {
                                    // persistence is best-effort
                                }
                                return next;
                            }), selection: selection })) })] })), _jsxs("main", { className: "flex min-w-0 flex-1 flex-col bg-(--ui-bg-editor)", children: [(tabs.length > 0 || !sidebarOpen) && (_jsxs("div", { className: "relative z-10 flex h-(--titlebar-height) shrink-0 items-stretch border-b border-(--ui-stroke-tertiary) bg-(--ui-sidebar-surface-background) [-webkit-app-region:no-drag]", children: [_jsxs("div", { className: "flex shrink-0 items-center gap-0.5 border-r border-(--ui-stroke-quaternary) px-1.5", children: [!sidebarOpen && (_jsx(Tip, { label: "Show file list", children: _jsx(Button, { "aria-label": "Show file list", onClick: () => setSidebar(true), size: "icon-xs", variant: "ghost", children: _jsx(IconLayoutSidebarLeftExpand, {}) }) })), _jsx(Tip, { label: "Back (\u2318[)", children: _jsx(Button, { "aria-label": "Back", disabled: nav.pos <= 0, onClick: () => goHistory(-1), size: "icon-xs", variant: "ghost", children: _jsx(IconArrowLeft, {}) }) }), _jsx(Tip, { label: "Forward (\u2318])", children: _jsx(Button, { "aria-label": "Forward", disabled: nav.pos >= nav.stack.length - 1, onClick: () => goHistory(1), size: "icon-xs", variant: "ghost", children: _jsx(IconArrowRight, {}) }) })] }), _jsx("div", { className: "flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", role: "tablist", children: tabs.map((tab, i) => (_jsxs("div", { className: cn('group/tab relative flex h-full min-w-0 max-w-48 shrink-0 cursor-pointer items-center border-r border-(--ui-stroke-quaternary) text-[0.6875rem] font-medium transition-colors duration-200 ease-out', i === activeTab
                                        ? 'bg-(--ui-bg-editor) text-foreground'
                                        : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'), onClick: () => {
                                        setActiveTab(i);
                                        recordVisit(tab);
                                    }, role: "tab", children: [i === activeTab && _jsx("span", { "aria-hidden": true, className: "absolute inset-x-0 top-0 h-px bg-(--theme-primary)" }), _jsxs("span", { className: "flex min-w-0 items-center gap-1.5 py-2 pl-3 pr-8", children: [tab.kind === 'note' ? (_jsx(IconFileText, { className: "shrink-0 opacity-60", size: 13 })) : (_jsx(FileGlyph, { kind: tab.file.kind })), _jsx("span", { className: "truncate", children: tabLabel(tab) })] }), _jsx("button", { "aria-label": "Close tab", className: "absolute right-1.5 grid size-5 place-items-center rounded opacity-0 transition-[opacity,color] duration-200 ease-out hover:bg-(--chrome-action-hover) group-hover/tab:opacity-100 group-focus-within/tab:opacity-100", onClick: event => {
                                                event.stopPropagation();
                                                closeTab(i);
                                            }, type: "button", children: _jsx(IconX, { size: 11 }) })] }, tabKey(tab)))) }), _jsxs("div", { className: "flex shrink-0 items-center gap-0.5 border-l border-(--ui-stroke-quaternary) px-1.5", children: [_jsx(Tip, { label: activeNote ? `Ask the agent about “${activeNote.title}”` : 'Ask the agent', children: _jsx(Button, { "aria-label": "Ask the agent", onClick: askAgent, size: "icon-xs", variant: "ghost", children: _jsx(IconSparkles, {}) }) }), activeNote && !railOpen && (_jsx(Tip, { label: "Show note panel", children: _jsx(Button, { "aria-label": "Show note panel", onClick: () => setRail(true), size: "icon-xs", variant: "ghost", children: _jsx(IconLayoutSidebarRightExpand, {}) }) }))] })] })), selection?.kind === 'note' ? (_jsxs(_Fragment, { children: [_jsx("div", { className: "shrink-0 border-b border-(--ui-stroke-quaternary) px-7 pb-4 pt-6", children: _jsxs("div", { className: "flex items-end justify-between gap-6", children: [_jsxs("div", { className: "min-w-0", children: [_jsxs("div", { className: "mb-2 flex min-w-0 items-center gap-1.5 text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--ui-text-tertiary)", children: [_jsx("span", { children: "Library" }), selection.note.folder
                                                            .split('/')
                                                            .filter(Boolean)
                                                            .map((part, index) => (_jsxs("span", { className: "contents", children: [_jsx(IconChevronRight, { className: "shrink-0 opacity-50", size: 11 }), _jsx("span", { className: "truncate", children: part })] }, `${part}-${index}`)))] }), _jsx("h2", { className: "truncate text-2xl font-semibold tracking-[-0.025em]", children: selection.note.title })] }), _jsxs("div", { className: "flex shrink-0 items-center gap-2 text-[0.6875rem] text-(--ui-text-tertiary)", children: [_jsxs("span", { className: "tabular-nums", children: [countWords(selection.note.content), " words"] }), saving && _jsx("span", { className: "text-(--ui-text-quaternary)", children: "Saving\u2026" }), _jsx(Tip, { label: "Rename note", children: _jsx(Button, { "aria-label": "Rename note", onClick: () => setRenameTarget({ kind: 'note', note: selection.note }), size: "icon-xs", variant: "ghost", children: _jsx(IconPencil, {}) }) }), _jsx(Tip, { label: "Delete note", children: _jsx(Button, { "aria-label": "Delete note", onClick: () => setDeleteTarget({ kind: 'note', note: selection.note }), size: "icon-xs", variant: "ghost", children: _jsx(IconTrash, {}) }) })] })] }) }), _jsx("div", { className: "min-h-0 flex-1 overflow-hidden px-7 pb-3", children: _jsx(NoteEditor, { imageContext: { files: imageFiles, noteFolder: selection.note.folder, vaultDir: VAULT_DIR }, initialValue: selection.note.content, isResolved: target => isWikilinkResolved(target, resolvable), notes: contents.notes, onChange: value => scheduleSave(selection.note, value), onOpenWikilink: target => void openWikilink(target), ref: noteEditorRef }, selection.note.path) })] })) : selection?.kind === 'file' ? (_jsx(FilePreview, { file: selection.file })) : (_jsx("div", { className: "grid flex-1 place-items-center text-center", children: _jsxs("div", { className: "flex flex-col items-center gap-3", children: [_jsxs("div", { children: [_jsx("div", { className: "text-sm font-medium", children: "No note open" }), _jsx("div", { className: "mt-1 text-xs text-muted-foreground", children: "Pick a note on the left, or start a fresh one." })] }), _jsxs(Button, { onClick: () => startCreating('note'), size: "sm", variant: "secondary", children: [_jsx(IconFilePlus, { size: 15 }), "New note"] })] }) }))] }), activeNote && index && railOpen && (_jsx(NoteRail, { activeNote: activeNote, index: index, notes: contents.notes, onCollapse: () => setRail(false), onCreateUnresolved: target => void openWikilink(target), onOpenNote: note => openInPlace({ kind: 'note', note }), onSearchTag: tag => {
                    setSidebar(true);
                    onSearchChange(`#${tag}`);
                }, onSelectHeading: handleSelectHeading })), _jsx(RenameDialog, { initialValue: renameTarget ? (renameTarget.kind === 'note' ? renameTarget.note.title : renameTarget.name) : '', label: renameTarget?.kind === 'folder' ? 'folder' : 'note', onClose: () => setRenameTarget(null), onSubmit: submitRename, open: Boolean(renameTarget) }), _jsx(ConfirmDialog, { busyLabel: "Moving to Trash\u2026", confirmLabel: "Move to Trash", description: deleteTarget
                    ? `“${deleteTarget.kind === 'note' ? deleteTarget.note.title : deleteTarget.name}” will move to the system Trash, where it can still be recovered.${deleteTarget.kind === 'folder' ? ' Everything inside it moves too.' : ''}`
                    : undefined, destructive: true, doneLabel: "Moved to Trash", onClose: () => setDeleteTarget(null), onConfirm: deleteFsEntry, open: Boolean(deleteTarget), title: `Move ${deleteTarget?.kind === 'folder' ? 'folder' : 'note'} to Trash?` })] }));
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
// Flat results list that replaces the folder tree while a search is active — filename
// matches first, then body matches with a one-line snippet (see search.ts).
function SearchResults({ hits, onSelect }) {
    if (!hits.length) {
        return (_jsxs("div", { className: "rounded-lg border border-dashed border-(--ui-stroke-tertiary) px-3 py-3", children: [_jsx("p", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--ui-text-quaternary)", children: "No matches" }), _jsx("p", { className: "mt-1 text-[0.6875rem] leading-relaxed text-muted-foreground", children: "Nothing in this vault's titles or text matches that search." })] }));
    }
    return (_jsx("div", { className: "space-y-0.5", children: hits.map(hit => (_jsxs("button", { className: "flex w-full flex-col items-start gap-0.5 rounded-lg px-2 py-1.5 text-left transition-[transform,color,background-color] duration-200 ease-out hover:bg-(--ui-row-hover-background) active:scale-[0.98]", onClick: () => onSelect(hit.note), type: "button", children: [_jsxs("span", { className: "flex w-full min-w-0 items-center gap-2 text-[0.8125rem] text-(--ui-text-secondary)", children: [_jsx(IconFileText, { className: "shrink-0 opacity-55", size: 14 }), _jsx("span", { className: "truncate font-medium", children: hit.note.title }), hit.note.folder && _jsx("span", { className: "shrink-0 truncate text-[0.65rem] text-(--ui-text-quaternary)", children: hit.note.folder })] }), hit.snippet && (_jsx("span", { className: "w-full truncate pl-[1.375rem] text-[0.6875rem] text-(--ui-text-tertiary)", children: hit.snippet }))] }, hit.note.path))) }));
}
function TreeLevel({ depth, expanded, node, onRequestDelete, onRequestRename, onSelect, onToggle, selection }) {
    return (_jsxs("div", { className: cn('space-y-0.5', depth > 0 && 'ml-3 border-l border-(--ui-stroke-quaternary) pl-1.5'), children: [node.folders
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(folder => {
                const isCollapsed = !expanded.has(folder.path);
                const folderTarget = { kind: 'folder', name: folder.name, path: folder.path };
                return (_jsxs("div", { className: "pb-0.5", children: [_jsxs(ContextMenu, { children: [_jsx(ContextMenuTrigger, { asChild: true, children: _jsxs("button", { className: "group/folder flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[0.68rem] font-semibold uppercase tracking-[0.075em] text-(--ui-text-secondary) transition-[transform,color,background-color] duration-200 ease-out hover:bg-(--ui-row-hover-background) hover:text-foreground active:scale-[0.98]", onClick: () => onToggle(folder.path), type: "button", children: [_jsx(IconChevronRight, { className: cn('shrink-0 transition-transform duration-200 ease-out', !isCollapsed && 'rotate-90'), size: 12 }), isCollapsed ? (_jsx(IconFolder, { className: "shrink-0 text-(--ui-text-tertiary) group-hover/folder:text-(--theme-primary)", size: 14 })) : (_jsx(IconFolderOpen, { className: "shrink-0 text-(--theme-primary)", size: 14 })), _jsx("span", { className: "truncate", children: folder.name })] }) }), _jsxs(ContextMenuContent, { children: [_jsxs(ContextMenuItem, { onSelect: () => onRequestRename(folderTarget), children: [_jsx(IconPencil, {}), "Rename"] }), _jsxs(ContextMenuItem, { onSelect: () => onRequestDelete(folderTarget), variant: "destructive", children: [_jsx(IconTrash, {}), "Delete"] })] })] }), !isCollapsed && (_jsx(TreeLevel, { depth: depth + 1, expanded: expanded, node: folder, onRequestDelete: onRequestDelete, onRequestRename: onRequestRename, onSelect: onSelect, onToggle: onToggle, selection: selection }))] }, folder.path));
            }), node.notes
                .slice()
                .sort((a, b) => a.title.localeCompare(b.title))
                .map(note => (_jsxs(ContextMenu, { children: [_jsx(ContextMenuTrigger, { asChild: true, children: _jsxs("button", { className: cn('relative flex w-full items-center gap-2 truncate rounded-lg px-2 py-1.5 text-left text-[0.8125rem] text-(--ui-text-secondary) transition-[transform,color,background-color] duration-200 ease-out before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-transparent hover:bg-(--ui-row-hover-background) hover:text-foreground active:scale-[0.98]', selection?.kind === 'note' &&
                                selection.note.path === note.path &&
                                'font-semibold text-foreground before:bg-(--theme-primary)'), onClick: () => onSelect({ kind: 'note', note }), type: "button", children: [_jsx(IconFileText, { className: "shrink-0 opacity-55", size: 14 }), _jsx("span", { className: "truncate", children: note.title })] }) }), _jsxs(ContextMenuContent, { children: [_jsxs(ContextMenuItem, { onSelect: () => onRequestRename({ kind: 'note', note }), children: [_jsx(IconPencil, {}), "Rename"] }), _jsxs(ContextMenuItem, { onSelect: () => onRequestDelete({ kind: 'note', note }), variant: "destructive", children: [_jsx(IconTrash, {}), "Delete"] })] })] }, note.path))), node.files
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(file => (_jsxs("button", { className: cn('relative flex w-full items-center gap-2 truncate rounded-lg px-2 py-1.5 text-left text-[0.8125rem] text-(--ui-text-tertiary) transition-[transform,color,background-color] duration-200 ease-out before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-transparent hover:bg-(--ui-row-hover-background) hover:text-foreground active:scale-[0.98]', selection?.kind === 'file' &&
                    selection.file.path === file.path &&
                    'font-semibold text-foreground before:bg-(--theme-primary)'), onClick: () => onSelect({ file, kind: 'file' }), type: "button", children: [_jsx(FileGlyph, { kind: file.kind }), _jsx("span", { className: "truncate", children: file.name })] }, file.path)))] }));
}
function fileUrl(path) {
    return `file://${encodeURI(path).replace(/#/g, '%23')}`;
}
function FilePreview({ file }) {
    const url = fileUrl(file.path);
    const openExternal = () => void window.hermesDesktop?.openExternal?.(url);
    const reveal = () => void window.hermesDesktop?.revealPath?.(file.path);
    // PDFs, HTML deliverables, and images render inside Nemesis (below), so we don't
    // offer to bounce them out to a browser/other app — everything stays in the app.
    // Only formats we can't render in-app (PowerPoint/Word) keep the external option.
    const canPreviewInApp = file.kind === 'pdf' || file.kind === 'html' || file.kind === 'image';
    return (_jsxs("div", { className: "flex min-h-0 flex-1 flex-col bg-(--ui-bg-editor)", children: [_jsxs("div", { className: "flex items-end justify-between gap-4 border-b border-(--ui-stroke-quaternary) px-6 pb-4 pt-6", children: [_jsxs("div", { className: "min-w-0", children: [_jsxs("p", { className: "mb-1.5 text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--ui-text-tertiary)", children: [file.folder || 'Library', " \u00B7 ", file.kind] }), _jsx("h2", { className: "truncate text-xl font-semibold tracking-tight", children: file.name })] }), _jsxs("div", { className: "flex gap-2", children: [!canPreviewInApp && (_jsx(Button, { onClick: openExternal, size: "sm", variant: "outline", children: "Open in default app" })), _jsx(Button, { onClick: reveal, size: "sm", variant: "outline", children: "Reveal" })] })] }), _jsx("div", { className: "min-h-0 flex-1 px-5 pb-5", children: file.kind === 'pdf' ? (_jsx(PdfViewer, { path: file.path })) : file.kind === 'html' ? (_jsx("iframe", { className: "h-full w-full rounded-lg border border-border bg-white", sandbox: "", src: url, title: file.name })) : file.kind === 'image' ? (_jsx("div", { className: "grid h-full place-items-center rounded-lg border border-border bg-card p-4", children: _jsx("img", { alt: file.name, className: "max-h-full max-w-full object-contain", src: url }) })) : (_jsx(EmptyState, { className: "h-full", description: file.kind === 'slides'
                        ? 'PowerPoint/Keynote files open in their own app — click “Open in default app”.'
                        : 'This file type opens in its own app — click “Open in default app”.', title: file.name })) })] }));
}
