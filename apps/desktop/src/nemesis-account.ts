// Nemesis accounts + billing structure. Students sign in directly inside the desktop
// app; the desktop reads their subscription tier
// straight from the `subscriptions` table (RLS `auth.uid() = user_id` makes that safe
// with just the user's own JWT + the public anon key). Account creation and subscription
// changes open the Nemesis account portal in the user's browser.
//
// What this deliberately does NOT do yet: meter/bill individual model calls. The agent
// still talks to its configured provider directly; moving the model key server-side
// behind a usage-metered proxy is the documented next step (docs/design note in the
// nemesis kit).
import { atom } from 'nanostores'

import { resetTelemetryIdentity, telemetryIdentify } from '@/nemesis-telemetry'

// Public client credentials — the same values the Nemesis account portal ships to every
// browser. Safe to embed: the anon key only grants what RLS policies allow.
export const SUPABASE_URL = 'https://qyjmivntajbigjswhahb.supabase.co'
export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF5am1pdm50YWpiaWdqc3doYWhiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0NjcyMDEsImV4cCI6MjA5NjA0MzIwMX0.N305XZXSciym2q6c6UMoNwdmCIUZWPgW_3jMIVnIPHk'
export const NEMESIS_ACCOUNT_SITE = 'https://app.enternemesis.com'
export const BILLING_URL = `${NEMESIS_ACCOUNT_SITE}/account/billing`
export const SIGNUP_URL = `${NEMESIS_ACCOUNT_SITE}/sign-up`

const SESSION_KEY = 'nemesis.account.v1'
const BYPASS_KEY = 'nemesis.account.bypass'

/** Owner escape hatch for local development only. Production beta builds always require an account. */
export const ACCOUNT_BYPASS_ENABLED = import.meta.env.DEV

export interface AccountState {
  status: 'loading' | 'signed-in' | 'signed-out'
  email?: string
  userId?: string
  /** Plan code from the subscriptions table; 'free' when no active subscription. */
  plan: string
  planStatus?: string
  periodEnd?: string
  /** Stripe trial boundary, retained only as display metadata after access ends. */
  trialEnd?: string
  /** True when the owner used the temporary offline bypass (no account checks). */
  bypass?: boolean
}

const DAY_MS = 24 * 60 * 60 * 1000
const TRIAL_REMINDER_WINDOW_MS = 3 * DAY_MS

export interface TrialTiming {
  daysRemaining: number
  end: string
  expired: boolean
  inFinalThreeDays: boolean
}

/** Trial timing derived from the subscription payload. It only controls copy;
 *  fetchPlan remains the authorization boundary for desktop access. */
export function getTrialTiming(
  account: Pick<AccountState, 'periodEnd' | 'plan' | 'planStatus' | 'trialEnd'>,
  now = Date.now()
): TrialTiming | null {
  const end = account.trialEnd || (account.planStatus === 'trialing' ? account.periodEnd : undefined)
  const endTimestamp = end ? Date.parse(end) : Number.NaN

  if (!end || !Number.isFinite(endTimestamp)) {
    return null
  }

  const millisecondsRemaining = endTimestamp - now
  const active = account.plan !== 'free' && account.planStatus === 'trialing' && millisecondsRemaining > 0
  const periodEndTimestamp = account.periodEnd ? Date.parse(account.periodEnd) : Number.NaN

  const endedAtTrialBoundary =
    account.plan === 'free' &&
    millisecondsRemaining <= 0 &&
    (account.planStatus === 'trialing' || !Number.isFinite(periodEndTimestamp) || periodEndTimestamp <= endTimestamp)

  if (!active && !endedAtTrialBoundary) {
    return null
  }

  return {
    daysRemaining: active ? Math.ceil(millisecondsRemaining / DAY_MS) : 0,
    end,
    expired: endedAtTrialBoundary,
    inFinalThreeDays: active && millisecondsRemaining <= TRIAL_REMINDER_WINDOW_MS
  }
}

export function trialCountdownLabel(daysRemaining: number): string {
  return `Trial ends in ${daysRemaining} ${daysRemaining === 1 ? 'day' : 'days'}`
}

export const $account = atom<AccountState>({ plan: 'free', status: 'loading' })
export const $accountDialogOpen = atom(false)

interface StoredSession {
  accessToken: string
  refreshToken: string
  /** Unix seconds. */
  expiresAt: number
  userId: string
  email: string
  /** Last verified trial boundary; display-only and never grants entitlement. */
  trialEnd?: string
}

