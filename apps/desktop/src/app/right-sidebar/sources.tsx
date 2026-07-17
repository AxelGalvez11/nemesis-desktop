// Sources rail (student build): every citation behind the CURRENT answer — markdown
// links, bare URLs, PMIDs, NCT trial ids, DOIs — collected into one clickable list.
// This replaces the developer file-tree as the default right-sidebar pane: students
// ask evidence questions, so the rail should answer "where did THAT come from?".
import { useStore } from '@nanostores/react'
import { computed } from 'nanostores'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { type ChatMessage, chatMessageText } from '@/lib/chat-messages'
import { useLinkTitle } from '@/lib/external-link'
import { cn } from '@/lib/utils'
import { NEMESIS_STUDENT_BUILD } from '@/nemesis'
import { openBrowserRail } from '@/store/browser-rail'
import { $messages } from '@/store/session'
import { $focusedSourceUrl } from '@/store/source-focus'

export interface SourceRef {
  url: string
  title: string
  badge: string
  domain: string
}

export const SOURCE_CHIP_CLASS_NAME =
  'group/source inline-flex max-w-full items-center gap-1.5 rounded-full border border-border/35 bg-card/65 px-2 py-1 text-[11px] leading-none text-muted-foreground shadow-[0_1px_1px_rgb(0_0_0/0.04)] transition-[background-color,border-color,color,box-shadow,transform] duration-150 hover:-translate-y-px hover:border-border/70 hover:bg-card hover:text-foreground hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--theme-primary)/35'

