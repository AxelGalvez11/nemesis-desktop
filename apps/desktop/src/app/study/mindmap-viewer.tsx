// Interactive, local-only rendering for agent-authored Mindmaps/*.md files. Markdown
// remains authoritative; mind-elixir only owns the viewport and a persisted arrangement.
import 'mind-elixir/style.css'

import MindElixir, { type MindElixirInstance, type NodeObj, type Operation, type Theme } from 'mind-elixir'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

import { LIBRARY_ROUTE } from '../routes'

import { MINDMAP_DIR, type MindmapFile } from './extras'
import { parseMindmapMarkdown } from './mindmap-parser'

const LAYOUT_STORAGE_PREFIX = 'nemesis.study.mindmap.layout:'
const LAYOUT_MOTION_MS = 180
const LAYOUT_EASING = 'cubic-bezier(0, 0, 0.2, 1)'

const MINDMAP_THEME: Theme = {
  cssVar: {
    '--accent-color': 'var(--theme-primary)',
    '--bgcolor': 'var(--ui-editor-surface-background)',
    '--color': 'var(--ui-text-secondary)',
    '--main-bgcolor': 'var(--ui-bg-card)',
    '--main-bgcolor-transparent': 'color-mix(in srgb, var(--ui-bg-card) 84%, transparent)',
    '--main-border': '1px solid var(--ui-stroke-secondary)',
    '--main-color': 'var(--ui-text-primary)',
    '--map-padding': '64px 88px',
    '--panel-bgcolor': 'var(--ui-bg-elevated)',
    '--panel-border-color': 'var(--ui-stroke-secondary)',
    '--panel-color': 'var(--ui-text-primary)',
    '--root-bgcolor': 'var(--theme-primary)',
    '--root-border-color': 'color-mix(in srgb, var(--theme-primary) 70%, black)',
    '--root-color': 'white',
    '--selected': 'var(--theme-primary)'
  },
  name: 'Nemesis Study',
  palette: ['#b3382e', '#94683c', '#54745f', '#4e7082', '#735f86', '#8b5c66'],
  type: 'light'
}

interface LayoutEntry {
  direction?: 0 | 1
  expanded?: boolean
  id: string
  index: number
  parentId: null | string
}

interface StoredLayout {
  entries: LayoutEntry[]
  version: 1
}

interface NodeDetail {
  note: string
  topic: string
}

type MindmapTopicElement = HTMLElement & { nodeObj?: NodeObj }

