// NoteRail — the right sidebar for the active note. Outline is a table of contents
// parsed from its markdown headers (h1–h3); Links is its outgoing [[wikilinks]] +
// relative .md links plus the notes that link back to it, and its #tags. Show/hide
// works like the LEFT sidebar: the parent (index.tsx) owns the open state and
// unmounts the rail entirely, so the editor reclaims the full width.
import {
  IconArrowLeft,
  IconArrowUpRight,
  IconFileText,
  IconHash,
  IconLayoutSidebarRightCollapse,
  IconLink,
  IconListTree,
  IconPlus
} from '@tabler/icons-react'
import { type ReactNode, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SegmentedControl, type SegmentedControlOption } from '@/components/ui/segmented-control'
import { Tip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

import { buildResolvableTitleSet, isWikilinkResolved } from './links'
import {
  extractHeadings,
  extractTags,
  extractTypedLinks,
  extractWikilinks,
  type NoteHeading,
  type VaultIndex,
  type VaultNote
} from './vault'

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
  /** Hide the rail — the parent unmounts it and shows a reopen button in the tab strip,
   *  mirroring how the left file-list sidebar collapses. */
  onCollapse: () => void
  /** Create-and-open the note an unresolved [[wikilink]] target points at — clicking an
   *  Unresolved row is the same "make this link real" affordance as clicking the link
   *  itself in the editor (index.tsx's openWikilink). */
  onCreateUnresolved: (target: string) => void
  onOpenNote: (note: VaultNote) => void
  /** Filter the library by a tag (fills the search box with "#tag"). */
  onSearchTag: (tag: string) => void
  onSelectHeading: (line: number) => void
}

