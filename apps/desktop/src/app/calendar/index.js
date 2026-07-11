import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// Calendar — assignment due dates, exams, and rotation dates for a pharmacy student.
// Events come from calendar.json (see model.ts): Nemesis can write to it directly as it
// reads a student's school accounts, and the student can add/edit/delete their own entries
// by hand. Agent-written events render read-only here — see model.ts's saveCalendarEvents
// for why a manual save can never clobber a concurrent agent write.
import { IconChevronLeft, IconChevronRight, IconPlus, IconTrash } from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Codicon } from '@/components/ui/codicon';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { dateKey, eventsByDate, freshId, loadCalendarState, monthGrid, parseDateKey, saveCalendarEvents, upcomingEvents } from './model';
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const AGENDA_WINDOW_DAYS = 30;
const MAX_CHIPS_PER_DAY = 3;
const KIND_ORDER = ['assignment', 'exam', 'rotation', 'class', 'other'];
const KIND_META = {
    assignment: { chip: 'bg-(--ui-blue)/15 text-(--ui-blue)', dot: 'bg-(--ui-blue)', label: 'Assignment' },
    class: { chip: 'bg-(--ui-bg-quaternary) text-muted-foreground', dot: 'bg-(--ui-text-tertiary)', label: 'Class' },
    exam: { chip: 'bg-(--theme-primary)/15 text-(--theme-primary)', dot: 'bg-(--theme-primary)', label: 'Exam' },
    other: { chip: 'bg-(--ui-cyan)/15 text-(--ui-cyan)', dot: 'bg-(--ui-cyan)', label: 'Other' },
    rotation: { chip: 'bg-(--ui-purple)/15 text-(--ui-purple)', dot: 'bg-(--ui-purple)', label: 'Rotation' }
};
function monthLabel(year, month) {
    return new Date(year, month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}
function formatEventDate(key) {
    return parseDateKey(key).toLocaleDateString(undefined, { day: 'numeric', month: 'short', weekday: 'short' });
}
/** "14:30" → "2:30 PM". Any other shape (an agent wrote something the time input can't
 *  parse) renders as-is rather than throwing — display should degrade, not crash. */
function formatEventTime(time) {
    const [hourText, minuteText] = time.split(':');
    const hour = Number(hourText);
    const minute = Number(minuteText);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
        return time;
    }
    return new Date(2000, 0, 1, hour, minute).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function emptyFormValues(date) {
    return { date, kind: 'assignment', title: '' };
}
export function CalendarView() {
    const [events, setEvents] = useState([]);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState(null);
    const [saving, setSaving] = useState(false);
    const [cursor, setCursor] = useState(() => {
        const now = new Date();
        return { month: now.getMonth(), year: now.getFullYear() };
    });
    const [dialog, setDialog] = useState(null);
    const refresh = useCallback(() => {
        void loadCalendarState().then(state => {
            setEvents(state.events);
            setLoaded(true);
        });
    }, []);
    useEffect(() => {
        refresh();
    }, [refresh]);
    // Nemesis may have just written calendar.json in another process (e.g. after a "pull my
    // due dates" run) — re-read whenever the window regains focus, same pattern the sidebar
    // uses to pick up out-of-band project changes.
    useEffect(() => {
        window.addEventListener('focus', refresh);
        return () => window.removeEventListener('focus', refresh);
    }, [refresh]);
    // `today` is deliberately recomputed every render (not memoized) so the "today" cell
    // and the agenda window stay correct if the app is left open across midnight — the
    // window-focus refresh above already forces a re-render on every return to the app.
    // The grid/agenda derivations are cheap (a 42-cell grid, a small filter+sort), so
    // there's no perf reason to memo them against a value that changes every render anyway.
    const today = new Date();
    const grid = monthGrid(cursor.year, cursor.month, today);
    const byDate = eventsByDate(events);
    const upcoming = upcomingEvents(events, today, AGENDA_WINDOW_DAYS);
    const goToMonth = (delta) => {
        setCursor(current => {
            const next = new Date(current.year, current.month + delta, 1);
            return { month: next.getMonth(), year: next.getFullYear() };
        });
    };
    const openEvent = (event) => {
        setDialog(event.source === 'agent' ? { event, mode: 'view' } : { event, mode: 'edit' });
    };
    const openAdd = (date) => setDialog({ date, mode: 'add' });
    const closeDialog = () => {
        setDialog(null);
        setError(null);
    };
    const persist = async (nextEvents) => {
        setSaving(true);
        setError(null);
        try {
            const state = await saveCalendarEvents(nextEvents);
            setEvents(state.events);
            setDialog(null);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : 'Could not save the calendar.');
        }
        finally {
            setSaving(false);
        }
    };
    const handleSave = (input) => {
        if (dialog && dialog.mode === 'edit') {
            void persist(events.map(event => (event.id === dialog.event.id ? { ...dialog.event, ...input } : event)));
            return;
        }
        const created = { id: freshId('event'), source: 'manual', ...input };
        void persist([...events, created]);
    };
    const handleDelete = () => {
        if (!dialog || dialog.mode !== 'edit') {
            return;
        }
        void persist(events.filter(event => event.id !== dialog.event.id));
    };
    return (_jsxs("div", { className: "flex h-full min-h-0 flex-col overflow-y-auto", children: [_jsxs("header", { className: "flex shrink-0 flex-wrap items-start justify-between gap-3 px-6 pb-3 pt-5", children: [_jsxs("div", { children: [_jsx("p", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--theme-primary)", children: "Schedule" }), _jsx("h1", { className: "mt-1 text-2xl font-semibold tracking-[-0.025em]", children: "Calendar" }), _jsx("p", { className: "mt-1 max-w-lg text-xs leading-relaxed text-muted-foreground", children: "Assignment due dates, exams, and rotation dates in one place. Nemesis can add these as it reads your school accounts \u2014 add or fix anything yourself too." })] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsxs("div", { className: "flex items-center gap-1 rounded-md border border-border", children: [_jsx(Button, { "aria-label": "Previous month", onClick: () => goToMonth(-1), size: "icon-xs", variant: "ghost", children: _jsx(IconChevronLeft, { size: 14 }) }), _jsx("span", { className: "min-w-32 px-1 text-center text-xs font-medium tabular-nums", children: monthLabel(cursor.year, cursor.month) }), _jsx(Button, { "aria-label": "Next month", onClick: () => goToMonth(1), size: "icon-xs", variant: "ghost", children: _jsx(IconChevronRight, { size: 14 }) })] }), _jsxs(Button, { onClick: () => openAdd(dateKey(today)), size: "sm", children: [_jsx(IconPlus, { size: 14 }), "Add event"] })] })] }), _jsxs("div", { className: "grid flex-1 grid-cols-1 gap-4 px-6 pb-8 lg:grid-cols-[minmax(0,1fr)_20rem]", children: [_jsx(MonthGrid, { days: grid, eventsByDay: byDate, onAddOnDate: openAdd, onOpenEvent: openEvent }), _jsx(Agenda, { events: upcoming, hasAnyEvents: events.length > 0, loaded: loaded, onOpenEvent: openEvent })] }), dialog && (_jsx(EventDialog, { dialog: dialog, error: error, onClose: closeDialog, onDelete: handleDelete, onSave: handleSave, saving: saving }))] }));
}
function MonthGrid({ days, eventsByDay, onAddOnDate, onOpenEvent }) {
    return (_jsxs("div", { className: "flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-card", children: [_jsx("div", { className: "grid shrink-0 grid-cols-7 border-b border-border text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-muted-foreground", children: WEEKDAY_LABELS.map(label => (_jsx("div", { className: "px-2 py-2 text-center", children: label }, label))) }), _jsx("div", { className: "grid flex-1 grid-cols-7 grid-rows-6", children: days.map(day => (_jsx(DayCell, { day: day, events: eventsByDay.get(day.key) ?? [], onAdd: onAddOnDate, onOpenEvent: onOpenEvent }, day.key))) })] }));
}
function DayCell({ day, events, onAdd, onOpenEvent }) {
    const visible = events.slice(0, MAX_CHIPS_PER_DAY);
    const overflow = events.length - visible.length;
    return (_jsxs("div", { className: cn('group flex min-h-20 flex-col gap-1 border-b border-r border-border p-1.5 [&:nth-child(7n)]:border-r-0', !day.inMonth && 'bg-(--ui-bg-quaternary)/40'), children: [_jsxs("div", { className: "flex shrink-0 items-center justify-between", children: [_jsx("span", { className: cn('grid size-5 place-items-center rounded-full text-[0.6875rem] font-medium tabular-nums', day.isToday ? 'bg-(--theme-primary) text-primary-foreground' : !day.inMonth && 'text-(--ui-text-quaternary)'), children: day.date.getDate() }), _jsx(Button, { "aria-label": `Add event on ${formatEventDate(day.key)}`, className: "opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100", onClick: () => onAdd(day.key), size: "icon-xs", variant: "ghost", children: _jsx(Codicon, { name: "add", size: "0.75rem" }) })] }), _jsxs("div", { className: "flex min-h-0 flex-1 flex-col gap-0.5", children: [visible.map(event => (_jsx("button", { className: cn('truncate rounded px-1 py-0.5 text-left text-[0.625rem] font-medium leading-tight', KIND_META[event.kind].chip), onClick: () => onOpenEvent(event), title: event.title, type: "button", children: event.title }, event.id))), overflow > 0 && (_jsxs(Popover, { children: [_jsx(PopoverTrigger, { asChild: true, children: _jsxs("button", { className: "truncate rounded px-1 py-0.5 text-left text-[0.625rem] font-medium text-muted-foreground hover:text-foreground", type: "button", children: ["+", overflow, " more"] }) }), _jsx(PopoverContent, { align: "start", className: "w-56 p-1.5", children: _jsx("div", { className: "flex flex-col gap-0.5", children: events.map(event => (_jsx("button", { className: cn('truncate rounded px-1.5 py-1 text-left text-xs font-medium', KIND_META[event.kind].chip), onClick: () => onOpenEvent(event), type: "button", children: event.title }, event.id))) }) })] }))] })] }));
}
function Agenda({ events, hasAnyEvents, loaded, onOpenEvent }) {
    return (_jsxs("div", { className: "flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-card", children: [_jsxs("div", { className: "shrink-0 border-b border-border px-4 py-3", children: [_jsx("p", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-muted-foreground", children: "Agenda" }), _jsx("h2", { className: "mt-0.5 text-sm font-semibold tracking-tight", children: "Next 30 days" })] }), _jsx("div", { className: "min-h-0 flex-1 overflow-y-auto p-2", children: !loaded ? (_jsx("div", { className: "grid min-h-32 place-items-center text-xs text-muted-foreground", children: "Loading\u2026" })) : events.length === 0 ? (_jsx(EmptyState, { className: "min-h-40", description: hasAnyEvents
                        ? 'Nothing due in the next 30 days.'
                        : 'Ask Nemesis to pull your due dates from Blackboard and Outlook, or add one.', title: hasAnyEvents ? 'All clear' : 'No deadlines yet' })) : (_jsx("div", { className: "flex flex-col gap-1", children: events.map(event => (_jsxs("button", { className: "flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-(--ui-control-hover-background)", onClick: () => onOpenEvent(event), type: "button", children: [_jsx("span", { className: cn('mt-1 size-1.5 shrink-0 rounded-full', KIND_META[event.kind].dot) }), _jsxs("span", { className: "min-w-0 flex-1", children: [_jsx("span", { className: "block truncate text-xs font-medium", children: event.title }), _jsxs("span", { className: "block text-[0.6875rem] text-muted-foreground", children: [formatEventDate(event.date), event.time ? ` · ${formatEventTime(event.time)}` : '', event.course ? ` · ${event.course}` : ''] })] })] }, event.id))) })) })] }));
}
function EventDialog({ dialog, error, onClose, onDelete, onSave, saving }) {
    if (dialog.mode === 'view') {
        return _jsx(EventViewDialog, { event: dialog.event, onClose: onClose });
    }
    return (_jsx(EventFormDialog, { error: error, initial: dialog.mode === 'add' ? emptyFormValues(dialog.date) : dialog.event, mode: dialog.mode, onClose: onClose, onDelete: onDelete, onSave: onSave, saving: saving }));
}
function ViewRow({ label, value }) {
    return (_jsxs("div", { className: "flex items-baseline gap-2", children: [_jsx("span", { className: "w-14 shrink-0 text-[0.6875rem] font-semibold uppercase tracking-[0.09em] text-muted-foreground", children: label }), _jsx("span", { className: "min-w-0 flex-1 text-foreground", children: value })] }));
}
function EventViewDialog({ event, onClose }) {
    return (_jsx(Dialog, { onOpenChange: open => !open && onClose(), open: true, children: _jsxs(DialogContent, { className: "sm:max-w-md", children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: event.title }), _jsx(DialogDescription, { children: "Added by Nemesis. Ask it to change this, or add your own event alongside it." })] }), _jsxs("div", { className: "flex flex-col gap-2 text-xs", children: [_jsx(ViewRow, { label: "When", value: `${formatEventDate(event.date)}${event.time ? ` · ${formatEventTime(event.time)}` : ''}` }), _jsx(ViewRow, { label: "Type", value: KIND_META[event.kind].label }), event.course && _jsx(ViewRow, { label: "Course", value: event.course }), event.note && _jsx(ViewRow, { label: "Notes", value: event.note })] }), _jsx(DialogFooter, { children: _jsx(Button, { onClick: onClose, variant: "outline", children: "Close" }) })] }) }));
}
function EventFormDialog({ error, initial, mode, onClose, onDelete, onSave, saving }) {
    const [title, setTitle] = useState(initial.title);
    const [date, setDate] = useState(initial.date);
    const [time, setTime] = useState(initial.time ?? '');
    const [kind, setKind] = useState(initial.kind);
    const [course, setCourse] = useState(initial.course ?? '');
    const [note, setNote] = useState(initial.note ?? '');
    const [armDelete, setArmDelete] = useState(false);
    const submit = () => {
        if (!title.trim() || !date) {
            return;
        }
        onSave({
            course: course.trim() || undefined,
            date,
            kind,
            note: note.trim() || undefined,
            time: time.trim() || undefined,
            title: title.trim()
        });
    };
    return (_jsx(Dialog, { onOpenChange: open => !open && onClose(), open: true, children: _jsxs(DialogContent, { banner: error || undefined, bannerTone: "error", className: "sm:max-w-md", children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: mode === 'edit' ? 'Edit event' : 'Add event' }), _jsx(DialogDescription, { children: "Assignment, exam, rotation, class \u2014 anything with a due date." })] }), _jsxs("div", { className: "flex flex-col gap-3", children: [_jsx(Input, { autoFocus: true, onChange: event => setTitle(event.target.value), placeholder: "Title", value: title }), _jsxs("div", { className: "flex gap-2", children: [_jsx(Input, { className: "flex-1", onChange: event => setDate(event.target.value), type: "date", value: date }), _jsx(Input, { className: "w-32", onChange: event => setTime(event.target.value), type: "time", value: time })] }), _jsxs(Select, { onValueChange: value => setKind(value), value: kind, children: [_jsx(SelectTrigger, { "aria-label": "Event type", className: "w-full", children: _jsx(SelectValue, {}) }), _jsx(SelectContent, { children: KIND_ORDER.map(option => (_jsxs(SelectItem, { value: option, children: [_jsx("span", { className: cn('size-1.5 rounded-full', KIND_META[option].dot) }), KIND_META[option].label] }, option))) })] }), _jsx(Input, { onChange: event => setCourse(event.target.value), placeholder: "Course (optional)", value: course }), _jsx(Textarea, { className: "min-h-16", onChange: event => setNote(event.target.value), placeholder: "Notes (optional)", value: note })] }), _jsxs(DialogFooter, { className: "flex-wrap gap-2 sm:justify-between", children: [mode === 'edit' ? (_jsxs(Button, { className: cn(armDelete && 'text-destructive'), onBlur: () => setArmDelete(false), onClick: () => (armDelete ? onDelete() : setArmDelete(true)), variant: "outline", children: [_jsx(IconTrash, { size: 13 }), armDelete ? 'Really delete?' : 'Delete'] })) : (_jsx("span", {})), _jsxs("div", { className: "flex gap-2", children: [_jsx(Button, { onClick: onClose, variant: "outline", children: "Cancel" }), _jsx(Button, { disabled: !title.trim() || !date || saving, onClick: submit, children: saving ? 'Saving…' : 'Save' })] })] })] }) }));
}
