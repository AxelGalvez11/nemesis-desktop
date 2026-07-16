/**
 * Tests for electron/mission-gateway.ts — the load-bearing piece once
 * mission-runner.ts's tests only exercise the MissionGateway facade via a
 * fake: THIS module has to get the real wire framing right, since nothing
 * else checks it. Framing asserted here is copied from
 * apps/shared/src/json-rpc-gateway.ts (the renderer's real gateway client):
 *   - outbound request: {jsonrpc:'2.0', id, method, params}
 *   - inbound response: a frame carrying `id` resolves/rejects the pending
 *     call keyed by that id (frame.result / frame.error.message)
 *   - inbound server event: {method:'event', params:{type, session_id,
 *     payload}} — dispatched to handlers keyed by params.type
 *
 * Run with: node --test electron/mission-gateway.test.ts
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createWebSocketMissionGateway } from './mission-gateway'

function fakeSocket() {
  const listeners = new Map<string, Set<(event: any) => void>>()
  const sent: any[] = []

  const socket = {
    readyState: 0, // CONNECTING
    send: (data: string) => sent.push(JSON.parse(data)),
    close: () => {
      socket.readyState = 3 // CLOSED
      fire('close', {})
    },
    addEventListener: (type: string, handler: (event: any) => void) => {
      let set = listeners.get(type)
      if (!set) {
        set = new Set()
        listeners.set(type, set)
      }
      set.add(handler)
    }
  }

  function fire(type: string, event: any) {
    for (const handler of listeners.get(type) ?? []) handler(event)
  }

  function open() {
    socket.readyState = 1 // OPEN
    fire('open', {})
  }

  function receive(frame: unknown) {
    fire('message', { data: JSON.stringify(frame) })
  }

  return { socket, sent, open, receive }
}

// getWsUrl is itself async, so gateway.connect() only reaches
// createSocket()/addEventListener('open', ...) after a microtask hop —
// firing `fake.open()` synchronously right after calling connect() would
// race that and be missed. Auto-opening on a macrotask (scheduled from
// inside createSocket, once the listener is guaranteed registered) sidesteps
// the race entirely for every test that just wants an already-open gateway.
async function connectedGateway() {
  const fake = fakeSocket()
  const gateway = createWebSocketMissionGateway({
    getWsUrl: async () => 'wss://example.test/ws',
    createSocket: () => {
      setTimeout(() => fake.open(), 0)
      return fake.socket as any
    }
  })
  await gateway.connect()
  return { gateway, fake }
}

test('connect waits for the socket to open before resolving', async () => {
  const fake = fakeSocket()
  const gateway = createWebSocketMissionGateway({
    getWsUrl: async () => 'wss://example.test/ws',
    createSocket: () => fake.socket as any
  })

  let connected = false
  const connecting = gateway.connect().then(() => {
    connected = true
  })

  // Yield past connect()'s internal `await getWsUrl()` hop (and therefore
  // past its 'open' listener registration) via a macrotask, not a microtask.
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(connected, false, 'must not resolve before the socket fires open')

  fake.open()
  await connecting
  assert.equal(connected, true)
})

test('request sends a jsonrpc frame and resolves from the response carrying the matching id', async () => {
  const { gateway, fake } = await connectedGateway()

  const resultPromise = gateway.request('session.create', { cols: 96, source: 'desktop' })
  assert.equal(fake.sent.length, 1)
  assert.equal(fake.sent[0].jsonrpc, '2.0')
  assert.equal(fake.sent[0].method, 'session.create')
  assert.deepEqual(fake.sent[0].params, { cols: 96, source: 'desktop' })
  assert.ok(fake.sent[0].id !== undefined && fake.sent[0].id !== null)

  fake.receive({ id: fake.sent[0].id, result: { session_id: 'sess-1' } })
  assert.deepEqual(await resultPromise, { session_id: 'sess-1' })
})

test('a response frame carrying error rejects the matching pending request', async () => {
  const { gateway, fake } = await connectedGateway()

  const resultPromise = gateway.request('prompt.submit', { session_id: 's1', text: 'hi' })
  fake.receive({ id: fake.sent[0].id, error: { message: 'boom' } })
  await assert.rejects(() => resultPromise, /boom/)
})

test('server events arrive wrapped as {method: "event", params}, dispatched by params.type only', async () => {
  const { gateway, fake } = await connectedGateway()

  const received: any[] = []
  gateway.on('message.delta', (event) => received.push(event))

  fake.receive({ method: 'event', params: { type: 'message.delta', session_id: 's1', payload: { text: 'hi' } } })
  // A frame for a different type must not reach the message.delta handler.
  fake.receive({ method: 'event', params: { type: 'message.complete', session_id: 's1', payload: { text: 'done' } } })

  assert.equal(received.length, 1)
  assert.deepEqual(received[0], { type: 'message.delta', session_id: 's1', payload: { text: 'hi' } })
})

test('unsubscribe stops further delivery to that handler', async () => {
  const { gateway, fake } = await connectedGateway()

  const received: any[] = []
  const unsubscribe = gateway.on('message.delta', (event) => received.push(event))
  unsubscribe()

  fake.receive({ method: 'event', params: { type: 'message.delta', session_id: 's1', payload: { text: 'hi' } } })
  assert.equal(received.length, 0)
})

test('request rejects on timeout instead of waiting forever for a late response', async () => {
  const { gateway } = await connectedGateway()
  await assert.rejects(() => gateway.request('slow.method', {}, 10), /timed out/)
})

test('request rejects immediately when there is no open connection', async () => {
  const gateway = createWebSocketMissionGateway({
    getWsUrl: async () => 'wss://example.test/ws',
    createSocket: () => fakeSocket().socket as any
  })
  await assert.rejects(() => gateway.request('session.create'), /not connected/)
})

test('close rejects all pending requests and further requests are refused', async () => {
  const { gateway } = await connectedGateway()

  const pending = gateway.request('session.create')
  gateway.close()

  await assert.rejects(() => pending, /closed/)
  await assert.rejects(() => gateway.request('prompt.submit'), /not connected/)
})
