/**
 * Notifies the student's phone that a dispatched mission needs review, via
 * Expo's free push API. Same raw-fetch style as mission-dispatcher.ts — no
 * new deps.
 *
 * No server secret is involved: possession of the device's Expo push token
 * (minted client-side, stored in `devices.expo_push_token` under RLS) is the
 * capability. This module only reads the signed-in user's own device rows —
 * `getAccessToken` must be their Supabase JWT, same as the dispatcher.
 *
 * Push is always best-effort: every failure path (no signed-in session, no
 * registered iOS device, the devices lookup failing, or exp.host itself
 * erroring) resolves quietly instead of throwing, because a missed
 * notification should never be allowed to break mission processing upstream.
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

export type PhoneNotifierDeps = {
  supabaseUrl: string
  anonKey: string
  getAccessToken: () => Promise<string | null>
  fetchImpl?: typeof fetch
}

type DeviceRow = { id: string; expo_push_token: string }

export function createPhoneNotifier(deps: PhoneNotifierDeps) {
  const doFetch = deps.fetchImpl ?? fetch

  return async function notifyPhone(missionId: string, title: string, body: string): Promise<void> {
    try {
      const token = await deps.getAccessToken()
      if (!token) return

      const res = await doFetch(
        `${deps.supabaseUrl}/rest/v1/devices?kind=eq.ios&expo_push_token=not.is.null&select=id,expo_push_token`,
        {
          headers: {
            apikey: deps.anonKey,
            Authorization: `Bearer ${token}`
          }
        }
      )
      if (!res.ok) return

      const text = await res.text()
      const rows = (text ? JSON.parse(text) : []) as DeviceRow[]
      if (!rows.length) return

      const messages = rows.map((row) => ({
        to: row.expo_push_token,
        title,
        body,
        data: { missionId }
      }))

      await doFetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(messages)
      })
    } catch {
      // Best-effort: network failure, malformed response, or exp.host being
      // down should never propagate into the caller's mission-processing flow.
    }
  }
}