function loadSession(): StoredSession | null {
  try {
    const raw = window.localStorage.getItem(SESSION_KEY)

    if (!raw) {
      return null
    }

    const parsed = JSON.parse(raw) as StoredSession

    return parsed && typeof parsed.accessToken === 'string' ? parsed : null
  } catch {
    return null
  }
}

function saveSession(session: StoredSession | null): void {
  try {
    if (session) {
      window.localStorage.setItem(SESSION_KEY, JSON.stringify(session))
    } else {
      window.localStorage.removeItem(SESSION_KEY)
    }
  } catch {
    // best-effort persistence
  }
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  user?: { id: string; email?: string }
  error_description?: string
  msg?: string
  error?: string
}

class AuthRequestError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'AuthRequestError'
    this.status = status
  }
}

async function tokenRequest(body: Record<string, string>, grant: string): Promise<StoredSession> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=${grant}`, {
    body: JSON.stringify(body),
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    method: 'POST'
  })

  const data = (await response.json().catch(() => ({}))) as TokenResponse

  if (!response.ok || !data.access_token) {
    const reason = data.error_description || data.msg || data.error || `sign-in failed (${response.status})`
    throw new AuthRequestError(reason, response.status)
  }

  return {
    accessToken: data.access_token,
    email: data.user?.email ?? '',
    expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
    refreshToken: data.refresh_token,
    userId: data.user?.id ?? ''
  }
}

/** Active-subscription statuses (Stripe vocabulary, as the web app writes them). */
const ACTIVE_STATUSES = new Set(['active', 'trialing', 'past_due'])

interface PlanEntitlement {
  plan: string
  planStatus?: string
  periodEnd?: string
  trialEnd?: string
}

async function fetchPlan(session: StoredSession): Promise<PlanEntitlement> {
  try {
    const baseQuery = '&stripe_livemode=eq.true&order=updated_at.desc&limit=1'

    const request = (select: string) =>
      fetch(`${SUPABASE_URL}/rest/v1/subscriptions?select=${select}${baseQuery}`, {
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.accessToken}` }
      })

    let response = await request('plan,status,current_period_end,stripe_livemode,trial_end')

    // Older deployments do not have trial_end yet. Keep those installs usable
    // while preferring Stripe's explicit trial boundary whenever it is present.
    if (response.status === 400) {
      response = await request('plan,status,current_period_end,stripe_livemode')
    }

    if (!response.ok) {
      return { plan: 'free' }
    }

    const rows = (await response.json()) as {
      plan?: string
      status?: string
      current_period_end?: string
      stripe_livemode?: boolean
      trial_end?: string
    }[]

    const sub = rows[0]
    const periodEnd = sub?.current_period_end ? Date.parse(sub.current_period_end) : Number.NaN
    const trialEnd = sub?.trial_end || (sub?.status === 'trialing' ? sub.current_period_end : undefined)
    const accessEnd = sub?.status === 'trialing' && trialEnd ? Date.parse(trialEnd) : periodEnd
    const withinPaidPeriod = Number.isFinite(accessEnd) && accessEnd > Date.now()

    if (sub?.plan && sub.status && ACTIVE_STATUSES.has(sub.status) && withinPaidPeriod) {
      return { periodEnd: sub.current_period_end, plan: sub.plan, planStatus: sub.status, trialEnd }
    }

    return { periodEnd: sub?.current_period_end, plan: 'free', planStatus: sub?.status, trialEnd }
  } catch {
    // The beta deliberately fails closed while offline. A future offline mode
    // must use a server-signed entitlement token; renderer localStorage is not
    // an authorization boundary.
    return { plan: 'free' }
  }
}

async function refreshIfNeeded(session: StoredSession): Promise<StoredSession> {
  const secondsLeft = session.expiresAt - Math.floor(Date.now() / 1000)

  if (secondsLeft > 120) {
    return session
  }

  const refreshed = await tokenRequest({ refresh_token: session.refreshToken }, 'refresh_token')

  const merged = {
    ...refreshed,
    email: refreshed.email || session.email,
    trialEnd: session.trialEnd,
    userId: refreshed.userId || session.userId
  }

  saveSession(merged)

  return merged
}

/** Best-effort: point the local agent backend at the Nemesis LLM proxy with this
 *  device's metering key. Idempotent — main only rewrites env + restarts the
 *  backend when something actually changed — so it's safe on every sign-in and
 *  entitlement refresh. Failures are silent; the next refresh retries. */
