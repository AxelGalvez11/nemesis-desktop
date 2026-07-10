import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Study — Anki-style spaced repetition over FSRS (see model.ts for the algorithm/licensing
// note). Interaction model deliberately mirrors what health-science students already have
// as muscle memory from Anki: deck browser with due badges → flip card (Space) →
// Again/Hard/Good/Easy (1-4), with the next-interval hint under each grade button.
import { IconLayoutGrid, IconList } from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { parseCardPaste } from './import-cards';
import { addCard, buildQueue, deckStats, deleteCard, deleteDeck, freshId, gradeCard, groupDecks, loadState, previewIntervals, reviewHeatmap, saveState, studyMotivation, toggleSuspendCard, updateCard } from './model';
const GRADES = [
    { key: '1', label: 'Again', rating: 'again' },
    { key: '2', label: 'Hard', rating: 'hard' },
    { key: '3', label: 'Good', rating: 'good' },
    { key: '4', label: 'Easy', rating: 'easy' }
];
const VIEW_MODE_KEY = 'nemesis.study.view';
function loadViewMode() {
    try {
        return window.localStorage.getItem(VIEW_MODE_KEY) === 'list' ? 'list' : 'cards';
    }
    catch {
        return 'cards';
    }
}
export function StudyView() {
    const [state, setState] = useState(() => loadState());
    const [reviewDeckId, setReviewDeckId] = useState(null);
    const [browseDeckId, setBrowseDeckId] = useState(null);
    const [reviewing, setReviewing] = useState(false);
    const [revealed, setRevealed] = useState(false);
    const [importOpen, setImportOpen] = useState(false);
    const [newDeckOpen, setNewDeckOpen] = useState(false);
    const [view, setView] = useState(() => loadViewMode());
    const [done, setDone] = useState(0);
    const now = useMemo(() => new Date(), [state, reviewing]);
    const queue = useMemo(() => (reviewing ? buildQueue(state, reviewDeckId, now) : []), [state, reviewDeckId, reviewing, now]);
    const current = queue[0];
    const totals = deckStats(state, null, now);
    const update = useCallback((next) => {
        setState(next);
        saveState(next);
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
    const createDeck = useCallback((name, course) => {
        const deck = {
            id: freshId('deck'),
            name: name.trim() || 'New deck',
            course: course.trim() || undefined,
            createdAt: new Date().toISOString(),
            cards: []
        };
        update({ ...state, decks: [...state.decks, deck] });
        setNewDeckOpen(false);
        // Straight into the card browser so the first card is one click away.
        setBrowseDeckId(deck.id);
    }, [state, update]);
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
    return (_jsxs("div", { className: "flex h-full min-h-0 flex-col overflow-y-auto", children: [_jsxs("header", { className: "flex shrink-0 items-center justify-between gap-3 px-6 pb-3 pt-5", children: [_jsxs("div", { children: [_jsx("h1", { className: "text-lg font-semibold", children: "Study" }), _jsxs("p", { className: "text-xs text-muted-foreground", children: [totals.due, " due \u00B7 ", totals.fresh, " new \u00B7 ", totals.total, " cards"] })] }), _jsx("div", { className: "flex items-center gap-2", children: reviewing || browseDeckId ? (_jsx(Button, { onClick: () => {
                                exitReview();
                                setBrowseDeckId(null);
                            }, size: "sm", variant: "outline", children: "Back to decks" })) : (_jsxs(_Fragment, { children: [_jsxs("div", { className: "mr-1 flex items-center overflow-hidden rounded-md border border-border", children: [_jsx("button", { className: cn('px-2 py-1.5 transition-colors', view === 'cards' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'), onClick: () => setViewMode('cards'), title: "Card view", type: "button", children: _jsx(IconLayoutGrid, { size: 14 }) }), _jsx("button", { className: cn('px-2 py-1.5 transition-colors', view === 'list' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'), onClick: () => setViewMode('list'), title: "List view", type: "button", children: _jsx(IconList, { size: 14 }) })] }), _jsx(Button, { onClick: () => setNewDeckOpen(true), size: "sm", variant: "outline", children: "New deck" }), _jsx(Button, { onClick: () => setImportOpen(true), size: "sm", variant: "outline", children: "Import cards" }), _jsx(Button, { disabled: totals.due === 0, onClick: () => startReview(null), size: "sm", children: "Study all" })] })) })] }), reviewing ? (current ? (_jsx(ReviewSurface, { done: done, item: current, intervals: previewIntervals(state, current.card.id, now), onGrade: grade, onReveal: () => setRevealed(true), remaining: queue.length, revealed: revealed })) : (_jsx(EmptyState, { className: "flex-1", description: done > 0 ? `${done} card${done === 1 ? '' : 's'} reviewed. Come back when the next ones are due.` : 'Nothing is due right now.', title: "All caught up" }))) : browseDeckId ? (_jsx(CardBrowser, { deck: state.decks.find(deck => deck.id === browseDeckId) ?? null, onChange: update, onDeleteDeck: () => removeDeck(browseDeckId), state: state })) : (_jsx(DeckBrowser, { onBrowse: setBrowseDeckId, onStudy: startReview, state: state, view: view })), _jsx(ImportDialog, { onImport: importCards, onOpenChange: setImportOpen, open: importOpen }), newDeckOpen && _jsx(NewDeckDialog, { onClose: () => setNewDeckOpen(false), onCreate: createDeck })] }));
}
function NewDeckDialog({ onClose, onCreate }) {
    const [name, setName] = useState('');
    const [course, setCourse] = useState('');
    return (_jsx(Dialog, { onOpenChange: open => !open && onClose(), open: true, children: _jsxs(DialogContent, { className: "sm:max-w-md", children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "New deck" }), _jsx(DialogDescription, { children: "Decks with the same course name group together on this page." })] }), _jsxs("div", { className: "flex flex-col gap-3", children: [_jsx(Input, { autoFocus: true, onChange: event => setName(event.target.value), onKeyDown: event => {
                                if (event.key === 'Enter' && name.trim()) {
                                    onCreate(name, course);
                                }
                            }, placeholder: "Deck name (e.g. Renal pharm)", value: name }), _jsx(Input, { onChange: event => setCourse(event.target.value), placeholder: "Course / group (e.g. Pharmacology \u2014 optional)", value: course })] }), _jsxs(DialogFooter, { children: [_jsx(Button, { onClick: onClose, variant: "outline", children: "Cancel" }), _jsx(Button, { disabled: !name.trim(), onClick: () => onCreate(name, course), children: "Create deck" })] })] }) }));
}
function DeckBrowser({ onBrowse, onStudy, state, view }) {
    const now = new Date();
    const groups = groupDecks(state, now);
    if (!state.decks.length) {
        return _jsx(EmptyState, { className: "flex-1", description: "Create a deck or import cards to get going.", title: "No decks yet" });
    }
    return (_jsxs("div", { className: "pb-8", children: [_jsx(Heatmap, { state: state }), groups.map(group => (_jsxs("section", { className: "px-6 pt-5", children: [_jsxs("div", { className: "mb-2 flex items-baseline justify-between border-b border-border pb-1.5", children: [_jsx("h2", { className: "text-sm font-semibold", children: group.course }), _jsxs("span", { className: "text-xs text-muted-foreground", children: [group.stats.due, " due \u00B7 ", group.decks.length, " deck", group.decks.length === 1 ? '' : 's', " \u00B7 ", group.stats.total, " cards"] })] }), view === 'list' ? (_jsx("div", { className: "overflow-hidden rounded-lg border border-border", children: group.decks.map(deck => (_jsx(DeckRow, { deck: deck, now: now, onBrowse: onBrowse, onStudy: onStudy, state: state }, deck.id))) })) : (_jsx("div", { className: "grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3", children: group.decks.map(deck => (_jsx(DeckCard, { deck: deck, now: now, onBrowse: onBrowse, onStudy: onStudy, state: state }, deck.id))) }))] }, group.course)))] }));
}
function DeckRow({ deck, now, onBrowse, onStudy, state }) {
    const stats = deckStats(state, deck.id, now);
    return (_jsxs("div", { className: "flex items-center gap-3 border-t border-border bg-card px-3 py-2 first:border-t-0 hover:bg-accent/50", children: [_jsx("div", { className: "min-w-0 flex-1 truncate text-sm", children: deck.name }), _jsxs("span", { className: "hidden shrink-0 text-right text-xs text-muted-foreground sm:block", children: [stats.total, " cards \u00B7 ", stats.fresh, " new"] }), _jsx("span", { className: "w-16 shrink-0 text-right", children: stats.due > 0 && _jsxs(Badge, { variant: "muted", children: [stats.due, " due"] }) }), _jsxs("div", { className: "flex shrink-0 gap-1.5", children: [_jsx(Button, { disabled: stats.due === 0, onClick: () => onStudy(deck.id), size: "sm", variant: "secondary", children: "Study" }), _jsx(Button, { onClick: () => onBrowse(deck.id), size: "sm", variant: "outline", children: "Cards" })] })] }));
}
function DeckCard({ deck, now, onBrowse, onStudy, state }) {
    const stats = deckStats(state, deck.id, now);
    return (_jsxs("div", { className: "flex flex-col gap-3 rounded-lg border border-border bg-card p-4", children: [_jsxs("div", { className: "min-w-0", children: [_jsxs("div", { className: "flex items-start justify-between gap-2", children: [_jsx("div", { className: "truncate text-sm font-medium", children: deck.name }), stats.due > 0 && _jsxs(Badge, { variant: "muted", children: [stats.due, " due"] })] }), _jsxs("div", { className: "mt-1 text-xs text-muted-foreground", children: [stats.total, " cards \u00B7 ", stats.fresh, " new"] })] }), _jsxs("div", { className: "mt-auto flex gap-2", children: [_jsx(Button, { className: "flex-1", disabled: stats.due === 0, onClick: () => onStudy(deck.id), size: "sm", variant: "secondary", children: stats.due > 0 ? 'Study' : 'Done for now' }), _jsx(Button, { onClick: () => onBrowse(deck.id), size: "sm", variant: "outline", children: "Cards" })] })] }));
}
// Contribution grid of review activity with streak stats, month labels, hover tooltips,
// legend, and a today marker — the "dynamic" upgrade.
const HEAT_MIX = ['', '30%', '52%', '76%', '100%'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function heatColor(level) {
    return level === 0
        ? 'color-mix(in srgb, gray 16%, transparent)'
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
    return (_jsxs("div", { className: "px-6 pt-1", children: [_jsxs("div", { className: "mb-2.5 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs", children: [_jsx(Stat, { label: "day streak", value: stats.currentStreak }), _jsx(Stat, { label: "longest", value: stats.longestStreak }), _jsx(Stat, { label: "days active", value: `${stats.daysLearnedPct}%` }), stats.retentionPct !== null && _jsx(Stat, { label: "retention (30d)", value: `${stats.retentionPct}%` }), _jsxs("span", { className: "text-muted-foreground", children: [total, " reviews \u00B7 18 weeks"] })] }), _jsxs("div", { className: "inline-flex flex-col gap-1", children: [_jsx("div", { className: "relative h-3 text-[9px] text-muted-foreground", style: { width: `${weeks * 14}px` }, children: monthLabels.map(m => (_jsx("span", { className: "absolute", style: { left: `${m.col * 14}px` }, children: m.label }, `${m.label}-${m.col}`))) }), _jsx("div", { className: "grid grid-flow-col grid-rows-7 gap-[3px]", style: { gridAutoColumns: '11px', gridTemplateRows: 'repeat(7, 11px)' }, children: cells.map(cell => (_jsx(Tip, { label: `${cell.count} review${cell.count === 1 ? '' : 's'} · ${new Date(`${cell.date}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' })}`, side: "top", children: _jsx("div", { className: cn('rounded-[2px]', cell.date === todayKey && 'ring-1 ring-foreground/60'), style: { backgroundColor: heatColor(cell.level) } }) }, cell.date))) }), _jsxs("div", { className: "flex items-center gap-1 self-end text-[9px] text-muted-foreground", children: [_jsx("span", { children: "Less" }), [0, 1, 2, 3, 4].map(level => (_jsx("span", { className: "size-2.5 rounded-[2px]", style: { backgroundColor: heatColor(level) } }, level))), _jsx("span", { children: "More" })] })] })] }));
}
function CardBrowser({ deck, onChange, onDeleteDeck, state }) {
    const [editing, setEditing] = useState(null);
    const [adding, setAdding] = useState(false);
    const [armDelete, setArmDelete] = useState(false);
    if (!deck) {
        return _jsx(EmptyState, { className: "flex-1", description: "This deck no longer exists.", title: "Deck not found" });
    }
    return (_jsxs("div", { className: "px-6 pb-8", children: [_jsxs("div", { className: "mb-2 flex items-baseline justify-between border-b border-border pb-1.5", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-sm font-semibold", children: deck.name }), _jsxs("p", { className: "text-xs text-muted-foreground", children: [deck.course ? `${deck.course} · ` : '', deck.cards.length, " card", deck.cards.length === 1 ? '' : 's'] })] }), _jsxs("div", { className: "flex gap-2", children: [_jsx(Button, { className: cn(armDelete && 'text-destructive'), onBlur: () => setArmDelete(false), onClick: () => (armDelete ? onDeleteDeck() : setArmDelete(true)), size: "sm", variant: "outline", children: armDelete ? 'Really delete?' : 'Delete deck' }), _jsx(Button, { onClick: () => setAdding(true), size: "sm", variant: "outline", children: "Add card" })] })] }), deck.cards.length === 0 ? (_jsx(EmptyState, { className: "min-h-40", description: "Add a card or import a set.", title: "No cards in this deck" })) : (_jsx("div", { className: "overflow-hidden rounded-lg border border-border", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { className: "bg-muted/40 text-xs text-muted-foreground", children: _jsxs("tr", { children: [_jsx("th", { className: "px-3 py-2 text-left font-medium", children: "Front" }), _jsx("th", { className: "hidden px-3 py-2 text-left font-medium md:table-cell", children: "Back" }), _jsx("th", { className: "px-3 py-2 text-left font-medium", children: "Tags" }), _jsx("th", { className: "w-8 px-3 py-2" })] }) }), _jsx("tbody", { children: deck.cards.map(card => (_jsxs("tr", { className: cn('cursor-pointer border-t border-border hover:bg-accent', card.suspended && 'opacity-45'), onClick: () => setEditing(card), children: [_jsxs("td", { className: "max-w-xs truncate px-3 py-2", children: [card.suspended && _jsx("span", { className: "mr-1 text-xs text-muted-foreground", children: "\u23F8" }), card.front] }), _jsx("td", { className: "hidden max-w-xs truncate px-3 py-2 text-muted-foreground md:table-cell", children: card.back }), _jsx("td", { className: "px-3 py-2", children: _jsx("div", { className: "flex flex-wrap gap-1", children: card.tags.map(tag => (_jsx(Badge, { variant: "outline", children: tag }, tag))) }) }), _jsx("td", { className: "px-3 py-2 text-right text-muted-foreground", children: "\u203A" })] }, card.id))) })] }) })), editing && (_jsx(EditCardDialog, { card: editing, onClose: () => setEditing(null), onDelete: () => {
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
function ReviewSurface({ done, intervals, item, onGrade, onReveal, remaining, revealed }) {
    return (_jsx("div", { className: "flex flex-1 flex-col items-center px-6 pb-8", children: _jsxs("div", { className: "flex w-full max-w-2xl flex-1 flex-col", children: [_jsxs("div", { className: "flex items-center justify-between pb-3 text-xs text-muted-foreground", children: [_jsxs("span", { className: "truncate", children: [item.deckName, item.isNew && (_jsx(Badge, { className: "ml-2", variant: "outline", children: "new" }))] }), _jsxs("span", { children: [done, " done \u00B7 ", remaining, " left"] })] }), _jsxs("div", { className: "flex min-h-64 flex-1 flex-col justify-center gap-5 rounded-lg border border-border bg-card p-8", children: [_jsx("div", { className: "text-base leading-relaxed", children: item.card.front }), revealed && (_jsxs(_Fragment, { children: [_jsx("div", { className: "border-t border-border" }), _jsx("div", { className: "text-base leading-relaxed text-muted-foreground", children: item.card.back })] }))] }), _jsx("div", { className: "pt-4", children: revealed ? (_jsx("div", { className: "grid grid-cols-4 gap-2", children: GRADES.map(option => (_jsxs(Button, { className: cn('flex-col gap-0.5 py-5', option.rating === 'again' && 'text-destructive'), onClick: () => onGrade(option.rating), variant: "secondary", children: [_jsx("span", { children: option.label }), _jsxs("span", { className: "text-[10px] opacity-60", children: [intervals[option.rating], " \u00B7 ", option.key] })] }, option.rating))) })) : (_jsxs(Button, { className: "w-full py-5", onClick: onReveal, variant: "secondary", children: ["Show answer ", _jsx("span", { className: "ml-2 text-[10px] opacity-60", children: "Space" })] })) })] }) }));
}
function ImportDialog({ onImport, onOpenChange, open }) {
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
    return (_jsx(Dialog, { onOpenChange: onOpenChange, open: open, children: _jsxs(DialogContent, { className: "sm:max-w-lg", children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "Import cards" }), _jsx(DialogDescription, { children: "Paste one card per line \u2014 term and definition separated by a tab (Quizlet export), \u201C - \u201D, or a comma." })] }), _jsxs("div", { className: "flex flex-col gap-3", children: [_jsx(Input, { onChange: event => setName(event.target.value), placeholder: "Deck name", value: name }), _jsx(Input, { onChange: event => setCourse(event.target.value), placeholder: "Course (optional)", value: course }), _jsx(Textarea, { className: "min-h-40 font-mono text-xs", onChange: event => setText(event.target.value), placeholder: 'lisinopril\tACE inhibitor — dry cough via bradykinin\nmetoprolol - beta-1 selective blocker', value: text }), _jsx("div", { className: "text-xs text-muted-foreground", children: parsedCount > 0 ? `${parsedCount} card${parsedCount === 1 ? '' : 's'} detected` : 'No cards detected yet' })] }), _jsxs(DialogFooter, { children: [_jsx(Button, { onClick: () => onOpenChange(false), variant: "outline", children: "Cancel" }), _jsx(Button, { disabled: parsedCount === 0, onClick: submit, children: "Create deck" })] })] }) }));
}
