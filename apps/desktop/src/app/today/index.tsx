import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import {
  type AcademicChange,
  type AcademicGraph,
  type AcademicObject,
  courseTitle,
  dueSoon,
  emptyGraph,
  eventsOnDay,
  loadAcademicGraph,
  recentChanges,
  scoreNextAction
} from '@/lib/academic-graph'
import { cn } from '@/lib/utils'
import { setComposerDraft } from '@/store/composer'

import { type CalendarEvent, dateKey, loadCalendarState, parseDateKey } from '../calendar/model'
import { CALENDAR_ROUTE, LEDGER_ROUTE, NEW_CHAT_ROUTE, SETTINGS_ROUTE } from '../routes'
import {
  dueSlot,
  loadCadence,
  portalSignInStatus,
  readLastNudge,
  saveCadence,
  SCHOOL_PORTALS,
  type SyncCadence,
  writeLastNudge
} from './school-sync-schedule'

const SYNC_CADENCE_LABEL: Record<SyncCadence, string> = {
  daily: 'Once a day',
  off: 'Manual only',
  twice: 'Twice a day'
}

const DAY_START_MINUTES = 8 * 60
const DAY_END_MINUTES = 22 * 60
const DEFAULT_EVENT_MINUTES = 60
const DUE_TYPES = new Set(['application', 'assignment', 'exam'])
const CLOSED_STATUSES = new Set(['done', 'graded', 'submitted'])
const MESSAGE_TITLE_RE = /\b(email|inbox|message|reply|respond|response|follow[ -]?up)\b/i

interface TimeRange {
  end: number
  start: number
}

interface PlanItem {
  durationMinutes?: number
  id: string
  kind: string
  sortMinutes: number
  subtitle?: string
  time?: string
  title: string
}

interface StudyBlockRecord {
  date?: unknown
  durationMinutes?: unknown
  end?: unknown
  start?: unknown
  time?: unknown
  title?: unknown
}

function minutesFromTime(value?: string): null | number {
  if (!value) {
    return null
  }

  const match = /^(\d{1,2}):(\d{2})/.exec(value.trim())

  if (!match) {
    return null
  }

  const hour = Number(match[1])
  const minute = Number(match[2])

  return hour >= 0 && hour < 24 && minute >= 0 && minute < 60 ? hour * 60 + minute : null
}

function timeFromIso(value?: string): string | undefined {
  const match = /T(\d{2}:\d{2})/.exec(value ?? '')

  return match?.[1]
}

function formatTime(value: string): string {
  const minutes = minutesFromTime(value)

  if (minutes == null) {
    return value
  }

  return new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  })
}

function durationFromFields(fields?: Record<string, unknown>, start?: string): number {
  if (typeof fields?.durationMinutes === 'number' && fields.durationMinutes > 0) {
    return fields.durationMinutes
  }

  if (typeof fields?.endTime === 'string') {
    const startMinutes = minutesFromTime(start)
    const endMinutes = minutesFromTime(fields.endTime)

    if (startMinutes != null && endMinutes != null && endMinutes > startMinutes) {
      return endMinutes - startMinutes
    }
  }

  return DEFAULT_EVENT_MINUTES
}

function studyBlocks(graph: AcademicGraph, todayKey: string): PlanItem[] {
  const result: PlanItem[] = []

  for (const object of graph.objects) {
    const rawBlocks = object.fields?.studyBlocks

    if (!Array.isArray(rawBlocks)) {
      continue
    }

    rawBlocks.forEach((raw, index) => {
      if (!raw || typeof raw !== 'object') {
        return
      }

      const block = raw as StudyBlockRecord
      const date = typeof block.date === 'string' ? block.date.slice(0, 10) : ''

      if (date !== todayKey) {
        return
      }

      const time =
        typeof block.start === 'string' ? block.start : typeof block.time === 'string' ? block.time : undefined

      const startMinutes = minutesFromTime(time)
      const endMinutes = typeof block.end === 'string' ? minutesFromTime(block.end) : null
      const explicitDuration = typeof block.durationMinutes === 'number' ? block.durationMinutes : null

      const durationMinutes =
        explicitDuration && explicitDuration > 0
          ? explicitDuration
          : startMinutes != null && endMinutes != null && endMinutes > startMinutes
            ? endMinutes - startMinutes
            : DEFAULT_EVENT_MINUTES

      result.push({
        durationMinutes,
        id: `study:${object.id}:${index}`,
        kind: 'Study block',
        sortMinutes: startMinutes ?? Number.POSITIVE_INFINITY,
        subtitle: courseTitle(graph, object.course),
        time,
        title: typeof block.title === 'string' && block.title.trim() ? block.title : `Study · ${object.title}`
      })
    })
  }

  return result
}

