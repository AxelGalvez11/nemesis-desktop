import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Codicon } from '@/components/ui/codicon';
import { courseTitle, dueSoon, emptyGraph, eventsOnDay, loadAcademicGraph, recentChanges, scoreNextAction } from '@/lib/academic-graph';
import { setComposerDraft } from '@/store/composer';
import { dateKey, loadCalendarState, parseDateKey } from '../calendar/model';
import { CALENDAR_ROUTE, LEDGER_ROUTE, NEW_CHAT_ROUTE, SETTINGS_ROUTE } from '../routes';
const DAY_START_MINUTES = 8 * 60;
const DAY_END_MINUTES = 22 * 60;
const DEFAULT_EVENT_MINUTES = 60;
const DUE_TYPES = new Set(['application', 'assignment', 'exam']);
const CLOSED_STATUSES = new Set(['done', 'graded', 'submitted']);
const MESSAGE_TITLE_RE = /\b(email|inbox|message|reply|respond|response|follow[ -]?up)\b/i;
function minutesFromTime(value) {
    if (!value) {
        return null;
    }
    const match = /^(\d{1,2}):(\d{2})/.exec(value.trim());
    if (!match) {
        return null;
    }
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    return hour >= 0 && hour < 24 && minute >= 0 && minute < 60 ? hour * 60 + minute : null;
}
function timeFromIso(value) {
    const match = /T(\d{2}:\d{2})/.exec(value ?? '');
    return match?.[1];
}
function formatTime(value) {
    const minutes = minutesFromTime(value);
    if (minutes == null) {
        return value;
    }
    return new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60).toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit'
    });
}
function durationFromFields(fields, start) {
    if (typeof fields?.durationMinutes === 'number' && fields.durationMinutes > 0) {
        return fields.durationMinutes;
    }
    if (typeof fields?.endTime === 'string') {
        const startMinutes = minutesFromTime(start);
        const endMinutes = minutesFromTime(fields.endTime);
        if (startMinutes != null && endMinutes != null && endMinutes > startMinutes) {
            return endMinutes - startMinutes;
        }
    }
    return DEFAULT_EVENT_MINUTES;
}
function studyBlocks(graph, todayKey) {
    const result = [];
    for (const object of graph.objects) {
        const rawBlocks = object.fields?.studyBlocks;
        if (!Array.isArray(rawBlocks)) {
            continue;
        }
        rawBlocks.forEach((raw, index) => {
            if (!raw || typeof raw !== 'object') {
                return;
            }
            const block = raw;
            const date = typeof block.date === 'string' ? block.date.slice(0, 10) : '';
            if (date !== todayKey) {
                return;
            }
            const time = typeof block.start === 'string' ? block.start : typeof block.time === 'string' ? block.time : undefined;
            const startMinutes = minutesFromTime(time);
            const endMinutes = typeof block.end === 'string' ? minutesFromTime(block.end) : null;
            const explicitDuration = typeof block.durationMinutes === 'number' ? block.durationMinutes : null;
            const durationMinutes = explicitDuration && explicitDuration > 0
                ? explicitDuration
                : startMinutes != null && endMinutes != null && endMinutes > startMinutes
                    ? endMinutes - startMinutes
                    : DEFAULT_EVENT_MINUTES;
            result.push({
                durationMinutes,
                id: `study:${object.id}:${index}`,
                kind: 'Study block',
                sortMinutes: startMinutes ?? Number.POSITIVE_INFINITY,
                subtitle: courseTitle(graph, object.course),
                time,
                title: typeof block.title === 'string' && block.title.trim() ? block.title : `Study · ${object.title}`
            });
        });
    }
    return result;
}
function calendarPlanItem(event) {
    const start = minutesFromTime(event.time);
    return {
        durationMinutes: start == null ? undefined : DEFAULT_EVENT_MINUTES,
        id: `calendar:${event.id}`,
        kind: event.kind === 'other' && /\b(study|review|practice|prep)\b/i.test(event.title) ? 'Study block' : event.kind,
        sortMinutes: start ?? Number.POSITIVE_INFINITY,
        subtitle: event.course,
        time: event.time,
        title: event.title
    };
}
function graphPlanItem(graph, object) {
    const time = timeFromIso(object.date);
    const start = minutesFromTime(time);
    return {
        durationMinutes: start == null ? undefined : durationFromFields(object.fields, time),
        id: `graph:${object.id}`,
        kind: object.type,
        sortMinutes: start ?? Number.POSITIVE_INFINITY,
        subtitle: courseTitle(graph, object.course),
        time,
        title: object.title
    };
}
function todayPlan(graph, calendarEvents, todayKey) {
    const calendar = calendarEvents.filter(event => event.date === todayKey).map(calendarPlanItem);
    const academic = eventsOnDay(graph, todayKey).map(object => graphPlanItem(graph, object));
    return [...calendar, ...academic, ...studyBlocks(graph, todayKey)].sort((a, b) => a.sortMinutes - b.sortMinutes || a.title.localeCompare(b.title));
}
function freeMinutes(plan) {
    const ranges = plan
        .filter(item => Number.isFinite(item.sortMinutes) && item.durationMinutes)
        .map(item => ({
        end: Math.min(DAY_END_MINUTES, item.sortMinutes + (item.durationMinutes ?? 0)),
        start: Math.max(DAY_START_MINUTES, item.sortMinutes)
    }))
        .filter(range => range.end > range.start)
        .sort((a, b) => a.start - b.start);
    const merged = [];
    for (const range of ranges) {
        const previous = merged.at(-1);
        if (previous && range.start <= previous.end) {
            previous.end = Math.max(previous.end, range.end);
        }
        else {
            merged.push({ ...range });
        }
    }
    const busy = merged.reduce((total, range) => total + range.end - range.start, 0);
    return Math.max(0, DAY_END_MINUTES - DAY_START_MINUTES - busy);
}
function formatDuration(minutes) {
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    if (hours === 0) {
        return `${remainder} m`;
    }
    return remainder ? `${hours} h ${remainder} m` : `${hours} h`;
}
function relativeDate(value, today) {
    if (!value) {
        return 'No date';
    }
    const date = parseDateKey(value.slice(0, 10));
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const days = Math.round((date.getTime() - todayStart.getTime()) / 86_400_000);
    if (days < 0) {
        return `${Math.abs(days)}d overdue`;
    }
    if (days === 0) {
        return 'Today';
    }
    if (days === 1) {
        return 'Tomorrow';
    }
    return `In ${days} days`;
}
function inboxObjects(graph) {
    return graph.objects
        .filter(object => {
        if (object.type === 'announcement' || object.type === 'contact') {
            return true;
        }
        return (object.type === 'application' && object.status === 'open') || MESSAGE_TITLE_RE.test(object.title);
    })
        .sort((a, b) => (b.updatedAt ?? b.source?.ts ?? b.date ?? '').localeCompare(a.updatedAt ?? a.source?.ts ?? a.date ?? ''));
}
function overdueObjects(graph, todayKey) {
    return graph.objects.filter(object => DUE_TYPES.has(object.type) &&
        Boolean(object.date) &&
        object.date.slice(0, 10) < todayKey &&
        !CLOSED_STATUSES.has(object.status ?? ''));
}
function Card({ children, icon, title }) {
    return (_jsxs("section", { className: "min-w-0 rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) p-4 shadow-[inset_0_1px_0_var(--ui-stroke-quaternary)]", children: [_jsxs("div", { className: "mb-3 flex items-center gap-2", children: [_jsx(Codicon, { className: "text-(--ui-text-tertiary)", name: icon, size: "0.9rem" }), _jsx("h2", { className: "text-xs font-semibold uppercase tracking-[0.08em] text-(--ui-text-secondary)", children: title })] }), children] }));
}
function EmptyCopy({ children }) {
    return _jsx("p", { className: "py-3 text-xs leading-relaxed text-(--ui-text-tertiary)", children: children });
}
function changeIsTrusted(change) {
    return change.kind === 'date-changed' || change.confidence === 'instructor-stated';
}
export function TodayView() {
    const navigate = useNavigate();
    const [graph, setGraph] = useState(() => emptyGraph());
    const [calendarEvents, setCalendarEvents] = useState([]);
    const [loaded, setLoaded] = useState(false);
    const refresh = useCallback(async () => {
        const [nextGraph, calendar] = await Promise.all([loadAcademicGraph(), loadCalendarState()]);
        setGraph(nextGraph);
        setCalendarEvents(calendar.events);
        setLoaded(true);
    }, []);
    useEffect(() => {
        void refresh();
    }, [refresh]);
    useEffect(() => {
        let lastRun = 0;
        const onFocus = () => {
            const now = Date.now();
            if (now - lastRun < 1500) {
                return;
            }
            lastRun = now;
            void refresh();
        };
        window.addEventListener('focus', onFocus);
        return () => window.removeEventListener('focus', onFocus);
    }, [refresh]);
    const now = new Date();
    const todayKey = dateKey(now);
    const plan = useMemo(() => todayPlan(graph, calendarEvents, todayKey), [calendarEvents, graph, todayKey]);
    const changes = useMemo(() => recentChanges(graph, 2), [graph]);
    const upcoming = useMemo(() => dueSoon(graph, 7), [graph]);
    const inbox = useMemo(() => inboxObjects(graph), [graph]);
    const overdue = useMemo(() => overdueObjects(graph, todayKey), [graph, todayKey]);
    const nextAction = useMemo(() => scoreNextAction(graph), [graph]);
    const free = useMemo(() => freeMinutes(plan), [plan]);
    const needsYou = useMemo(() => new Set([...upcoming, ...overdue, ...inbox].map(object => object.id)).size, [inbox, overdue, upcoming]);
    const startNextAction = () => {
        if (!nextAction) {
            return;
        }
        setComposerDraft(`Help me study ${nextAction.object.title} — quiz me and find my weak spots.`);
        navigate(NEW_CHAT_ROUTE);
    };
    const startSchoolSync = () => {
        setComposerDraft('Sync my school — run your school-sync pipeline: sweep Blackboard and Outlook for anything new, capture the files, write lecture notes and flashcards for new material, and update my calendar and Home page. Report what changed.');
        navigate(NEW_CHAT_ROUTE);
    };
    if (!loaded) {
        return (_jsx("main", { className: "grid h-full min-h-0 place-items-center bg-(--ui-editor-surface-background)", children: _jsxs("div", { className: "flex items-center gap-2 text-xs text-(--ui-text-tertiary)", children: [_jsx(Codicon, { name: "loading", spinning: true }), "Building today"] }) }));
    }
    if (graph.objects.length === 0) {
        return (_jsx("main", { className: "grid h-full min-h-0 place-items-center overflow-y-auto bg-(--ui-editor-surface-background) px-6", children: _jsxs("div", { className: "max-w-md text-center", children: [_jsx("span", { className: "mx-auto grid size-12 place-items-center rounded-xl border border-(--theme-primary)/35 bg-(--theme-primary)/10 text-(--theme-primary)", children: _jsx(Codicon, { name: "dashboard", size: "1.35rem" }) }), _jsx("h1", { className: "mt-4 text-xl font-semibold tracking-[-0.02em]", children: "Your semester will live here" }), _jsx("p", { className: "mt-2 text-sm leading-relaxed text-(--ui-text-secondary)", children: "Connect your school accounts and I'll build your semester here." }), _jsxs(Button, { className: "mt-5", onClick: () => navigate(`${SETTINGS_ROUTE}?tab=connections`), children: [_jsx(Codicon, { name: "plug" }), "Open Connections"] })] }) }));
    }
    const greeting = now.getHours() < 12 ? 'morning' : now.getHours() < 18 ? 'afternoon' : 'evening';
    const dateLabel = now.toLocaleDateString(undefined, { day: 'numeric', month: 'short', weekday: 'long' });
    return (_jsx("main", { className: "h-full min-h-0 overflow-y-auto bg-(--ui-editor-surface-background)", children: _jsxs("div", { className: "mx-auto flex w-full max-w-[1180px] flex-col px-5 pb-7 pt-6 sm:px-7", children: [_jsxs("header", { children: [_jsxs("p", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-(--theme-primary)", children: ["Today \u00B7 ", dateLabel] }), _jsxs("h1", { className: "mt-2 text-3xl font-semibold tracking-[-0.035em] sm:text-4xl", children: ["Good ", greeting, ", ", graph.student?.name?.trim() || 'there'] }), _jsxs("p", { className: "mt-2 text-sm text-(--ui-text-secondary)", children: [formatDuration(free), " free today \u00B7 ", needsYou, " item", needsYou === 1 ? '' : 's', " need you \u00B7 ", overdue.length, ' ', "overdue"] })] }), _jsx("section", { className: "mt-6 rounded-xl border-2 border-(--theme-primary) bg-[color-mix(in_srgb,var(--theme-primary)_7%,var(--ui-bg-elevated))] p-5 shadow-[0_0_28px_color-mix(in_srgb,var(--theme-primary)_9%,transparent)]", children: _jsxs("div", { className: "flex flex-col gap-5 sm:flex-row sm:items-center", children: [_jsx("span", { className: "grid size-11 shrink-0 place-items-center rounded-xl bg-(--theme-primary)/15 text-(--theme-primary)", children: _jsx(Codicon, { name: "target", size: "1.2rem" }) }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("p", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.11em] text-(--theme-primary)", children: "Start here" }), _jsx("h2", { className: "mt-1 text-lg font-semibold tracking-[-0.015em]", children: nextAction?.object.title ?? 'You are clear for the moment' }), _jsx("p", { className: "mt-1 text-xs text-(--ui-text-secondary)", children: nextAction?.reason ?? 'No urgent deadline is competing for your attention.' })] }), _jsxs("div", { className: "flex shrink-0 items-center gap-2 self-start sm:self-auto", children: [_jsxs(Button, { onClick: startSchoolSync, size: "lg", variant: "outline", children: [_jsx(Codicon, { name: "sync" }), "Sync school"] }), nextAction && (_jsxs(Button, { onClick: startNextAction, size: "lg", children: [_jsx(Codicon, { name: "play" }), "Start"] }))] })] }) }), _jsxs("div", { className: "mt-5 grid [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))] gap-4", children: [_jsx(Card, { icon: "history", title: "Changed since yesterday", children: changes.length === 0 ? (_jsx(EmptyCopy, { children: "Nothing new." })) : (_jsx("div", { className: "divide-y divide-(--ui-stroke-tertiary)", children: changes.slice(0, 4).map(change => (_jsxs("div", { className: "flex gap-2.5 py-2.5 first:pt-0 last:pb-0", children: [_jsx("span", { className: changeIsTrusted(change)
                                                ? 'mt-1.5 size-1.5 shrink-0 rounded-full bg-(--theme-primary)'
                                                : 'mt-1.5 size-1.5 shrink-0 rounded-full bg-(--ui-text-quaternary)' }), _jsxs("div", { className: "min-w-0", children: [_jsx("p", { className: "text-xs leading-relaxed text-(--ui-text-primary)", children: change.summary }), changeIsTrusted(change) && (_jsx("p", { className: "mt-1 text-[0.625rem] font-medium uppercase tracking-[0.07em] text-(--theme-primary)", children: change.kind === 'date-changed' ? 'Date changed' : 'Instructor stated' }))] })] }, `${change.objectId}:${change.ts}`))) })) }), _jsx(Card, { icon: "calendar", title: "Due soon", children: upcoming.length === 0 ? (_jsx(EmptyCopy, { children: "Nothing due \u2014 you're clear." })) : (_jsx("div", { className: "divide-y divide-(--ui-stroke-tertiary)", children: upcoming.slice(0, 5).map(object => (_jsxs("button", { className: "group flex w-full items-start justify-between gap-3 py-2.5 text-left first:pt-0 last:pb-0", onClick: () => navigate(CALENDAR_ROUTE), type: "button", children: [_jsxs("span", { className: "min-w-0", children: [_jsx("span", { className: "block truncate text-xs font-medium group-hover:text-(--theme-primary)", children: object.title }), _jsx("span", { className: "mt-0.5 block truncate text-[0.6875rem] text-(--ui-text-tertiary)", children: courseTitle(graph, object.course) || object.type })] }), _jsx("span", { className: "shrink-0 text-[0.6875rem] font-medium tabular-nums text-(--ui-text-secondary)", children: relativeDate(object.date, now) })] }, object.id))) })) }), _jsx(Card, { icon: "checklist", title: "Today's plan", children: plan.length === 0 ? (_jsx(EmptyCopy, { children: "Your day is open. Add a study block when you know what deserves the time." })) : (_jsx("div", { className: "divide-y divide-(--ui-stroke-tertiary)", children: plan.slice(0, 5).map(item => (_jsxs("div", { className: "flex gap-3 py-2.5 first:pt-0 last:pb-0", children: [_jsx("span", { className: "w-16 shrink-0 text-[0.6875rem] font-medium tabular-nums text-(--theme-primary)", children: item.time ? formatTime(item.time) : 'Any time' }), _jsxs("div", { className: "min-w-0", children: [_jsx("p", { className: "truncate text-xs font-medium", children: item.title }), _jsx("p", { className: "mt-0.5 truncate text-[0.6875rem] capitalize text-(--ui-text-tertiary)", children: [item.kind, item.subtitle].filter(Boolean).join(' · ') })] })] }, item.id))) })) }), _jsx(Card, { icon: "mail", title: "Inbox needs you", children: inbox.length === 0 ? (_jsx(EmptyCopy, { children: "Nothing waiting for you." })) : (_jsxs("div", { children: [_jsx("div", { className: "divide-y divide-(--ui-stroke-tertiary)", children: inbox.slice(0, 3).map(object => (_jsxs("div", { className: "py-2.5 first:pt-0 last:pb-0", children: [_jsx("p", { className: "truncate text-xs font-medium", children: object.title }), _jsx("p", { className: "mt-0.5 truncate text-[0.6875rem] capitalize text-(--ui-text-tertiary)", children: [object.type, courseTitle(graph, object.course)].filter(Boolean).join(' · ') })] }, object.id))) }), inbox.length > 3 && (_jsxs("p", { className: "mt-3 text-[0.6875rem] text-(--ui-text-quaternary)", children: [inbox.length - 3, " more filed"] }))] })) })] }), _jsxs("button", { className: "mt-5 flex w-full items-center justify-center gap-2 rounded-lg border border-(--ui-stroke-tertiary) px-4 py-3 text-center text-[0.6875rem] text-(--ui-text-tertiary) transition-colors hover:bg-(--ui-control-hover-background) hover:text-(--ui-text-secondary)", onClick: () => navigate(LEDGER_ROUTE), type: "button", children: [_jsx(Codicon, { className: "shrink-0 text-(--theme-primary)", name: "shield", size: "0.85rem" }), _jsx("span", { children: "Read your accounts this morning \u00B7 sent nothing \u00B7 submitted nothing." })] })] }) }));
}
