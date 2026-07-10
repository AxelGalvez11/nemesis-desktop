// Library — the notes vault page. Plain Obsidian-compatible Markdown on disk, edited with
// the SAME CodeMirror editor the app already ships (language auto-detected from the .md
// path), plus a wikilink/backlink rail computed by vault.ts. Autosaves 800ms after typing.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { CodeEditor } from '@/components/chat/code-editor'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

import { buildIndex, extractWikilinks, loadVault, saveNote, SEED_NOTES, VAULT_DIR, type VaultNote } from './vault'

export function LibraryView() {
  const [notes, setNotes] = useState<VaultNote[] | null>(null)
  const [error, setError] = useState<null | string>(null)
  const [activeTitle, setActiveTitle] = useState<null | string>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [creating, setCreating] = useState(false)
  const [saving, setSaving] = useState(false)
  const saveTimer = useRef<null | ReturnType<typeof setTimeout>>(null)
  const [searchParams] = useSearchParams()

  // Deep link from the Graph page: /library?note=Title opens that note.
  useEffect(() => {
    const requested = searchParams.get('note')

    if (requested && notes?.some(note => note.title === requested)) {
      setActiveTitle(requested)
    }
  }, [notes, searchParams])

  const refresh = useCallback(async () => {
    try {
      let loaded = await loadVault()

      if (!loaded.length) {
        // First run: seed the vault so Library + Graph demonstrate themselves.
        for (const seed of SEED_NOTES) {
          await saveNote(seed.title, seed.content)
        }

        loaded = await loadVault()
      }

      setNotes(loaded)
      setError(null)
      setActiveTitle(current => current ?? loaded[0]?.title ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the Library folder.')
    }
  }, [])

  useEffect(() => {
    void refresh()

    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current)
      }
    }
  }, [refresh])

  const index = useMemo(() => (notes ? buildIndex(notes) : null), [notes])
  const active = notes?.find(note => note.title === activeTitle) ?? null

  const scheduleSave = useCallback(
    (title: string, content: string) => {
      // Keep the in-memory copy current so links/backlinks track while typing.
      setNotes(current =>
        current ? current.map(note => (note.title === title ? { ...note, content } : note)) : current
      )

      if (saveTimer.current) {
        clearTimeout(saveTimer.current)
      }

      saveTimer.current = setTimeout(() => {
        setSaving(true)
        void saveNote(title, content).finally(() => setSaving(false))
      }, 800)
    },
    []
  )

  const createNote = useCallback(async () => {
    const title = draftTitle.trim()

    if (!title) {
      return
    }

    await saveNote(title, `# ${title}\n\n`)
    setDraftTitle('')
    setCreating(false)
    await refresh()
    setActiveTitle(title)
  }, [draftTitle, refresh])

  if (error) {
    return <EmptyState className="h-full" description={`${error} (${VAULT_DIR})`} title="Library unavailable" />
  }

  if (!notes) {
    return <EmptyState className="h-full" description="Opening your vault…" title="Library" />
  }

  const outgoing = active && index ? (index.links.get(active.title) ?? []) : []
  const incoming = active && index ? (index.backlinks.get(active.title) ?? []) : []
  const unresolved = active
    ? extractWikilinks(active.content).filter(
        target => !notes.some(note => note.title.toLowerCase() === target.toLowerCase())
      )
    : []

  return (
    <div className="flex h-full min-h-0">
      {/* Note list */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-border">
        <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-5">
          <h1 className="text-lg font-semibold">Library</h1>
          <Button onClick={() => setCreating(open => !open)} size="sm" variant="outline">
            New
          </Button>
        </div>
        <p className="px-4 pb-2 text-xs text-muted-foreground">
          {notes.length} notes · your own Markdown files
        </p>
        {creating && (
          <div className="flex gap-1 px-3 pb-2">
            <Input
              autoFocus
              onChange={event => setDraftTitle(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  void createNote()
                }
              }}
              placeholder="Note title"
              value={draftTitle}
            />
          </div>
        )}
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {notes.map(note => (
            <button
              className={cn(
                'block w-full truncate rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent',
                note.title === activeTitle && 'bg-accent text-accent-foreground'
              )}
              key={note.path}
              onClick={() => setActiveTitle(note.title)}
              type="button"
            >
              {note.title}
            </button>
          ))}
        </nav>
      </aside>

      {/* Editor */}
      <main className="flex min-w-0 flex-1 flex-col">
        {active ? (
          <>
            <div className="flex items-center justify-between px-5 pb-1 pt-5">
              <h2 className="truncate text-base font-medium">{active.title}</h2>
              <span className="text-xs text-muted-foreground">{saving ? 'Saving…' : 'Saved to disk'}</span>
            </div>
            <div className="min-h-0 flex-1 px-3 pb-3">
              <CodeEditor
                filePath={active.path}
                initialValue={active.content}
                key={active.path}
                onChange={value => scheduleSave(active.title, value)}
              />
            </div>
          </>
        ) : (
          <EmptyState className="flex-1" description="Pick a note on the left, or create one." title="No note open" />
        )}
      </main>

      {/* Links rail */}
      <aside className="hidden w-56 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border px-4 pb-4 pt-5 lg:flex">
        <LinkGroup
          emptyLabel="No links yet — write [[Note title]] to connect ideas."
          onOpen={setActiveTitle}
          title="Links"
          titles={outgoing}
        />
        <LinkGroup emptyLabel="Nothing links here yet." onOpen={setActiveTitle} title="Backlinks" titles={incoming} />
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
