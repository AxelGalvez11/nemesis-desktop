// Inline PDF reading — pdf.js (Apache-2.0, Mozilla; the same engine Firefox ships) rendered
// into our own dark chrome, replacing Chromium's stock grey viewer. Pages paint lazily as
// they scroll into view, crisp at any devicePixelRatio, with simple zoom / fit-width.
// The file is read through the hardened fs bridge (readFileDataUrl) — no webserver, no
// plugin process, nothing leaves the machine.
// Legacy build on purpose: pdf.js's default build targets the newest browser engines
// (it already uses JS features Electron doesn't ship yet); legacy carries the polyfills.
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

GlobalWorkerOptions.workerSrc = workerUrl

const FIT_PADDING = 72
const MIN_SCALE = 0.5
const MAX_SCALE = 2.5

interface PdfViewerProps {
  path: string
}

export function PdfViewer({ path }: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const railRef = useRef<HTMLDivElement | null>(null)
  const pageHostsRef = useRef(new Map<number, HTMLDivElement>())
  const [doc, setDoc] = useState<null | PDFDocumentProxy>(null)
  const [error, setError] = useState<null | string>(null)
  const [baseSize, setBaseSize] = useState<{ height: number; width: number } | null>(null)
  const [fitScale, setFitScale] = useState(1)
  const [zoom, setZoom] = useState<'fit' | number>('fit')
  const [currentPage, setCurrentPage] = useState(1)

  // Load the document once per path. Teardown goes through the loading task —
  // that's pdf.js v6's owner of the worker/document lifecycle.
  useEffect(() => {
    let cancelled = false
    let task: null | ReturnType<typeof getDocument> = null
    setDoc(null)
    setError(null)

    void (async () => {
      try {
        const read = await window.hermesDesktop?.readFileDataUrl?.(path)
        const src = typeof read === 'string' ? read : (read as { dataUrl?: string } | undefined)?.dataUrl

        if (!src) {
          throw new Error('Could not read the file.')
        }

        const buffer = await (await fetch(src)).arrayBuffer()
        task = getDocument({ data: new Uint8Array(buffer) })
        const loaded = await task.promise

        if (cancelled) {
          return
        }

        const first = await loaded.getPage(1)
        const viewport = first.getViewport({ scale: 1 })

        if (cancelled) {
          return
        }

        setBaseSize({ height: viewport.height, width: viewport.width })
        setDoc(loaded)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not open this PDF.')
        }
      }
    })()

    return () => {
      cancelled = true
      void task?.destroy().catch(() => {})
    }
  }, [path])

  // Fit-width: track the container so "Fit" stays correct across pane resizes.
  useEffect(() => {
    const host = containerRef.current

    if (!host || !baseSize) {
      return
    }

    const recompute = () => {
      const width = host.clientWidth - FIT_PADDING

      if (width > 100) {
        setFitScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, width / baseSize.width)))
      }
    }

    recompute()
    const observer = new ResizeObserver(recompute)
    observer.observe(host)

    return () => observer.disconnect()
  }, [baseSize])

  const scale = zoom === 'fit' ? fitScale : zoom

  const step = useCallback(
    (direction: 1 | -1) => {
      setZoom(current => {
        const from = current === 'fit' ? fitScale : current

        return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round((from + direction * 0.125) * 1000) / 1000))
      })
    },
    [fitScale]
  )

  const registerPageHost = useCallback((pageNumber: number, host: HTMLDivElement | null) => {
    if (host) {
      pageHostsRef.current.set(pageNumber, host)
    } else {
      pageHostsRef.current.delete(pageNumber)
    }
  }, [])

  // Track which page owns the middle of the viewport (drives the thumbnail highlight
  // and the "Page x / y" readout).
  const onScroll = useCallback(() => {
    const container = containerRef.current

    if (!container) {
      return
    }

    const middle = container.scrollTop + container.clientHeight / 2
    let best = 1
    let bestDistance = Number.POSITIVE_INFINITY

    for (const [pageNumber, host] of pageHostsRef.current) {
      const center = host.offsetTop + host.offsetHeight / 2
      const distance = Math.abs(center - middle)

      if (distance < bestDistance) {
        bestDistance = distance
        best = pageNumber
      }
    }

    setCurrentPage(best)
  }, [])

  const jumpToPage = useCallback((pageNumber: number) => {
    pageHostsRef.current.get(pageNumber)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  if (error) {
    return (
      <div className="grid h-full place-items-center rounded-lg border border-border bg-card p-6 text-center text-sm text-muted-foreground">
        {error}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-(--ui-bg-secondary,var(--color-muted))">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-card/70 px-3 py-1.5 backdrop-blur">
        <span className="text-xs tabular-nums text-muted-foreground">
          {doc ? `Page ${currentPage} / ${doc.numPages}` : 'Opening…'}
        </span>
        <div className="flex items-center gap-1">
          <Button aria-label="Zoom out" className="h-6 w-6 p-0" onClick={() => step(-1)} size="sm" variant="ghost">
            −
          </Button>
          <span className="w-12 text-center text-xs tabular-nums text-muted-foreground">{Math.round(scale * 100)}%</span>
          <Button aria-label="Zoom in" className="h-6 w-6 p-0" onClick={() => step(1)} size="sm" variant="ghost">
            +
          </Button>
          <Button className="h-6 px-2 text-xs" onClick={() => setZoom('fit')} size="sm" variant={zoom === 'fit' ? 'secondary' : 'ghost'}>
            Fit
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        {doc && baseSize && doc.numPages > 1 && (
          <div className="w-[6.5rem] shrink-0 overflow-y-auto border-r border-border px-2 py-2" ref={railRef}>
            {Array.from({ length: doc.numPages }, (_, i) => (
              <PdfThumb
                active={currentPage === i + 1}
                baseSize={baseSize}
                doc={doc}
                key={i + 1}
                onSelect={jumpToPage}
                pageNumber={i + 1}
                root={railRef.current}
              />
            ))}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2" onScroll={onScroll} ref={containerRef}>
          {doc && baseSize ? (
            Array.from({ length: doc.numPages }, (_, i) => (
              <PdfPage
                baseSize={baseSize}
                doc={doc}
                key={`${i + 1}@${scale.toFixed(3)}`}
                onHost={registerPageHost}
                pageNumber={i + 1}
                root={containerRef.current}
                scale={scale}
              />
            ))
          ) : (
            <div className="grid h-full place-items-center text-sm text-muted-foreground">Opening…</div>
          )}
        </div>
      </div>
    </div>
  )
}

const THUMB_WIDTH = 80

function PdfThumb({
  active,
  baseSize,
  doc,
  onSelect,
  pageNumber,
  root
}: {
  active: boolean
  baseSize: { height: number; width: number }
  doc: PDFDocumentProxy
  onSelect: (pageNumber: number) => void
  pageNumber: number
  root: HTMLDivElement | null
}) {
  const hostRef = useRef<HTMLButtonElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [visible, setVisible] = useState(pageNumber <= 8)

  useEffect(() => {
    const host = hostRef.current

    if (!host || visible) {
      return
    }

    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          setVisible(true)
        }
      },
      { root, rootMargin: '400px 0px' }
    )

    observer.observe(host)

    return () => observer.disconnect()
  }, [root, visible])

  useEffect(() => {
    if (!visible) {
      return
    }

    let cancelled = false

    void (async () => {
      try {
        const page = await doc.getPage(pageNumber)
        const canvas = canvasRef.current

        if (cancelled || !canvas) {
          return
        }

        const viewport = page.getViewport({ scale: (THUMB_WIDTH / baseSize.width) * 2 })
        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)
        await page.render({ canvas, viewport }).promise
      } catch {
        // thumb render failures are non-fatal; the main page view still works
      }
    })()

    return () => {
      cancelled = true
    }
  }, [baseSize.width, doc, pageNumber, visible])

  const thumbHeight = Math.round((baseSize.height / baseSize.width) * THUMB_WIDTH)

  return (
    <button
      className={cn(
        'mb-2 block w-full rounded-md p-1 transition-colors',
        active ? 'bg-(--theme-primary)/15 ring-1 ring-(--theme-primary)' : 'hover:bg-accent'
      )}
      onClick={() => onSelect(pageNumber)}
      ref={hostRef}
      title={`Page ${pageNumber}`}
      type="button"
    >
      {visible ? (
        <canvas className="w-full rounded-sm bg-white shadow" ref={canvasRef} style={{ height: thumbHeight }} />
      ) : (
        <div className="w-full rounded-sm bg-white/10" style={{ height: thumbHeight }} />
      )}
      <span className={cn('mt-0.5 block text-center text-[10px] tabular-nums', active ? 'text-foreground' : 'text-muted-foreground')}>
        {pageNumber}
      </span>
    </button>
  )
}

