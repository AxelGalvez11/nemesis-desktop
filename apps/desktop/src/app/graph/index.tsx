// Graph — 3D map of the Library vault. Node = note, edge = [[wikilink]], hubs glow in the
// Nemesis crimson. Built on 3d-force-graph (MIT — the same library behind Obsidian's
// community 3D graph plugin). Clicking a node opens that note in the Library; wikilink
// targets that don't exist yet render as dim "ghost" nodes and a click CREATES the note
// (Obsidian's edit affordance), so the graph is a place to grow the vault, not just view it.
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'

import { LIBRARY_ROUTE } from '../routes'
import { buildIndex, extractWikilinks, loadVault, saveNote } from '../library/vault'

interface GraphNode {
  id: string
  degree: number
  ghost?: boolean
}

export function GraphView() {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const navigate = useNavigate()
  const [status, setStatus] = useState<'empty' | 'error' | 'loading' | 'ready'>('loading')
  const [noteCount, setNoteCount] = useState(0)
  const [ghostCount, setGhostCount] = useState(0)

  useEffect(() => {
    const host = hostRef.current

    if (!host) {
      return
    }

    let disposed = false
    let graph: { _destructor?: () => void; height: (h: number) => unknown; width: (w: number) => unknown } | null = null
    let observer: ResizeObserver | null = null

    void (async () => {
      try {
        const [{ default: ForceGraph3D }, notes] = await Promise.all([import('3d-force-graph'), loadVault()])

        if (disposed) {
          return
        }

        if (!notes.length) {
          setStatus('empty')

          return
        }

        const index = buildIndex(notes)
        const nodes: GraphNode[] = notes.map(note => ({
          degree: (index.links.get(note.title)?.length ?? 0) + (index.backlinks.get(note.title)?.length ?? 0),
          id: note.title
        }))
        const links = [...index.links.entries()].flatMap(([source, targets]) =>
          targets.map(target => ({ source, target }))
        )

        // Ghost nodes: wikilink targets with no note behind them yet. Dim, and a click
        // creates the note — the same "unresolved link" affordance Obsidian's graph has.
        const known = new Set(notes.map(note => note.title.toLowerCase()))
        const ghostByLower = new Map<string, string>()

        for (const note of notes) {
          for (const target of extractWikilinks(note.content)) {
            if (!known.has(target.toLowerCase())) {
              const display = ghostByLower.get(target.toLowerCase()) ?? target
              ghostByLower.set(target.toLowerCase(), display)
              links.push({ source: note.title, target: display })
            }
          }
        }

        for (const display of ghostByLower.values()) {
          nodes.push({ degree: 1, ghost: true, id: display })
        }

        const accent = getComputedStyle(document.documentElement).getPropertyValue('--theme-midground').trim() || '#b3382e'

        // A graph is a viz surface: keep it dark for node contrast even in light mode.
        const instance = new ForceGraph3D(host)
          .backgroundColor('#0e0e0e')
          .width(host.clientWidth || host.offsetWidth || 800)
          .height(host.clientHeight || host.offsetHeight || 600)
          .nodeLabel((node: object) => {
            const graphNode = node as GraphNode

            return graphNode.ghost
              ? `<div style="font: 12px sans-serif; color:#aaa">${graphNode.id} — click to create this note</div>`
              : `<div style="font: 12px sans-serif; color:#eee">${graphNode.id}</div>`
          })
          .nodeRelSize(4)
          .nodeColor((node: object) => {
            const graphNode = node as GraphNode

            if (graphNode.ghost) {
              return 'rgba(170,170,170,0.35)'
            }

            return graphNode.degree >= 2 ? accent : '#c8c8c8'
          })
          .nodeVal((node: object) => 1 + (node as GraphNode).degree)
          .nodeOpacity(0.9)
          .linkColor(() => '#4a4a4a')
          .linkWidth(0.5)
          .linkOpacity(0.55)
          .onNodeClick((node: object) => {
            const graphNode = node as GraphNode

            void (async () => {
              if (graphNode.ghost) {
                // Materialize the note, then jump into it.
                try {
                  await saveNote(graphNode.id, `# ${graphNode.id}\n\n`)
                } catch {
                  return
                }
              }

              navigate(`${LIBRARY_ROUTE}?note=${encodeURIComponent(graphNode.id)}`)
            })()
          })
          .graphData({ links, nodes })

        // Frame the whole graph once the force sim settles (and again as a fallback —
        // the container can report 0px at construction inside the flex layout). Generous
        // padding keeps the nodes comfortably inside the viewport rather than filling it.
        instance.onEngineStop(() => instance.zoomToFit(500, 110))
        window.setTimeout(() => instance.zoomToFit(700, 110), 1500)

        const controls = instance.controls() as { autoRotate?: boolean; autoRotateSpeed?: number }
        controls.autoRotate = true
        controls.autoRotateSpeed = 0.5

        observer = new ResizeObserver(() => {
          instance.width(host.clientWidth || 800)
          instance.height(host.clientHeight || 600)
        })
        observer.observe(host)

        graph = instance
        setNoteCount(notes.length)
        setGhostCount(ghostByLower.size)
        setStatus('ready')
      } catch {
        if (!disposed) {
          setStatus('error')
        }
      }
    })()

    return () => {
      disposed = true
      observer?.disconnect()
      graph?._destructor?.()
    }
  }, [navigate])

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <header className="pointer-events-none absolute left-6 top-5 z-10">
        <h1 className="text-lg font-semibold">Graph</h1>
        <p className="text-xs text-muted-foreground">
          {status === 'ready'
            ? `${noteCount} notes${ghostCount > 0 ? ` · ${ghostCount} to create` : ''} — click any node`
            : ''}
        </p>
        {status === 'ready' && ghostCount > 0 && (
          <p className="text-[11px] text-muted-foreground/70">Dim nodes are [[links]] with no note yet — click one to create it.</p>
        )}
      </header>
      {status === 'ready' && (
        <div className="absolute right-6 top-5 z-10">
          <Button onClick={() => navigate(`${LIBRARY_ROUTE}?create=note`)} size="sm" variant="outline">
            + New note
          </Button>
        </div>
      )}
      {status === 'error' && (
        <EmptyState className="flex-1" description="Could not read the Library vault." title="Graph unavailable" />
      )}
      {status === 'empty' && (
        <EmptyState className="flex-1" description="Write linked notes in the Library first." title="Nothing to map yet" />
      )}
      <div className={status === 'ready' || status === 'loading' ? 'min-h-0 flex-1' : 'hidden'} ref={hostRef} />
    </div>
  )
}
