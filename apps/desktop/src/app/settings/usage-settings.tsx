// Account & usage settings (student build). One page answers "who am I signed in
// as, what plan am I on, and how much AI have I used" — account status from the
// live subscription read, today's allowance from the metering proxy's /usage
// endpoint, and a 7-day view read straight from the student's own usage counters
// (RLS-scoped). All read-only; subscription changes open in the browser.
import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  $account,
  BILLING_URL,
  fetchUsage,
  fetchWeeklyUsage,
  getTrialTiming,
  planLabel,
  refreshEntitlement,
  signOut,
  trialCountdownLabel,
  type UsageSnapshot,
  type WeeklyUsageDay
} from '@/nemesis-account'
import { setTelemetryEnabled, telemetryEnabled } from '@/nemesis-telemetry'

function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`
  }

  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}K`
  }

  return String(value)
}

/** The last 7 UTC days (oldest first), each with that day's used tokens (0 when
 *  the student didn't use Nemesis that day — the table only has rows for active
 *  days). */
function fillWeek(rows: WeeklyUsageDay[], now = Date.now()): WeeklyUsageDay[] {
  const byDay = new Map(rows.map(row => [row.periodStart, row.used]))

  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(now - (6 - index) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

    return { periodStart: day, used: byDay.get(day) ?? 0 }
  })
}

function dayLetter(isoDate: string): string {
  const day = new Date(`${isoDate}T00:00:00Z`).getUTCDay()

  return ['S', 'M', 'T', 'W', 'T', 'F', 'S'][day] ?? ''
}

