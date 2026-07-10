import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Study — Anki-style spaced repetition over FSRS (see model.ts for the algorithm/licensing
// note). Interaction model deliberately mirrors what health-science students already have
// as muscle memory from Anki: deck browser with due badges → flip card (Space) →
// Again/Hard/Good/Easy (1-4), with the next-interval hint under each grade button.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { parseCardPaste } from './import-cards';
import { buildQueue, deckStats, freshId, gradeCard, loadState, previewIntervals, saveState } from './model';
const GRADES = [
    { key: '1', label: 'Again', rating: 'again' },
    { key: '2', label: 'Hard', rating: 'hard' },
    { key: '3', label: 'Good', rating: 'good' },
    { key: '4', label: 'Easy', rating: 'easy' }
];
export function StudyView() {
    const [state, setState] = useState(() => loadState());
    const [reviewDeckId, setReviewDeckId] = useState(null);
    const [reviewing, setReviewing] = useState(false);
    const [revealed, setRevealed] = useState(false);
    const [importOpen, setImportOpen] = useState(false);
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
    return (_jsxs("div", { className: "flex h-full min-h-0 flex-col overflow-y-auto", children: [_jsxs("header", { className: "flex shrink-0 items-center justify-between gap-3 px-6 pb-3 pt-5", children: [_jsxs("div", { children: [_jsx("h1", { className: "text-lg font-semibold", children: "Study" }), _jsxs("p", { className: "text-xs text-muted-foreground", children: [totals.due, " due \u00B7 ", totals.fresh, " new \u00B7 ", totals.total, " cards"] })] }), _jsx("div", { className: "flex items-center gap-2", children: reviewing ? (_jsx(Button, { onClick: exitReview, size: "sm", variant: "outline", children: "Back to decks" })) : (_jsxs(_Fragment, { children: [_jsx(Button, { onClick: () => setImportOpen(true), size: "sm", variant: "outline", children: "Import cards" }), _jsx(Button, { disabled: totals.due === 0, onClick: () => startReview(null), size: "sm", children: "Study all" })] })) })] }), reviewing ? (current ? (_jsx(ReviewSurface, { done: done, item: current, intervals: previewIntervals(state, current.card.id, now), onGrade: grade, onReveal: () => setRevealed(true), remaining: queue.length, revealed: revealed })) : (_jsx(EmptyState, { className: "flex-1", description: done > 0 ? `${done} card${done === 1 ? '' : 's'} reviewed. Come back when the next ones are due.` : 'Nothing is due right now.', title: "All caught up" }))) : (_jsx(DeckGrid, { onStudy: startReview, state: state })), _jsx(ImportDialog, { onImport: importCards, onOpenChange: setImportOpen, open: importOpen })] }));
}
function DeckGrid({ onStudy, state }) {
    const now = new Date();
    if (!state.decks.length) {
        return _jsx(EmptyState, { className: "flex-1", description: "Import cards to build your first deck.", title: "No decks yet" });
    }
    return (_jsx("div", { className: "grid grid-cols-1 gap-3 px-6 pb-6 md:grid-cols-2 xl:grid-cols-3", children: state.decks.map(deck => {
            const stats = deckStats(state, deck.id, now);
            return (_jsxs("div", { className: "flex flex-col gap-3 rounded-lg border border-border bg-card p-4", children: [_jsxs("div", { className: "min-w-0", children: [_jsxs("div", { className: "flex items-start justify-between gap-2", children: [_jsx("div", { className: "truncate text-sm font-medium", children: deck.name }), stats.due > 0 && _jsxs(Badge, { variant: "muted", children: [stats.due, " due"] })] }), _jsxs("div", { className: "mt-1 text-xs text-muted-foreground", children: [deck.course ? `${deck.course} · ` : '', stats.total, " cards \u00B7 ", stats.fresh, " new"] })] }), _jsx("div", { className: "mt-auto", children: _jsx(Button, { disabled: stats.due === 0, onClick: () => onStudy(deck.id), size: "sm", variant: "secondary", children: stats.due > 0 ? 'Study' : 'Done for now' }) })] }, deck.id));
        }) }));
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