async function syncBackendLlm(): Promise<void> {
  try {
    const key = $deviceKey.get() ?? (await mintDeviceKey())
    await window.hermesDesktop?.nemesisLlmSync?.(key)
  } catch {
    // Offline, signed out, or the proxy is unreachable — retried on the next cycle.
  }
}

// iOS companion: main process (electron/mission-dispatcher.ts) polls
// agent_missions with this token under RLS, so it needs to stay current.
// Best-effort and fire-and-forget everywhere it's called — a missed sync just
// means the dispatcher keeps using whatever it already has (or stays paused
// until the next successful push).
function pushMissionSession(accessToken: string | null): void {
  try {
    void window.hermesDesktop?.nemesisMissionsSyncSession?.(accessToken)?.catch(() => {})
  } catch {
    // ignore
  }
}

const MISSION_SESSION_RESYNC_MS = 20 * 60_000

let missionSessionSyncTimer: ReturnType<typeof setInterval> | null = null

/** Idempotent: safe to call from every place a session becomes "current".
 *  A Supabase access token is short-lived (~1h) and nothing else re-checks it
 *  on a long-running app — without this, leaving the Mac open longer than
 *  that would silently stop the mission dispatcher (it would keep polling
 *  with a stale token and 401ing) until the next sign-in-shaped event. This
 *  re-validates/re-pushes well inside that window instead. */
function startMissionSessionSync(): void {
  if (missionSessionSyncTimer) {
    return
  }

  missionSessionSyncTimer = setInterval(() => {
    void (async () => {
      const stored = loadSession()

      if (!stored) {
        return
      }

      try {
        const fresh = await refreshIfNeeded(stored)

        if (fresh !== stored) {
          saveSession(fresh)
        }

        pushMissionSession(fresh.accessToken)
      } catch {
        // Offline, or the refresh itself was rejected — leave the timer
        // running; the next tick (or the next sign-in-shaped event) retries.
      }
    })()
  }, MISSION_SESSION_RESYNC_MS)
}

function stopMissionSessionSync(): void {
  if (missionSessionSyncTimer) {
    clearInterval(missionSessionSyncTimer)
    missionSessionSyncTimer = null
  }
}

async function applySession(session: StoredSession): Promise<void> {
  const entitlement = await fetchPlan(session)

  const trialEnd =
    entitlement.planStatus === 'trialing'
      ? entitlement.trialEnd || entitlement.periodEnd
      : entitlement.plan === 'free'
        ? entitlement.trialEnd || session.trialEnd
        : undefined

  if (trialEnd !== session.trialEnd) {
    saveSession({ ...session, trialEnd })
  }

  $account.set({
    email: session.email,
    periodEnd: entitlement.periodEnd,
    plan: entitlement.plan,
    planStatus: entitlement.planStatus,
    status: 'signed-in',
    trialEnd,
    userId: session.userId
  })

  // Zero-setup model access: every verified sign-in (re)wires the agent backend
  // to the metering proxy. Fire-and-forget so account state never waits on it.
  void syncBackendLlm()

  // iOS companion: give the mission dispatcher this session's access token and
  // make sure the periodic re-sync (JWT staleness guard) is running.
  pushMissionSession(session.accessToken)
  startMissionSessionSync()

  // No-op unless telemetry is running (consent-gated); uses the uuid, never the email.
  telemetryIdentify(session.userId)
}

function applyUnavailableSession(session: StoredSession, previous?: AccountState): void {
  const trialEnd =
    previous?.trialEnd || (previous?.planStatus === 'trialing' ? previous.periodEnd : undefined) || session.trialEnd

  if (trialEnd !== session.trialEnd) {
    saveSession({ ...session, trialEnd })
  }

  $account.set({
    email: session.email,
    periodEnd: previous?.periodEnd,
    plan: 'free',
    planStatus: previous?.planStatus,
    status: 'signed-in',
    trialEnd,
    userId: session.userId
  })

  // The entitlement check failed (offline/rate-limited/5xx), but the session
  // itself is still valid — the dispatcher's RLS calls only need identity, not
  // plan status, so it should keep working through an unavailable entitlement.
  pushMissionSession(session.accessToken)
  startMissionSessionSync()
}

