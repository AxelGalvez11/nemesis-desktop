/**
 * Tests for electron/device-registration.ts.
 *
 * Run with: node --test electron/device-registration.test.ts
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { ensureDesktopDevice } from './device-registration'

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

test('with no cached id, upserts a desktop devices row and caches the returned id', async () => {
  const { impl, calls } = fakeFetch([
    {
      match: (u, i) => u.includes('/rest/v1/devices') && i?.method === 'POST',
      respond: () => new Response(JSON.stringify([{ id: 'device-abc' }]), { status: 201 })
    }
  ])

  const written: string[] = []
  const id = await ensureDesktopDevice({
    supabaseUrl: URL_BASE,
    anonKey: 'anon',
    getAccessToken: async () => FAKE_JWT,
    hostname: () => "Axel's MacBook Pro",
    readCachedId: () => null,
    writeCachedId: (id) => written.push(id),
    fetchImpl: impl
  })

  assert.equal(id, 'device-abc')
  assert.deepEqual(written, ['device-abc'])

  const upsert = calls.find((c) => c.init?.method === 'POST')
  assert.ok(upsert)
  assert.match(upsert!.url, /on_conflict=user_id,kind,name/)
  const body = JSON.parse(String(upsert!.init?.body))
  assert.equal(body.kind, 'desktop')
  assert.equal(body.name, "Axel's MacBook Pro")
  const headers = upsert!.init?.headers as Record<string, string>
  assert.match(headers.Prefer, /resolution=merge-duplicates/)
})

test('reuses a cached id without making any network call', async () => {
  const { impl, calls } = fakeFetch([])
  const id = await ensureDesktopDevice({
    supabaseUrl: URL_BASE,
    anonKey: 'anon',
    getAccessToken: async () => FAKE_JWT,
    hostname: () => 'host',
    readCachedId: () => 'cached-device-id',
    writeCachedId: () => {
      throw new Error('should not write when reusing a cached id')
    },
    fetchImpl: impl
  })

  assert.equal(id, 'cached-device-id')
  assert.equal(calls.length, 0)
})

test('throws when there is no signed-in session and no cached id', async () => {
  await assert.rejects(
    () =>
      ensureDesktopDevice({
        supabaseUrl: URL_BASE,
        anonKey: 'anon',
        getAccessToken: async () => null,
        hostname: () => 'host',
        readCachedId: () => null,
        writeCachedId: () => {}
      }),
    /no signed-in session/
  )
})

test('throws when the upsert request fails', async () => {
  const { impl } = fakeFetch([
    {
      match: (u, i) => u.includes('/rest/v1/devices') && i?.method === 'POST',
      respond: () => new Response('server error', { status: 500 })
    }
  ])

  await assert.rejects(
    () =>
      ensureDesktopDevice({
        supabaseUrl: URL_BASE,
        anonKey: 'anon',
        getAccessToken: async () => FAKE_JWT,
        hostname: () => 'host',
        readCachedId: () => null,
        writeCachedId: () => {},
        fetchImpl: impl
      }),
    /postgrest 500/
  )
})