function calendarPlanItem(event: CalendarEvent): PlanItem {
  const start = minutesFromTime(event.time)

  return {
    durationMinutes: start == null ? undefined : DEFAULT_EVENT_MINUTES,
    id: `calendar:${event.id}`,
    kind: event.kind === 'other' && /\b(study|review|practice|prep)\b/i.test(event.title) ? 'Study block' : event.kind,
    sortMinutes: start ?? Number.POSITIVE_INFINITY,
    subtitle: event.course,
    time: event.time,
    title: event.title
  }
}

function graphPlanItem(graph: AcademicGraph, object: AcademicObject): PlanItem {
  const time = timeFromIso(object.date)
  const start = minutesFromTime(time)

  return {
    durationMinutes: start == null ? undefined : durationFromFields(object.fields, time),
    id: `graph:${object.id}`,
    kind: object.type,
    sortMinutes: start ?? Number.POSITIVE_INFINITY,
    subtitle: courseTitle(graph, object.course),
    time,
    title: object.title
  }
}

function todayPlan(graph: AcademicGraph, calendarEvents: CalendarEvent[], todayKey: string): PlanItem[] {
  const calendar = calendarEvents.filter(event => event.date === todayKey).map(calendarPlanItem)
  const academic = eventsOnDay(graph, todayKey).map(object => graphPlanItem(graph, object))

  return [...calendar, ...academic, ...studyBlocks(graph, todayKey)].sort(
    (a, b) => a.sortMinutes - b.sortMinutes || a.title.localeCompare(b.title)
  )
}

function freeMinutes(plan: PlanItem[]): number {
  const ranges = plan
    .filter(item => Number.isFinite(item.sortMinutes) && item.durationMinutes)
    .map(item => ({
      end: Math.min(DAY_END_MINUTES, item.sortMinutes + (item.durationMinutes ?? 0)),
      start: Math.max(DAY_START_MINUTES, item.sortMinutes)
    }))
    .filter(range => range.end > range.start)
    .sort((a, b) => a.start - b.start)

  const merged: TimeRange[] = []

  for (const range of ranges) {
    const previous = merged.at(-1)

    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end)
    } else {
      merged.push({ ...range })
    }
  }

  const busy = merged.reduce((total, range) => total + range.end - range.start, 0)

  return Math.max(0, DAY_END_MINUTES - DAY_START_MINUTES - busy)
}

function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60

  if (hours === 0) {
    return `${remainder} m`
  }

  return remainder ? `${hours} h ${remainder} m` : `${hours} h`
}

function relativeDate(value: string | undefined, today: Date): string {
  if (!value) {
    return 'No date'
  }

  const date = parseDateKey(value.slice(0, 10))
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const days = Math.round((date.getTime() - todayStart.getTime()) / 86_400_000)

  if (days < 0) {
    return `${Math.abs(days)}d overdue`
  }

  if (days === 0) {
    return 'Today'
  }

  if (days === 1) {
    return 'Tomorrow'
  }

  return `In ${days} days`
}

function inboxObjects(graph: AcademicGraph): AcademicObject[] {
  return graph.objects
    .filter(object => {
      if (object.type === 'announcement' || object.type === 'contact') {
        return true
      }

      return (object.type === 'application' && object.status === 'open') || MESSAGE_TITLE_RE.test(object.title)
    })
    .sort((a, b) =>
      (b.updatedAt ?? b.source?.ts ?? b.date ?? '').localeCompare(a.updatedAt ?? a.source?.ts ?? a.date ?? '')
    )
}

function overdueObjects(graph: AcademicGraph, todayKey: string): AcademicObject[] {
  return graph.objects.filter(
    object =>
      DUE_TYPES.has(object.type) &&
      Boolean(object.date) &&
      object.date!.slice(0, 10) < todayKey &&
      !CLOSED_STATUSES.has(object.status ?? '')
  )
}

function Card({ children, icon, title }: { children: React.ReactNode; icon: string; title: string }) {
  return (
    <section className="min-w-0 rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) p-4 shadow-[inset_0_1px_0_var(--ui-stroke-quaternary)]">
      <div className="mb-3 flex items-center gap-2">
        <Codicon className="text-(--ui-text-tertiary)" name={icon} size="0.9rem" />
        <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-(--ui-text-secondary)">{title}</h2>
      </div>
      {children}
    </section>
  )
}

