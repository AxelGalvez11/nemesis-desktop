// Calendar — assignment due dates, exams, and rotation dates for a pharmacy student.
// Events come from calendar.json (see model.ts): Nemesis can write to it directly as it
// reads a student's school accounts, and the student can add/edit/delete their own entries
// by hand. Agent-written events render read-only here — see model.ts's saveCalendarEvents
// for why a manual save can never clobber a concurrent agent write.
import { IconChevronLeft, IconChevronRight, IconPlus, IconTrash } from '@tabler/icons-react'
import { useCallback, useEffect, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SegmentedControl, type SegmentedControlOption } from '@/components/ui/segmented-control'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { persistString, storedString } from '@/lib/storage'
import { cn } from '@/lib/utils'

import {
  addDays,
  addMonths,
  addWeeks,
  addYears,
  type CalendarEvent,
  type CalendarEventKind,
  dateKey,
  dayEvents,
  eventsByDate,
  freshId,
  loadCalendarState,
  type MonthDay,
  monthGrid,
  parseDateKey,
  saveCalendarEvents,
  startOfWeek,
  upcomingEvents,
  weekGrid
} from './model'

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const AGENDA_WINDOW_DAYS = 30
const MAX_CHIPS_PER_DAY = 3
const KIND_ORDER: CalendarEventKind[] = ['assignment', 'exam', 'rotation', 'class', 'other']

const KIND_META: Record<CalendarEventKind, { chip: string; dot: string; label: string }> = {
  assignment: { chip: 'bg-(--ui-blue)/15 text-(--ui-blue)', dot: 'bg-(--ui-blue)', label: 'Assignment' },
  class: { chip: 'bg-(--ui-bg-quaternary) text-muted-foreground', dot: 'bg-(--ui-text-tertiary)', label: 'Class' },
  exam: { chip: 'bg-(--theme-primary)/15 text-(--theme-primary)', dot: 'bg-(--theme-primary)', label: 'Exam' },
  other: { chip: 'bg-(--ui-cyan)/15 text-(--ui-cyan)', dot: 'bg-(--ui-cyan)', label: 'Other' },
  rotation: { chip: 'bg-(--ui-purple)/15 text-(--ui-purple)', dot: 'bg-(--ui-purple)', label: 'Rotation' }
}

type CalendarViewMode = 'day' | 'week' | 'month' | 'year'

const VIEW_STORAGE_KEY = 'nemesis.calendar.view'

const VIEW_OPTIONS: readonly SegmentedControlOption<CalendarViewMode>[] = [
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'year', label: 'Year' }
]

const VIEW_UNIT_LABEL: Record<CalendarViewMode, string> = { day: 'day', month: 'month', week: 'week', year: 'year' }

function isCalendarViewMode(value: null | string): value is CalendarViewMode {
  return value === 'day' || value === 'week' || value === 'month' || value === 'year'
}

function loadStoredView(): CalendarViewMode {
  const raw = storedString(VIEW_STORAGE_KEY)

  return isCalendarViewMode(raw) ? raw : 'month'
}

type EventFormValues = Omit<CalendarEvent, 'id' | 'source'>

type DialogState =
  | { mode: 'add'; date: string }
  | { mode: 'edit'; event: CalendarEvent }
  | { mode: 'view'; event: CalendarEvent }

