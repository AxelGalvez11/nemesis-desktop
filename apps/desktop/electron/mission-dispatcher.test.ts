/**
 * Tests for electron/mission-dispatcher.ts.
 *
 * Run with: node --test electron/mission-dispatcher.test.ts
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createMissionDispatcher } from './mission-dispatcher'

const URL_BASE = 'https://example.supabase.co'

// A real access token must be a Supabase user JWT (RLS resolves auth.uid()
// from it) — NOT the nmk_ metering key used for the LLM proxy. The dispatcher
// decodes the payload segment to get `sub` for mission_events.user_id, so the
// fake token needs a real base64url JSON payload, not an opaque string.
const FAKE_JWT = `x.${Buffer.from(JSON.stringify({ sub: 'user-1' })).toString('base64')}.y`

function fakeFetch(queue: Array<{ match: (url: string, init?: RequestInit) => boolean; respond: () => Response }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const impl = (async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const hit = queue.find((q) => q.match(String(url), init))
    if (!hit) return new Response('[]', { status: 200 })
    return hit.respond()
  }) as typeof fetch
  return { impl, calls }
}

const baseDeps = () => ({
  supabaseUrl: URL_BASE,
  anonKey: 'anon',
  getAccessToken: async () => FAKE_JWT,
  getDeviceId: async () => 'device-1',
  notifyCalls: [] as string[]
})

test('tick claims a queued mission, runs it, reports result and notifies', async () => {
  const d = baseDeps()
  const mission = { id: 'm1', title: 'Summarize PHCY 1205 slides', prompt: 'do it', status: 'queued' }
  const { impl, calls } = fakeFetch([
    {
      // 1. poll for queued missions
      match: (u, i) => u.includes('/rest/v1/agent_missions') && (i?.method ?? 'GET') === 'GET',
      respond: () => new Response(JSON.stringify([mission]), { status: 200 })
    },
    {
      // 2. atomic claim (PATCH ... &status=eq.queued) returns the claimed row
      match: (u, i) => u.includes('status=eq.queued') && i?.method === 'PATCH',
      respond: () => new Response(JSON.stringify([{ ...mission, status: 'claimed' }]), { status: 200 })
    },
    {
      // 3+ everything else (heartbeat, event inserts, final status PATCH) succeeds
      match: () => true,
      respond: () => new Response('[]', { status: 201 })
    }
  ])
  const dispatcher = createMissionDispatcher({
    ...d,
    fetchImpl: impl,
    runMission: async (_prompt, onLog) => {
      onLog('working')
      return { ok: true, summary: 'Draft ready: 40 cards' }
    },
    notifyPhone: async (id) => {
      d.notifyCalls.push(id)
    }
  })
  await dispatcher.tick()

  const patches = calls.filter((c) => c.init?.method === 'PATCH')
  assert.equal(patches.length >= 2, true) // claim + final status (heartbeat is a PATCH too)
  const finalPatch = JSON.parse(String(patches[patches.length - 1].init?.body))
  assert.equal(finalPatch.status, 'needs_review')
  assert.equal(finalPatch.result_summary, 'Draft ready: 40 cards')
  assert.deepEqual(d.notifyCalls, ['m1'])
})

test('tick does nothing when claim loses the race (empty PATCH result)', async () => {
  const d = baseDeps()
  let ran = false
  const { impl } = fakeFetch([
    {
      match: (u, i) => (i?.method ?? 'GET') === 'GET',
      respond: () => new Response(JSON.stringify([{ id: 'm1', prompt: 'p', title: 't', status: 'queued' }]), { status: 200 })
    },
    { match: (u, i) => i?.method === 'PATCH', respond: () => new Response('[]', { status: 200 }) }
  ])
  const dispatcher = createMissionDispatcher({
    ...d,
    fetchImpl: impl,
    runMission: async () => {
      ran = true
      return { ok: true, summary: 's' }
    },
    notifyPhone: async () => {}
  })
  await dispatcher.tick()
  assert.equal(ran, false)
})

test('runMission failure marks mission failed and still notifies', async () => {
  const d = baseDeps()
  const { impl, calls } = fakeFetch([
    {
      match: (u, i) => (i?.method ?? 'GET') === 'GET',
      respond: () => new Response(JSON.stringify([{ id: 'm2', prompt: 'p', title: 't', status: 'queued' }]), { status: 200 })
    },
    {
      match: (u, i) => i?.method === 'PATCH' && u.includes('status=eq.queued'),
      respond: () => new Response(JSON.stringify([{ id: 'm2', status: 'claimed' }]), { status: 200 })
    },
    { match: () => true, respond: () => new Response('[]', { status: 201 }) }
  ])
  const dispatcher = createMissionDispatcher({
    ...d,
    fetchImpl: impl,
    runMission: async () => {
      throw new Error('agent crashed')
    },
    notifyPhone: async (id) => {
      d.notifyCalls.push(id)
    }
  })
  await dispatcher.tick()
  const patches = calls.filter((c) => c.init?.method === 'PATCH')
  const finalPatch = JSON.parse(String(patches[patches.length - 1].init?.body))
  assert.equal(finalPatch.status, 'failed')
  assert.deepEqual(d.notifyCalls, ['m2'])
})

test('tick is a no-op when signed out', async () => {
  const { impl, calls } = fakeFetch([])
  const dispatcher = createMissionDispatcher({
    supabaseUrl: URL_BASE,
    anonKey: 'anon',
    getAccessToken: async () => null,
    getDeviceId: async () => 'device-1',
    fetchImpl: impl,
    runMission: async () => ({ ok: true, summary: 's' }),
    notifyPhone: async () => {}
  })
  await dispatcher.tick()
  assert.equal(calls.length, 0)
})

test('tick heartbeats devices.last_seen_at while signed in, even with no queued missions', async () => {
  const d = baseDeps()
  const { impl, calls } = fakeFetch([
    {
      match: (u, i) => u.includes('/rest/v1/agent_missions') && (i?.method ?? 'GET') === 'GET',
      respond: () => new Response('[]', { status: 200 }) // nothing queued
    },
    { match: () => true, respond: () => new Response('[]', { status: 200 }) }
  ])
  const dispatcher = createMissionDispatcher({
    ...d,
    fetchImpl: impl,
    runMission: async () => ({ ok: true, summary: 's' }),
    notifyPhone: async () => {}
  })
  await dispatcher.tick()

  const heartbeat = calls.find((c) => c.init?.method === 'PATCH' && c.url.includes('/rest/v1/devices') && c.url.includes('id=eq.device-1'))
  assert.ok(heartbeat, 'expected a heartbeat PATCH to /rest/v1/devices for this device id')
  const body = JSON.parse(String(heartbeat!.init?.body))
  assert.equal(typeof body.last_seen_at, 'string')
  // Presence is independent of mission activity — no mission means no other PATCH.
  const patches = calls.filter((c) => c.init?.method === 'PATCH')
  assert.equal(patches.length, 1)
})

test('tick resolves without throwing when the mission poll fails (network/auth error)', async () => {
  const d = baseDeps()
  const { impl } = fakeFetch([
    { match: (u) => u.includes('/rest/v1/devices'), respond: () => new Response('[]', { status: 200 }) },
    {
      match: (u, i) => u.includes('/rest/v1/agent_missions') && (i?.method ?? 'GET') === 'GET',
      respond: () => new Response('{"message":"invalid JWT"}', { status: 401 })
    }
  ])
  const dispatcher = createMissionDispatcher({
    ...d,
    fetchImpl: impl,
    runMission: async () => ({ ok: true, summary: 's' }),
    notifyPhone: async () => {}
  })
  await assert.doesNotReject(() => dispatcher.tick())
})
