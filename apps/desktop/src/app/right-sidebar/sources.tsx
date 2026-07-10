// Sources rail (student build): every citation the agent surfaces in the current chat —
// markdown links, bare URLs, PMIDs, NCT trial ids, DOIs — collected into one clickable
// list. This replaces the developer file-tree as the default right-sidebar pane: students
// ask evidence questions, so the rail should answer "where did that come from?".
import { useStore } from '@nanostores/react'
import { useMemo, useState } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { type ChatMessage, chatMessageText } from '@/lib/chat-messages'
import { openBrowserRail } from '@/store/browser-rail'
import { $messages } from '@/store/session'

export interface SourceRef {
  url: string
  title: string
  badge: string
  domain: string
}

const MD_LINK = /\[([^\]\n]{1,160})\]\((https?:\/\/[^\s)]+)\)/g
const BARE_URL = /https?:\/\/[^\s<>"'()[\]{}]+/g
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
    const query = parsed.searchParams.get('term') || parsed.searchParams.get('search') || parsed.searchParams.get('query')
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

export function SourcesTab() {
  const messages = useStore($messages)
  const sources = useMemo(() => extractSources(messages), [messages])

  const openExternal = (url: string) => {
    void window.hermesDesktop?.openExternal?.(url)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col pt-1">
      {/* Rail header: the label + the agent-browser opener (the live mirror
          where school-portal logins are typed). */}
      <div className="flex h-7 shrink-0 items-center justify-between px-2.5">
        <span className="text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-muted-foreground/70">
          Sources
        </span>
        <button
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[0.65rem] font-medium text-muted-foreground transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground"
          onClick={() => openBrowserRail()}
          title="Watch and steer the agent's browser"
          type="button"
        >
          <Codicon name="globe" size="0.7rem" />
          Browser
        </button>
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
        <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-4">
          <div className="flex flex-wrap gap-1.5">
            {sources.map(source => (
              <button
                className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-card px-2 py-1 text-[11px] text-foreground/85 transition-colors hover:border-(--theme-primary) hover:text-foreground"
                key={source.url}
                onClick={() => openExternal(source.url)}
                title={`${source.title}\n${source.url}`}
                type="button"
              >
                <SourceFavicon domain={source.domain} />
                <span className="font-semibold uppercase tracking-wide text-[10px] text-(--theme-primary)">
                  {source.badge}
                </span>
                <span className="max-w-[8.5rem] truncate text-muted-foreground">{source.title}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
