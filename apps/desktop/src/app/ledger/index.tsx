import { useCallback, useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { groupByDay, type LedgerEntry, loadLedger, trustLine } from '@/lib/activity-ledger'
import { cn } from '@/lib/utils'

function formatTimestamp(ts: string): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })
}

function LedgerRow({ entry }: { entry: LedgerEntry }) {
  const externalAction = entry.sent === true || entry.submitted === true

  return (
    <article
      className={cn(
        'grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3 border-l-2 py-3 pl-3 sm:grid-cols-[6.5rem_minmax(0,1fr)] sm:gap-5 sm:pl-4',
        externalAction ? 'border-l-(--ui-red)' : 'border-l-transparent'
      )}
    >
      <time className="pt-0.5 font-mono text-[0.67rem] tabular-nums text-(--ui-text-tertiary)" dateTime={entry.ts}>
        {formatTimestamp(entry.ts)}
      </time>
      <div className="min-w-0">
        <div className="flex flex-wrap items-start gap-2">
          <p className="min-w-0 flex-1 text-sm leading-5 text-(--ui-text-primary)">{entry.action}</p>
          <span className="shrink-0 rounded bg-(--ui-bg-quaternary) px-1.5 py-0.5 text-[0.625rem] font-medium uppercase tracking-[0.06em] text-(--ui-text-tertiary)">
            {entry.area}
          </span>
        </div>
        {entry.detail && <p className="mt-1 text-xs leading-relaxed text-(--ui-text-secondary)">{entry.detail}</p>}
        {entry.wrote?.map(path => (
          <p className="mt-1 truncate font-mono text-[0.65rem] leading-4 text-(--ui-text-quaternary)" key={path} title={path}>
            {path}
          </p>
        ))}
        {externalAction && (
          <p className="mt-1.5 text-[0.625rem] font-semibold uppercase tracking-[0.08em] text-(--ui-red)">
            {[entry.sent && 'Sent', entry.submitted && 'Submitted'].filter(Boolean).join(' · ')}
          </p>
        )}
      </div>
    </article>
  )
}

export function LedgerView() {
  const [entries, setEntries] = useState<LedgerEntry[]>([])
  const [loaded, setLoaded] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const refresh = useCallback(async (manual = false) => {
    if (manual) {
      setRefreshing(true)
    }

    try {
      setEntries(await loadLedger())
    } finally {
      setLoaded(true)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void refresh()

    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)

    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  const groups = useMemo(() => groupByDay(entries), [entries])

  return (
    <main className="h-full min-h-0 overflow-y-auto bg-(--ui-editor-surface-background)">
      <header className="sticky top-0 z-10 border-b border-(--ui-stroke-tertiary) bg-(--ui-editor-surface-background)/95 backdrop-blur">
        <div className="mx-auto w-full max-w-[960px] px-5 pb-4 pt-6 sm:px-7">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-(--ui-text-tertiary)">Activity</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-[-0.025em]">Ledger</h1>
            </div>
            <Button disabled={refreshing} onClick={() => void refresh(true)} size="sm" variant="outline">
              <Codicon name="refresh" spinning={refreshing} />
              Refresh
            </Button>
          </div>
          <div className="mt-4 flex items-center justify-center gap-2 rounded-lg border border-(--ui-stroke-tertiary) px-4 py-3 text-center text-[0.6875rem] text-(--ui-text-tertiary)">
            <Codicon className="shrink-0" name="shield" size="0.85rem" />
            <span>{trustLine(entries)}</span>
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-[960px] px-5 pb-10 pt-5 sm:px-7">
        {!loaded ? (
          <div className="flex items-center justify-center gap-2 py-16 text-xs text-(--ui-text-tertiary)">
            <Codicon name="loading" spinning />
            Reading the ledger
          </div>
        ) : groups.length === 0 ? (
          <div className="grid min-h-64 place-items-center px-5 text-center">
            <p className="max-w-md text-sm leading-relaxed text-(--ui-text-secondary)">
              No actions recorded yet. Every action Nemesis takes will appear here, in plain English.
            </p>
          </div>
        ) : (
          <div className="space-y-7">
            {groups.map(group => (
              <section key={group.dayIso}>
                <h2 className="border-b border-(--ui-stroke-tertiary) pb-2 text-xs font-semibold text-(--ui-text-secondary)">
                  {group.label}
                </h2>
                <div className="divide-y divide-(--ui-stroke-tertiary)">
                  {group.entries.map((entry, index) => (
                    <LedgerRow entry={entry} key={`${entry.ts}:${entry.action}:${index}`} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </main>
  )
}
