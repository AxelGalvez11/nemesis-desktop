// Scheduled school sync + portal sign-in status. Pure/logic layer; the Today
// page renders it. The clock lives in the renderer (the app must be open for a
// scheduled sync — there is no cloud waking a closed laptop; that's the future
// cloud-agent add-on), and portal login walls with 2FA are always the student's
// to clear, so a scheduled slot NUDGES via a native notification rather than
// silently spending tokens on a turn the student can't see.
import { loadSchoolPortals } from '@/lib/school-portals';
export const SYNC_CADENCE_KEY = 'nemesis.school.autosync.cadence.v1';
const LAST_NUDGE_KEY = 'nemesis.school.autosync.lastNudge.v1';
// The two slots a twice-daily cadence fires at (local hours): morning brief and
// early-evening catch-up — when new lecture posts and assignments actually land.
export const SYNC_HOURS_TWICE = [8, 18];
export const SYNC_HOURS_DAILY = [8];
// The student's configured portals (LMS + school email) — per-student, editable
// in Settings → Connections. Empty until the student connects their own; a fresh
// install ships with no pre-set school (see DEFAULT_SCHOOL_PORTALS).
export function schoolPortals() {
    return loadSchoolPortals();
}
export function loadCadence() {
    const raw = (() => {
        try {
            return window.localStorage.getItem(SYNC_CADENCE_KEY);
        }
        catch {
            return null;
        }
    })();
    return raw === 'daily' || raw === 'twice' || raw === 'off' ? raw : 'off';
}
export function saveCadence(cadence) {
    try {
        window.localStorage.setItem(SYNC_CADENCE_KEY, cadence);
    }
    catch {
        // persistence is best-effort
    }
}
function hoursFor(cadence) {
    if (cadence === 'twice') {
        return SYNC_HOURS_TWICE;
    }
    if (cadence === 'daily') {
        return SYNC_HOURS_DAILY;
    }
    return [];
}
/** A slot key like "2026-07-12@8" — one nudge per slot per day, at most. */
function slotKey(now, hour) {
    return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}@${hour}`;
}
/**
 * The scheduled slot that is currently DUE and not yet nudged, or null. Only the
 * LATEST slot whose hour has already passed today counts — `lastNudgedSlot` stores
 * a single value, so comparing against every earlier slot would re-fire the morning
 * one once evening overwrites it. Pure over (cadence, now, lastNudgedSlot).
 */
export function dueSlot(cadence, now, lastNudgedSlot) {
    const passed = hoursFor(cadence).filter(hour => now.getHours() >= hour);
    if (passed.length === 0) {
        return null;
    }
    const latest = slotKey(now, Math.max(...passed));
    return latest === lastNudgedSlot ? null : latest;
}
export function readLastNudge() {
    try {
        return window.localStorage.getItem(LAST_NUDGE_KEY);
    }
    catch {
        return null;
    }
}
export function writeLastNudge(slot) {
    try {
        window.localStorage.setItem(LAST_NUDGE_KEY, slot);
    }
    catch {
        // best-effort
    }
}
/** Are the school portals signed in? Cookie presence per origin (best-effort). */
export async function portalSignInStatus(portals = schoolPortals()) {
    const check = window.hermesDesktop?.schoolView?.connectionStatus;
    if (!check) {
        return {};
    }
    try {
        return await check(portals.map(portal => portal.origin));
    }
    catch {
        return {};
    }
}