export async function initAccount(): Promise<void> {
  try {
    if (ACCOUNT_BYPASS_ENABLED && window.localStorage.getItem(BYPASS_KEY) === '1') {
      $account.set({ bypass: true, plan: 'free', status: 'signed-in' })

      return
    }

    if (!ACCOUNT_BYPASS_ENABLED) {
      window.localStorage.removeItem(BYPASS_KEY)
    }
  } catch {
    // fall through
  }

  const stored = loadSession()

  if (!stored) {
    $account.set({ plan: 'free', status: 'signed-out' })

    return
  }

  try {
    const session = await refreshIfNeeded(stored)
    await applySession(session)
  } catch (error) {
    const credentialsRejected = error instanceof AuthRequestError && [400, 401, 403, 422].includes(error.status)

    // Keep a session available for retry through network failures, timeouts,
    // rate limits, and temporary 5xx responses. Paid access still fails closed
    // until the live entitlement can be verified again.
    if (!credentialsRejected) {
      applyUnavailableSession(stored)

      return
    }

    saveSession(null)
    $account.set({ plan: 'free', status: 'signed-out' })
  }
}

export async function signIn(email: string, password: string): Promise<void> {
  const session = await tokenRequest({ email, password }, 'password')
  saveSession(session)

  try {
    window.localStorage.removeItem(BYPASS_KEY)
  } catch {
    // ignore
  }

  await applySession(session)
}

/** Adopt a session delivered by the nemesis:// OAuth deep link (Google/Apple
 *  sign-in finishes in the browser). Only the refresh token is trusted from the
 *  URL: it's exchanged with Supabase for a fresh, server-validated session, so a
 *  forged link can't inject a fabricated identity. */
export async function adoptOAuthSession(refreshToken: string): Promise<void> {
  const session = await tokenRequest({ refresh_token: refreshToken }, 'refresh_token')
  saveSession(session)

  try {
    window.localStorage.removeItem(BYPASS_KEY)
  } catch {
    // ignore
  }

  await applySession(session)
}

const OAUTH_STATE_KEY = 'nemesis.oauth.states.v2'
const OAUTH_STATE_TTL_MS = 15 * 60_000
const OAUTH_STATE_MAX = 5

interface PendingOAuthState {
  at: number
  state: string
}

