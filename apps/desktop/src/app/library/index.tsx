// Library — the notes vault page. A folder tree (left) over recursive Obsidian-compatible
// Markdown, a prose-styled CodeMirror editor (middle, de-code-ified via .nemesis-prose-editor
// CSS), and a Links/Backlinks rail. Non-markdown files (PDF/images inline; slides/docs open
// externally) preview in place. Autosaves 800ms after typing.
import { IconFileText, IconFileTypePdf, IconPaperclip, IconPhoto, IconPresentation, IconX } from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

import { NoteEditor } from './note-editor'
import { PdfViewer } from './pdf-viewer'
import {
  buildIndex,
  createFolder,
  extractWikilinks,
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

  const outgoing = activeNote && index ? (index.links.get(activeNote.title) ?? []) : []
  const incoming = activeNote && index ? (index.backlinks.get(activeNote.title) ?? []) : []
  const unresolved = activeNote
    ? extractWikilinks(activeNote.content).filter(
        target => !contents.notes.some(note => note.title.toLowerCase() === target.toLowerCase())
      )
    : []

  return (
    <div className="flex h-full min-h-0">
      {/* Folder tree */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-border">
        <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-5">
          <h1 className="text-lg font-semibold">Library</h1>
          <div className="flex gap-1">
            <Button className="h-7 px-2 text-xs" onClick={() => { setCreating('note'); setDraft('') }} size="sm" variant="outline">
              + Note
            </Button>
            <Button className="h-7 px-2 text-xs" onClick={() => { setCreating('folder'); setDraft('') }} size="sm" variant="outline">
              + Folder
            </Button>
          </div>
        </div>
        {creating && (
          <div className="px-3 pb-2">
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
            {targetFolder && <p className="px-1 pt-1 text-[10px] text-muted-foreground">in {targetFolder}</p>}
          </div>
        )}
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
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
      <main className="flex min-w-0 flex-1 flex-col">
        {tabs.length > 0 && (
          <div className="flex shrink-0 items-end gap-0.5 overflow-x-auto border-b border-border px-2 pt-2">
            {tabs.map((tab, i) => (
              <div
                className={cn(
                  'group/tab flex max-w-[13rem] shrink-0 cursor-pointer items-center gap-1 rounded-t-md border border-b-0 px-2.5 py-1.5 text-xs transition-colors',
                  i === activeTab
                    ? 'border-border bg-card text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                )}
                key={tabKey(tab)}
                onClick={() => setActiveTab(i)}
              >
                <span className="truncate">{tabLabel(tab)}</span>
                <button
                  aria-label="Close tab"
                  className="rounded p-0.5 opacity-0 transition-opacity hover:bg-accent group-hover/tab:opacity-100"
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
            <div className="flex items-center justify-between px-5 pb-1 pt-5">
              <h2 className="truncate text-base font-medium">{selection.note.title}</h2>
              <span className="text-xs text-muted-foreground">{saving ? 'Saving…' : 'Saved to disk'}</span>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden px-6 pb-3">
              <NoteEditor
                initialValue={selection.note.content}
                key={selection.note.path}
                onChange={value => scheduleSave(selection.note, value)}
                onOpenWikilink={target => void openWikilink(target)}
              />
            </div>
          </>
        ) : selection?.kind === 'file' ? (
          <FilePreview file={selection.file} />
        ) : (
          <EmptyState className="flex-1" description="Pick a note on the left, or create one." title="No note open" />
        )}
      </main>

      {/* Links rail (notes only) */}
      {activeNote && (
        <aside className="hidden w-56 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border px-4 pb-4 pt-5 lg:flex">
          <LinkGroup
            emptyLabel="Write [[Note title]] to connect ideas."
            onOpen={title => {
              const note = contents.notes.find(n => n.title === title)
              if (note) openSelection({ kind: 'note', note })
            }}
            title="Links"
            titles={outgoing}
          />
          <LinkGroup
            emptyLabel="Nothing links here yet."
            onOpen={title => {
              const note = contents.notes.find(n => n.title === title)
              if (note) openSelection({ kind: 'note', note })
            }}
            title="Backlinks"
            titles={incoming}
          />
          {unresolved.length > 0 && (
            <div>
              <h3 className="pb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Unresolved</h3>
              <div className="flex flex-wrap gap-1.5">
                {unresolved.map(target => (
                  <span className="rounded-md border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground" key={target}>
                    {target}
                  </span>
                ))}
              </div>
            </div>
          )}
        </aside>
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

  return <Icon className="-mt-px mr-1.5 inline shrink-0 opacity-70" size={14} />
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
  const pad = { paddingLeft: `${depth * 12 + 8}px` }

  return (
    <>
      {node.folders
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(folder => {
          const isCollapsed = collapsed.has(folder.path)

          return (
            <div key={folder.path}>
              <button
                className="flex w-full items-center gap-1 rounded-md py-1 pr-2 text-left text-sm text-foreground hover:bg-accent"
                onClick={() => onToggle(folder.path)}
                style={pad}
                type="button"
              >
                <span className={cn('inline-block transition-transform', !isCollapsed && 'rotate-90')}>▸</span>
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
              'block w-full truncate rounded-md py-1.5 pr-2 text-left text-sm hover:bg-accent',
              selection?.kind === 'note' && selection.note.path === note.path && 'bg-accent text-accent-foreground'
            )}
            key={note.path}
            onClick={() => onSelect({ kind: 'note', note })}
            style={pad}
            type="button"
          >
            {note.title}
          </button>
        ))}
      {node.files
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(file => (
          <button
            className={cn(
              'block w-full truncate rounded-md py-1.5 pr-2 text-left text-sm text-muted-foreground hover:bg-accent',
              selection?.kind === 'file' && selection.file.path === file.path && 'bg-accent text-accent-foreground'
            )}
            key={file.path}
            onClick={() => onSelect({ file, kind: 'file' })}
            style={pad}
            type="button"
          >
            <FileGlyph kind={file.kind} />
            {file.name}
          </button>
        ))}
    </>
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
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 px-5 pb-2 pt-5">
        <h2 className="truncate text-base font-medium">{file.name}</h2>
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
    <div>
      <h3 className="pb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      {titles.length ? (
        <div className="flex flex-wrap gap-1.5">
          {titles.map(target => (
            <button
              className="rounded-md border border-border px-2 py-0.5 text-xs hover:bg-accent"
              key={target}
              onClick={() => onOpen(target)}
              type="button"
            >
              {target}
            </button>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{emptyLabel}</p>
      )}
    </div>
  )
}
