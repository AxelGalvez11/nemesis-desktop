import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Study — Anki-style spaced repetition over FSRS (see model.ts for the algorithm/licensing
// note). Interaction model deliberately mirrors what health-science students already have
// as muscle memory from Anki: deck browser with due badges → flip card (Space) →
// Again/Hard/Good/Easy (1-4), with the next-interval hint under each grade button.
import { IconArrowLeft, IconCards, IconChecklist, IconChevronDown, IconDots, IconFileImport, IconFolderPlus, IconMessage, IconPencil, IconPlayerPause, IconPlus, IconSitemap, IconSparkles, IconTrash } from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { assembleCardContext } from '@/app/note-chat/context';
import { NoteChatPanel } from '@/app/note-chat/note-chat-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Tip } from '@/components/ui/tooltip';
import { renameDesktopPath } from '@/lib/desktop-fs';
import { cn } from '@/lib/utils';
import { seedComposerDraft } from '@/store/composer';
import { getRememberedSessionId } from '@/store/session';
import { NEW_CHAT_ROUTE, sessionRoute } from '../routes';
import { hasClozeMarker, renderClozeAnswer, renderClozePrompt } from './cloze';
import { DECK_DIR, importedDeckFileNames, scanAllDeckFiles } from './deck-files';
import { readDiskStudyState, readDiskTestAttempts } from './disk-state';
import { bestAttempt, groupExtras, lastAttempt, loadTestAttempts, saveTestAttempts, scanMindmapFiles, scanTestFiles } from './extras';
import { parseCardPaste } from './import-cards';
import { MindmapViewerDialog } from './mindmap-viewer';
import { addCard, addSection, adoptLegacyDeckFiles, assignDeckSection, buildQueue, DEFAULT_STUDY_SETTINGS, deleteCard, deleteDeck, deleteSection, freshId, getSettings, gradeCard, groupDecks, LEECH_TAG, loadState, localDayKey, previewIntervals, reconcileDeckFiles, renameDeck, reviewHeatmap, saveState, setSettings, toggleSuspendCard, undoLastGrade, updateCard } from './model';
import { STUDY_STATE_EXTERNAL_CHANGE_EVENT } from './phone-sync';
import { TestSurface } from './test-mode';
const GRADES = [
    { key: '1', label: 'Again', rating: 'again' },
    { key: '2', label: 'Hard', rating: 'hard' },
    { key: '3', label: 'Good', rating: 'good' },
    { key: '4', label: 'Easy', rating: 'easy' }
];
const TAB_KEY = 'nemesis.study.tab.v1';
const COLLAPSED_SECTIONS_KEY = 'nemesis.study.sections.collapsed.v1';
const STUDY_TABS = [
    { icon: _jsx(IconCards, { size: 13 }), id: 'cards', label: 'Cards' },
    { icon: _jsx(IconChecklist, { size: 13 }), id: 'tests', label: 'Tests' },
    { icon: _jsx(IconSitemap, { size: 13 }), id: 'maps', label: 'Mind maps' }
];
const ORDER_OPTIONS = [
    { id: 'due', label: 'Due first' },
    { id: 'random', label: 'Random' }
];
// FSRS request_retention choices (see StudySettings.desiredRetention). Values
// are stringified for the Select; String(0.9) round-trips exactly.
const RETENTION_OPTIONS = [
    { label: '80%', value: '0.8' },
    { label: '85%', value: '0.85' },
    { label: '90% (default)', value: '0.9' },
    { label: '95%', value: '0.95' }
];
/** "3 cards reviewed — 2 Good · 1 Again." for the end-of-session recap. */
function sessionRecapLine(done, grades) {
    const parts = GRADES.filter(option => grades[option.rating] > 0)
        .map(option => `${grades[option.rating]} ${option.label}`)
        .join(' · ');
    return `${done} card${done === 1 ? '' : 's'} reviewed${parts ? ` — ${parts}` : ''}.`;
}
function zeroSessionGrades() {
    return { again: 0, easy: 0, good: 0, hard: 0 };
}
function categoryForQueueItem(item, state) {
    if (item.isNew) {
        return 'new';
    }
    const cardState = state.schedule[item.scheduleKey]?.state;
    return cardState === 1 || cardState === 3 ? 'learning' : 'review';
}
function countQueueCategories(queue, state) {
    return queue.reduce((counts, item) => {
        counts[categoryForQueueItem(item, state)]++;
        return counts;
    }, { learning: 0, new: 0, review: 0 });
}
function loadTab() {
    try {
        const stored = window.localStorage.getItem(TAB_KEY);
        return stored === 'tests' || stored === 'maps' ? stored : 'cards';
    }
    catch {
        return 'cards';
    }
}
function loadCollapsedSections() {
    try {
        const stored = JSON.parse(window.localStorage.getItem(COLLAPSED_SECTIONS_KEY) ?? '[]');
        return Array.isArray(stored)
            ? new Set(stored.filter((course) => typeof course === 'string'))
            : new Set();
    }
    catch {
        return new Set();
    }
}
// The flip toggle's persisted value now lives in StudySettings (model.ts migrates
// the old standalone key on load — see LEGACY_FLIP_KEY). This only covers the
// OS-level accessibility preference, which always overrides the stored setting.
function prefersReducedMotion() {
    try {
        return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    }
    catch {
        return false;
    }
}
export function StudyView() {
    const [state, setState] = useState(() => loadState());
    const [reviewDeckId, setReviewDeckId] = useState(null);
    const [browseDeckId, setBrowseDeckId] = useState(null);
    const [reviewing, setReviewing] = useState(false);
    const [revealed, setRevealed] = useState(false);
    const [importOpen, setImportOpen] = useState(false);
    const [newDeckSection, setNewDeckSection] = useState(null);
    const [newSectionOpen, setNewSectionOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [tab, setTab] = useState(() => loadTab());
    const [collapsedSections, setCollapsedSections] = useState(() => loadCollapsedSections());
    const [reducedMotion] = useState(() => prefersReducedMotion());
    const [matchDeckId, setMatchDeckId] = useState(null);
    const [done, setDone] = useState(0);
    const [sessionTotal, setSessionTotal] = useState(0);
    // Session-only (deliberately unpersisted): the pre-grade snapshot for Undo
    // and the per-grade tallies for the end-of-session recap.
    const [lastUndo, setLastUndo] = useState(null);
    const [sessionGrades, setSessionGrades] = useState(() => zeroSessionGrades());
    const [autoImported, setAutoImported] = useState([]);
    const [mindmaps, setMindmaps] = useState([]);
    const [tests, setTests] = useState([]);
    const [testAttempts, setTestAttempts] = useState(() => loadTestAttempts());
    const [viewingMindmap, setViewingMindmap] = useState(null);
    const [takingTest, setTakingTest] = useState(null);
    // `now` advances on a timer while the Study page is open (not only when state
    // changes), so due cards — especially just-learned cards on their short 1–10 min
    // FSRS steps — resurface without needing a keystroke, and the deck-list due
    // counts stay live. Reset on entering/leaving review so a session starts fresh.
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        setNow(new Date());
        const id = window.setInterval(() => setNow(new Date()), 15_000);
        return () => window.clearInterval(id);
    }, [reviewing]);
    const queue = useMemo(() => (reviewing ? buildQueue(state, reviewDeckId, now) : []), [state, reviewDeckId, reviewing, now]);
    // Pin the on-screen card by its schedule key so a background queue refresh (the
    // timer tick that resurfaces a card learned earlier this session) can't swap the
    // card out from under the user mid-review. It changes only when they grade the
    // pinned card (dropping it from the queue) or the queue empties.
    const [currentKey, setCurrentKey] = useState(null);
    const current = useMemo(() => {
        if (!reviewing) {
            return undefined;
        }
        const pinned = currentKey ? queue.find(item => item.scheduleKey === currentKey) : undefined;
        return pinned ?? queue[0];
    }, [reviewing, queue, currentKey]);
    useEffect(() => {
        const key = current?.scheduleKey ?? null;
        if (key !== currentKey) {
            setCurrentKey(key);
        }
    }, [current, currentKey]);
    const remainingCounts = useMemo(() => countQueueCategories(queue, state), [queue, state]);
    const todayQueue = useMemo(() => buildQueue(state, null, now), [now, state]);
    // When the live queue is empty, how many cards become due within the next 20
    // minutes (learning cards on their short FSRS steps) — drives the "coming back
    // soon" hint on the caught-up screen so the student keeps the window open.
    const comingBackSoon = useMemo(() => {
        if (!reviewing || current) {
            return 0;
        }
        return buildQueue(state, reviewDeckId, new Date(now.getTime() + 20 * 60_000)).length;
    }, [reviewing, current, now, state, reviewDeckId]);
    const sections = useMemo(() => groupDecks(state, now)
        .map(group => group.course)
        .filter(course => course.toLocaleLowerCase() !== 'other'), [now, state]);
    const settings = getSettings(state);
    const flip = settings.flip && !reducedMotion;
    const update = useCallback((next) => {
        setState(next);
        saveState(next);
    }, []);
    // Phone grades land in localStorage via the phone-sync bridge (its ingest is
    // synchronous through the same saveState) — reload so an open page converges
    // without a remount. Fired right after the bridge saves, never mid-fold.
    useEffect(() => {
        const onExternalChange = () => setState(loadState());
        window.addEventListener(STUDY_STATE_EXTERNAL_CHANGE_EVENT, onExternalChange);
        return () => window.removeEventListener(STUDY_STATE_EXTERNAL_CHANGE_EVENT, onExternalChange);
    }, []);
    const toggleSection = useCallback((course) => {
        setCollapsedSections(current => {
            const next = new Set(current);
            if (next.has(course)) {
                next.delete(course);
            }
            else {
                next.add(course);
            }
            try {
                window.localStorage.setItem(COLLAPSED_SECTIONS_KEY, JSON.stringify([...next]));
            }
            catch {
                // A blocked/full localStorage should not prevent the section from toggling.
            }
            return next;
        });
    }, []);
    // Agent-managed decks: the vault's Flashcards folder is the source of truth, so
    // reconcile against it on mount and whenever the window regains focus — the agent
    // may have renamed, edited, or deleted deck files while you were away. Debounced so
    // an incidental refocus doesn't hammer the disk. Review schedules survive because
    // reconcile keeps card ids for unchanged card text (see model.ts).
    useEffect(() => {
        let cancelled = false;
        let lastRun = 0;
        let restoreChecked = false;
        const reconcile = async () => {
            lastRun = Date.now();
            // One-shot on mount: a fresh install starts with empty localStorage, but the
            // vault's .study/ mirror may hold review history from a previous install —
            // adopt it BEFORE the first deck-file scan so FSRS schedules survive.
            if (!restoreChecked) {
                restoreChecked = true;
                const [diskState, diskAttempts] = await Promise.all([readDiskStudyState(), readDiskTestAttempts()]);
                if (cancelled) {
                    return;
                }
                const local = loadState();
                if (diskState &&
                    local.decks.length === 0 &&
                    local.reviews.length === 0 &&
                    Object.keys(local.schedule).length === 0) {
                    saveState(diskState);
                    setState(diskState);
                }
                if (diskAttempts && Object.keys(diskAttempts).length > 0 && Object.keys(loadTestAttempts()).length === 0) {
                    saveTestAttempts(diskAttempts);
                    setTestAttempts(diskAttempts);
                }
            }
            const [candidates, mindmapFiles, testFiles] = await Promise.all([
                scanAllDeckFiles(),
                scanMindmapFiles(),
                scanTestFiles()
            ]);
            if (cancelled) {
                return;
            }
            // Mind maps/tests carry no schedule state to preserve, so every scan just
            // replaces the list outright — no reconcile-against-existing-state needed.
            setMindmaps(mindmapFiles);
            setTests(testFiles);
            if (!candidates) {
                return;
            }
            const addedNames = [];
            setState(current => {
                const adopted = adoptLegacyDeckFiles(current, importedDeckFileNames());
                const next = reconcileDeckFiles(adopted, candidates);
                if (next === current) {
                    return current;
                }
                const knownIds = new Set(current.decks.map(deck => deck.id));
                for (const deck of next.decks) {
                    // Genuinely new decks only — renamed/relinked decks keep their id.
                    if (deck.sourceFile && !knownIds.has(deck.id)) {
                        addedNames.push(deck.name);
                    }
                }
                saveState(next);
                return next;
            });
            if (addedNames.length) {
                setAutoImported([...new Set(addedNames)]);
            }
        };
        void reconcile();
        const onFocus = () => {
            if (Date.now() - lastRun < 1500) {
                return;
            }
            void reconcile();
        };
        window.addEventListener('focus', onFocus);
        return () => {
            cancelled = true;
            window.removeEventListener('focus', onFocus);
        };
    }, []);
    const startReview = useCallback((deckId) => {
        const sessionQueue = buildQueue(state, deckId, new Date());
        setReviewDeckId(deckId);
        setSessionTotal(sessionQueue.length);
        setReviewing(true);
        setRevealed(false);
        setDone(0);
        setLastUndo(null);
        setSessionGrades(zeroSessionGrades());
    }, [state]);
    const exitReview = useCallback(() => {
        setReviewing(false);
        setRevealed(false);
    }, []);
    const grade = useCallback((rating) => {
        if (!current) {
            return;
        }
        // Fold against the PERSISTED state, not the render closure: the
        // phone-sync bridge may have ingested phone grades between our last
        // render and this keystroke, and update() overwrites rather than merges —
        // reading loadState() in this same synchronous block closes that window.
        const latest = loadState();
        // Snapshot BEFORE grading so Undo can restore the exact schedule entry
        // (or its absence, for a never-studied card).
        const previous = latest.schedule[current.scheduleKey];
        setLastUndo({ rating, scheduleKey: current.scheduleKey, ...(previous ? { previous } : {}) });
        setSessionGrades(counts => ({ ...counts, [rating]: counts[rating] + 1 }));
        update(gradeCard(latest, current.scheduleKey, rating, new Date()));
        setRevealed(false);
        setDone(count => count + 1);
    }, [current, update]);
    const undoGrade = useCallback(() => {
        if (!lastUndo) {
            return;
        }
        // Same persisted-state rule as grade() — see the comment there.
        update(undoLastGrade(loadState(), lastUndo));
        setSessionGrades(counts => ({ ...counts, [lastUndo.rating]: Math.max(0, counts[lastUndo.rating] - 1) }));
        setDone(count => Math.max(0, count - 1));
        setLastUndo(null);
        setRevealed(false);
    }, [lastUndo, update]);
    // Mini-chat about the card under review: a slide-in overlay, 'c' toggles it. Keyed
    // (via NoteChatPanel) to the card's scope, so it follows the card and stays walled
    // off from the main chat.
    const [reviewChatOpen, setReviewChatOpen] = useState(false);
    const reviewCardContext = useMemo(() => {
        if (!current) {
            return null;
        }
        const deck = state.decks.find(entry => entry.id === current.deckId);
        return assembleCardContext({
            card: current.card,
            clozeIndex: current.clozeIndex,
            deckId: current.deckId,
            deckName: current.deckName,
            sourceFile: deck?.sourceFile
        });
    }, [current, state.decks]);
    // Anki muscle memory: Space/Enter flips, 1-4 grades, Escape leaves the session.
    useEffect(() => {
        if (!reviewing) {
            return;
        }
        const onKey = (event) => {
            const target = event.target;
            if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
                return;
            }
            // 'c' toggles the card mini-chat overlay (guarded above: never while typing).
            if (event.key === 'c') {
                event.preventDefault();
                setReviewChatOpen(open => !open);
                return;
            }
            if (event.key === 'Escape') {
                exitReview();
                return;
            }
            if (!current) {
                return;
            }
            // Anki's `u`: take back the last grade (only while a next card is shown).
            if (event.key === 'u' && lastUndo) {
                event.preventDefault();
                undoGrade();
                return;
            }
            if (!revealed && (event.key === ' ' || event.key === 'Enter')) {
                event.preventDefault();
                setRevealed(true);
                return;
            }
            if (revealed) {
                const match = GRADES.find(option => option.key === event.key);
                if (match) {
                    event.preventDefault();
                    grade(match.rating);
                }
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [current, exitReview, grade, lastUndo, revealed, reviewing, undoGrade]);
    const switchTab = useCallback((next) => {
        setTab(next);
        try {
            window.localStorage.setItem(TAB_KEY, next);
        }
        catch {
            // persistence is best-effort
        }
    }, []);
    const navigate = useNavigate();
    // The page's one ambient line to the agent: land in the CURRENT conversation
    // (owner call — a fresh session per click scattered chats), pre-filling the
    // composer through the draft stash it actually restores from on arrival.
    const askAgent = useCallback((draft) => {
        const lastSession = getRememberedSessionId();
        if (draft) {
            seedComposerDraft(draft, lastSession);
        }
        navigate(lastSession ? sessionRoute(lastSession) : NEW_CHAT_ROUTE);
    }, [navigate]);
    // Anki-style per-deck NEW/LEARN/DUE — bucketed from the same capped queue the
    // "Start review" button studies, so the numbers always agree with the session.
    const queueCountsByDeck = useMemo(() => {
        const counts = new Map();
        for (const item of todayQueue) {
            const bucket = counts.get(item.deckId) ?? { learning: 0, new: 0, review: 0 };
            bucket[categoryForQueueItem(item, state)]++;
            counts.set(item.deckId, bucket);
        }
        return counts;
    }, [state, todayQueue]);
    const startMatch = useCallback((deckId) => {
        setBrowseDeckId(null);
        exitReview();
        setMatchDeckId(deckId);
    }, [exitReview]);
    const createDeck = useCallback((name, course) => {
        const deck = {
            id: freshId('deck'),
            name: name.trim() || 'New deck',
            course: course.trim() || undefined,
            createdAt: new Date().toISOString(),
            cards: []
        };
        update({ ...state, decks: [...state.decks, deck] });
        setNewDeckSection(null);
        // Straight into the card browser so the first card is one click away.
        setBrowseDeckId(deck.id);
    }, [state, update]);
    const createSection = useCallback((name) => {
        update(addSection(state, name));
        setNewSectionOpen(false);
    }, [state, update]);
    const moveDeck = useCallback((deckId, section) => update(assignDeckSection(state, deckId, section)), [state, update]);
    const removeDeck = useCallback((deckId) => {
        update(deleteDeck(state, deckId));
        setBrowseDeckId(null);
    }, [state, update]);
    const renameBrowsedDeck = useCallback(async (name) => {
        const deck = state.decks.find(candidate => candidate.id === browseDeckId);
        if (!deck || deck.name === name) {
            return;
        }
        if (!deck.sourceFile) {
            update(renameDeck(state, deck.id, name));
            return;
        }
        // File-backed deck: rename the vault file FIRST — reconcile relinks by
        // file name, so state only changes once the disk rename succeeded. A
        // thrown IPC error surfaces in the dialog and the old name stands.
        const extension = deck.sourceFile.match(/\.(tsv|txt|md)$/i)?.[0] ?? '.tsv';
        const fileName = `${name}${extension}`;
        await renameDesktopPath(`${DECK_DIR}/${deck.sourceFile}`, fileName);
        update(renameDeck(state, deck.id, name, fileName));
    }, [browseDeckId, state, update]);
    const importCards = useCallback((name, course, text) => {
        const parsed = parseCardPaste(text);
        if (!parsed.length) {
            return false;
        }
        const deck = {
            id: freshId('deck'),
            name: name.trim() || 'Imported deck',
            course: course.trim() || undefined,
            createdAt: new Date().toISOString(),
            cards: parsed.map(card => ({ id: freshId('card'), front: card.front, back: card.back, tags: [] }))
        };
        update({ ...state, decks: [...state.decks, deck] });
        setImportOpen(false);
        return true;
    }, [state, update]);
    const inSubSurface = Boolean(browseDeckId || matchDeckId);
    // Taking a test is fullscreen, same as reviewing a deck: no header, no tabs.
    // TestSurface carries its own back button, progress bar, and Esc handling.
    if (takingTest) {
        return (_jsx("div", { className: "flex h-full min-h-0 flex-col overflow-y-auto", children: _jsx(TestSurface, { file: takingTest, onComplete: () => setTestAttempts(loadTestAttempts()), onExit: () => setTakingTest(null) }) }));
    }
    // Entering a deck is fullscreen: the whole page becomes the card — no header,
    // no tabs, nothing but the review. Esc (or the back button) returns.
    if (reviewing && current) {
        return (_jsxs("div", { className: "relative flex h-full min-h-0 flex-col overflow-y-auto", children: [_jsx(ReviewSurface, { activeCategory: categoryForQueueItem(current, state), chatOpen: reviewChatOpen, flip: flip, intervals: previewIntervals(state, current.scheduleKey, now), item: current, onExit: exitReview, onGrade: grade, onReveal: () => setRevealed(true), onToggleChat: () => setReviewChatOpen(open => !open), onUndo: lastUndo ? undoGrade : null, position: Math.min(done + 1, sessionTotal), remainingCounts: remainingCounts, revealed: revealed, sessionTotal: sessionTotal, showIntervalHints: settings.showIntervalHints }), reviewCardContext && (_jsx("div", { "aria-hidden": !reviewChatOpen, className: cn('absolute inset-y-0 right-0 z-30 flex w-[340px] max-w-[85vw] border-l border-border bg-background shadow-xl transition-transform duration-200 ease-out', reviewChatOpen ? 'translate-x-0' : 'pointer-events-none translate-x-full'), children: _jsx(NoteChatPanel, { context: reviewCardContext, onClose: () => setReviewChatOpen(false) }) }))] }));
    }
    return (_jsxs("div", { className: "flex h-full min-h-0 flex-col overflow-y-auto", children: [_jsxs("header", { className: "flex shrink-0 items-start justify-between gap-3 px-6 pb-3 pt-5", children: [_jsx("div", { className: "min-w-0", children: _jsx("h1", { className: "text-lg font-semibold tracking-tight", children: "Study" }) }), _jsx("div", { className: "flex shrink-0 items-center gap-1.5", children: inSubSurface || reviewing ? (_jsx(Button, { onClick: () => {
                                exitReview();
                                setBrowseDeckId(null);
                                setMatchDeckId(null);
                            }, size: "sm", variant: "outline", children: "Back to decks" })) : (_jsx(_Fragment, { children: _jsxs(Button, { onClick: () => askAgent(), size: "sm", variant: "outline", children: [_jsx("span", { "aria-hidden": "true", className: "size-1.5 rounded-full bg-(--theme-primary)" }), "Ask the agent"] }) })) })] }), !inSubSurface && !reviewing && (_jsx("nav", { "aria-label": "Study sections", className: "mx-6 mb-3 flex items-center gap-1 border-b border-(--ui-stroke-tertiary)", children: STUDY_TABS.map(option => {
                    const count = option.id === 'cards' ? todayQueue.length : option.id === 'tests' ? tests.length : mindmaps.length;
                    return (_jsxs("button", { "aria-current": tab === option.id ? 'page' : undefined, className: cn('relative -mb-px flex items-center gap-1.5 border-b-2 border-transparent px-2.5 pb-2 pt-1 text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50', tab === option.id && 'border-(--theme-primary) text-foreground'), onClick: () => switchTab(option.id), type: "button", children: [option.icon, option.label, count > 0 && _jsx("span", { className: "tabular-nums text-(--ui-text-quaternary)", children: count })] }, option.id));
                }) })), autoImported.length > 0 && !reviewing && !browseDeckId && tab === 'cards' && (_jsxs("div", { className: "mx-6 mb-1 flex items-center justify-between rounded-md border border-(--theme-primary)/40 bg-(--theme-primary)/10 px-3 py-1.5 text-xs", children: [_jsxs("span", { children: ["Nemesis added ", autoImported.length === 1 ? 'a new deck' : `${autoImported.length} new decks`, ":", ' ', autoImported.join(', ')] }), _jsx("button", { className: "text-muted-foreground hover:text-foreground", onClick: () => setAutoImported([]), type: "button", children: "Dismiss" })] })), reviewing ? (_jsx(EmptyState, { className: "flex-1", description: comingBackSoon > 0
                    ? `${done > 0 ? `${sessionRecapLine(done, sessionGrades)} ` : ''}${comingBackSoon} card${comingBackSoon === 1 ? '' : 's'} will be ready in a few minutes — keep this open and they'll come back.`
                    : done > 0
                        ? `${sessionRecapLine(done, sessionGrades)} Come back when the next ones are due.`
                        : 'Nothing is due right now.', title: comingBackSoon > 0 ? 'Caught up for now' : 'All caught up' })) : matchDeckId ? (_jsx(MatchGame, { deck: state.decks.find(deck => deck.id === matchDeckId) ?? null, onExit: () => setMatchDeckId(null) })) : browseDeckId ? (_jsx(CardBrowser, { deck: state.decks.find(deck => deck.id === browseDeckId) ?? null, onChange: update, onDeleteDeck: () => removeDeck(browseDeckId), onMatch: () => startMatch(browseDeckId), onMoveDeck: section => moveDeck(browseDeckId, section), onRename: renameBrowsedDeck, sections: sections, state: state })) : tab === 'cards' ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: "mx-6 mb-1 flex items-center gap-4", children: [todayQueue.length > 0 && (_jsxs(Button, { onClick: () => startReview(null), size: "inline", variant: "textStrong", children: ["Study all due (", todayQueue.length, ")"] })), _jsxs(Button, { onClick: () => setNewDeckSection(''), size: "inline", variant: "text", children: [_jsx(IconPlus, { size: 13 }), "New deck"] }), _jsxs(Button, { onClick: () => setImportOpen(true), size: "inline", variant: "text", children: [_jsx(IconFileImport, { size: 13 }), "Import"] }), _jsxs(Button, { onClick: () => setNewSectionOpen(true), size: "inline", variant: "text", children: [_jsx(IconFolderPlus, { size: 13 }), "New section"] })] }), _jsx(DeckBrowser, { collapsedSections: collapsedSections, onBrowse: setBrowseDeckId, onCreateDeck: setNewDeckSection, onDeleteDeck: removeDeck, onDeleteSection: course => update(deleteSection(state, course)), onMatch: startMatch, onMoveDeck: moveDeck, onStudy: startReview, onToggleSection: toggleSection, queueCounts: queueCountsByDeck, state: state })] })) : tab === 'tests' ? (_jsx(TestsBrowser, { collapsedSections: collapsedSections, mindmaps: mindmaps, onAskAgent: askAgent, onStartTest: setTakingTest, onToggleSection: toggleSection, state: state, testAttempts: testAttempts, tests: tests })) : (_jsx(MindmapsBrowser, { collapsedSections: collapsedSections, mindmaps: mindmaps, onAskAgent: askAgent, onOpenMindmap: setViewingMindmap, onToggleSection: toggleSection, state: state, tests: tests })), _jsx(MindmapViewerDialog, { file: viewingMindmap, onOpenChange: open => !open && setViewingMindmap(null) }), _jsx(ImportDialog, { onImport: importCards, onOpenChange: setImportOpen, open: importOpen, sections: sections }), newDeckSection !== null && (_jsx(NewDeckDialog, { initialSection: newDeckSection, onClose: () => setNewDeckSection(null), onCreate: createDeck, sections: sections })), newSectionOpen && (_jsx(NewSectionDialog, { onClose: () => setNewSectionOpen(false), onCreate: createSection, sections: sections })), _jsx(StudySettingsDialog, { onChange: patch => update(setSettings(state, patch)), onOpenChange: setSettingsOpen, open: settingsOpen, settings: settings })] }));
}
const OTHER_SECTION_VALUE = '__other__';
function SectionSelect({ label, onChange, sections, value }) {
    return (_jsxs(Select, { onValueChange: section => onChange(section === OTHER_SECTION_VALUE ? '' : section), value: value.trim() || OTHER_SECTION_VALUE, children: [_jsx(SelectTrigger, { "aria-label": label, className: "w-full", children: _jsx(SelectValue, { placeholder: "Other" }) }), _jsxs(SelectContent, { children: [sections.map(section => (_jsx(SelectItem, { value: section, children: section }, section))), _jsx(SelectItem, { value: OTHER_SECTION_VALUE, children: "Other" })] })] }));
}
function NewDeckDialog({ initialSection, onClose, onCreate, sections }) {
    const [name, setName] = useState('');
    const [course, setCourse] = useState(initialSection);
    return (_jsx(Dialog, { onOpenChange: open => !open && onClose(), open: true, children: _jsxs(DialogContent, { className: "sm:max-w-md", children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "New deck" }), _jsx(DialogDescription, { children: "Choose where this deck belongs. Ungrouped decks stay in Other." })] }), _jsxs("div", { className: "flex flex-col gap-3", children: [_jsx(Input, { autoFocus: true, onChange: event => setName(event.target.value), onKeyDown: event => {
                                if (event.key === 'Enter' && name.trim()) {
                                    onCreate(name, course);
                                }
                            }, placeholder: "Deck name (e.g. Renal pharm)", value: name }), _jsxs("div", { className: "space-y-1.5", children: [_jsx("label", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-muted-foreground", children: "Section" }), _jsx(SectionSelect, { label: "Deck section", onChange: setCourse, sections: sections, value: course })] })] }), _jsxs(DialogFooter, { children: [_jsx(Button, { onClick: onClose, variant: "outline", children: "Cancel" }), _jsx(Button, { disabled: !name.trim(), onClick: () => onCreate(name, course), children: "Create deck" })] })] }) }));
}
function NewSectionDialog({ onClose, onCreate, sections }) {
    const [name, setName] = useState('');
    const normalized = name.trim().toLocaleLowerCase();
    const unavailable = normalized === 'other' || sections.some(section => section.toLocaleLowerCase() === normalized);
    const valid = Boolean(normalized) && !unavailable;
    return (_jsx(Dialog, { onOpenChange: open => !open && onClose(), open: true, children: _jsxs(DialogContent, { className: "sm:max-w-md", children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "New section" }), _jsx(DialogDescription, { children: "Create a home for related decks. Empty sections remain visible until you add one." })] }), _jsx(Input, { autoFocus: true, onChange: event => setName(event.target.value), onKeyDown: event => {
                        if (event.key === 'Enter' && valid) {
                            onCreate(name);
                        }
                    }, placeholder: "Section name (e.g. Microeconomics)", value: name }), normalized && unavailable && (_jsx("p", { className: "text-xs text-muted-foreground", children: "That section already exists. \u201COther\u201D is reserved for ungrouped decks." })), _jsxs(DialogFooter, { children: [_jsx(Button, { onClick: onClose, variant: "outline", children: "Cancel" }), _jsx(Button, { disabled: !valid, onClick: () => onCreate(name), children: "Create section" })] })] }) }));
}
function RenameDeckDialog({ deck, onClose, onRename }) {
    const [name, setName] = useState(deck.name);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const trimmed = name.trim();
    const submit = async () => {
        if (!trimmed || busy) {
            return;
        }
        if (trimmed === deck.name) {
            onClose();
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await onRename(trimmed);
            onClose();
        }
        catch (err) {
            // Nothing changed (the file rename failed first) — keep the old name.
            setError(err instanceof Error ? err.message : 'Could not rename the deck.');
            setBusy(false);
        }
    };
    return (_jsx(Dialog, { onOpenChange: open => !open && !busy && onClose(), open: true, children: _jsxs(DialogContent, { className: "sm:max-w-md", children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "Rename deck" }), _jsx(DialogDescription, { children: deck.sourceFile
                                ? `Also renames “${deck.sourceFile}” in your Flashcards folder, so the agent keeps this deck in sync.`
                                : 'Review progress stays with the deck.' })] }), _jsx(Input, { autoFocus: true, onChange: event => setName(event.target.value), onKeyDown: event => {
                        if (event.key === 'Enter') {
                            void submit();
                        }
                    }, placeholder: "Deck name", value: name }), error && _jsx("p", { className: "text-xs text-destructive", children: error }), _jsxs(DialogFooter, { children: [_jsx(Button, { disabled: busy, onClick: onClose, variant: "outline", children: "Cancel" }), _jsx(Button, { disabled: !trimmed || busy, onClick: () => void submit(), children: busy ? 'Renaming…' : 'Rename' })] })] }) }));
}
function SettingRow({ children, description, label }) {
    return (_jsxs("div", { className: "flex items-center justify-between gap-4 py-2.5", children: [_jsxs("div", { className: "min-w-0 pr-2", children: [_jsx("div", { className: "text-sm font-medium text-foreground", children: label }), description && _jsx("div", { className: "mt-0.5 text-xs text-muted-foreground", children: description })] }), _jsx("div", { className: "shrink-0", children: children })] }));
}
/** Cast + clamp a raw number-input string to a non-negative integer. Empty or
 *  non-numeric input becomes 0 (== unlimited), never NaN or negative. */
