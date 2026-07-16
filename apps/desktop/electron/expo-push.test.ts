/**
 * Tests for electron/expo-push.ts.
 *
 * Run with: node --test electron/expo-push.test.ts
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createPhoneNotifier } from './expo-push'

const URL_BASE = 'https://example.supabase.co'
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

const baseDeps = (fetchImpl: typeof fetch) => ({
  supabaseUrl: URL_BASE,
  anonKey: 'anon',
  getAccessToken: async () => FAKE_JWT,
  fetchImpl
})

test('one iOS device with a token produces exactly one exp.host push', async () => {
  const { impl, calls } = fakeFetch([
    {
      match: (u) => u.includes('/rest/v1/devices') && u.includes('kind=eq.ios'),
      respond: () => new Response(JSON.stringify([{ id: 'd1', expo_push_token: 'ExponentPushToken[abc]' }]), { status: 200 })
    },
    { match: (u) => u.startsWith('https://exp.host/'), respond: () => new Response('{"data":[]}', { status: 200 }) }
  ])

  const notifyPhone = createPhoneNotifier(baseDeps(impl))
  await notifyPhone('m1', 'Ready for review', 'Flashcards: 40 cards')

  const pushCalls = calls.filter((c) => c.url.startsWith('https://exp.host/'))
  assert.equal(pushCalls.length, 1)
  const body = JSON.parse(String(pushCalls[0].init?.body))
  assert.deepEqual(body, [
    { to: 'ExponentPushToken[abc]', title: 'Ready for review', body: 'Flashcards: 40 cards', data: { missionId: 'm1' } }
  ])
})

test('zero iOS devices with a token produces zero exp.host calls', async () => {
  const { impl, calls } = fakeFetch([
    {
      match: (u) => u.includes('/rest/v1/devices') && u.includes('kind=eq.ios'),
      respond: () => new Response('[]', { status: 200 })
    }
  ])

  const notifyPhone = createPhoneNotifier(baseDeps(impl))
  await notifyPhone('m1', 'Ready for review', 'body')

  assert.equal(
    calls.filter((c) => c.url.startsWith('https://exp.host/')).length,
    0
  )
})

test('an exp.host failure resolves without throwing', async () => {
  const { impl } = fakeFetch([
    {
      match: (u) => u.includes('/rest/v1/devices') && u.includes('kind=eq.ios'),
      respond: () => new Response(JSON.stringify([{ id: 'd1', expo_push_token: 'ExponentPushToken[abc]' }]), { status: 200 })
    },
    { match: (u) => u.startsWith('https://exp.host/'), respond: () => new Response('server error', { status: 500 }) }
  ])

  const notifyPhone = createPhoneNotifier(baseDeps(impl))
  await assert.doesNotReject(() => notifyPhone('m1', 'Ready for review', 'body'))
})

test('a devices lookup failure (network/RLS error) resolves without throwing', async () => {
  const impl = (async () => {
    throw new Error('network down')
  }) as typeof fetch

  const notifyPhone = createPhoneNotifier(baseDeps(impl))
  await assert.doesNotReject(() => notifyPhone('m1', 'Ready for review', 'body'))
})

test('multiple iOS devices with tokens batch into a single exp.host call', async () => {
  const { impl, calls } = fakeFetch([
    {
      match: (u) => u.includes('/rest/v1/devices') && u.includes('kind=eq.ios'),
      respond: () =>
        new Response(
          JSON.stringify([
            { id: 'd1', expo_push_token: 'ExponentPushToken[one]' },
            { id: 'd2', expo_push_token: 'ExponentPushToken[two]' }
          ]),
          { status: 200 }
        )
    },
    { match: (u) => u.startsWith('https://exp.host/'), respond: () => new Response('{"data":[]}', { status: 200 }) }
  ])

  const notifyPhone = createPhoneNotifier(baseDeps(impl))
  await notifyPhone('m2', 'Mission failed', 'oops')

  const pushCalls = calls.filter((c) => c.url.startsWith('https://exp.host/'))
  assert.equal(pushCalls.length, 1)
  const body = JSON.parse(String(pushCalls[0].init?.body))
  assert.equal(body.length, 2)
  assert.deepEqual(
    body.map((m: any) => m.to),
    ['ExponentPushToken[one]', 'ExponentPushToken[two]']
  )
})

test('is a no-op (no fetch calls at all) when signed out', async () => {
  const { impl, calls } = fakeFetch([])
  const notifyPhone = createPhoneNotifier({
    supabaseUrl: URL_BASE,
    anonKey: 'anon',
    getAccessToken: async () => null,
    fetchImpl: impl
  })
  await notifyPhone('m1', 'Ready for review', 'body')
  assert.equal(calls.length, 0)
})
