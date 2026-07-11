// Graph — 3D map of the Library vault. Node = note, edge = [[wikilink]], hubs glow in the
// Nemesis crimson. Built on 3d-force-graph (MIT — the same library behind Obsidian's
// community 3D graph plugin). Clicking a node opens that note in the Library; wikilink
// targets that don't exist yet render as dim "ghost" nodes and a click CREATES the note
// (Obsidian's edit affordance), so the graph is a place to grow the vault, not just view it.
// Every node carries an always-visible title sprite (three-spritetext), and hovering or
// clicking a node lights up its direct neighbors while fading the rest of the graph.
import { IconAdjustmentsHorizontal } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Switch } from '@/components/ui/switch'
import { useTheme } from '@/themes/context'

import { LIBRARY_ROUTE } from '../routes'
import { buildIndex, extractWikilinks, loadVault, saveNote } from '../library/vault'

interface GraphNode {
  id: string
  degree: number
  ghost?: boolean
}

interface GraphLink {
  source: GraphNode | string
  target: GraphNode | string
}

// Structural slice of the 3d-force-graph instance we tune at runtime. nodeColor/linkColor/
// linkWidth/linkDirectionalParticles use overloaded (getter + setter) signatures so the
// hover/select glow can re-trigger the already-installed accessor via the library's own
// `.prop(.prop())` idiom — see refreshHighlight() below.
interface TunableGraph {
  backgroundColor: (color: string) => unknown
  controls: () => { autoRotate?: boolean; autoRotateSpeed?: number }
  d3Force: (name: string) => undefined | { distance?: (n: number) => unknown; strength?: (n: number) => unknown }
  d3ReheatSimulation: () => unknown
  linkColor: {
    (): (link: object) => string
    (accessor: (link: object) => string): unknown
  }
  linkDirectionalParticles: {
    (): (link: object) => number
    (accessor: (link: object) => number): unknown
  }
  linkWidth: {
    (): (link: object) => number
    (accessor: (link: object) => number): unknown
  }
  nodeColor: {
    (): (node: object) => string
    (accessor: (node: object) => string): unknown
  }
  nodeRelSize: (n: number) => unknown
  refresh?: () => unknown
}

// three-spritetext's declared type extends THREE.Sprite, but this workspace's `three`
// install ships no bundled TypeScript types (and no @types/three is installed either), so
// inherited Object3D/Sprite members like position/center don't resolve through that
// base-class link at the type level — they're still there at runtime. Assert the minimal
// shape we actually touch rather than pulling in a types package for two setter calls.
interface Object3DLike {
  center: { set: (x: number, y: number) => unknown }
  position: { set: (x: number, y: number, z: number) => unknown }
}

interface GraphPalette {
  accent: string
  background: string
  ghost: string
  label: string
  link: string
  node: string
}

interface GraphControlsState {
  nodeSize: number
  spread: number
  repulsion: number
  rotationSpeed: number
  showNames: boolean
  neighborGlow: boolean
}

const GRAPH_SETTINGS_KEY = 'nemesis.graph.settings.v1'

const DEFAULT_CONTROLS: GraphControlsState = {
  neighborGlow: true,
  nodeSize: 4,
  repulsion: 40,
  rotationSpeed: 0,
  showNames: true,
  spread: 34
}

// Always-visible node label (three-spritetext) tuning.
const LABEL_MAX_CHARS = 24
const LABEL_TEXT_HEIGHT = 3.6
// The label's bottom edge sits this much beyond the node sphere's own radius (see
// sprite.center below) — proportional, not a flat offset, so it still clears big hub
// spheres instead of looking glued on at high "Node size" settings.
const LABEL_OFFSET_SCALE = 1.2

// Hover/select "connected neighbor" glow tuning.
const DEFAULT_LINK_WIDTH = 0.5
const HIGHLIGHT_LINK_WIDTH = 2.5
const HIGHLIGHT_LINK_PARTICLES = 3
const HIGHLIGHT_LINK_PARTICLE_WIDTH = 2.2
// How far a non-neighbor color is blended toward the background when a highlight is active.
const DIM_MIX_RATIO = 0.65

