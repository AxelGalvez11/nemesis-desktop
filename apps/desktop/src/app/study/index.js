import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Study — Anki-style spaced repetition over FSRS (see model.ts for the algorithm/licensing
// note). Interaction model deliberately mirrors what health-science students already have
// as muscle memory from Anki: deck browser with due badges → flip card (Space) →
// Again/Hard/Good/Easy (1-4), with the next-interval hint under each grade button.
import { IconCards, IconFolderPlus, IconLayoutGrid, IconList, IconPlayerPause } from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { importedDeckFileNames, scanAllDeckFiles } from './deck-files';
import { parseCardPaste } from './import-cards';
import { addCard, addSection, adoptLegacyDeckFiles, assignDeckSection, buildQueue, deckStats, deleteCard, deleteDeck, freshId, gradeCard, groupDecks, loadState, previewIntervals, reconcileDeckFiles, reviewHeatmap, saveState, studyMotivation, toggleSuspendCard, updateCard } from './model';
const GRADES = [
    { key: '1', label: 'Again', rating: 'again' },
    { key: '2', label: 'Hard', rating: 'hard' },
    { key: '3', label: 'Good', rating: 'good' },
    { key: '4', label: 'Easy', rating: 'easy' }
];
const VIEW_MODE_KEY = 'nemesis.study.view';
const FLIP_KEY = 'nemesis.study.flip';
function loadViewMode() {
    try {
        return window.localStorage.getItem(VIEW_MODE_KEY) === 'list' ? 'list' : 'cards';
    }
    catch {
        return 'cards';
    }
}
function loadFlip() {
    try {
        // Default on, but never fight a reduced-motion preference.
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
            return false;
        }
        return window.localStorage.getItem(FLIP_KEY) !== 'off';
    }
    catch {
        return true;
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
    const [view, setView] = useState(() => loadViewMode());
    const [flip, setFlip] = useState(() => loadFlip());
    const [matchDeckId, setMatchDeckId] = useState(null);
    const [done, setDone] = useState(0);
    const [autoImported, setAutoImported] = useState([]);
    const now = useMemo(() => new Date(), [state, reviewing]);
    const queue = useMemo(() => (reviewing ? buildQueue(state, reviewDeckId, now) : []), [state, reviewDeckId, reviewing, now]);
    const current = queue[0];
    const totals = deckStats(state, null, now);
    const sections = useMemo(() => groupDecks(state, now).map(group => group.course).filter(course => course.toLocaleLowerCase() !== 'other'), [now, state]);
    const update = useCallback((next) => {
        setState(next);
        saveState(next);
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
            const candidates = await scanAllDeckFiles();
            if (cancelled || !candidates) {
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
    const toggleFlip = useCallback(() => {
        setFlip(current => {
            const next = !current;
            try {
                window.localStorage.setItem(FLIP_KEY, next ? 'on' : 'off');
            }
            catch {
                // persistence is best-effort
            }
            return next;
        });
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
    return (_jsxs("div", { className: "flex h-full min-h-0 flex-col overflow-y-auto", children: [_jsxs("header", { className: "flex shrink-0 items-center justify-between gap-3 px-6 pb-3 pt-5", children: [_jsxs("div", { children: [_jsx("h1", { className: "text-lg font-semibold", children: "Study" }), _jsxs("p", { className: "text-xs text-muted-foreground", children: [totals.due, " due \u00B7 ", totals.fresh, " new \u00B7 ", totals.total, " cards"] })] }), _jsx("div", { className: "flex flex-wrap items-center justify-end gap-2", children: reviewing || browseDeckId || matchDeckId ? (_jsx(Button, { onClick: () => {
                                exitReview();
                                setBrowseDeckId(null);
                                setMatchDeckId(null);
                            }, size: "sm", variant: "outline", children: "Back to decks" })) : (_jsxs(_Fragment, { children: [_jsxs("div", { className: "mr-1 flex items-center overflow-hidden rounded-md border border-border", children: [_jsx("button", { className: cn('px-2 py-1.5 transition-colors', view === 'cards' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'), onClick: () => setViewMode('cards'), title: "Card view", type: "button", children: _jsx(IconLayoutGrid, { size: 14 }) }), _jsx("button", { className: cn('px-2 py-1.5 transition-colors', view === 'list' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'), onClick: () => setViewMode('list'), title: "List view", type: "button", children: _jsx(IconList, { size: 14 }) })] }), _jsx("button", { className: cn('rounded-md border border-border px-2 py-1.5 transition-colors', flip ? 'text-(--theme-primary)' : 'text-muted-foreground hover:text-foreground'), onClick: toggleFlip, title: flip ? 'Flip animation on' : 'Flip animation off', type: "button", children: _jsx(IconCards, { size: 14 }) }), _jsxs(Button, { onClick: () => setNewSectionOpen(true), size: "sm", variant: "outline", children: [_jsx(IconFolderPlus, { size: 14 }), "New section"] }), _jsx(Button, { onClick: () => setNewDeckSection(''), size: "sm", variant: "outline", children: "New deck" }), _jsx(Button, { onClick: () => setImportOpen(true), size: "sm", variant: "outline", children: "Import cards" }), _jsx(Button, { disabled: totals.due === 0, onClick: () => startReview(null), size: "sm", children: "Study all" })] })) })] }), autoImported.length > 0 && !reviewing && !browseDeckId && (_jsxs("div", { className: "mx-6 mb-1 flex items-center justify-between rounded-md border border-(--theme-primary)/40 bg-(--theme-primary)/10 px-3 py-1.5 text-xs", children: [_jsxs("span", { children: ["Nemesis added ", autoImported.length === 1 ? 'a new deck' : `${autoImported.length} new decks`, ":", ' ', autoImported.join(', ')] }), _jsx("button", { className: "text-muted-foreground hover:text-foreground", onClick: () => setAutoImported([]), type: "button", children: "Dismiss" })] })), reviewing ? (current ? (_jsx(ReviewSurface, { done: done, flip: flip, intervals: previewIntervals(state, current.card.id, now), item: current, onGrade: grade, onReveal: () => setRevealed(true), remaining: queue.length, revealed: revealed })) : (_jsx(EmptyState, { className: "flex-1", description: done > 0 ? `${done} card${done === 1 ? '' : 's'} reviewed. Come back when the next ones are due.` : 'Nothing is due right now.', title: "All caught up" }))) : matchDeckId ? (_jsx(MatchGame, { deck: state.decks.find(deck => deck.id === matchDeckId) ?? null, onExit: () => setMatchDeckId(null) })) : browseDeckId ? (_jsx(CardBrowser, { deck: state.decks.find(deck => deck.id === browseDeckId) ?? null, onChange: update, onDeleteDeck: () => removeDeck(browseDeckId), onMatch: () => startMatch(browseDeckId), onMoveDeck: section => moveDeck(browseDeckId, section), sections: sections, state: state })) : (_jsx(DeckBrowser, { onBrowse: setBrowseDeckId, onCreateDeck: setNewDeckSection, onMatch: startMatch, onStudy: startReview, state: state, view: view })), _jsx(ImportDialog, { onImport: importCards, onOpenChange: setImportOpen, open: importOpen, sections: sections }), newDeckSection !== null && (_jsx(NewDeckDialog, { initialSection: newDeckSection, onClose: () => setNewDeckSection(null), onCreate: createDeck, sections: sections })), newSectionOpen && (_jsx(NewSectionDialog, { onClose: () => setNewSectionOpen(false), onCreate: createSection, sections: sections }))] }));
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
function DeckBrowser({ onBrowse, onCreateDeck, onMatch, onStudy, state, view }) {
    const now = new Date();
    const groups = groupDecks(state, now);
    if (!groups.length) {
        return _jsx(EmptyState, { className: "flex-1", description: "Create a deck or import cards to get going.", title: "No decks yet" });
    }
    return (_jsxs("div", { className: "pb-10", children: [_jsx(Heatmap, { state: state }), groups.map(group => (_jsxs("section", { className: "px-8 pt-7", children: [_jsxs("div", { className: "mb-3 flex items-baseline justify-between", children: [_jsx("h2", { className: "text-[15px] font-semibold tracking-tight", children: group.course }), _jsxs("span", { className: "text-xs text-muted-foreground", children: [group.stats.due, " due \u00B7 ", group.decks.length, " deck", group.decks.length === 1 ? '' : 's', " \u00B7 ", group.stats.total, " cards"] })] }), group.decks.length === 0 ? (_jsxs("div", { className: "rounded-xl border border-dashed border-(--ui-stroke-tertiary) bg-(--ui-bg-card) px-4 py-5", children: [_jsx("p", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--ui-text-quaternary)", children: "Empty section" }), _jsxs("div", { className: "mt-1 flex items-center gap-1 text-xs text-muted-foreground", children: [_jsx("span", { children: "No decks yet \u2014" }), _jsx(Button, { onClick: () => onCreateDeck(group.course), size: "inline", variant: "textStrong", children: "add one" })] })] })) : view === 'list' ? (_jsx("div", { className: "flex flex-col gap-2", children: group.decks.map(deck => (_jsx(DeckRow, { deck: deck, now: now, onBrowse: onBrowse, onMatch: onMatch, onStudy: onStudy, state: state }, deck.id))) })) : (_jsx("div", { className: "grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3", children: group.decks.map(deck => (_jsx(DeckCard, { deck: deck, now: now, onBrowse: onBrowse, onMatch: onMatch, onStudy: onStudy, state: state }, deck.id))) }))] }, group.course)))] }));
}
// Fraction of a deck's cards that have been studied at least once (not "new").
function masteryPct(stats) {
    return stats.total > 0 ? Math.round(((stats.total - stats.fresh) / stats.total) * 100) : 0;
}
function MasteryBar({ pct }) {
    return (_jsx("div", { className: "h-1.5 w-full overflow-hidden rounded-full bg-(--ui-bg-tertiary,color-mix(in_srgb,gray_18%,transparent))", children: _jsx("div", { className: "h-full rounded-full bg-(--theme-primary)", style: { width: `${pct}%` } }) }));
}
function DuePill({ due }) {
    return (_jsxs("span", { className: "shrink-0 rounded-full bg-(--theme-primary)/15 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-(--theme-primary)", children: [due, " due"] }));
}
function DeckRow({ deck, now, onBrowse, onMatch, onStudy, state }) {
    const stats = deckStats(state, deck.id, now);
    return (_jsxs("div", { className: "group flex items-center gap-4 rounded-xl border border-border bg-card px-4 py-3 transition-colors hover:border-(--theme-primary)/40", children: [_jsxs("div", { className: "min-w-0 flex-1", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: "truncate text-sm font-medium", children: deck.name }), stats.due > 0 && _jsx(DuePill, { due: stats.due })] }), _jsxs("div", { className: "mt-1.5 flex items-center gap-2", children: [_jsx("div", { className: "h-1 w-28 max-w-[40%] overflow-hidden rounded-full bg-(--ui-bg-tertiary,color-mix(in_srgb,gray_18%,transparent))", children: _jsx("div", { className: "h-full rounded-full bg-(--theme-primary)", style: { width: `${masteryPct(stats)}%` } }) }), _jsxs("span", { className: "text-[11px] text-muted-foreground tabular-nums", children: [stats.total, " cards \u00B7 ", stats.fresh, " new"] })] })] }), _jsxs("div", { className: "flex shrink-0 gap-1.5 opacity-80 transition-opacity group-hover:opacity-100", children: [_jsx(Button, { disabled: stats.due === 0, onClick: () => onStudy(deck.id), size: "sm", variant: "secondary", children: "Study" }), _jsx(Button, { disabled: stats.total < 2, onClick: () => onMatch(deck.id), size: "sm", variant: "ghost", children: "Match" }), _jsx(Button, { onClick: () => onBrowse(deck.id), size: "sm", variant: "ghost", children: "Cards" })] })] }));
}
function DeckCard({ deck, now, onBrowse, onMatch, onStudy, state }) {
    const stats = deckStats(state, deck.id, now);
    const pct = masteryPct(stats);
    return (_jsxs("div", { className: "group flex flex-col gap-4 rounded-2xl border border-border bg-card p-5 transition-[transform,box-shadow,border-color] duration-200 ease-out hover:-translate-y-0.5 hover:border-(--theme-primary)/40 hover:shadow-lg hover:shadow-black/20", children: [_jsxs("div", { className: "flex items-start justify-between gap-2", children: [_jsx("h3", { className: "text-[15px] font-semibold leading-snug tracking-tight", children: deck.name }), stats.due > 0 && _jsx(DuePill, { due: stats.due })] }), _jsxs("div", { className: "mt-auto", children: [_jsxs("div", { className: "mb-1.5 flex items-baseline justify-between text-[11px] text-muted-foreground", children: [_jsxs("span", { className: "tabular-nums", children: [stats.total, " card", stats.total === 1 ? '' : 's', " \u00B7 ", stats.fresh, " new"] }), _jsxs("span", { className: "tabular-nums", children: [pct, "% studied"] })] }), _jsx(MasteryBar, { pct: pct })] }), _jsxs("div", { className: "flex gap-2", children: [_jsx(Button, { className: "flex-1", disabled: stats.due === 0, onClick: () => onStudy(deck.id), size: "sm", children: stats.due > 0 ? 'Study' : 'Done for now' }), _jsx(Button, { disabled: stats.total < 2, onClick: () => onMatch(deck.id), size: "sm", variant: "outline", children: "Match" }), _jsx(Button, { onClick: () => onBrowse(deck.id), size: "sm", variant: "ghost", children: "Cards" })] })] }));
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
    const weeks = Math.ceil(cells.length / 7);
    const monthLabels = [];
    let lastMonth = -1;
    for (let w = 0; w < weeks; w++) {
        const first = cells[w * 7];
        if (first) {
            const month = Number(first.date.slice(5, 7)) - 1;
            if (month !== lastMonth) {
                monthLabels.push({ col: w, label: MONTHS[month] });
                lastMonth = month;
            }
        }
    }
    return (_jsx("div", { className: "px-8 pt-2", children: _jsxs("div", { className: "rounded-2xl border border-border bg-card p-5", children: [_jsxs("div", { className: "mb-4", children: [_jsx("p", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--theme-primary)", children: "Review activity" }), _jsxs("div", { className: "mt-1.5 flex flex-wrap items-center gap-x-6 gap-y-1.5 text-xs", children: [_jsx(Stat, { label: "day streak", value: stats.currentStreak }), _jsx(Stat, { label: "longest", value: stats.longestStreak }), _jsx(Stat, { label: "days active", value: `${stats.daysLearnedPct}%` }), stats.retentionPct !== null && _jsx(Stat, { label: "retention (30d)", value: `${stats.retentionPct}%` }), _jsxs("span", { className: "text-muted-foreground", children: [total, " reviews \u00B7 past 53 weeks"] })] }), total === 0 && _jsx("p", { className: "mt-1 text-xs text-muted-foreground", children: "Your year fills in as you grade cards." })] }), _jsx("div", { className: "overflow-x-auto pb-1", children: _jsxs("div", { className: "min-w-max", children: [_jsxs("div", { className: "grid grid-cols-[2rem_auto] gap-x-2 gap-y-1", children: [_jsx("div", {}), _jsx("div", { className: "relative h-3 text-[9px] text-muted-foreground", style: { width: `${weeks * 14}px` }, children: monthLabels.map(month => (_jsx("span", { className: "absolute", style: { left: `${month.col * 14}px` }, children: month.label }, `${month.label}-${month.col}`))) }), _jsx("div", { className: "grid grid-rows-7 gap-[3px] text-[9px] leading-[11px] text-muted-foreground", style: { gridTemplateRows: 'repeat(7, 11px)' }, children: WEEKDAYS.map(day => (_jsx("span", { children: day }, day))) }), _jsx("div", { className: "grid grid-flow-col grid-rows-7 gap-[3px]", style: { gridAutoColumns: '11px', gridTemplateRows: 'repeat(7, 11px)' }, children: cells.map(cell => (_jsx(Tip, { label: `${cell.count} review${cell.count === 1 ? '' : 's'} · ${new Date(`${cell.date}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' })}`, side: "top", children: _jsx("div", { className: cn('rounded-[2px]', cell.date === todayKey && 'ring-1 ring-foreground/60'), style: { backgroundColor: heatColor(cell.level) } }) }, cell.date))) })] }), _jsxs("div", { className: "mt-2 flex items-center justify-end gap-1 text-[9px] text-muted-foreground", children: [_jsx("span", { children: "Less" }), [0, 1, 2, 3, 4].map(level => (_jsx("span", { className: "size-2.5 rounded-[2px]", style: { backgroundColor: heatColor(level) } }, level))), _jsx("span", { children: "More" })] })] }) })] }) }));
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
                                tags: tags.split(',').map(tag => tag.trim()).filter(Boolean)
                            }), children: "Save" })] })] }) }));
}
function AddCardDialog({ onClose, onCreate }) {
    const [front, setFront] = useState('');
    const [back, setBack] = useState('');
    const [tags, setTags] = useState('');
    return (_jsx(Dialog, { onOpenChange: open => !open && onClose(), open: true, children: _jsxs(DialogContent, { className: "sm:max-w-lg", children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "Add card" }), _jsx(DialogDescription, { children: "New cards enter the review queue as \u201Cnew\u201D." })] }), _jsxs("div", { className: "flex flex-col gap-3", children: [_jsx(Textarea, { className: "min-h-20", onChange: event => setFront(event.target.value), placeholder: "Front", value: front }), _jsx(Textarea, { className: "min-h-20", onChange: event => setBack(event.target.value), placeholder: "Back", value: back }), _jsx(Input, { onChange: event => setTags(event.target.value), placeholder: "Tags (comma-separated)", value: tags })] }), _jsxs(DialogFooter, { children: [_jsx(Button, { onClick: onClose, variant: "outline", children: "Cancel" }), _jsx(Button, { disabled: !front.trim() || !back.trim(), onClick: () => onCreate(front.trim(), back.trim(), tags.split(',').map(tag => tag.trim()).filter(Boolean)), children: "Add card" })] })] }) }));
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
function ReviewSurface({ done, flip, intervals, item, onGrade, onReveal, remaining, revealed }) {
    const total = done + remaining;
    const progress = total > 0 ? Math.round((done / total) * 100) : 0;
    return (_jsx("div", { className: "flex flex-1 flex-col items-center px-6 pb-8", children: _jsxs("div", { className: "flex w-full max-w-2xl flex-1 flex-col", children: [_jsxs("div", { className: "flex items-center justify-between pb-2 text-xs text-muted-foreground", children: [_jsxs("span", { className: "truncate", children: [item.deckName, item.isNew && (_jsx(Badge, { className: "ml-2", variant: "outline", children: "new" }))] }), _jsxs("span", { className: "tabular-nums", children: [done, " done \u00B7 ", remaining, " left"] })] }), _jsx("div", { className: "mb-4 h-1 w-full overflow-hidden rounded-full bg-(--ui-bg-tertiary,theme(colors.muted.DEFAULT))", children: _jsx("div", { className: "h-full bg-(--theme-primary)", style: { width: `${progress}%` } }) }), flip ? (_jsx("button", { "aria-label": revealed ? item.card.back : 'Show answer', className: "nemesis-flip flex-1 [perspective:1600px]", "data-flipped": revealed ? 'true' : undefined, onClick: () => !revealed && onReveal(), type: "button", children: _jsxs("div", { className: "nemesis-flip-inner relative h-full min-h-64 w-full", children: [_jsx(FlipFace, { label: "Question", children: item.card.front }), _jsx(FlipFace, { back: true, label: "Answer", muted: true, children: item.card.back })] }) })) : (_jsxs("div", { className: "flex min-h-64 flex-1 flex-col justify-center gap-5 rounded-xl border border-border bg-card p-8", children: [_jsxs("div", { children: [_jsx("div", { className: "pb-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground", children: "Question" }), _jsx("div", { className: "text-lg leading-relaxed", children: item.card.front })] }), revealed && (_jsxs(_Fragment, { children: [_jsx("div", { className: "border-t border-border" }), _jsxs("div", { children: [_jsx("div", { className: "pb-1.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground", children: "Answer" }), _jsx("div", { className: "text-lg leading-relaxed text-foreground/80", children: item.card.back })] })] }))] })), item.card.tags.length > 0 && (_jsx("div", { className: "flex flex-wrap gap-1 pt-2.5", children: item.card.tags.map(tag => (_jsx(Badge, { variant: "outline", children: tag }, tag))) })), _jsx("div", { className: "pt-4", children: revealed ? (_jsx("div", { className: "grid grid-cols-4 gap-2", children: GRADES.map(option => (_jsxs(Button, { className: cn('flex-col gap-0.5 py-5', option.rating === 'again' && 'text-destructive'), onClick: () => onGrade(option.rating), variant: "secondary", children: [_jsx("span", { children: option.label }), _jsxs("span", { className: "text-[10px] opacity-60", children: [intervals[option.rating], " \u00B7 ", option.key] })] }, option.rating))) })) : (_jsxs(Button, { className: "w-full py-5", onClick: onReveal, variant: "secondary", children: ["Show answer ", _jsx("span", { className: "ml-2 text-[10px] opacity-60", children: "Space" })] })) })] }) }));
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
