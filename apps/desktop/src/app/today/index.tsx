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
import { ensurePortalsMirrored, PORTALS_CHANGED_EVENT } from '@/lib/school-portals'
import { cn } from '@/lib/utils'
import { seedComposerDraft } from '@/store/composer'

import { type CalendarEvent, dateKey, loadCalendarState, parseDateKey } from '../calendar/model'
import { CALENDAR_ROUTE, LEDGER_ROUTE, NEW_CHAT_ROUTE, SETTINGS_ROUTE } from '../routes'
import {
  dueSlot,
  loadCadence,
  portalSignInStatus,
  readLastNudge,
  saveCadence,
  schoolPortals,
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

type AttentionBucket = 'later' | 'overdue' | 'today' | 'tomorrow' | 'undated'

interface AttentionItem {
  bucket: AttentionBucket
  object: AcademicObject
}

type TimelineEntry =
  | {
      item: PlanItem
      kind: 'item'
      sortMinutes: number
    }
  | {
      kind: 'window'
      range: TimeRange
      sortMinutes: number
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

function occupiedRanges(plan: PlanItem[]): TimeRange[] {
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

  return merged
}

function freeWindows(ranges: TimeRange[], minimumMinutes = 30): TimeRange[] {
  const windows: TimeRange[] = []
  let cursor = DAY_START_MINUTES

  for (const range of ranges) {
    if (range.start - cursor >= minimumMinutes) {
      windows.push({ end: range.start, start: cursor })
    }

    cursor = Math.max(cursor, range.end)
  }

  if (DAY_END_MINUTES - cursor >= minimumMinutes) {
    windows.push({ end: DAY_END_MINUTES, start: cursor })
  }

  return windows
}

function freeMinutes(plan: PlanItem[]): number {
  const busy = occupiedRanges(plan).reduce((total, range) => total + range.end - range.start, 0)

  return Math.max(0, DAY_END_MINUTES - DAY_START_MINUTES - busy)
}

function formatMinuteOfDay(minutes: number): string {
  return new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  })
}

function runwayPercent(minutes: number): number {
  const clamped = Math.min(DAY_END_MINUTES, Math.max(DAY_START_MINUTES, minutes))

  return ((clamped - DAY_START_MINUTES) / (DAY_END_MINUTES - DAY_START_MINUTES)) * 100
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

function attentionBucket(object: AcademicObject, todayKey: string): AttentionBucket {
  const key = object.date?.slice(0, 10)

  if (!key) {
    return 'undated'
  }

  if (key < todayKey) {
    return 'overdue'
  }

  if (key === todayKey) {
    return 'today'
  }

  const today = parseDateKey(todayKey)
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)

  if (key === dateKey(tomorrow)) {
    return 'tomorrow'
  }

  return 'later'
}

function needsAttention(
  overdue: AcademicObject[],
  upcoming: AcademicObject[],
  inbox: AcademicObject[],
  todayKey: string
): AttentionItem[] {
  const objects = new Map<string, AcademicObject>()

  for (const object of [...overdue, ...upcoming, ...inbox]) {
    if (!objects.has(object.id)) {
      objects.set(object.id, object)
    }
  }

  const bucketRank: Record<AttentionBucket, number> = {
    overdue: 0,
    today: 1,
    tomorrow: 2,
    later: 3,
    undated: 4
  }

  return [...objects.values()]
    .map(object => ({ bucket: attentionBucket(object, todayKey), object }))
    .sort(
      (a, b) =>
        bucketRank[a.bucket] - bucketRank[b.bucket] ||
        (a.object.date ?? '').localeCompare(b.object.date ?? '') ||
        a.object.title.localeCompare(b.object.title)
    )
}

function latestAcademicTimestamp(graph: AcademicGraph): null | number {
  const timestamps = [
    ...graph.changes.map(change => change.ts),
    ...graph.objects.flatMap(object => [object.updatedAt, object.source?.ts, object.createdAt])
  ]
    .filter((value): value is string => Boolean(value))
    .map(value => Date.parse(value))
    .filter(value => Number.isFinite(value))

  return timestamps.length ? Math.max(...timestamps) : null
}

