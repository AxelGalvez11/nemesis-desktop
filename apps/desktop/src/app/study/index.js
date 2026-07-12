import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Study — Anki-style spaced repetition over FSRS (see model.ts for the algorithm/licensing
// note). Interaction model deliberately mirrors what health-science students already have
// as muscle memory from Anki: deck browser with due badges → flip card (Space) →
// Again/Hard/Good/Easy (1-4), with the next-interval hint under each grade button.
import { IconChevronDown, IconChecklist, IconFolderPlus, IconLayoutGrid, IconList, IconPlayerPause, IconSettings, IconSitemap } from '@tabler/icons-react';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { importedDeckFileNames, scanAllDeckFiles } from './deck-files';
import { bestAttempt, groupExtras, lastAttempt, loadTestAttempts, scanMindmapFiles, scanTestFiles } from './extras';
import { parseCardPaste } from './import-cards';
import { MindmapViewerDialog } from './mindmap-viewer';
import { addCard, addSection, adoptLegacyDeckFiles, assignDeckSection, buildQueue, deckStats, DEFAULT_STUDY_SETTINGS, deleteCard, deleteDeck, freshId, getSettings, gradeCard, groupDecks, loadState, previewIntervals, reconcileDeckFiles, reviewHeatmap, saveState, setSettings, studyMotivation, toggleSuspendCard, updateCard } from './model';
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
function loadViewMode() {
    try {
        return window.localStorage.getItem(VIEW_MODE_KEY) === 'list' ? 'list' : 'cards';
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
    const [view, setView] = useState(() => loadViewMode());
    const [collapsedSections, setCollapsedSections] = useState(() => loadCollapsedSections());
    const [reducedMotion] = useState(() => prefersReducedMotion());
    const [matchDeckId, setMatchDeckId] = useState(null);
    const [done, setDone] = useState(0);
    const [autoImported, setAutoImported] = useState([]);
    const [mindmaps, setMindmaps] = useState([]);
    const [tests, setTests] = useState([]);
    const [testAttempts, setTestAttempts] = useState(() => loadTestAttempts());
    const [viewingMindmap, setViewingMindmap] = useState(null);
    const [takingTest, setTakingTest] = useState(null);
    const now = useMemo(() => new Date(), [state, reviewing]);
    const queue = useMemo(() => (reviewing ? buildQueue(state, reviewDeckId, now) : []), [state, reviewDeckId, reviewing, now]);
    const current = queue[0];
    const remainingCounts = useMemo(() => queue.reduce((counts, item) => {
        if (item.isNew) {
            counts.new++;
        }
        else {
            const cardState = state.schedule[item.card.id]?.state;
            if (cardState === 1 || cardState === 3) {
                counts.learning++;
            }
            else {
                counts.review++;
            }
        }
        return counts;
    }, { learning: 0, new: 0, review: 0 }), [queue, state.schedule]);
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
        setReviewDeckId(deckId);
        setReviewing(true);
        setRevealed(false);
        setDone(0);
    }, []);
    const exitReview = useCallback(() => {
        setReviewing(false);
        setRevealed(false);
    }, []);
    const grade = useCallback((rating) => {
        if (!current) {
            return;
        }
        update(gradeCard(state, current.card.id, rating, new Date()));
        setRevealed(false);
        setDone(count => count + 1);
    }, [current, state, update]);
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
    }, [current, exitReview, grade, revealed, reviewing]);
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
    return (_jsxs("div", { className: "flex h-full min-h-0 flex-col overflow-y-auto", children: [_jsxs("header", { className: "flex shrink-0 items-center justify-between gap-3 px-6 pb-3 pt-5", children: [_jsxs("div", { children: [_jsx("h1", { className: "text-lg font-semibold", children: "Study" }), _jsxs("p", { className: "text-xs text-muted-foreground", children: [totals.due, " due \u00B7 ", totals.fresh, " new \u00B7 ", totals.total, " cards"] })] }), _jsx("div", { className: "flex flex-wrap items-center justify-end gap-2", children: reviewing || browseDeckId || matchDeckId || takingTest ? (_jsx(Button, { onClick: () => {
                                exitReview();
                                setBrowseDeckId(null);
                                setMatchDeckId(null);
                                setTakingTest(null);
                            }, size: "sm", variant: "outline", children: "Back to decks" })) : (_jsxs(_Fragment, { children: [_jsxs("div", { className: "mr-1 flex items-center overflow-hidden rounded-md border border-border", children: [_jsx("button", { className: cn('px-2 py-1.5 transition-colors', view === 'cards'
                                                ? 'bg-accent text-accent-foreground'
                                                : 'text-muted-foreground hover:text-foreground'), onClick: () => setViewMode('cards'), title: "Card view", type: "button", children: _jsx(IconLayoutGrid, { size: 14 }) }), _jsx("button", { className: cn('px-2 py-1.5 transition-colors', view === 'list' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'), onClick: () => setViewMode('list'), title: "List view", type: "button", children: _jsx(IconList, { size: 14 }) })] }), _jsx("button", { "aria-label": "Study settings", className: "rounded-md border border-border px-2 py-1.5 text-muted-foreground transition-colors hover:text-foreground", onClick: () => setSettingsOpen(true), title: "Study settings", type: "button", children: _jsx(IconSettings, { size: 14 }) }), _jsxs(Button, { onClick: () => setNewSectionOpen(true), size: "sm", variant: "outline", children: [_jsx(IconFolderPlus, { size: 14 }), "New section"] }), _jsx(Button, { onClick: () => setNewDeckSection(''), size: "sm", variant: "outline", children: "New deck" }), _jsx(Button, { onClick: () => setImportOpen(true), size: "sm", variant: "outline", children: "Import cards" }), _jsx(Button, { disabled: totals.due === 0, onClick: () => startReview(null), size: "sm", children: "Study all" })] })) })] }), autoImported.length > 0 && !reviewing && !browseDeckId && (_jsxs("div", { className: "mx-6 mb-1 flex items-center justify-between rounded-md border border-(--theme-primary)/40 bg-(--theme-primary)/10 px-3 py-1.5 text-xs", children: [_jsxs("span", { children: ["Nemesis added ", autoImported.length === 1 ? 'a new deck' : `${autoImported.length} new decks`, ":", ' ', autoImported.join(', ')] }), _jsx("button", { className: "text-muted-foreground hover:text-foreground", onClick: () => setAutoImported([]), type: "button", children: "Dismiss" })] })), reviewing ? (current ? (_jsx(ReviewSurface, { flip: flip, intervals: previewIntervals(state, current.card.id, now), item: current, onGrade: grade, onReveal: () => setRevealed(true), remainingCounts: remainingCounts, revealed: revealed, showIntervalHints: settings.showIntervalHints })) : (_jsx(EmptyState, { className: "flex-1", description: done > 0
                    ? `${done} card${done === 1 ? '' : 's'} reviewed. Come back when the next ones are due.`
                    : 'Nothing is due right now.', title: "All caught up" }))) : matchDeckId ? (_jsx(MatchGame, { deck: state.decks.find(deck => deck.id === matchDeckId) ?? null, onExit: () => setMatchDeckId(null) })) : browseDeckId ? (_jsx(CardBrowser, { deck: state.decks.find(deck => deck.id === browseDeckId) ?? null, onChange: update, onDeleteDeck: () => removeDeck(browseDeckId), onMatch: () => startMatch(browseDeckId), onMoveDeck: section => moveDeck(browseDeckId, section), sections: sections, state: state })) : takingTest ? (_jsx(TestSurface, { file: takingTest, onComplete: () => setTestAttempts(loadTestAttempts()), onExit: () => setTakingTest(null) })) : (_jsx(DeckBrowser, { collapsedSections: collapsedSections, mindmaps: mindmaps, onBrowse: setBrowseDeckId, onCreateDeck: setNewDeckSection, onMatch: startMatch, onOpenMindmap: setViewingMindmap, onStartTest: setTakingTest, onStudy: startReview, onToggleSection: toggleSection, state: state, testAttempts: testAttempts, tests: tests, view: view })), _jsx(MindmapViewerDialog, { file: viewingMindmap, onOpenChange: open => !open && setViewingMindmap(null) }), _jsx(ImportDialog, { onImport: importCards, onOpenChange: setImportOpen, open: importOpen, sections: sections }), newDeckSection !== null && (_jsx(NewDeckDialog, { initialSection: newDeckSection, onClose: () => setNewDeckSection(null), onCreate: createDeck, sections: sections })), newSectionOpen && (_jsx(NewSectionDialog, { onClose: () => setNewSectionOpen(false), onCreate: createSection, sections: sections })), _jsx(StudySettingsDialog, { onChange: patch => update(setSettings(state, patch)), onOpenChange: setSettingsOpen, open: settingsOpen, settings: settings })] }));
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
    return (_jsx(Dialog, { onOpenChange: onOpenChange, open: open, children: _jsxs(DialogContent, { className: "sm:max-w-md", children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "Study settings" }), _jsx(DialogDescription, { children: "Limits and behavior for review sessions. Changes apply immediately." })] }), _jsxs("div", { className: "flex flex-col divide-y divide-border", children: [_jsx(SettingRow, { description: "Cards introduced for the first time. 0 = unlimited.", label: "New cards per day", children: _jsx(Input, { className: "w-20 text-right", inputMode: "numeric", min: 0, onChange: event => onChange({ newPerDay: parseDailyCap(event.target.value) }), step: 1, type: "number", value: settings.newPerDay }) }), _jsx(SettingRow, { description: "Cards already in review rotation. 0 = unlimited.", label: "Reviews per day", children: _jsx(Input, { className: "w-20 text-right", inputMode: "numeric", min: 0, onChange: event => onChange({ reviewsPerDay: parseDailyCap(event.target.value) }), step: 1, type: "number", value: settings.reviewsPerDay }) }), _jsx(SettingRow, { label: "Review order", children: _jsx(SegmentedControl, { onChange: order => onChange({ order }), options: ORDER_OPTIONS, value: settings.order }) }), _jsx(SettingRow, { label: "Card flip animation", children: _jsx(Switch, { "aria-label": "Card flip animation", checked: settings.flip, onCheckedChange: flip => onChange({ flip }) }) }), _jsx(SettingRow, { description: "The estimated interval shown on each grade button.", label: "Next-interval hints", children: _jsx(Switch, { "aria-label": "Show next-interval hints", checked: settings.showIntervalHints, onCheckedChange: showIntervalHints => onChange({ showIntervalHints }) }) })] }), _jsxs(DialogFooter, { className: "sm:justify-between", children: [_jsx(Button, { onClick: () => onChange(DEFAULT_STUDY_SETTINGS), size: "sm", variant: "text", children: "Reset to defaults" }), _jsx(Button, { onClick: () => onOpenChange(false), size: "sm", variant: "outline", children: "Done" })] })] }) }));
}
function DeckBrowser({ collapsedSections, mindmaps, onBrowse, onCreateDeck, onMatch, onOpenMindmap, onStartTest, onStudy, onToggleSection, state, testAttempts, tests, view }) {
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
    ];
    if (!groups.length) {
        return (_jsx(EmptyState, { className: "flex-1", description: "Create a deck or import cards to get going.", title: "No decks yet" }));
    }
    return (_jsxs("div", { className: "pb-10", children: [_jsx(Heatmap, { state: state }), groups.map(group => {
                const groupMindmaps = group.extras?.mindmaps ?? [];
                const groupTests = group.extras?.tests ?? [];
                const hasExtras = groupMindmaps.length > 0 || groupTests.length > 0;
                const isCollapsed = collapsedSections.has(group.course);
                return (_jsxs("section", { className: "px-8 pt-7", children: [_jsxs("div", { className: "mb-3 flex items-baseline justify-between", children: [_jsx("h2", { className: "text-[15px] font-semibold tracking-tight", children: _jsxs("button", { "aria-expanded": !isCollapsed, className: "flex items-center gap-1.5 rounded-sm text-left hover:text-(--theme-primary) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--theme-primary)/45", onClick: () => onToggleSection(group.course), type: "button", children: [_jsx(IconChevronDown, { "aria-hidden": "true", className: cn('transition-transform', isCollapsed && '-rotate-90'), size: 15 }), _jsx("span", { children: group.course })] }) }), _jsxs("span", { className: "text-xs text-muted-foreground", children: [group.stats.due, " due \u00B7 ", group.decks.length, " deck", group.decks.length === 1 ? '' : 's', " \u00B7", ' ', group.stats.total, " cards", groupMindmaps.length > 0 &&
                                            ` · ${groupMindmaps.length} mind map${groupMindmaps.length === 1 ? '' : 's'}`, groupTests.length > 0 && ` · ${groupTests.length} test${groupTests.length === 1 ? '' : 's'}`] })] }), !isCollapsed && (_jsxs(_Fragment, { children: [group.decks.length === 0 ? (hasExtras ? null : (_jsxs("div", { className: "rounded-xl border border-dashed border-(--ui-stroke-tertiary) bg-(--ui-bg-card) px-4 py-5", children: [_jsx("p", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--ui-text-quaternary)", children: "Empty section" }), _jsxs("div", { className: "mt-1 flex items-center gap-1 text-xs text-muted-foreground", children: [_jsx("span", { children: "No decks yet \u2014" }), _jsx(Button, { onClick: () => onCreateDeck(group.course), size: "inline", variant: "textStrong", children: "add one" })] })] }))) : view === 'list' ? (_jsx("div", { className: "flex flex-col gap-2", children: group.decks.map(deck => (_jsx(DeckRow, { deck: deck, now: now, onBrowse: onBrowse, onMatch: onMatch, onStudy: onStudy, state: state }, deck.id))) })) : (_jsx("div", { className: "grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3", children: group.decks.map(deck => (_jsx(DeckCard, { curve: curvesByDeck.get(deck.id) ?? [], deck: deck, now: now, onBrowse: onBrowse, onMatch: onMatch, onStudy: onStudy, state: state }, deck.id))) })), hasExtras && (_jsxs("div", { className: "mt-2 flex flex-col gap-2", children: [groupMindmaps.map(mindmap => (_jsx(MindmapRow, { mindmap: mindmap, onOpen: () => onOpenMindmap(mindmap) }, mindmap.fileName))), groupTests.map(test => (_jsx(TestRow, { attempts: testAttempts[test.fileName]?.attempts ?? [], onStart: () => onStartTest(test), test: test }, test.fileName)))] }))] }))] }, group.course));
            })] }));
}
function MindmapRow({ mindmap, onOpen }) {
    return (_jsxs("button", { className: "group flex w-full items-center gap-3 rounded-xl border border-border bg-card px-4 py-2.5 text-left transition-colors hover:border-(--theme-primary)/40", onClick: onOpen, type: "button", children: [_jsx(IconSitemap, { className: "shrink-0 text-muted-foreground", size: 16 }), _jsx("span", { className: "min-w-0 flex-1 truncate text-sm font-medium", children: mindmap.title }), _jsx(Badge, { variant: "outline", children: "Mind map" })] }));
}
function TestRow({ attempts, onStart, test }) {
    const best = bestAttempt(attempts);
    const last = lastAttempt(attempts);
    const count = test.questions.length;
    const onKeyDown = (event) => {
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) {
            return;
        }
        event.preventDefault();
        onStart();
    };
    return (_jsxs("div", { className: "group flex w-full cursor-pointer items-center gap-3 rounded-xl border border-border bg-card px-4 py-2.5 outline-none transition-[box-shadow,border-color] hover:border-(--theme-primary)/50 hover:ring-2 hover:ring-(--theme-primary)/20 focus-visible:ring-2 focus-visible:ring-(--theme-primary)/45", onClick: onStart, onKeyDown: onKeyDown, role: "button", tabIndex: 0, children: [_jsx(IconChecklist, { className: "shrink-0 text-muted-foreground", size: 16 }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("div", { className: "truncate text-sm font-medium", children: test.title }), _jsxs("div", { className: "mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground", children: [_jsxs("span", { children: [count, " question", count === 1 ? '' : 's'] }), best && (_jsxs("span", { children: ["\u00B7 best ", best.score, "/", best.total] })), last && last !== best && (_jsxs("span", { children: ["\u00B7 last ", last.score, "/", last.total] }))] })] })] }));
}
function DuePill({ due }) {
    return (_jsxs("span", { className: "shrink-0 rounded-full bg-(--theme-primary)/15 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-(--theme-primary)", children: [due, " due"] }));
}
function RetentionSparkline({ curve }) {
    // SVG defs need document-unique ids — this component renders once per deck card.
    const gradientId = useId();
    const finalDay = curve.at(-1)?.day ?? 1;
    const coordinates = curve.map(point => {
        const x = 2 + (point.day / Math.max(1, finalDay)) * 96;
        const y = 4 + (1 - point.retention) * 30;
        return [x, y];
    });
    const points = coordinates.map(([x, y]) => `${x},${y}`).join(' ');
    const area = `M ${coordinates.map(([x, y]) => `${x} ${y}`).join(' L ')} L 98 38 L 2 38 Z`;
    const first = curve[0];
    const last = curve.at(-1) ?? first;
    return (_jsxs("div", { children: [_jsxs("svg", { "aria-hidden": "true", className: "h-10 w-full", preserveAspectRatio: "none", viewBox: "0 0 100 40", children: [_jsxs("defs", { children: [_jsxs("linearGradient", { id: `${gradientId}-fade`, x1: "0", x2: "0", y1: "0", y2: "1", children: [_jsx("stop", { offset: "0%", stopColor: "var(--theme-primary)", stopOpacity: "0.38" }), _jsx("stop", { offset: "70%", stopColor: "var(--theme-primary)", stopOpacity: "0.08" }), _jsx("stop", { offset: "100%", stopColor: "var(--theme-primary)", stopOpacity: "0" })] }), _jsx("filter", { height: "300%", id: `${gradientId}-glow`, width: "120%", x: "-10%", y: "-100%", children: _jsx("feGaussianBlur", { in: "SourceGraphic", stdDeviation: "1.6" }) })] }), _jsx("path", { d: area, fill: `url(#${gradientId}-fade)` }), _jsx("polyline", { fill: "none", filter: `url(#${gradientId}-glow)`, opacity: "0.75", points: points, stroke: "var(--theme-primary)", strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: "2.6" }), _jsx("polyline", { fill: "none", points: points, stroke: "var(--theme-primary)", strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: "1.4", vectorEffect: "non-scaling-stroke" }), _jsx("circle", { cx: coordinates[0][0], cy: coordinates[0][1], fill: "var(--theme-primary)", filter: `url(#${gradientId}-glow)`, opacity: "0.9", r: "2.6" }), _jsx("circle", { cx: coordinates[0][0], cy: coordinates[0][1], fill: "var(--theme-primary)", r: "1.6" })] }), _jsxs("p", { className: "mt-0.5 text-[11px] text-muted-foreground tabular-nums", children: ["Recall ", Math.round(first.retention * 100), "% \u2192 ", Math.round(last.retention * 100), "% in ", finalDay, "d"] })] }));
}
function DeckRow({ deck, now, onBrowse, onMatch, onStudy, state }) {
    const stats = deckStats(state, deck.id, now);
    const openDeck = () => onStudy(deck.id);
    const onKeyDown = (event) => {
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) {
            return;
        }
        event.preventDefault();
        openDeck();
    };
    return (_jsxs("div", { className: "group flex cursor-pointer items-center gap-4 rounded-xl border border-border bg-card px-4 py-3 outline-none transition-[box-shadow,border-color] hover:border-(--theme-primary)/50 hover:ring-2 hover:ring-(--theme-primary)/20 focus-visible:ring-2 focus-visible:ring-(--theme-primary)/45", onClick: openDeck, onKeyDown: onKeyDown, role: "button", tabIndex: 0, children: [_jsxs("div", { className: "min-w-0 flex-1", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: "truncate text-sm font-medium", children: deck.name }), stats.due > 0 && _jsx(DuePill, { due: stats.due })] }), _jsxs("p", { className: "mt-1.5 text-[11px] text-muted-foreground tabular-nums", children: [stats.total, " cards \u00B7 ", stats.fresh, " new"] })] }), _jsxs("div", { className: "flex shrink-0 gap-1.5 opacity-80 transition-opacity group-hover:opacity-100", children: [_jsx(Button, { disabled: stats.total < 2, onClick: event => {
                            event.stopPropagation();
                            onMatch(deck.id);
                        }, size: "sm", variant: "ghost", children: "Match" }), _jsx(Button, { onClick: event => {
                            event.stopPropagation();
                            onBrowse(deck.id);
                        }, size: "sm", variant: "ghost", children: "Cards" })] })] }));
}
function DeckCard({ curve, deck, now, onBrowse, onMatch, onStudy, state }) {
    const stats = deckStats(state, deck.id, now);
    const openDeck = () => onStudy(deck.id);
    const onKeyDown = (event) => {
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) {
            return;
        }
        event.preventDefault();
        openDeck();
    };
    return (_jsxs("div", { className: "group flex cursor-pointer flex-col gap-4 rounded-2xl border border-border bg-card p-5 outline-none transition-[transform,box-shadow,border-color] duration-200 ease-out hover:-translate-y-0.5 hover:border-(--theme-primary)/50 hover:ring-2 hover:ring-(--theme-primary)/20 hover:shadow-lg hover:shadow-black/20 focus-visible:ring-2 focus-visible:ring-(--theme-primary)/45", onClick: openDeck, onKeyDown: onKeyDown, role: "button", tabIndex: 0, children: [_jsxs("div", { className: "flex items-start justify-between gap-2", children: [_jsx("h3", { className: "text-[15px] font-semibold leading-snug tracking-tight", children: deck.name }), stats.due > 0 && _jsx(DuePill, { due: stats.due })] }), curve.length > 0 ? (_jsx(RetentionSparkline, { curve: curve })) : (_jsxs("div", { children: [_jsx("svg", { "aria-hidden": "true", className: "h-10 w-full", preserveAspectRatio: "none", viewBox: "0 0 100 40", children: _jsx("line", { stroke: "var(--ui-stroke-secondary)", strokeDasharray: "3 4", strokeLinecap: "round", strokeWidth: "1.2", x1: "2", x2: "98", y1: "10", y2: "30" }) }), _jsx("p", { className: "mt-0.5 text-[11px] text-muted-foreground/70", children: "Study one card to light up this deck\u2019s forgetting curve." })] })), _jsxs("p", { className: "mt-auto text-[11px] tabular-nums text-muted-foreground", children: [stats.total, " card", stats.total === 1 ? '' : 's', " \u00B7 ", stats.fresh, " new"] }), _jsxs("div", { className: "flex gap-2", children: [_jsx(Button, { disabled: stats.total < 2, onClick: event => {
                            event.stopPropagation();
                            onMatch(deck.id);
                        }, size: "sm", variant: "outline", children: "Match" }), _jsx(Button, { onClick: event => {
                            event.stopPropagation();
                            onBrowse(deck.id);
                        }, size: "sm", variant: "ghost", children: "Cards" })] })] }));
}
// Contribution grid of review activity with streak stats, month labels, hover tooltips,
// legend, and a today marker — the "dynamic" upgrade.
const HEAT_MIX = ['', '30%', '52%', '76%', '100%'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function heatColor(level) {
    return level === 0
        ? 'color-mix(in srgb, var(--ui-text-primary) 10%, transparent)'
        : `color-mix(in srgb, var(--theme-primary) ${HEAT_MIX[level]}, transparent)`;
}
function Stat({ label, value }) {
    return (_jsxs("span", { className: "flex items-baseline gap-1", children: [_jsx("span", { className: "text-sm font-semibold text-foreground", children: value }), _jsx("span", { className: "text-muted-foreground", children: label })] }));
}
function Heatmap({ state }) {
    const todayIso = new Date().toISOString();
    const { cells, total } = useMemo(() => reviewHeatmap(state, todayIso), [state, todayIso]);
    const stats = useMemo(() => studyMotivation(state, todayIso), [state, todayIso]);
    const todayKey = todayIso.slice(0, 10);
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
    return (_jsx("div", { className: "px-8 pt-2", children: _jsxs("div", { className: "rounded-2xl border border-border bg-card p-5", children: [_jsxs("div", { className: "mb-4", children: [_jsx("p", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--theme-primary)", children: "Review activity" }), _jsxs("div", { className: "mt-1.5 flex flex-wrap items-center gap-x-6 gap-y-1.5 text-xs", children: [_jsx(Stat, { label: "day streak", value: stats.currentStreak }), _jsx(Stat, { label: "longest", value: stats.longestStreak }), _jsx(Stat, { label: "days active", value: `${stats.daysLearnedPct}%` }), stats.retentionPct !== null && _jsx(Stat, { label: "retention (30d)", value: `${stats.retentionPct}%` }), _jsxs("span", { className: "text-muted-foreground", children: [total, " reviews \u00B7 past 12 months"] })] }), total === 0 && _jsx("p", { className: "mt-1 text-xs text-muted-foreground", children: "Your year fills in as you grade cards." })] }), _jsx("div", { className: "overflow-x-auto pb-1", children: _jsxs("div", { className: "min-w-max", children: [_jsxs("div", { className: "grid grid-cols-[2rem_auto] gap-x-2 gap-y-1", children: [_jsx("div", {}), _jsx("div", { className: "relative h-3 text-[9px] text-muted-foreground", style: { width: `${weeks * 14}px` }, children: monthLabels.map(month => (_jsx("span", { className: "absolute", style: { left: `${month.col * 14}px` }, children: month.label }, `${month.label}-${month.col}`))) }), _jsx("div", { className: "grid grid-rows-7 gap-[3px] text-[9px] leading-[11px] text-muted-foreground", style: { gridTemplateRows: 'repeat(7, 11px)' }, children: WEEKDAYS.map(day => (_jsx("span", { children: day }, day))) }), _jsxs("div", { className: "grid grid-flow-col grid-rows-7 gap-[3px]", style: { gridAutoColumns: '11px', gridTemplateRows: 'repeat(7, 11px)' }, children: [Array.from({ length: firstDayOffset }, (_, index) => (_jsx("span", { "aria-hidden": "true" }, `leading-${index}`))), cells.map(cell => (_jsx(Tip, { label: `${cell.count} review${cell.count === 1 ? '' : 's'} · ${new Date(`${cell.date}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' })}`, side: "top", children: _jsx("div", { className: cn('rounded-[2px]', cell.date === todayKey && 'ring-1 ring-foreground/60'), style: { backgroundColor: heatColor(cell.level) } }) }, cell.date)))] })] }), _jsxs("div", { className: "mt-2 flex items-center justify-end gap-1 text-[9px] text-muted-foreground", children: [_jsx("span", { children: "Less" }), [0, 1, 2, 3, 4].map(level => (_jsx("span", { className: "size-2.5 rounded-[2px]", style: { backgroundColor: heatColor(level) } }, level))), _jsx("span", { children: "More" })] })] }) })] }) }));
}
function CardBrowser({ deck, onChange, onDeleteDeck, onMatch, onMoveDeck, sections, state }) {
    const [editing, setEditing] = useState(null);
    const [adding, setAdding] = useState(false);
    const [armDelete, setArmDelete] = useState(false);
    if (!deck) {
        return _jsx(EmptyState, { className: "flex-1", description: "This deck no longer exists.", title: "Deck not found" });
    }
    return (_jsxs("div", { className: "px-6 pb-8", children: [_jsxs("div", { className: "mb-2 flex items-center justify-between gap-3 border-b border-border pb-1.5", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-sm font-semibold", children: deck.name }), _jsxs("p", { className: "text-xs text-muted-foreground", children: [deck.course ? `${deck.course} · ` : '', deck.cards.length, " card", deck.cards.length === 1 ? '' : 's'] })] }), _jsxs("div", { className: "flex flex-wrap items-center justify-end gap-2", children: [_jsx("div", { className: "w-40", children: _jsx(SectionSelect, { label: "Move deck to section", onChange: onMoveDeck, sections: sections, value: deck.course ?? '' }) }), _jsx(Button, { className: cn(armDelete && 'text-destructive'), onBlur: () => setArmDelete(false), onClick: () => (armDelete ? onDeleteDeck() : setArmDelete(true)), size: "sm", variant: "outline", children: armDelete ? 'Really delete?' : 'Delete deck' }), _jsx(Button, { disabled: deck.cards.length < 2, onClick: onMatch, size: "sm", variant: "outline", children: "Match" }), _jsx(Button, { onClick: () => setAdding(true), size: "sm", variant: "outline", children: "Add card" })] })] }), deck.cards.length === 0 ? (_jsx(EmptyState, { className: "min-h-40", description: "Add a card or import a set.", title: "No cards in this deck" })) : (_jsx("div", { className: "overflow-hidden rounded-lg border border-border", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { className: "bg-muted/40 text-xs text-muted-foreground", children: _jsxs("tr", { children: [_jsx("th", { className: "px-3 py-2 text-left font-medium", children: "Front" }), _jsx("th", { className: "hidden px-3 py-2 text-left font-medium md:table-cell", children: "Back" }), _jsx("th", { className: "px-3 py-2 text-left font-medium", children: "Tags" }), _jsx("th", { className: "w-8 px-3 py-2" })] }) }), _jsx("tbody", { children: deck.cards.map(card => (_jsxs("tr", { className: cn('cursor-pointer border-t border-border hover:bg-accent', card.suspended && 'opacity-45'), onClick: () => setEditing(card), children: [_jsxs("td", { className: "max-w-xs truncate px-3 py-2", children: [card.suspended && (_jsx(IconPlayerPause, { className: "-mt-px mr-1 inline text-muted-foreground", size: 12 })), card.front] }), _jsx("td", { className: "hidden max-w-xs truncate px-3 py-2 text-muted-foreground md:table-cell", children: card.back }), _jsx("td", { className: "px-3 py-2", children: _jsx("div", { className: "flex flex-wrap gap-1", children: card.tags.map(tag => (_jsx(Badge, { variant: "outline", children: tag }, tag))) }) }), _jsx("td", { className: "px-3 py-2 text-right text-muted-foreground", children: "\u203A" })] }, card.id))) })] }) })), editing && (_jsx(EditCardDialog, { card: editing, onClose: () => setEditing(null), onDelete: () => {
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
                } }))] }));
}
function EditCardDialog({ card, onClose, onDelete, onSave, onToggleSuspend }) {
    const [front, setFront] = useState(card.front);
    const [back, setBack] = useState(card.back);
    const [tags, setTags] = useState(card.tags.join(', '));
    return (_jsx(Dialog, { onOpenChange: open => !open && onClose(), open: true, children: _jsxs(DialogContent, { className: "sm:max-w-lg", children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "Edit card" }), _jsx(DialogDescription, { children: "Suspend hides a card from review without deleting it." })] }), _jsxs("div", { className: "flex flex-col gap-3", children: [_jsx(Textarea, { className: "min-h-20", onChange: event => setFront(event.target.value), placeholder: "Front", value: front }), _jsx(Textarea, { className: "min-h-20", onChange: event => setBack(event.target.value), placeholder: "Back", value: back }), _jsx(Input, { onChange: event => setTags(event.target.value), placeholder: "Tags (comma-separated)", value: tags })] }), _jsxs(DialogFooter, { className: "flex-wrap gap-2 sm:justify-between", children: [_jsxs("div", { className: "flex gap-2", children: [_jsx(Button, { className: "text-destructive", onClick: onDelete, variant: "outline", children: "Delete" }), _jsx(Button, { onClick: onToggleSuspend, variant: "outline", children: card.suspended ? 'Unsuspend' : 'Suspend' })] }), _jsx(Button, { disabled: !front.trim() || !back.trim(), onClick: () => onSave({
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
    return (_jsx(Dialog, { onOpenChange: open => !open && onClose(), open: true, children: _jsxs(DialogContent, { className: "sm:max-w-lg", children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "Add card" }), _jsx(DialogDescription, { children: "New cards enter the review queue as \u201Cnew\u201D." })] }), _jsxs("div", { className: "flex flex-col gap-3", children: [_jsx(Textarea, { className: "min-h-20", onChange: event => setFront(event.target.value), placeholder: "Front", value: front }), _jsx(Textarea, { className: "min-h-20", onChange: event => setBack(event.target.value), placeholder: "Back", value: back }), _jsx(Input, { onChange: event => setTags(event.target.value), placeholder: "Tags (comma-separated)", value: tags })] }), _jsxs(DialogFooter, { children: [_jsx(Button, { onClick: onClose, variant: "outline", children: "Cancel" }), _jsx(Button, { disabled: !front.trim() || !back.trim(), onClick: () => onCreate(front.trim(), back.trim(), tags
                                .split(',')
                                .map(tag => tag.trim())
                                .filter(Boolean)), children: "Add card" })] })] }) }));
}
function FlipFace({ back, children, label, muted }) {
    return (_jsxs("div", { className: cn('absolute inset-0 flex min-h-64 flex-col justify-center gap-3 rounded-xl border border-border bg-card p-8 text-left [backface-visibility:hidden]', back && '[transform:rotateY(180deg)]'), children: [_jsx("div", { className: "text-[10px] font-medium uppercase tracking-widest text-muted-foreground", children: label }), _jsx("div", { className: cn('text-lg leading-relaxed', muted ? 'text-foreground/80' : 'text-foreground'), children: children })] }));
}
function buildMatchTiles(deck, size) {
    // Deterministic-enough shuffle without RNG dependence on the module: seed off the
    // clock once per round (fresh each mount).
    const pool = [...deck.cards];
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
    const size = deck ? Math.min(6, deck.cards.length) : 0;
    const [tiles, setTiles] = useState(() => (deck ? buildMatchTiles(deck, size) : []));
    const [selected, setSelected] = useState(null);
    const [matched, setMatched] = useState(new Set());
    const [wrong, setWrong] = useState(null);
    const [elapsed, setElapsed] = useState(0);
    const [won, setWon] = useState(false);
    const restart = useCallback(() => {
        if (!deck) {
            return;
        }
        setTiles(buildMatchTiles(deck, size));
        setSelected(null);
        setMatched(new Set());
        setWrong(null);
        setElapsed(0);
        setWon(false);
    }, [deck, size]);
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
function ReviewSurface({ flip, intervals, item, onGrade, onReveal, remainingCounts, revealed, showIntervalHints }) {
    return (_jsx("div", { className: "flex flex-1 flex-col items-center px-6 pb-8", children: _jsxs("div", { className: "flex w-full max-w-2xl flex-1 flex-col", children: [_jsxs("div", { className: "flex items-center justify-between pb-2 text-xs text-muted-foreground", children: [_jsxs("span", { className: "truncate", children: [item.deckName, item.isNew && (_jsx(Badge, { className: "ml-2", variant: "outline", children: "new" }))] }), _jsxs("span", { "aria-label": "Cards remaining", className: "flex shrink-0 items-center gap-3 font-mono text-[0.6875rem] tabular-nums", children: [_jsxs("span", { className: "text-(--ui-blue)", title: "New cards remaining", children: [remainingCounts.new, " ", _jsx("span", { className: "font-sans text-muted-foreground", children: "New" })] }), _jsxs("span", { className: "text-(--ui-red)", title: "Learning cards remaining", children: [remainingCounts.learning, " ", _jsx("span", { className: "font-sans text-muted-foreground", children: "Learning" })] }), _jsxs("span", { className: "text-(--ui-green)", title: "Review cards remaining", children: [remainingCounts.review, " ", _jsx("span", { className: "font-sans text-muted-foreground", children: "Review" })] })] })] }), flip ? (_jsx("button", { "aria-label": revealed ? item.card.back : 'Show answer', className: "nemesis-flip flex-1 [perspective:1600px]", "data-flipped": revealed ? 'true' : undefined, onClick: () => !revealed && onReveal(), type: "button", children: _jsxs("div", { className: "nemesis-flip-inner relative h-full min-h-64 w-full", children: [_jsx(FlipFace, { label: "Question", children: item.card.front }), _jsx(FlipFace, { back: true, label: "Answer", muted: true, children: item.card.back })] }) })) : (_jsxs("div", { className: "flex min-h-64 flex-1 flex-col justify-center gap-5 rounded-xl border border-border bg-card p-8", children: [_jsxs("div", { children: [_jsx("div", { className: "pb-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground", children: "Question" }), _jsx("div", { className: "text-lg leading-relaxed", children: item.card.front })] }), revealed && (_jsxs(_Fragment, { children: [_jsx("div", { className: "border-t border-border" }), _jsxs("div", { children: [_jsx("div", { className: "pb-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground", children: "Answer" }), _jsx("div", { className: "text-lg leading-relaxed text-foreground/80", children: item.card.back })] })] }))] })), item.card.tags.length > 0 && (_jsx("div", { className: "flex flex-wrap gap-1 pt-2.5", children: item.card.tags.map(tag => (_jsx(Badge, { variant: "outline", children: tag }, tag))) })), _jsx("div", { className: "pt-4", children: revealed ? (_jsx("div", { className: "grid grid-cols-4 gap-2", children: GRADES.map(option => (_jsxs(Button, { className: cn('flex-col gap-0.5 py-5', option.rating === 'again' && 'text-destructive'), onClick: () => onGrade(option.rating), variant: "secondary", children: [_jsx("span", { children: option.label }), showIntervalHints && (_jsxs("span", { className: "text-[10px] opacity-60", children: [intervals[option.rating], " \u00B7 ", option.key] }))] }, option.rating))) })) : (_jsxs(Button, { className: "w-full py-5", onClick: onReveal, variant: "secondary", children: ["Show answer ", _jsx("span", { className: "ml-2 text-[10px] opacity-60", children: "Space" })] })) })] }) }));
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
