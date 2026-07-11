// DOM chrome for the NATIVE school browser: the page itself is a real Electron
// WebContentsView the MAIN process composites OVER this panel — no screencast,
// no forwarded input (cf. browser-mirror.tsx, the config fallback). This
// component renders only the tab strip + URL bar + a placeholder box, and
// keeps the main process told exactly where the page should sit (setBounds
// with the placeholder's rect, in CSS px — main scales by the live zoomFactor)
// and when it may be shown at all (setVisible — the native view floats above
// ALL DOM, so it must yield while a modal dialog is open).
import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { Codicon } from '@/components/ui/codicon'
import type { HermesSchoolViewState } from '@/global'
import { cn } from '@/lib/utils'
import { $zoomPercent } from '@/store/zoom'

import { BrowserMirror } from './browser-mirror'

// ResizeObserver only fires on SIZE changes; pure position shifts (another
// pane opening pushes this one sideways at the same size) are caught by this
// slow poll instead.
const BOUNDS_POLL_MS = 250

function api() {
  return window.hermesDesktop?.schoolView
}

function hostFor(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** Same URL-bar contract as the mirror: explicit schemes pass through, bare
 *  domains get https://, anything else becomes a Google search. */
function navigationTarget(raw: string): null | string {
  const trimmed = raw.trim()

  if (!trimmed) {
    return null
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return trimmed
  }

  return /\s/.test(trimmed) || !trimmed.includes('.')
    ? `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
    : `https://${trimmed}`
}

type PanelMode = HermesSchoolViewState['mode']

// The mode is fixed for the app's lifetime (the main process decides it
// before app-ready), so resolve it once per renderer and reuse across
// remounts of the rail.
let modePromise: null | Promise<PanelMode> = null

function resolveMode(): Promise<PanelMode> {
  modePromise ??= (async () => {
    try {
      const state = await api()?.getState()

      return state?.mode === 'native' ? 'native' : 'mirror'
    } catch {
      return 'mirror'
    }
  })()

  return modePromise
}

/** The right-rail Browser tab: native WebContentsView chrome when the main
 *  process runs the school browser in native mode, the CDP screencast mirror
 *  otherwise (mirror config fallback, older preload, plain web build). */
export function SchoolBrowserPanel() {
  const [mode, setMode] = useState<null | PanelMode>(null)

  useEffect(() => {
    let cancelled = false

    void resolveMode().then(resolved => {
      if (!cancelled) {
        setMode(resolved)
      }
    })

    return () => {
      cancelled = true
    }
  }, [])

  if (!mode) {
    // One IPC round-trip of blank surface — avoids flashing the wrong chrome.
    return <div className="h-full w-full bg-(--ui-editor-surface-background)" />
  }

  return mode === 'native' ? <NativeBrowserPanel /> : <BrowserMirror />
}

function NativeBrowserPanel() {
  const [state, setState] = useState<HermesSchoolViewState | null>(null)
  const [urlDraft, setUrlDraft] = useState<null | string>(null)
  const zoomPercent = useStore($zoomPercent)

  const placeholderRef = useRef<HTMLDivElement | null>(null)
  // Last rect actually SENT — drift is measured against it, so slow 1px-a-beat
  // creep still converges on a send instead of being skipped forever.
  const lastSentRef = useRef({ height: -1, width: -1, x: -1, y: -1 })

  const reportBounds = useCallback((force = false) => {
    const box = placeholderRef.current?.getBoundingClientRect()

    if (!box) {
      return
    }

    const rect = {
      height: Math.round(box.height),
      width: Math.round(box.width),
      x: Math.round(box.x),
      y: Math.round(box.y)
    }

    const last = lastSentRef.current

    const unchanged =
      Math.abs(rect.x - last.x) < 2 &&
      Math.abs(rect.y - last.y) < 2 &&
      Math.abs(rect.width - last.width) < 2 &&
      Math.abs(rect.height - last.height) < 2

    if (!force && unchanged) {
      return
    }

    lastSentRef.current = rect
    void api()
      ?.setBounds(rect)
      .catch(() => undefined)
  }, [])

  // Tab/URL state: seed once, then live off the main-process broadcasts
  // (every tab mutation pushes a fresh snapshot).
  useEffect(() => {
    void api()
      ?.getState()
      .then(setState)
      .catch(() => undefined)

    return api()?.onState(setState)
  }, [])

  // Geometry: observer for size changes + the position-shift poll.
  useEffect(() => {
    const observer = new ResizeObserver(() => reportBounds())

    if (placeholderRef.current) {
      observer.observe(placeholderRef.current)
    }

    const timer = window.setInterval(() => reportBounds(), BOUNDS_POLL_MS)
    reportBounds(true)

    return () => {
      observer.disconnect()
      window.clearInterval(timer)
    }
  }, [reportBounds])

  // Zoom rescales the native view in the MAIN process (it multiplies the CSS
  // rect by the live zoomFactor), so a zoom change must re-send even when the
  // rect here reads the same.
  useEffect(() => {
    reportBounds(true)
  }, [reportBounds, zoomPercent])

  // Visibility: shown while mounted — EXCEPT while any open DOM dialog
  // exists, because the native view composites above the entire DOM and would
  // cover the modal. Watch the body and yield for as long as one is up.
  useEffect(() => {
    let lastApplied: boolean | null = null
    let raf = 0

    const sync = () => {
      const next = !document.querySelector('[role="dialog"][data-state="open"]')

      if (next !== lastApplied) {
        lastApplied = next
        void api()
          ?.setVisible(next)
          .catch(() => undefined)
      }
    }

    // Coalesce mutation bursts through rAF — streaming chat mutates the DOM
    // constantly and the querySelector only needs to run once per frame.
    const schedule = () => {
      if (raf) {
        return
      }

      raf = window.requestAnimationFrame(() => {
        raf = 0
        sync()
      })
    }

    sync()

    const observer = new MutationObserver(schedule)
    observer.observe(document.body, {
      attributeFilter: ['data-state'],
      attributes: true,
      childList: true,
      subtree: true
    })

    return () => {
      observer.disconnect()
      window.cancelAnimationFrame(raf)
      void api()
        ?.setVisible(false)
        .catch(() => undefined)
    }
  }, [])

  // Tab-op invokes resolve with the fresh snapshot — apply it directly
  // instead of waiting a beat for the broadcast to come back around.
  const apply = useCallback((op?: Promise<HermesSchoolViewState>) => {
    void op?.then(setState).catch(() => undefined)
  }, [])

  const navigate = useCallback(
    (raw: string) => {
      const target = navigationTarget(raw)

      if (target) {
        apply(api()?.navigate(target))
        setUrlDraft(null)
      }
    },
    [apply]
  )

  const tabs = state?.tabs ?? []
  const activeUrl = tabs.find(tab => tab.id === state?.activeId)?.url ?? ''

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-(--ui-editor-surface-background)">
      {/* Native browser tab strip */}
      <div className="flex h-7 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-(--ui-stroke-tertiary) px-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map(tab => {
          const active = tab.id === state?.activeId

          return (
            <div
              className={cn(
                'group/btab flex h-5.5 min-w-0 max-w-40 shrink-0 items-center rounded-md pl-2 pr-1 text-[0.65rem]',
                active
                  ? 'bg-(--ui-bg-secondary) text-foreground'
                  : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
              )}
              key={tab.id}
            >
              <button
                className="min-w-0 truncate outline-none"
                onClick={() => {
                  apply(api()?.activate(tab.id))
                  setUrlDraft(null)
                }}
                title={tab.url}
                type="button"
              >
                {tab.title || hostFor(tab.url) || 'New tab'}
              </button>
              <button
                aria-label="Close tab"
                className="ml-1 grid size-4 shrink-0 place-items-center rounded-sm opacity-0 transition-opacity hover:bg-(--ui-control-hover-background) group-hover/btab:opacity-100"
                onClick={() => apply(api()?.closeTab(tab.id))}
                type="button"
              >
                <Codicon name="close" size="0.6rem" />
              </button>
            </div>
          )
        })}
        <button
          aria-label="New tab"
          className="grid size-5.5 shrink-0 place-items-center rounded-md text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground"
          onClick={() => apply(api()?.newTab())}
          type="button"
        >
          <Codicon name="add" size="0.7rem" />
        </button>
      </div>

      {/* Nav row: back / forward / reload + URL */}
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-(--ui-stroke-tertiary) px-1.5">
        <button
          aria-label="Back"
          className="grid size-6 place-items-center rounded-md text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground"
          onClick={() => apply(api()?.history('back'))}
          type="button"
        >
          <Codicon name="arrow-left" size="0.8rem" />
        </button>
        <button
          aria-label="Forward"
          className="grid size-6 place-items-center rounded-md text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground"
          onClick={() => apply(api()?.history('forward'))}
          type="button"
        >
          <Codicon name="arrow-right" size="0.8rem" />
        </button>
        <button
          aria-label="Reload"
          className="grid size-6 place-items-center rounded-md text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground"
          onClick={() => apply(api()?.reload())}
          type="button"
        >
          <Codicon name="refresh" size="0.8rem" />
        </button>
        <input
          className="h-6 min-w-0 flex-1 rounded-md border border-(--ui-stroke-quaternary) bg-(--ui-bg-secondary) px-2 text-[0.7rem] text-foreground outline-none placeholder:text-(--ui-text-quaternary) focus:border-(--ui-stroke-secondary)"
          onBlur={() => setUrlDraft(null)}
          onChange={event => setUrlDraft(event.target.value)}
          onFocus={event => event.target.select()}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              navigate(event.currentTarget.value)
              event.currentTarget.blur()
            }
          }}
          placeholder="Type a URL and press Enter"
          spellCheck={false}
          value={urlDraft ?? activeUrl}
        />
      </div>

      {/* Placeholder: the main process composites the WebContentsView exactly
          over this box (reportBounds keeps it told where the box sits). The
          hint below is only ever visible before the first state lands. */}
      <div className="relative min-h-0 flex-1" ref={placeholderRef}>
        {tabs.length === 0 && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center text-[0.72rem] text-(--ui-text-tertiary)">
            Opening the browser…
          </div>
        )}
      </div>
    </div>
  )
}
