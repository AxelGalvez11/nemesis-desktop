// NoteRail — the right sidebar for the active note. Outline is a table of contents
// parsed from its markdown headers (h1–h3); Links is its outgoing [[wikilinks]] +
// relative .md links plus the notes that link back to it. Collapses to a thin strip,
// Obsidian-style, with the collapsed state remembered across sessions.
import {
  IconLayoutSidebarRightCollapse,
  IconLayoutSidebarRightExpand,
  IconLink,
  IconListTree
} from '@tabler/icons-react'
import { useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SegmentedControl, type SegmentedControlOption } from '@/components/ui/segmented-control'
import { Tip } from '@/components/ui/tooltip'
import { persistBoolean, storedBoolean } from '@/lib/storage'
import { cn } from '@/lib/utils'

import { extractHeadings, extractWikilinks, type NoteHeading, type VaultIndex, type VaultNote } from './vault'

const COLLAPSED_KEY = 'hermes.desktop.library.rightRailCollapsed'

type RailTab = 'outline' | 'links'

const RAIL_TABS: readonly SegmentedControlOption<RailTab>[] = [
  { id: 'outline', icon: IconListTree, label: 'Outline' },
  { id: 'links', icon: IconLink, label: 'Links' }
]

const OUTLINE_INDENT: Record<1 | 2 | 3, string> = { 1: 'pl-2', 2: 'pl-5', 3: 'pl-8' }

export interface NoteRailProps {
  activeNote: VaultNote
  index: VaultIndex
  notes: VaultNote[]
  onOpenNote: (note: VaultNote) => void
  onSelectHeading: (line: number) => void
}

export function NoteRail({ activeNote, index, notes, onOpenNote, onSelectHeading }: NoteRailProps) {
  const [collapsed, setCollapsed] = useState(() => storedBoolean(COLLAPSED_KEY, false))
  const [tab, setTab] = useState<RailTab>('outline')

  const toggleCollapsed = () => {
    setCollapsed(current => {
      const next = !current
      persistBoolean(COLLAPSED_KEY, next)

      return next
    })
  }

  const headings = useMemo(() => extractHeadings(activeNote.content), [activeNote.content])
  const outgoing = index.links.get(activeNote.title) ?? []
  const incoming = index.backlinks.get(activeNote.title) ?? []

  const unresolved = useMemo(
    () =>
      extractWikilinks(activeNote.content).filter(
        target => !notes.some(note => note.title.toLowerCase() === target.toLowerCase())
      ),
    [activeNote.content, notes]
  )

  const openByTitle = (title: string) => {
    const note = notes.find(n => n.title === title)

    if (note) {
      onOpenNote(note)
    }
  }

  return (
    <aside
      className={cn(
        'hidden shrink-0 flex-col border-l border-(--ui-stroke-tertiary) bg-(--ui-sidebar-surface-background) lg:flex',
        collapsed ? 'w-10' : 'w-64'
      )}
    >
      <div className="flex h-(--titlebar-height) shrink-0 items-center gap-2 border-b border-(--ui-stroke-tertiary) px-2">
        {!collapsed && <SegmentedControl onChange={setTab} options={RAIL_TABS} value={tab} />}
        <Tip label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          <Button
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="ml-auto shrink-0 transition-transform duration-200 ease-out active:scale-[0.98]"
            onClick={toggleCollapsed}
            size="icon-xs"
            variant="ghost"
          >
            {collapsed ? <IconLayoutSidebarRightExpand /> : <IconLayoutSidebarRightCollapse />}
          </Button>
        </Tip>
      </div>

      {!collapsed && (
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-3 px-3 pb-4 pt-3">
            {tab === 'outline' ? (
              <OutlineList headings={headings} onSelect={onSelectHeading} />
            ) : (
              <>
                <LinkGroup
                  emptyLabel="Write [[Note title]] or a relative .md link to connect ideas."
                  onOpen={openByTitle}
                  title="Links"
                  titles={outgoing}
                />
                <LinkGroup emptyLabel="Nothing links here yet." onOpen={openByTitle} title="Backlinks" titles={incoming} />
                {unresolved.length > 0 && (
                  <div className="rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-3 shadow-[inset_0_1px_0_var(--ui-stroke-quaternary)]">
                    <div className="mb-2 flex items-center justify-between">
                      <h3 className="text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
                        Unresolved
                      </h3>
                      <span className="text-[0.65rem] tabular-nums text-(--ui-text-quaternary)">{unresolved.length}</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {unresolved.map(target => (
                        <span
                          className="rounded-full border border-dashed border-(--ui-stroke-secondary) px-2.5 py-1 text-[0.6875rem] text-muted-foreground"
                          key={target}
                        >
                          {target}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </ScrollArea>
      )}
    </aside>
  )
}

function OutlineList({ headings, onSelect }: { headings: NoteHeading[]; onSelect: (line: number) => void }) {
  if (!headings.length) {
    return (
      <div className="rounded-lg border border-dashed border-(--ui-stroke-tertiary) px-3 py-3">
        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--ui-text-quaternary)">No headings</p>
        <p className="mt-1 text-[0.6875rem] leading-relaxed text-muted-foreground">
          Add a # heading, ## heading, or ### heading to build a table of contents.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-0.5">
      {headings.map(heading => (
        <button
          className={cn(
            'truncate rounded-lg py-1.5 text-left text-[0.8125rem] text-(--ui-text-secondary) transition-colors duration-200 ease-out hover:bg-(--ui-row-hover-background) hover:text-foreground active:scale-[0.98]',
            OUTLINE_INDENT[heading.level],
            heading.level === 1 && 'font-semibold text-foreground'
          )}
          key={heading.line}
          onClick={() => onSelect(heading.line)}
          type="button"
        >
          {heading.text}
        </button>
      ))}
    </div>
  )
}

function LinkGroup({
  emptyLabel,
  onOpen,
  title,
  titles
}: {
  emptyLabel: string
  onOpen: (title: string) => void
  title: string
  titles: string[]
}) {
  return (
    <div className="rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-card) p-3 shadow-[inset_0_1px_0_var(--ui-stroke-quaternary)]">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <h3 className="text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-muted-foreground">{title}</h3>
        <span className="rounded-full bg-(--ui-bg-quaternary) px-1.5 py-0.5 text-[0.625rem] font-medium tabular-nums text-(--ui-text-tertiary)">
          {titles.length}
        </span>
      </div>
      {titles.length ? (
        <div className="flex flex-wrap gap-1.5">
          {titles.map(target => (
            <button
              className="rounded-full border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) px-2.5 py-1 text-[0.6875rem] text-(--ui-text-secondary) transition-[transform,color,border-color,background-color] duration-200 ease-out hover:border-(--theme-primary)/40 hover:bg-(--ui-bg-primary) hover:text-foreground active:scale-[0.98]"
              key={target}
              onClick={() => onOpen(target)}
              type="button"
            >
              {target}
            </button>
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-(--ui-stroke-tertiary) px-3 py-3">
          <p className="text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--ui-text-quaternary)">None yet</p>
          <p className="mt-1 text-[0.6875rem] leading-relaxed text-muted-foreground">{emptyLabel}</p>
        </div>
      )}
    </div>
  )
}