export function UsageSettings() {
  const account = useStore($account)
  const [usage, setUsage] = useState<null | UsageSnapshot>(null)
  const [state, setState] = useState<'error' | 'loading' | 'ready'>('loading')
  const [week, setWeek] = useState<null | WeeklyUsageDay[]>(null)
  const [refreshingPlan, setRefreshingPlan] = useState(false)

  const load = () => {
    setState('loading')
    void fetchUsage().then(result => {
      setUsage(result)
      setState(result ? 'ready' : 'error')
    })
    void fetchWeeklyUsage().then(rows => {
      setWeek(rows ? fillWeek(rows) : null)
    })
  }

  useEffect(() => {
    load()
     
  }, [])

  const pct = usage && usage.dailyLimit > 0 ? Math.min(100, Math.round((usage.used / usage.dailyLimit) * 100)) : 0
  const planName = usage ? planLabel(usage.plan) : planLabel(account.plan)
  const trialTiming = getTrialTiming(account)

  const planDetail =
    trialTiming && !trialTiming.expired
      ? `${trialCountdownLabel(trialTiming.daysRemaining)} · ${new Date(trialTiming.end).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`
      : account.plan === 'free'
        ? 'No active plan — upgrade for the full study engine.'
        : account.periodEnd
          ? `Renews ${new Date(account.periodEnd).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`
          : account.planStatus || 'Active'

  const weekTotal = week ? week.reduce((sum, day) => sum + day.used, 0) : 0
  const weekMax = week ? Math.max(1, ...week.map(day => day.used)) : 1

  return (
    // OverlayMain clips its children (overflow-hidden) and expects every
    // settings page to own its scrolling, like Connections does. Without
    // this wrapper the page was simply cut off at short window heights —
    // hiding the privacy toggle at the bottom with no way to reach it.
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-8">
        <div className="flex flex-col gap-1">
          <span className="text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-muted-foreground/70">
            Account &amp; usage
          </span>
          <h2 className="text-lg font-semibold text-foreground">Your account</h2>
          <p className="text-sm text-muted-foreground">
            Your plan, this week&apos;s AI work, and today&apos;s allowance — all in one place.
          </p>
        </div>

        {/* Account status */}
        <div className="flex flex-col gap-3 rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-foreground">
                {account.bypass ? 'Offline mode — not signed in' : account.email || 'Signed in'}
              </div>
              <div className="pt-0.5 text-xs text-muted-foreground">{account.bypass ? 'Local development' : planDetail}</div>
            </div>
            <span className="shrink-0 rounded-full bg-(--theme-primary)/15 px-2.5 py-1 text-[11px] font-semibold text-(--theme-primary)">
              {trialTiming && !trialTiming.expired ? `${planLabel(account.plan)} trial` : `${planLabel(account.plan)} plan`}
            </span>
          </div>
          {!account.bypass && (
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => void window.hermesDesktop?.openExternal?.(BILLING_URL)} size="sm" variant="secondary">
                {account.plan === 'free' ? 'Choose a plan' : 'Manage subscription'}
              </Button>
              <Button
                disabled={refreshingPlan}
                onClick={() => {
                  setRefreshingPlan(true)
                  void refreshEntitlement().finally(() => {
                    setRefreshingPlan(false)
                    load()
                  })
                }}
                size="sm"
                variant="outline"
              >
                {refreshingPlan ? 'Checking…' : 'Refresh plan'}
              </Button>
              <Button onClick={() => void signOut()} size="sm" variant="ghost">
                Sign out
              </Button>
            </div>
          )}
        </div>

        {/* This week */}
        <div className="flex flex-col gap-3 rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-5">
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-medium text-foreground">This week</span>
            <span className="text-sm tabular-nums text-muted-foreground">
              {week ? `${formatTokens(weekTotal)} tokens over 7 days` : 'Not available yet'}
            </span>
          </div>
          {week ? (
            <div aria-label="AI usage for the last 7 days" className="flex items-end gap-2" role="img">
              {week.map(day => (
                <div className="flex flex-1 flex-col items-center gap-1" key={day.periodStart}>
                  <div className="flex h-16 w-full items-end overflow-hidden rounded-md bg-(--ui-bg-tertiary)">
                    <div
                      className="w-full rounded-md bg-(--theme-primary)/80 transition-[height] duration-500"
                      style={{ height: `${Math.max(day.used > 0 ? 6 : 0, Math.round((day.used / weekMax) * 100))}%` }}
                      title={`${day.periodStart}: ${formatTokens(day.used)} tokens`}
                    />
                  </div>
                  <span className="text-[10px] text-muted-foreground/70">{dayLetter(day.periodStart)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Weekly usage appears after your first AI request while signed in.
            </p>
          )}
        </div>

        {/* Today */}
        {state === 'ready' && usage ? (
          <div className="flex flex-col gap-4 rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-5">
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium text-foreground">Used today</span>
              <span className="text-sm tabular-nums text-muted-foreground">
                {formatTokens(usage.used)} / {usage.dailyLimit > 0 ? formatTokens(usage.dailyLimit) : 'unlimited'}
              </span>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-(--ui-bg-tertiary)">
              <div
                className="h-full rounded-full bg-(--theme-primary) transition-[width] duration-500"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                <span className="font-semibold text-foreground">{formatTokens(usage.remaining)}</span> left today · resets
                at midnight (UTC)
              </span>
              <span className="rounded-full bg-(--theme-primary)/15 px-2 py-0.5 font-semibold text-(--theme-primary)">
                {planName}
              </span>
            </div>
          </div>
        ) : state === 'loading' ? (
          <div className="rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-5 text-sm text-muted-foreground">
            Checking your allowance…
          </div>
        ) : (
          <div className="flex flex-col items-start gap-3 rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-5">
            <p className="text-sm text-muted-foreground">
              Today&apos;s allowance isn&apos;t available yet — this needs you to be signed in with an active plan and the
              metering service reachable.
            </p>
            <Button onClick={load} size="sm" variant="secondary">
              Try again
            </Button>
          </div>
        )}

        <p className="text-xs leading-relaxed text-muted-foreground/70">
          &ldquo;AI work&rdquo; is measured in tokens — the units the model reads and writes. Heavy tasks (a full
          research brief, a slide deck) use more than a quick question. Lecture transcription runs on your own Mac and
          never counts against this.
        </p>

        <PrivacyCard />
      </div>
    </div>
  )
}

/** Opt-out for the anonymous telemetry disclosed at the consent screen. Applies
 *  immediately in both directions (see setTelemetryEnabled). */
function PrivacyCard() {
  const [share, setShare] = useState(() => telemetryEnabled())

  const toggle = (next: boolean) => {
    setShare(next)
    setTelemetryEnabled(next)
  }

  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-5">
      <div>
        <div className="text-sm font-medium">Share anonymous usage stats &amp; crash reports</div>
        <p className="pt-1 text-xs leading-relaxed text-muted-foreground">
          Feature counts and crash reports only — never your chats, notes, files, or recordings. Turning this off
          stops sharing immediately.
        </p>
      </div>
      <Switch checked={share} onCheckedChange={toggle} />
    </div>
  )
}
