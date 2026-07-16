export const STUDY_DATA_DIR = '~/Documents/Nemesis Library/.study';
export const STUDY_STATE_FILE = `${STUDY_DATA_DIR}/state.json`;
export const TEST_ATTEMPTS_FILE = `${STUDY_DATA_DIR}/test-attempts.json`;
const MIRROR_DEBOUNCE_MS = 1500;
const MIRROR_VERSION = 1;
function bridge() {
    const api = typeof window === 'undefined' ? undefined : window.hermesDesktop;
    if (!api?.writeTextFile || !api.makeDir) {
        return null;
    }
    return api;
}
const pendingWrites = new Map();
let dirReady = false;
async function writeNow(path, text) {
    const api = bridge();
    if (!api) {
        return;
    }
    try {
        if (!dirReady) {
            await api.makeDir(STUDY_DATA_DIR);
            dirReady = true;
        }
        await api.writeTextFile(path, text);
    }
    catch {
        // Mirror is best-effort; localStorage still holds the truth.
    }
}
function scheduleMirror(path, serialize) {
    if (!bridge()) {
        return;
    }
    const existing = pendingWrites.get(path);
    if (existing) {
        clearTimeout(existing);
    }
    pendingWrites.set(path, setTimeout(() => {
        pendingWrites.delete(path);
        void writeNow(path, serialize());
    }, MIRROR_DEBOUNCE_MS));
}
function envelope(data) {
    const wrapped = { data, updatedAt: new Date().toISOString(), version: MIRROR_VERSION };
    return JSON.stringify(wrapped, null, 2);
}
export function mirrorStudyState(state) {
    scheduleMirror(STUDY_STATE_FILE, () => envelope(state));
}
export function mirrorTestAttempts(store) {
    scheduleMirror(TEST_ATTEMPTS_FILE, () => envelope(store));
}
async function readEnvelope(path, looksValid) {
    const api = bridge();
    if (!api) {
        return null;
    }
    try {
        const read = await api.readFileText(path);
        if (!read.text) {
            return null;
        }
        const parsed = JSON.parse(read.text);
        const data = parsed?.data;
        return looksValid(data) ? data : null;
    }
    catch {
        return null;
    }
}
function looksLikeStudyState(data) {
    const candidate = data;
    return Boolean(candidate && Array.isArray(candidate.decks) && typeof candidate.schedule === 'object');
}
function looksLikeAttemptsStore(data) {
    return Boolean(data) && typeof data === 'object' && !Array.isArray(data);
}
/** Disk copy of the study state, or null (no bridge, no file, unparseable). */
export function readDiskStudyState() {
    return readEnvelope(STUDY_STATE_FILE, looksLikeStudyState);
}
/** Disk copy of the test-attempt history, or null. */
export function readDiskTestAttempts() {
    return readEnvelope(TEST_ATTEMPTS_FILE, looksLikeAttemptsStore);
}
