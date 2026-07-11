// Mind map viewer: renders an agent-written outline (see extras.ts) as an interactive
// markmap (markmap-lib transforms markdown → tree, markmap-view lays it out as SVG).
// Both are MIT-licensed and load no network resources — the transform + render are fully
// local, matching every other vault-content viewer in this app (PdfViewer, Library notes).
import { Transformer } from 'markmap-lib'
import { Markmap } from 'markmap-view'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

import type { MindmapFile } from './extras'

// One shared Transformer — it's stateless per-call (transform() takes the markdown fresh
// each time), so there's no reason to build a new markdown-it pipeline per dialog open.
const transformer = new Transformer()

// Real CSS text, injected into markmap's own <style> tag (see the `style` option below) —
// var()/color-mix() are resolved natively by the browser's CSS engine here, so referencing
// the app's tokens directly is safe (unlike the `color` option below, which is a JS
// function whose return value becomes an SVG stroke attribute).
const MINDMAP_THEME_CSS = `
.markmap {
  --markmap-text-color: var(--ui-text-primary);
  --markmap-a-color: var(--theme-primary);
  --markmap-a-hover-color: var(--theme-primary);
  --markmap-code-bg: color-mix(in srgb, var(--ui-text-primary) 10%, transparent);
  --markmap-code-color: var(--ui-text-secondary);
  --markmap-circle-open-bg: var(--ui-bg-card);
  --markmap-highlight-bg: color-mix(in srgb, var(--theme-primary) 25%, transparent);
}
`

// Chrome can resolve a CSS custom property to the CSS Color-4 `color(srgb r g b / a)`
// syntax. That's real CSS (safe wherever the browser parses it natively, like the style
// text above) — but the `color` option below returns a plain string that markmap-view
// hands to d3's `.attr('stroke', …)`. The graph page (app/graph/index.tsx) hit this exact
// class of bug with three.js, whose own color parser doesn't understand `color(srgb …)`
// and silently falls back to black. SVG presentation attributes are CSS-parsed by the
// browser too, so this is likely unnecessary here — but normalizing to a plain
// `rgb(r, g, b)` string removes any doubt at near-zero cost. Local copy (not imported):
// the graph page is out of this branch's scope, and this is a small, stable utility.
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

interface MindmapPalette {
  accent: string
  line: string
}

function readMindmapPalette(): MindmapPalette {
  return {
    accent: resolveCssColor('var(--theme-primary)', '#b3382e'),
    line: resolveCssColor('color-mix(in srgb, var(--ui-text-primary) 32%, transparent)', 'rgba(160,160,160,0.5)')
  }
}

interface OutlineLine {
  depth: number
  text: string
}

/** Fallback-path parser: headings + bullets → an indented line list. Not a full markdown
 *  parser (deliberately) — this only has to be legible when markmap itself can't render. */
function parseOutlineFallback(markdown: string): OutlineLine[] {
  const lines: OutlineLine[] = []
  let headingDepth = 0

  for (const rawLine of markdown.split(/\r?\n/)) {
    const heading = rawLine.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)

    if (heading) {
      headingDepth = heading[1].length - 1
      lines.push({ depth: headingDepth, text: heading[2] })

      continue
    }

    const bullet = rawLine.match(/^(\s*)[-*+]\s+(.+)$/)

    if (bullet) {
      const indent = Math.floor(bullet[1].replace(/\t/g, '  ').length / 2)
      lines.push({ depth: headingDepth + 1 + indent, text: bullet[2] })

      continue
    }

    const text = rawLine.trim()

    if (text) {
      lines.push({ depth: headingDepth + 1, text })
    }
  }

  return lines
}

function OutlineFallback({ outline }: { outline: string }) {
  const lines = parseOutlineFallback(outline)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
      <p className="mb-3 text-xs text-muted-foreground">Showing the plain outline — the mind map view couldn’t load.</p>
      {lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">This mind map is empty.</p>
      ) : (
        <div className="space-y-1 font-mono text-[0.8125rem] leading-relaxed">
          {lines.map((line, index) => (
            <div key={index} style={{ paddingLeft: `${line.depth * 1.25}rem` }}>
              {line.text}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function MindmapCanvas({ file }: { file: MindmapFile }) {
  const svgRef = useRef<null | SVGSVGElement>(null)
  const markmapRef = useRef<Markmap | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!svgRef.current) {
      setFailed(true)

      return
    }

    try {
      const { root } = transformer.transform(file.outline.trim() || `# ${file.title}`)
      const palette = readMindmapPalette()

      markmapRef.current = Markmap.create(
        svgRef.current,
        {
          autoFit: true,
          color: node => (node.state.depth === 0 ? palette.accent : palette.line),
          duration: 300,
          style: () => MINDMAP_THEME_CSS
        },
        root
      )
    } catch {
      setFailed(true)
    }

    return () => {
      markmapRef.current?.destroy()
      markmapRef.current = null
    }
    // `file` is intentionally excluded: this component remounts on file change (the
    // caller passes `key={file.fileName}`), so re-running this effect for the same
    // mounted instance would only ever happen for a `file` that hasn't changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (failed) {
    return <OutlineFallback outline={file.outline} />
  }

  return (
    <div className="relative min-h-0 flex-1">
      <svg className="h-full w-full" ref={svgRef} />
      <Button className="absolute bottom-3 right-3" onClick={() => void markmapRef.current?.fit()} size="sm" variant="outline">
        Fit
      </Button>
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
  return (
    <Dialog onOpenChange={onOpenChange} open={file !== null}>
      <DialogContent className="flex h-[85vh] max-h-[85vh] w-full max-w-4xl flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
        {file && (
          <>
            <DialogHeader className="shrink-0 border-b border-border px-5 py-3.5 pr-11">
              <DialogTitle className="truncate">{file.title}</DialogTitle>
            </DialogHeader>
            <MindmapCanvas file={file} key={file.fileName} />
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
