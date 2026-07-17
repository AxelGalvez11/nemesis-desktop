// Phone-sync study bridge (sync spec Phases 2/3). Lives in the RENDERER on
// purpose: the study state's source of truth is renderer localStorage, and the
// FSRS apply path (model.ts gradeCard) lives here — the spec's hard rule is that
// phone grades and desktop grades flow through the SAME function.
//
// Two jobs share one 30s tick:
//   1. Snapshots DOWN — precompute every deck's due queue + stats into
//      `.study/phone-decks.json`; the main process splits that file into one
//      encrypted `kind: 'deck'` document per deck (see electron/main.ts
//      listPhoneDerivedDocs). Written only when deck content actually changed,
//      so the publisher isn't spammed with no-op republishes.
//   2. Grades UP→APPLIED — pull un-ingested review_events rows (RLS-scoped),
//      fold them through gradeCard, save, then stamp ingested_at. The
//      read-fold-write block is synchronous, so a concurrently open Study page
//      can never interleave a grade into the middle of it; the page reloads via
//      STUDY_STATE_EXTERNAL_CHANGE_EVENT (dispatched synchronously right after
//      the save, before any await, closing the clobber window).
import { restFetch } from '../../nemesis-account';
import { clozeIndexes, clozeScheduleKey, renderClozeAnswer, renderClozePrompt } from './cloze';
import { STUDY_DATA_DIR } from './disk-state';
import { buildQueue, deckStats, gradeCard, loadState, saveState } from './model';
export const STUDY_STATE_EXTERNAL_CHANGE_EVENT = 'nemesis:study-state-external-change';
export const PHONE_DECKS_FILE = `${STUDY_DATA_DIR}/phone-decks.json`;
const TICK_MS = 30_000;
const INGEST_LIMIT = 200;
const GRADES = new Set(['again', 'hard', 'good', 'easy']);
/** Precompute the phone's study material: per deck, today's queue (due order,
 *  daily caps — exactly what the desktop review surface would show) with
 *  pre-rendered cloze prompts, so the phone ships zero scheduler code. Pure. */
export function buildPhoneDecksPayload(state, now) {
    return {
        v: 1,
        asOf: now.toISOString(),
        decks: state.decks.map(deck => ({
            id: deck.id,
            name: deck.name,
            ...(deck.course ? { course: deck.course } : {}),
            stats: deckStats(state, deck.id, now),
            queue: buildQueue(state, deck.id, now).map(item => {
                const isCloze = item.clozeIndex !== undefined;
                const note = isCloze && item.card.back.trim() ? item.card.back : undefined;
                return {
                    key: item.scheduleKey,
                    prompt: isCloze ? renderClozePrompt(item.card.front, item.clozeIndex ?? 0) : item.card.front,
                    answer: isCloze ? renderClozeAnswer(item.card.front) : item.card.back,
                    ...(note ? { note } : {}),
                    isNew: item.isNew
                };
            })
        }))
    };
}
/** Fold phone grades into study state through the one true apply path. Grades
 *  for cards deleted since the phone's snapshot are counted as skipped (still
 *  stamped by the caller — gradeCard would otherwise mint orphan schedule
 *  entries). Reviews anchor to the phone's review time, clamped so clock skew
 *  can't schedule from the future. Pure. */
export function applyPhoneReviews(state, rows, now) {
    const validKeys = new Set();
    for (const deck of state.decks) {
        for (const card of deck.cards) {
            const indexes = clozeIndexes(card.front);
            if (indexes.length) {
                for (const index of indexes)
                    validKeys.add(clozeScheduleKey(card.id, index));
            }
            else {
                validKeys.add(card.id);
            }
        }
    }
    let next = state;
    let applied = 0;
    let skipped = 0;
    for (const row of rows) {
        if (!GRADES.has(row.grade) || !validKeys.has(row.schedule_key)) {
            skipped++;
            continue;
        }
        const reviewedAt = new Date(row.reviewed_at);
        const when = Number.isFinite(reviewedAt.getTime()) && reviewedAt.getTime() < now.getTime() ? reviewedAt : now;
        next = gradeCard(next, row.schedule_key, row.grade, when);
        applied++;
    }
    return { applied, skipped, state: next };
}
function looksLikeReviewRow(row) {
    const candidate = row;
    return Boolean(candidate &&
        typeof candidate.id === 'string' &&
        typeof candidate.schedule_key === 'string' &&
        typeof candidate.grade === 'string' &&
        typeof candidate.reviewed_at === 'string');
}
let running = false;
/** Start the background bridge; returns a stop function. Idempotent — a second
 *  call while running is a no-op (the shell mounts this exactly once). Runs even
 *  when signed out: snapshots are local-only, and restFetch no-ops the ingest. */
export function startPhoneStudySync() {
    if (running) {
        return () => { };
    }
    running = true;
    let busy = false;
    let lastDecksJson = null;
    const writeSnapshots = async (state) => {
        const payload = buildPhoneDecksPayload(state, new Date());
        // Change detection ignores asOf — otherwise every tick would look "new" and
        // the publisher would re-encrypt identical decks forever.
        const decksJson = JSON.stringify(payload.decks);
        if (decksJson === lastDecksJson) {
            return;
        }
        const api = window.hermesDesktop;
        if (!api?.writeTextFile || !api.makeDir) {
            return;
        }
        try {
            await api.makeDir(STUDY_DATA_DIR);
            await api.writeTextFile(PHONE_DECKS_FILE, JSON.stringify(payload));
            lastDecksJson = decksJson;
        }
        catch {
            // best-effort: the next tick retries
        }
    };
    const ingest = async () => {
        const res = await restFetch(`review_events?select=id,schedule_key,grade,reviewed_at&ingested_at=is.null&order=reviewed_at.asc&limit=${INGEST_LIMIT}`);
        if (!res?.ok) {
            return;
        }
        let rows;
        try {
            rows = await res.json();
        }
        catch {
            return;
        }
        const valid = Array.isArray(rows) ? rows.filter(looksLikeReviewRow) : [];
        if (!valid.length) {
            return;
        }
        // Synchronous read-fold-write-notify: no await between loadState and the
        // event dispatch, so an open Study page can neither interleave a grade nor
        // clobber the fold with a stale in-memory state.
        const folded = applyPhoneReviews(loadState(), valid, new Date());
        saveState(folded.state);
        try {
            window.dispatchEvent(new Event(STUDY_STATE_EXTERNAL_CHANGE_EVENT));
        }
        catch {
            // no-op outside a browser context
        }
        // Stamp AFTER the save. A crash between save and stamp re-applies these
        // rows next tick — the spec blesses that: worst case a card shows one extra
        // time, and no grade is ever lost.
        await restFetch(`review_events?id=in.(${valid.map(row => row.id).join(',')})`, {
            body: JSON.stringify({ ingested_at: new Date().toISOString() }),
            headers: { Prefer: 'return=minimal' },
            method: 'PATCH'
        });
    };
    const tick = async () => {
        if (busy) {
            return;
        }
        busy = true;
        try {
            await ingest();
            await writeSnapshots(loadState());
        }
        catch {
            // transient (network, bridge) — the next tick retries
        }
        finally {
            busy = false;
        }
    };
    void tick();
    const timer = setInterval(() => {
        void tick();
    }, TICK_MS);
    return () => {
        clearInterval(timer);
        running = false;
    };
}
