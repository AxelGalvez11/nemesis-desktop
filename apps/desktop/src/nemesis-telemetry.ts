// Anonymous product telemetry + crash reports (PostHog) — student build only.
//
// PRIVACY CONTRACT (the consent screen and Privacy Policy describe exactly this):
//   - NEVER chat text, notes, files, transcripts, recordings, file paths, or URLs.
//   - Events are feature counters (app launched, recorder used) plus crash reports.
//   - The id is the Supabase user id (a random uuid), never the email.
//   - Disclosed at the consent gate with a default-on checkbox; opt-out any time in
//     Settings → Account & usage. Turning it off stops capture immediately.
//
// The phc_ key is PostHog's public write-only ingestion key (same project as the
// web app, already shipped in its public bundle) — safe to embed. Analytics reads
// happen server-side with a different key.
import posthog from 'posthog-js'

import { NEMESIS_STUDENT_BUILD } from '@/nemesis'

const POSTHOG_KEY = 'phc_xcEjfTB3a2ftyzsw7oEAkpiBXRThWWjA3D5BcPBj36ht'
const POSTHOG_HOST = 'https://us.i.posthog.com'
const TELEMETRY_STORAGE_KEY = 'nemesis.telemetry.enabled'

let started = false

export function telemetryEnabled(): boolean {
  try {
    return window.localStorage.getItem(TELEMETRY_STORAGE_KEY) !== 'off'
  } catch {
    return true
  }
}

/** Flips the setting AND applies it immediately (opt-out stops capture right away). */
export function setTelemetryEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(TELEMETRY_STORAGE_KEY, enabled ? 'on' : 'off')
  } catch {
    // localStorage unavailable — the in-memory guards below still apply this session.
  }

  if (!started) {
    if (enabled) {
      startTelemetry()
    }

    return
  }

  if (enabled) {
    posthog.opt_in_capturing()
  } else {
    posthog.opt_out_capturing()
  }
}

/** Idempotent. Call only once the student has accepted the consent screen. */
export function startTelemetry(): void {
  if (started || !NEMESIS_STUDENT_BUILD || !telemetryEnabled()) {
    return
  }

  started = true

  try {
    posthog.init(POSTHOG_KEY, {
      autocapture: false, // never read on-screen text or inputs
      capture_exceptions: true, // crash reports (message + stack, no page content)
      capture_pageview: false,
      disable_session_recording: true,
      person_profiles: 'identified_only'
    })
    void window.hermesDesktop
      ?.getVersion?.()
      .then(info => posthog.capture('app_launched', { app_version: info.appVersion, platform: info.platform }))
      .catch(() => {})
  } catch {
    started = false
  }
}

/** Counter-style events only — call sites must pass no content, paths, or URLs. */
export function telemetryCapture(event: string, properties?: Record<string, boolean | number | string>): void {
  if (!started || !telemetryEnabled()) {
    return
  }

  try {
    posthog.capture(event, properties)
  } catch {
    // Telemetry must never break the app.
  }
}

/** Ties events to the Supabase user id (uuid only — never the email). */
export function telemetryIdentify(userId: string): void {
  if (!started || !telemetryEnabled() || !userId) {
    return
  }

  try {
    posthog.identify(userId)
  } catch {
    // Telemetry must never break the app.
  }
}

/** Sign-out: drop the identity so the next student on this Mac starts clean. */
export function resetTelemetryIdentity(): void {
  if (!started) {
    return
  }

  try {
    posthog.reset()
  } catch {
    // Telemetry must never break the app.
  }
}