// Chrome resolves CSS custom properties to the CSS Color-4 `color(srgb r g b / a)`
// syntax, which three.js (the 3d-force-graph renderer) CANNOT parse — it silently
// falls back to black, making nodes invisible on a dark background. Normalize every
// resolved value to an opaque `rgb(r, g, b)` string that three.js parses reliably.
function normalizeToRgb(computed: string): null | string {
  if (!computed) {
    return null
  }

  const rgb = computed.match(/rgba?\(([^)]+)\)/i)

  if (rgb) {
    const [r, g, b] = rgb[1].split(/[,/]/).map(part => Math.round(parseFloat(part.trim())))

    return Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) ? `rgb(${r}, ${g}, ${b})` : null
  }

  const srgb = computed.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/i)

  if (srgb) {
    const [r, g, b] = [srgb[1], srgb[2], srgb[3]].map(part => Math.round(parseFloat(part) * 255))

    return `rgb(${r}, ${g}, ${b})`
  }

  // Already a hex / named color three.js understands.
  return computed
}

function resolveCssColor(value: string, fallback: string): string {
  const probe = document.createElement('span')
  probe.style.color = value
  probe.style.display = 'none'
  document.body.appendChild(probe)
  const resolved = getComputedStyle(probe).color
  probe.remove()

  return normalizeToRgb(resolved) || fallback
}

function readGraphPalette(mode: 'dark' | 'light'): GraphPalette {
  const dark = mode === 'dark'

  return {
    accent: resolveCssColor('var(--theme-primary)', '#b3382e'),
    background: resolveCssColor('var(--ui-bg-editor)', dark ? '#0e0e0e' : '#fafafa'),
    ghost: resolveCssColor(
      'color-mix(in srgb, var(--ui-text-primary) 38%, transparent)',
      dark ? 'rgba(232,232,232,0.38)' : 'rgba(28,28,30,0.38)'
    ),
    label: resolveCssColor('var(--ui-text-primary)', dark ? '#eeeeee' : '#1c1c1e'),
    link: resolveCssColor(
      'color-mix(in srgb, var(--ui-text-primary) 32%, transparent)',
      dark ? 'rgba(232,232,232,0.32)' : 'rgba(28,28,30,0.32)'
    ),
    node: resolveCssColor('var(--ui-text-secondary)', dark ? '#c8c8c8' : '#3f3f43')
  }
}

function graphNodeColor(node: object, palette: GraphPalette): string {
  const graphNode = node as GraphNode

  if (graphNode.ghost) {
    return palette.ghost
  }

  return graphNode.degree >= 2 ? palette.accent : palette.node
}

function parseRgbTriplet(color: string): [number, number, number] | null {
  const match = color.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i)

  if (!match) {
    return null
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

// Blend an already-normalized rgb(...) color toward the background to "dim" it for the
// non-neighbor state during hover/select glow. Plain arithmetic rather than CSS
// color-mix, for the same reason normalizeToRgb exists above: don't depend on the
// runtime's own color parsing. Falls back to the original color if either input isn't a
// plain rgb()/rgba() string (e.g. a hex fallback from resolveCssColor).
function dimColor(color: string, background: string, ratio: number): string {
  const fg = parseRgbTriplet(color)
  const bg = parseRgbTriplet(background)

  if (!fg || !bg) {
    return color
  }

  const [r, g, b] = fg.map((channel, index) => Math.round(channel * (1 - ratio) + bg[index] * ratio))

  return `rgb(${r}, ${g}, ${b})`
}

// Layers the hover/select glow on top of the node's normal color: the active node and its
// direct neighbors brighten to the theme accent, everything else fades toward the
// background once a highlight is active. With no active node this is just graphNodeColor.
function resolveNodeColor(node: GraphNode, palette: GraphPalette, highlightNodes: Set<GraphNode>, active: GraphNode | null): string {
  const normal = graphNodeColor(node, palette)

  if (!active) {
    return normal
  }

  return highlightNodes.has(node) ? palette.accent : dimColor(normal, palette.background, DIM_MIX_RATIO)
}

function resolveLinkColor(link: GraphLink, palette: GraphPalette, highlightLinks: Set<GraphLink>, active: GraphNode | null): string {
  if (!active) {
    return palette.link
  }

  return highlightLinks.has(link) ? palette.accent : dimColor(palette.link, palette.background, DIM_MIX_RATIO)
}

function truncateLabel(text: string): string {
  return text.length > LABEL_MAX_CHARS ? `${text.slice(0, LABEL_MAX_CHARS - 1)}…` : text
}

// Small Map<K, V[]> append helper used to build the node adjacency below without mutating
// the graph's own node/link objects.
function pushToMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key)

  if (existing) {
    existing.push(value)

    return
  }

  map.set(key, [value])
}