export function NoteRail({
  activeNote,
  index,
  notes,
  onCollapse,
  onCreateUnresolved,
  onOpenNote,
  onSearchTag,
  onSelectHeading
}: NoteRailProps) {
  const [tab, setTab] = useState<RailTab>('outline')

  const headings = useMemo(() => extractHeadings(activeNote.content), [activeNote.content])
  const tags = useMemo(() => extractTags(activeNote.content), [activeNote.content])
  const outgoing = index.links.get(activeNote.title) ?? []
  const incoming = index.backlinks.get(activeNote.title) ?? []

  // Same folder-aware resolution rule the editor uses — a [[folder/Title]] link to a
  // real note is resolved, not "unresolved with a path for a name".
  const unresolved = useMemo(() => {
    const resolvable = buildResolvableTitleSet(notes)

    return extractWikilinks(activeNote.content).filter(target => !isWikilinkResolved(target, resolvable))
  }, [activeNote.content, notes])

  // Library Brain phase 2's link grammar (skills/nemesis-notes/SKILL.md): a "## Related"
  // bullet with a leading "word:" that isn't one of the five allowed relationship types.
  const offGrammarLinks = useMemo(
    () => extractTypedLinks(activeNote.content).filter(link => link.type === null),
    [activeNote.content]
  )

  const openByTitle = (title: string) => {
    const note = notes.find(n => n.title === title)

    if (note) {
      onOpenNote(note)
    }
  }

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-l border-(--ui-stroke-tertiary) bg-(--ui-sidebar-surface-background) lg:flex">
      <div className="flex h-(--titlebar-height) shrink-0 items-center gap-2 border-b border-(--ui-stroke-tertiary) px-2">
        <SegmentedControl onChange={setTab} options={RAIL_TABS} value={tab} />
        <Tip label="Hide note panel">
          <Button
            aria-label="Hide note panel"
            className="ml-auto shrink-0 transition-transform duration-200 ease-out active:scale-[0.98]"
            onClick={onCollapse}
            size="icon-xs"
            variant="ghost"
          >
            <IconLayoutSidebarRightCollapse />
          </Button>
        </Tip>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 px-3 pb-4 pt-3">
          {tab === 'outline' ? (
            <OutlineList headings={headings} onSelect={onSelectHeading} />
          ) : (
            <>
              <RailSection
                count={outgoing.length}
                emptyLabel="Write [[Note title]] or a relative .md link to connect ideas."
                title="Links"
              >
                {outgoing.map(title => (
                  <NoteRow icon={<IconArrowUpRight size={13} />} key={title} label={title} onClick={() => openByTitle(title)} />
                ))}
              </RailSection>

              <RailSection count={incoming.length} emptyLabel="Nothing links here yet." title="Backlinks">
                {incoming.map(title => (
                  <NoteRow icon={<IconArrowLeft size={13} />} key={title} label={title} onClick={() => openByTitle(title)} />
                ))}
              </RailSection>

              {tags.length > 0 && (
                <RailSection count={tags.length} emptyLabel="" title="Tags">
                  <div className="flex flex-wrap gap-1.5 px-1 pt-0.5">
                    {tags.map(tag => (
                      <Tip key={tag} label={`Show notes tagged #${tag}`}>
                        <button
                          className="flex items-center gap-0.5 rounded-md bg-(--ui-bg-quaternary) px-1.5 py-0.5 text-[0.6875rem] font-medium text-(--ui-text-secondary) transition-colors duration-200 ease-out hover:bg-(--ui-row-hover-background) hover:text-foreground active:scale-[0.98]"
                          onClick={() => onSearchTag(tag)}
                          type="button"
                        >
                          <IconHash className="opacity-55" size={11} />
                          {tag}
                        </button>
                      </Tip>
                    ))}
                  </div>
                </RailSection>
              )}

              {unresolved.length > 0 && (
                <RailSection count={unresolved.length} emptyLabel="" title="Unresolved">
                  {unresolved.map(target => {
                    const slash = target.lastIndexOf('/')
                    const name = slash >= 0 ? target.slice(slash + 1) : target
                    const folder = slash >= 0 ? target.slice(0, slash) : ''

                    return (
                      <Tip key={target} label={`Create “${target}”`}>
                        <button
                          className="group flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-200 ease-out hover:bg-(--ui-row-hover-background) active:scale-[0.98]"
                          onClick={() => onCreateUnresolved(target)}
                          type="button"
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[0.8125rem] text-muted-foreground group-hover:text-foreground">
                              {name}
                            </span>
                            {folder && (
                              <span className="block truncate text-[0.625rem] text-(--ui-text-quaternary)">{folder}</span>
                            )}
                          </span>
                          <IconPlus className="shrink-0 opacity-0 transition-opacity duration-200 group-hover:opacity-60" size={13} />
                        </button>
                      </Tip>
                    )
                  })}
                </RailSection>
              )}

              {offGrammarLinks.length > 0 && (
                <RailSection count={offGrammarLinks.length} emptyLabel="" title="Off-grammar links">
                  <p className="px-2 pb-1 text-[0.6875rem] leading-relaxed text-(--ui-text-quaternary)">
                    Only the five grammar words resolve as typed relationships — see nemesis-notes.
                  </p>
                  {offGrammarLinks.map((link, i) => (
                    <div
                      className="flex min-w-0 items-center gap-1.5 px-2 py-1"
                      key={`${link.prefix}::${link.target}::${i}`}
                    >
                      <span className="truncate text-[0.8125rem] text-(--ui-text-secondary)">{link.prefix}</span>
                      <span className="shrink-0 text-(--ui-text-quaternary)">{'→'}</span>
                      <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-muted-foreground">
                        [[{link.target}]]
                      </span>
                    </div>
                  ))}
                </RailSection>
              )}
            </>
          )}
        </div>
      </ScrollArea>
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

/** One titled group in the Links tab — heading + count, then full-width rows (not pills:
 *  long note titles and folder paths truncate instead of overflowing the rail). */
function RailSection({
  children,
  count,
  emptyLabel,
  title
}: {
  children: ReactNode
  count: number
  emptyLabel: string
  title: string
}) {
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center justify-between gap-2 px-2">
        <h3 className="text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-muted-foreground">{title}</h3>
        <span className="text-[0.65rem] tabular-nums text-(--ui-text-quaternary)">{count}</span>
      </div>
      {count > 0 ? (
        <div className="flex flex-col gap-0.5">{children}</div>
      ) : (
        <p className="px-2 py-1 text-[0.6875rem] leading-relaxed text-(--ui-text-quaternary)">{emptyLabel}</p>
      )}
    </div>
  )
}

function NoteRow({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      className="group flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-200 ease-out hover:bg-(--ui-row-hover-background) active:scale-[0.98]"
      onClick={onClick}
      type="button"
    >
      <span className="shrink-0 text-(--ui-text-quaternary) transition-colors duration-200 group-hover:text-(--ui-text-secondary)">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-(--ui-text-secondary) transition-colors duration-200 group-hover:text-foreground">
        {label}
      </span>
      <IconFileText className="shrink-0 opacity-0 transition-opacity duration-200 group-hover:opacity-40" size={13} />
    </button>
  )
}
