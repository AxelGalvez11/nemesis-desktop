/**
 * Tests for electron/mission-runner.ts.
 *
 * Run with: node --test electron/mission-runner.test.ts
 *
 * Recon (Task 3 Step 1) — the chat UI's session-open/send-message path and
 * the 3 signatures mission-runner.ts is built against:
 *
 * 1. `apps/shared/src/json-rpc-gateway.ts` — JsonRpcGatewayClient, the class
 *    the renderer's HermesGateway (apps/desktop/src/hermes.ts) subclasses:
 *      connect(wsUrl: string): Promise<void>
 *      request<T>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>
 *      on<P>(type: GatewayEventName, handler: (event: GatewayEvent<P>) => void): () => void   // returns unsubscribe
 *      close(): void
 *
 * 2. `src/app/session/hooks/use-session-actions/index.ts` — opening a session
 *    ("New Session" / the composer's first send) calls:
 *      requestGateway<SessionCreateResponse>('session.create', { cols: 96, source: 'desktop', ... })
 *    which resolves `{ session_id, stored_session_id, ... }`.
 *
 * 3. `src/app/session/hooks/use-prompt-actions/submit.ts` +
 *    `src/app/session/hooks/use-message-stream/gateway-event.ts` — sending a
 *    typed message calls:
 *      requestGateway('prompt.submit', { session_id, text }, PROMPT_SUBMIT_REQUEST_TIMEOUT_MS)
 *    which is "effectively fire-and-forget": the RPC ack is not the turn
 *    result. The turn's text streams as `message.delta` events
 *    (`payload.text` chunks) and resolves on a `message.complete` event
 *    (`payload.text`), both filtered by `event.session_id`; a failed turn
 *    fires an `error` event instead (`payload.message`).
 *
 * mission-runner.ts is deliberately NOT built against HermesGateway/the
 * renderer's requestGateway wrapper (those are renderer-only, UI-coupled).
 * It talks to the same gateway wire protocol through a small injected
 * MissionGateway facade (connect/request/on/close) so it's fully unit
 * testable and Task 5 can wire a real JsonRpcGatewayClient into it.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createMissionRunner, type MissionGateway } from './mission-runner'

test('sends the mission prompt with the standing header, streams deltas to onLog, and resolves with the final message', async () => {
  const requests: Array<{ method: string; params?: Record<string, unknown> }> = []
  const handlers = new Map<string, (event: any) => void>()

  const gateway: MissionGateway = {
    connect: async () => {},
    request: async <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> => {
      requests.push({ method, params })
      if (method === 'session.create') return { session_id: 'sess-1' } as T
      if (method === 'prompt.submit') {
        queueMicrotask(() => {
          handlers.get('message.delta')?.({ type: 'message.delta', session_id: 'sess-1', payload: { text: 'Working' } })
          handlers.get('message.delta')?.({ type: 'message.delta', session_id: 'sess-1', payload: { text: ' on it' } })
          handlers.get('message.complete')?.({
            type: 'message.complete',
            session_id: 'sess-1',
            payload: { text: 'Working on it. Draft ready.' }
          })
        })
      }
      return {} as T
    },
    on: (type, handler) => {
      handlers.set(type, handler)
      return () => handlers.delete(type)
    },
    close: () => {}
  }

  const logs: string[] = []
  const result = await createMissionRunner(gateway)('Make 5 flashcards', (line) => logs.push(line))

  assert.equal(result.ok, true)
  assert.equal(result.summary, 'Working on it. Draft ready.')
  assert.deepEqual(logs, ['Working', ' on it'])

  const submit = requests.find((r) => r.method === 'prompt.submit')
  assert.ok(submit, 'expected a prompt.submit request')
  assert.equal(submit!.params?.session_id, 'sess-1')
  assert.match(String(submit!.params?.text), /^\[Dispatched from the student's phone\./)
  assert.match(String(submit!.params?.text), /Never submit anything to a school portal\.\]/)
  assert.match(String(submit!.params?.text), /Make 5 flashcards$/)
})

test('truncates the final summary to 500 characters', async () => {
  const long = 'x'.repeat(600)
  let completeHandler: ((event: any) => void) | undefined

  const gateway: MissionGateway = {
    connect: async () => {},
    request: async <T = unknown>(method: string): Promise<T> => {
      if (method === 'session.create') return { session_id: 's1' } as T
      if (method === 'prompt.submit') {
        queueMicrotask(() => completeHandler?.({ type: 'message.complete', session_id: 's1', payload: { text: long } }))
      }
      return {} as T
    },
    on: (type, handler) => {
      if (type === 'message.complete') completeHandler = handler
      return () => {}
    },
    close: () => {}
  }

  const result = await createMissionRunner(gateway)('p', () => {})
  assert.equal(result.ok, true)
  assert.equal(result.summary.length, 500)
  assert.equal(result.summary, long.slice(0, 500))
})

test('resolves from background.complete too — a headless session may route completion there instead of message.complete', async () => {
  let backgroundCompleteHandler: ((event: any) => void) | undefined

  const gateway: MissionGateway = {
    connect: async () => {},
    request: async <T = unknown>(method: string): Promise<T> => {
      if (method === 'session.create') return { session_id: 's1' } as T
      if (method === 'prompt.submit') {
        queueMicrotask(() =>
          backgroundCompleteHandler?.({ type: 'background.complete', session_id: 's1', payload: { text: 'done in the background' } })
        )
      }
      return {} as T
    },
    on: (type, handler) => {
      if (type === 'background.complete') backgroundCompleteHandler = handler
      return () => {}
    },
    close: () => {}
  }

  const result = await createMissionRunner(gateway)('p', () => {})
  assert.equal(result.ok, true)
  assert.equal(result.summary, 'done in the background')
})

test('a mid-turn error event resolves { ok: false } instead of throwing', async () => {
  let errorHandler: ((event: any) => void) | undefined

  const gateway: MissionGateway = {
    connect: async () => {},
    request: async <T = unknown>(method: string): Promise<T> => {
      if (method === 'session.create') return { session_id: 's1' } as T
      if (method === 'prompt.submit') {
        queueMicrotask(() => errorHandler?.({ type: 'error', session_id: 's1', payload: { message: 'provider timeout' } }))
      }
      return {} as T
    },
    on: (type, handler) => {
      if (type === 'error') errorHandler = handler
      return () => {}
    },
    close: () => {}
  }

  const result = await createMissionRunner(gateway)('p', () => {})
  assert.equal(result.ok, false)
  assert.match(result.summary, /provider timeout/)
})

test('a gateway connect failure resolves { ok: false } instead of throwing, and still closes', async () => {
  let closed = false
  const gateway: MissionGateway = {
    connect: async () => {
      throw new Error('gateway offline')
    },
    request: async () => {
      throw new Error('request should not be called when connect fails')
    },
    on: () => () => {},
    close: () => {
      closed = true
    }
  }

  const result = await createMissionRunner(gateway)('p', () => {})
  assert.equal(result.ok, false)
  assert.match(result.summary, /gateway offline/)
  assert.equal(closed, true)
})

test('a session.create failure resolves { ok: false } instead of throwing', async () => {
  const gateway: MissionGateway = {
    connect: async () => {},
    request: async <T = unknown>(method: string): Promise<T> => {
      if (method === 'session.create') throw new Error('no backend')
      return {} as T
    },
    on: () => () => {},
    close: () => {}
  }

  const result = await createMissionRunner(gateway)('p', () => {})
  assert.equal(result.ok, false)
  assert.match(result.summary, /no backend/)
})

test('gives up and resolves { ok: false } if message.complete never arrives within the timeout', async () => {
  let closed = false
  const gateway: MissionGateway = {
    connect: async () => {},
    request: async <T = unknown>(method: string): Promise<T> => {
      if (method === 'session.create') return { session_id: 's1' } as T
      return {} as T // prompt.submit "acks" but no stream/complete event ever fires
    },
    on: () => () => {},
    close: () => {
      closed = true
    }
  }

  const result = await createMissionRunner(gateway, { completionTimeoutMs: 25 })('p', () => {})
  assert.equal(result.ok, false)
  assert.match(result.summary, /timed out/i)
  assert.equal(closed, true)
})

test('ignores stream events addressed to a different session id', async () => {
  let deltaHandler: ((event: any) => void) | undefined
  let completeHandler: ((event: any) => void) | undefined

  const gateway: MissionGateway = {
    connect: async () => {},
    request: async <T = unknown>(method: string): Promise<T> => {
      if (method === 'session.create') return { session_id: 'sess-mine' } as T
      if (method === 'prompt.submit') {
        queueMicrotask(() => {
          deltaHandler?.({ type: 'message.delta', session_id: 'sess-other', payload: { text: 'not mine' } })
          completeHandler?.({ type: 'message.complete', session_id: 'sess-other', payload: { text: 'not mine either' } })
          completeHandler?.({ type: 'message.complete', session_id: 'sess-mine', payload: { text: 'mine' } })
        })
      }
      return {} as T
    },
    on: (type, handler) => {
      if (type === 'message.delta') deltaHandler = handler
      if (type === 'message.complete') completeHandler = handler
      return () => {}
    },
    close: () => {}
  }

  const logs: string[] = []
  const result = await createMissionRunner(gateway)('p', (line) => logs.push(line))
  assert.equal(result.ok, true)
  assert.equal(result.summary, 'mine')
  assert.deepEqual(logs, [])
})
