// Inline source pills — ChatGPT-style receipts directly under an assistant answer,
// built from the citations named in THAT answer's text (PMIDs, links, trial ids, DOIs).
// Sources from the same site collapse into ONE chip (favicon + site name + "+N"), the
// way ChatGPT clusters same-claim citations, and the row ends with a stacked-favicon
// "Sources" affordance that opens the right-rail Sources panel. The rail stays the
// whole-chat view (it also digs through tool traffic); this is the per-answer receipt.
import { type FC, useMemo } from 'react'

import { SOURCE_CHIP_CLASS_NAME, SourceFavicon, type SourceRef, sourcesFromText } from '@/app/right-sidebar/sources'
import { NEMESIS_STUDENT_BUILD } from '@/nemesis'
import { focusSourceInRail } from '@/store/source-focus'

interface SourceGroup {
  items: SourceRef[]
  primary: SourceRef
}

/** Cluster citations by site so four PubMed papers read as one calm "PubMed +3"
 *  chip instead of four near-identical pills. Order follows first appearance. */
function groupByDomain(sources: SourceRef[]): SourceGroup[] {
  const groups = new Map<string, SourceGroup>()

  for (const source of sources) {
    const key = source.domain || source.url
    const existing = groups.get(key)

    if (existing) {
      existing.items.push(source)
    } else {
      groups.set(key, { items: [source], primary: source })
    }
  }

  return [...groups.values()]
}

export const MessageSources: FC<{ text: string }> = ({ text }) => {
  const sources = useMemo(() => (text ? sourcesFromText(text) : []), [text])
  const groups = useMemo(() => groupByDomain(sources), [sources])

  if (!NEMESIS_STUDENT_BUILD || groups.length === 0) {
    return null
  }

  // ONE footer pill (owner call 2026-07-16): inline chips inside the answer are
  // the per-claim receipts now (markdown-text renders citation links as chips),
  // so the foot carries a single stacked-favicon "Sources · N" into the rail.
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5" data-slot="nemesis_message-sources">
      <button
        className={SOURCE_CHIP_CLASS_NAME}
        onClick={() => focusSourceInRail(sources[0].url)}
        title={groups.map(group => group.primary.title).join('\n')}
        type="button"
      >
        <span className="flex -space-x-1.5">
          {groups.slice(0, 3).map(group => (
            <span className="rounded-full bg-background ring-2 ring-background" key={group.primary.url}>
              <SourceFavicon domain={group.primary.domain} />
            </span>
          ))}
        </span>
        <span className="text-foreground/80">Sources</span>
        <span className="shrink-0 text-[10px] font-medium text-muted-foreground/55">{sources.length}</span>
      </button>
    </div>
  )
}
