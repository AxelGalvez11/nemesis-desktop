// Library — the notes vault page. A folder tree (left) over recursive Obsidian-compatible
// Markdown, a prose-styled CodeMirror editor (middle, de-code-ified via .nemesis-prose-editor
// CSS), and a collapsible Outline/Links rail (right). Non-markdown files (PDF/images inline;
// slides/docs open externally) preview in place. Autosaves 800ms after typing.
import {
  IconArrowLeft,
  IconArrowRight,
  IconChevronRight,
  IconFilePlus,
  IconFileText,
  IconFileTypePdf,
  IconFolder,
  IconFolderOpen,
  IconFolderPlus,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconPaperclip,
  IconPhoto,
  IconPresentation,
  IconX
} from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Tip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { notifyError } from '@/store/notifications'

import { type ArtifactRecord, loadRecentArtifacts, openArtifactHref } from '../artifacts/artifact-utils'

import { NoteEditor, type NoteEditorHandle } from './note-editor'
import { NoteRail } from './note-rail'
import { PdfViewer } from './pdf-viewer'
import {
  buildIndex,
  createFolder,
  loadVaultContents,
  saveNote,
  SEED_NOTES,
  VAULT_DIR,
  type VaultContents,
  type VaultFile,
  type VaultNote
} from './vault'

type Selection = { kind: 'note'; note: VaultNote } | { kind: 'file'; file: VaultFile } | null
type TabItem = NonNullable<Selection>

function tabKey(tab: TabItem): string {
  return tab.kind === 'note' ? tab.note.path : tab.file.path
}

function tabLabel(tab: TabItem): string {
  return tab.kind === 'note' ? tab.note.title : tab.file.name
}

function countWords(value: string): number {
  return value.trim().match(/\S+/g)?.length ?? 0
}

const SIDEBAR_KEY = 'nemesis.library.sidebar.v1'

/** Browser-style visit history over opened notes/files. Pure: visit/step in,
 *  new state out — unit-testable without React. */
export interface NavHistory {
  stack: TabItem[]
  pos: number
}

export function recordNavVisit(current: NavHistory, next: TabItem): NavHistory {
  const atCursor = current.pos >= 0 ? current.stack[current.pos] : undefined

  if (atCursor && tabKey(atCursor) === tabKey(next)) {
    return current
  }

  const stack = [...current.stack.slice(0, current.pos + 1), next].slice(-60)

  return { pos: stack.length - 1, stack }
}

interface TreeNode {
  name: string
  path: string
  folders: TreeNode[]
  notes: VaultNote[]
  files: VaultFile[]
}

function buildTree(contents: VaultContents): TreeNode {
  const root: TreeNode = { files: [], folders: [], name: '', notes: [], path: '' }
  const nodeFor = (folder: string): TreeNode => {
    if (!folder) {
      return root
    }

    let node = root

    for (const part of folder.split('/')) {
      const next = node.folders.find(child => child.name === part)

      if (next) {
        node = next
      } else {
        const created: TreeNode = {
          files: [],
          folders: [],
          name: part,
          notes: [],
          path: node.path ? `${node.path}/${part}` : part
        }
        node.folders.push(created)
        node = created
      }
    }

    return node
  }

  for (const folder of contents.folders) {
    nodeFor(folder)
  }

  for (const note of contents.notes) {
    nodeFor(note.folder).notes.push(note)
  }

  for (const file of contents.files) {
    nodeFor(file.folder).files.push(file)
  }

  return root
}

