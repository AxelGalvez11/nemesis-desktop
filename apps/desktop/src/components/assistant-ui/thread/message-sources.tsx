// Inline source pills — PharmaOrb-style chips directly under an assistant answer,
// built from the citations named in THAT answer's text (PMIDs, links, trial ids, DOIs).
// The right-sidebar Sources rail stays the whole-chat view (it also digs through tool
// traffic); this is the per-answer receipt.
import { type FC, useMemo } from 'react'

import { SOURCE_CHIP_CLASS_NAME, SourceFavicon, sourcesFromText } from '@/app/right-sidebar/sources'
import { NEMESIS_STUDENT_BUILD } from '@/nemesis'
import { focusSourceInRail } from '@/store/source-focus'

export const MessageSources: FC<{ text: string }> = ({ text }) => {
  const sources = useMemo(() => (text ? sourcesFromText(text) : []), [text])

  if (!NEMESIS_STUDENT_BUILD || sources.length === 0) {
    return null
  }

  return (
    <div className="mt-3 flex flex-wrap gap-1.5" data-slot="nemesis_message-sources">
      {sources.map(source => (
        <button
          className={SOURCE_CHIP_CLASS_NAME}
          key={source.url}
          onClick={() => focusSourceInRail(source.url)}
          title={`${source.title}\n${source.url}`}
          type="button"
        >
          <SourceFavicon domain={source.domain} />
          <span className="max-w-[14rem] truncate text-foreground/80">{source.title}</span>
          <span className="shrink-0 text-[9px] font-medium uppercase tracking-wide text-muted-foreground/55">
            {source.badge}
          </span>
        </button>
      ))}
    </div>
  )
}
