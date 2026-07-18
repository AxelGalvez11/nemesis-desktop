import { $gateway } from '@/store/gateway'

// The distinct session `source` for mini-chat turns. These are REAL backend
// sessions (the local agent needs one to read files / write flashcards), so we
// tag them with their own source and exclude that source from the Sessions
// sidebar + search — the same bucketing cron/messaging sessions already use — so
// a per-note/card conversation never surfaces in the main chat history.
export const NOTE_CHAT_SESSION_SOURCE = 'note-chat'

// prompt.submit is fire-and-forget: the turn is delivered via streamed events,
// not the RPC return, so mirror the main chat's long ack ceiling.
const PROMPT_SUBMIT_TIMEOUT_MS = 1_800_000

export type NoteChatRole = 'user' | 'assistant'

export interface NoteChatMessage {
  role: NoteChatRole
  text: string
  streaming?: boolean
  error?: boolean
}

export interface ScopeState {
  sessionId: string | null
  busy: boolean
  messages: NoteChatMessage[]
}

/** The subset of a gateway event this store consumes. */
export interface NoteChatGatewayEvent {
  type: string
  session_id?: string
  payload?: { text?: unknown; rendered?: unknown }
}

export type RequestGatewayFn = <T = unknown>(
  method: string,
  params?: Record<string, unknown>,
  timeoutMs?: number
) => Promise<T>

export type SubscribeEventsFn = (cb: (event: NoteChatGatewayEvent) => void) => () => void

export interface NoteChatStore {
  getScopeSnapshot: (scopeKey: string) => ScopeState
  subscribeScope: (scopeKey: string, cb: () => void) => () => void
  sendTurn: (scopeKey: string, text: string) => Promise<void>
  reset: (scopeKey: string) => void
}

// Stable empty state so getScopeSnapshot returns a referentially-stable value for
// untouched scopes (required by useSyncExternalStore).
const EMPTY_SCOPE: ScopeState = { sessionId: null, busy: false, messages: [] }

function coerceText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && typeof (value as { text?: unknown }).text === 'string') {
    return (value as { text: string }).text
  }
  return ''
}

/**
 * A scoped mini-chat store: one independent agent conversation per scope key (a
 * note path, or `card:<deckId>:<cardId>`). Deliberately dependency-injected and
 * framework-free so it can be unit-tested with fakes and, critically, so it NEVER
 * touches the app-wide singleton session atoms ($messages, $activeSessionId, ...).
 * It owns its own message lists and routes streamed gateway events to the scope
 * whose session id matches — so the main chat can neither disturb nor be disturbed.
 */
