// Inline source pills — PharmaOrb-style chips directly under an assistant answer,
// built from the citations named in THAT answer's text (PMIDs, links, trial ids, DOIs).
// The right-sidebar Sources rail stays the whole-chat view (it also digs through tool
// traffic); this is the per-answer receipt.
import { type FC, useMemo } from 'react'

import { sourcesFromText } from '@/app/right-sidebar/sources'
import { NEMESIS_STUDENT_BUILD } from '@/nemesis'

export const MessageSources: FC<{ text: string }> = ({ text }) => {
  const sources = useMemo(() => (text ? sourcesFromText(text) : []), [text])

  if (!NEMESIS_STUDENT_BUILD || sources.length === 0) {
    return null
  }

  return (
    <div className="mt-3 flex flex-wrap gap-1.5" data-slot="nemesis_message-sources">
      {sources.map(source => (
        <button
          className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-foreground/85 transition-colors hover:border-(--theme-primary) hover:text-foreground"
          key={source.url}
          onClick={() => void window.hermesDesktop?.openExternal?.(source.url)}
          title={`${source.title}\n${source.url}`}
          type="button"
        >
          <span className="text-[10px] font-semibold uppercase tracking-wide text-(--theme-primary)">
            {source.badge}
          </span>
          <span className="max-w-[14rem] truncate text-muted-foreground">{source.title}</span>
        </button>
      ))}
    </div>
  )
}