function EmptyCopy({ children }: { children: React.ReactNode }) {
  return <p className="py-3 text-xs leading-relaxed text-(--ui-text-tertiary)">{children}</p>
}

function changeIsTrusted(change: AcademicChange): boolean {
  return change.kind === 'date-changed' || change.confidence === 'instructor-stated'
}

export function TodayView() {
  const navigate = useNavigate()
  const [graph, setGraph] = useState<AcademicGraph>(() => emptyGraph())
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([])
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async () => {
    const [nextGraph, calendar] = await Promise.all([loadAcademicGraph(), loadCalendarState()])
    setGraph(nextGraph)
    setCalendarEvents(calendar.events)
    setLoaded(true)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    let lastRun = 0

    const onFocus = () => {
      const now = Date.now()

      if (now - lastRun < 1500) {
        return
      }

      lastRun = now
      void refresh()
    }

    window.addEventListener('focus', onFocus)

    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  const now = new Date()
  const todayKey = dateKey(now)
  const plan = useMemo(() => todayPlan(graph, calendarEvents, todayKey), [calendarEvents, graph, todayKey])
  const changes = useMemo(() => recentChanges(graph, 2), [graph])
  const upcoming = useMemo(() => dueSoon(graph, 7), [graph])
  const inbox = useMemo(() => inboxObjects(graph), [graph])
  const overdue = useMemo(() => overdueObjects(graph, todayKey), [graph, todayKey])
  const nextAction = useMemo(() => scoreNextAction(graph), [graph])
  const free = useMemo(() => freeMinutes(plan), [plan])

  const needsYou = useMemo(
    () => new Set([...upcoming, ...overdue, ...inbox].map(object => object.id)).size,
    [inbox, overdue, upcoming]
  )

  const startNextAction = () => {
    if (!nextAction) {
      return
    }

    setComposerDraft(`Help me study ${nextAction.object.title} — quiz me and find my weak spots.`)
    navigate(NEW_CHAT_ROUTE)
  }

  const startSchoolSync = () => {
    setComposerDraft(
      'Sync my school — run your school-sync pipeline: sweep Blackboard and Outlook for anything new, capture the files, write lecture notes and flashcards for new material, and update my calendar and Home page. Report what changed.'
    )
    navigate(NEW_CHAT_ROUTE)
  }

  const [cadence, setCadence] = useState<SyncCadence>(() => loadCadence())
  const [portalStatus, setPortalStatus] = useState<Record<string, boolean>>({})

  // Refresh the signed-in status when Today mounts/refocuses — the student may
  // have logged into a portal in the browser panel since last time.
  useEffect(() => {
    let alive = true
    const refresh = () => void portalSignInStatus().then(status => alive && setPortalStatus(status))
    refresh()
    window.addEventListener('focus', refresh)

    return () => {
      alive = false
      window.removeEventListener('focus', refresh)
    }
  }, [])

  // The scheduler: while the app is open, check each minute whether a scheduled
  // slot is due; if so, fire ONE native "time to sync" nudge (never a silent
  // token-spending turn), tagged so it fires at most once per slot per day.
  useEffect(() => {
    if (cadence === 'off') {
      return
    }

    const tick = () => {
      const slot = dueSlot(cadence, new Date(), readLastNudge())

      if (!slot) {
        return
      }

      writeLastNudge(slot)
      void window.hermesDesktop?.notify?.({
        body: 'Open Nemesis and hit Sync school to pull in new lectures, files, and deadlines.',
        title: 'Time to sync your school'
      })
    }

    tick()
    const timer = window.setInterval(tick, 60_000)

    return () => window.clearInterval(timer)
  }, [cadence])

  const changeCadence = (next: SyncCadence) => {
    setCadence(next)
    saveCadence(next)
  }

  if (!loaded) {
    return (
      <main className="grid h-full min-h-0 place-items-center bg-(--ui-editor-surface-background)">
        <div className="flex items-center gap-2 text-xs text-(--ui-text-tertiary)">
          <Codicon name="loading" spinning />
          Building today
        </div>
      </main>
    )
  }

  if (graph.objects.length === 0) {
    return (
      <main className="grid h-full min-h-0 place-items-center overflow-y-auto bg-(--ui-editor-surface-background) px-6">
        <div className="max-w-md text-center">
          <span className="mx-auto grid size-12 place-items-center rounded-xl border border-(--theme-primary)/35 bg-(--theme-primary)/10 text-(--theme-primary)">
            <Codicon name="dashboard" size="1.35rem" />
          </span>
          <h1 className="mt-4 text-xl font-semibold tracking-[-0.02em]">Your semester will live here</h1>
          <p className="mt-2 text-sm leading-relaxed text-(--ui-text-secondary)">
            Connect your school accounts and I'll build your semester here.
          </p>
          <Button className="mt-5" onClick={() => navigate(`${SETTINGS_ROUTE}?tab=connections`)}>
            <Codicon name="plug" />
            Open Connections
          </Button>
        </div>
      </main>
    )
  }

  const greeting = now.getHours() < 12 ? 'morning' : now.getHours() < 18 ? 'afternoon' : 'evening'
  const dateLabel = now.toLocaleDateString(undefined, { day: 'numeric', month: 'short', weekday: 'long' })

  return (
    <main className="h-full min-h-0 overflow-y-auto bg-(--ui-editor-surface-background)">
      <div className="mx-auto flex w-full max-w-[1180px] flex-col px-5 pb-7 pt-6 sm:px-7">
        <header>
          <p className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-(--theme-primary)">
            Today · {dateLabel}
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">
            Good {greeting}, {graph.student?.name?.trim() || 'there'}
          </h1>
          <p className="mt-2 text-sm text-(--ui-text-secondary)">
            {formatDuration(free)} free today · {needsYou} item{needsYou === 1 ? '' : 's'} need you · {overdue.length}{' '}
            overdue
          </p>
        </header>

        <section className="mt-6 rounded-xl border-2 border-(--theme-primary) bg-[color-mix(in_srgb,var(--theme-primary)_7%,var(--ui-bg-elevated))] p-5 shadow-[0_0_28px_color-mix(in_srgb,var(--theme-primary)_9%,transparent)]">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
            <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-(--theme-primary)/15 text-(--theme-primary)">
              <Codicon name="target" size="1.2rem" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[0.65rem] font-semibold uppercase tracking-[0.11em] text-(--theme-primary)">
                Start here
              </p>
              <h2 className="mt-1 text-lg font-semibold tracking-[-0.015em]">
                {nextAction?.object.title ?? 'You are clear for the moment'}
              </h2>
              <p className="mt-1 text-xs text-(--ui-text-secondary)">
                {nextAction?.reason ?? 'No urgent deadline is competing for your attention.'}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2 self-start sm:self-auto">
              <Button onClick={startSchoolSync} size="lg" variant="outline">
                <Codicon name="sync" />
                Sync school
              </Button>
              {nextAction && (
                <Button onClick={startNextAction} size="lg">
                  <Codicon name="play" />
                  Start
                </Button>
              )}
            </div>
          </div>

          {/* Sign-in status + auto-sync cadence — the student knows whether a
              sync will work (portals signed in) before running it, and can put
              the sweep on a schedule. */}
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-(--theme-primary)/20 pt-3.5 text-xs">
            <span className="flex flex-wrap items-center gap-2.5">
              {SCHOOL_PORTALS.map(portal => {
                const signedIn = portalStatus[portal.origin] === true
                const known = portal.origin in portalStatus

                return (
                  <span className="flex items-center gap-1.5 text-(--ui-text-secondary)" key={portal.id}>
                    <span
                      className={cn(
                        'size-1.5 rounded-full',
                        signedIn ? 'bg-emerald-500' : known ? 'bg-amber-500' : 'bg-(--ui-text-quaternary)'
                      )}
                    />
                    {portal.name}
                    <span className="text-(--ui-text-tertiary)">
                      {signedIn ? 'signed in' : known ? 'needs login' : '—'}
                    </span>
                  </span>
                )
              })}
            </span>
            <label className="ml-auto flex items-center gap-2 text-(--ui-text-tertiary)">
              Auto-sync
              <select
                className="rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-bg-quaternary) px-2 py-1 text-xs text-(--ui-text-primary) outline-none focus-visible:ring-2 focus-visible:ring-(--theme-primary)/40"
                onChange={event => changeCadence(event.target.value as SyncCadence)}
                value={cadence}
              >
                {(['off', 'daily', 'twice'] as const).map(option => (
                  <option key={option} value={option}>
                    {SYNC_CADENCE_LABEL[option]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>

        <div className="mt-5 grid [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))] gap-4">
          <Card icon="history" title="Changed since yesterday">
            {changes.length === 0 ? (
              <EmptyCopy>Nothing new.</EmptyCopy>
            ) : (
              <div className="divide-y divide-(--ui-stroke-tertiary)">
                {changes.slice(0, 4).map(change => (
                  <div className="flex gap-2.5 py-2.5 first:pt-0 last:pb-0" key={`${change.objectId}:${change.ts}`}>
                    <span
                      className={
                        changeIsTrusted(change)
                          ? 'mt-1.5 size-1.5 shrink-0 rounded-full bg-(--theme-primary)'
                          : 'mt-1.5 size-1.5 shrink-0 rounded-full bg-(--ui-text-quaternary)'
                      }
                    />
                    <div className="min-w-0">
                      <p className="text-xs leading-relaxed text-(--ui-text-primary)">{change.summary}</p>
                      {changeIsTrusted(change) && (
                        <p className="mt-1 text-[0.625rem] font-medium uppercase tracking-[0.07em] text-(--theme-primary)">
                          {change.kind === 'date-changed' ? 'Date changed' : 'Instructor stated'}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card icon="calendar" title="Due soon">
            {upcoming.length === 0 ? (
              <EmptyCopy>Nothing due — you're clear.</EmptyCopy>
            ) : (
              <div className="divide-y divide-(--ui-stroke-tertiary)">
                {upcoming.slice(0, 5).map(object => (
                  <button
                    className="group flex w-full items-start justify-between gap-3 py-2.5 text-left first:pt-0 last:pb-0"
                    key={object.id}
                    onClick={() => navigate(CALENDAR_ROUTE)}
                    type="button"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium group-hover:text-(--theme-primary)">
                        {object.title}
                      </span>
                      <span className="mt-0.5 block truncate text-[0.6875rem] text-(--ui-text-tertiary)">
                        {courseTitle(graph, object.course) || object.type}
                      </span>
                    </span>
                    <span className="shrink-0 text-[0.6875rem] font-medium tabular-nums text-(--ui-text-secondary)">
                      {relativeDate(object.date, now)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </Card>

          <Card icon="checklist" title="Today's plan">
            {plan.length === 0 ? (
              <EmptyCopy>Your day is open. Add a study block when you know what deserves the time.</EmptyCopy>
            ) : (
              <div className="divide-y divide-(--ui-stroke-tertiary)">
                {plan.slice(0, 5).map(item => (
                  <div className="flex gap-3 py-2.5 first:pt-0 last:pb-0" key={item.id}>
                    <span className="w-16 shrink-0 text-[0.6875rem] font-medium tabular-nums text-(--theme-primary)">
                      {item.time ? formatTime(item.time) : 'Any time'}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium">{item.title}</p>
                      <p className="mt-0.5 truncate text-[0.6875rem] capitalize text-(--ui-text-tertiary)">
                        {[item.kind, item.subtitle].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card icon="mail" title="Inbox needs you">
            {inbox.length === 0 ? (
              <EmptyCopy>Nothing waiting for you.</EmptyCopy>
            ) : (
              <div>
                <div className="divide-y divide-(--ui-stroke-tertiary)">
                  {inbox.slice(0, 3).map(object => (
                    <div className="py-2.5 first:pt-0 last:pb-0" key={object.id}>
                      <p className="truncate text-xs font-medium">{object.title}</p>
                      <p className="mt-0.5 truncate text-[0.6875rem] capitalize text-(--ui-text-tertiary)">
                        {[object.type, courseTitle(graph, object.course)].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                  ))}
                </div>
                {inbox.length > 3 && (
                  <p className="mt-3 text-[0.6875rem] text-(--ui-text-quaternary)">{inbox.length - 3} more filed</p>
                )}
              </div>
            )}
          </Card>
        </div>

        <button
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg border border-(--ui-stroke-tertiary) px-4 py-3 text-center text-[0.6875rem] text-(--ui-text-tertiary) transition-colors hover:bg-(--ui-control-hover-background) hover:text-(--ui-text-secondary)"
          onClick={() => navigate(LEDGER_ROUTE)}
          type="button"
        >
          <Codicon className="shrink-0 text-(--theme-primary)" name="shield" size="0.85rem" />
          <span>Read your accounts this morning · sent nothing · submitted nothing.</span>
        </button>
      </div>
    </main>
  )
}
