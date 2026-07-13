// Usage settings (student build): today's model-token budget for the signed-in
// plan, read live from the metering proxy's /usage endpoint. Read-only — the
// same key→plan→counter the proxy enforces, so it can't disagree with reality.
import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { $account, fetchUsage, planLabel, type UsageSnapshot } from '@/nemesis-account'

function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`
  }

  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}K`
  }

  return String(value)
}

export function UsageSettings() {
  const account = useStore($account)
  const [usage, setUsage] = useState<null | UsageSnapshot>(null)
  const [state, setState] = useState<'error' | 'loading' | 'ready'>('loading')

  const load = () => {
    setState('loading')
    void fetchUsage().then(result => {
      setUsage(result)
      setState(result ? 'ready' : 'error')
    })
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pct = usage && usage.dailyLimit > 0 ? Math.min(100, Math.round((usage.used / usage.dailyLimit) * 100)) : 0
  const planName = usage ? planLabel(usage.plan) : planLabel(account.plan)

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-col gap-1">
        <span className="text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-muted-foreground/70">Usage</span>
        <h2 className="text-lg font-semibold text-foreground">Today&apos;s allowance</h2>
        <p className="text-sm text-muted-foreground">
          Your {planName} plan includes a daily amount of AI work. It resets every day at midnight (UTC).
        </p>
      </div>

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
              <span className="font-semibold text-foreground">{formatTokens(usage.remaining)}</span> left today
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
            Usage isn&apos;t available yet — this needs you to be signed in with an active plan and the metering
            service running.
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
    </div>
  )
}
