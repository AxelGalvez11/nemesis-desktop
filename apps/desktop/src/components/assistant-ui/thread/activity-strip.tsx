// Claude-style activity collapse (student build). While a turn runs, the live trail
// stays visible exactly as before — reasoning previews shimmer and tool approvals remain
// clickable. Once the turn settles, the whole trail folds into this one quiet row
// ("Worked through N steps") and expands only on demand, so finished answers read as
// answers, not as terminal logs.
import { useAuiState } from '@assistant-ui/react'
import { type FC, useEffect, useRef, useState } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { cn } from '@/lib/utils'
import { NEMESIS_STUDENT_BUILD } from '@/nemesis'

export const ActivityStrip: FC = () => {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement | null>(null)
  const running = useAuiState(s => s.message.status?.type === 'running')
  const steps = useAuiState(s => s.message.parts.filter(part => part?.type === 'tool-call').length)
  const hasReasoning = useAuiState(s =>
    s.message.parts.some(part => part?.type === 'reasoning' && typeof part.text === 'string' && part.text.trim().length > 0)
  )

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

  if (!active || running) {
    // Zero-size anchor keeps the ref attached so the attribute updates on settle.
    return <button aria-hidden className="hidden" ref={ref} tabIndex={-1} type="button" />
  }

  return (
    <button
      className={cn(
        'mb-1 flex items-center gap-1 text-[length:var(--conversation-tool-font-size)] text-(--ui-text-tertiary) transition-colors hover:text-foreground'
      )}
      onClick={() => setOpen(value => !value)}
      ref={ref}
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
