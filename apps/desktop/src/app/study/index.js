import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Study — Anki-style spaced repetition over FSRS (see model.ts for the algorithm/licensing
// note). Interaction model deliberately mirrors what health-science students already have
// as muscle memory from Anki: deck browser with due badges → flip card (Space) →
// Again/Hard/Good/Easy (1-4), with the next-interval hint under each grade button.
import { IconCards, IconChevronDown, IconChecklist, IconDots, IconFileImport, IconFolderPlus, IconLayoutGrid, IconList, IconPencil, IconPlayerPause, IconPlus, IconSettings, IconSitemap } from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { hasClozeMarker, renderClozeAnswer, renderClozePrompt } from './cloze';
import { DECK_DIR, importedDeckFileNames, scanAllDeckFiles } from './deck-files';
import { bestAttempt, groupExtras, lastAttempt, loadTestAttempts, scanMindmapFiles, scanTestFiles } from './extras';
import { parseCardPaste } from './import-cards';
import { MindmapViewerDialog } from './mindmap-viewer';
import { addCard, addSection, adoptLegacyDeckFiles, assignDeckSection, buildQueue, deckStats, DEFAULT_STUDY_SETTINGS, deleteCard, deleteDeck, freshId, getSettings, gradeCard, groupDecks, LEECH_TAG, loadState, localDayKey, previewIntervals, reconcileDeckFiles, renameDeck, reviewHeatmap, saveState, setSettings, studyMotivation, toggleSuspendCard, undoLastGrade, updateCard } from './model';
import { deckRetentionCurve } from './retention';
import { TestSurface } from './test-mode';
const GRADES = [
    { key: '1', label: 'Again', rating: 'again' },
    { key: '2', label: 'Hard', rating: 'hard' },
    { key: '3', label: 'Good', rating: 'good' },
    { key: '4', label: 'Easy', rating: 'easy' }
];
const VIEW_MODE_KEY = 'nemesis.study.view';
const COLLAPSED_SECTIONS_KEY = 'nemesis.study.sections.collapsed.v1';
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
function loadViewMode() {
    try {
        return window.localStorage.getItem(VIEW_MODE_KEY) === 'cards' ? 'cards' : 'list';
    }
    catch {
        return 'list';
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
    const [view, setView] = useState(() => loadViewMode());
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
    const now = useMemo(() => new Date(), [state, reviewing]);
    const queue = useMemo(() => (reviewing ? buildQueue(state, reviewDeckId, now) : []), [state, reviewDeckId, reviewing, now]);
    const current = queue[0];
    const remainingCounts = useMemo(() => countQueueCategories(queue, state), [queue, state]);
    const todayQueue = useMemo(() => buildQueue(state, null, now), [now, state]);
    const todayCounts = useMemo(() => countQueueCategories(todayQueue, state), [state, todayQueue]);
    const scheduledDue = todayCounts.learning + todayCounts.review;
    const estimatedReviewMinutes = todayQueue.length > 0 ? Math.max(1, Math.ceil((todayQueue.length * 20) / 60)) : 0;
    const totals = deckStats(state, null, now);
    const sections = useMemo(() => groupDecks(state, now)
        .map(group => group.course)
        .filter(course => course.toLocaleLowerCase() !== 'other'), [now, state]);
    const settings = getSettings(state);
    const flip = settings.flip && !reducedMotion;
    const update = useCallback((next) => {
        setState(next);
        saveState(next);
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
        const reconcile = async () => {
            lastRun = Date.now();
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
        // Snapshot BEFORE grading so Undo can restore the exact schedule entry
        // (or its absence, for a never-studied card).
        const previous = state.schedule[current.scheduleKey];
        setLastUndo({ rating, scheduleKey: current.scheduleKey, ...(previous ? { previous } : {}) });
        setSessionGrades(counts => ({ ...counts, [rating]: counts[rating] + 1 }));
        update(gradeCard(state, current.scheduleKey, rating, new Date()));
        setRevealed(false);
        setDone(count => count + 1);
    }, [current, state, update]);
    const undoGrade = useCallback(() => {
        if (!lastUndo) {
            return;
        }
        update(undoLastGrade(state, lastUndo));
        setSessionGrades(counts => ({ ...counts, [lastUndo.rating]: Math.max(0, counts[lastUndo.rating] - 1) }));
        setDone(count => Math.max(0, count - 1));
        setLastUndo(null);
        setRevealed(false);
    }, [lastUndo, state, update]);
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
    const setViewMode = useCallback((mode) => {
        setView(mode);
        try {
            window.localStorage.setItem(VIEW_MODE_KEY, mode);
        }
        catch {
            // persistence is best-effort
        }
    }, []);
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
    return (_jsxs("div", { className: "flex h-full min-h-0 flex-col overflow-y-auto", children: [_jsxs("header", { className: "flex shrink-0 items-start justify-between gap-3 px-6 pb-3 pt-5", children: [_jsxs("div", { className: "min-w-0", children: [_jsx("h1", { className: "text-lg font-semibold tracking-tight", children: "Study" }), _jsxs("p", { className: "mt-0.5 text-[0.65rem] font-medium tabular-nums text-(--ui-text-tertiary)", children: [totals.due, " due \u00B7 ", totals.fresh, " new \u00B7 ", totals.total, " cards"] })] }), _jsx("div", { className: "flex shrink-0 items-center gap-1", children: reviewing || browseDeckId || matchDeckId || takingTest ? (_jsx(Button, { onClick: () => {
                                exitReview();
                                setBrowseDeckId(null);
                                setMatchDeckId(null);
                                setTakingTest(null);
                            }, size: "sm", variant: "outline", children: "Back to decks" })) : (_jsxs(_Fragment, { children: [_jsxs(DropdownMenu, { children: [_jsx(DropdownMenuTrigger, { asChild: true, children: _jsx(Button, { "aria-label": "Add study material", size: "icon-xs", title: "Add study material", variant: "ghost", children: _jsx(IconPlus, {}) }) }), _jsxs(DropdownMenuContent, { align: "end", className: "w-44", children: [_jsxs(DropdownMenuItem, { onSelect: () => setNewDeckSection(''), children: [_jsx(IconCards, {}), "New deck"] }), _jsxs(DropdownMenuItem, { onSelect: () => setNewSectionOpen(true), children: [_jsx(IconFolderPlus, {}), "New section"] }), _jsxs(DropdownMenuItem, { onSelect: () => setImportOpen(true), children: [_jsx(IconFileImport, {}), "Import cards"] })] })] }), _jsx(Tip, { label: "Study settings", children: _jsx(Button, { "aria-label": "Study settings", onClick: () => setSettingsOpen(true), size: "icon-xs", variant: "ghost", children: _jsx(IconSettings, {}) }) })] })) })] }), !reviewing && !browseDeckId && !matchDeckId && !takingTest && (_jsx(TodaysReviewBrief, { counts: todayCounts, estimatedMinutes: estimatedReviewMinutes, hasScheduledDue: scheduledDue > 0, onStart: () => startReview(null), total: todayQueue.length })), autoImported.length > 0 && !reviewing && !browseDeckId && (_jsxs("div", { className: "mx-6 mb-1 flex items-center justify-between rounded-md border border-(--theme-primary)/40 bg-(--theme-primary)/10 px-3 py-1.5 text-xs", children: [_jsxs("span", { children: ["Nemesis added ", autoImported.length === 1 ? 'a new deck' : `${autoImported.length} new decks`, ":", ' ', autoImported.join(', ')] }), _jsx("button", { className: "text-muted-foreground hover:text-foreground", onClick: () => setAutoImported([]), type: "button", children: "Dismiss" })] })), reviewing ? (current ? (_jsx(ReviewSurface, { activeCategory: categoryForQueueItem(current, state), flip: flip, intervals: previewIntervals(state, current.scheduleKey, now), item: current, onGrade: grade, onReveal: () => setRevealed(true), onUndo: lastUndo ? undoGrade : null, position: Math.min(done + 1, sessionTotal), remainingCounts: remainingCounts, revealed: revealed, sessionTotal: sessionTotal, showIntervalHints: settings.showIntervalHints })) : (_jsx(EmptyState, { className: "flex-1", description: done > 0
                    ? `${sessionRecapLine(done, sessionGrades)} Come back when the next ones are due.`
                    : 'Nothing is due right now.', title: "All caught up" }))) : matchDeckId ? (_jsx(MatchGame, { deck: state.decks.find(deck => deck.id === matchDeckId) ?? null, onExit: () => setMatchDeckId(null) })) : browseDeckId ? (_jsx(CardBrowser, { deck: state.decks.find(deck => deck.id === browseDeckId) ?? null, onChange: update, onDeleteDeck: () => removeDeck(browseDeckId), onMatch: () => startMatch(browseDeckId), onMoveDeck: section => moveDeck(browseDeckId, section), onRename: renameBrowsedDeck, sections: sections, state: state })) : takingTest ? (_jsx(TestSurface, { file: takingTest, onComplete: () => setTestAttempts(loadTestAttempts()), onExit: () => setTakingTest(null) })) : (_jsx(DeckBrowser, { collapsedSections: collapsedSections, mindmaps: mindmaps, onBrowse: setBrowseDeckId, onCreateDeck: setNewDeckSection, onDeleteDeck: removeDeck, onMatch: startMatch, onMoveDeck: moveDeck, onOpenMindmap: setViewingMindmap, onStartTest: setTakingTest, onStudy: startReview, onToggleSection: toggleSection, onViewChange: setViewMode, state: state, testAttempts: testAttempts, tests: tests, view: view })), _jsx(MindmapViewerDialog, { file: viewingMindmap, onOpenChange: open => !open && setViewingMindmap(null) }), _jsx(ImportDialog, { onImport: importCards, onOpenChange: setImportOpen, open: importOpen, sections: sections }), newDeckSection !== null && (_jsx(NewDeckDialog, { initialSection: newDeckSection, onClose: () => setNewDeckSection(null), onCreate: createDeck, sections: sections })), newSectionOpen && (_jsx(NewSectionDialog, { onClose: () => setNewSectionOpen(false), onCreate: createSection, sections: sections })), _jsx(StudySettingsDialog, { onChange: patch => update(setSettings(state, patch)), onOpenChange: setSettingsOpen, open: settingsOpen, settings: settings })] }));
}
function TodaysReviewBrief({ counts, estimatedMinutes, hasScheduledDue, onStart, total }) {
    const hasFreshCards = counts.new > 0;
    return (_jsxs("section", { className: "mx-6 mb-3 flex items-center justify-between gap-5 rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) px-4 py-3", children: [_jsxs("div", { className: "min-w-0", children: [_jsx("p", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--ui-text-tertiary)", children: "Today\u2019s review" }), hasScheduledDue ? (_jsxs("p", { className: "mt-1 text-base font-semibold tracking-tight", children: [total, " card", total === 1 ? '' : 's', ' ', _jsxs("span", { className: "font-normal text-muted-foreground", children: ["\u00B7 about ", estimatedMinutes, " min"] })] })) : (_jsx("p", { className: "mt-1 text-base font-semibold tracking-tight", children: "You\u2019re caught up" })), _jsxs("div", { className: "mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.6875rem] tabular-nums text-muted-foreground", children: [_jsxs("span", { children: [_jsx("span", { className: "font-semibold text-foreground", children: counts.new }), " New"] }), _jsxs("span", { children: [_jsx("span", { className: "font-semibold text-foreground", children: counts.learning }), " Learning"] }), _jsxs("span", { children: [_jsx("span", { className: "font-semibold text-foreground", children: counts.review }), " Review"] })] })] }), hasScheduledDue ? (_jsx(Button, { onClick: onStart, size: "sm", children: "Start review \u2192" })) : hasFreshCards ? (_jsx(Button, { onClick: onStart, size: "sm", children: "Practice new cards" })) : null] }));
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
                    }, placeholder: "Section name (e.g. Pharmacology)", value: name }), normalized && unavailable && (_jsx("p", { className: "text-xs text-muted-foreground", children: "That section already exists. \u201COther\u201D is reserved for ungrouped decks." })), _jsxs(DialogFooter, { children: [_jsx(Button, { onClick: onClose, variant: "outline", children: "Cancel" }), _jsx(Button, { disabled: !valid, onClick: () => onCreate(name), children: "Create section" })] })] }) }));
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
function DeckBrowser({ collapsedSections, mindmaps, onBrowse, onCreateDeck, onDeleteDeck, onMatch, onMoveDeck, onOpenMindmap, onStartTest, onStudy, onToggleSection, onViewChange, state, testAttempts, tests, view }) {
    const [deleteDeckTarget, setDeleteDeckTarget] = useState(null);
    const { curvesByDeck, now } = useMemo(() => {
        const calculationTime = new Date();
        const curves = new Map(state.decks.map(deck => [
            deck.id,
            deckRetentionCurve(deck.cards.flatMap(card => {
                const schedule = state.schedule[card.id];
                return schedule ? [schedule] : [];
            }), calculationTime)
        ]));
        return { curvesByDeck: curves, now: calculationTime };
    }, [state]);
    const deckGroups = groupDecks(state, now);
    const extrasByCourse = useMemo(() => groupExtras(state.sections, mindmaps, tests), [mindmaps, state.sections, tests]);
    const extraOnlyCourses = [...extrasByCourse.keys()]
        .filter(course => !deckGroups.some(group => group.course === course))
        .sort((a, b) => a.localeCompare(b));
    const groups = [
        ...deckGroups.map(group => ({ ...group, extras: extrasByCourse.get(group.course) })),
        ...extraOnlyCourses.map(course => ({
            course,
            decks: [],
            extras: extrasByCourse.get(course),
            stats: { due: 0, fresh: 0, total: 0 }
        }))
    ].sort((a, b) => {
        const aIsOther = a.course.toLocaleLowerCase() === 'other';
        const bIsOther = b.course.toLocaleLowerCase() === 'other';
        if (aIsOther !== bIsOther) {
            return aIsOther ? 1 : -1;
        }
        return b.stats.due - a.stats.due || a.course.localeCompare(b.course);
    });
    if (!groups.length) {
        return (_jsx(EmptyState, { className: "flex-1", description: "Create a deck or import cards to get going.", title: "No decks yet" }));
    }
    return (_jsxs("div", { className: "pb-10", children: [_jsx("div", { className: "flex justify-end px-8 pt-1", children: _jsxs("div", { className: "flex items-center rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-0.5", children: [_jsx(Tip, { label: "List view", children: _jsx(Button, { "aria-label": "List view", "aria-pressed": view === 'list', className: cn(view === 'list' && 'bg-(--ui-control-active-background) text-foreground'), onClick: () => onViewChange('list'), size: "icon-xs", variant: "ghost", children: _jsx(IconList, {}) }) }), _jsx(Tip, { label: "Card view", children: _jsx(Button, { "aria-label": "Card view", "aria-pressed": view === 'cards', className: cn(view === 'cards' && 'bg-(--ui-control-active-background) text-foreground'), onClick: () => onViewChange('cards'), size: "icon-xs", variant: "ghost", children: _jsx(IconLayoutGrid, {}) }) })] }) }), groups.map(group => {
                const groupMindmaps = group.extras?.mindmaps ?? [];
                const groupTests = group.extras?.tests ?? [];
                const hasExtras = groupMindmaps.length > 0 || groupTests.length > 0;
                const hasResources = group.decks.length > 0 || hasExtras;
                const isCollapsed = collapsedSections.has(group.course);
                return (_jsxs("section", { className: "px-8 pt-5", children: [_jsxs("div", { className: "mb-2 flex items-baseline justify-between gap-4", children: [_jsx("h2", { className: "min-w-0 text-sm font-semibold tracking-tight", children: _jsxs("button", { "aria-expanded": !isCollapsed, className: "flex min-w-0 items-center gap-1.5 rounded-sm text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50", onClick: () => onToggleSection(group.course), type: "button", children: [_jsx(IconChevronDown, { "aria-hidden": "true", className: cn('shrink-0 transition-transform', isCollapsed && '-rotate-90'), size: 14 }), _jsx("span", { className: "truncate", children: group.course })] }) }), _jsxs("span", { className: "shrink-0 text-[0.6875rem] tabular-nums text-muted-foreground", children: [group.stats.due, " due \u00B7 ", group.decks.length, " deck", group.decks.length === 1 ? '' : 's', " \u00B7", ' ', group.stats.total, " cards", groupMindmaps.length > 0 &&
                                            ` · ${groupMindmaps.length} mind map${groupMindmaps.length === 1 ? '' : 's'}`, groupTests.length > 0 && ` · ${groupTests.length} test${groupTests.length === 1 ? '' : 's'}`] })] }), !isCollapsed &&
                            (hasResources ? (view === 'list' ? (_jsxs("div", { className: "divide-y divide-(--ui-stroke-tertiary) rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-bg-card)", children: [group.decks.map(deck => (_jsx(DeckRow, { curve: curvesByDeck.get(deck.id) ?? [], deck: deck, now: now, onBrowse: onBrowse, onDelete: () => setDeleteDeckTarget(deck), onMatch: onMatch, onMove: section => onMoveDeck(deck.id, section), onStudy: onStudy, sections: state.sections, state: state }, deck.id))), groupMindmaps.map(mindmap => (_jsx(MindmapRow, { mindmap: mindmap, onOpen: () => onOpenMindmap(mindmap) }, mindmap.fileName))), groupTests.map(test => (_jsx(TestRow, { attempts: testAttempts[test.fileName]?.attempts ?? [], onStart: () => onStartTest(test), test: test }, test.fileName)))] })) : (_jsxs(_Fragment, { children: [group.decks.length > 0 && (_jsx("div", { className: "grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3", children: group.decks.map(deck => (_jsx(DeckCard, { curve: curvesByDeck.get(deck.id) ?? [], deck: deck, now: now, onBrowse: onBrowse, onDelete: () => setDeleteDeckTarget(deck), onMatch: onMatch, onMove: section => onMoveDeck(deck.id, section), onStudy: onStudy, sections: state.sections, state: state }, deck.id))) })), hasExtras && (_jsxs("div", { className: cn('divide-y divide-(--ui-stroke-tertiary) rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-bg-card)', group.decks.length > 0 && 'mt-3'), children: [groupMindmaps.map(mindmap => (_jsx(MindmapRow, { mindmap: mindmap, onOpen: () => onOpenMindmap(mindmap) }, mindmap.fileName))), groupTests.map(test => (_jsx(TestRow, { attempts: testAttempts[test.fileName]?.attempts ?? [], onStart: () => onStartTest(test), test: test }, test.fileName)))] }))] }))) : (_jsxs("div", { className: "rounded-md border border-dashed border-(--ui-stroke-tertiary) bg-(--ui-bg-card) px-4 py-4", children: [_jsx("p", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--ui-text-quaternary)", children: "Empty section" }), _jsxs("div", { className: "mt-1 flex items-center gap-1 text-xs text-muted-foreground", children: [_jsx("span", { children: "No decks yet \u2014" }), _jsx(Button, { onClick: () => onCreateDeck(group.course), size: "inline", variant: "textStrong", children: "add one" })] })] })))] }, group.course));
            }), _jsx(Heatmap, { state: state }), _jsx(DeleteDeckDialog, { deck: deleteDeckTarget, onClose: () => setDeleteDeckTarget(null), onConfirm: () => {
                    if (!deleteDeckTarget) {
                        return;
                    }
                    onDeleteDeck(deleteDeckTarget.id);
                    setDeleteDeckTarget(null);
                } })] }));
}
function ResourceIcon({ children }) {
    return (_jsx("span", { className: "grid size-7 shrink-0 place-items-center rounded-md bg-(--ui-bg-quaternary) text-(--ui-text-tertiary)", children: children }));
}
function MindmapRow({ mindmap, onOpen }) {
    return (_jsxs("div", { className: "flex w-full items-center gap-3 px-3 py-2.5", children: [_jsx(ResourceIcon, { children: _jsx(IconSitemap, { size: 15 }) }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("div", { className: "truncate text-sm font-medium", children: mindmap.title }), _jsx("div", { className: "mt-0.5 truncate text-[0.6875rem] text-muted-foreground", children: "Mind map \u00B7 visual outline" })] }), _jsx("span", { className: "hidden w-40 shrink-0 text-right text-xs text-muted-foreground sm:block", children: "Visual outline" }), _jsx(Button, { onClick: onOpen, size: "sm", variant: "outline", children: "Open" })] }));
}
function TestRow({ attempts, onStart, test }) {
    const best = bestAttempt(attempts);
    const last = lastAttempt(attempts);
    const count = test.questions.length;
    return (_jsxs("div", { className: "flex w-full items-center gap-3 px-3 py-2.5", children: [_jsx(ResourceIcon, { children: _jsx(IconChecklist, { size: 15 }) }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("div", { className: "truncate text-sm font-medium", children: test.title }), _jsxs("div", { className: "mt-0.5 truncate text-[0.6875rem] text-muted-foreground", children: [count, " question", count === 1 ? '' : 's', best ? ` · best ${best.score}/${best.total}` : ''] })] }), _jsx("span", { className: "hidden w-40 shrink-0 text-right text-xs tabular-nums text-muted-foreground sm:block", children: last ? `Test ${last.score}/${last.total}` : 'Not taken yet' }), _jsx(Button, { onClick: onStart, size: "sm", variant: "outline", children: last ? 'Retake' : 'Start' })] }));
}
function DuePill({ due }) {
    return (_jsxs("span", { className: "shrink-0 rounded-full bg-(--theme-primary)/15 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-(--theme-primary)", children: [due, " due"] }));
}
const RETENTION_DAY_MS = 24 * 60 * 60 * 1000;
function RetentionSparkline({ curve, now }) {
    const [activeIndex, setActiveIndex] = useState(0);
    const [inspecting, setInspecting] = useState(false);
    if (!curve.length) {
        return (_jsxs("div", { children: [_jsx("svg", { "aria-hidden": "true", className: "h-9 w-full", preserveAspectRatio: "none", viewBox: "0 0 100 40", children: _jsx("line", { stroke: "var(--ui-stroke-secondary)", strokeDasharray: "3 4", strokeLinecap: "round", strokeWidth: "1", vectorEffect: "non-scaling-stroke", x1: "2", x2: "98", y1: "12", y2: "28" }) }), _jsxs("p", { className: "mt-0.5 text-[0.6875rem] text-muted-foreground", children: [_jsx("span", { className: "font-medium text-foreground", children: "No recall estimate yet" }), _jsx("span", { children: " \u00B7 Review a card to begin" })] })] }));
    }
    const finalDay = curve.at(-1)?.day ?? 1;
    const coordinates = curve.map(point => {
        const x = 2 + (point.day / Math.max(1, finalDay)) * 96;
        const y = 4 + (1 - point.retention) * 30;
        return [x, y];
    });
    const points = coordinates.map(([x, y]) => `${x},${y}`).join(' ');
    const first = curve[0];
    const last = curve.at(-1) ?? first;
    const safeIndex = Math.min(activeIndex, curve.length - 1);
    const activePoint = curve[safeIndex];
    const [activeX, activeY] = coordinates[safeIndex];
    const activeDate = new Date(now.getTime() + activePoint.day * RETENTION_DAY_MS).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short'
    });
    const activeLabel = `${activeDate} · estimated recall ${Math.round(activePoint.retention * 100)}%`;
    const tooltipTransform = activeX < 22
        ? 'translate(0, calc(-100% - 8px))'
        : activeX > 78
            ? 'translate(-100%, calc(-100% - 8px))'
            : 'translate(-50%, calc(-100% - 8px))';
    return (_jsxs("div", { "aria-label": `${Math.round(first.retention * 100)}% recall now. Projected ${Math.round(last.retention * 100)}% in ${finalDay} days. Use the arrow keys to inspect the curve.`, className: "relative outline-none focus-visible:ring-2 focus-visible:ring-ring/50", onBlur: () => setInspecting(false), onFocus: () => setInspecting(true), onKeyDown: event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
                return;
            }
            event.preventDefault();
            setInspecting(true);
            setActiveIndex(index => event.key === 'ArrowLeft'
                ? Math.max(0, index - 1)
                : Math.min(curve.length - 1, index + 1));
        }, onPointerLeave: event => {
            if (document.activeElement !== event.currentTarget) {
                setInspecting(false);
            }
        }, onPointerMove: event => {
            const rect = event.currentTarget.getBoundingClientRect();
            const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)));
            setActiveIndex(Math.round(ratio * (curve.length - 1)));
            setInspecting(true);
        }, role: "img", tabIndex: 0, children: [_jsxs("svg", { "aria-hidden": "true", className: "h-9 w-full", preserveAspectRatio: "none", viewBox: "0 0 100 40", children: [_jsx("polyline", { fill: "none", points: points, stroke: "var(--ui-stroke-secondary)", strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: "1", vectorEffect: "non-scaling-stroke" }), inspecting && (_jsxs(_Fragment, { children: [_jsx("line", { stroke: "var(--ui-text-secondary)", strokeWidth: "1", vectorEffect: "non-scaling-stroke", x1: activeX - 3, x2: activeX + 3, y1: activeY, y2: activeY }), _jsx("line", { stroke: "var(--ui-text-secondary)", strokeWidth: "1", vectorEffect: "non-scaling-stroke", x1: activeX, x2: activeX, y1: activeY - 3, y2: activeY + 3 })] })), _jsx("circle", { cx: coordinates[coordinates.length - 1][0], cy: coordinates[coordinates.length - 1][1], fill: "var(--theme-primary)", r: "1.7" })] }), inspecting && (_jsx("span", { className: "pointer-events-none absolute z-20 whitespace-nowrap bg-foreground px-1.5 py-1 text-[11px] font-bold leading-none text-background", style: {
                    left: `${activeX}%`,
                    top: `${(activeY / 40) * 100}%`,
                    transform: tooltipTransform
                }, children: activeLabel })), _jsx(Tip, { label: "FSRS estimate based on cards you\u2019ve reviewed in this deck.", side: "bottom", children: _jsxs("p", { className: "mt-0.5 cursor-help text-[0.6875rem] tabular-nums", children: [_jsxs("span", { className: "font-semibold text-foreground", children: [Math.round(first.retention * 100), "% recall now"] }), _jsxs("span", { className: "text-muted-foreground", children: [' ', "\u00B7 Projected ", Math.round(last.retention * 100), "% in ", finalDay, " days"] })] }) })] }));
}
function DeckActionsMenu({ deck, matchableCount, onBrowse, onDelete, onMatch, onMove, sections }) {
    const currentSection = !deck.course?.trim() || deck.course.trim().toLocaleLowerCase() === 'other' ? 'Other' : deck.course.trim();
    return (_jsxs(DropdownMenu, { children: [_jsx(DropdownMenuTrigger, { asChild: true, children: _jsx(Button, { "aria-label": `More actions for ${deck.name}`, size: "icon-xs", variant: "ghost", children: _jsx(IconDots, {}) }) }), _jsxs(DropdownMenuContent, { align: "end", className: "w-44", children: [_jsx(DropdownMenuItem, { onSelect: onBrowse, children: "Cards" }), _jsx(DropdownMenuItem, { disabled: matchableCount < 2, onSelect: onMatch, children: "Match" }), _jsxs(DropdownMenuSub, { children: [_jsx(DropdownMenuSubTrigger, { children: "Move to section" }), _jsxs(DropdownMenuSubContent, { className: "w-44", children: [sections.map(section => (_jsxs(DropdownMenuItem, { disabled: section.toLocaleLowerCase() === currentSection.toLocaleLowerCase(), onSelect: () => onMove(section), children: [_jsx("span", { className: "min-w-0 flex-1 truncate", children: section }), section.toLocaleLowerCase() === currentSection.toLocaleLowerCase() && (_jsx("span", { className: "text-muted-foreground", children: "\u2713" }))] }, section))), _jsxs(DropdownMenuItem, { disabled: currentSection === 'Other', onSelect: () => onMove(''), children: [_jsx("span", { className: "min-w-0 flex-1", children: "Other" }), currentSection === 'Other' && _jsx("span", { className: "text-muted-foreground", children: "\u2713" })] })] })] }), _jsx(DropdownMenuItem, { onSelect: onDelete, variant: "destructive", children: "Delete deck" })] })] }));
}
function DeckRow({ curve, deck, now, onBrowse, onDelete, onMatch, onMove, onStudy, sections, state }) {
    const stats = deckStats(state, deck.id, now);
    const matchableCount = deck.cards.filter(card => !hasClozeMarker(card.front)).length;
    return (_jsxs("div", { className: "flex w-full items-center gap-3 px-3 py-2.5", children: [_jsx(ResourceIcon, { children: _jsx(IconCards, { size: 15 }) }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsxs("div", { className: "flex min-w-0 items-center gap-2", children: [_jsx("span", { className: "truncate text-sm font-medium", children: deck.name }), stats.due > 0 && _jsx(DuePill, { due: stats.due })] }), _jsxs("p", { className: "mt-0.5 text-[0.6875rem] tabular-nums text-muted-foreground", children: [stats.total, " card", stats.total === 1 ? '' : 's', " \u00B7 ", stats.fresh, " new"] })] }), _jsx("div", { className: "hidden w-52 shrink-0 lg:block", children: _jsx(RetentionSparkline, { curve: curve, now: now }) }), _jsx(Button, { onClick: () => onStudy(deck.id), size: "sm", variant: "outline", children: "Study" }), _jsx(DeckActionsMenu, { deck: deck, matchableCount: matchableCount, onBrowse: () => onBrowse(deck.id), onDelete: onDelete, onMatch: () => onMatch(deck.id), onMove: onMove, sections: sections })] }));
}
function DeckCard({ curve, deck, now, onBrowse, onDelete, onMatch, onMove, onStudy, sections, state }) {
    const stats = deckStats(state, deck.id, now);
    const matchableCount = deck.cards.filter(card => !hasClozeMarker(card.front)).length;
    return (_jsxs("div", { className: "flex flex-col gap-3 rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-4", children: [_jsxs("div", { className: "flex items-start gap-2.5", children: [_jsx(ResourceIcon, { children: _jsx(IconCards, { size: 15 }) }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("h3", { className: "truncate text-sm font-semibold", children: deck.name }), _jsxs("p", { className: "mt-0.5 text-[0.6875rem] tabular-nums text-muted-foreground", children: [stats.total, " card", stats.total === 1 ? '' : 's', " \u00B7 ", stats.fresh, " new"] })] }), stats.due > 0 && _jsx(DuePill, { due: stats.due })] }), _jsx(RetentionSparkline, { curve: curve, now: now }), _jsxs("div", { className: "mt-auto flex items-center justify-end gap-1", children: [_jsx(Button, { onClick: () => onStudy(deck.id), size: "sm", variant: "outline", children: "Study" }), _jsx(DeckActionsMenu, { deck: deck, matchableCount: matchableCount, onBrowse: () => onBrowse(deck.id), onDelete: onDelete, onMatch: () => onMatch(deck.id), onMove: onMove, sections: sections })] })] }));
}
function DeleteDeckDialog({ deck, onClose, onConfirm }) {
    return (_jsx(Dialog, { onOpenChange: open => !open && onClose(), open: Boolean(deck), children: _jsxs(DialogContent, { className: "sm:max-w-md", children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "Delete deck?" }), _jsx(DialogDescription, { children: deck ? `“${deck.name}” and its local review schedule will be removed.` : 'This deck will be removed.' })] }), _jsxs(DialogFooter, { children: [_jsx(Button, { onClick: onClose, variant: "outline", children: "Cancel" }), _jsx(Button, { onClick: onConfirm, variant: "destructive", children: "Delete deck" })] })] }) }));
}
// Contribution grid of review activity with streak stats, month labels, hover tooltips,
// legend, and a today marker.
const HEAT_MIX = ['', '14%', '24%', '38%', '54%'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function heatColor(level) {
    return level === 0
        ? 'color-mix(in srgb, var(--ui-text-primary) 8%, transparent)'
        : `color-mix(in srgb, var(--ui-text-primary) ${HEAT_MIX[level]}, transparent)`;
}
function Stat({ label, value }) {
    return (_jsxs("span", { className: "flex items-baseline gap-1", children: [_jsx("span", { className: "text-sm font-semibold text-foreground", children: value }), _jsx("span", { className: "text-muted-foreground", children: label })] }));
}
function Heatmap({ state }) {
    const [expanded, setExpanded] = useState(false);
    const todayIso = new Date().toISOString();
    const { cells, total } = useMemo(() => reviewHeatmap(state, todayIso), [state, todayIso]);
    const stats = useMemo(() => studyMotivation(state, todayIso), [state, todayIso]);
    // Local calendar day — must match the cell dates reviewHeatmap now emits.
    const todayKey = localDayKey(new Date(todayIso));
    const firstDayOffset = cells[0] ? new Date(`${cells[0].date}T00:00:00.000Z`).getUTCDay() : 0;
    const weeks = Math.ceil((firstDayOffset + cells.length) / 7);
    const daysIntoWeek = new Date(`${todayKey}T00:00:00.000Z`).getUTCDay() + 1;
    const reviewsThisWeek = cells
        .slice(-daysIntoWeek)
        .reduce((sum, cell) => sum + cell.count, 0);
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
    return (_jsx("section", { className: "px-8 pb-2 pt-8", children: _jsxs("div", { className: "rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-card)", children: [_jsxs("button", { "aria-expanded": expanded, className: "flex w-full items-center justify-between gap-4 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50", onClick: () => setExpanded(value => !value), type: "button", children: [_jsxs("div", { className: "min-w-0", children: [_jsx("h2", { className: "text-sm font-semibold", children: "Review history" }), _jsxs("p", { className: "mt-1 flex flex-wrap items-center gap-x-2 text-[0.6875rem] tabular-nums text-muted-foreground", children: [_jsxs("span", { children: [stats.currentStreak, " day streak"] }), _jsx("span", { "aria-hidden": "true", children: "\u00B7" }), _jsxs("span", { children: [stats.retentionPct === null ? '—' : `${stats.retentionPct}%`, " 30-day retention"] }), _jsx("span", { "aria-hidden": "true", children: "\u00B7" }), _jsxs("span", { children: [reviewsThisWeek, " reviews this week"] })] })] }), _jsx(IconChevronDown, { "aria-hidden": "true", className: cn('shrink-0 text-muted-foreground transition-transform', !expanded && '-rotate-90'), size: 15 })] }), expanded && (_jsxs("div", { className: "border-t border-(--ui-stroke-tertiary) px-4 pb-4 pt-3", children: [_jsxs("div", { className: "mb-4 flex flex-wrap items-center gap-x-6 gap-y-1.5 text-xs", children: [_jsx(Stat, { label: "longest streak", value: stats.longestStreak }), _jsx(Stat, { label: "days active", value: `${stats.daysLearnedPct}%` }), _jsxs("span", { className: "text-muted-foreground", children: [total, " reviews \u00B7 past 12 months"] })] }), total === 0 && (_jsx("p", { className: "mb-3 text-xs text-muted-foreground", children: "Your history fills in as you grade cards." })), _jsx("div", { className: "overflow-x-auto pb-1", children: _jsxs("div", { className: "min-w-max", children: [_jsxs("div", { className: "grid grid-cols-[2rem_auto] gap-x-2 gap-y-1", children: [_jsx("div", {}), _jsx("div", { className: "relative h-3 text-[9px] text-muted-foreground", style: { width: `${weeks * 14}px` }, children: monthLabels.map(month => (_jsx("span", { className: "absolute", style: { left: `${month.col * 14}px` }, children: month.label }, `${month.label}-${month.col}`))) }), _jsx("div", { className: "grid grid-rows-7 gap-[3px] text-[9px] leading-[11px] text-muted-foreground", style: { gridTemplateRows: 'repeat(7, 11px)' }, children: WEEKDAYS.map(day => (_jsx("span", { children: day }, day))) }), _jsxs("div", { className: "grid grid-flow-col grid-rows-7 gap-[3px]", style: { gridAutoColumns: '11px', gridTemplateRows: 'repeat(7, 11px)' }, children: [Array.from({ length: firstDayOffset }, (_, index) => (_jsx("span", { "aria-hidden": "true" }, `leading-${index}`))), cells.map(cell => (_jsx(Tip, { label: `${cell.count} review${cell.count === 1 ? '' : 's'} · ${new Date(`${cell.date}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' })}`, side: "top", children: _jsx("div", { className: cn('rounded-[2px]', cell.date === todayKey && 'ring-1 ring-foreground/60'), style: { backgroundColor: heatColor(cell.level) } }) }, cell.date)))] })] }), _jsxs("div", { className: "mt-2 flex items-center justify-end gap-1 text-[9px] text-muted-foreground", children: [_jsx("span", { children: "Less" }), [0, 1, 2, 3, 4].map(level => (_jsx("span", { className: "size-2.5 rounded-[2px]", style: { backgroundColor: heatColor(level) } }, level))), _jsx("span", { children: "More" })] })] }) })] }))] }) }));
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
function ReviewSurface({ activeCategory, flip, intervals, item, onGrade, onReveal, onUndo, position, remainingCounts, revealed, sessionTotal, showIntervalHints }) {
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
    return (_jsx("div", { className: "flex flex-1 flex-col items-center px-6 pb-8", children: _jsxs("div", { className: "flex w-full max-w-2xl flex-1 flex-col", children: [_jsxs("div", { className: "flex items-center justify-between gap-4 pb-2 text-xs text-muted-foreground", children: [_jsxs("span", { className: "min-w-0 truncate", children: [item.deckName, item.isNew && (_jsx(Badge, { className: "ml-2", variant: "outline", children: "new" }))] }), _jsxs("div", { className: "flex shrink-0 items-center gap-4", children: [onUndo && (_jsxs(Button, { onClick: onUndo, size: "inline", variant: "text", children: ["Undo ", _jsx("span", { className: "text-[10px] opacity-60", children: "u" })] })), _jsxs("span", { className: "tabular-nums", children: [position, " of ", sessionTotal] }), _jsx("span", { "aria-label": "Cards remaining", className: "flex items-center gap-3 text-[0.6875rem] tabular-nums", children: countItems.map(count => (_jsxs("span", { className: "flex items-center gap-1.5", children: [_jsx("span", { "aria-hidden": "true", className: cn('size-1 rounded-full bg-(--ui-stroke-secondary)', activeCategory === count.category && 'bg-(--theme-primary)') }), _jsxs("span", { children: [_jsx("span", { className: "font-medium text-foreground", children: count.value }), " ", count.label] })] }, count.category))) })] })] }), flip ? (_jsx("button", { "aria-label": revealed ? answer : 'Show answer', className: "nemesis-flip flex-1 [perspective:1600px]", "data-flipped": revealed ? 'true' : undefined, onClick: () => !revealed && onReveal(), type: "button", children: _jsxs("div", { className: "nemesis-flip-inner relative h-full min-h-64 w-full", children: [_jsx(FlipFace, { label: "Question", children: prompt }), _jsxs(FlipFace, { back: true, label: "Answer", muted: true, children: [answer, answerNote && _jsx("div", { className: "pt-3 text-sm text-muted-foreground", children: answerNote })] })] }) })) : (_jsxs("div", { className: "flex min-h-64 flex-1 flex-col justify-center gap-5 rounded-xl border border-border bg-card p-8", children: [_jsxs("div", { children: [_jsx("div", { className: "pb-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground", children: "Question" }), _jsx("div", { className: "text-lg leading-relaxed", children: prompt })] }), revealed && (_jsxs(_Fragment, { children: [_jsx("div", { className: "border-t border-border" }), _jsxs("div", { children: [_jsx("div", { className: "pb-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground", children: "Answer" }), _jsx("div", { className: "text-lg leading-relaxed text-foreground/80", children: answer }), answerNote && _jsx("div", { className: "pt-2 text-sm text-muted-foreground", children: answerNote })] })] }))] })), item.card.tags.length > 0 && (_jsx("div", { className: "flex flex-wrap gap-1 pt-2.5", children: item.card.tags.map(tag => (_jsx(Badge, { variant: "outline", children: tag }, tag))) })), _jsx("div", { className: "pt-4", children: revealed ? (_jsx("div", { className: "grid grid-cols-4 gap-2", children: GRADES.map(option => (_jsxs(Button, { className: cn('flex-col gap-0.5 py-5', option.rating === 'again' && 'text-(--theme-primary)'), onClick: () => onGrade(option.rating), variant: "secondary", children: [_jsx("span", { children: option.label }), showIntervalHints && (_jsxs("span", { className: "text-[10px] opacity-60", children: [intervals[option.rating], " \u00B7 ", option.key] }))] }, option.rating))) })) : (_jsxs(Button, { className: "w-full py-5", onClick: onReveal, variant: "secondary", children: ["Show answer ", _jsx("span", { className: "ml-2 text-[10px] opacity-60", children: "Space" })] })) })] }) }));
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
