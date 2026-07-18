import { $gateway } from '@/store/gateway';
// The distinct session `source` for mini-chat turns. These are REAL backend
// sessions (the local agent needs one to read files / write flashcards), so we
// tag them with their own source and exclude that source from the Sessions
// sidebar + search — the same bucketing cron/messaging sessions already use — so
// a per-note/card conversation never surfaces in the main chat history.
export const NOTE_CHAT_SESSION_SOURCE = 'note-chat';
// prompt.submit is fire-and-forget: the turn is delivered via streamed events,
// not the RPC return, so mirror the main chat's long ack ceiling.
const PROMPT_SUBMIT_TIMEOUT_MS = 1_800_000;
// Stable empty state so getScopeSnapshot returns a referentially-stable value for
// untouched scopes (required by useSyncExternalStore).
const EMPTY_SCOPE = { sessionId: null, busy: false, messages: [] };
function coerceText(value) {
    if (typeof value === 'string')
        return value;
    if (value && typeof value === 'object' && typeof value.text === 'string') {
        return value.text;
    }
    return '';
}
/**
 * A scoped mini-chat store: one independent agent conversation per scope key (a
 * note path, or `card:<deckId>:<cardId>`). Deliberately dependency-injected and
 * framework-free so it can be unit-tested with fakes and, critically, so it NEVER
 * touches the app-wide singleton session atoms ($messages, $activeSessionId, ...).
 * It owns its own message lists and routes streamed gateway events to the scope
 * whose session id matches — so the main chat can neither disturb nor be disturbed.
 */
export function createNoteChatStore(deps) {
    const scopes = new Map();
    const listeners = new Map();
    // sessionId -> scopeKey. Only OUR sessions live here, so an event whose session
    // id isn't a key routes to nothing — foreign sessions (the main chat) are
    // ignored by construction.
    const scopeBySession = new Map();
    const snapshot = (scopeKey) => scopes.get(scopeKey) ?? EMPTY_SCOPE;
    const emit = (scopeKey) => {
        const set = listeners.get(scopeKey);
        if (set)
            for (const cb of set)
                cb();
    };
    const update = (scopeKey, fn) => {
        scopes.set(scopeKey, fn(scopes.get(scopeKey) ?? { sessionId: null, busy: false, messages: [] }));
        emit(scopeKey);
    };
    const appendAssistantDelta = (scopeKey, delta) => {
        if (!delta)
            return;
        update(scopeKey, state => {
            const messages = state.messages.slice();
            const last = messages[messages.length - 1];
            if (last && last.role === 'assistant' && last.streaming) {
                messages[messages.length - 1] = { ...last, text: last.text + delta };
            }
            else {
                messages.push({ role: 'assistant', text: delta, streaming: true });
            }
            return { ...state, messages };
        });
    };
    const completeAssistant = (scopeKey, finalText) => {
        update(scopeKey, state => {
            const messages = state.messages.slice();
            const last = messages[messages.length - 1];
            if (last && last.role === 'assistant' && last.streaming) {
                messages[messages.length - 1] = { role: 'assistant', text: finalText || last.text, streaming: false };
            }
            else if (finalText) {
                messages.push({ role: 'assistant', text: finalText, streaming: false });
            }
            return { ...state, messages, busy: false };
        });
    };
    const failAssistant = (scopeKey, message) => {
        update(scopeKey, state => {
            const messages = state.messages.slice();
            const last = messages[messages.length - 1];
            if (last && last.role === 'assistant' && last.streaming) {
                messages[messages.length - 1] = { role: 'assistant', text: last.text || message, streaming: false, error: true };
            }
            else {
                messages.push({ role: 'assistant', text: message, streaming: false, error: true });
            }
            return { ...state, messages, busy: false };
        });
    };
    deps.subscribeEvents(event => {
        const sessionId = event.session_id;
        if (!sessionId)
            return;
        const scopeKey = scopeBySession.get(sessionId);
        if (!scopeKey)
            return;
        if (event.type === 'message.delta') {
            appendAssistantDelta(scopeKey, coerceText(event.payload?.text));
        }
        else if (event.type === 'message.complete') {
            completeAssistant(scopeKey, coerceText(event.payload?.text) || coerceText(event.payload?.rendered));
        }
        else if (event.type === 'error') {
            failAssistant(scopeKey, 'That request could not be completed.');
        }
    });
    const sendTurn = async (scopeKey, text) => {
        if (!text.trim())
            return;
        update(scopeKey, state => ({ ...state, busy: true, messages: [...state.messages, { role: 'user', text }] }));
        let sessionId = snapshot(scopeKey).sessionId;
        if (!sessionId) {
            try {
                const created = await deps.requestGateway('session.create', {
                    cols: 96,
                    source: NOTE_CHAT_SESSION_SOURCE
                });
                sessionId = created.session_id;
                update(scopeKey, state => ({ ...state, sessionId }));
                scopeBySession.set(sessionId, scopeKey);
            }
            catch {
                failAssistant(scopeKey, 'Could not start a chat session.');
                return;
            }
        }
        try {
            await deps.requestGateway('prompt.submit', { session_id: sessionId, text }, PROMPT_SUBMIT_TIMEOUT_MS);
        }
        catch {
            failAssistant(scopeKey, 'Could not send that message.');
        }
    };
    const subscribeScope = (scopeKey, cb) => {
        let set = listeners.get(scopeKey);
        if (!set) {
            set = new Set();
            listeners.set(scopeKey, set);
        }
        set.add(cb);
        return () => void set.delete(cb);
    };
    const reset = (scopeKey) => {
        const existing = scopes.get(scopeKey);
        if (existing?.sessionId)
            scopeBySession.delete(existing.sessionId);
        scopes.set(scopeKey, { sessionId: null, busy: false, messages: [] });
        emit(scopeKey);
    };
    return { getScopeSnapshot: snapshot, subscribeScope, sendTurn, reset };
}
// ── Real-app singleton, wired to the live gateway ───────────────────────────
// Reads $gateway at call time so it follows the swapping active-profile socket (a
// one-time capture would go deaf on a profile switch).
const liveRequestGateway = (method, params = {}, timeoutMs) => {
    const gateway = $gateway.get();
    if (!gateway)
        return Promise.reject(new Error('Nemesis local service unavailable'));
    return gateway.request(method, params, timeoutMs);
};
// Re-attaches the event listener whenever $gateway swaps instances.
const subscribeGatewayEvents = cb => {
    let off = () => { };
    const unsubscribe = $gateway.subscribe(gateway => {
        off();
        off = gateway ? gateway.onEvent(event => cb(event)) : () => { };
    });
    return () => {
        off();
        unsubscribe();
    };
};
let singleton = null;
/** The app-wide mini-chat store, created lazily and wired to the live gateway. */
export function getNoteChatStore() {
    if (!singleton) {
        singleton = createNoteChatStore({ requestGateway: liveRequestGateway, subscribeEvents: subscribeGatewayEvents });
    }
    return singleton;
}