function loadPendingOAuthStates(): PendingOAuthState[] {
  try {
    const raw = window.localStorage.getItem(OAUTH_STATE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []

    if (!Array.isArray(parsed)) {
      return []
    }

    const cutoff = Date.now() - OAUTH_STATE_TTL_MS

    return parsed.filter(
      (entry): entry is PendingOAuthState =>
        Boolean(entry) &&
        typeof (entry as PendingOAuthState).state === 'string' &&
        typeof (entry as PendingOAuthState).at === 'number' &&
        (entry as PendingOAuthState).at >= cutoff
    )
  } catch {
    return []
  }
}

function savePendingOAuthStates(states: PendingOAuthState[]): void {
  try {
    if (states.length === 0) {
      window.localStorage.removeItem(OAUTH_STATE_KEY)
    } else {
      window.localStorage.setItem(OAUTH_STATE_KEY, JSON.stringify(states.slice(-OAUTH_STATE_MAX)))
    }
  } catch {
    // Best-effort: without storage the state check below fails closed.
  }
}

/** Browser URL that starts Google/Apple OAuth for the DESKTOP app: the account
 *  site finishes the provider flow, then hands the session back through the
 *  nemesis:// deep link. A random `state` rides the whole round trip so the
 *  deep-link handler only accepts sign-ins THIS app started (a malicious local
 *  page can't sign the student into an attacker's account).
 *
 *  A small SET of recent states is kept (15-min TTL) instead of one slot: the
 *  owner-reproduced beta.14 dead end was a second button click silently
 *  overwriting the first tab's nonce, so whichever tab the student actually
 *  finished in came back with a "stale" state and the dialog hung forever. */
export function desktopOAuthStartUrl(provider: 'apple' | 'google'): string {
  const state = crypto.randomUUID()

  savePendingOAuthStates([...loadPendingOAuthStates(), { at: Date.now(), state }])

  return `${NEMESIS_ACCOUNT_SITE}/auth/desktop?provider=${provider}&state=${state}`
}

/** One-shot check that a returning OAuth deep link carries a state we issued
 *  recently. On success ALL pending states are consumed (the round trip is
 *  done); on failure the pending set is left for the genuine tab to finish. */
export function consumeOAuthState(state: string | undefined): boolean {
  if (!state) {
    return false
  }

  const pending = loadPendingOAuthStates()

  if (!pending.some(entry => entry.state === state)) {
    // Expired/foreign state: persist the TTL-pruned list so junk ages out.
    savePendingOAuthStates(pending)

    return false
  }

  savePendingOAuthStates([])

  return true
}

export async function signOut(): Promise<void> {
  const stored = loadSession()

  if (stored) {
    // Best-effort server-side revoke; local clear is what matters.
    void fetch(`${SUPABASE_URL}/auth/v1/logout`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${stored.accessToken}` },
      method: 'POST'
    }).catch(() => {})
  }

  // Drop the metering device key with the session: a different student signing
  // in on this Mac must mint their OWN key, or their usage would be billed to
  // the previous account.
  try {
    window.localStorage.removeItem(DEVICE_KEY_STORE)
  } catch {
    // ignore
  }

  $deviceKey.set(null)

  resetTelemetryIdentity()

  // iOS companion: stop the mission dispatcher immediately — a different
  // student signing in on this Mac must never have missions dispatched under
  // the previous account's session.
  stopMissionSessionSync()
  pushMissionSession(null)

  saveSession(null)

  try {
    window.localStorage.removeItem(BYPASS_KEY)
  } catch {
    // ignore
  }

  $account.set({ plan: 'free', status: 'signed-out' })
}

/** Temporary owner escape hatch: use the app without an account (dev/offline). */
export function bypassAccount(): void {
  if (!ACCOUNT_BYPASS_ENABLED) {
    return
  }

  try {
    window.localStorage.setItem(BYPASS_KEY, '1')
  } catch {
    // ignore
  }

  $account.set({ bypass: true, plan: 'free', status: 'signed-in' })
}

export async function refreshEntitlement(): Promise<void> {
  const stored = loadSession()

  if (!stored) {
    return
  }

  const current = $account.get()

  const currentEntitlementEnd =
    current.planStatus === 'trialing' && current.trialEnd ? current.trialEnd : current.periodEnd

  const currentPeriodEnd = currentEntitlementEnd ? Date.parse(currentEntitlementEnd) : Number.NaN

  // Expiry is enforced synchronously before any network request. If the
  // device is offline at the boundary, access fails closed instead of leaving
  // a stale paid renderer state alive indefinitely.
  if (Number.isFinite(currentPeriodEnd) && currentPeriodEnd <= Date.now()) {
    applyUnavailableSession(stored, current)
  }

  try {
    const session = await refreshIfNeeded(stored)
    await applySession(session)
  } catch {
    // keep current state; a later refresh can succeed
  }
}

// --- Metered LLM proxy device key -------------------------------------------
// The proxy (cloud/nemesis-llm in the kit) authenticates the agent's model calls with a
// long-lived device key so every token is attributed, budgeted, and billed to the plan.

const DEVICE_KEY_STORE = 'nemesis.devicekey.v1'
export const LLM_PROXY_URL = `${SUPABASE_URL}/functions/v1/nemesis-llm`

export const $deviceKey = atom<null | string>(loadDeviceKey())

function loadDeviceKey(): null | string {
  try {
    return window.localStorage.getItem(DEVICE_KEY_STORE)
  } catch {
    return null
  }
}

export interface LlmMessage {
  content: string
  role: 'assistant' | 'system' | 'user'
}

/** One-shot completion through the metered proxy (device-key auth, non-streaming).
 *  'deepseek-chat' resolves server-side to the fast non-thinking tier — right for
 *  small frequent calls like the recorder's live copilot. Throws on failure. */
export async function llmComplete(messages: LlmMessage[], opts: { maxTokens?: number } = {}): Promise<string> {
  const key = $deviceKey.get() ?? (await mintDeviceKey())

  const response = await fetch(`${LLM_PROXY_URL}/v1/chat/completions`, {
    body: JSON.stringify({
      max_tokens: opts.maxTokens ?? 320,
      messages,
      model: 'deepseek-chat',
      stream: false,
      temperature: 0.2
    }),
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    method: 'POST'
  })

  const data = (await response.json().catch(() => ({}))) as {
    choices?: { message?: { content?: string } }[]
    error?: string | { message?: string }
  }

  if (!response.ok) {
    const detail = typeof data.error === 'string' ? data.error : data.error?.message
    throw new Error(detail || `model call failed (${response.status})`)
  }

  return data.choices?.[0]?.message?.content ?? ''
}

export async function mintDeviceKey(): Promise<string> {
  const stored = loadSession()

  if (!stored) {
    throw new Error('Sign in first.')
  }

  const session = await refreshIfNeeded(stored)

  const response = await fetch(`${LLM_PROXY_URL}/device-key`, {
    body: JSON.stringify({ label: 'Nemesis desktop' }),
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session.accessToken}`,
      'Content-Type': 'application/json'
    },
    method: 'POST'
  })

  if (response.status === 404) {
    throw new Error('Metering proxy is not deployed yet — deploy cloud/nemesis-llm first.')
  }

  const data = (await response.json().catch(() => ({}))) as { key?: string; error?: string }

  if (!response.ok || !data.key) {
    throw new Error(data.error || `could not mint a device key (${response.status})`)
  }

  try {
    window.localStorage.setItem(DEVICE_KEY_STORE, data.key)
  } catch {
    // best-effort
  }

  $deviceKey.set(data.key)

  $deviceKey.set(data.key)

  return data.key
}