function reducedMotionRequested(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function mindmapTopics(host: HTMLElement): MindmapTopicElement[] {
  return Array.from(host.querySelectorAll<MindmapTopicElement>('me-parent > me-tpc'))
}

/** mind-elixir reflows nested inline/flex custom elements and directly removes a
 * collapsed subtree, so CSS top/left transitions never see changing properties
 * and an exit fade cannot run. FLIP the surviving me-parent wrappers after the
 * synchronous re-layout, and fade the newly-created subtree wrappers in. */
function animateMindmapRelayout(host: HTMLElement, updateLayout: () => void): void {
  if (reducedMotionRequested()) {
    updateLayout()

    return
  }

  const before = new Map(
    mindmapTopics(host).flatMap(topic => {
      const id = topic.nodeObj?.id

      return id ? [[id, topic.getBoundingClientRect()] as const] : []
    })
  )

  updateLayout()

  window.requestAnimationFrame(() => {
    for (const topic of mindmapTopics(host)) {
      const wrapper = topic.parentElement as HTMLElement | null
      const id = topic.nodeObj?.id

      if (!wrapper || !id) {
        continue
      }

      const previous = before.get(id)

      if (!previous) {
        wrapper.animate(
          [
            { opacity: 0, transform: 'scale(0.97)' },
            { opacity: 1, transform: 'scale(1)' }
          ],
          { duration: LAYOUT_MOTION_MS, easing: LAYOUT_EASING }
        )

        continue
      }

      const current = topic.getBoundingClientRect()
      const deltaX = previous.left - current.left
      const deltaY = previous.top - current.top

      if (Math.abs(deltaX) > 0.5 || Math.abs(deltaY) > 0.5) {
        wrapper.animate([{ transform: `translate(${deltaX}px, ${deltaY}px)` }, { transform: 'translate(0, 0)' }], {
          duration: LAYOUT_MOTION_MS,
          easing: LAYOUT_EASING
        })
      }
    }
  })
}

function scaleFitSmooth(host: HTMLElement, mind: MindElixirInstance): void {
  const canvas = host.querySelector<HTMLElement>('.map-canvas')

  if (!canvas || reducedMotionRequested()) {
    mind.scaleFit()

    return
  }

  canvas.classList.add('mindmap-smooth-transform')
  mind.scaleFit()
  window.setTimeout(() => canvas.classList.remove('mindmap-smooth-transform'), LAYOUT_MOTION_MS)
}

function mapPath(file: MindmapFile): string {
  return `${MINDMAP_DIR}/${file.fileName}`
}

function storageKey(file: MindmapFile): string {
  return `${LAYOUT_STORAGE_PREFIX}${mapPath(file)}`
}

function walkNodes(
  node: NodeObj,
  visit: (node: NodeObj, parentId: null | string, index: number) => void,
  parentId: null | string = null,
  index = 0
) {
  visit(node, parentId, index)
  node.children?.forEach((child, index) => {
    walkNodes(child, visit, node.id, index)
  })
}

function collectLayout(root: NodeObj): StoredLayout {
  const entries: LayoutEntry[] = []

  walkNodes(root, (node, parentId, index) => {
    entries.push({ direction: node.direction, expanded: node.expanded, id: node.id, index, parentId })
  })

  return { entries, version: 1 }
}

function readStoredLayout(file: MindmapFile): null | StoredLayout {
  try {
    const raw = window.localStorage.getItem(storageKey(file))

    if (!raw) {
      return null
    }

    const parsed = JSON.parse(raw) as Partial<StoredLayout>

    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      return null
    }

    const entries = parsed.entries.filter(
      (entry): entry is LayoutEntry =>
        Boolean(entry) &&
        typeof entry.id === 'string' &&
        typeof entry.index === 'number' &&
        (entry.parentId === null || typeof entry.parentId === 'string')
    )

    return { entries, version: 1 }
  } catch {
    return null
  }
}

function createsCycle(id: string, parentId: string, parentById: Map<string, null | string>): boolean {
  const visited = new Set([id])
  let cursor: null | string = parentId

  while (cursor) {
    if (visited.has(cursor)) {
      return true
    }

    visited.add(cursor)
    cursor = parentById.get(cursor) ?? null
  }

  return false
}

/** Apply only parent/order/direction/expanded state to freshly parsed nodes. Topics,
 * notes, and membership always come from the current Markdown file. */
function applyStoredLayout(root: NodeObj, stored: null | StoredLayout): NodeObj {
  if (!stored) {
    return root
  }

  const nodesById = new Map<string, NodeObj>()
  const canonicalOrder = new Map<string, number>()
  const parentById = new Map<string, null | string>()

  walkNodes(root, (node, parentId, index) => {
    nodesById.set(node.id, node)
    canonicalOrder.set(node.id, index)
    parentById.set(node.id, parentId)
  })

  const storedById = new Map(stored.entries.map(entry => [entry.id, entry]))

  for (const entry of stored.entries) {
    if (entry.id === root.id || !nodesById.has(entry.id) || !entry.parentId || !nodesById.has(entry.parentId)) {
      continue
    }

    if (!createsCycle(entry.id, entry.parentId, parentById)) {
      parentById.set(entry.id, entry.parentId)
    }
  }

  for (const node of nodesById.values()) {
    node.children = []
    const entry = storedById.get(node.id)

    if (entry?.direction === 0 || entry?.direction === 1) {
      node.direction = entry.direction
    }

    if (typeof entry?.expanded === 'boolean') {
      node.expanded = entry.expanded
    }
  }

  for (const node of nodesById.values()) {
    if (node.id === root.id) {
      continue
    }

    const parent = nodesById.get(parentById.get(node.id) ?? '') ?? root

    parent.children ??= []
    parent.children.push(node)
  }

  for (const parent of nodesById.values()) {
    parent.children?.sort((left, right) => {
      const leftEntry = storedById.get(left.id)
      const rightEntry = storedById.get(right.id)
      const leftOrder =
        leftEntry?.parentId === parent.id ? leftEntry.index : 1_000_000 + (canonicalOrder.get(left.id) ?? 0)
      const rightOrder =
        rightEntry?.parentId === parent.id ? rightEntry.index : 1_000_000 + (canonicalOrder.get(right.id) ?? 0)

      return leftOrder - rightOrder
    })
  }

  return root
}

