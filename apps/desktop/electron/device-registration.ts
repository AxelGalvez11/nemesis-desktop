/**
 * Registers (or reuses) this Mac's `devices` row so the mission dispatcher
 * has a stable `claimed_by`/heartbeat identity, and the phone can tell which
 * device picked up a mission.
 *
 * Deliberately takes no dependency on `electron` or `os` directly (mirrors
 * update-remote.ts / dashboard-token.ts) — `hostname()` and the cache
 * read/write are injected so this stays unit testable without a real
 * filesystem or app.getPath(). main.ts wires `os.hostname` and a
 * userData/device-id.json-backed cache in.
 */

export type DeviceRegistrationDeps = {
  supabaseUrl: string
  anonKey: string
  getAccessToken: () => Promise<string | null>
  hostname: () => string
  /** Returns the cached device id, or null if there isn't one yet (or it's unreadable). */
  readCachedId: () => string | null
  /** Best-effort persist; failures are the caller's concern (main.ts logs, doesn't throw). */
  writeCachedId: (id: string) => void
  fetchImpl?: typeof fetch
}

type UpsertedDevice = { id: string }

/** This is Task 2's `getDeviceId`. */
export async function ensureDesktopDevice(deps: DeviceRegistrationDeps): Promise<string> {
  const cached = deps.readCachedId()
  if (cached) return cached

  const token = await deps.getAccessToken()
  if (!token) {
    throw new Error('cannot register this device: no signed-in session')
  }

  const doFetch = deps.fetchImpl ?? fetch
  const res = await doFetch(`${deps.supabaseUrl}/rest/v1/devices?on_conflict=user_id,kind,name`, {
    method: 'POST',
    headers: {
      apikey: deps.anonKey,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation,resolution=merge-duplicates'
    },
    body: JSON.stringify({
      kind: 'desktop',
      name: deps.hostname(),
      last_seen_at: new Date().toISOString()
    })
  })

  if (!res.ok) {
    throw new Error(`postgrest ${res.status} registering this device`)
  }

  const text = await res.text()
  const rows = (text ? JSON.parse(text) : []) as UpsertedDevice[]
  const id = rows[0]?.id

  if (!id) {
    throw new Error('device upsert did not return an id')
  }

  deps.writeCachedId(id)
  return id
}