function formatFreshness(timestamp: null | number, now: number): string {
  if (timestamp == null) {
    return 'Sync time unavailable'
  }

  const elapsedMinutes = Math.max(0, Math.floor((now - timestamp) / 60_000))

  if (elapsedMinutes < 1) {
    return 'Synced just now'
  }

  if (elapsedMinutes < 60) {
    return `Synced ${elapsedMinutes}m ago`
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60)

  if (elapsedHours < 24) {
    return `Synced ${elapsedHours}h ago`
  }

  return `Synced ${Math.floor(elapsedHours / 24)}d ago`
}

function nextActionLabel(object: AcademicObject): string {
  if (object.type === 'exam') {
    return 'Start exam review'
  }

  if (object.type === 'assignment') {
    return 'Start assignment review'
  }

  if (object.type === 'application') {
    return 'Prepare with Nemesis'
  }

  return 'Start review'
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
  const attentionItems = useMemo(
    () => needsAttention(overdue, upcoming, inbox, todayKey),
    [inbox, overdue, todayKey, upcoming]
  )
  const timedPlan = useMemo(() => plan.filter(item => Number.isFinite(item.sortMinutes)), [plan])
  const flexiblePlan = useMemo(() => plan.filter(item => !Number.isFinite(item.sortMinutes)), [plan])
  const busyRanges = useMemo(() => occupiedRanges(plan), [plan])
  const openWindows = useMemo(() => freeWindows(busyRanges), [busyRanges])
  const timeline = useMemo<TimelineEntry[]>(
    () =>
      [
        ...timedPlan.map(item => ({ item, kind: 'item' as const, sortMinutes: item.sortMinutes })),
        ...openWindows.map(range => ({ kind: 'window' as const, range, sortMinutes: range.start }))
      ].sort((a, b) => a.sortMinutes - b.sortMinutes),
    [openWindows, timedPlan]
  )
  const orderedChanges = useMemo(
    () =>
      [...changes].sort(
        (a, b) =>
          Number(changeIsTrusted(b)) - Number(changeIsTrusted(a)) ||
          (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0)
      ),
    [changes]
  )
  const latestSyncAt = useMemo(() => latestAcademicTimestamp(graph), [graph])
  const freshness = formatFreshness(latestSyncAt, now.getTime())
  const needsYou = attentionItems.length
  const currentMinutes = now.getHours() * 60 + now.getMinutes()
  const currentTimeIsOnRunway = currentMinutes >= DAY_START_MINUTES && currentMinutes <= DAY_END_MINUTES

  const startNextAction = () => {
    if (!nextAction) {
      return
    }

    seedComposerDraft(`Help me study ${nextAction.object.title} — quiz me and find my weak spots.`)
    navigate(NEW_CHAT_ROUTE)
  }

  const startSchoolSync = () => {
    seedComposerDraft(
      'Sync my school — run your school-sync pipeline: sweep Blackboard and Outlook for anything new, capture the files, write lecture notes and flashcards for new material, and update my calendar and Home page. Report what changed.'
    )
    navigate(NEW_CHAT_ROUTE)
  }

  const startSemesterScaffold = () => {
    seedComposerDraft(
      'Set up my semester — run your semester-scaffold skill: find my course syllabi, and for each course build the skeleton (weekly topic schedule, every exam and assignment with its date and grade weight, the grading breakdown) into my graph and a per-course overview note. Frame the whole term first; I\'ll pull materials after. Report what you set up.'
    )
    navigate(NEW_CHAT_ROUTE)
  }

  const [cadence, setCadence] = useState<SyncCadence>(() => loadCadence())
  const [portals, setPortals] = useState(() => schoolPortals())
  const [portalStatus, setPortalStatus] = useState<Record<string, boolean>>({})

  // Refresh the signed-in status when Today mounts/refocuses — the student may
  // have logged into a portal in the browser panel since last time — and re-read
  // the portal list when it's edited in Settings → Connections. Mount also
  // re-mirrors the list to .nemesis/portals.json so the agent always finds it.
  useEffect(() => {
    let alive = true
    ensurePortalsMirrored()
    const refresh = () => void portalSignInStatus().then(status => alive && setPortalStatus(status))
    const onPortalsChanged = () => {
      if (alive) {
        setPortals(schoolPortals())
      }

      refresh()
    }

    refresh()
    window.addEventListener('focus', refresh)
    window.addEventListener(PORTALS_CHANGED_EVENT, onPortalsChanged)

    return () => {
      alive = false
      window.removeEventListener('focus', refresh)
      window.removeEventListener(PORTALS_CHANGED_EVENT, onPortalsChanged)
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
          <span className="mx-auto grid size-12 place-items-center rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) text-(--ui-text-secondary)">
            <Codicon name="dashboard" size="1.35rem" />
          </span>
          <h1 className="mt-4 text-xl font-semibold tracking-[-0.02em]">Your semester will live here</h1>
          <p className="mt-2 text-sm leading-relaxed text-(--ui-text-secondary)">
            Give me a syllabus and I&rsquo;ll frame your whole term — weekly topics, every
            exam and its weight, the grading breakdown — then fill it in as materials arrive.
          </p>
          <div className="mt-5 flex flex-col items-center gap-2">
            <Button onClick={startSemesterScaffold}>
              <Codicon name="milestone" />
              Set up my semester
            </Button>
            <Button
              className="text-(--ui-text-secondary)"
              onClick={() => navigate(`${SETTINGS_ROUTE}?tab=connections`)}
              size="sm"
              variant="ghost"
            >
              <Codicon name="plug" />
              Connect school accounts first
            </Button>
          </div>
        </div>
      </main>
    )
  }

  const greeting = now.getHours() < 12 ? 'morning' : now.getHours() < 18 ? 'afternoon' : 'evening'
  const dateLabel = now.toLocaleDateString(undefined, { day: 'numeric', month: 'short', weekday: 'long' })

  return (
    <main className="h-full min-h-0 overflow-y-auto bg-(--ui-editor-surface-background)">
      <div className="mx-auto flex w-full max-w-[1180px] flex-col px-5 pb-7 pt-5 sm:px-7">
        <header className="flex flex-col gap-4 border-b border-(--ui-stroke-quaternary) pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <p className="text-[0.65rem] font-semibold uppercase tracking-[0.1em] text-(--ui-text-tertiary)">
              Today · {dateLabel}
            </p>
            <h1 className="mt-1.5 text-2xl font-semibold tracking-[-0.03em] sm:text-3xl">
              Good {greeting}, {graph.student?.name?.trim() || 'there'}
            </h1>
            <p className="mt-1.5 text-xs text-(--ui-text-secondary)">
              {formatDuration(free)} free · {needsYou} item{needsYou === 1 ? '' : 's'} need you · {overdue.length}{' '}
              overdue
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            <span className="text-[0.6875rem] tabular-nums text-(--ui-text-tertiary)">{freshness}</span>
            <Button onClick={startSchoolSync} size="sm" variant="outline">
              <Codicon name="sync" />
              Sync school
            </Button>
          </div>
        </header>

        <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1.55fr)_minmax(300px,0.9fr)] lg:items-start">
          <div className="min-w-0 space-y-4">
            <section className="min-w-0 rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) p-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-quaternary) text-(--ui-text-secondary)">
                  <Codicon name="target" size="1.05rem" />
                </span>

                <div className="min-w-0 flex-1">
                  <p className="text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--ui-text-tertiary)">
                    Next action
                  </p>
                  <h2 className="mt-1 text-lg font-semibold tracking-[-0.015em]">
                    {nextAction?.object.title ?? 'You are clear for the moment'}
                  </h2>
                  <p className="mt-1 text-xs leading-relaxed text-(--ui-text-secondary)">
                    {nextAction?.reason ?? 'No urgent deadline is competing for your attention.'}
                  </p>
                </div>

                {nextAction && (
                  <Button className="shrink-0 self-start sm:self-auto" onClick={startNextAction} size="lg">
                    <Codicon name="play" />
                    {nextActionLabel(nextAction.object)}
                  </Button>
                )}
              </div>
            </section>

            <section className="min-w-0 rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated)">
              <div className="flex items-center justify-between gap-4 border-b border-(--ui-stroke-quaternary) px-5 py-4">
                <div>
                  <div className="flex items-center gap-2">
                    <Codicon className="text-(--ui-text-tertiary)" name="calendar" size="0.9rem" />
                    <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-(--ui-text-secondary)">
                      Today
                    </h2>
                  </div>
                  <p className="mt-1 text-[0.6875rem] text-(--ui-text-tertiary)">
                    {timedPlan.length} timed · {flexiblePlan.length} flexible
                  </p>
                </div>

                <Button onClick={() => navigate(CALENDAR_ROUTE)} size="sm" variant="ghost">
                  Open calendar
                  <Codicon name="arrow-right" />
                </Button>
              </div>

              <div className="px-5 py-4">
                <div>
                  <div className="flex items-center justify-between text-[0.625rem] font-medium tabular-nums text-(--ui-text-quaternary)">
                    <span>8 AM</span>
                    <span>Day runway</span>
                    <span>10 PM</span>
                  </div>

                  <div
                    aria-label="Day runway from 8 AM to 10 PM"
                    className="relative mt-2 h-2.5 overflow-hidden rounded-full border border-(--ui-stroke-tertiary) bg-(--ui-bg-quaternary)"
                  >
                    {openWindows.map(range => (
                      <span
                        className="absolute inset-y-0 bg-(--ui-bg-elevated)"
                        key={`runway-open:${range.start}:${range.end}`}
                        style={{
                          left: `${runwayPercent(range.start)}%`,
                          width: `${runwayPercent(range.end) - runwayPercent(range.start)}%`
                        }}
                        title={`Open ${formatMinuteOfDay(range.start)}–${formatMinuteOfDay(range.end)}`}
                      />
                    ))}

                    {busyRanges.map(range => (
                      <span
                        className="absolute inset-y-0 bg-(--ui-text-quaternary)"
                        key={`runway-busy:${range.start}:${range.end}`}
                        style={{
                          left: `${runwayPercent(range.start)}%`,
                          width: `${runwayPercent(range.end) - runwayPercent(range.start)}%`
                        }}
                        title={`Occupied ${formatMinuteOfDay(range.start)}–${formatMinuteOfDay(range.end)}`}
                      />
                    ))}

                    {currentTimeIsOnRunway && (
                      <span
                        aria-label={`Current time ${formatMinuteOfDay(currentMinutes)}`}
                        className="absolute -inset-y-px z-10 w-px bg-(--theme-primary)"
                        style={{ left: `${runwayPercent(currentMinutes)}%` }}
                        title={`Now · ${formatMinuteOfDay(currentMinutes)}`}
                      />
                    )}
                  </div>
                </div>

                {timeline.length === 0 ? (
                  <EmptyCopy>Your day is open. Add a study block when you know what deserves the time.</EmptyCopy>
                ) : (
                  <div className="relative ml-1 mt-5 border-l border-(--ui-stroke-tertiary)">
                    {timeline.map(entry =>
                      entry.kind === 'window' ? (
                        <div
                          className="relative grid grid-cols-[5rem_minmax(0,1fr)] gap-3 py-2.5 pl-4"
                          key={`window:${entry.range.start}:${entry.range.end}`}
                        >
                          <span className="absolute -left-1 top-[1.05rem] size-2 rounded-full border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated)" />
                          <span className="text-[0.6875rem] font-medium tabular-nums text-(--ui-text-quaternary)">
                            {formatMinuteOfDay(entry.range.start)}
                          </span>
                          <div className="min-w-0 rounded-lg border border-dashed border-(--ui-stroke-tertiary) px-3 py-2">
                            <p className="text-xs font-medium text-(--ui-text-secondary)">
                              Open for {formatDuration(entry.range.end - entry.range.start)}
                            </p>
                            <p className="mt-0.5 text-[0.6875rem] tabular-nums text-(--ui-text-tertiary)">
                              {formatMinuteOfDay(entry.range.start)}–{formatMinuteOfDay(entry.range.end)}
                            </p>
                          </div>
                        </div>
                      ) : (
                        <div
                          className="relative grid grid-cols-[5rem_minmax(0,1fr)] gap-3 py-2.5 pl-4"
                          key={entry.item.id}
                        >
                          <span className="absolute -left-1 top-[1.05rem] size-2 rounded-full border border-(--ui-stroke-tertiary) bg-(--ui-text-tertiary)" />
                          <span className="text-[0.6875rem] font-medium tabular-nums text-(--ui-text-secondary)">
                            {entry.item.time ? formatTime(entry.item.time) : formatMinuteOfDay(entry.item.sortMinutes)}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate text-xs font-medium">{entry.item.title}</p>
                            <p className="mt-0.5 truncate text-[0.6875rem] capitalize text-(--ui-text-tertiary)">
                              {[
                                entry.item.kind,
                                entry.item.subtitle,
                                entry.item.durationMinutes ? formatDuration(entry.item.durationMinutes) : undefined
                              ]
                                .filter(Boolean)
                                .join(' · ')}
                            </p>
                          </div>
                        </div>
                      )
                    )}
                  </div>
                )}

                {flexiblePlan.length > 0 && (
                  <div className="mt-5 border-t border-(--ui-stroke-quaternary) pt-4">
                    <h3 className="text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-(--ui-text-tertiary)">
                      Flexible
                    </h3>
                    <div className="mt-2 divide-y divide-(--ui-stroke-quaternary)">
                      {flexiblePlan.map(item => (
                        <div className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0" key={item.id}>
                          <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-(--ui-text-quaternary)" />
                          <div className="min-w-0">
                            <p className="truncate text-xs font-medium">{item.title}</p>
                            <p className="mt-0.5 truncate text-[0.6875rem] capitalize text-(--ui-text-tertiary)">
                              {[item.kind, item.subtitle].filter(Boolean).join(' · ')}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </section>
          </div>

          <aside className="min-w-0 space-y-4">
            <section className="min-w-0 rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Codicon className="text-(--ui-text-tertiary)" name="warning" size="0.9rem" />
                  <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-(--ui-text-secondary)">
                    Needs attention
                  </h2>
                </div>
                <span className="text-[0.6875rem] tabular-nums text-(--ui-text-tertiary)">
                  {attentionItems.length}
                </span>
              </div>

              {attentionItems.length === 0 ? (
                <EmptyCopy>Nothing waiting for you.</EmptyCopy>
              ) : (
                <div className="divide-y divide-(--ui-stroke-tertiary)">
                  {attentionItems.map(item => {
                    const opensCalendar = DUE_TYPES.has(item.object.type) && Boolean(item.object.date)
                    const content = (
                      <>
                        <span className="min-w-0">
                          <span className="block truncate text-xs font-medium">{item.object.title}</span>
                          <span className="mt-0.5 block truncate text-[0.6875rem] capitalize text-(--ui-text-tertiary)">
                            {[item.object.type, courseTitle(graph, item.object.course)].filter(Boolean).join(' · ')}
                          </span>
                        </span>
                        <span
                          className={cn(
                            'shrink-0 text-[0.6875rem] font-medium tabular-nums',
                            item.bucket === 'overdue'
                              ? 'text-(--theme-primary)'
                              : 'text-(--ui-text-secondary)'
                          )}
                        >
                          {item.bucket === 'undated' ? 'Message' : relativeDate(item.object.date, now)}
                        </span>
                      </>
                    )

                    return opensCalendar ? (
                      <button
                        className="group flex w-full items-start justify-between gap-3 py-2.5 text-left first:pt-0 last:pb-0 hover:text-(--ui-text-primary)"
                        key={item.object.id}
                        onClick={() => navigate(CALENDAR_ROUTE)}
                        type="button"
                      >
                        {content}
                      </button>
                    ) : (
                      <div
                        className="flex items-start justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
                        key={item.object.id}
                      >
                        {content}
                      </div>
                    )
                  })}
                </div>
              )}
            </section>

            <section className="min-w-0 rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Codicon className="text-(--ui-text-tertiary)" name="history" size="0.9rem" />
                  <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-(--ui-text-secondary)">
                    Since yesterday
                  </h2>
                </div>
                <Button onClick={() => navigate(LEDGER_ROUTE)} size="sm" variant="ghost">
                  Full history
                </Button>
              </div>

              {orderedChanges.length === 0 ? (
                <EmptyCopy>Nothing new.</EmptyCopy>
              ) : (
                <div className="divide-y divide-(--ui-stroke-tertiary)">
                  {orderedChanges.slice(0, 3).map(change => (
                    <div className="flex gap-2.5 py-2.5 first:pt-0 last:pb-0" key={`${change.objectId}:${change.ts}`}>
                      <span
                        className={cn(
                          'mt-1.5 size-1.5 shrink-0 rounded-full',
                          changeIsTrusted(change) ? 'bg-(--ui-text-secondary)' : 'bg-(--ui-text-quaternary)'
                        )}
                      />
                      <div className="min-w-0">
                        <p className="text-xs leading-relaxed text-(--ui-text-primary)">{change.summary}</p>
                        {changeIsTrusted(change) && (
                          <p className="mt-1 text-[0.625rem] font-medium uppercase tracking-[0.07em] text-(--ui-text-tertiary)">
                            {change.kind === 'date-changed' ? 'Date changed' : 'Instructor stated'}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {orderedChanges.length > 3 && (
                <p className="mt-3 text-[0.6875rem] text-(--ui-text-quaternary)">
                  {orderedChanges.length - 3} more in history
                </p>
              )}
            </section>

            <section className="min-w-0 rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Codicon className="text-(--ui-text-tertiary)" name="plug" size="0.9rem" />
                  <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-(--ui-text-secondary)">
                    School connections
                  </h2>
                </div>
                <Button
                  onClick={() => navigate(`${SETTINGS_ROUTE}?tab=connections`)}
                  size="sm"
                  variant="ghost"
                >
                  Manage
                </Button>
              </div>

              {portals.length === 0 ? (
                <EmptyCopy>No school accounts connected.</EmptyCopy>
              ) : (
                <div className="divide-y divide-(--ui-stroke-quaternary)">
                  {portals.map(portal => {
                    const signedIn = portalStatus[portal.origin] === true
                    const known = portal.origin in portalStatus

                    return (
                      <div className="flex items-center justify-between gap-3 py-2 first:pt-0" key={portal.id}>
                        <span className="flex min-w-0 items-center gap-2">
                          <span
                            className={cn(
                              'size-1.5 shrink-0 rounded-full',
                              signedIn
                                ? 'bg-emerald-500'
                                : known
                                  ? 'bg-amber-500'
                                  : 'bg-(--ui-text-quaternary)'
                            )}
                          />
                          <span className="truncate text-xs font-medium">{portal.name}</span>
                        </span>
                        <span className="shrink-0 text-[0.6875rem] text-(--ui-text-tertiary)">
                          {signedIn ? 'Signed in' : known ? 'Needs login' : 'Checking'}
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}

              <label className="mt-3 flex items-center justify-between gap-3 border-t border-(--ui-stroke-quaternary) pt-3 text-xs text-(--ui-text-secondary)">
                Sync reminder
                <select
                  className="rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-bg-quaternary) px-2 py-1 text-xs text-(--ui-text-primary) outline-none focus-visible:ring-2 focus-visible:ring-(--ui-text-quaternary)"
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
            </section>
          </aside>
        </div>

        <button
          className="mt-5 flex w-full items-center justify-center gap-2 px-4 py-2 text-center text-[0.6875rem] text-(--ui-text-quaternary) transition-colors hover:text-(--ui-text-secondary)"
          onClick={() => navigate(LEDGER_ROUTE)}
          type="button"
        >
          <Codicon className="shrink-0" name="shield" size="0.8rem" />
          <span>
            Nemesis read {portals.length} account{portals.length === 1 ? '' : 's'} today · sent nothing
          </span>
        </button>
      </div>
    </main>
  )
}
