// Library — the notes vault page. A folder tree (left) over recursive Obsidian-compatible
// Markdown, a prose-styled CodeMirror editor (middle, de-code-ified via .nemesis-prose-editor
// CSS), and a collapsible Outline/Links rail (right). Non-markdown files (PDF/images inline;
// slides/docs open externally) preview in place. Autosaves 800ms after typing.
import {
  IconChevronRight,
  IconFilePlus,
  IconFileText,
  IconFileTypePdf,
  IconFolder,
  IconFolderOpen,
  IconFolderPlus,
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
        const created: TreeNode = { files: [], folders: [], name: part, notes: [], path: node.path ? `${node.path}/${part}` : part }
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

  const openSelection = useCallback((next: TabItem) => {
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
  }, [])

  const closeTab = useCallback((index: number) => {
    setTabs(current => current.filter((_, i) => i !== index))
    setActiveTab(current => (index < current ? current - 1 : Math.max(0, Math.min(current, tabs.length - 2))))
  }, [tabs.length])

  useEffect(() => {
    void (async () => {
      const loaded = await refresh()

      if (loaded && tabs.length === 0 && loaded.notes[0]) {
        openSelection({ kind: 'note', note: loaded.notes[0] })
      }
    })()

    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh])

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
    }

    window.addEventListener('focus', onFocus)

    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

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
      setCreating('note')
      setDraft('')
    }
  }, [contents, openSelection, searchParams])

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
      current
        ? { ...current, notes: current.notes.map(n => (n.path === note.path ? { ...n, content } : n)) }
        : current
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

      const existing = loaded.notes.find(n => n.title.toLowerCase() === target.toLowerCase())

      if (existing) {
        openSelection({ kind: 'note', note: existing })

        return
      }

      await saveNote(target, `# ${target}\n\n`)
      const after = await refresh()
      const created = after?.notes.find(n => n.title.toLowerCase() === target.toLowerCase())

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
      <aside className="flex w-64 shrink-0 flex-col border-r border-(--ui-stroke-tertiary) bg-(--ui-sidebar-surface-background)">
        <div className="flex items-center justify-between gap-3 px-4 pb-3 pt-5">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight">Library</h1>
            <p className="mt-0.5 text-[0.65rem] font-medium tabular-nums text-(--ui-text-tertiary)">
              {noteCount} note{noteCount === 1 ? '' : 's'} · {fileCount} file{fileCount === 1 ? '' : 's'}
            </p>
          </div>
          <div className="flex gap-0.5">
            <Tip label="New note">
              <Button
                aria-label="New note"
                className="transition-transform duration-200 ease-out active:scale-[0.98]"
                onClick={() => { setCreating('note'); setDraft('') }}
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
                onClick={() => { setCreating('folder'); setDraft('') }}
                size="icon-xs"
                variant="ghost"
              >
                <IconFolderPlus />
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
                if (event.key === 'Enter') void submitCreate()
                if (event.key === 'Escape') setCreating(null)
              }}
              placeholder={creating === 'folder' ? 'Folder name' : 'Note title'}
              value={draft}
            />
            {targetFolder && <p className="px-1 pt-1.5 text-[10px] text-muted-foreground">in {targetFolder}</p>}
          </div>
        )}
        <nav className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-4">
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

      {/* Editor / preview */}
      <main className="flex min-w-0 flex-1 flex-col bg-(--ui-bg-editor)">
        {tabs.length > 0 && (
          <div
            className="flex h-(--titlebar-height) shrink-0 overflow-x-auto overflow-y-hidden border-b border-(--ui-stroke-tertiary) bg-(--ui-sidebar-surface-background) [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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
                onClick={() => setActiveTab(i)}
                role="tab"
              >
                {i === activeTab && <span aria-hidden className="absolute inset-x-0 top-0 h-px bg-(--theme-primary)" />}
                <span className="flex min-w-0 items-center gap-1.5 py-2 pl-3 pr-8">
                  {tab.kind === 'note' ? <IconFileText className="shrink-0 opacity-60" size={13} /> : <FileGlyph kind={tab.file.kind} />}
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
        )}
        {selection?.kind === 'note' ? (
          <>
            <div className="shrink-0 border-b border-(--ui-stroke-quaternary) px-7 pb-4 pt-6">
              <div className="flex items-end justify-between gap-6">
                <div className="min-w-0">
                  <div className="mb-2 flex min-w-0 items-center gap-1.5 text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--ui-text-tertiary)">
                    <span>Library</span>
                    {selection.note.folder.split('/').filter(Boolean).map((part, index) => (
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
          <EmptyState className="flex-1" description="Pick a note on the left, or create one." title="No note open" />
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
                  <IconFolder className="shrink-0 text-(--ui-text-tertiary) group-hover/folder:text-(--theme-primary)" size={14} />
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
              selection?.kind === 'note' && selection.note.path === note.path && 'font-semibold text-foreground before:bg-(--theme-primary)'
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
              selection?.kind === 'file' && selection.file.path === file.path && 'font-semibold text-foreground before:bg-(--theme-primary)'
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