function monthLabel(year: number, month: number): string {
  return new Date(year, month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

function formatEventDate(key: string): string {
  return parseDateKey(key).toLocaleDateString(undefined, { day: 'numeric', month: 'short', weekday: 'short' })
}

/** "14:30" → "2:30 PM". Any other shape (an agent wrote something the time input can't
 *  parse) renders as-is rather than throwing — display should degrade, not crash. */
function formatEventTime(time: string): string {
  const [hourText, minuteText] = time.split(':')
  const hour = Number(hourText)
  const minute = Number(minuteText)

  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return time
  }

  return new Date(2000, 0, 1, hour, minute).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** Steps `cursor` by one unit of the active view's granularity — shared by the header's
 *  prev/next arrows (see goStep in CalendarView). */
function stepCursor(cursor: Date, view: CalendarViewMode, delta: number): Date {
  if (view === 'day') {
    return addDays(cursor, delta)
  }

  if (view === 'week') {
    return addWeeks(cursor, delta)
  }

  if (view === 'month') {
    return addMonths(cursor, delta)
  }

  return addYears(cursor, delta)
}

/** The header's center label, formatted to match the active view's granularity — e.g.
 *  "Jul 14 – Jul 20, 2026" for week, "July 2026" for month. */
function viewLabel(view: CalendarViewMode, cursor: Date): string {
  if (view === 'day') {
    return cursor.toLocaleDateString(undefined, { day: 'numeric', month: 'short', weekday: 'short', year: 'numeric' })
  }

  if (view === 'week') {
    const start = startOfWeek(cursor)
    const end = addDays(start, 6)
    const startLabel = start.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
    const endLabel = end.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

    return `${startLabel} – ${endLabel}`
  }

  if (view === 'year') {
    return String(cursor.getFullYear())
  }

  return monthLabel(cursor.getFullYear(), cursor.getMonth())
}

function emptyFormValues(date: string): EventFormValues {
  return { date, kind: 'assignment', title: '' }
}

export function CalendarView() {
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<null | string>(null)
  const [saving, setSaving] = useState(false)

  const [view, setView] = useState<CalendarViewMode>(loadStoredView)
  const [cursor, setCursor] = useState(() => new Date())

  const [dialog, setDialog] = useState<DialogState | null>(null)

  const refresh = useCallback(() => {
    void loadCalendarState().then(state => {
      setEvents(state.events)
      setLoaded(true)
    })
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Nemesis may have just written calendar.json in another process (e.g. after a "pull my
  // due dates" run) — re-read whenever the window regains focus, same pattern the sidebar
  // uses to pick up out-of-band project changes.
  useEffect(() => {
    window.addEventListener('focus', refresh)

    return () => window.removeEventListener('focus', refresh)
  }, [refresh])

  // `today` is deliberately recomputed every render (not memoized) so the "today" cell
  // and the agenda window stay correct if the app is left open across midnight — the
  // window-focus refresh above already forces a re-render on every return to the app.
  // The grid/agenda derivations are cheap (a 42-cell grid, a small filter+sort), so
  // there's no perf reason to memo them against a value that changes every render anyway.
  const today = new Date()
  const grid = monthGrid(cursor.getFullYear(), cursor.getMonth(), today)
  const byDate = eventsByDate(events)
  const upcoming = upcomingEvents(events, today, AGENDA_WINDOW_DAYS)

  const changeView = (next: CalendarViewMode) => {
    setView(next)
    persistString(VIEW_STORAGE_KEY, next)
  }

  const goStep = (delta: number) => {
    setCursor(current => stepCursor(current, view, delta))
  }

  const openMonth = (year: number, month: number) => {
    setCursor(new Date(year, month, 1))
    changeView('month')
  }

  const openEvent = (event: CalendarEvent) => {
    setDialog(event.source === 'agent' ? { event, mode: 'view' } : { event, mode: 'edit' })
  }

  const openAdd = (date: string) => setDialog({ date, mode: 'add' })

  const closeDialog = () => {
    setDialog(null)
    setError(null)
  }

  const persist = async (nextEvents: CalendarEvent[]) => {
    setSaving(true)
    setError(null)

    try {
      const state = await saveCalendarEvents(nextEvents)
      setEvents(state.events)
      setDialog(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the calendar.')
    } finally {
      setSaving(false)
    }
  }

  const handleSave = (input: EventFormValues) => {
    if (dialog && dialog.mode === 'edit') {
      void persist(events.map(event => (event.id === dialog.event.id ? { ...dialog.event, ...input } : event)))

      return
    }

    const created: CalendarEvent = { id: freshId('event'), source: 'manual', ...input }
    void persist([...events, created])
  }

  const handleDelete = () => {
    if (!dialog || dialog.mode !== 'edit') {
      return
    }

    void persist(events.filter(event => event.id !== dialog.event.id))
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <header className="flex shrink-0 flex-wrap items-start justify-between gap-3 px-6 pb-3 pt-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.025em]">Calendar</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl onChange={changeView} options={VIEW_OPTIONS} value={view} />
          <div className="flex items-center gap-1 rounded-md border border-border">
            <Button aria-label={`Previous ${VIEW_UNIT_LABEL[view]}`} onClick={() => goStep(-1)} size="icon-xs" variant="ghost">
              <IconChevronLeft size={14} />
            </Button>
            <span className="min-w-32 px-1 text-center text-xs font-medium tabular-nums">{viewLabel(view, cursor)}</span>
            <Button aria-label={`Next ${VIEW_UNIT_LABEL[view]}`} onClick={() => goStep(1)} size="icon-xs" variant="ghost">
              <IconChevronRight size={14} />
            </Button>
          </div>
          <Button onClick={() => openAdd(dateKey(today))} size="sm">
            <IconPlus size={14} />
            Add event
          </Button>
        </div>
      </header>

      <div className="grid flex-1 grid-cols-1 gap-4 px-6 pb-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        {view === 'day' && (
          <DayPanel date={cursor} events={dayEvents(events, cursor)} onAddOnDate={openAdd} onOpenEvent={openEvent} today={today} />
        )}
        {view === 'week' && (
          <WeekGrid days={weekGrid(cursor, today)} eventsByDay={byDate} onAddOnDate={openAdd} onOpenEvent={openEvent} />
        )}
        {view === 'month' && <MonthGrid days={grid} eventsByDay={byDate} onAddOnDate={openAdd} onOpenEvent={openEvent} />}
        {view === 'year' && <YearGrid eventsByDay={byDate} onSelectMonth={openMonth} today={today} year={cursor.getFullYear()} />}
        <Agenda events={upcoming} hasAnyEvents={events.length > 0} loaded={loaded} onOpenEvent={openEvent} />
      </div>

      {dialog && (
        <EventDialog
          dialog={dialog}
          error={error}
          onClose={closeDialog}
          onDelete={handleDelete}
          onSave={handleSave}
          saving={saving}
        />
      )}
    </div>
  )
}

function MonthGrid({
  days,
  eventsByDay,
  onAddOnDate,
  onOpenEvent
}: {
  days: MonthDay[]
  eventsByDay: Map<string, CalendarEvent[]>
  onAddOnDate: (date: string) => void
  onOpenEvent: (event: CalendarEvent) => void
}) {
  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-card">
      <div className="grid shrink-0 grid-cols-7 border-b border-border text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
        {WEEKDAY_LABELS.map(label => (
          <div className="px-2 py-2 text-center" key={label}>
            {label}
          </div>
        ))}
      </div>
      <div className="grid flex-1 grid-cols-7 grid-rows-6">
        {days.map(day => (
          <DayCell
            day={day}
            events={eventsByDay.get(day.key) ?? []}
            key={day.key}
            onAdd={onAddOnDate}
            onOpenEvent={onOpenEvent}
          />
        ))}
      </div>
    </div>
  )
}

function DayCell({
  day,
  events,
  onAdd,
  onOpenEvent
}: {
  day: MonthDay
  events: CalendarEvent[]
  onAdd: (date: string) => void
  onOpenEvent: (event: CalendarEvent) => void
}) {
  const visible = events.slice(0, MAX_CHIPS_PER_DAY)
  const overflow = events.length - visible.length

  return (
    <div
      className={cn(
        'group flex min-h-20 flex-col gap-1 border-b border-r border-border p-1.5 [&:nth-child(7n)]:border-r-0',
        !day.inMonth && 'bg-(--ui-bg-quaternary)/40'
      )}
    >
      <div className="flex shrink-0 items-center justify-between">
        <span
          className={cn(
            'grid size-5 place-items-center rounded-full text-[0.6875rem] font-medium tabular-nums',
            day.isToday ? 'bg-(--theme-primary) text-primary-foreground' : !day.inMonth && 'text-(--ui-text-quaternary)'
          )}
        >
          {day.date.getDate()}
        </span>
        <Button
          aria-label={`Add event on ${formatEventDate(day.key)}`}
          className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          onClick={() => onAdd(day.key)}
          size="icon-xs"
          variant="ghost"
        >
          <Codicon name="add" size="0.75rem" />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5">
        {visible.map(event => (
          <button
            className={cn(
              'truncate rounded px-1 py-0.5 text-left text-[0.625rem] font-medium leading-tight',
              KIND_META[event.kind].chip
            )}
            key={event.id}
            onClick={() => onOpenEvent(event)}
            title={event.title}
            type="button"
          >
            {event.title}
          </button>
        ))}
        {overflow > 0 && (
          <Popover>
            <PopoverTrigger asChild>
              <button
                className="truncate rounded px-1 py-0.5 text-left text-[0.625rem] font-medium text-muted-foreground hover:text-foreground"
                type="button"
              >
                +{overflow} more
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-56 p-1.5">
              <div className="flex flex-col gap-0.5">
                {events.map(event => (
                  <button
                    className={cn('truncate rounded px-1.5 py-1 text-left text-xs font-medium', KIND_META[event.kind].chip)}
                    key={event.id}
                    onClick={() => onOpenEvent(event)}
                    type="button"
                  >
                    {event.title}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        )}
      </div>
    </div>
  )
}

function WeekGrid({
  days,
  eventsByDay,
  onAddOnDate,
  onOpenEvent
}: {
  days: MonthDay[]
  eventsByDay: Map<string, CalendarEvent[]>
  onAddOnDate: (date: string) => void
  onOpenEvent: (event: CalendarEvent) => void
}) {
  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-card">
      <div className="grid shrink-0 grid-cols-7 border-b border-border text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
        {WEEKDAY_LABELS.map(label => (
          <div className="px-2 py-2 text-center" key={label}>
            {label}
          </div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7">
        {days.map(day => (
          <WeekDayColumn
            day={day}
            events={eventsByDay.get(day.key) ?? []}
            key={day.key}
            onAdd={onAddOnDate}
            onOpenEvent={onOpenEvent}
          />
        ))}
      </div>
    </div>
  )
}

function WeekDayColumn({
  day,
  events,
  onAdd,
  onOpenEvent
}: {
  day: MonthDay
  events: CalendarEvent[]
  onAdd: (date: string) => void
  onOpenEvent: (event: CalendarEvent) => void
}) {
  return (
    <div className="group flex min-h-0 flex-col gap-1.5 border-r border-border p-1.5 last:border-r-0">
      <div className="flex shrink-0 items-center justify-between">
        <span
          className={cn(
            'grid size-5 place-items-center rounded-full text-[0.6875rem] font-medium tabular-nums',
            day.isToday && 'bg-(--theme-primary) text-primary-foreground'
          )}
        >
          {day.date.getDate()}
        </span>
        <Button
          aria-label={`Add event on ${formatEventDate(day.key)}`}
          className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          onClick={() => onAdd(day.key)}
          size="icon-xs"
          variant="ghost"
        >
          <Codicon name="add" size="0.75rem" />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        {events.length === 0 ? (
          <p className="px-1 pt-1 text-[0.625rem] text-(--ui-text-quaternary)">No events</p>
        ) : (
          events.map(event => (
            <button
              className={cn(
                'truncate rounded px-1.5 py-1 text-left text-[0.6875rem] font-medium leading-tight',
                KIND_META[event.kind].chip
              )}
              key={event.id}
              onClick={() => onOpenEvent(event)}
              title={event.title}
              type="button"
            >
              {event.time && <span className="tabular-nums opacity-70">{formatEventTime(event.time)} · </span>}
              {event.title}
            </button>
          ))
        )}
      </div>
    </div>
  )
}

function DayPanel({
  date,
  events,
  onAddOnDate,
  onOpenEvent,
  today
}: {
  date: Date
  events: CalendarEvent[]
  onAddOnDate: (date: string) => void
  onOpenEvent: (event: CalendarEvent) => void
  today: Date
}) {
  const isToday = dateKey(date) === dateKey(today)

  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex shrink-0 items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div>
          <p className="text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
            {date.toLocaleDateString(undefined, { weekday: 'long' })}
          </p>
          <div className="mt-0.5 flex items-center gap-2">
            <h2 className="text-2xl font-semibold tracking-tight">
              {date.toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}
            </h2>
            {isToday && <Badge>Today</Badge>}
          </div>
        </div>
        <Button
          aria-label={`Add event on ${formatEventDate(dateKey(date))}`}
          onClick={() => onAddOnDate(dateKey(date))}
          size="icon-xs"
          variant="ghost"
        >
          <Codicon name="add" size="0.875rem" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {events.length === 0 ? (
          <EmptyState className="min-h-40" description="Nothing due today." title="All clear" />
        ) : (
          <div className="flex flex-col gap-1">
            {events.map(event => (
              <button
                className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-(--ui-control-hover-background)"
                key={event.id}
                onClick={() => onOpenEvent(event)}
                type="button"
              >
                <span className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', KIND_META[event.kind].dot)} />
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium">{event.title}</span>
                  <span className="block text-[0.6875rem] text-muted-foreground">
                    {event.time ? formatEventTime(event.time) : 'No time set'}
                    {event.course ? ` · ${event.course}` : ''}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function YearGrid({
  eventsByDay,
  onSelectMonth,
  today,
  year
}: {
  eventsByDay: Map<string, CalendarEvent[]>
  onSelectMonth: (year: number, month: number) => void
  today: Date
  year: number
}) {
  return (
    <div className="grid min-h-0 grid-cols-2 gap-3 overflow-y-auto rounded-2xl border border-border bg-card p-3 sm:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: 12 }, (_, month) => (
        <MiniMonth
          days={monthGrid(year, month, today)}
          eventsByDay={eventsByDay}
          key={month}
          month={month}
          onSelectMonth={onSelectMonth}
          year={year}
        />
      ))}
    </div>
  )
}

function MiniMonth({
  days,
  eventsByDay,
  month,
  onSelectMonth,
  year
}: {
  days: MonthDay[]
  eventsByDay: Map<string, CalendarEvent[]>
  month: number
  onSelectMonth: (year: number, month: number) => void
  year: number
}) {
  return (
    <button
      className="flex flex-col gap-1.5 rounded-xl border border-border p-2 text-left transition-colors hover:border-(--theme-primary)/60 hover:bg-(--ui-control-hover-background)"
      onClick={() => onSelectMonth(year, month)}
      type="button"
    >
      <p className="px-0.5 text-[0.6875rem] font-semibold">
        {new Date(year, month, 1).toLocaleDateString(undefined, { month: 'long' })}
      </p>
      <div className="grid grid-cols-7 gap-y-0.5">
        {days.map(day => (
          <div className={cn('flex flex-col items-center gap-0.5', !day.inMonth && 'opacity-30')} key={day.key}>
            <span
              className={cn(
                'grid size-4 place-items-center rounded-full text-[0.5625rem] tabular-nums text-muted-foreground',
                day.isToday && 'bg-(--theme-primary) font-semibold text-primary-foreground'
              )}
            >
              {day.date.getDate()}
            </span>
            <span
              className={cn('size-1 rounded-full', (eventsByDay.get(day.key)?.length ?? 0) > 0 && 'bg-(--theme-primary)')}
            />
          </div>
        ))}
      </div>
    </button>
  )
}

function Agenda({
  events,
  hasAnyEvents,
  loaded,
  onOpenEvent
}: {
  events: CalendarEvent[]
  hasAnyEvents: boolean
  loaded: boolean
  onOpenEvent: (event: CalendarEvent) => void
}) {
  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-card">
      <div className="shrink-0 border-b border-border px-4 py-3">
        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-muted-foreground">Agenda</p>
        <h2 className="mt-0.5 text-sm font-semibold tracking-tight">Next 30 days</h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {!loaded ? (
          <div className="grid min-h-32 place-items-center text-xs text-muted-foreground">Loading…</div>
        ) : events.length === 0 ? (
          <EmptyState
            className="min-h-40"
            description={
              hasAnyEvents
                ? 'Nothing due in the next 30 days.'
                : 'Ask Nemesis to pull your due dates from Blackboard and Outlook, or add one.'
            }
            title={hasAnyEvents ? 'All clear' : 'No deadlines yet'}
          />
        ) : (
          <div className="flex flex-col gap-1">
            {events.map(event => (
              <button
                className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-(--ui-control-hover-background)"
                key={event.id}
                onClick={() => onOpenEvent(event)}
                type="button"
              >
                <span className={cn('mt-1 size-1.5 shrink-0 rounded-full', KIND_META[event.kind].dot)} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">{event.title}</span>
                  <span className="block text-[0.6875rem] text-muted-foreground">
                    {formatEventDate(event.date)}
                    {event.time ? ` · ${formatEventTime(event.time)}` : ''}
                    {event.course ? ` · ${event.course}` : ''}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function EventDialog({
  dialog,
  error,
  onClose,
  onDelete,
  onSave,
  saving
}: {
  dialog: DialogState
  error: null | string
  onClose: () => void
  onDelete: () => void
  onSave: (input: EventFormValues) => void
  saving: boolean
}) {
  if (dialog.mode === 'view') {
    return <EventViewDialog event={dialog.event} onClose={onClose} />
  }

  return (
    <EventFormDialog
      error={error}
      initial={dialog.mode === 'add' ? emptyFormValues(dialog.date) : dialog.event}
      mode={dialog.mode}
      onClose={onClose}
      onDelete={onDelete}
      onSave={onSave}
      saving={saving}
    />
  )
}

function ViewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-14 shrink-0 text-[0.6875rem] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 flex-1 text-foreground">{value}</span>
    </div>
  )
}

function EventViewDialog({ event, onClose }: { event: CalendarEvent; onClose: () => void }) {
  return (
    <Dialog onOpenChange={open => !open && onClose()} open>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{event.title}</DialogTitle>
          <DialogDescription>Added by Nemesis. Ask it to change this, or add your own event alongside it.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 text-xs">
          <ViewRow
            label="When"
            value={`${formatEventDate(event.date)}${event.time ? ` · ${formatEventTime(event.time)}` : ''}`}
          />
          <ViewRow label="Type" value={KIND_META[event.kind].label} />
          {event.course && <ViewRow label="Course" value={event.course} />}
          {event.note && <ViewRow label="Notes" value={event.note} />}
        </div>
        <DialogFooter>
          <Button onClick={onClose} variant="outline">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function EventFormDialog({
  error,
  initial,
  mode,
  onClose,
  onDelete,
  onSave,
  saving
}: {
  error: null | string
  initial: EventFormValues
  mode: 'add' | 'edit'
  onClose: () => void
  onDelete: () => void
  onSave: (input: EventFormValues) => void
  saving: boolean
}) {
  const [title, setTitle] = useState(initial.title)
  const [date, setDate] = useState(initial.date)
  const [time, setTime] = useState(initial.time ?? '')
  const [kind, setKind] = useState<CalendarEventKind>(initial.kind)
  const [course, setCourse] = useState(initial.course ?? '')
  const [note, setNote] = useState(initial.note ?? '')
  const [armDelete, setArmDelete] = useState(false)

  const submit = () => {
    if (!title.trim() || !date) {
      return
    }

    onSave({
      course: course.trim() || undefined,
      date,
      kind,
      note: note.trim() || undefined,
      time: time.trim() || undefined,
      title: title.trim()
    })
  }

  return (
    <Dialog onOpenChange={open => !open && onClose()} open>
      <DialogContent banner={error || undefined} bannerTone="error" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === 'edit' ? 'Edit event' : 'Add event'}</DialogTitle>
          <DialogDescription>Assignment, exam, rotation, class — anything with a due date.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input autoFocus onChange={event => setTitle(event.target.value)} placeholder="Title" value={title} />
          <div className="flex gap-2">
            <Input className="flex-1" onChange={event => setDate(event.target.value)} type="date" value={date} />
            <Input className="w-32" onChange={event => setTime(event.target.value)} type="time" value={time} />
          </div>
          <Select onValueChange={value => setKind(value as CalendarEventKind)} value={kind}>
            <SelectTrigger aria-label="Event type" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KIND_ORDER.map(option => (
                <SelectItem key={option} value={option}>
                  <span className={cn('size-1.5 rounded-full', KIND_META[option].dot)} />
                  {KIND_META[option].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input onChange={event => setCourse(event.target.value)} placeholder="Course (optional)" value={course} />
          <Textarea className="min-h-16" onChange={event => setNote(event.target.value)} placeholder="Notes (optional)" value={note} />
        </div>
        <DialogFooter className="flex-wrap gap-2 sm:justify-between">
          {mode === 'edit' ? (
            <Button
              className={cn(armDelete && 'text-destructive')}
              onBlur={() => setArmDelete(false)}
              onClick={() => (armDelete ? onDelete() : setArmDelete(true))}
              variant="outline"
            >
              <IconTrash size={13} />
              {armDelete ? 'Really delete?' : 'Delete'}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button onClick={onClose} variant="outline">
              Cancel
            </Button>
            <Button disabled={!title.trim() || !date || saving} onClick={submit}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