const MD_LINK = /\[([^\]\n]{1,160})\]\((https?:\/\/[^\s)]+)\)/g
const BARE_URL = /https?:\/\/[^\s<>"'()[\]{}]+/g
// Scheme-less citations ("www.gov.uk/drug-safety-update/…") — models write these
// from memory; without this they render as links but never become pills.
const WWW_URL = /\bwww\.[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s<>"'()[\]{}]*/gi
const PMID_RE = /\bPMID:?\s*(\d{6,9})\b/gi
const NCT_RE = /\bNCT\d{8}\b/gi
const DOI_RE = /\b10\.\d{4,9}\/[^\s<>"'()[\]{}]+/g

function cleanUrl(raw: string): string {
  return raw.replace(/[.,;:!?]+$/, '')
}

function badgeFor(hostname: string): string {
  const host = hostname.replace(/^www\./, '')

  if (host.includes('pubmed.ncbi')) {
    return 'PubMed'
  }

  if (host.includes('ncbi.nlm.nih.gov') || host.includes('pmc.ncbi')) {
    return 'NCBI'
  }

  if (host.endsWith('fda.gov')) {
    return 'FDA'
  }

  if (host.includes('clinicaltrials.gov')) {
    return 'Trial'
  }

  if (host === 'doi.org') {
    return 'DOI'
  }

  if (host.endsWith('who.int')) {
    return 'WHO'
  }

  if (host.endsWith('cdc.gov')) {
    return 'CDC'
  }

  if (host.endsWith('nih.gov')) {
    return 'NIH'
  }

  if (host.includes('cochrane')) {
    return 'Cochrane'
  }

  return 'Web'
}

// Tool traffic only counts when it hits a known evidence host — the agent consulting
// PubMed/FDA/ClinicalTrials is a source; a random search-result URL is noise.
const EVIDENCE_HOSTS = ['ncbi.nlm.nih.gov', 'fda.gov', 'clinicaltrials.gov', 'doi.org', 'who.int', 'cdc.gov', 'nih.gov']

function isEvidenceHost(hostname: string): boolean {
  const host = hostname.replace(/^www\./, '')

  return EVIDENCE_HOSTS.some(candidate => host === candidate || host.endsWith(`.${candidate}`))
}

interface SourceSink {
  push: (rawUrl: string, title?: string) => void
}

/** Text-level citations: markdown links, bare URLs, PMIDs, NCT ids, DOIs. */
function harvestText(text: string, sink: SourceSink): void {
  // Markdown links first (they carry real titles), then scan the remainder so the
  // same URL isn't double-counted as a bare match.
  for (const match of text.matchAll(MD_LINK)) {
    sink.push(match[2], match[1])
  }

  const stripped = text.replace(MD_LINK, ' ')

  for (const match of stripped.matchAll(BARE_URL)) {
    sink.push(match[0])
  }

  for (const match of stripped.replace(BARE_URL, ' ').matchAll(WWW_URL)) {
    sink.push(`https://${match[0]}`)
  }

  for (const match of stripped.matchAll(PMID_RE)) {
    sink.push(`https://pubmed.ncbi.nlm.nih.gov/${match[1]}/`, `PMID ${match[1]}`)
  }

  for (const match of stripped.matchAll(NCT_RE)) {
    sink.push(`https://clinicaltrials.gov/study/${match[0].toUpperCase()}`, match[0].toUpperCase())
  }

  for (const match of stripped.matchAll(DOI_RE)) {
    sink.push(`https://doi.org/${cleanUrl(match[0])}`, `DOI ${cleanUrl(match[0])}`)
  }
}

function makeSink(): { out: SourceRef[]; sink: SourceSink } {
  const seen = new Set<string>()
  const out: SourceRef[] = []

  const push = (rawUrl: string, title?: string) => {
    const url = cleanUrl(rawUrl)
    let parsed: URL

    try {
      parsed = new URL(url)
    } catch {
      return
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return
    }

    // openFDA stamps terms/license/disclaimer links into every response — boilerplate,
    // not sources.
    if (/^open\.fda\.gov$/i.test(parsed.hostname) && /terms|license|disclaimer/i.test(parsed.pathname)) {
      return
    }

    const key = url.replace(/\/+$/, '').toLowerCase()

    if (seen.has(key)) {
      return
    }

    seen.add(key)

    const domain = parsed.hostname.replace(/^www\./, '')

    // API lookups label better by WHAT was searched than by their endpoint path.
    const query =
      parsed.searchParams.get('term') || parsed.searchParams.get('search') || parsed.searchParams.get('query')

    const fallback = query
      ? `${domain} — “${decodeURIComponent(query).replace(/\+/g, ' ').slice(0, 40)}”`
      : `${domain}${parsed.pathname.length > 1 ? decodeURIComponent(parsed.pathname).slice(0, 60) : ''}`

    out.push({ badge: badgeFor(parsed.hostname), domain, title: (title || fallback).trim(), url })
  }

  return { out, sink: { push } }
}

/** Citations named in a single blob of answer text. Pure — feeds the inline pills. */
export function sourcesFromText(text: string): SourceRef[] {
  const { out, sink } = makeSink()
  harvestText(text, sink)

  return out.slice(0, 24)
}

/** Pull every citation out of the assistant's messages (plus evidence-host URLs from the
 *  agent's tool traffic), deduped, in reading order. Pure. */
export function extractSources(messages: readonly ChatMessage[]): SourceRef[] {
  const { out, sink } = makeSink()

  for (const message of messages) {
    // Deep-scan every message's raw payload — tool calls and their results ride INSIDE
    // the assistant message in this app — keeping only evidence-host URLs (a PubMed/FDA/
    // trials lookup is a source; a random search-result URL is noise).
    let raw = ''

    try {
      raw = JSON.stringify(message).slice(0, 300_000)
    } catch {
      raw = ''
    }

    if (raw) {
      for (const match of raw.replace(/\\\//g, '/').matchAll(BARE_URL)) {
        const candidate = cleanUrl(match[0].replace(/\\+$/, ''))

        try {
          if (isEvidenceHost(new URL(candidate).hostname)) {
            sink.push(candidate)
          }
        } catch {
          // not a parseable URL — skip
        }
      }
    }

    if (message.role !== 'assistant') {
      continue
    }

    let text = ''

    try {
      text = chatMessageText(message)
    } catch {
      continue
    }

    if (text) {
      harvestText(text, sink)
    }
  }

  return out.slice(0, 100)
}

/** The current exchange: the last user message onward — the only slice of the session
 *  the Sources rail reads (owner call 2026-07-14; the whole-session harvest buried the
 *  live answer's citations and froze the rail across session switches). */
export function currentExchange(messages: readonly ChatMessage[]): readonly ChatMessage[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'user') {
      return messages.slice(index)
    }
  }

  return messages
}

/** Whether the current answer touched any sources — the right rail only offers its
 *  Sources tab (and only shows at all, absent a preview/browser) when this is true. */
export function hasCurrentExchangeSources(messages: readonly ChatMessage[]): boolean {
  return extractSources(currentExchange(messages)).length > 0
}

/** Store form of the same check, so layout code (the rail's Pane, its segment strip)
 *  can subscribe to the BOOLEAN and only re-render when it flips — subscribing the
 *  desktop controller to $messages itself would re-render the shell every token. */
export const $currentExchangeHasSources = computed($messages, hasCurrentExchangeSources)

/** Site icon for a pill — the domain's own favicon, falling back to a letter badge
 *  (api subdomains and offline mode often have no icon to fetch). */
export function SourceFavicon({ domain }: { domain: string }) {
  const [failed, setFailed] = useState(false)

  if (failed) {
    return (
      <span className="grid size-4 shrink-0 place-items-center rounded-sm bg-(--theme-primary)/15 text-[9px] font-bold text-(--theme-primary)">
        {domain.charAt(0).toUpperCase()}
      </span>
    )
  }

  return (
    <img
      alt=""
      className="size-4 shrink-0 rounded-sm"
      loading="lazy"
      onError={() => setFailed(true)}
      src={`https://${domain}/favicon.ico`}
    />
  )
}

/** One reading-list row, ChatGPT-anatomy: publisher line (favicon + badge),
 *  the real article title (fetched lazily, 2-line clamp) as the prominent
 *  element, then the dim domain. Click reads it in the rail's own Browser
 *  tab; the hover ↗ is the external escape hatch. */
function SourceRow({
  focused,
  refCb,
  source
}: {
  focused: boolean
  refCb: (el: HTMLButtonElement | null) => void
  source: SourceRef
}) {
  const fetchedTitle = useLinkTitle(source.url)
  // Some sources are raw API endpoints (NCBI eutils, openFDA) that answer a
  // browser GET with an error page — "400 Bad Request", "403 Forbidden", etc.
  // Never let that stand in as the title; fall back to our own derived label.
  const looksLikeHttpError = /^\d{3}\b|bad request|forbidden|not found|error|access denied/i.test(fetchedTitle.trim())
  const title = fetchedTitle && !looksLikeHttpError ? fetchedTitle : source.title

  return (
    <div className="group/source relative">
      <button
        className={cn(
          'flex w-full flex-col items-start gap-0.5 rounded-lg px-2 py-2 pr-7 text-left transition-colors hover:bg-(--chrome-action-hover)',
          focused && 'bg-card ring-2 ring-(--theme-primary)/70 ring-offset-1 ring-offset-background'
        )}
        onClick={() => {
          void window.hermesDesktop?.schoolView?.newTab?.(source.url)
          openBrowserRail()
        }}
        ref={refCb}
        title={`${title}\n${source.url}\nClick: read here · ↗: open in your browser`}
        type="button"
      >
        <span className="flex min-w-0 max-w-full items-center gap-1.5 text-[0.65rem] text-muted-foreground">
          <SourceFavicon domain={source.domain} />
          <span className="truncate">{source.badge}</span>
        </span>
        <span className="line-clamp-2 text-xs font-medium leading-snug text-foreground/90">{title}</span>
        <span className="max-w-full truncate text-[0.65rem] text-muted-foreground/60">{source.domain}</span>
      </button>
      {/* Student build: research stays inside Nemesis — no external-browser escape hatch. */}
      {!NEMESIS_STUDENT_BUILD && (
        <button
          aria-label="Open in your browser"
          className="absolute right-1.5 top-2 grid place-items-center rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-focus-within/source:opacity-70 group-hover/source:opacity-70"
          onClick={() => void window.hermesDesktop?.openExternal?.(source.url)}
          title="Open in your browser"
          type="button"
        >
          <Codicon name="link-external" size="0.625rem" />
        </button>
      )}
    </div>
  )
}

export function SourcesTab() {
  const messages = useStore($messages)
  const focusedSourceUrl = useStore($focusedSourceUrl)
  // Only the current exchange (last user message onward) feeds the rail — see
  // currentExchange above for why.
  const exchange = useMemo(() => currentExchange(messages), [messages])
  const sources = useMemo(() => extractSources(exchange), [exchange])
  // ChatGPT splits its drawer into cited-in-the-answer vs everything else the
  // run touched. Cited = named in an ASSISTANT message's text; the rest came
  // from tool traffic only.
  const citedUrls = useMemo(() => {
    const assistantText = exchange
      .filter(message => message.role === 'assistant')
      .map(message => chatMessageText(message))
      .join('\n')

    return new Set(sourcesFromText(assistantText).map(source => source.url))
  }, [exchange])
  const cited = useMemo(() => sources.filter(source => citedUrls.has(source.url)), [citedUrls, sources])
  const consulted = useMemo(() => sources.filter(source => !citedUrls.has(source.url)), [citedUrls, sources])
  const sourceElements = useRef(new Map<string, HTMLButtonElement>())

  useEffect(() => {
    if (!focusedSourceUrl) {
      return
    }

    const sourceElement = sourceElements.current.get(focusedSourceUrl)

    if (sourceElement) {
      sourceElement.scrollIntoView({ block: 'nearest' })
    }

    const clearFocusTimer = window.setTimeout(() => {
      if ($focusedSourceUrl.get() === focusedSourceUrl) {
        $focusedSourceUrl.set(null)
      }
    }, 1600)

    return () => window.clearTimeout(clearFocusTimer)
  }, [focusedSourceUrl, sources])

  return (
    <div className="flex min-h-0 flex-1 flex-col pt-1">
      {/* Rail header. (The Browser opener that used to live here is gone — the
          Sources | Browser segmented control above the rail already covers it,
          and two "Browser" buttons in one panel read as a bug.) */}
      <div className="flex h-7 shrink-0 items-center px-2.5">
        <span className="text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-muted-foreground/70">
          Sources
        </span>
      </div>
      {sources.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-4 text-center">
          <div className="text-[0.7rem] font-semibold uppercase tracking-[0.07em] text-muted-foreground/75">
            No sources yet
          </div>
          <div className="text-[0.68rem] leading-relaxed text-muted-foreground/65">
            Ask a research question — every paper, label, and trial the agent cites lands here.
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-4">
          {cited.length > 0 && (
            <>
              <div className="px-2 pb-1 pt-1 text-[0.6rem] font-semibold uppercase tracking-[0.09em] text-muted-foreground/60">
                Citations
              </div>
              <div className="flex flex-col gap-0.5">
                {cited.map(source => (
                  <SourceRow
                    focused={focusedSourceUrl === source.url}
                    key={source.url}
                    refCb={element => {
                      if (element) {
                        sourceElements.current.set(source.url, element)
                      } else {
                        sourceElements.current.delete(source.url)
                      }
                    }}
                    source={source}
                  />
                ))}
              </div>
            </>
          )}
          {consulted.length > 0 && (
            <>
              <div className="px-2 pb-1 pt-3 text-[0.6rem] font-semibold uppercase tracking-[0.09em] text-muted-foreground/60">
                Also consulted
              </div>
              <div className="flex flex-col gap-0.5">
                {consulted.map(source => (
                  <SourceRow
                    focused={focusedSourceUrl === source.url}
                    key={source.url}
                    refCb={element => {
                      if (element) {
                        sourceElements.current.set(source.url, element)
                      } else {
                        sourceElements.current.delete(source.url)
                      }
                    }}
                    source={source}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