function loadControls(): GraphControlsState {
  try {
    const raw = window.localStorage.getItem(GRAPH_SETTINGS_KEY)

    if (raw) {
      return { ...DEFAULT_CONTROLS, ...(JSON.parse(raw) as Partial<GraphControlsState>) }
    }
  } catch {
    // fall through to defaults
  }

  return DEFAULT_CONTROLS
}

function ControlSlider({
  label,
  max,
  min,
  onChange,
  step,
  value
}: {
  label: string
  max: number
  min: number
  onChange: (value: number) => void
  step: number
  value: number
}) {
  return (
    <label className="block space-y-1.5">
      <span className="flex items-center justify-between text-xs font-medium text-(--ui-text-primary)">
        {label}
        <span className="rounded bg-(--ui-bg-quaternary) px-1.5 py-0.5 text-[0.6875rem] font-semibold tabular-nums text-(--ui-text-secondary)">
          {value}
        </span>
      </span>
      <input
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-(--ui-stroke-primary) accent-(--theme-primary) [&::-moz-range-thumb]:size-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-(--theme-primary) [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-(--theme-primary)"
        max={max}
        min={min}
        onChange={event => onChange(Number(event.target.value))}
        step={step}
        type="range"
        value={value}
      />
    </label>
  )
}

export function GraphView() {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const graphRef = useRef<null | TunableGraph>(null)
  const navigate = useNavigate()
  const [status, setStatus] = useState<'empty' | 'error' | 'loading' | 'ready'>('loading')
  const [noteCount, setNoteCount] = useState(0)
  const [ghostCount, setGhostCount] = useState(0)
  const [controls, setControls] = useState<GraphControlsState>(() => loadControls())
  const [panelOpen, setPanelOpen] = useState(false)
  const { renderedMode, theme } = useTheme()
  const controlsRef = useRef(controls)
  const paletteRef = useRef<GraphPalette | null>(null)
  // Hover/select glow state — refs (not React state) since these drive imperative
  // three.js accessor re-evaluation, not re-renders.
  const hoverNodeRef = useRef<GraphNode | null>(null)
  const selectedNodeRef = useRef<GraphNode | null>(null)
  const highlightNodesRef = useRef<Set<GraphNode>>(new Set())
  const highlightLinksRef = useRef<Set<GraphLink>>(new Set())
  // Direct-neighbor adjacency, rebuilt once per graph load (see the main effect below).
  const neighborsByNodeRef = useRef<Map<GraphNode, GraphNode[]>>(new Map())
  const linksByNodeRef = useRef<Map<GraphNode, GraphLink[]>>(new Map())
  // Last-applied values for the tuning-panel effect below, so toggling "Node names" or
  // dragging a layout slider only pays for a sprite rebuild / simulation reheat when
  // that specific setting actually changed — not on every unrelated control tweak.
  const prevShowNamesRef = useRef(controls.showNames)
  const prevLayoutSignatureRef = useRef(`${controls.nodeSize}|${controls.spread}|${controls.repulsion}`)
  controlsRef.current = controls

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const palette = readGraphPalette(renderedMode)
      paletteRef.current = palette
      const graph = graphRef.current

      if (!graph) {
        return
      }

      graph.backgroundColor(palette.background)
      // refresh() flushes every node's three.js object — including the label sprites,
      // which only read the palette at creation time — and re-evaluates the
      // ref-reading nodeColor/linkColor/etc accessors installed below in the same pass.
      graph.refresh?.()
      refreshHighlight()
    })

    return () => window.cancelAnimationFrame(frame)
  }, [renderedMode, theme])

  // Recompute the hover/select "connected neighbor" set from the precomputed adjacency,
  // then re-trigger the (already-installed, ref-reading) color/width/particle accessors
  // via the library's own `.prop(.prop())` idiom for a cheap redigest — NOT refresh(),
  // which would tear down and rebuild every node's label sprite on every mouse move.
  //
  // "Neighbor glow" off short-circuits `active` to null — same as nothing being hovered
  // or selected — so resolveNodeColor/resolveLinkColor fall through to their plain,
  // un-dimmed color for every node/link. Written as a direct ref read (not a helper
  // function call) everywhere it's needed below, so react-hooks/exhaustive-deps can see
  // it only touches refs and doesn't ask for it to be listed as an effect dependency.
  function refreshHighlight() {
    const active = controlsRef.current.neighborGlow ? hoverNodeRef.current ?? selectedNodeRef.current : null
    const highlightNodes = highlightNodesRef.current
    const highlightLinks = highlightLinksRef.current

    highlightNodes.clear()
    highlightLinks.clear()

    if (active) {
      highlightNodes.add(active)
      neighborsByNodeRef.current.get(active)?.forEach(neighbor => highlightNodes.add(neighbor))
      linksByNodeRef.current.get(active)?.forEach(link => highlightLinks.add(link))
    }

    const graph = graphRef.current

    if (!graph) {
      return
    }

    graph.nodeColor(graph.nodeColor())
    graph.linkColor(graph.linkColor())
    graph.linkWidth(graph.linkWidth())
    graph.linkDirectionalParticles(graph.linkDirectionalParticles())
  }

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
        const [{ default: ForceGraph3D }, { default: SpriteText }, notes] = await Promise.all([
          import('3d-force-graph'),
          import('three-spritetext'),
          loadVault()
        ])

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

        // Direct-neighbor adjacency, built once for this graph load (not re-derived on
        // every hover/select) — mirrors 3d-force-graph's own "highlight on hover"
        // reference pattern, but keeps it in side-table Maps instead of mutating the
        // node/link objects themselves.
        const neighborsByNode = new Map<GraphNode, GraphNode[]>()
        const linksByNode = new Map<GraphNode, GraphLink[]>()
        const nodeById = new Map(nodes.map(node => [node.id, node]))

        for (const link of links) {
          const source = nodeById.get(link.source)
          const target = nodeById.get(link.target)

          if (!source || !target) {
            continue
          }

          pushToMap(neighborsByNode, source, target)
          pushToMap(neighborsByNode, target, source)
          pushToMap(linksByNode, source, link)
          pushToMap(linksByNode, target, link)
        }

        neighborsByNodeRef.current = neighborsByNode
        linksByNodeRef.current = linksByNode

        const palette =
          paletteRef.current ?? readGraphPalette(document.documentElement.classList.contains('dark') ? 'dark' : 'light')
        paletteRef.current = palette

        const instance = new ForceGraph3D(host)
          .backgroundColor(palette.background)
          .width(host.clientWidth || host.offsetWidth || 800)
          .height(host.clientHeight || host.offsetHeight || 600)
          .nodeLabel((node: object) => {
            const graphNode = node as GraphNode

            return graphNode.ghost
              ? `<div style="font: 12px sans-serif; color:${paletteRef.current?.label ?? palette.label}">${graphNode.id} — click to create this note</div>`
              : `<div style="font: 12px sans-serif; color:${paletteRef.current?.label ?? palette.label}">${graphNode.id}</div>`
          })
          .nodeRelSize(controlsRef.current.nodeSize)
          .nodeColor((node: object) =>
            resolveNodeColor(
              node as GraphNode,
              paletteRef.current ?? palette,
              highlightNodesRef.current,
              controlsRef.current.neighborGlow ? hoverNodeRef.current ?? selectedNodeRef.current : null
            )
          )
          .nodeVal((node: object) => 1 + (node as GraphNode).degree)
          .nodeOpacity(0.9)
          .nodeThreeObject((node: object) => {
            if (!controlsRef.current.showNames) {
              return undefined
            }

            const graphNode = node as GraphNode
            const activePalette = paletteRef.current ?? palette
            const color = graphNode.ghost ? activePalette.ghost : activePalette.label
            const sprite = new SpriteText(truncateLabel(graphNode.id), LABEL_TEXT_HEIGHT, color)
            const object3d = sprite as unknown as Object3DLike
            const radius = Math.cbrt(1 + graphNode.degree) * controlsRef.current.nodeSize

            // Anchor the sprite's bottom edge (not its center) at the offset point, so the
            // label grows upward from just outside the sphere instead of straddling it.
            object3d.center.set(0.5, 0)
            object3d.position.set(0, radius * LABEL_OFFSET_SCALE, 0)

            return sprite
          })
          .nodeThreeObjectExtend(true)
          .linkColor((link: object) =>
            resolveLinkColor(
              link as GraphLink,
              paletteRef.current ?? palette,
              highlightLinksRef.current,
              controlsRef.current.neighborGlow ? hoverNodeRef.current ?? selectedNodeRef.current : null
            )
          )
          .linkWidth((link: object) => (highlightLinksRef.current.has(link as GraphLink) ? HIGHLIGHT_LINK_WIDTH : DEFAULT_LINK_WIDTH))
          .linkOpacity(0.55)
          .linkDirectionalParticles((link: object) =>
            highlightLinksRef.current.has(link as GraphLink) ? HIGHLIGHT_LINK_PARTICLES : 0
          )
          .linkDirectionalParticleWidth(HIGHLIGHT_LINK_PARTICLE_WIDTH)
          .onNodeHover((node: object | null) => {
            const graphNode = node as GraphNode | null

            if (hoverNodeRef.current === graphNode) {
              return
            }

            hoverNodeRef.current = graphNode
            refreshHighlight()
          })
          .onNodeClick((node: object) => {
            const graphNode = node as GraphNode

            selectedNodeRef.current = graphNode
            refreshHighlight()

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
          .onBackgroundClick(() => {
            selectedNodeRef.current = null
            refreshHighlight()
          })
          .graphData({ links, nodes })

        // Frame the whole graph once the force sim settles (and again as a fallback —
        // the container can report 0px at construction inside the flex layout). Generous
        // padding keeps the nodes comfortably inside the viewport rather than filling it.
        instance.onEngineStop(() => instance.zoomToFit(500, 110))
        window.setTimeout(() => instance.zoomToFit(700, 110), 1500)

        const orbit = instance.controls() as { autoRotate?: boolean; autoRotateSpeed?: number }
        orbit.autoRotate = controlsRef.current.rotationSpeed > 0
        orbit.autoRotateSpeed = controlsRef.current.rotationSpeed

        observer = new ResizeObserver(() => {
          instance.width(host.clientWidth || 800)
          instance.height(host.clientHeight || 600)
        })
        observer.observe(host)

        graph = instance
        graphRef.current = instance as unknown as TunableGraph
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
      graphRef.current = null
      neighborsByNodeRef.current = new Map()
      linksByNodeRef.current = new Map()
      hoverNodeRef.current = null
      selectedNodeRef.current = null
      highlightNodesRef.current = new Set()
      highlightLinksRef.current = new Set()
      graph?._destructor?.()
    }
  }, [navigate])

  // Live-apply the tuning panel: size, spread (link distance) and repulsion (charge) are
  // cheap prop setters we can always re-send, but the simulation is only reheated when
  // one of those three layout values actually changed — not on every render of this
  // effect — so the "Rotation speed" / "Node names" / "Neighbor glow" controls below
  // (none of which affect layout) don't jiggle the graph or yank the camera through the
  // onEngineStop -> zoomToFit callback above.
  useEffect(() => {
    try {
      window.localStorage.setItem(GRAPH_SETTINGS_KEY, JSON.stringify(controls))
    } catch {
      // persistence is best-effort
    }

    const graph = graphRef.current

    if (!graph || status !== 'ready') {
      return
    }

    graph.nodeRelSize(controls.nodeSize)
    graph.d3Force('link')?.distance?.(controls.spread)
    graph.d3Force('charge')?.strength?.(-controls.repulsion)

    const layoutSignature = `${controls.nodeSize}|${controls.spread}|${controls.repulsion}`

    if (prevLayoutSignatureRef.current !== layoutSignature) {
      prevLayoutSignatureRef.current = layoutSignature
      graph.d3ReheatSimulation()
    }

    const orbit = graph.controls()
    orbit.autoRotate = controls.rotationSpeed > 0
    orbit.autoRotateSpeed = controls.rotationSpeed

    if (prevShowNamesRef.current !== controls.showNames) {
      prevShowNamesRef.current = controls.showNames
      graph.refresh?.()
    }

    refreshHighlight()
  }, [controls, status])

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
        <div className="absolute right-6 top-5 z-10 flex flex-col items-end gap-2">
          <div className="flex gap-2">
            <Button
              aria-label="Graph settings"
              className="active:scale-[0.97] motion-reduce:transition-none"
              onClick={() => setPanelOpen(value => !value)}
              size="sm"
              variant={panelOpen ? 'secondary' : 'outline'}
            >
              <IconAdjustmentsHorizontal size={14} />
            </Button>
            <Button onClick={() => navigate(`${LIBRARY_ROUTE}?create=note`)} size="sm" variant="outline">
              + New note
            </Button>
          </div>
          {panelOpen && (
            <div className="w-64 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) p-4 text-(--ui-text-primary) shadow-lg">
              <div className="mb-4">
                <p className="text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-(--theme-primary)">Graph controls</p>
                <p className="mt-1 text-xs text-(--ui-text-secondary)">Tune the map without changing your notes.</p>
              </div>
              <div className="space-y-4">
                <ControlSlider
                  label="Node size"
                  max={10}
                  min={1}
                  onChange={nodeSize => setControls(current => ({ ...current, nodeSize }))}
                  step={0.5}
                  value={controls.nodeSize}
                />
                <ControlSlider
                  label="Spread"
                  max={120}
                  min={10}
                  onChange={spread => setControls(current => ({ ...current, spread }))}
                  step={2}
                  value={controls.spread}
                />
                <ControlSlider
                  label="Repulsion"
                  max={140}
                  min={0}
                  onChange={repulsion => setControls(current => ({ ...current, repulsion }))}
                  step={5}
                  value={controls.repulsion}
                />
                <ControlSlider
                  label="Rotation speed"
                  max={3}
                  min={0}
                  onChange={rotationSpeed => setControls(current => ({ ...current, rotationSpeed }))}
                  step={0.1}
                  value={controls.rotationSpeed}
                />
              </div>
              <label className="mt-4 flex cursor-pointer items-center justify-between border-t border-(--ui-stroke-tertiary) pt-3 text-xs font-medium text-(--ui-text-primary)">
                Node names
                <Switch
                  checked={controls.showNames}
                  onCheckedChange={showNames => setControls(current => ({ ...current, showNames }))}
                  size="xs"
                />
              </label>
              <label className="mt-3 flex cursor-pointer items-center justify-between text-xs font-medium text-(--ui-text-primary)">
                Neighbor glow
                <Switch
                  checked={controls.neighborGlow}
                  onCheckedChange={neighborGlow => setControls(current => ({ ...current, neighborGlow }))}
                  size="xs"
                />
              </label>
              <Button
                className="mt-3"
                onClick={() => setControls(DEFAULT_CONTROLS)}
                size="inline"
                variant="text"
              >
                Reset to defaults
              </Button>
            </div>
          )}
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
