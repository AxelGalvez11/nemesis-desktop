// Claude-style activity collapse (student build). While a turn runs, the strip is a
// LIVE one-liner — a human phrase for the current tool call / thought ("Searching
// PubMed for 'tesamorelin'…") that cross-fades as the activity changes, the way
// ChatGPT/Claude narrate work. The full trail below stays visible exactly as before —
// reasoning previews shimmer and tool approvals remain clickable. Once the turn
// settles, the whole trail folds into this one quiet row ("Worked through N steps")
// and expands only on demand, so finished answers read as answers, not terminal logs.
import { useAuiState } from '@assistant-ui/react'
import { type FC, useCallback, useEffect, useRef, useState } from 'react'

import { currentActivityEvent, phraseForActivity } from '@/components/assistant-ui/thread/activity-phrase'
import { Codicon } from '@/components/ui/codicon'
import { cn } from '@/lib/utils'
import { NEMESIS_STUDENT_BUILD } from '@/nemesis'

export const ActivityStrip: FC = () => {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLElement | null>(null)
  const running = useAuiState(s => s.message.status?.type === 'running')
  const steps = useAuiState(s => s.message.parts.filter(part => part?.type === 'tool-call').length)
  const hasReasoning = useAuiState(s =>
    s.message.parts.some(part => part?.type === 'reasoning' && typeof part.text === 'string' && part.text.trim().length > 0)
  )

  // The selector returns the phrase STRING (not the event object) so token
  // flushes that don't change the phrase are referentially stable and skip
  // re-rendering. Empty while settled, while the answer itself streams, or in
  // the stock (non-student) build.
  const livePhrase = useAuiState(s => {
    if (!NEMESIS_STUDENT_BUILD || s.message.status?.type !== 'running') {
      return ''
    }

    const event = currentActivityEvent(s.message.parts)

    return event ? phraseForActivity(event) : ''
  })

  const active = NEMESIS_STUDENT_BUILD && (steps > 0 || hasReasoning)

  // The trail lives in a sibling subtree (MessagePrimitive.Parts), so the collapse is
  // driven by an attribute on the shared message root + a CSS rule in styles.css.
  useEffect(() => {
    const root = ref.current?.closest('[data-role="assistant"]')

    if (!root) {
      return
    }

    if (!active) {
      root.removeAttribute('data-nemesis-activity')

      return
    }

    root.setAttribute('data-nemesis-activity', running ? 'live' : open ? 'open' : 'collapsed')
  }, [active, open, running])

  // Branches render different elements (div / button), so the ref is a shared
  // callback rather than a per-element RefObject.
  const attachRef = useCallback((node: HTMLElement | null) => {
    ref.current = node
  }, [])

  if (running && livePhrase) {
    return (
      <div
        aria-live="polite"
        className="mb-1 flex min-w-0 max-w-full items-center gap-1 text-[length:var(--conversation-tool-font-size)] text-(--ui-text-tertiary)"
        data-slot="aui_activity-phrase"
        ref={attachRef}
        role="status"
      >
        {/* Keyed by phrase: a new phrase remounts the wrapper, replaying the CSS
            fade (styles.css .nemesis-activity-phrase) — a quiet cross-fade with
            no animation library. The inner span carries the live shimmer. */}
        <span className="nemesis-activity-phrase flex min-w-0" key={livePhrase}>
          <span className="shimmer min-w-0 truncate">{livePhrase}</span>
        </span>
      </div>
    )
  }

  if (!active || running) {
    // Zero-size anchor keeps the ref attached so the attribute updates on settle.
    return <button aria-hidden className="hidden" ref={attachRef} tabIndex={-1} type="button" />
  }

  return (
    <button
      className={cn(
        'mb-1 flex items-center gap-1 text-[length:var(--conversation-tool-font-size)] text-(--ui-text-tertiary) transition-colors hover:text-foreground'
      )}
      onClick={() => setOpen(value => !value)}
      ref={attachRef}
      type="button"
    >
      <Codicon name={open ? 'chevron-down' : 'chevron-right'} size="0.8125rem" />
      <span>
        {open
          ? 'Hide steps'
          : steps > 0
            ? `Worked through ${steps} step${steps === 1 ? '' : 's'}`
            : 'Show thinking'}
      </span>
    </button>
  )
}
