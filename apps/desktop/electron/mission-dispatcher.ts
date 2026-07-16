/**
 * Background service: pulls queued missions from Supabase, claims one
 * atomically, runs it through the agent, streams events back, notifies the
 * phone, and heartbeats this device's `last_seen_at` so the phone's
 * "is my Mac online" check stays accurate.
 *
 * Raw PostgREST fetch on purpose — matches nemesis-account.ts style, no new
 * deps. Auth is the user's Supabase access token (a real JWT), NOT the nmk_
 * metering key used for the LLM proxy: RLS on agent_missions/mission_events/
 * devices is `user_id = auth.uid()`, and `auth.uid()` only resolves from a
 * genuine Supabase user JWT. The anon key alone authenticates as the `anon`
 * role, which has no rows visible under these policies.
 *
 * tick() trusts that `deps.runMission` (Task 3's createMissionRunner) bounds
 * its own promise with an internal completion timeout, so a stuck agent turn
 * can never hang tick() forever and hold the `busy` gate closed.
 */

type RunResult = { ok: boolean; summary: string }

export type MissionDispatcherDeps = {
  supabaseUrl: string
  anonKey: string
  getAccessToken: () => Promise<string | null>
  getDeviceId: () => Promise<string>
  runMission: (prompt: string, onLog: (line: string) => void) => Promise<RunResult>
  notifyPhone: (missionId: string, title: string, body: string) => Promise<void>
  fetchImpl?: typeof fetch
}

type MissionRow = { id: string; title: string; prompt: string; status: string }

export function createMissionDispatcher(deps: MissionDispatcherDeps) {
  const doFetch = deps.fetchImpl ?? fetch
  let timer: ReturnType<typeof setInterval> | null = null
  let busy = false

  const rest = async (path: string, token: string, init?: RequestInit) => {
    const res = await doFetch(`${deps.supabaseUrl}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: deps.anonKey,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        ...(init?.headers ?? {})
      }
    })
    if (!res.ok) throw new Error(`postgrest ${res.status} on ${path}`)
    const text = await res.text()
    return text ? JSON.parse(text) : []
  }

  // RLS requires user_id on inserts; read it from the JWT payload.
  const userIdFromToken = (token: string): string =>
    JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8')).sub

  const emit = (token: string, missionId: string, event: { type: string; payload: Record<string, unknown> }) =>
    rest('mission_events', token, {
      method: 'POST',
      body: JSON.stringify({ mission_id: missionId, user_id: userIdFromToken(token), ...event })
    }).catch(() => {}) // event loss is tolerable; the status PATCH is the source of truth

  // Best-effort presence signal, independent of whether a mission is queued.
  // apps/mobile's isDesktopOnline() reads this (a devices row updated within
  // the last 5 minutes) to show "Waiting for your Mac" vs. "Your Mac is
  // offline" in the composer. Never throws: a missed heartbeat only means a
  // stale badge on the phone, never a broken dispatch.
  const heartbeat = (token: string, deviceId: string) =>
    rest(`devices?id=eq.${deviceId}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ last_seen_at: new Date().toISOString() })
    }).catch(() => {})

  async function tick(): Promise<void> {
    if (busy) return
    const token = await deps.getAccessToken()
    if (!token) return
    busy = true
    try {
      const deviceId = await deps.getDeviceId()
      await heartbeat(token, deviceId)

      const queued = (await rest(
        'agent_missions?status=eq.queued&target=eq.desktop&order=created_at.asc&limit=1',
        token
      )) as MissionRow[]
      if (!queued.length) return
      const mission = queued[0]

      // Atomic claim: only wins if the row is still queued.
      const claimed = (await rest(`agent_missions?id=eq.${mission.id}&status=eq.queued`, token, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'claimed', claimed_by: deviceId, updated_at: new Date().toISOString() })
      })) as MissionRow[]
      if (!claimed.length) return // another device won the race

      await rest(`agent_missions?id=eq.${mission.id}`, token, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'running', updated_at: new Date().toISOString() })
      })
      await emit(token, mission.id, { type: 'status', payload: { status: 'running' } })

      let outcome: RunResult
      try {
        outcome = await deps.runMission(mission.prompt, (line) => {
          void emit(token, mission.id, { type: 'log', payload: { line } })
        })
      } catch (err) {
        outcome = { ok: false, summary: err instanceof Error ? err.message : 'mission failed' }
      }

      const finalStatus = outcome.ok ? 'needs_review' : 'failed'
      await rest(`agent_missions?id=eq.${mission.id}`, token, {
        method: 'PATCH',
        body: JSON.stringify({ status: finalStatus, result_summary: outcome.summary, updated_at: new Date().toISOString() })
      })
      await emit(token, mission.id, {
        type: outcome.ok ? 'result' : 'error',
        payload: { summary: outcome.summary }
      })
      await deps
        .notifyPhone(mission.id, outcome.ok ? 'Ready for review' : 'Mission failed', `${mission.title}: ${outcome.summary}`.slice(0, 170))
        .catch(() => {})
    } catch {
      // Transient network/auth failure on the poll or claim call (e.g. a JWT
      // that expired before the renderer's next refresh cycle re-synced one).
      // Swallow so the interval keeps ticking — the next tick retries clean.
    } finally {
      busy = false
    }
  }

  return {
    tick,
    start(intervalMs: number) {
      if (timer) return
      timer = setInterval(() => {
        void tick()
      }, intervalMs)
    },
    stop() {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    }
  }
}
