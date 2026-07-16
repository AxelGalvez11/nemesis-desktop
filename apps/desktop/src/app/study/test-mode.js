import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// Test mode: FULLSCREEN quiz flow for an agent-written test file (see extras.ts), styled
// like the deck ReviewSurface in index.tsx — one question at a time, immediate feedback,
// then a score screen. The page hides its header/tabs while a test runs, so this surface
// carries its own back affordance. Attempts persist to localStorage so the section row
// can show a best/last score without re-opening the test.
import { IconArrowLeft } from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { loadTestAttempts, recordAttempt, saveTestAttempts } from './extras';
export function TestSurface({ file, onComplete, onExit }) {
    const [index, setIndex] = useState(0);
    const [selected, setSelected] = useState(null);
    const [revealed, setRevealed] = useState(false);
    const [answers, setAnswers] = useState([]);
    const [finished, setFinished] = useState(false);
    const [recorded, setRecorded] = useState(false);
    const total = file.questions.length;
    const question = file.questions[index];
    const score = answers.filter(answer => answer.correct).length;
    const selectOption = useCallback((optionIndex) => {
        if (revealed || !question) {
            return;
        }
        setSelected(optionIndex);
        setRevealed(true);
        setAnswers(prev => [...prev, { correct: optionIndex === question.answer, questionIndex: index, selected: optionIndex }]);
    }, [index, question, revealed]);
    const next = useCallback(() => {
        if (!revealed) {
            return;
        }
        if (index + 1 >= total) {
            setFinished(true);
            return;
        }
        setIndex(current => current + 1);
        setSelected(null);
        setRevealed(false);
    }, [index, revealed, total]);
    const retake = useCallback(() => {
        setIndex(0);
        setSelected(null);
        setRevealed(false);
        setAnswers([]);
        setFinished(false);
        setRecorded(false);
    }, []);
    // Persist the attempt exactly once, the moment the score screen first shows.
    useEffect(() => {
        if (!finished || recorded) {
            return;
        }
        setRecorded(true);
        saveTestAttempts(recordAttempt(loadTestAttempts(), file.fileName, { date: new Date().toISOString(), score, total }));
        onComplete();
    }, [file.fileName, finished, onComplete, recorded, score, total]);
    // Same muscle memory as the deck review surface: number keys answer, Enter advances,
    // Escape leaves — including from the score screen (the page chrome is hidden while
    // a test runs, so Esc must always be a way out).
    useEffect(() => {
        const onKey = (event) => {
            const target = event.target;
            if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
                return;
            }
            if (event.key === 'Escape') {
                onExit();
                return;
            }
            if (finished || !question) {
                return;
            }
            if (!revealed) {
                const optionIndex = Number(event.key) - 1;
                if (Number.isInteger(optionIndex) && optionIndex >= 0 && optionIndex < question.options.length) {
                    event.preventDefault();
                    selectOption(optionIndex);
                }
                return;
            }
            if (event.key === 'Enter') {
                event.preventDefault();
                next();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [finished, next, onExit, question, revealed, selectOption]);
    if (finished) {
        return _jsx(TestScoreScreen, { answers: answers, file: file, onExit: onExit, onRetake: retake, score: score });
    }
    if (!question) {
        return null;
    }
    const progress = total > 0 ? ((index + (revealed ? 1 : 0)) / total) * 100 : 0;
    return (_jsx("div", { className: "flex flex-1 flex-col items-center px-6 pb-8 pt-5", children: _jsxs("div", { className: "flex w-full max-w-2xl flex-1 flex-col", children: [_jsxs("div", { className: "flex items-center justify-between gap-4 pb-2 text-xs text-muted-foreground", children: [_jsxs("span", { className: "flex min-w-0 items-center gap-2 truncate", children: [_jsxs("button", { "aria-label": "Leave test", className: "flex shrink-0 items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50", onClick: onExit, type: "button", children: [_jsx(IconArrowLeft, { size: 13 }), "back"] }), _jsx("span", { "aria-hidden": "true", className: "text-(--ui-text-quaternary)", children: "\u00B7" }), file.title] }), _jsxs("span", { className: "tabular-nums", children: [index + 1, "/", total] })] }), _jsx("div", { className: "mb-4 h-1 w-full overflow-hidden rounded-full bg-(--ui-bg-tertiary,theme(colors.muted.DEFAULT))", children: _jsx("div", { className: "h-full bg-(--theme-primary) transition-[width]", style: { width: `${progress}%` } }) }), _jsx("div", { className: "flex min-h-40 flex-1 flex-col justify-center gap-5 rounded-xl border border-border bg-card p-8", children: _jsx("div", { className: "text-lg leading-relaxed", children: question.q }) }), _jsx("div", { className: "grid grid-cols-1 gap-2 pt-4", children: question.options.map((option, optionIndex) => {
                        const isSelected = selected === optionIndex;
                        const isAnswer = optionIndex === question.answer;
                        return (_jsxs("button", { className: cn('flex items-center gap-3 rounded-lg border px-4 py-3 text-left text-sm transition-colors', !revealed && 'border-border bg-card hover:border-(--theme-primary)/50', revealed && isAnswer && 'border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300', revealed && isSelected && !isAnswer && 'nemesis-shake border-destructive bg-destructive/10 text-destructive', revealed && !isSelected && !isAnswer && 'border-border opacity-60'), disabled: revealed, onClick: () => selectOption(optionIndex), type: "button", children: [_jsx("span", { className: "flex size-5 shrink-0 items-center justify-center rounded-full border border-current text-[10px] font-semibold", children: optionIndex + 1 }), _jsx("span", { children: option })] }, optionIndex));
                    }) }), revealed && question.why && (_jsx("div", { className: "mt-4 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground", children: question.why })), _jsx("div", { className: "pt-4", children: revealed ? (_jsxs(Button, { className: "w-full py-5", onClick: next, variant: "secondary", children: [index + 1 >= total ? 'See results' : 'Next question', " ", _jsx("span", { className: "ml-2 text-[10px] opacity-60", children: "Enter" })] })) : (_jsxs("p", { className: "pt-1 text-center text-[10px] text-muted-foreground opacity-60", children: ["Press 1-", question.options.length, " to answer"] })) })] }) }));
}
function TestScoreScreen({ answers, file, onExit, onRetake, score }) {
    const total = file.questions.length;
    const pct = total > 0 ? Math.round((score / total) * 100) : 0;
    const misses = answers.filter(answer => !answer.correct);
    return (_jsxs("div", { className: "mx-auto flex w-full max-w-2xl flex-1 flex-col px-6 pb-8", children: [_jsxs("div", { className: "flex flex-col items-center justify-center gap-1.5 py-10 text-center", children: [_jsxs("div", { className: "text-3xl font-semibold tabular-nums", children: [score, " / ", total] }), _jsxs("p", { className: "text-sm text-muted-foreground", children: [pct, "% correct"] })] }), misses.length > 0 && (_jsxs("div", { className: "mb-6 flex flex-col gap-3", children: [_jsxs("h3", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-muted-foreground", children: ["Review misses (", misses.length, ")"] }), misses.map(miss => {
                        const missedQuestion = file.questions[miss.questionIndex];
                        return (_jsxs("div", { className: "rounded-lg border border-border bg-card p-4", children: [_jsx("p", { className: "text-sm font-medium", children: missedQuestion.q }), _jsxs("p", { className: "mt-1.5 text-xs text-destructive", children: ["Your answer: ", missedQuestion.options[miss.selected]] }), _jsxs("p", { className: "text-xs text-emerald-600 dark:text-emerald-400", children: ["Correct: ", missedQuestion.options[missedQuestion.answer]] }), missedQuestion.why && _jsx("p", { className: "mt-1.5 text-xs text-muted-foreground", children: missedQuestion.why })] }, miss.questionIndex));
                    })] })), _jsxs("div", { className: "flex justify-center gap-2", children: [_jsx(Button, { onClick: onRetake, children: "Retake" }), _jsx(Button, { onClick: onExit, variant: "outline", children: "Back to decks" })] })] }));
}
