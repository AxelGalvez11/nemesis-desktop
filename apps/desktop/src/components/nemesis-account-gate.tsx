// Account gate + account dialog (student build). Signed out → a full-screen sign-in
// card over the app (students use their PharmaOrb account; creating one happens on the
// web). Signed in → nothing rendered here except the Account dialog, opened from the
// statusbar chip: plan badge, renewal date, Manage billing (web app's Stripe page),
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
  $deviceKey,
  BILLING_URL,
  bypassAccount,
  initAccount,
  mintDeviceKey,
  planLabel,
  refreshEntitlement,
  SIGNUP_URL,
  signIn,
  signOut
} from '@/nemesis-account'

export const NemesisAccountGate: FC = () => {
  const account = useStore($account)
  const dialogOpen = useStore($accountDialogOpen)
  const deviceKey = useStore($deviceKey)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<null | string>(null)
  const [keyBusy, setKeyBusy] = useState(false)
  const [keyError, setKeyError] = useState<null | string>(null)

  useEffect(() => {
    if (NEMESIS_STUDENT_BUILD) {
      void initAccount()
    }
  }, [])

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
                Use your PharmaOrb account — your plan and billing live there.
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
            <button
              className="text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
              onClick={bypassAccount}
              title="Temporary: use the app without an account (owner/dev escape hatch)"
              type="button"
            >
              Skip for now
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Signed in → only the account dialog (opened from the statusbar chip).
  return (
    <Dialog onOpenChange={open => $accountDialogOpen.set(open)} open={dialogOpen}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Account</DialogTitle>
          <DialogDescription>
            {account.bypass ? 'Offline mode — not signed in.' : account.email}
          </DialogDescription>
        </DialogHeader>

        {!account.bypass && (
          <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-3 py-2.5">
            <div>
              <div className="text-sm font-medium">{planLabel(account.plan)} plan</div>
              <div className="text-xs text-muted-foreground">
                {account.plan === 'free'
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
          <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-medium">Metered model key</div>
                <div className="text-xs text-muted-foreground">
                  {deviceKey
                    ? `Active · ends …${deviceKey.slice(-4)} — usage counts against your plan`
                    : 'Bills model usage to your plan instead of a local key.'}
                </div>
              </div>
              <div className="flex shrink-0 gap-1.5">
                {deviceKey && (
                  <Button
                    onClick={() => void navigator.clipboard?.writeText(deviceKey).catch(() => {})}
                    size="sm"
                    variant="ghost"
                  >
                    Copy
                  </Button>
                )}
                <Button
                  disabled={keyBusy}
                  onClick={() => {
                    setKeyBusy(true)
                    setKeyError(null)
                    void mintDeviceKey()
                      .catch(err => setKeyError(err instanceof Error ? err.message : 'failed'))
                      .finally(() => setKeyBusy(false))
                  }}
                  size="sm"
                  variant="outline"
                >
                  {keyBusy ? 'Minting…' : deviceKey ? 'New key' : 'Mint key'}
                </Button>
              </div>
            </div>
            {keyError && <p className="pt-1.5 text-xs text-destructive">{keyError}</p>}
          </div>
        )}

        <DialogFooter className="flex-wrap gap-2 sm:justify-between">
          <div className="flex gap-2">
            <Button onClick={() => void window.hermesDesktop?.openExternal?.(BILLING_URL)} size="sm" variant="secondary">
              {account.plan === 'free' ? 'Upgrade' : 'Manage billing'}
            </Button>
            {!account.bypass && (
              <Button onClick={() => void refreshEntitlement()} size="sm" variant="outline">
                Refresh plan
              </Button>
            )}
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
  )
}
