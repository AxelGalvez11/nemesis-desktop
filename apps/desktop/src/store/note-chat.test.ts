import { describe, expect, it } from 'vitest'

import { createNoteChatStore, NOTE_CHAT_SESSION_SOURCE, type NoteChatGatewayEvent } from './note-chat'

function harness() {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  let emit: (event: NoteChatGatewayEvent) => void = () => {}
  const store = createNoteChatStore({
    requestGateway: async (method, params = {}) => {
      calls.push({ method, params })
      if (method === 'session.create') return { session_id: 'sess-1' } as never
      return {} as never
    },
    subscribeEvents: cb => {
      emit = cb
      return () => {}
    }
  })
  return { store, calls, emit: (event: NoteChatGatewayEvent) => emit(event) }
}

describe('note-chat scoped store', () => {
  it('first turn creates a session once (tagged note-chat), then submits with it', async () => {
    const h = harness()
    await h.store.sendTurn('note:a.md', '@file:a.md\n\nExplain simpler')

    expect(h.calls.map(c => c.method)).toEqual(['session.create', 'prompt.submit'])
    expect(h.calls[0].params.source).toBe(NOTE_CHAT_SESSION_SOURCE)
    expect(h.calls[1].params.session_id).toBe('sess-1')

    const snap = h.store.getScopeSnapshot('note:a.md')
    expect(snap.messages[0].role).toBe('user')
    expect(snap.busy).toBe(true) // stays busy until the stream completes

    await h.store.sendTurn('note:a.md', 'follow up')
    expect(h.calls.filter(c => c.method === 'session.create')).toHaveLength(1)
  })

  it('streamed tokens accumulate into the assistant message; scopes stay isolated', async () => {
    const h = harness()
    await h.store.sendTurn('note:a.md', 'q')

    h.emit({ session_id: 'sess-1', type: 'message.delta', payload: { text: 'Hel' } })
    h.emit({ session_id: 'sess-1', type: 'message.delta', payload: { text: 'lo' } })

    // Mid-stream: accumulated, still streaming + busy.
    let snap = h.store.getScopeSnapshot('note:a.md')
    expect(snap.messages.at(-1)!.text).toBe('Hello')
    expect(snap.messages.at(-1)!.streaming).toBe(true)
    expect(snap.busy).toBe(true)

    // Complete with no text -> keeps the accumulated text, ends the turn.
    h.emit({ session_id: 'sess-1', type: 'message.complete', payload: {} })
    snap = h.store.getScopeSnapshot('note:a.md')
    expect(snap.messages.at(-1)!.text).toBe('Hello')
    expect(snap.messages.at(-1)!.streaming).toBeFalsy()
    expect(snap.busy).toBe(false)

    // A different scope is fully independent.
    expect(h.store.getScopeSnapshot('card:d:1').messages).toEqual([])
  })

  it('ignores events whose session id is not one of ours (the main chat cannot bleed in)', async () => {
    const h = harness()
    await h.store.sendTurn('note:a.md', 'q')
    // An event for a foreign session (e.g. the main chat) must not touch our scope.
    h.emit({ session_id: 'other-session', type: 'message.delta', payload: { text: 'leak' } })
    const snap = h.store.getScopeSnapshot('note:a.md')
    expect(snap.messages.some(m => m.role === 'assistant')).toBe(false)
  })

  it('surfaces a friendly error when the turn fails', async () => {
    const store = createNoteChatStore({
      requestGateway: async method => {
        if (method === 'session.create') return { session_id: 's' } as never
        throw new Error('boom')
      },
      subscribeEvents: () => () => {}
    })
    await store.sendTurn('note:x.md', 'hi')
    const snap = store.getScopeSnapshot('note:x.md')
    expect(snap.busy).toBe(false)
    expect(snap.messages.at(-1)!.error).toBe(true)
  })
})
