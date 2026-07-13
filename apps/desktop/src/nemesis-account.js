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
import { atom } from 'nanostores';
// Public client credentials — the same values the Nemesis account portal ships to every
// browser. Safe to embed: the anon key only grants what RLS policies allow.
export const SUPABASE_URL = 'https://qyjmivntajbigjswhahb.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF5am1pdm50YWpiaWdqc3doYWhiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0NjcyMDEsImV4cCI6MjA5NjA0MzIwMX0.N305XZXSciym2q6c6UMoNwdmCIUZWPgW_3jMIVnIPHk';
export const NEMESIS_ACCOUNT_SITE = 'https://app.enternemesis.com';
export const BILLING_URL = `${NEMESIS_ACCOUNT_SITE}/account/billing`;
export const SIGNUP_URL = `${NEMESIS_ACCOUNT_SITE}/sign-up`;
const SESSION_KEY = 'nemesis.account.v1';
const BYPASS_KEY = 'nemesis.account.bypass';
export const $account = atom({ plan: 'free', status: 'loading' });
export const $accountDialogOpen = atom(false);
function loadSession() {
    try {
        const raw = window.localStorage.getItem(SESSION_KEY);
        if (!raw) {
            return null;
        }
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed.accessToken === 'string' ? parsed : null;
    }
    catch {
        return null;
    }
}
function saveSession(session) {
    try {
        if (session) {
            window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
        }
        else {
            window.localStorage.removeItem(SESSION_KEY);
        }
    }
    catch {
        // best-effort persistence
    }
}
async function tokenRequest(body, grant) {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=${grant}`, {
        body: JSON.stringify(body),
        headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
        method: 'POST'
    });
    const data = (await response.json().catch(() => ({})));
    if (!response.ok || !data.access_token) {
        const reason = data.error_description || data.msg || data.error || `sign-in failed (${response.status})`;
        throw new Error(reason);
    }
    return {
        accessToken: data.access_token,
        email: data.user?.email ?? '',
        expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
        refreshToken: data.refresh_token,
        userId: data.user?.id ?? ''
    };
}
/** Active-subscription statuses (Stripe vocabulary, as the web app writes them). */
const ACTIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);
async function fetchPlan(session) {
    try {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?select=plan,status,current_period_end&order=updated_at.desc&limit=1`, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.accessToken}` } });
        if (!response.ok) {
            return { plan: 'free' };
        }
        const rows = (await response.json());
        const sub = rows[0];
        if (sub?.plan && sub.status && ACTIVE_STATUSES.has(sub.status)) {
            return { periodEnd: sub.current_period_end, plan: sub.plan, planStatus: sub.status };
        }
        return { plan: 'free', planStatus: sub?.status };
    }
    catch {
        // Offline or unreachable: don't lock the student out of a paid tier they had;
        // default to free-tier behavior for this session.
        return { plan: 'free' };
    }
}
async function refreshIfNeeded(session) {
    const secondsLeft = session.expiresAt - Math.floor(Date.now() / 1000);
    if (secondsLeft > 120) {
        return session;
    }
    const refreshed = await tokenRequest({ refresh_token: session.refreshToken }, 'refresh_token');
    const merged = { ...refreshed, email: refreshed.email || session.email, userId: refreshed.userId || session.userId };
    saveSession(merged);
    return merged;
}
async function applySession(session) {
    const entitlement = await fetchPlan(session);
    $account.set({
        email: session.email,
        periodEnd: entitlement.periodEnd,
        plan: entitlement.plan,
        planStatus: entitlement.planStatus,
        status: 'signed-in',
        userId: session.userId
    });
}
export async function initAccount() {
    try {
        if (window.localStorage.getItem(BYPASS_KEY) === '1') {
            $account.set({ bypass: true, plan: 'free', status: 'signed-in' });
            return;
        }
    }
    catch {
        // fall through
    }
    const stored = loadSession();
    if (!stored) {
        $account.set({ plan: 'free', status: 'signed-out' });
        return;
    }
    try {
        const session = await refreshIfNeeded(stored);
        await applySession(session);
    }
    catch {
        // Refresh failed (revoked/expired) → ask the student to sign in again.
        saveSession(null);
        $account.set({ plan: 'free', status: 'signed-out' });
    }
}
export async function signIn(email, password) {
    const session = await tokenRequest({ email, password }, 'password');
    saveSession(session);
    try {
        window.localStorage.removeItem(BYPASS_KEY);
    }
    catch {
        // ignore
    }
    await applySession(session);
}
export async function signOut() {
    const stored = loadSession();
    if (stored) {
        // Best-effort server-side revoke; local clear is what matters.
        void fetch(`${SUPABASE_URL}/auth/v1/logout`, {
            headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${stored.accessToken}` },
            method: 'POST'
        }).catch(() => { });
    }
    saveSession(null);
    try {
        window.localStorage.removeItem(BYPASS_KEY);
    }
    catch {
        // ignore
    }
    $account.set({ plan: 'free', status: 'signed-out' });
}
/** Temporary owner escape hatch: use the app without an account (dev/offline). */
export function bypassAccount() {
    try {
        window.localStorage.setItem(BYPASS_KEY, '1');
    }
    catch {
        // ignore
    }
    $account.set({ bypass: true, plan: 'free', status: 'signed-in' });
}
export async function refreshEntitlement() {
    const stored = loadSession();
    if (!stored) {
        return;
    }
    try {
        const session = await refreshIfNeeded(stored);
        await applySession(session);
    }
    catch {
        // keep current state; a later refresh can succeed
    }
}
// --- Metered LLM proxy device key -------------------------------------------
// The proxy (cloud/nemesis-llm in the kit) authenticates the agent's model calls with a
// long-lived device key so every token is attributed, budgeted, and billed to the plan.
const DEVICE_KEY_STORE = 'nemesis.devicekey.v1';
export const LLM_PROXY_URL = `${SUPABASE_URL}/functions/v1/nemesis-llm`;
export const $deviceKey = atom(loadDeviceKey());
function loadDeviceKey() {
    try {
        return window.localStorage.getItem(DEVICE_KEY_STORE);
    }
    catch {
        return null;
    }
}
export async function mintDeviceKey() {
    const stored = loadSession();
    if (!stored) {
        throw new Error('Sign in first.');
    }
    const session = await refreshIfNeeded(stored);
    const response = await fetch(`${LLM_PROXY_URL}/device-key`, {
        body: JSON.stringify({ label: 'Nemesis desktop' }),
        headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${session.accessToken}`,
            'Content-Type': 'application/json'
        },
        method: 'POST'
    });
    if (response.status === 404) {
        throw new Error('Metering proxy is not deployed yet — deploy cloud/nemesis-llm first.');
    }
    const data = (await response.json().catch(() => ({})));
    if (!response.ok || !data.key) {
        throw new Error(data.error || `could not mint a device key (${response.status})`);
    }
    try {
        window.localStorage.setItem(DEVICE_KEY_STORE, data.key);
    }
    catch {
        // best-effort
    }
    $deviceKey.set(data.key);
    return data.key;
}
/** Today's token budget for the in-app Usage view. Returns null when there's
 *  no device key yet (nothing to report) or the proxy/usage endpoint isn't
 *  reachable — the UI treats null as "usage isn't available", never an error. */
export async function fetchUsage() {
    const key = $deviceKey.get();
    if (!key) {
        return null;
    }
    try {
        const response = await fetch(`${LLM_PROXY_URL}/usage`, {
            headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${key}` },
            method: 'GET'
        });
        if (!response.ok) {
            return null;
        }
        const data = (await response.json());
        if (typeof data.daily_limit !== 'number' || typeof data.used !== 'number') {
            return null;
        }
        return {
            dailyLimit: data.daily_limit,
            periodStart: data.period_start ?? '',
            plan: data.plan ?? 'free',
            remaining: typeof data.remaining === 'number' ? data.remaining : Math.max(0, data.daily_limit - data.used),
            used: data.used
        };
    }
    catch {
        return null;
    }
}
/** Human label for a plan code: 'health_pro' → 'Health Pro'. */
export function planLabel(plan) {
    if (!plan || plan === 'free') {
        return 'Free';
    }
    return plan
        .split(/[_-]/)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}
