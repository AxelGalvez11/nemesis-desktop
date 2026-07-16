// Inline citation chips (student build). The engine cites in plain text —
// "(PMID: 37385280)", "PMID 39318607", "NCT04881760" — which used to render as
// raw parentheticals with receipts only at the answer's foot. linkifyCitations
// runs in the markdown preprocess step and turns those tokens into markdown
// links with short labels; MarkdownLink then renders any citation-target link
// as a compact inline chip that focuses the right-rail Sources panel.
//
// Code is never touched: fenced blocks and inline code spans are split out
// before transforming, so a PMID inside a snippet stays literal.
const PMID_RE = /\bPMIDs?:?\s*(\d{6,9})\b/gi;
const NCT_RE = /\b(NCT\d{8})\b/g;
/** Wrapping parens/brackets around a run that is ONLY citations + separators
 *  get dropped — "(PMID: 1, PMID: 2)" reads as two chips, not "(chip chip)". */
const PAREN_CITATIONS_RE = /[([]\s*((?:PMIDs?:?\s*\d{6,9}|NCT\d{8})(?:\s*[,;]\s*(?:PMIDs?:?\s*)?(?:\d{6,9}|NCT\d{8}))*)\s*[)\]]/gi;
export function pubmedUrl(pmid) {
    return `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
}
function trialUrl(nct) {
    return `https://clinicaltrials.gov/study/${nct}`;
}
function linkifySegment(segment) {
    return segment
        .replace(PAREN_CITATIONS_RE, (_match, inner) => {
        const links = [];
        for (const pmid of inner.matchAll(PMID_RE)) {
            links.push(`[PubMed](${pubmedUrl(pmid[1])})`);
        }
        for (const nct of inner.matchAll(NCT_RE)) {
            links.push(`[Trial](${trialUrl(nct[1])})`);
        }
        return links.join(' ');
    })
        .replace(PMID_RE, (_match, pmid) => `[PubMed](${pubmedUrl(pmid)})`)
        .replace(NCT_RE, (_match, nct) => `[Trial](${trialUrl(nct)})`);
}
/** Split on fenced blocks and inline code so only prose is transformed. */
const CODE_SPLIT_RE = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g;
export function linkifyCitations(text) {
    if (!/PMID|NCT\d/i.test(text)) {
        return text;
    }
    return text
        .split(CODE_SPLIT_RE)
        .map((segment, index) => (index % 2 === 1 ? segment : linkifySegment(segment)))
        .join('');
}
const CITATION_HOST_RE = /^https:\/\/(?:pubmed\.ncbi\.nlm\.nih\.gov|(?:www\.)?clinicaltrials\.gov|doi\.org)\//i;
/** True when a link target is a citation the inline chip treatment applies to. */
export function isCitationHref(href) {
    return Boolean(href && CITATION_HOST_RE.test(href));
}
