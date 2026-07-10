// Graph — 3D map of the Library vault. Node = note, edge = [[wikilink]], hubs glow in the
// Nemesis crimson. Built on 3d-force-graph (MIT — the same library behind Obsidian's
// community 3D graph plugin). Clicking a node opens that note in the Library.
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { EmptyState } from '@/components/ui/empty-state'

import { LIBRARY_ROUTE } from '../routes'
import { buildIndex, loadVault } from '../library/vault'

interface GraphNode {
  id: string
  degree: number
}

export function GraphView() {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const navigate = useNavigate()
  const [status, setStatus] = useState<'empty' | 'error' | 'loading' | 'ready'>('loading')
  const [noteCount, setNoteCount] = useState(0)

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

        const accent = getComputedStyle(document.documentElement).getPropertyValue('--theme-midground').trim() || '#b3382e'

        // A graph is a viz surface: keep it dark for node contrast even in light mode.
        const instance = new ForceGraph3D(host)
          .backgroundColor('#0e0e0e')
          .width(host.clientWidth || host.offsetWidth || 800)
          .height(host.clientHeight || host.offsetHeight || 600)
          .nodeLabel((node: object) => `<div style="font: 12px sans-serif; color:#eee">${(node as GraphNode).id}</div>`)
          .nodeRelSize(6)
          .nodeColor((node: object) => ((node as GraphNode).degree >= 2 ? accent : '#c8c8c8'))
          .nodeVal((node: object) => 2 + (node as GraphNode).degree * 2)
          .nodeOpacity(0.95)
          .linkColor(() => '#4a4a4a')
          .linkWidth(0.5)
          .linkOpacity(0.6)
          .onNodeClick((node: object) =>
            navigate(`${LIBRARY_ROUTE}?note=${encodeURIComponent((node as GraphNode).id)}`)
          )
          .graphData({ links, nodes })

        // Frame the whole graph once the force sim settles (and again as a fallback —
        // the container can report 0px at construction inside the flex layout).
        instance.onEngineStop(() => instance.zoomToFit(400, 60))
        window.setTimeout(() => instance.zoomToFit(600, 60), 1400)

        const controls = instance.controls() as { autoRotate?: boolean; autoRotateSpeed?: number }
        controls.autoRotate = true
        controls.autoRotateSpeed = 0.6

        observer = new ResizeObserver(() => {
          instance.width(host.clientWidth || 800)
          instance.height(host.clientHeight || 600)
        })
        observer.observe(host)

        graph = instance
        setNoteCount(notes.length)
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
          {status === 'ready' ? `${noteCount} notes — click a node to open it` : ''}
        </p>
      </header>
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
