export const CALENDAR_DIR = '~/Documents/Nemesis Library/School';
export const CALENDAR_FILE = `${CALENDAR_DIR}/calendar.json`;
const KINDS = new Set(['assignment', 'exam', 'rotation', 'class', 'other']);
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
let idCounter = 0;
export function freshId(prefix) {
    idCounter += 1;
    return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}
function cleanText(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function sanitizeEvent(raw) {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const value = raw;
    const id = cleanText(value.id);
    const title = cleanText(value.title);
    const date = typeof value.date === 'string' ? value.date.trim() : '';
    const kind = typeof value.kind === 'string' && KINDS.has(value.kind) ? value.kind : null;
    if (!id || !title || !DATE_KEY_RE.test(date) || !kind) {
        return null;
    }
    const source = value.source === 'agent' || value.source === 'manual' ? value.source : undefined;
    return {
        course: cleanText(value.course),
        date,
        id,
        kind,
        note: cleanText(value.note),
        source,
        time: cleanText(value.time),
        title
    };
}
/** Parse calendar.json text into a validated event list. A malformed entry drops just
 *  that entry instead of failing the whole file — an agent's partial write or a typo in a
 *  hand-edited file shouldn't blank the page. */
export function parseCalendarEvents(text) {
    try {
        const parsed = JSON.parse(text);
        const list = parsed && typeof parsed === 'object' ? parsed.events : undefined;
        return Array.isArray(list) ? list.map(sanitizeEvent).filter((event) => event !== null) : [];
    }
    catch {
        return [];
    }
}
/** Read the agent-writable calendar file. A missing file, an unavailable desktop bridge,
 *  or malformed JSON all resolve to an empty list — this page must never hard-fail just
 *  because Nemesis hasn't written anything yet. */
export async function loadCalendarState() {
    const api = window.hermesDesktop;
    if (!api?.readFileText) {
        return { events: [] };
    }
    try {
        const read = await api.readFileText(CALENDAR_FILE);
        return { events: parseCalendarEvents(read.text ?? '') };
    }
    catch {
        return { events: [] };
    }
}
async function writeCalendarState(state) {
    const api = window.hermesDesktop;
    if (!api?.writeTextFile) {
        throw new Error('Saving is unavailable in this build.');
    }
    await api.makeDir?.(CALENDAR_DIR);
    await api.writeTextFile(CALENDAR_FILE, JSON.stringify({ events: state.events }, null, 2));
}
/** Persist a manual add/edit/delete. `localEvents` is the editor's full list with that
 *  change already applied. Agent events are always taken FRESH from disk rather than from
 *  `localEvents` — so a manual save can never clobber an agent write/edit/delete that
 *  happened concurrently, even though the page merged agent events into its own state for
 *  display. Manual events are taken from `localEvents`, which is the student's source of
 *  truth. The UI only lets a student edit/delete their own (non-agent) events. */
export async function saveCalendarEvents(localEvents) {
    const disk = await loadCalendarState();
    const agentEvents = disk.events.filter(event => event.source === 'agent');
    const manualEvents = localEvents.filter(event => event.source !== 'agent');
    const next = { events: [...agentEvents, ...manualEvents] };
    await writeCalendarState(next);
    return next;
}
// --- Date helpers -------------------------------------------------------------------
// Event `date` fields are plain "yyyy-mm-dd" with no time zone. Always parse/format them
// as LOCAL dates: `new Date("yyyy-mm-dd")` parses as UTC midnight, which renders as the
// PREVIOUS day in any negative UTC-offset timezone — that would put half of the US on the
// wrong day for every event.
export function parseDateKey(key) {
    const [year, month, day] = key.split('-').map(Number);
    return new Date(year, (month || 1) - 1, day || 1);
}
export function dateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
/** A 6x7 Sunday-first grid covering `month`, padded with adjacent-month days so every
 *  week row is full — the standard month-calendar layout. */
export function monthGrid(year, month, today) {
    const first = new Date(year, month, 1);
    const start = new Date(year, month, 1 - first.getDay());
    const todayKey = dateKey(today);
    const days = [];
    for (let i = 0; i < 42; i++) {
        const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        days.push({ date, inMonth: date.getMonth() === month, isToday: dateKey(date) === todayKey, key: dateKey(date) });
    }
    return days;
}
/** Group events by date key for O(1) lookup while rendering the grid; each day's events
 *  are time-sorted (undated-time events sort first). */
export function eventsByDate(events) {
    const map = new Map();
    for (const event of events) {
        const list = map.get(event.date) ?? [];
        list.push(event);
        map.set(event.date, list);
    }
    for (const list of map.values()) {
        list.sort((a, b) => (a.time ?? '').localeCompare(b.time ?? ''));
    }
    return map;
}
/** Upcoming events from `from` through `from + days`, soonest first — the Agenda list. */
export function upcomingEvents(events, from, days) {
    const fromKey = dateKey(from);
    const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + days);
    const toKey = dateKey(to);
    return events
        .filter(event => event.date >= fromKey && event.date <= toKey)
        .sort((a, b) => (a.date === b.date ? (a.time ?? '').localeCompare(b.time ?? '') : a.date.localeCompare(b.date)));
}