function addNoteIndicators(node: NodeObj) {
  node.tags = node.note ? [{ className: 'mindmap-note-dot', text: '' }] : undefined
  node.children?.forEach(addNoteIndicators)
}

function persistLayout(file: MindmapFile, mind: MindElixirInstance) {
  try {
    window.localStorage.setItem(storageKey(file), JSON.stringify(collectLayout(mind.getData().nodeData)))
  } catch {
    // Layout persistence is best-effort; the map remains fully usable without it.
  }
}

function OutlineFallback({ file }: { file: MindmapFile }) {
  const root = parseMindmapMarkdown(file.outline, file.title)
  const lines: Array<{ depth: number; node: NodeObj }> = []

  const flatten = (node: NodeObj, depth: number) => {
    lines.push({ depth, node })
    node.children?.forEach(child => flatten(child, depth + 1))
  }

  flatten(root, 0)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
      <p className="mb-3 text-xs text-muted-foreground">
        Showing the plain outline — the interactive mind map couldn’t load.
      </p>
      <div className="space-y-1 text-[0.8125rem] leading-relaxed">
        {lines.map(({ depth, node }) => (
          <div key={node.id} style={{ paddingLeft: `${depth * 1.25}rem` }}>
            <span className="font-medium">{node.topic}</span>
            {node.note && <span className="text-muted-foreground"> — {node.note}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

function MindmapCanvas({ file }: { file: MindmapFile }) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const mindRef = useRef<MindElixirInstance | null>(null)
  const [failed, setFailed] = useState(false)
  const [selectedDetail, setSelectedDetail] = useState<NodeDetail | null>(null)

  useEffect(() => {
    const host = hostRef.current

    if (!host) {
      setFailed(true)

      return
    }

    let mind: MindElixirInstance | null = null
    let resizeObserver: ResizeObserver | null = null
    let animationFrame = 0
    let hostCleanup: (() => void) | null = null

    try {
      const root = applyStoredLayout(parseMindmapMarkdown(file.outline, file.title), readStoredLayout(file))

      addNoteIndicators(root)

      mind = new MindElixir({
        allowUndo: false,
        before: {
          addChild: () => false,
          beginEdit: () => false,
          copyNode: () => false,
          copyNodes: () => false,
          insertParent: () => false,
          insertSibling: () => false,
          removeNodes: () => false,
          reshapeNode: () => false,
          rmSubline: () => false,
          setNodeTopic: () => false
        },
        contextMenu: false,
        direction: MindElixir.SIDE as 2,
        editable: true,
        el: host,
        keypress: false,
        // NEVER set overflowHidden: true — mind-elixir treats it as "the host manages
        // interaction" and skips binding its mouse handlers entirely (no drag/click/pan).
        mouseSelectionButton: 0,
        theme: MINDMAP_THEME,
        toolBar: false
      })

      const initError = mind.init({ direction: MindElixir.SIDE as 2, nodeData: root, theme: MINDMAP_THEME })

      if (initError) {
        throw initError
      }

      mindRef.current = mind

      mind.bus.addListener('selectNodes', nodes => {
        const selected = nodes.at(-1)

        setSelectedDetail(selected?.note ? { note: selected.note, topic: selected.topic } : null)
      })
      // Clicking a parent node toggles its children open/closed — students expect the
      // node itself to respond, not only mind-elixir's tiny edge expander dot. Notes
      // still open via the selection listener above; both can happen on one click.
      // A small movement guard keeps drag-drops from also toggling the dropped node.
      let pointerOrigin: { x: number; y: number } | null = null
      const onPointerDown = (event: PointerEvent) => {
        pointerOrigin = { x: event.clientX, y: event.clientY }
      }
      const onTopicClick = (event: MouseEvent) => {
        const dragged =
          pointerOrigin && Math.hypot(event.clientX - pointerOrigin.x, event.clientY - pointerOrigin.y) > 6

        if (dragged) {
          return
        }

        const topic = (event.target as HTMLElement).closest('me-tpc') as (HTMLElement & { nodeObj?: NodeObj }) | null
        const node = topic?.nodeObj

        if (mind && topic && node?.children?.length) {
          animateMindmapRelayout(host, () => {
            mind?.expandNode(topic as Parameters<MindElixirInstance['expandNode']>[0], node.expanded === false)
          })
          persistLayout(file, mind)
        }
      }

      host.addEventListener('pointerdown', onPointerDown)
      host.addEventListener('click', onTopicClick)
      hostCleanup = () => {
        host.removeEventListener('pointerdown', onPointerDown)
        host.removeEventListener('click', onTopicClick)
      }
      mind.bus.addListener('operation', (operation: Operation) => {
        if (
          operation.name === 'moveNodeAfter' ||
          operation.name === 'moveNodeBefore' ||
          operation.name === 'moveNodeIn'
        ) {
          persistLayout(file, mind as MindElixirInstance)
        }
      })

      animationFrame = window.requestAnimationFrame(() => mind && scaleFitSmooth(host, mind))
      resizeObserver = new ResizeObserver(() => mind && scaleFitSmooth(host, mind))
      resizeObserver.observe(host)
    } catch {
      setFailed(true)
    }

    return () => {
      window.cancelAnimationFrame(animationFrame)
      resizeObserver?.disconnect()
      hostCleanup?.()
      mind?.destroy()
      mindRef.current = null
    }
  }, [file])

  if (failed) {
    return <OutlineFallback file={file} />
  }

  return (
    <div className="flex min-h-0 flex-1 bg-(--ui-editor-surface-background)">
      <div className="relative min-w-0 flex-1">
        <div className="study-mindmap-host h-full w-full" ref={hostRef} />
        <div className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated)/90 px-2.5 py-1.5 text-[0.6875rem] text-(--ui-text-tertiary) shadow-sm">
          Drag nodes to arrange · scroll to pan · Ctrl/⌘ + scroll to zoom
        </div>
        <Button
          className="absolute bottom-3 right-3"
          onClick={() => {
            if (mindRef.current && hostRef.current) {
              scaleFitSmooth(hostRef.current, mindRef.current)
            }
          }}
          size="sm"
          variant="outline"
        >
          Fit
        </Button>
      </div>
      {selectedDetail && (
        <aside className="w-72 shrink-0 overflow-y-auto border-l border-(--ui-stroke-tertiary) bg-(--ui-bg-card) px-5 py-6">
          <p className="text-[0.65rem] font-semibold uppercase tracking-[0.1em] text-(--theme-primary)">Explanation</p>
          <h3 className="mt-2 text-base font-semibold tracking-tight text-(--ui-text-primary)">
            {selectedDetail.topic}
          </h3>
          <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-(--ui-text-secondary)">{selectedDetail.note}</p>
        </aside>
      )}
    </div>
  )
}

export function MindmapViewerDialog({
  file,
  onOpenChange
}: {
  file: MindmapFile | null
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()

  const openSourceNote = () => {
    if (!file) {
      return
    }

    onOpenChange(false)
    navigate(`${LIBRARY_ROUTE}?note=${encodeURIComponent(file.title)}`)
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={file !== null}>
      <DialogContent className="flex h-[85vh] max-h-[85vh] w-[94vw] max-w-6xl flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl">
        {file && (
          <>
            <DialogHeader className="shrink-0 border-b border-border px-5 py-3.5 pr-12">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <DialogTitle className="truncate">{file.title}</DialogTitle>
                  <p className="mt-0.5 truncate text-[0.6875rem] text-muted-foreground">{mapPath(file)}</p>
                </div>
                <Button className="shrink-0" onClick={openSourceNote} size="sm" variant="outline">
                  Open source note
                </Button>
              </div>
            </DialogHeader>
            <MindmapCanvas file={file} key={file.fileName} />
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