export function LibraryView() {
  const [contents, setContents] = useState<VaultContents | null>(null)
  const [deliverables, setDeliverables] = useState<ArtifactRecord[] | null>(null)
  const [error, setError] = useState<null | string>(null)
  // Obsidian-style tabs: every opened note/file gets (or refocuses) a tab.
  const [tabs, setTabs] = useState<TabItem[]>([])
  const [activeTab, setActiveTab] = useState(0)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState<null | 'folder' | 'note'>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [searchParams] = useSearchParams()
  const saveTimer = useRef<null | ReturnType<typeof setTimeout>>(null)
  const noteEditorRef = useRef<NoteEditorHandle>(null)
  // Folder-tree sidebar visibility (persisted) + browser-style visit history.
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try {
      return window.localStorage.getItem(SIDEBAR_KEY) !== '0'
    } catch {
      return true
    }
  })
  const [nav, setNavState] = useState<NavHistory>({ pos: -1, stack: [] })
  const navRef = useRef(nav)
  navRef.current = nav
  // Set while a back/forward jump re-opens an entry, so the jump itself
  // doesn't get recorded as a fresh visit.
  const navigatingRef = useRef(false)

  const setSidebar = useCallback((open: boolean) => {
    setSidebarOpen(open)

    try {
      window.localStorage.setItem(SIDEBAR_KEY, open ? '1' : '0')
    } catch {
      // persistence is best-effort
    }
  }, [])

  const startCreating = useCallback(
    (mode: 'folder' | 'note') => {
      setSidebar(true)
      setCreating(mode)
      setDraft('')
    },
    [setSidebar]
  )

  const recordVisit = useCallback((next: TabItem) => {
    if (navigatingRef.current) {
      return
    }

    setNavState(current => recordNavVisit(current, next))
  }, [])

  const refresh = useCallback(async () => {
    try {
      let loaded = await loadVaultContents()

      if (!loaded.notes.length && !loaded.files.length) {
        for (const seed of SEED_NOTES) {
          await saveNote(seed.title, seed.content)
        }

        loaded = await loadVaultContents()
      }

      setContents(loaded)
      setError(null)

      return loaded
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the Library folder.')

      return null
    }
  }, [])

  const refreshDeliverables = useCallback(async () => {
    try {
      setDeliverables(await loadRecentArtifacts())
    } catch (err) {
      setDeliverables([])
      notifyError(err, 'Could not load files made by Nemesis.')
    }
  }, [])

  const openDeliverable = useCallback(async (artifact: ArtifactRecord) => {
    try {
      // A vault file deliverable is often recorded as a vault-RELATIVE path
      // ("Exports/report.html"); resolve it against the vault root so it opens in
      // the preview pane rather than falling through to an unresolvable href.
      const isSchemeOrAbsolute = /^(?:[a-z]+:|\/|~)/i.test(artifact.value)
      const target =
        artifact.kind === 'file' && !isSchemeOrAbsolute ? `${VAULT_DIR}/${artifact.value}` : artifact.href

      await openArtifactHref(target)
    } catch (err) {
      notifyError(err, 'Could not open this deliverable.')
    }
  }, [])

  const openSelection = useCallback(
    (next: TabItem) => {
      const key = tabKey(next)
      setTabs(current => {
        const existing = current.findIndex(tab => tabKey(tab) === key)

        if (existing >= 0) {
          setActiveTab(existing)

          return current
        }

        setActiveTab(current.length)

        return [...current, next]
      })
      recordVisit(next)
    },
    [recordVisit]
  )

  // Back/forward over the visit history — re-opens the entry (restoring its
  // tab if it was closed) without recording the jump as a new visit.
  const goHistory = useCallback(
    (delta: -1 | 1) => {
      const { pos, stack } = navRef.current
      const target = stack[pos + delta]

      if (!target) {
        return
      }

      navigatingRef.current = true
      openSelection(target)
      navigatingRef.current = false
      setNavState({ pos: pos + delta, stack })
    },
    [openSelection]
  )

  // Cmd+N = new note, Cmd+[ / Cmd+] = back / forward (skipped while typing in
  // the editor, where CodeMirror owns bracket shortcuts for indentation).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) {
        return
      }

      const inEditor = event.target instanceof HTMLElement && Boolean(event.target.closest('.cm-editor'))

      if (event.key === 'n') {
        event.preventDefault()
        startCreating('note')
      } else if (event.key === '[' && !inEditor) {
        event.preventDefault()
        goHistory(-1)
      } else if (event.key === ']' && !inEditor) {
        event.preventDefault()
        goHistory(1)
      }
    }

    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  }, [goHistory, startCreating])

  const closeTab = useCallback(
    (index: number) => {
      setTabs(current => current.filter((_, i) => i !== index))
      setActiveTab(current => (index < current ? current - 1 : Math.max(0, Math.min(current, tabs.length - 2))))
    },
    [tabs.length]
  )

  useEffect(() => {
    void (async () => {
      const loaded = await refresh()

      if (loaded && tabs.length === 0 && loaded.notes[0]) {
        openSelection({ kind: 'note', note: loaded.notes[0] })
      }
    })()
    void refreshDeliverables()

    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, refreshDeliverables])

  // Re-read the vault when the window regains focus so files the agent moved,
  // renamed, or created while you were away show up without a manual reload.
  // Debounced so an incidental refocus doesn't hammer the disk.
  useEffect(() => {
    let last = 0

    const onFocus = () => {
      const now = Date.now()

      if (now - last < 1500) {
        return
      }

      last = now
      void refresh()
      void refreshDeliverables()
    }

    window.addEventListener('focus', onFocus)

    return () => window.removeEventListener('focus', onFocus)
  }, [refresh, refreshDeliverables])

  const tree = useMemo(() => (contents ? buildTree(contents) : null), [contents])
  const index = useMemo(() => (contents ? buildIndex(contents.notes) : null), [contents])

  // Deep links from the Graph page: /library?note=Title opens a note,
  // /library?create=note lands with the new-note field already open.
  useEffect(() => {
    const requested = searchParams.get('note')

    if (requested && contents) {
      const note = contents.notes.find(n => n.title === requested)

      if (note) {
        openSelection({ kind: 'note', note })
      }
    }

    if (searchParams.get('create') === 'note') {
      startCreating('note')
    }
  }, [contents, openSelection, searchParams, startCreating])

  // Tabs hold snapshots; always render the freshest note object from `contents`
  // so switching back to a tab shows the edits made since it was opened.
  const selection: Selection = useMemo(() => {
    const tab = tabs[activeTab]

    if (!tab) {
      return null
    }

    if (tab.kind === 'note' && contents) {
      const fresh = contents.notes.find(note => note.path === tab.note.path)

      return { kind: 'note', note: fresh ?? tab.note }
    }

    return tab
  }, [activeTab, contents, tabs])

  const activeNote = selection?.kind === 'note' ? selection.note : null

  const scheduleSave = useCallback((note: VaultNote, content: string) => {
    setContents(current =>
      current ? { ...current, notes: current.notes.map(n => (n.path === note.path ? { ...n, content } : n)) } : current
    )

    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
    }

    saveTimer.current = setTimeout(() => {
      setSaving(true)
      void saveNote(note.title, content, note.folder).finally(() => setSaving(false))
    }, 800)
  }, [])

  // Outline tab entries drive the editor imperatively — scrolling to a line isn't
  // something the editor's props model expresses, so this goes through its ref handle.
  const handleSelectHeading = useCallback((line: number) => {
    noteEditorRef.current?.scrollToLine(line)
  }, [])

  const targetFolder =
    selection?.kind === 'note' ? selection.note.folder : selection?.kind === 'file' ? selection.file.folder : ''

  // Click a [[wikilink]] in the editor: open the note if it exists, create it if not —
  // the Obsidian affordance that makes links feel alive.
  const openWikilink = useCallback(
    async (target: string) => {
      const loaded = contents ?? (await refresh())

      if (!loaded) {
        return
      }

      // Obsidian-style targets: plain [[Title]] or path-qualified
      // [[Folder/Title]] (the agent writes the latter into Home.md). Resolve
      // both; a missing path-qualified note is created IN its folder rather
      // than as a root note with a slash jammed into the name.
      const wanted = target.toLowerCase()
      const existing = loaded.notes.find(
        n => n.title.toLowerCase() === wanted || `${n.folder}/${n.title}`.toLowerCase() === wanted
      )

      if (existing) {
        openSelection({ kind: 'note', note: existing })

        return
      }

      const slash = target.lastIndexOf('/')
      const folder = slash > 0 ? target.slice(0, slash) : ''
      const title = slash > 0 ? target.slice(slash + 1) : target

      if (folder) {
        await createFolder(folder)
      }

      await saveNote(title, `# ${title}\n\n`, folder)
      const after = await refresh()
      const created = after?.notes.find(
        n => n.title.toLowerCase() === title.toLowerCase() && (!folder || n.folder.toLowerCase() === folder.toLowerCase())
      )

      if (created) {
        openSelection({ kind: 'note', note: created })
      }
    },
    [contents, openSelection, refresh]
  )

  const submitCreate = useCallback(async () => {
    const name = draft.trim()

    if (!name) {
      return
    }

    if (creating === 'folder') {
      await createFolder(targetFolder ? `${targetFolder}/${name}` : name)
    } else {
      await saveNote(name, `# ${name}\n\n`, targetFolder)
    }

    setDraft('')
    const mode = creating
    setCreating(null)
    const loaded = await refresh()

    if (mode === 'note' && loaded) {
      const note = loaded.notes.find(n => n.title === name && n.folder === targetFolder)

      if (note) {
        openSelection({ kind: 'note', note })
      }
    }
  }, [creating, draft, openSelection, refresh, targetFolder])

  if (error) {
    return <EmptyState className="h-full" description={`${error} (${VAULT_DIR})`} title="Library unavailable" />
  }

  if (!contents || !tree) {
    return <EmptyState className="h-full" description="Opening your vault…" title="Library" />
  }

  const noteCount = contents.notes.length
  const fileCount = contents.files.length

  return (
    <div className="flex h-full min-h-0 bg-(--ui-editor-surface-background)">
      {/* Folder tree */}
      {sidebarOpen && (
      <aside className="flex w-64 shrink-0 flex-col border-r border-(--ui-stroke-tertiary) bg-(--ui-sidebar-surface-background)">
        <div className="flex items-center justify-between gap-3 px-4 pb-3 pt-5">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight">Library</h1>
            <p className="mt-0.5 text-[0.65rem] font-medium tabular-nums text-(--ui-text-tertiary)">
              {noteCount} note{noteCount === 1 ? '' : 's'} · {fileCount} file{fileCount === 1 ? '' : 's'}
            </p>
          </div>
          <div className="flex gap-0.5">
            <Tip label="New note (⌘N)">
              <Button
                aria-label="New note"
                className="transition-transform duration-200 ease-out active:scale-[0.98]"
                onClick={() => startCreating('note')}
                size="icon-xs"
                variant="ghost"
              >
                <IconFilePlus />
              </Button>
            </Tip>
            <Tip label="New folder">
              <Button
                aria-label="New folder"
                className="transition-transform duration-200 ease-out active:scale-[0.98]"
                onClick={() => startCreating('folder')}
                size="icon-xs"
                variant="ghost"
              >
                <IconFolderPlus />
              </Button>
            </Tip>
            <Tip label="Hide file list">
              <Button
                aria-label="Hide file list"
                className="transition-transform duration-200 ease-out active:scale-[0.98]"
                onClick={() => setSidebar(false)}
                size="icon-xs"
                variant="ghost"
              >
                <IconLayoutSidebarLeftCollapse />
              </Button>
            </Tip>
          </div>
        </div>
        {creating && (
          <div className="mx-3 mb-2 rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) p-2 shadow-sm">
            <Input
              autoFocus
              onChange={event => setDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  void submitCreate()
                }

                if (event.key === 'Escape') {
                  setCreating(null)
                }
              }}
              placeholder={creating === 'folder' ? 'Folder name' : 'Note title'}
              value={draft}
            />
            {targetFolder && <p className="px-1 pt-1.5 text-[10px] text-muted-foreground">in {targetFolder}</p>}
          </div>
        )}
        <nav className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-4">
          <section className="mb-3 border-b border-(--ui-stroke-quaternary) pb-3">
            <div className="mb-1.5 flex items-center justify-between gap-2 px-2">
              <h2 className="text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--ui-text-tertiary)">
                Made by Nemesis
              </h2>
              {deliverables && deliverables.length > 0 && (
                <span className="text-[0.625rem] tabular-nums text-(--ui-text-quaternary)">{deliverables.length}</span>
              )}
            </div>
            {!deliverables ? (
              <p className="px-2 py-1 text-xs text-(--ui-text-tertiary)">Finding deliverables…</p>
            ) : deliverables.length === 0 ? (
              <p className="px-2 py-1 text-xs text-(--ui-text-tertiary)">Chat-made files will appear here.</p>
            ) : (
              <div className="space-y-0.5">
                {deliverables.map(artifact => (
                  <button
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[0.8125rem] text-(--ui-text-secondary) transition-colors hover:bg-(--ui-row-hover-background) hover:text-foreground"
                    key={artifact.id}
                    onClick={() => void openDeliverable(artifact)}
                    title={`${artifact.label} · ${artifact.sessionTitle}`}
                    type="button"
                  >
                    {artifact.kind === 'image' ? (
                      <IconPhoto className="shrink-0 text-(--theme-primary)" size={14} />
                    ) : (
                      <IconFileText className="shrink-0 text-(--theme-primary)" size={14} />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{artifact.label}</span>
                      <span className="block truncate text-[0.625rem] text-(--ui-text-tertiary)">
                        {artifact.sessionTitle}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
          <TreeLevel
            collapsed={collapsed}
            depth={0}
            node={tree}
            onSelect={next => next && openSelection(next)}
            onToggle={path =>
              setCollapsed(current => {
                const next = new Set(current)
                next.has(path) ? next.delete(path) : next.add(path)

                return next
              })
            }
            selection={selection}
          />
        </nav>
      </aside>
      )}

      {/* Editor / preview */}
      <main className="flex min-w-0 flex-1 flex-col bg-(--ui-bg-editor)">
        {(tabs.length > 0 || !sidebarOpen) && (
          <div className="flex h-(--titlebar-height) shrink-0 items-stretch border-b border-(--ui-stroke-tertiary) bg-(--ui-sidebar-surface-background)">
            {/* Navigation cluster: sidebar re-open + browser-style back/forward */}
            <div className="flex shrink-0 items-center gap-0.5 border-r border-(--ui-stroke-quaternary) px-1.5">
              {!sidebarOpen && (
                <Tip label="Show file list">
                  <Button aria-label="Show file list" onClick={() => setSidebar(true)} size="icon-xs" variant="ghost">
                    <IconLayoutSidebarLeftExpand />
                  </Button>
                </Tip>
              )}
              <Tip label="Back (⌘[)">
                <Button
                  aria-label="Back"
                  disabled={nav.pos <= 0}
                  onClick={() => goHistory(-1)}
                  size="icon-xs"
                  variant="ghost"
                >
                  <IconArrowLeft />
                </Button>
              </Tip>
              <Tip label="Forward (⌘])">
                <Button
                  aria-label="Forward"
                  disabled={nav.pos >= nav.stack.length - 1}
                  onClick={() => goHistory(1)}
                  size="icon-xs"
                  variant="ghost"
                >
                  <IconArrowRight />
                </Button>
              </Tip>
            </div>
            <div
              className="flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              role="tablist"
            >
            {tabs.map((tab, i) => (
              <div
                className={cn(
                  'group/tab relative flex h-full min-w-0 max-w-48 shrink-0 cursor-pointer items-center border-r border-(--ui-stroke-quaternary) text-[0.6875rem] font-medium transition-colors duration-200 ease-out',
                  i === activeTab
                    ? 'bg-(--ui-bg-editor) text-foreground'
                    : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
                )}
                key={tabKey(tab)}
                onClick={() => {
                  setActiveTab(i)
                  recordVisit(tab)
                }}
                role="tab"
              >
                {i === activeTab && <span aria-hidden className="absolute inset-x-0 top-0 h-px bg-(--theme-primary)" />}
                <span className="flex min-w-0 items-center gap-1.5 py-2 pl-3 pr-8">
                  {tab.kind === 'note' ? (
                    <IconFileText className="shrink-0 opacity-60" size={13} />
                  ) : (
                    <FileGlyph kind={tab.file.kind} />
                  )}
                  <span className="truncate">{tabLabel(tab)}</span>
                </span>
                <button
                  aria-label="Close tab"
                  className="absolute right-1.5 grid size-5 place-items-center rounded opacity-0 transition-[opacity,color] duration-200 ease-out hover:bg-(--chrome-action-hover) group-hover/tab:opacity-100 group-focus-within/tab:opacity-100"
                  onClick={event => {
                    event.stopPropagation()
                    closeTab(i)
                  }}
                  type="button"
                >
                  <IconX size={11} />
                </button>
              </div>
            ))}
            </div>
          </div>
        )}
        {selection?.kind === 'note' ? (
          <>
            <div className="shrink-0 border-b border-(--ui-stroke-quaternary) px-7 pb-4 pt-6">
              <div className="flex items-end justify-between gap-6">
                <div className="min-w-0">
                  <div className="mb-2 flex min-w-0 items-center gap-1.5 text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--ui-text-tertiary)">
                    <span>Library</span>
                    {selection.note.folder
                      .split('/')
                      .filter(Boolean)
                      .map((part, index) => (
                        <span className="contents" key={`${part}-${index}`}>
                          <IconChevronRight className="shrink-0 opacity-50" size={11} />
                          <span className="truncate">{part}</span>
                        </span>
                      ))}
                  </div>
                  <h2 className="truncate text-2xl font-semibold tracking-[-0.025em]">{selection.note.title}</h2>
                </div>
                <div className="flex shrink-0 items-center gap-2 text-[0.6875rem] text-(--ui-text-tertiary)">
                  <span className="tabular-nums">{countWords(selection.note.content)} words</span>
                  <span className="rounded-full border border-(--ui-stroke-tertiary) bg-(--ui-bg-quaternary) px-2.5 py-1 font-medium">
                    {saving ? 'Saving…' : 'Saved to disk'}
                  </span>
                </div>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden px-7 pb-3">
              <NoteEditor
                initialValue={selection.note.content}
                key={selection.note.path}
                onChange={value => scheduleSave(selection.note, value)}
                onOpenWikilink={target => void openWikilink(target)}
                ref={noteEditorRef}
              />
            </div>
          </>
        ) : selection?.kind === 'file' ? (
          <FilePreview file={selection.file} />
        ) : (
          <div className="grid flex-1 place-items-center text-center">
            <div className="flex flex-col items-center gap-3">
              <div>
                <div className="text-sm font-medium">No note open</div>
                <div className="mt-1 text-xs text-muted-foreground">Pick a note on the left, or start a fresh one.</div>
              </div>
              <Button onClick={() => startCreating('note')} size="sm" variant="secondary">
                <IconFilePlus size={15} />
                New note
              </Button>
            </div>
          </div>
        )}
      </main>

      {/* Outline/Links rail (notes only) */}
      {activeNote && index && (
        <NoteRail
          activeNote={activeNote}
          index={index}
          notes={contents.notes}
          onOpenNote={note => openSelection({ kind: 'note', note })}
          onSelectHeading={handleSelectHeading}
        />
      )}
    </div>
  )
}

function FileGlyph({ kind }: { kind: VaultFile['kind'] }) {
  const Icon =
    kind === 'pdf'
      ? IconFileTypePdf
      : kind === 'html'
        ? IconPresentation
        : kind === 'slides'
          ? IconPresentation
          : kind === 'image'
            ? IconPhoto
            : kind === 'doc'
              ? IconFileText
              : IconPaperclip

  return <Icon className="shrink-0 opacity-60" size={14} />
}

function TreeLevel({
  collapsed,
  depth,
  node,
  onSelect,
  onToggle,
  selection
}: {
  collapsed: Set<string>
  depth: number
  node: TreeNode
  onSelect: (selection: Selection) => void
  onToggle: (path: string) => void
  selection: Selection
}) {
  return (
    <div className={cn('space-y-0.5', depth > 0 && 'ml-3 border-l border-(--ui-stroke-quaternary) pl-1.5')}>
      {node.folders
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(folder => {
          const isCollapsed = collapsed.has(folder.path)

          return (
            <div className="pb-0.5" key={folder.path}>
              <button
                className="group/folder flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[0.68rem] font-semibold uppercase tracking-[0.075em] text-(--ui-text-secondary) transition-[transform,color,background-color] duration-200 ease-out hover:bg-(--ui-row-hover-background) hover:text-foreground active:scale-[0.98]"
                onClick={() => onToggle(folder.path)}
                type="button"
              >
                <IconChevronRight
                  className={cn('shrink-0 transition-transform duration-200 ease-out', !isCollapsed && 'rotate-90')}
                  size={12}
                />
                {isCollapsed ? (
                  <IconFolder
                    className="shrink-0 text-(--ui-text-tertiary) group-hover/folder:text-(--theme-primary)"
                    size={14}
                  />
                ) : (
                  <IconFolderOpen className="shrink-0 text-(--theme-primary)" size={14} />
                )}
                <span className="truncate">{folder.name}</span>
              </button>
              {!isCollapsed && (
                <TreeLevel
                  collapsed={collapsed}
                  depth={depth + 1}
                  node={folder}
                  onSelect={onSelect}
                  onToggle={onToggle}
                  selection={selection}
                />
              )}
            </div>
          )
        })}
      {node.notes
        .slice()
        .sort((a, b) => a.title.localeCompare(b.title))
        .map(note => (
          <button
            className={cn(
              'relative flex w-full items-center gap-2 truncate rounded-lg px-2 py-1.5 text-left text-[0.8125rem] text-(--ui-text-secondary) transition-[transform,color,background-color] duration-200 ease-out before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-transparent hover:bg-(--ui-row-hover-background) hover:text-foreground active:scale-[0.98]',
              selection?.kind === 'note' &&
                selection.note.path === note.path &&
                'font-semibold text-foreground before:bg-(--theme-primary)'
            )}
            key={note.path}
            onClick={() => onSelect({ kind: 'note', note })}
            type="button"
          >
            <IconFileText className="shrink-0 opacity-55" size={14} />
            <span className="truncate">{note.title}</span>
          </button>
        ))}
      {node.files
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(file => (
          <button
            className={cn(
              'relative flex w-full items-center gap-2 truncate rounded-lg px-2 py-1.5 text-left text-[0.8125rem] text-(--ui-text-tertiary) transition-[transform,color,background-color] duration-200 ease-out before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-transparent hover:bg-(--ui-row-hover-background) hover:text-foreground active:scale-[0.98]',
              selection?.kind === 'file' &&
                selection.file.path === file.path &&
                'font-semibold text-foreground before:bg-(--theme-primary)'
            )}
            key={file.path}
            onClick={() => onSelect({ file, kind: 'file' })}
            type="button"
          >
            <FileGlyph kind={file.kind} />
            <span className="truncate">{file.name}</span>
          </button>
        ))}
    </div>
  )
}

function fileUrl(path: string): string {
  return `file://${encodeURI(path).replace(/#/g, '%23')}`
}

function FilePreview({ file }: { file: VaultFile }) {
  const url = fileUrl(file.path)
  const openExternal = () => void window.hermesDesktop?.openExternal?.(url)
  const reveal = () => void window.hermesDesktop?.revealPath?.(file.path)

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-(--ui-bg-editor)">
      <div className="flex items-end justify-between gap-4 border-b border-(--ui-stroke-quaternary) px-6 pb-4 pt-6">
        <div className="min-w-0">
          <p className="mb-1.5 text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--ui-text-tertiary)">
            {file.folder || 'Library'} · {file.kind}
          </p>
          <h2 className="truncate text-xl font-semibold tracking-tight">{file.name}</h2>
        </div>
        <div className="flex gap-2">
          <Button onClick={openExternal} size="sm" variant="outline">
            Open in default app
          </Button>
          <Button onClick={reveal} size="sm" variant="outline">
            Reveal
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 px-5 pb-5">
        {file.kind === 'pdf' ? (
          <PdfViewer path={file.path} />
        ) : file.kind === 'html' ? (
          // Agent-generated deliverables (slides/reports) render live. Sandboxed:
          // no scripts, so the deck's own scroll-snap CSS drives it and nothing runs.
          <iframe
            className="h-full w-full rounded-lg border border-border bg-white"
            sandbox=""
            src={url}
            title={file.name}
          />
        ) : file.kind === 'image' ? (
          <div className="grid h-full place-items-center rounded-lg border border-border bg-card p-4">
            <img alt={file.name} className="max-h-full max-w-full object-contain" src={url} />
          </div>
        ) : (
          <EmptyState
            className="h-full"
            description={
              file.kind === 'slides'
                ? 'PowerPoint/Keynote files open in their own app — click “Open in default app”.'
                : 'This file type opens in its own app — click “Open in default app”.'
            }
            title={file.name}
          />
        )}
      </div>
    </div>
  )
}
