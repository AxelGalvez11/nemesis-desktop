// Account gate + account dialog (student build). Signed out → a full-screen native
// sign-in card; account creation happens in the browser. Signed in → nothing rendered
// here except a once-per-session final-three-days trial reminder and the Account
// dialog, opened from the statusbar chip: plan badge, renewal/trial date, browser-based subscription management,
// Refresh plan, Sign out.
import { useStore } from '@nanostores/react'
import { type FC, useEffect, useState } from 'react'

import { BrandMark } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Loader } from '@/components/ui/loader'
import { NEMESIS_STUDENT_BUILD } from '@/nemesis'
import {
  $account,
  $accountDialogOpen,
  ACCOUNT_BYPASS_ENABLED,
  BILLING_URL,
  bypassAccount,
  getTrialTiming,
  initAccount,
  planLabel,
  refreshEntitlement,
  signIn,
  signOut,
  SIGNUP_URL,
  trialCountdownLabel
} from '@/nemesis-account'

export const NemesisAccountGate: FC = () => {
  const account = useStore($account)
  const dialogOpen = useStore($accountDialogOpen)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<null | string>(null)
  const [refreshingPlan, setRefreshingPlan] = useState(false)
  const [dismissedTrialEnd, setDismissedTrialEnd] = useState<null | string>(null)
  const trialTiming = getTrialTiming(account)

  const trialEndDate = trialTiming
    ? new Date(trialTiming.end).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
    : null

  useEffect(() => {
    if (!NEMESIS_STUDENT_BUILD) {
      return
    }

    void initAccount()
    const revalidate = () => void refreshEntitlement()
    const interval = window.setInterval(revalidate, 5 * 60 * 1000)
    window.addEventListener('focus', revalidate)

    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', revalidate)
    }
  }, [])

  useEffect(() => {
    const entitlementEnd = account.planStatus === 'trialing' && account.trialEnd ? account.trialEnd : account.periodEnd

    if (!NEMESIS_STUDENT_BUILD || account.bypass || account.status !== 'signed-in' || !entitlementEnd) {
      return
    }

    const millisecondsUntilExpiry = Date.parse(entitlementEnd) - Date.now()

    const timeout = window.setTimeout(
      () => void refreshEntitlement(),
      Math.max(0, Math.min(millisecondsUntilExpiry + 250, 2_147_483_647))
    )

    return () => window.clearTimeout(timeout)
  }, [account.bypass, account.periodEnd, account.planStatus, account.status, account.trialEnd])

  if (!NEMESIS_STUDENT_BUILD) {
    return null
  }

  const submit = async () => {
    if (!email.trim() || !password || busy) {
      return
    }

    setBusy(true)
    setError(null)

    try {
      await signIn(email.trim(), password)
      setPassword('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in.')
    } finally {
      setBusy(false)
    }
  }

  if (account.status === 'loading') {
    return null
  }

  if (account.status === 'signed-out') {
    return (
      <div className="fixed inset-0 z-[1300] flex items-center justify-center bg-background/95 backdrop-blur-md p-4">
        <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-8 shadow-lg">
          <div className="flex flex-col items-center gap-3 pb-5 text-center">
            <BrandMark className="size-12" />
            <div>
              <h2 className="text-lg font-semibold tracking-tight">Sign in to Nemesis</h2>
              <p className="pt-1 text-xs text-muted-foreground">
                Use your Nemesis account. Your plan stays in sync across the desktop and account portal.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-2.5">
            <Input
              autoFocus
              onChange={event => setEmail(event.target.value)}
              placeholder="Email"
              type="email"
              value={email}
            />
            <Input
              onChange={event => setPassword(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  void submit()
                }
              }}
              placeholder="Password"
              type="password"
              value={password}
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
            <Button className="mt-1 w-full" disabled={busy || !email.trim() || !password} onClick={() => void submit()}>
              {busy ? <Loader className="size-4" type="fourier-flow" /> : null}
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
          </div>

          <div className="flex items-center justify-between pt-4 text-xs">
            <button
              className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              onClick={() => void window.hermesDesktop?.openExternal?.(SIGNUP_URL)}
              type="button"
            >
              Create an account
            </button>
            {ACCOUNT_BYPASS_ENABLED && (
              <button
                className="text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
                onClick={bypassAccount}
                title="Local development only"
                type="button"
              >
                Skip for local development
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  if (!account.bypass && account.plan === 'free') {
    const trialExpired = trialTiming?.expired === true

    return (
      <div className="fixed inset-0 z-[1300] flex items-center justify-center bg-background/95 p-4 backdrop-blur-md">
        <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-8 shadow-lg">
          <div className="flex flex-col items-center gap-3 text-center">
            <BrandMark className="size-12" />
            <div>
              <h2 className="text-lg font-semibold tracking-tight">
                {trialExpired ? 'Your Nemesis trial has ended' : 'Choose a Nemesis plan'}
              </h2>
              <p className="pt-1 text-xs leading-relaxed text-muted-foreground">
                {trialExpired
                  ? `Trial access ended${trialEndDate ? ` on ${trialEndDate}` : ''}. Choose a plan to restore the desktop study engine.`
                  : 'Your account is ready. A paid beta plan unlocks the desktop study engine.'}
              </p>
            </div>
          </div>
          <div className="mt-5 flex flex-col gap-2.5">
            <Button onClick={() => void window.hermesDesktop?.openExternal?.(BILLING_URL)}>
              {trialExpired ? 'Upgrade Nemesis' : 'View beta plans'}
            </Button>
            <Button
              disabled={refreshingPlan}
              onClick={() => {
                setRefreshingPlan(true)
                void refreshEntitlement().finally(() => setRefreshingPlan(false))
              }}
              variant="secondary"
            >
              {refreshingPlan ? 'Checking plan…' : 'I already subscribed — refresh'}
            </Button>
            <Button onClick={() => void signOut()} variant="ghost">
              Sign out
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // Signed in → a single dismissible reminder in the final three days, plus
  // the account dialog opened from the statusbar chip. Revalidation does not
  // recreate the reminder because dismissal is scoped to this mounted session.
  return (
    <>
      {trialTiming?.inFinalThreeDays && dismissedTrialEnd !== trialTiming.end && !dialogOpen && (
        <div
          aria-live="polite"
          className="fixed top-4 right-4 z-[1200] w-[min(24rem,calc(100vw-2rem))] rounded-xl border border-(--theme-primary)/40 bg-card p-4 shadow-lg"
          role="status"
        >
          <div className="text-sm font-semibold">Nemesis trial ending soon</div>
          <p className="pt-1 text-xs leading-relaxed text-muted-foreground">
            {trialCountdownLabel(trialTiming.daysRemaining)} · {trialEndDate}. Manage your subscription to keep Nemesis
            available without interruption.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <Button onClick={() => void window.hermesDesktop?.openExternal?.(BILLING_URL)} size="sm">
              Manage trial
            </Button>
            <Button onClick={() => setDismissedTrialEnd(trialTiming.end)} size="sm" variant="ghost">
              Dismiss
            </Button>
          </div>
        </div>
      )}

      <Dialog onOpenChange={open => $accountDialogOpen.set(open)} open={dialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Account</DialogTitle>
            <DialogDescription>{account.bypass ? 'Offline mode — not signed in.' : account.email}</DialogDescription>
          </DialogHeader>

          {!account.bypass && (
            <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-3 py-2.5">
              <div>
                <div className="text-sm font-medium">
                  {trialTiming && !trialTiming.expired
                    ? `${planLabel(account.plan)} trial`
                    : `${planLabel(account.plan)} plan`}
                </div>
                <div className="text-xs text-muted-foreground">
                  {trialTiming && !trialTiming.expired
                    ? `${trialCountdownLabel(trialTiming.daysRemaining)} · ${trialEndDate}`
                    : account.plan === 'free'
                      ? 'Upgrade for the full study engine.'
                      : account.periodEnd
                        ? `Renews ${new Date(account.periodEnd).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`
                        : account.planStatus || 'Active'}
                </div>
              </div>
              <span className="rounded-full bg-(--theme-primary)/15 px-2.5 py-1 text-[11px] font-semibold text-(--theme-primary)">
                {planLabel(account.plan)}
              </span>
            </div>
          )}

          {!account.bypass && (
            <p className="text-xs text-muted-foreground">Subscription changes open securely in your browser.</p>
          )}

          {!account.bypass && (
            <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5">
              <div className="text-sm font-medium">What your plan includes</div>
              <p className="pt-1 text-xs leading-relaxed text-muted-foreground">
                Nemesis intelligence is built in — AI answers, web research, and study tools are covered by your plan.
                No separate AI account, key, or bill.
              </p>
            </div>
          )}

          <DialogFooter className="flex-wrap gap-2 sm:justify-between">
            <div className="flex gap-2">
              <Button
                onClick={() => void window.hermesDesktop?.openExternal?.(BILLING_URL)}
                size="sm"
                variant="secondary"
              >
                {account.plan === 'free' ? 'Choose a plan' : 'Manage subscription'}
              </Button>
              {!account.bypass && (
                <Button onClick={() => void refreshEntitlement()} size="sm" variant="outline">
                  Refresh plan
                </Button>
              )}
              <Button
                onClick={() => {
                  const subject = encodeURIComponent('Nemesis bug report')
                  const body = encodeURIComponent(
                    'What happened:\n\n\nWhat I expected:\n\n\nWhat I was doing right before:\n\n\n(Nemesis beta on macOS)'
                  )
                  void window.hermesDesktop?.openExternal?.(`mailto:support@enternemesis.com?subject=${subject}&body=${body}`)
                }}
                size="sm"
                variant="outline"
              >
                Report a bug
              </Button>
            </div>
            <Button
              onClick={() => {
                $accountDialogOpen.set(false)
                void signOut()
              }}
              size="sm"
              variant="ghost"
            >
              Sign out
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