export function createNoteChatStore(deps: {
  requestGateway: RequestGatewayFn
  subscribeEvents: SubscribeEventsFn
}): NoteChatStore {
  const scopes = new Map<string, ScopeState>()
  const listeners = new Map<string, Set<() => void>>()
  // sessionId -> scopeKey. Only OUR sessions live here, so an event whose session
  // id isn't a key routes to nothing — foreign sessions (the main chat) are
  // ignored by construction.
  const scopeBySession = new Map<string, string>()

  const snapshot = (scopeKey: string): ScopeState => scopes.get(scopeKey) ?? EMPTY_SCOPE

  const emit = (scopeKey: string): void => {
    const set = listeners.get(scopeKey)
    if (set) for (const cb of set) cb()
  }

  const update = (scopeKey: string, fn: (state: ScopeState) => ScopeState): void => {
    scopes.set(scopeKey, fn(scopes.get(scopeKey) ?? { sessionId: null, busy: false, messages: [] }))
    emit(scopeKey)
  }

  const appendAssistantDelta = (scopeKey: string, delta: string): void => {
    if (!delta) return
    update(scopeKey, state => {
      const messages = state.messages.slice()
      const last = messages[messages.length - 1]
      if (last && last.role === 'assistant' && last.streaming) {
        messages[messages.length - 1] = { ...last, text: last.text + delta }
      } else {
        messages.push({ role: 'assistant', text: delta, streaming: true })
      }
      return { ...state, messages }
    })
  }

  const completeAssistant = (scopeKey: string, finalText: string): void => {
    update(scopeKey, state => {
      const messages = state.messages.slice()
      const last = messages[messages.length - 1]
      if (last && last.role === 'assistant' && last.streaming) {
        messages[messages.length - 1] = { role: 'assistant', text: finalText || last.text, streaming: false }
      } else if (finalText) {
        messages.push({ role: 'assistant', text: finalText, streaming: false })
      }
      return { ...state, messages, busy: false }
    })
  }

  const failAssistant = (scopeKey: string, message: string): void => {
    update(scopeKey, state => {
      const messages = state.messages.slice()
      const last = messages[messages.length - 1]
      if (last && last.role === 'assistant' && last.streaming) {
        messages[messages.length - 1] = { role: 'assistant', text: last.text || message, streaming: false, error: true }
      } else {
        messages.push({ role: 'assistant', text: message, streaming: false, error: true })
      }
      return { ...state, messages, busy: false }
    })
  }

  deps.subscribeEvents(event => {
    const sessionId = event.session_id
    if (!sessionId) return
    const scopeKey = scopeBySession.get(sessionId)
    if (!scopeKey) return
    if (event.type === 'message.delta') {
      appendAssistantDelta(scopeKey, coerceText(event.payload?.text))
    } else if (event.type === 'message.complete') {
      completeAssistant(scopeKey, coerceText(event.payload?.text) || coerceText(event.payload?.rendered))
    } else if (event.type === 'error') {
      failAssistant(scopeKey, 'That request could not be completed.')
    }
  })

  const sendTurn = async (scopeKey: string, text: string): Promise<void> => {
    if (!text.trim()) return
    update(scopeKey, state => ({ ...state, busy: true, messages: [...state.messages, { role: 'user', text }] }))

    let sessionId = snapshot(scopeKey).sessionId
    if (!sessionId) {
      try {
        const created = await deps.requestGateway<{ session_id: string }>('session.create', {
          cols: 96,
          source: NOTE_CHAT_SESSION_SOURCE
        })
        sessionId = created.session_id
        update(scopeKey, state => ({ ...state, sessionId }))
        scopeBySession.set(sessionId, scopeKey)
      } catch {
        failAssistant(scopeKey, 'Could not start a chat session.')
        return
      }
    }

    try {
      await deps.requestGateway('prompt.submit', { session_id: sessionId, text }, PROMPT_SUBMIT_TIMEOUT_MS)
    } catch {
      failAssistant(scopeKey, 'Could not send that message.')
    }
  }

  const subscribeScope = (scopeKey: string, cb: () => void): (() => void) => {
    let set = listeners.get(scopeKey)
    if (!set) {
      set = new Set()
      listeners.set(scopeKey, set)
    }
    set.add(cb)
    return () => void set.delete(cb)
  }

  const reset = (scopeKey: string): void => {
    const existing = scopes.get(scopeKey)
    if (existing?.sessionId) scopeBySession.delete(existing.sessionId)
    scopes.set(scopeKey, { sessionId: null, busy: false, messages: [] })
    emit(scopeKey)
  }

  return { getScopeSnapshot: snapshot, subscribeScope, sendTurn, reset }
}

// ── Real-app singleton, wired to the live gateway ───────────────────────────

// Reads $gateway at call time so it follows the swapping active-profile socket (a
// one-time capture would go deaf on a profile switch).
const liveRequestGateway: RequestGatewayFn = <T,>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs?: number
): Promise<T> => {
  const gateway = $gateway.get()
  if (!gateway) return Promise.reject(new Error('Nemesis local service unavailable'))
  return gateway.request<T>(method, params, timeoutMs)
}

// Re-attaches the event listener whenever $gateway swaps instances.
const subscribeGatewayEvents: SubscribeEventsFn = cb => {
  let off: () => void = () => {}
  const unsubscribe = $gateway.subscribe(gateway => {
    off()
    off = gateway ? gateway.onEvent(event => cb(event as NoteChatGatewayEvent)) : () => {}
  })
  return () => {
    off()
    unsubscribe()
  }
}

let singleton: NoteChatStore | null = null

/** The app-wide mini-chat store, created lazily and wired to the live gateway. */
export function getNoteChatStore(): NoteChatStore {
  if (!singleton) {
    singleton = createNoteChatStore({ requestGateway: liveRequestGateway, subscribeEvents: subscribeGatewayEvents })
  }
  return singleton
}
