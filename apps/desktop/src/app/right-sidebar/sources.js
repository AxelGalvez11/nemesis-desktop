import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// Sources rail (student build): every citation the agent surfaces in the current chat —
// markdown links, bare URLs, PMIDs, NCT trial ids, DOIs — collected into one clickable
// list. This replaces the developer file-tree as the default right-sidebar pane: students
// ask evidence questions, so the rail should answer "where did that come from?".
import { useStore } from '@nanostores/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Codicon } from '@/components/ui/codicon';
import { chatMessageText } from '@/lib/chat-messages';
import { cn } from '@/lib/utils';
import { $messages } from '@/store/session';
import { $focusedSourceUrl } from '@/store/source-focus';
export const SOURCE_CHIP_CLASS_NAME = 'group/source inline-flex max-w-full items-center gap-1.5 rounded-full border border-border/35 bg-card/65 px-2 py-1 text-[11px] leading-none text-muted-foreground shadow-[0_1px_1px_rgb(0_0_0/0.04)] transition-[background-color,border-color,color,box-shadow,transform] duration-150 hover:-translate-y-px hover:border-border/70 hover:bg-card hover:text-foreground hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--theme-primary)/35';
const MD_LINK = /\[([^\]\n]{1,160})\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_URL = /https?:\/\/[^\s<>"'()[\]{}]+/g;
const PMID_RE = /\bPMID:?\s*(\d{6,9})\b/gi;
const NCT_RE = /\bNCT\d{8}\b/gi;
const DOI_RE = /\b10\.\d{4,9}\/[^\s<>"'()[\]{}]+/g;
function cleanUrl(raw) {
    return raw.replace(/[.,;:!?]+$/, '');
}
function badgeFor(hostname) {
    const host = hostname.replace(/^www\./, '');
    if (host.includes('pubmed.ncbi')) {
        return 'PubMed';
    }
    if (host.includes('ncbi.nlm.nih.gov') || host.includes('pmc.ncbi')) {
        return 'NCBI';
    }
    if (host.endsWith('fda.gov')) {
        return 'FDA';
    }
    if (host.includes('clinicaltrials.gov')) {
        return 'Trial';
    }
    if (host === 'doi.org') {
        return 'DOI';
    }
    if (host.endsWith('who.int')) {
        return 'WHO';
    }
    if (host.endsWith('cdc.gov')) {
        return 'CDC';
    }
    if (host.endsWith('nih.gov')) {
        return 'NIH';
    }
    if (host.includes('cochrane')) {
        return 'Cochrane';
    }
    return 'Web';
}
// Tool traffic only counts when it hits a known evidence host — the agent consulting
// PubMed/FDA/ClinicalTrials is a source; a random search-result URL is noise.
const EVIDENCE_HOSTS = ['ncbi.nlm.nih.gov', 'fda.gov', 'clinicaltrials.gov', 'doi.org', 'who.int', 'cdc.gov', 'nih.gov'];
function isEvidenceHost(hostname) {
    const host = hostname.replace(/^www\./, '');
    return EVIDENCE_HOSTS.some(candidate => host === candidate || host.endsWith(`.${candidate}`));
}
/** Text-level citations: markdown links, bare URLs, PMIDs, NCT ids, DOIs. */
function harvestText(text, sink) {
    // Markdown links first (they carry real titles), then scan the remainder so the
    // same URL isn't double-counted as a bare match.
    for (const match of text.matchAll(MD_LINK)) {
        sink.push(match[2], match[1]);
    }
    const stripped = text.replace(MD_LINK, ' ');
    for (const match of stripped.matchAll(BARE_URL)) {
        sink.push(match[0]);
    }
    for (const match of stripped.matchAll(PMID_RE)) {
        sink.push(`https://pubmed.ncbi.nlm.nih.gov/${match[1]}/`, `PMID ${match[1]}`);
    }
    for (const match of stripped.matchAll(NCT_RE)) {
        sink.push(`https://clinicaltrials.gov/study/${match[0].toUpperCase()}`, match[0].toUpperCase());
    }
    for (const match of stripped.matchAll(DOI_RE)) {
        sink.push(`https://doi.org/${cleanUrl(match[0])}`, `DOI ${cleanUrl(match[0])}`);
    }
}
function makeSink() {
    const seen = new Set();
    const out = [];
    const push = (rawUrl, title) => {
        const url = cleanUrl(rawUrl);
        let parsed;
        try {
            parsed = new URL(url);
        }
        catch {
            return;
        }
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
            return;
        }
        // openFDA stamps terms/license/disclaimer links into every response — boilerplate,
        // not sources.
        if (/^open\.fda\.gov$/i.test(parsed.hostname) && /terms|license|disclaimer/i.test(parsed.pathname)) {
            return;
        }
        const key = url.replace(/\/+$/, '').toLowerCase();
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        const domain = parsed.hostname.replace(/^www\./, '');
        // API lookups label better by WHAT was searched than by their endpoint path.
        const query = parsed.searchParams.get('term') || parsed.searchParams.get('search') || parsed.searchParams.get('query');
        const fallback = query
            ? `${domain} — “${decodeURIComponent(query).replace(/\+/g, ' ').slice(0, 40)}”`
            : `${domain}${parsed.pathname.length > 1 ? decodeURIComponent(parsed.pathname).slice(0, 60) : ''}`;
        out.push({ badge: badgeFor(parsed.hostname), domain, title: (title || fallback).trim(), url });
    };
    return { out, sink: { push } };
}
/** Citations named in a single blob of answer text. Pure — feeds the inline pills. */
export function sourcesFromText(text) {
    const { out, sink } = makeSink();
    harvestText(text, sink);
    return out.slice(0, 24);
}
/** Pull every citation out of the assistant's messages (plus evidence-host URLs from the
 *  agent's tool traffic), deduped, in reading order. Pure. */
export function extractSources(messages) {
    const { out, sink } = makeSink();
    for (const message of messages) {
        // Deep-scan every message's raw payload — tool calls and their results ride INSIDE
        // the assistant message in this app — keeping only evidence-host URLs (a PubMed/FDA/
        // trials lookup is a source; a random search-result URL is noise).
        let raw = '';
        try {
            raw = JSON.stringify(message).slice(0, 300_000);
        }
        catch {
            raw = '';
        }
        if (raw) {
            for (const match of raw.replace(/\\\//g, '/').matchAll(BARE_URL)) {
                const candidate = cleanUrl(match[0].replace(/\\+$/, ''));
                try {
                    if (isEvidenceHost(new URL(candidate).hostname)) {
                        sink.push(candidate);
                    }
                }
                catch {
                    // not a parseable URL — skip
                }
            }
        }
        if (message.role !== 'assistant') {
            continue;
        }
        let text = '';
        try {
            text = chatMessageText(message);
        }
        catch {
            continue;
        }
        if (text) {
            harvestText(text, sink);
        }
    }
    return out.slice(0, 100);
}
/** Site icon for a pill — the domain's own favicon, falling back to a letter badge
 *  (api subdomains and offline mode often have no icon to fetch). */
export function SourceFavicon({ domain }) {
    const [failed, setFailed] = useState(false);
    if (failed) {
        return (_jsx("span", { className: "grid size-4 shrink-0 place-items-center rounded-sm bg-(--theme-primary)/15 text-[9px] font-bold text-(--theme-primary)", children: domain.charAt(0).toUpperCase() }));
    }
    return (_jsx("img", { alt: "", className: "size-4 shrink-0 rounded-sm", loading: "lazy", onError: () => setFailed(true), src: `https://${domain}/favicon.ico` }));
}
export function SourcesTab() {
    const messages = useStore($messages);
    const focusedSourceUrl = useStore($focusedSourceUrl);
    const sources = useMemo(() => extractSources(messages), [messages]);
    const sourceElements = useRef(new Map());
    useEffect(() => {
        if (!focusedSourceUrl) {
            return;
        }
        const sourceElement = sourceElements.current.get(focusedSourceUrl);
        if (sourceElement) {
            sourceElement.scrollIntoView({ block: 'nearest' });
        }
        const clearFocusTimer = window.setTimeout(() => {
            if ($focusedSourceUrl.get() === focusedSourceUrl) {
                $focusedSourceUrl.set(null);
            }
        }, 1600);
        return () => window.clearTimeout(clearFocusTimer);
    }, [focusedSourceUrl, sources]);
    const openExternal = (url) => {
        void window.hermesDesktop?.openExternal?.(url);
    };
    return (_jsxs("div", { className: "flex min-h-0 flex-1 flex-col pt-1", children: [_jsx("div", { className: "flex h-7 shrink-0 items-center px-2.5", children: _jsx("span", { className: "text-[0.65rem] font-semibold uppercase tracking-[0.09em] text-muted-foreground/70", children: "Sources" }) }), sources.length === 0 ? (_jsxs("div", { className: "flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-4 text-center", children: [_jsx("div", { className: "text-[0.7rem] font-semibold uppercase tracking-[0.07em] text-muted-foreground/75", children: "No sources yet" }), _jsx("div", { className: "text-[0.68rem] leading-relaxed text-muted-foreground/65", children: "Ask a research question \u2014 every paper, label, and trial the agent cites lands here." })] })) : (_jsx("div", { className: "min-h-0 flex-1 overflow-y-auto px-2.5 pb-4", children: _jsx("div", { className: "flex flex-wrap gap-1.5", children: sources.map(source => (_jsxs("button", { className: cn(SOURCE_CHIP_CLASS_NAME, focusedSourceUrl === source.url &&
                            'bg-card text-foreground ring-2 ring-(--theme-primary)/70 ring-offset-1 ring-offset-background'), onClick: () => openExternal(source.url), ref: element => {
                            if (element) {
                                sourceElements.current.set(source.url, element);
                            }
                            else {
                                sourceElements.current.delete(source.url);
                            }
                        }, title: `${source.title}\n${source.url}`, type: "button", children: [_jsx(SourceFavicon, { domain: source.domain }), _jsx("span", { className: "max-w-[8.5rem] truncate text-foreground/80", children: source.title }), _jsx("span", { className: "shrink-0 text-[9px] font-medium uppercase tracking-wide text-muted-foreground/55", children: source.badge }), _jsx(Codicon, { className: "ml-0.5 shrink-0 opacity-0 transition-opacity group-hover/source:opacity-60 group-focus-visible/source:opacity-60", name: "link-external", size: "0.625rem" })] }, source.url))) }) }))] }));
}
