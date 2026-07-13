import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Codicon } from '@/components/ui/codicon';
import { courseTitle, dueSoon, emptyGraph, eventsOnDay, loadAcademicGraph, recentChanges, scoreNextAction } from '@/lib/academic-graph';
import { ensurePortalsMirrored, PORTALS_CHANGED_EVENT } from '@/lib/school-portals';
import { cn } from '@/lib/utils';
import { setComposerDraft } from '@/store/composer';
import { dateKey, loadCalendarState, parseDateKey } from '../calendar/model';
import { CALENDAR_ROUTE, LEDGER_ROUTE, NEW_CHAT_ROUTE, SETTINGS_ROUTE } from '../routes';
import { dueSlot, loadCadence, portalSignInStatus, readLastNudge, saveCadence, schoolPortals, writeLastNudge } from './school-sync-schedule';
const SYNC_CADENCE_LABEL = {
    daily: 'Once a day',
    off: 'Manual only',
    twice: 'Twice a day'
};
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
function occupiedRanges(plan) {
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
    return merged;
}
function freeWindows(ranges, minimumMinutes = 30) {
    const windows = [];
    let cursor = DAY_START_MINUTES;
    for (const range of ranges) {
        if (range.start - cursor >= minimumMinutes) {
            windows.push({ end: range.start, start: cursor });
        }
        cursor = Math.max(cursor, range.end);
    }
    if (DAY_END_MINUTES - cursor >= minimumMinutes) {
        windows.push({ end: DAY_END_MINUTES, start: cursor });
    }
    return windows;
}
function freeMinutes(plan) {
    const busy = occupiedRanges(plan).reduce((total, range) => total + range.end - range.start, 0);
    return Math.max(0, DAY_END_MINUTES - DAY_START_MINUTES - busy);
}
function formatMinuteOfDay(minutes) {
    return new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60).toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit'
    });
}
function runwayPercent(minutes) {
    const clamped = Math.min(DAY_END_MINUTES, Math.max(DAY_START_MINUTES, minutes));
    return ((clamped - DAY_START_MINUTES) / (DAY_END_MINUTES - DAY_START_MINUTES)) * 100;
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
function attentionBucket(object, todayKey) {
    const key = object.date?.slice(0, 10);
    if (!key) {
        return 'undated';
    }
    if (key < todayKey) {
        return 'overdue';
    }
    if (key === todayKey) {
        return 'today';
    }
    const today = parseDateKey(todayKey);
    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    if (key === dateKey(tomorrow)) {
        return 'tomorrow';
    }
    return 'later';
}
function needsAttention(overdue, upcoming, inbox, todayKey) {
    const objects = new Map();
    for (const object of [...overdue, ...upcoming, ...inbox]) {
        if (!objects.has(object.id)) {
            objects.set(object.id, object);
        }
    }
    const bucketRank = {
        overdue: 0,
        today: 1,
        tomorrow: 2,
        later: 3,
        undated: 4
    };
    return [...objects.values()]
        .map(object => ({ bucket: attentionBucket(object, todayKey), object }))
        .sort((a, b) => bucketRank[a.bucket] - bucketRank[b.bucket] ||
        (a.object.date ?? '').localeCompare(b.object.date ?? '') ||
        a.object.title.localeCompare(b.object.title));
}
function latestAcademicTimestamp(graph) {
    const timestamps = [
        ...graph.changes.map(change => change.ts),
        ...graph.objects.flatMap(object => [object.updatedAt, object.source?.ts, object.createdAt])
    ]
        .filter((value) => Boolean(value))
        .map(value => Date.parse(value))
        .filter(value => Number.isFinite(value));
    return timestamps.length ? Math.max(...timestamps) : null;
}
function formatFreshness(timestamp, now) {
    if (timestamp == null) {
        return 'Sync time unavailable';
    }
    const elapsedMinutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
    if (elapsedMinutes < 1) {
        return 'Synced just now';
    }
    if (elapsedMinutes < 60) {
        return `Synced ${elapsedMinutes}m ago`;
    }
    const elapsedHours = Math.floor(elapsedMinutes / 60);
    if (elapsedHours < 24) {
        return `Synced ${elapsedHours}h ago`;
    }
    return `Synced ${Math.floor(elapsedHours / 24)}d ago`;
}
function nextActionLabel(object) {
    if (object.type === 'exam') {
        return 'Start exam review';
    }
    if (object.type === 'assignment') {
        return 'Start assignment review';
    }
    if (object.type === 'application') {
        return 'Prepare with Nemesis';
    }
    return 'Start review';
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
    const attentionItems = useMemo(() => needsAttention(overdue, upcoming, inbox, todayKey), [inbox, overdue, todayKey, upcoming]);
    const timedPlan = useMemo(() => plan.filter(item => Number.isFinite(item.sortMinutes)), [plan]);
    const flexiblePlan = useMemo(() => plan.filter(item => !Number.isFinite(item.sortMinutes)), [plan]);
    const busyRanges = useMemo(() => occupiedRanges(plan), [plan]);
    const openWindows = useMemo(() => freeWindows(busyRanges), [busyRanges]);
    const timeline = useMemo(() => [
        ...timedPlan.map(item => ({ item, kind: 'item', sortMinutes: item.sortMinutes })),
        ...openWindows.map(range => ({ kind: 'window', range, sortMinutes: range.start }))
    ].sort((a, b) => a.sortMinutes - b.sortMinutes), [openWindows, timedPlan]);
    const orderedChanges = useMemo(() => [...changes].sort((a, b) => Number(changeIsTrusted(b)) - Number(changeIsTrusted(a)) ||
        (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0)), [changes]);
    const latestSyncAt = useMemo(() => latestAcademicTimestamp(graph), [graph]);
    const freshness = formatFreshness(latestSyncAt, now.getTime());
    const needsYou = attentionItems.length;
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const currentTimeIsOnRunway = currentMinutes >= DAY_START_MINUTES && currentMinutes <= DAY_END_MINUTES;
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
    const startSemesterScaffold = () => {
        setComposerDraft('Set up my semester — run your semester-scaffold skill: find my course syllabi, and for each course build the skeleton (weekly topic schedule, every exam and assignment with its date and grade weight, the grading breakdown) into my graph and a per-course overview note. Frame the whole term first; I\'ll pull materials after. Report what you set up.');
        navigate(NEW_CHAT_ROUTE);
    };
    const [cadence, setCadence] = useState(() => loadCadence());
    const [portals, setPortals] = useState(() => schoolPortals());
    const [portalStatus, setPortalStatus] = useState({});
    // Refresh the signed-in status when Today mounts/refocuses — the student may
    // have logged into a portal in the browser panel since last time — and re-read
    // the portal list when it's edited in Settings → Connections. Mount also
    // re-mirrors the list to .nemesis/portals.json so the agent always finds it.
    useEffect(() => {
        let alive = true;
        ensurePortalsMirrored();
        const refresh = () => void portalSignInStatus().then(status => alive && setPortalStatus(status));
        const onPortalsChanged = () => {
            if (alive) {
                setPortals(schoolPortals());
            }
            refresh();
        };
        refresh();
        window.addEventListener('focus', refresh);
        window.addEventListener(PORTALS_CHANGED_EVENT, onPortalsChanged);
        return () => {
            alive = false;
            window.removeEventListener('focus', refresh);
            window.removeEventListener(PORTALS_CHANGED_EVENT, onPortalsChanged);
        };
    }, []);
    // The scheduler: while the app is open, check each minute whether a scheduled
    // slot is due; if so, fire ONE native "time to sync" nudge (never a silent
    // token-spending turn), tagged so it fires at most once per slot per day.
    useEffect(() => {
        if (cadence === 'off') {
            return;
        }
        const tick = () => {
            const slot = dueSlot(cadence, new Date(), readLastNudge());
            if (!slot) {
                return;
            }
            writeLastNudge(slot);
            void window.hermesDesktop?.notify?.({
                body: 'Open Nemesis and hit Sync school to pull in new lectures, files, and deadlines.',
                title: 'Time to sync your school'
            });
        };
        tick();
        const timer = window.setInterval(tick, 60_000);
        return () => window.clearInterval(timer);
    }, [cadence]);
    const changeCadence = (next) => {
        setCadence(next);
        saveCadence(next);
    };
    if (!loaded) {
        return (_jsx("main", { className: "grid h-full min-h-0 place-items-center bg-(--ui-editor-surface-background)", children: _jsxs("div", { className: "flex items-center gap-2 text-xs text-(--ui-text-tertiary)", children: [_jsx(Codicon, { name: "loading", spinning: true }), "Building today"] }) }));
    }
    if (graph.objects.length === 0) {
        return (_jsx("main", { className: "grid h-full min-h-0 place-items-center overflow-y-auto bg-(--ui-editor-surface-background) px-6", children: _jsxs("div", { className: "max-w-md text-center", children: [_jsx("span", { className: "mx-auto grid size-12 place-items-center rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) text-(--ui-text-secondary)", children: _jsx(Codicon, { name: "dashboard", size: "1.35rem" }) }), _jsx("h1", { className: "mt-4 text-xl font-semibold tracking-[-0.02em]", children: "Your semester will live here" }), _jsx("p", { className: "mt-2 text-sm leading-relaxed text-(--ui-text-secondary)", children: "Give me a syllabus and I\u2019ll frame your whole term \u2014 weekly topics, every exam and its weight, the grading breakdown \u2014 then fill it in as materials arrive." }), _jsxs("div", { className: "mt-5 flex flex-col items-center gap-2", children: [_jsxs(Button, { onClick: startSemesterScaffold, children: [_jsx(Codicon, { name: "milestone" }), "Set up my semester"] }), _jsxs(Button, { className: "text-(--ui-text-secondary)", onClick: () => navigate(`${SETTINGS_ROUTE}?tab=connections`), size: "sm", variant: "ghost", children: [_jsx(Codicon, { name: "plug" }), "Connect school accounts first"] })] })] }) }));
    }
    const greeting = now.getHours() < 12 ? 'morning' : now.getHours() < 18 ? 'afternoon' : 'evening';
    const dateLabel = now.toLocaleDateString(undefined, { day: 'numeric', month: 'short', weekday: 'long' });
    return (_jsx("main", { className: "h-full min-h-0 overflow-y-auto bg-(--ui-editor-surface-background)", children: _jsxs("div", { className: "mx-auto flex w-full max-w-[1180px] flex-col px-5 pb-7 pt-5 sm:px-7", children: [_jsxs("header", { className: "flex flex-col gap-4 border-b border-(--ui-stroke-quaternary) pb-5 sm:flex-row sm:items-end sm:justify-between", children: [_jsxs("div", { className: "min-w-0", children: [_jsxs("p", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.1em] text-(--ui-text-tertiary)", children: ["Today \u00B7 ", dateLabel] }), _jsxs("h1", { className: "mt-1.5 text-2xl font-semibold tracking-[-0.03em] sm:text-3xl", children: ["Good ", greeting, ", ", graph.student?.name?.trim() || 'there'] }), _jsxs("p", { className: "mt-1.5 text-xs text-(--ui-text-secondary)", children: [formatDuration(free), " free \u00B7 ", needsYou, " item", needsYou === 1 ? '' : 's', " need you \u00B7 ", overdue.length, ' ', "overdue"] })] }), _jsxs("div", { className: "flex shrink-0 items-center gap-3", children: [_jsx("span", { className: "text-[0.6875rem] tabular-nums text-(--ui-text-tertiary)", children: freshness }), _jsxs(Button, { onClick: startSchoolSync, size: "sm", variant: "outline", children: [_jsx(Codicon, { name: "sync" }), "Sync school"] })] })] }), _jsxs("div", { className: "mt-5 grid gap-4 lg:grid-cols-[minmax(0,1.55fr)_minmax(300px,0.9fr)] lg:items-start", children: [_jsxs("div", { className: "min-w-0 space-y-4", children: [_jsx("section", { className: "min-w-0 rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) p-5", children: _jsxs("div", { className: "flex flex-col gap-4 sm:flex-row sm:items-center", children: [_jsx("span", { className: "grid size-10 shrink-0 place-items-center rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-quaternary) text-(--ui-text-secondary)", children: _jsx(Codicon, { name: "target", size: "1.05rem" }) }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("p", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--ui-text-tertiary)", children: "Next action" }), _jsx("h2", { className: "mt-1 text-lg font-semibold tracking-[-0.015em]", children: nextAction?.object.title ?? 'You are clear for the moment' }), _jsx("p", { className: "mt-1 text-xs leading-relaxed text-(--ui-text-secondary)", children: nextAction?.reason ?? 'No urgent deadline is competing for your attention.' })] }), nextAction && (_jsxs(Button, { className: "shrink-0 self-start sm:self-auto", onClick: startNextAction, size: "lg", children: [_jsx(Codicon, { name: "play" }), nextActionLabel(nextAction.object)] }))] }) }), _jsxs("section", { className: "min-w-0 rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated)", children: [_jsxs("div", { className: "flex items-center justify-between gap-4 border-b border-(--ui-stroke-quaternary) px-5 py-4", children: [_jsxs("div", { children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Codicon, { className: "text-(--ui-text-tertiary)", name: "calendar", size: "0.9rem" }), _jsx("h2", { className: "text-xs font-semibold uppercase tracking-[0.08em] text-(--ui-text-secondary)", children: "Today" })] }), _jsxs("p", { className: "mt-1 text-[0.6875rem] text-(--ui-text-tertiary)", children: [timedPlan.length, " timed \u00B7 ", flexiblePlan.length, " flexible"] })] }), _jsxs(Button, { onClick: () => navigate(CALENDAR_ROUTE), size: "sm", variant: "ghost", children: ["Open calendar", _jsx(Codicon, { name: "arrow-right" })] })] }), _jsxs("div", { className: "px-5 py-4", children: [_jsxs("div", { children: [_jsxs("div", { className: "flex items-center justify-between text-[0.625rem] font-medium tabular-nums text-(--ui-text-quaternary)", children: [_jsx("span", { children: "8 AM" }), _jsx("span", { children: "Day runway" }), _jsx("span", { children: "10 PM" })] }), _jsxs("div", { "aria-label": "Day runway from 8 AM to 10 PM", className: "relative mt-2 h-2.5 overflow-hidden rounded-full border border-(--ui-stroke-tertiary) bg-(--ui-bg-quaternary)", children: [openWindows.map(range => (_jsx("span", { className: "absolute inset-y-0 bg-(--ui-bg-elevated)", style: {
                                                                        left: `${runwayPercent(range.start)}%`,
                                                                        width: `${runwayPercent(range.end) - runwayPercent(range.start)}%`
                                                                    }, title: `Open ${formatMinuteOfDay(range.start)}–${formatMinuteOfDay(range.end)}` }, `runway-open:${range.start}:${range.end}`))), busyRanges.map(range => (_jsx("span", { className: "absolute inset-y-0 bg-(--ui-text-quaternary)", style: {
                                                                        left: `${runwayPercent(range.start)}%`,
                                                                        width: `${runwayPercent(range.end) - runwayPercent(range.start)}%`
                                                                    }, title: `Occupied ${formatMinuteOfDay(range.start)}–${formatMinuteOfDay(range.end)}` }, `runway-busy:${range.start}:${range.end}`))), currentTimeIsOnRunway && (_jsx("span", { "aria-label": `Current time ${formatMinuteOfDay(currentMinutes)}`, className: "absolute -inset-y-px z-10 w-px bg-(--theme-primary)", style: { left: `${runwayPercent(currentMinutes)}%` }, title: `Now · ${formatMinuteOfDay(currentMinutes)}` }))] })] }), timeline.length === 0 ? (_jsx(EmptyCopy, { children: "Your day is open. Add a study block when you know what deserves the time." })) : (_jsx("div", { className: "relative ml-1 mt-5 border-l border-(--ui-stroke-tertiary)", children: timeline.map(entry => entry.kind === 'window' ? (_jsxs("div", { className: "relative grid grid-cols-[5rem_minmax(0,1fr)] gap-3 py-2.5 pl-4", children: [_jsx("span", { className: "absolute -left-1 top-[1.05rem] size-2 rounded-full border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated)" }), _jsx("span", { className: "text-[0.6875rem] font-medium tabular-nums text-(--ui-text-quaternary)", children: formatMinuteOfDay(entry.range.start) }), _jsxs("div", { className: "min-w-0 rounded-lg border border-dashed border-(--ui-stroke-tertiary) px-3 py-2", children: [_jsxs("p", { className: "text-xs font-medium text-(--ui-text-secondary)", children: ["Open for ", formatDuration(entry.range.end - entry.range.start)] }), _jsxs("p", { className: "mt-0.5 text-[0.6875rem] tabular-nums text-(--ui-text-tertiary)", children: [formatMinuteOfDay(entry.range.start), "\u2013", formatMinuteOfDay(entry.range.end)] })] })] }, `window:${entry.range.start}:${entry.range.end}`)) : (_jsxs("div", { className: "relative grid grid-cols-[5rem_minmax(0,1fr)] gap-3 py-2.5 pl-4", children: [_jsx("span", { className: "absolute -left-1 top-[1.05rem] size-2 rounded-full border border-(--ui-stroke-tertiary) bg-(--ui-text-tertiary)" }), _jsx("span", { className: "text-[0.6875rem] font-medium tabular-nums text-(--ui-text-secondary)", children: entry.item.time ? formatTime(entry.item.time) : formatMinuteOfDay(entry.item.sortMinutes) }), _jsxs("div", { className: "min-w-0", children: [_jsx("p", { className: "truncate text-xs font-medium", children: entry.item.title }), _jsx("p", { className: "mt-0.5 truncate text-[0.6875rem] capitalize text-(--ui-text-tertiary)", children: [
                                                                            entry.item.kind,
                                                                            entry.item.subtitle,
                                                                            entry.item.durationMinutes ? formatDuration(entry.item.durationMinutes) : undefined
                                                                        ]
                                                                            .filter(Boolean)
                                                                            .join(' · ') })] })] }, entry.item.id))) })), flexiblePlan.length > 0 && (_jsxs("div", { className: "mt-5 border-t border-(--ui-stroke-quaternary) pt-4", children: [_jsx("h3", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-(--ui-text-tertiary)", children: "Flexible" }), _jsx("div", { className: "mt-2 divide-y divide-(--ui-stroke-quaternary)", children: flexiblePlan.map(item => (_jsxs("div", { className: "flex items-start gap-3 py-2.5 first:pt-0 last:pb-0", children: [_jsx("span", { className: "mt-1.5 size-1.5 shrink-0 rounded-full bg-(--ui-text-quaternary)" }), _jsxs("div", { className: "min-w-0", children: [_jsx("p", { className: "truncate text-xs font-medium", children: item.title }), _jsx("p", { className: "mt-0.5 truncate text-[0.6875rem] capitalize text-(--ui-text-tertiary)", children: [item.kind, item.subtitle].filter(Boolean).join(' · ') })] })] }, item.id))) })] }))] })] })] }), _jsxs("aside", { className: "min-w-0 space-y-4", children: [_jsxs("section", { className: "min-w-0 rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) p-4", children: [_jsxs("div", { className: "mb-3 flex items-center justify-between gap-3", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Codicon, { className: "text-(--ui-text-tertiary)", name: "warning", size: "0.9rem" }), _jsx("h2", { className: "text-xs font-semibold uppercase tracking-[0.08em] text-(--ui-text-secondary)", children: "Needs attention" })] }), _jsx("span", { className: "text-[0.6875rem] tabular-nums text-(--ui-text-tertiary)", children: attentionItems.length })] }), attentionItems.length === 0 ? (_jsx(EmptyCopy, { children: "Nothing waiting for you." })) : (_jsx("div", { className: "divide-y divide-(--ui-stroke-tertiary)", children: attentionItems.map(item => {
                                                const opensCalendar = DUE_TYPES.has(item.object.type) && Boolean(item.object.date);
                                                const content = (_jsxs(_Fragment, { children: [_jsxs("span", { className: "min-w-0", children: [_jsx("span", { className: "block truncate text-xs font-medium", children: item.object.title }), _jsx("span", { className: "mt-0.5 block truncate text-[0.6875rem] capitalize text-(--ui-text-tertiary)", children: [item.object.type, courseTitle(graph, item.object.course)].filter(Boolean).join(' · ') })] }), _jsx("span", { className: cn('shrink-0 text-[0.6875rem] font-medium tabular-nums', item.bucket === 'overdue'
                                                                ? 'text-(--theme-primary)'
                                                                : 'text-(--ui-text-secondary)'), children: item.bucket === 'undated' ? 'Message' : relativeDate(item.object.date, now) })] }));
                                                return opensCalendar ? (_jsx("button", { className: "group flex w-full items-start justify-between gap-3 py-2.5 text-left first:pt-0 last:pb-0 hover:text-(--ui-text-primary)", onClick: () => navigate(CALENDAR_ROUTE), type: "button", children: content }, item.object.id)) : (_jsx("div", { className: "flex items-start justify-between gap-3 py-2.5 first:pt-0 last:pb-0", children: content }, item.object.id));
                                            }) }))] }), _jsxs("section", { className: "min-w-0 rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) p-4", children: [_jsxs("div", { className: "mb-3 flex items-center justify-between gap-3", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Codicon, { className: "text-(--ui-text-tertiary)", name: "history", size: "0.9rem" }), _jsx("h2", { className: "text-xs font-semibold uppercase tracking-[0.08em] text-(--ui-text-secondary)", children: "Since yesterday" })] }), _jsx(Button, { onClick: () => navigate(LEDGER_ROUTE), size: "sm", variant: "ghost", children: "Full history" })] }), orderedChanges.length === 0 ? (_jsx(EmptyCopy, { children: "Nothing new." })) : (_jsx("div", { className: "divide-y divide-(--ui-stroke-tertiary)", children: orderedChanges.slice(0, 3).map(change => (_jsxs("div", { className: "flex gap-2.5 py-2.5 first:pt-0 last:pb-0", children: [_jsx("span", { className: cn('mt-1.5 size-1.5 shrink-0 rounded-full', changeIsTrusted(change) ? 'bg-(--ui-text-secondary)' : 'bg-(--ui-text-quaternary)') }), _jsxs("div", { className: "min-w-0", children: [_jsx("p", { className: "text-xs leading-relaxed text-(--ui-text-primary)", children: change.summary }), changeIsTrusted(change) && (_jsx("p", { className: "mt-1 text-[0.625rem] font-medium uppercase tracking-[0.07em] text-(--ui-text-tertiary)", children: change.kind === 'date-changed' ? 'Date changed' : 'Instructor stated' }))] })] }, `${change.objectId}:${change.ts}`))) })), orderedChanges.length > 3 && (_jsxs("p", { className: "mt-3 text-[0.6875rem] text-(--ui-text-quaternary)", children: [orderedChanges.length - 3, " more in history"] }))] }), _jsxs("section", { className: "min-w-0 rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) p-4", children: [_jsxs("div", { className: "mb-3 flex items-center justify-between gap-3", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Codicon, { className: "text-(--ui-text-tertiary)", name: "plug", size: "0.9rem" }), _jsx("h2", { className: "text-xs font-semibold uppercase tracking-[0.08em] text-(--ui-text-secondary)", children: "School connections" })] }), _jsx(Button, { onClick: () => navigate(`${SETTINGS_ROUTE}?tab=connections`), size: "sm", variant: "ghost", children: "Manage" })] }), portals.length === 0 ? (_jsx(EmptyCopy, { children: "No school accounts connected." })) : (_jsx("div", { className: "divide-y divide-(--ui-stroke-quaternary)", children: portals.map(portal => {
                                                const signedIn = portalStatus[portal.origin] === true;
                                                const known = portal.origin in portalStatus;
                                                return (_jsxs("div", { className: "flex items-center justify-between gap-3 py-2 first:pt-0", children: [_jsxs("span", { className: "flex min-w-0 items-center gap-2", children: [_jsx("span", { className: cn('size-1.5 shrink-0 rounded-full', signedIn
                                                                        ? 'bg-emerald-500'
                                                                        : known
                                                                            ? 'bg-amber-500'
                                                                            : 'bg-(--ui-text-quaternary)') }), _jsx("span", { className: "truncate text-xs font-medium", children: portal.name })] }), _jsx("span", { className: "shrink-0 text-[0.6875rem] text-(--ui-text-tertiary)", children: signedIn ? 'Signed in' : known ? 'Needs login' : 'Checking' })] }, portal.id));
                                            }) })), _jsxs("label", { className: "mt-3 flex items-center justify-between gap-3 border-t border-(--ui-stroke-quaternary) pt-3 text-xs text-(--ui-text-secondary)", children: ["Sync reminder", _jsx("select", { className: "rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-bg-quaternary) px-2 py-1 text-xs text-(--ui-text-primary) outline-none focus-visible:ring-2 focus-visible:ring-(--ui-text-quaternary)", onChange: event => changeCadence(event.target.value), value: cadence, children: ['off', 'daily', 'twice'].map(option => (_jsx("option", { value: option, children: SYNC_CADENCE_LABEL[option] }, option))) })] })] })] })] }), _jsxs("button", { className: "mt-5 flex w-full items-center justify-center gap-2 px-4 py-2 text-center text-[0.6875rem] text-(--ui-text-quaternary) transition-colors hover:text-(--ui-text-secondary)", onClick: () => navigate(LEDGER_ROUTE), type: "button", children: [_jsx(Codicon, { className: "shrink-0", name: "shield", size: "0.8rem" }), _jsxs("span", { children: ["Nemesis read ", portals.length, " account", portals.length === 1 ? '' : 's', " today \u00B7 sent nothing"] })] })] }) }));
}