export interface UsageSnapshot {
  plan: string
  dailyLimit: number
  used: number
  remaining: number
  periodStart: string
}

/** Today's token budget for the in-app Usage view. Returns null when there's
 *  no device key yet (nothing to report) or the proxy/usage endpoint isn't
 *  reachable — the UI treats null as "usage isn't available", never an error. */
export async function fetchUsage(): Promise<null | UsageSnapshot> {
  const key = $deviceKey.get()

  if (!key) {
    return null
  }

  try {
    const response = await fetch(`${LLM_PROXY_URL}/usage`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${key}` },
      method: 'GET'
    })

    if (!response.ok) {
      return null
    }

    const data = (await response.json()) as {
      plan?: string
      daily_limit?: number
      used?: number
      remaining?: number
      period_start?: string
    }

    if (typeof data.daily_limit !== 'number' || typeof data.used !== 'number') {
      return null
    }

    return {
      dailyLimit: data.daily_limit,
      periodStart: data.period_start ?? '',
      plan: data.plan ?? 'free',
      remaining: typeof data.remaining === 'number' ? data.remaining : Math.max(0, data.daily_limit - data.used),
      used: data.used
    }
  } catch {
    return null
  }
}

export interface WeeklyUsageDay {
  /** YYYY-MM-DD (UTC day, matching the proxy's counters). */
  periodStart: string
  used: number
}

/** The signed-in student's own daily token counters for the last 7 days, read
 *  straight from the metering table (RLS `auth.uid() = user_id` scopes it to
 *  their rows). Null when signed out or unreachable — the UI shows "not
 *  available", never an error. */
export async function fetchWeeklyUsage(): Promise<null | WeeklyUsageDay[]> {
  const stored = loadSession()

  if (!stored) {
    return null
  }

  try {
    const session = await refreshIfNeeded(stored)
    const since = new Date(Date.now() - 6 * DAY_MS).toISOString().slice(0, 10)

    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/usage_counters?select=period_start,used` +
        `&counter_key=eq.nemesis_llm_tokens&period_start=gte.${since}&order=period_start.asc`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.accessToken}` } }
    )

    if (!response.ok) {
      return null
    }

    const rows = (await response.json()) as { period_start?: string; used?: number }[]

    return rows
      .filter(row => typeof row.period_start === 'string' && typeof row.used === 'number')
      .map(row => ({ periodStart: (row.period_start as string).slice(0, 10), used: row.used as number }))
  } catch {
    return null
  }
}

/** Authed PostgREST call for renderer-side background jobs (phone-sync study
 *  ingest). Same session plumbing as fetchWeeklyUsage: current session, refresh
 *  when close to expiry, anon apikey + user Bearer so RLS scopes every row.
 *  Null when signed out or the network call itself threw — callers treat both
 *  as "try again next tick". */
export async function restFetch(pathAndQuery: string, init?: RequestInit): Promise<null | Response> {
  const stored = loadSession()

  if (!stored) {
    return null
  }

  try {
    const session = await refreshIfNeeded(stored)

    // Caller headers first, auth last — a caller can add Prefer/etc. but can
    // never (accidentally) override the credentials.
    return await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${session.accessToken}`,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {})
      }
    })
  } catch {
    return null
  }
}

/** Human label for a plan code: 'health_pro' → 'Health Pro'. */
export function planLabel(plan: string): string {
  if (!plan || plan === 'free') {
    return 'Free'
  }

  const namedPlans: Record<string, string> = {
    plus: 'Student',
    pro: 'Agent Pro',
    max: 'Max'
  }

  const normalized = plan.toLowerCase()

  if (namedPlans[normalized]) {
    return namedPlans[normalized]
  }

  return plan
    .split(/[_-]/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}
