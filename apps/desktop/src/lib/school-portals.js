// The student's OWN school portals (LMS + school email) — the one piece of school
// identity that differs per student. Blackboard-at-UTHSC was hardcoded while Nemesis
// had a single user (the owner); every other student needs their own address here.
// localStorage is the UI's source of truth; every save is mirrored to
// ~/Documents/Nemesis Library/.nemesis/portals.json so the AGENT navigates to the
// same portal the app shows (see the nemesis-school-sync skill). The mirror is
// one-way (app → file): the agent reads it and sends students to Settings →
// Connections to change it.
const STORE_KEY = 'nemesis.school.portals.v1';
const PORTALS_FILE = '~/Documents/Nemesis Library/.nemesis/portals.json';
export const PORTALS_CHANGED_EVENT = 'nemesis:school-portals-changed';
// First-run defaults = the owner's own school, so existing installs behave
// exactly as before until a student sets their own portal.
export const DEFAULT_SCHOOL_PORTALS = [
    {
        id: 'lms',
        kind: 'lms',
        name: 'Blackboard',
        origin: 'https://blackboard.uthsc.edu',
        url: 'https://blackboard.uthsc.edu/'
    },
    {
        id: 'email',
        kind: 'email',
        name: 'Outlook',
        origin: 'https://outlook.cloud.microsoft',
        url: 'https://outlook.cloud.microsoft/mail/'
    }
];
/** Best-effort brand detection so the row reads "Canvas", not a bare URL. */
export function lmsNameFor(url) {
    const host = originOf(url).replace(/^https?:\/\//, '').toLowerCase();
    if (host.includes('blackboard')) {
        return 'Blackboard';
    }
    if (host.includes('canvas') || host.includes('instructure')) {
        return 'Canvas';
    }
    if (host.includes('brightspace') || host.includes('d2l')) {
        return 'Brightspace';
    }
    if (host.includes('moodle')) {
        return 'Moodle';
    }
    if (host.includes('schoology')) {
        return 'Schoology';
    }
    return 'School portal';
}
function originOf(url) {
    try {
        return new URL(url).origin;
    }
    catch {
        return url;
    }
}
/** "blackboard.myschool.edu" → "https://blackboard.myschool.edu/", or null if unparseable. */
export function normalizePortalUrl(raw) {
    const trimmed = raw.trim();
    if (!trimmed) {
        return null;
    }
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
        return new URL(withScheme).toString();
    }
    catch {
        return null;
    }
}
export function loadSchoolPortals() {
    try {
        const raw = window.localStorage.getItem(STORE_KEY);
        if (!raw) {
            return DEFAULT_SCHOOL_PORTALS;
        }
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.length === 0) {
            return DEFAULT_SCHOOL_PORTALS;
        }
        const portals = parsed.filter((entry) => Boolean(entry) &&
            typeof entry.url === 'string' &&
            typeof entry.name === 'string');
        return portals.length > 0 ? portals : DEFAULT_SCHOOL_PORTALS;
    }
    catch {
        return DEFAULT_SCHOOL_PORTALS;
    }
}
export function saveSchoolPortals(portals) {
    try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify(portals));
    }
    catch {
        // persistence is best-effort
    }
    void mirrorToVault(portals);
    window.dispatchEvent(new Event(PORTALS_CHANGED_EVENT));
}
/** Replace the LMS entry with the given URL; returns the new list (already saved). */
export function setSchoolLms(url) {
    const normalized = normalizePortalUrl(url);
    if (!normalized) {
        return loadSchoolPortals();
    }
    const lms = {
        id: 'lms',
        kind: 'lms',
        name: lmsNameFor(normalized),
        origin: originOf(normalized),
        url: normalized
    };
    const next = [lms, ...loadSchoolPortals().filter(portal => portal.kind !== 'lms')];
    saveSchoolPortals(next);
    return next;
}
/** Keep the agent-facing file current even if the student never edits anything. */
export function ensurePortalsMirrored() {
    void mirrorToVault(loadSchoolPortals());
}
// The agent-facing mirror. Shape is deliberately plain JSON the skill documents:
// { "portals": [{ "kind": "lms", "name": "Canvas", "url": "https://..." }] }
async function mirrorToVault(portals) {
    const api = window.hermesDesktop;
    if (!api?.writeTextFile) {
        return;
    }
    try {
        await api.makeDir?.('~/Documents/Nemesis Library/.nemesis');
        await api.writeTextFile(PORTALS_FILE, `${JSON.stringify({ portals: portals.map(({ kind, name, url }) => ({ kind, name, url })) }, null, 2)}\n`);
    }
    catch {
        // best-effort: the agent falls back to asking the student
    }
}
