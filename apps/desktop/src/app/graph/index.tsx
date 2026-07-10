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

        const styles = getComputedStyle(document.documentElement)
        const background = styles.getPropertyValue('--dt-background').trim() || '#0e0e0e'
        const accent = styles.getPropertyValue('--theme-midground').trim() || '#b3382e'

        const instance = new ForceGraph3D(host)
          .graphData({ links, nodes })
          .backgroundColor(background)
          .nodeLabel((node: object) => `<div style="font: 12px sans-serif">${(node as GraphNode).id}</div>`)
          .nodeColor((node: object) => ((node as GraphNode).degree >= 2 ? accent : '#9a9a9a'))
          .nodeVal((node: object) => 1 + (node as GraphNode).degree)
          .linkColor(() => '#3f3f3f')
          .linkOpacity(0.55)
          .onNodeClick((node: object) =>
            navigate(`${LIBRARY_ROUTE}?note=${encodeURIComponent((node as GraphNode).id)}`)
          )

        const controls = instance.controls() as { autoRotate?: boolean; autoRotateSpeed?: number }
        controls.autoRotate = true
        controls.autoRotateSpeed = 0.55

        const fit = () => {
          instance.width(host.clientWidth)
          instance.height(host.clientHeight)
        }

        observer = new ResizeObserver(fit)
        observer.observe(host)
        fit()

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