function PdfPage({
  baseSize,
  doc,
  onHost,
  pageNumber,
  root,
  scale
}: {
  baseSize: { height: number; width: number }
  doc: PDFDocumentProxy
  onHost: (pageNumber: number, host: HTMLDivElement | null) => void
  pageNumber: number
  root: HTMLDivElement | null
  scale: number
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [visible, setVisible] = useState(pageNumber <= 2)
  const [rendered, setRendered] = useState(false)

  // Lazily wake pages as they approach the viewport (600px lookahead).
  useEffect(() => {
    const host = hostRef.current

    if (!host || visible) {
      return
    }

    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          setVisible(true)
        }
      },
      { root, rootMargin: '600px 0px' }
    )

    observer.observe(host)

    return () => observer.disconnect()
  }, [root, visible])

  useEffect(() => {
    if (!visible) {
      return
    }

    let cancelled = false

    void (async () => {
      try {
        const page = await doc.getPage(pageNumber)
        const canvas = canvasRef.current

        if (cancelled || !canvas) {
          return
        }

        const viewport = page.getViewport({ scale })
        const dpr = Math.min(2, window.devicePixelRatio || 1)
        canvas.width = Math.floor(viewport.width * dpr)
        canvas.height = Math.floor(viewport.height * dpr)
        canvas.style.width = `${Math.floor(viewport.width)}px`
        canvas.style.height = `${Math.floor(viewport.height)}px`
        await page.render({
          canvas,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
          viewport
        }).promise

        if (!cancelled) {
          setRendered(true)
        }
      } catch (err) {
        // A cancelled render (fast scroll/zoom) is routine; anything else is worth a trace.
        if (!cancelled) {
          console.warn(`[pdf-viewer] page ${pageNumber} render failed`, err)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [doc, pageNumber, scale, visible])

  const placeholderHeight = Math.floor(baseSize.height * scale)

  return (
    <div
      className="my-3 flex justify-center"
      ref={element => {
        hostRef.current = element
        onHost(pageNumber, element)
      }}
    >
      {visible ? (
        <canvas
          className="max-w-full rounded-md bg-white shadow-lg ring-1 ring-black/20"
          ref={canvasRef}
          style={rendered ? undefined : { height: placeholderHeight, width: Math.floor(baseSize.width * scale) }}
        />
      ) : (
        <div
          className="max-w-full rounded-md bg-white/5 ring-1 ring-white/10"
          style={{ height: placeholderHeight, width: Math.floor(baseSize.width * scale) }}
        />
      )}
    </div>
  )
}