function parseDailyCap(raw) {
    const parsed = Math.round(Number(raw));
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}
function StudySettingsDialog({ onChange, onOpenChange, open, settings }) {
    return (_jsx(Dialog, { onOpenChange: onOpenChange, open: open, children: _jsxs(DialogContent, { className: "sm:max-w-md", children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "Study settings" }), _jsx(DialogDescription, { children: "Limits and behavior for review sessions. Changes apply immediately." })] }), _jsxs("div", { className: "flex flex-col divide-y divide-border", children: [_jsx(SettingRow, { description: "Cards introduced for the first time. 0 = unlimited.", label: "New cards per day", children: _jsx(Input, { className: "w-20 text-right", inputMode: "numeric", min: 0, onChange: event => onChange({ newPerDay: parseDailyCap(event.target.value) }), step: 1, type: "number", value: settings.newPerDay }) }), _jsx(SettingRow, { description: "Cards already in review rotation. 0 = unlimited.", label: "Reviews per day", children: _jsx(Input, { className: "w-20 text-right", inputMode: "numeric", min: 0, onChange: event => onChange({ reviewsPerDay: parseDailyCap(event.target.value) }), step: 1, type: "number", value: settings.reviewsPerDay }) }), _jsx(SettingRow, { description: "Recall chance targeted when a card comes due. Higher = shorter intervals, more reviews.", label: "Target retention", children: _jsxs(Select, { onValueChange: value => onChange({ desiredRetention: Number(value) }), value: String(settings.desiredRetention), children: [_jsx(SelectTrigger, { "aria-label": "Target retention", className: "w-32", children: _jsx(SelectValue, {}) }), _jsx(SelectContent, { children: RETENTION_OPTIONS.map(option => (_jsx(SelectItem, { value: option.value, children: option.label }, option.value))) })] }) }), _jsx(SettingRow, { label: "Review order", children: _jsx(SegmentedControl, { onChange: order => onChange({ order }), options: ORDER_OPTIONS, value: settings.order }) }), _jsx(SettingRow, { label: "Card flip animation", children: _jsx(Switch, { "aria-label": "Card flip animation", checked: settings.flip, onCheckedChange: flip => onChange({ flip }) }) }), _jsx(SettingRow, { description: "The estimated interval shown on each grade button.", label: "Next-interval hints", children: _jsx(Switch, { "aria-label": "Show next-interval hints", checked: settings.showIntervalHints, onCheckedChange: showIntervalHints => onChange({ showIntervalHints }) }) })] }), _jsxs(DialogFooter, { className: "sm:justify-between", children: [_jsx(Button, { onClick: () => onChange(DEFAULT_STUDY_SETTINGS), size: "sm", variant: "text", children: "Reset to defaults" }), _jsx(Button, { onClick: () => onOpenChange(false), size: "sm", variant: "outline", children: "Done" })] })] }) }));
}
/** Shared grid for the Anki-style deck table: name | New | Learn | Due | row menu. */
const DECK_GRID = 'grid grid-cols-[minmax(0,1fr)_3.25rem_3.25rem_3.25rem_2.25rem] items-center gap-x-2';
const ZERO_COUNTS = { learning: 0, new: 0, review: 0 };
function CountCell({ tone, value }) {
    return (_jsx("span", { className: cn('text-right text-xs tabular-nums', value === 0
            ? 'text-(--ui-text-quaternary)'
            : tone === 'review'
                ? 'font-semibold text-(--theme-primary)'
                : tone === 'learning'
                    ? 'text-foreground'
                    : 'text-muted-foreground'), children: value }));
}
function DeckColumnHeader() {
    return (_jsxs("div", { className: cn(DECK_GRID, 'px-3 pb-1'), children: [_jsx("span", {}), ['New', 'Learn', 'Due'].map(label => (_jsx("span", { className: "text-right text-[0.6rem] font-semibold uppercase tracking-[0.09em] text-(--ui-text-quaternary)", children: label }, label))), _jsx("span", {})] }));
}
function DeckBrowser({ collapsedSections, onBrowse, onCreateDeck, onDeleteDeck, onDeleteSection, onMatch, onMoveDeck, onStudy, onToggleSection, queueCounts, state }) {
    const [deleteDeckTarget, setDeleteDeckTarget] = useState(null);
    const [deleteSectionTarget, setDeleteSectionTarget] = useState(null);
    const now = useMemo(() => new Date(), [state]);
    const groups = groupDecks(state, now);
    if (!groups.length) {
        return (_jsx(EmptyState, { className: "flex-1", description: "Create a deck or import cards to get going.", title: "No decks yet" }));
    }
    return (_jsxs("div", { className: "flex flex-1 flex-col pb-10", children: [_jsx("div", { className: "px-8 pt-3", children: _jsx(DeckColumnHeader, {}) }), groups.map(group => {
                const isCollapsed = collapsedSections.has(group.course);
                const rollup = group.decks.reduce((sum, deck) => {
                    const counts = queueCounts.get(deck.id) ?? ZERO_COUNTS;
                    return {
                        learning: sum.learning + counts.learning,
                        new: sum.new + counts.new,
                        review: sum.review + counts.review
                    };
                }, { learning: 0, new: 0, review: 0 });
                return (_jsxs("section", { className: "px-8 pt-3", children: [_jsxs("div", { className: cn(DECK_GRID, 'group/section rounded-md px-3 py-1.5'), children: [_jsx("h2", { className: "min-w-0 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground", children: _jsxs("button", { "aria-expanded": !isCollapsed, className: "flex min-w-0 items-center gap-1.5 rounded-sm text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50", onClick: () => onToggleSection(group.course), type: "button", children: [_jsx(IconChevronDown, { "aria-hidden": "true", className: cn('shrink-0 transition-transform', isCollapsed && '-rotate-90'), size: 13 }), _jsx("span", { className: "truncate", children: group.course }), _jsxs("span", { className: "font-normal normal-case tracking-normal text-(--ui-text-quaternary)", children: [group.decks.length, " deck", group.decks.length === 1 ? '' : 's'] })] }) }), _jsx(CountCell, { tone: "new", value: rollup.new }), _jsx(CountCell, { tone: "learning", value: rollup.learning }), _jsx(CountCell, { tone: "review", value: rollup.review }), _jsx("span", { className: "flex justify-end", children: group.course.toLocaleLowerCase() !== 'other' && (_jsx("button", { "aria-label": `Delete section ${group.course}`, className: "rounded-sm p-0.5 text-muted-foreground/70 opacity-0 outline-none transition-opacity hover:text-destructive focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 group-hover/section:opacity-100", onClick: () => setDeleteSectionTarget(group.course), title: "Delete section", type: "button", children: _jsx(IconTrash, { size: 13 }) })) })] }), !isCollapsed &&
                            (group.decks.length > 0 ? (_jsx("div", { className: "divide-y divide-(--ui-stroke-quaternary) rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-bg-card)", children: group.decks.map(deck => (_jsx(DeckTableRow, { counts: queueCounts.get(deck.id) ?? ZERO_COUNTS, deck: deck, onBrowse: onBrowse, onDelete: () => setDeleteDeckTarget(deck), onMatch: onMatch, onMove: section => onMoveDeck(deck.id, section), onStudy: onStudy, sections: state.sections }, deck.id))) })) : (_jsxs("div", { className: "rounded-md border border-dashed border-(--ui-stroke-tertiary) bg-(--ui-bg-card) px-4 py-4", children: [_jsx("p", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--ui-text-quaternary)", children: "Empty section" }), _jsxs("div", { className: "mt-1 flex items-center gap-1 text-xs text-muted-foreground", children: [_jsx("span", { children: "No decks yet \u2014" }), _jsx(Button, { onClick: () => onCreateDeck(group.course), size: "inline", variant: "textStrong", children: "add one" })] })] })))] }, group.course));
            }), _jsx(Heatmap, { state: state }), _jsx(DeleteDeckDialog, { deck: deleteDeckTarget, onClose: () => setDeleteDeckTarget(null), onConfirm: () => {
                    if (!deleteDeckTarget) {
                        return;
                    }
                    onDeleteDeck(deleteDeckTarget.id);
                    setDeleteDeckTarget(null);
                } }), _jsx(ConfirmDialog, { confirmLabel: "Delete section", description: "The decks inside are kept \u2014 they move back to the ungrouped list.", destructive: true, dismissOnConfirm: true, onClose: () => setDeleteSectionTarget(null), onConfirm: () => {
                    if (deleteSectionTarget) {
                        onDeleteSection(deleteSectionTarget);
                    }
                }, open: deleteSectionTarget !== null, title: `Delete "${deleteSectionTarget ?? ''}"?` })] }));
}
function ResourceIcon({ children }) {
    return (_jsx("span", { className: "grid size-7 shrink-0 place-items-center rounded-md bg-(--ui-bg-quaternary) text-(--ui-text-tertiary)", children: children }));
}
/** Rough node count for a mind-map card: outline headings + bullets. */
function countOutlineNodes(outline) {
    return outline.split('\n').filter(line => /^\s*(?:[-*+]|#{1,6})\s/.test(line)).length;
}
function ExtrasSectionHeader({ collapsed, course, meta, onToggle }) {
    return (_jsxs("div", { className: "mb-2 flex items-baseline justify-between gap-4", children: [_jsx("h2", { className: "min-w-0 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground", children: _jsxs("button", { "aria-expanded": !collapsed, className: "flex min-w-0 items-center gap-1.5 rounded-sm text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50", onClick: onToggle, type: "button", children: [_jsx(IconChevronDown, { "aria-hidden": "true", className: cn('shrink-0 transition-transform', collapsed && '-rotate-90'), size: 13 }), _jsx("span", { className: "truncate", children: course })] }) }), _jsx("span", { className: "shrink-0 text-[0.6875rem] tabular-nums text-muted-foreground", children: meta })] }));
}
/** Empty state with the one agent CTA these tabs earn — the agent authors this material. */
function AgentEmptyState({ cta, description, onAsk, title }) {
    return (_jsx("div", { className: "grid flex-1 place-items-center px-6 py-16 text-center", children: _jsxs("div", { children: [_jsx("div", { className: "text-sm font-medium", children: title }), _jsx("p", { className: "mx-auto mt-1 max-w-sm text-xs text-muted-foreground", children: description }), _jsxs(Button, { className: "mt-4", onClick: onAsk, size: "sm", variant: "outline", children: [_jsx(IconSparkles, { size: 14 }), cta] })] }) }));
}
function TestsBrowser({ collapsedSections, mindmaps, onAskAgent, onStartTest, onToggleSection, state, testAttempts, tests }) {
    const extrasByCourse = useMemo(() => groupExtras(state.sections, mindmaps, tests), [mindmaps, state.sections, tests]);
    const courses = [...extrasByCourse.entries()]
        .filter(([, extras]) => extras.tests.length > 0)
        .sort(([a], [b]) => a.localeCompare(b));
    if (!courses.length) {
        return (_jsx(AgentEmptyState, { cta: "Ask the agent for one", description: "Practice tests live here, grouped by course. The agent builds them from your lectures and grades your attempts.", onAsk: () => onAskAgent('Build me a practice test from my recent lectures — multiple choice with an explanation for every answer, saved to my Tests folder.'), title: "No practice tests yet" }));
    }
    return (_jsx("div", { className: "pb-10", children: courses.map(([course, extras]) => {
            const isCollapsed = collapsedSections.has(course);
            const bestPct = extras.tests.reduce((best, test) => {
                const attempt = bestAttempt(testAttempts[test.fileName]?.attempts ?? []);
                if (!attempt || attempt.total === 0) {
                    return best;
                }
                const pct = Math.round((attempt.score / attempt.total) * 100);
                return best === null ? pct : Math.max(best, pct);
            }, null);
            return (_jsxs("section", { className: "px-8 pt-4", children: [_jsx(ExtrasSectionHeader, { collapsed: isCollapsed, course: course, meta: `${extras.tests.length} test${extras.tests.length === 1 ? '' : 's'}${bestPct === null ? '' : ` · best ${bestPct}%`}`, onToggle: () => onToggleSection(course) }), !isCollapsed && (_jsx("div", { className: "divide-y divide-(--ui-stroke-quaternary) rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-bg-card)", children: extras.tests.map(test => (_jsx(TestRow, { attempts: testAttempts[test.fileName]?.attempts ?? [], onStart: () => onStartTest(test), test: test }, test.fileName))) }))] }, course));
        }) }));
}
function MindmapCard({ mindmap, onOpen }) {
    const nodes = countOutlineNodes(mindmap.outline);
    return (_jsxs("button", { className: "flex flex-col items-start rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-4 text-left outline-none transition-colors hover:border-(--ui-stroke-secondary) focus-visible:ring-2 focus-visible:ring-ring/50", onClick: onOpen, type: "button", children: [_jsx(IconSitemap, { className: "text-(--ui-text-tertiary)", size: 16 }), _jsx("span", { className: "mt-2 w-full truncate text-sm font-medium", children: mindmap.title }), _jsxs("span", { className: "mt-0.5 text-[0.6875rem] tabular-nums text-muted-foreground", children: [nodes, " node", nodes === 1 ? '' : 's', " \u00B7 opens the interactive map"] })] }));
}
function MindmapsBrowser({ collapsedSections, mindmaps, onAskAgent, onOpenMindmap, onToggleSection, state, tests }) {
    const extrasByCourse = useMemo(() => groupExtras(state.sections, mindmaps, tests), [mindmaps, state.sections, tests]);
    const courses = [...extrasByCourse.entries()]
        .filter(([, extras]) => extras.mindmaps.length > 0)
        .sort(([a], [b]) => a.localeCompare(b));
    if (!courses.length) {
        return (_jsx(AgentEmptyState, { cta: "Ask the agent for one", description: "Mind maps live here, grouped by course \u2014 the big picture of each topic as an interactive map the agent draws from your material.", onAsk: () => onAskAgent('Build a mind map of the big picture from my recent lectures — a markdown outline saved to my Mindmaps folder.'), title: "No mind maps yet" }));
    }
    return (_jsx("div", { className: "pb-10", children: courses.map(([course, extras]) => {
            const isCollapsed = collapsedSections.has(course);
            const nodeTotal = extras.mindmaps.reduce((sum, mindmap) => sum + countOutlineNodes(mindmap.outline), 0);
            return (_jsxs("section", { className: "px-8 pt-4", children: [_jsx(ExtrasSectionHeader, { collapsed: isCollapsed, course: course, meta: `${extras.mindmaps.length} map${extras.mindmaps.length === 1 ? '' : 's'} · ${nodeTotal} nodes`, onToggle: () => onToggleSection(course) }), !isCollapsed && (_jsx("div", { className: "grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3", children: extras.mindmaps.map(mindmap => (_jsx(MindmapCard, { mindmap: mindmap, onOpen: () => onOpenMindmap(mindmap) }, mindmap.fileName))) }))] }, course));
        }) }));
}
function TestRow({ attempts, onStart, test }) {
    const best = bestAttempt(attempts);
    const last = lastAttempt(attempts);
    const count = test.questions.length;
    return (_jsxs("div", { className: "flex w-full items-center gap-3 px-3 py-2.5", children: [_jsx(ResourceIcon, { children: _jsx(IconChecklist, { size: 15 }) }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("div", { className: "truncate text-sm font-medium", children: test.title }), _jsxs("div", { className: "mt-0.5 truncate text-[0.6875rem] text-muted-foreground", children: [count, " question", count === 1 ? '' : 's', best ? ` · best ${best.score}/${best.total}` : ''] })] }), _jsx("span", { className: "hidden w-40 shrink-0 text-right text-xs tabular-nums text-muted-foreground sm:block", children: last ? `Test ${last.score}/${last.total}` : 'Not taken yet' }), _jsx(Button, { onClick: onStart, size: "sm", variant: "outline", children: last ? 'Retake' : 'Start' })] }));
}
function DeckActionsMenu({ deck, matchableCount, onBrowse, onDelete, onMatch, onMove, sections }) {
    const currentSection = !deck.course?.trim() || deck.course.trim().toLocaleLowerCase() === 'other' ? 'Other' : deck.course.trim();
    return (_jsxs(DropdownMenu, { children: [_jsx(DropdownMenuTrigger, { asChild: true, children: _jsx(Button, { "aria-label": `More actions for ${deck.name}`, size: "icon-xs", variant: "ghost", children: _jsx(IconDots, {}) }) }), _jsxs(DropdownMenuContent, { align: "end", className: "w-44", children: [_jsx(DropdownMenuItem, { onSelect: onBrowse, children: "Cards" }), _jsx(DropdownMenuItem, { disabled: matchableCount < 2, onSelect: onMatch, children: "Match" }), _jsxs(DropdownMenuSub, { children: [_jsx(DropdownMenuSubTrigger, { children: "Move to section" }), _jsxs(DropdownMenuSubContent, { className: "w-44", children: [sections.map(section => (_jsxs(DropdownMenuItem, { disabled: section.toLocaleLowerCase() === currentSection.toLocaleLowerCase(), onSelect: () => onMove(section), children: [_jsx("span", { className: "min-w-0 flex-1 truncate", children: section }), section.toLocaleLowerCase() === currentSection.toLocaleLowerCase() && (_jsx("span", { className: "text-muted-foreground", children: "\u2713" }))] }, section))), _jsxs(DropdownMenuItem, { disabled: currentSection === 'Other', onSelect: () => onMove(''), children: [_jsx("span", { className: "min-w-0 flex-1", children: "Other" }), currentSection === 'Other' && _jsx("span", { className: "text-muted-foreground", children: "\u2713" })] })] })] }), _jsx(DropdownMenuItem, { onSelect: onDelete, variant: "destructive", children: "Delete deck" })] })] }));
}
function DeckTableRow({ counts, deck, onBrowse, onDelete, onMatch, onMove, onStudy, sections }) {
    const matchableCount = deck.cards.filter(card => !hasClozeMarker(card.front)).length;
    return (_jsxs("div", { className: cn(DECK_GRID, 'group/deck px-3 py-2 transition-colors hover:bg-(--ui-row-hover-background)'), children: [_jsxs("button", { className: "flex min-w-0 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50", onClick: () => onStudy(deck.id), type: "button", children: [_jsx("span", { className: "truncate text-sm", children: deck.name }), _jsx("span", { "aria-hidden": "true", className: "shrink-0 text-[0.6875rem] font-medium text-(--theme-primary) opacity-0 transition-opacity group-hover/deck:opacity-100", children: "study \u203A" })] }), _jsx(CountCell, { tone: "new", value: counts.new }), _jsx(CountCell, { tone: "learning", value: counts.learning }), _jsx(CountCell, { tone: "review", value: counts.review }), _jsx("span", { className: "flex justify-end opacity-0 transition-opacity focus-within:opacity-100 group-hover/deck:opacity-100", children: _jsx(DeckActionsMenu, { deck: deck, matchableCount: matchableCount, onBrowse: () => onBrowse(deck.id), onDelete: onDelete, onMatch: () => onMatch(deck.id), onMove: onMove, sections: sections }) })] }));
}
function DeleteDeckDialog({ deck, onClose, onConfirm }) {
    return (_jsx(Dialog, { onOpenChange: open => !open && onClose(), open: Boolean(deck), children: _jsxs(DialogContent, { className: "sm:max-w-md", children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "Delete deck?" }), _jsx(DialogDescription, { children: deck ? `“${deck.name}” and its local review schedule will be removed.` : 'This deck will be removed.' })] }), _jsxs(DialogFooter, { children: [_jsx(Button, { onClick: onClose, variant: "outline", children: "Cancel" }), _jsx(Button, { onClick: onConfirm, variant: "destructive", children: "Delete deck" })] })] }) }));
}
// Contribution grid of review activity — month labels, hover tooltips, legend, and a
// today marker. Always visible, centered near the bottom of the cards tab.
const HEAT_MIX = ['', '14%', '24%', '38%', '54%'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function heatColor(level) {
    return level === 0
        ? 'color-mix(in srgb, var(--ui-text-primary) 8%, transparent)'
        : `color-mix(in srgb, var(--ui-text-primary) ${HEAT_MIX[level]}, transparent)`;
}
function Heatmap({ state }) {
    const todayIso = new Date().toISOString();
    const { cells } = useMemo(() => reviewHeatmap(state, todayIso), [state, todayIso]);
    // Local calendar day — must match the cell dates reviewHeatmap now emits.
    const todayKey = localDayKey(new Date(todayIso));
    const firstDayOffset = cells[0] ? new Date(`${cells[0].date}T00:00:00.000Z`).getUTCDay() : 0;
    const weeks = Math.ceil((firstDayOffset + cells.length) / 7);
    const monthLabels = [];
    if (cells[0]) {
        monthLabels.push({ col: 0, label: MONTHS[Number(cells[0].date.slice(5, 7)) - 1] });
        for (let index = 1; index < cells.length; index++) {
            const cell = cells[index];
            if (cell.date.endsWith('-01')) {
                monthLabels.push({
                    col: Math.floor((firstDayOffset + index) / 7),
                    label: MONTHS[Number(cell.date.slice(5, 7)) - 1]
                });
            }
        }
    }
    return (_jsx("div", { className: "mt-auto flex shrink-0 justify-center px-6 pb-10 pt-4", children: _jsx("div", { className: "overflow-x-auto pb-1", children: _jsxs("div", { className: "min-w-max", children: [_jsxs("div", { className: "grid grid-cols-[2rem_auto] gap-x-2 gap-y-1", children: [_jsx("div", {}), _jsx("div", { className: "relative h-3 text-[9px] text-muted-foreground", style: { width: `${weeks * 14}px` }, children: monthLabels.map(month => (_jsx("span", { className: "absolute", style: { left: `${month.col * 14}px` }, children: month.label }, `${month.label}-${month.col}`))) }), _jsx("div", { className: "grid grid-rows-7 gap-[3px] text-[9px] leading-[11px] text-muted-foreground", style: { gridTemplateRows: 'repeat(7, 11px)' }, children: WEEKDAYS.map(day => (_jsx("span", { children: day }, day))) }), _jsxs("div", { className: "grid grid-flow-col grid-rows-7 gap-[3px]", style: { gridAutoColumns: '11px', gridTemplateRows: 'repeat(7, 11px)' }, children: [Array.from({ length: firstDayOffset }, (_, index) => (_jsx("span", { "aria-hidden": "true" }, `leading-${index}`))), cells.map(cell => (_jsx(Tip, { label: `${cell.count} review${cell.count === 1 ? '' : 's'} · ${new Date(`${cell.date}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' })}`, side: "top", children: _jsx("div", { className: cn('rounded-[2px]', cell.date === todayKey && 'ring-1 ring-foreground/60'), style: { backgroundColor: heatColor(cell.level) } }) }, cell.date)))] })] }), _jsxs("div", { className: "mt-2 flex items-center justify-end gap-1 text-[9px] text-muted-foreground", children: [_jsx("span", { children: "Less" }), [0, 1, 2, 3, 4].map(level => (_jsx("span", { className: "size-2.5 rounded-[2px]", style: { backgroundColor: heatColor(level) } }, level))), _jsx("span", { children: "More" })] })] }) }) }));
}
function CardBrowser({ deck, onChange, onDeleteDeck, onMatch, onMoveDeck, onRename, sections, state }) {
    const [editing, setEditing] = useState(null);
    const [adding, setAdding] = useState(false);
    const [armDelete, setArmDelete] = useState(false);
    const [renaming, setRenaming] = useState(false);
    const [query, setQuery] = useState('');
    if (!deck) {
        return _jsx(EmptyState, { className: "flex-1", description: "This deck no longer exists.", title: "Deck not found" });
    }
    const matchableCount = deck.cards.filter(card => !hasClozeMarker(card.front)).length;
    const needle = query.trim().toLocaleLowerCase();
    const visibleCards = needle
        ? deck.cards.filter(card => `${card.front}\n${card.back}\n${card.tags.join('\n')}`.toLocaleLowerCase().includes(needle))
        : deck.cards;
    return (_jsxs("div", { className: "px-6 pb-8", children: [_jsxs("div", { className: "mb-2 flex items-center justify-between gap-3 border-b border-border pb-1.5", children: [_jsxs("div", { className: "min-w-0", children: [_jsxs("div", { className: "flex min-w-0 items-center gap-1", children: [_jsx("h2", { className: "truncate text-sm font-semibold", children: deck.name }), _jsx(Tip, { label: "Rename deck", children: _jsx(Button, { "aria-label": "Rename deck", onClick: () => setRenaming(true), size: "icon-xs", variant: "ghost", children: _jsx(IconPencil, {}) }) })] }), _jsxs("p", { className: "text-xs text-muted-foreground", children: [deck.course ? `${deck.course} · ` : '', deck.cards.length, " card", deck.cards.length === 1 ? '' : 's'] })] }), _jsxs("div", { className: "flex flex-wrap items-center justify-end gap-2", children: [_jsx("div", { className: "w-40", children: _jsx(SectionSelect, { label: "Move deck to section", onChange: onMoveDeck, sections: sections, value: deck.course ?? '' }) }), _jsx(Button, { className: cn(armDelete && 'text-destructive'), onBlur: () => setArmDelete(false), onClick: () => (armDelete ? onDeleteDeck() : setArmDelete(true)), size: "sm", variant: "outline", children: armDelete ? 'Really delete?' : 'Delete deck' }), _jsx(Button, { disabled: matchableCount < 2, onClick: onMatch, size: "sm", variant: "outline", children: "Match" }), _jsx(Button, { onClick: () => setAdding(true), size: "sm", variant: "outline", children: "Add card" })] })] }), deck.cards.length > 0 && (_jsxs("div", { className: "mb-2 flex items-center gap-2", children: [_jsx(Input, { "aria-label": "Search cards", className: "h-8 max-w-64", onChange: event => setQuery(event.target.value), placeholder: "Search front, back, or tags", value: query }), needle && (_jsxs("span", { className: "text-xs tabular-nums text-muted-foreground", children: [visibleCards.length, " of ", deck.cards.length] }))] })), deck.cards.length === 0 ? (_jsx(EmptyState, { className: "min-h-40", description: "Add a card or import a set.", title: "No cards in this deck" })) : visibleCards.length === 0 ? (_jsx(EmptyState, { className: "min-h-40", description: "Try different text or clear the search.", title: "No cards match" })) : (_jsx("div", { className: "overflow-hidden rounded-lg border border-border", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { className: "bg-muted/40 text-xs text-muted-foreground", children: _jsxs("tr", { children: [_jsx("th", { className: "px-3 py-2 text-left font-medium", children: "Front" }), _jsx("th", { className: "hidden px-3 py-2 text-left font-medium md:table-cell", children: "Back" }), _jsx("th", { className: "px-3 py-2 text-left font-medium", children: "Tags" }), _jsx("th", { className: "w-8 px-3 py-2" })] }) }), _jsx("tbody", { children: visibleCards.map(card => (_jsxs("tr", { className: cn('cursor-pointer border-t border-border hover:bg-accent', card.suspended && 'opacity-45'), onClick: () => setEditing(card), children: [_jsxs("td", { className: "max-w-xs truncate px-3 py-2", children: [card.suspended && (_jsx(IconPlayerPause, { className: "-mt-px mr-1 inline text-muted-foreground", size: 12 })), card.tags.includes(LEECH_TAG) && (_jsx(Badge, { className: "mr-1.5 border-destructive/40 text-destructive", variant: "outline", children: "leech" })), card.front] }), _jsx("td", { className: "hidden max-w-xs truncate px-3 py-2 text-muted-foreground md:table-cell", children: card.back }), _jsx("td", { className: "px-3 py-2", children: _jsx("div", { className: "flex flex-wrap gap-1", children: card.tags.map(tag => (_jsx(Badge, { variant: "outline", children: tag }, tag))) }) }), _jsx("td", { className: "px-3 py-2 text-right text-muted-foreground", children: "\u203A" })] }, card.id))) })] }) })), editing && (_jsx(EditCardDialog, { card: editing, onClose: () => setEditing(null), onDelete: () => {
                    onChange(deleteCard(state, deck.id, editing.id));
                    setEditing(null);
                }, onSave: card => {
                    onChange(updateCard(state, deck.id, card));
                    setEditing(null);
                }, onToggleSuspend: () => {
                    onChange(toggleSuspendCard(state, deck.id, editing.id));
                    setEditing(null);
                } })), adding && (_jsx(AddCardDialog, { onClose: () => setAdding(false), onCreate: (front, back, tags) => {
                    onChange(addCard(state, deck.id, front, back, tags));
                    setAdding(false);
                } })), renaming && _jsx(RenameDeckDialog, { deck: deck, onClose: () => setRenaming(false), onRename: onRename })] }));
}
function EditCardDialog({ card, onClose, onDelete, onSave, onToggleSuspend }) {
    const [front, setFront] = useState(card.front);
    const [back, setBack] = useState(card.back);
    const [tags, setTags] = useState(card.tags.join(', '));
    return (_jsx(Dialog, { onOpenChange: open => !open && onClose(), open: true, children: _jsxs(DialogContent, { className: "sm:max-w-lg", children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "Edit card" }), _jsx(DialogDescription, { children: "Suspend hides a card from review without deleting it." })] }), _jsxs("div", { className: "flex flex-col gap-3", children: [_jsx(Textarea, { className: "min-h-20", onChange: event => setFront(event.target.value), placeholder: "Front", value: front }), _jsx(Textarea, { className: "min-h-20", onChange: event => setBack(event.target.value), placeholder: "Back", value: back }), _jsx(Input, { onChange: event => setTags(event.target.value), placeholder: "Tags (comma-separated)", value: tags })] }), _jsxs(DialogFooter, { className: "flex-wrap gap-2 sm:justify-between", children: [_jsxs("div", { className: "flex gap-2", children: [_jsx(Button, { className: "text-destructive", onClick: onDelete, variant: "outline", children: "Delete" }), _jsx(Button, { onClick: onToggleSuspend, variant: "outline", children: card.suspended ? 'Unsuspend' : 'Suspend' })] }), _jsx(Button, { disabled: !front.trim() || (!back.trim() && !hasClozeMarker(front)), onClick: () => onSave({
                                ...card,
                                back: back.trim(),
                                front: front.trim(),
                                tags: tags
                                    .split(',')
                                    .map(tag => tag.trim())
                                    .filter(Boolean)
                            }), children: "Save" })] })] }) }));
}
function AddCardDialog({ onClose, onCreate }) {
    const [front, setFront] = useState('');
    const [back, setBack] = useState('');
    const [tags, setTags] = useState('');
    return (_jsx(Dialog, { onOpenChange: open => !open && onClose(), open: true, children: _jsxs(DialogContent, { className: "sm:max-w-lg", children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "Add card" }), _jsxs(DialogDescription, { children: ["New cards enter the review queue as \u201Cnew\u201D. Wrap text in ", '{{c1::…}}', " for cloze blanks \u2014 each index becomes its own card, and the back is optional."] })] }), _jsxs("div", { className: "flex flex-col gap-3", children: [_jsx(Textarea, { className: "min-h-20", onChange: event => setFront(event.target.value), placeholder: 'Front — plain, or cloze: {{c1::furosemide}} blocks {{c2::Na-K-2Cl}}', value: front }), _jsx(Textarea, { className: "min-h-20", onChange: event => setBack(event.target.value), placeholder: "Back", value: back }), _jsx(Input, { onChange: event => setTags(event.target.value), placeholder: "Tags (comma-separated)", value: tags })] }), _jsxs(DialogFooter, { children: [_jsx(Button, { onClick: onClose, variant: "outline", children: "Cancel" }), _jsx(Button, { disabled: !front.trim() || (!back.trim() && !hasClozeMarker(front)), onClick: () => onCreate(front.trim(), back.trim(), tags
                                .split(',')
                                .map(tag => tag.trim())
                                .filter(Boolean)), children: "Add card" })] })] }) }));
}
function FlipFace({ back, children, label, muted }) {
    return (_jsxs("div", { className: cn('absolute inset-0 flex min-h-64 flex-col justify-center gap-3 rounded-xl border border-border bg-card p-8 text-left [backface-visibility:hidden]', back && '[transform:rotateY(180deg)]'), children: [_jsx("div", { className: "text-[10px] font-medium uppercase tracking-widest text-muted-foreground", children: label }), _jsx("div", { className: cn('text-lg leading-relaxed', muted ? 'text-foreground/80' : 'text-foreground'), children: children })] }));
}
function buildMatchTiles(cards, size) {
    // Deterministic-enough shuffle without RNG dependence on the module: seed off the
    // clock once per round (fresh each mount).
    const pool = [...cards];
    const seed = Date.now();
    for (let i = pool.length - 1; i > 0; i--) {
        const j = ((seed >> (i % 16)) ^ (i * 2654435761)) % (i + 1);
        const k = j < 0 ? -j : j;
        [pool[i], pool[k]] = [pool[k], pool[i]];
    }
    const chosen = pool.slice(0, size);
    const tiles = [];
    for (const card of chosen) {
        tiles.push({ cardId: card.id, id: `${card.id}:f`, side: 'front', text: card.front });
        tiles.push({ cardId: card.id, id: `${card.id}:b`, side: 'back', text: card.back });
    }
    for (let i = tiles.length - 1; i > 0; i--) {
        const j = ((seed >> ((i + 3) % 16)) ^ (i * 40503)) % (i + 1);
        const k = j < 0 ? -j : j;
        [tiles[i], tiles[k]] = [tiles[k], tiles[i]];
    }
    return tiles;
}
function MatchGame({ deck, onExit }) {
    // Cloze cards are fill-in-the-blank, not term/definition pairs — exclude them.
    const [matchCards] = useState(() => deck ? deck.cards.filter(card => !hasClozeMarker(card.front)) : []);
    const size = Math.min(6, matchCards.length);
    const [tiles, setTiles] = useState(() => buildMatchTiles(matchCards, size));
    const [selected, setSelected] = useState(null);
    const [matched, setMatched] = useState(new Set());
    const [wrong, setWrong] = useState(null);
    const [elapsed, setElapsed] = useState(0);
    const [won, setWon] = useState(false);
    const restart = useCallback(() => {
        if (!matchCards.length) {
            return;
        }
        setTiles(buildMatchTiles(matchCards, size));
        setSelected(null);
        setMatched(new Set());
        setWrong(null);
        setElapsed(0);
        setWon(false);
    }, [matchCards, size]);
    // Timer runs until the board is cleared.
    useEffect(() => {
        if (won) {
            return;
        }
        const id = window.setInterval(() => setElapsed(value => value + 1), 1000);
        return () => window.clearInterval(id);
    }, [won]);
    const pick = useCallback((tile) => {
        if (matched.has(tile.id) || wrong || tile.id === selected) {
            return;
        }
        if (!selected) {
            setSelected(tile.id);
            return;
        }
        const first = tiles.find(candidate => candidate.id === selected);
        if (!first) {
            setSelected(tile.id);
            return;
        }
        if (first.cardId === tile.cardId && first.side !== tile.side) {
            const next = new Set(matched);
            next.add(first.id);
            next.add(tile.id);
            setMatched(next);
            setSelected(null);
            if (next.size === tiles.length) {
                setWon(true);
            }
        }
        else {
            setWrong([first.id, tile.id]);
            setSelected(null);
            window.setTimeout(() => setWrong(null), 550);
        }
    }, [matched, selected, tiles, wrong]);
    if (!deck) {
        return _jsx(EmptyState, { className: "flex-1", description: "This deck no longer exists.", title: "Deck not found" });
    }
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(elapsed % 60).padStart(2, '0');
    return (_jsxs("div", { className: "flex min-h-0 flex-1 flex-col px-6 pb-8", children: [_jsxs("div", { className: "flex items-center justify-between pb-3", children: [_jsxs("div", { children: [_jsxs("h2", { className: "text-sm font-semibold", children: [deck.name, " \u2014 Match"] }), _jsx("p", { className: "text-xs text-muted-foreground", children: "Tap a term, then its match. Fastest time wins." })] }), _jsxs("span", { className: "text-lg font-semibold tabular-nums text-muted-foreground", children: [mm, ":", ss] })] }), won ? (_jsxs("div", { className: "flex flex-1 flex-col items-center justify-center gap-4", children: [_jsxs("div", { className: "text-center", children: [_jsx("div", { className: "text-2xl font-semibold", children: "Matched them all" }), _jsxs("div", { className: "pt-1 text-sm text-muted-foreground", children: [size, " pairs in ", mm, ":", ss] })] }), _jsxs("div", { className: "flex gap-2", children: [_jsx(Button, { onClick: restart, children: "Play again" }), _jsx(Button, { onClick: onExit, variant: "outline", children: "Back to decks" })] })] })) : (_jsx("div", { className: "grid flex-1 auto-rows-fr grid-cols-2 gap-2.5 md:grid-cols-3 lg:grid-cols-4", children: tiles.map(tile => {
                    const isMatched = matched.has(tile.id);
                    const isWrong = wrong?.includes(tile.id);
                    const isSelected = selected === tile.id;
                    return (_jsx("button", { className: cn('flex items-center justify-center rounded-lg border p-3 text-center text-sm leading-snug transition-[transform,opacity,border-color,background-color] duration-200 ease-out active:scale-[0.98]', isMatched && 'pointer-events-none scale-95 border-transparent bg-transparent opacity-0', isSelected && 'border-(--theme-primary) bg-(--theme-primary)/10', isWrong && 'nemesis-shake border-destructive text-destructive', !isMatched && !isSelected && !isWrong && 'border-border bg-card hover:border-(--theme-primary)/50'), onClick: () => pick(tile), type: "button", children: tile.text }, tile.id));
                }) }))] }));
}
function ReviewSurface({ activeCategory, chatOpen, flip, intervals, item, onExit, onGrade, onReveal, onToggleChat, onUndo, position, remainingCounts, revealed, sessionTotal, showIntervalHints }) {
    const countItems = [
        { category: 'new', label: 'New', value: remainingCounts.new },
        { category: 'learning', label: 'Learning', value: remainingCounts.learning },
        { category: 'review', label: 'Review', value: remainingCounts.review }
    ];
    // Cloze cards drill one index: blank it in the prompt, reveal everything in
    // the answer, and show the (optional) back as a footnote under the answer.
    const isCloze = item.clozeIndex !== undefined;
    const prompt = isCloze ? renderClozePrompt(item.card.front, item.clozeIndex ?? 0) : item.card.front;
    const answer = isCloze ? renderClozeAnswer(item.card.front) : item.card.back;
    const answerNote = isCloze && item.card.back.trim() ? item.card.back : null;
    return (_jsx("div", { className: "flex flex-1 flex-col items-center px-6 pb-8 pt-5", children: _jsxs("div", { className: "flex w-full max-w-2xl flex-1 flex-col", children: [_jsxs("div", { className: "flex items-center justify-between gap-4 pb-2 text-xs text-muted-foreground", children: [_jsxs("span", { className: "flex min-w-0 items-center gap-2 truncate", children: [_jsxs("button", { "aria-label": "Leave review", className: "flex shrink-0 items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50", onClick: onExit, type: "button", children: [_jsx(IconArrowLeft, { size: 13 }), "back"] }), _jsx("span", { "aria-hidden": "true", className: "text-(--ui-text-quaternary)", children: "\u00B7" }), item.deckName, item.isNew && (_jsx(Badge, { className: "ml-2", variant: "outline", children: "new" }))] }), _jsxs("div", { className: "flex shrink-0 items-center gap-4", children: [_jsxs("button", { "aria-label": "Chat about this card", "aria-pressed": chatOpen, className: cn('flex items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50', chatOpen && 'text-foreground'), onClick: onToggleChat, type: "button", children: [_jsx(IconMessage, { size: 13 }), "chat ", _jsx("span", { className: "text-[10px] opacity-60", children: "c" })] }), onUndo && (_jsxs(Button, { onClick: onUndo, size: "inline", variant: "text", children: ["Undo ", _jsx("span", { className: "text-[10px] opacity-60", children: "u" })] })), _jsxs("span", { className: "tabular-nums", children: [position, " of ", sessionTotal] }), _jsx("span", { "aria-label": "Cards remaining", className: "flex items-center gap-3 text-[0.6875rem] tabular-nums", children: countItems.map(count => (_jsxs("span", { className: "flex items-center gap-1.5", children: [_jsx("span", { "aria-hidden": "true", className: cn('size-1 rounded-full bg-(--ui-stroke-secondary)', activeCategory === count.category && 'bg-(--theme-primary)') }), _jsxs("span", { children: [_jsx("span", { className: "font-medium text-foreground", children: count.value }), " ", count.label] })] }, count.category))) })] })] }), flip ? (_jsx("button", { "aria-label": revealed ? answer : 'Show answer', className: "nemesis-flip flex-1 [perspective:1600px]", "data-flipped": revealed ? 'true' : undefined, onClick: () => !revealed && onReveal(), type: "button", children: _jsxs("div", { className: "nemesis-flip-inner relative h-full min-h-64 w-full", children: [_jsx(FlipFace, { label: "Question", children: prompt }), _jsxs(FlipFace, { back: true, label: "Answer", muted: true, children: [answer, answerNote && _jsx("div", { className: "pt-3 text-sm text-muted-foreground", children: answerNote })] })] }) })) : (_jsxs("div", { className: "flex min-h-64 flex-1 flex-col justify-center gap-5 rounded-xl border border-border bg-card p-8", children: [_jsxs("div", { children: [_jsx("div", { className: "pb-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground", children: "Question" }), _jsx("div", { className: "text-lg leading-relaxed", children: prompt })] }), revealed && (_jsxs(_Fragment, { children: [_jsx("div", { className: "border-t border-border" }), _jsxs("div", { children: [_jsx("div", { className: "pb-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground", children: "Answer" }), _jsx("div", { className: "text-lg leading-relaxed text-foreground/80", children: answer }), answerNote && _jsx("div", { className: "pt-2 text-sm text-muted-foreground", children: answerNote })] })] }))] })), item.card.tags.length > 0 && (_jsx("div", { className: "flex flex-wrap gap-1 pt-2.5", children: item.card.tags.map(tag => (_jsx(Badge, { variant: "outline", children: tag }, tag))) })), _jsx("div", { className: "pt-4", children: revealed ? (_jsx("div", { className: "grid grid-cols-4 gap-2", children: GRADES.map(option => (_jsxs(Button, { className: cn('flex-col gap-0.5 py-5', option.rating === 'again' && 'text-(--theme-primary)'), onClick: () => onGrade(option.rating), variant: "secondary", children: [_jsx("span", { children: option.label }), showIntervalHints && (_jsxs("span", { className: "text-[10px] opacity-60", children: [intervals[option.rating], " \u00B7 ", option.key] }))] }, option.rating))) })) : (_jsxs(Button, { className: "w-full py-5", onClick: onReveal, variant: "secondary", children: ["Show answer ", _jsx("span", { className: "ml-2 text-[10px] opacity-60", children: "Space" })] })) }), _jsx("p", { className: "pt-3 text-center text-[10px] text-(--ui-text-quaternary)", children: "Space to flip \u00B7 1\u20134 to grade \u00B7 u undo \u00B7 Esc exit" })] }) }));
}
function ImportDialog({ onImport, onOpenChange, open, sections }) {
    const [name, setName] = useState('');
    const [course, setCourse] = useState('');
    const [text, setText] = useState('');
    const parsedCount = useMemo(() => parseCardPaste(text).length, [text]);
    const submit = () => {
        if (onImport(name, course, text)) {
            setName('');
            setCourse('');
            setText('');
        }
    };
    return (_jsx(Dialog, { onOpenChange: onOpenChange, open: open, children: _jsxs(DialogContent, { className: "sm:max-w-lg", children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "Import cards" }), _jsx(DialogDescription, { children: "Paste one card per line \u2014 term and definition separated by a tab (Quizlet export), \u201C - \u201D, or a comma." })] }), _jsxs("div", { className: "flex flex-col gap-3", children: [_jsx(Input, { onChange: event => setName(event.target.value), placeholder: "Deck name", value: name }), _jsxs("div", { className: "space-y-1.5", children: [_jsx("label", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-muted-foreground", children: "Section" }), _jsx(SectionSelect, { label: "Imported deck section", onChange: setCourse, sections: sections, value: course })] }), _jsx(Textarea, { className: "min-h-40 font-mono text-xs", onChange: event => setText(event.target.value), placeholder: 'lisinopril\tACE inhibitor — dry cough via bradykinin\nmetoprolol - beta-1 selective blocker', value: text }), _jsx("div", { className: "text-xs text-muted-foreground", children: parsedCount > 0 ? `${parsedCount} card${parsedCount === 1 ? '' : 's'} detected` : 'No cards detected yet' })] }), _jsxs(DialogFooter, { children: [_jsx(Button, { onClick: () => onOpenChange(false), variant: "outline", children: "Cancel" }), _jsx(Button, { disabled: parsedCount === 0, onClick: submit, children: "Create deck" })] })] }) }));
}
