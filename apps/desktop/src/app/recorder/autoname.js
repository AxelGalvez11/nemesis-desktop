// Auto-naming for recordings — derives a human title from the on-device live
// transcript so the archive reads "Vancomycin & Nephrotoxicity — Jul 11" instead of
// "Lecture 11 Jul 2026 8.15 PM". Fully local and deterministic: pharm-lexicon terms
// ranked by how often they were said, falling back to the lecture's opening topic
// phrase. Returns null when the transcript is too thin to name confidently, so
// callers keep their timestamp default. Never called when the student typed their
// own title (see `titleEdited` in service.ts).
import { detectPharmTerms } from './pharm-lexicon';
/** Below this much transcript, any derived name is a guess — keep the default. */
const MIN_TRANSCRIPT_CHARS = 120;
const MAX_TITLE_CHARS = 48;
/** Spoken lecture lead-ins ("okay so today we're going to talk about…") that carry
 *  no topic signal. Stripped repeatedly from the front of the opening sentence. */
const LEAD_IN_RE = /^(?:okay|ok|so|um|uh|alright|all right|right|welcome(?: back)?|good (?:morning|afternoon|evening)|hi|hello|everyone|everybody|guys|class|today|now|next|first|let's|lets|we're|we are|we'll|we will|i'm|i am|going to|gonna|to talk about|talk about|talking about|to cover|cover|covering|to discuss|discuss|discussing|start with|starting|continue with|continuing|to look at|look at|looking at|move on to|get started(?: with)?|pick up(?: where we left off)?)[,.!;:\s]+/i;
const TRAILING_STOPWORDS = new Set([
    'a',
    'an',
    'and',
    'as',
    'at',
    'but',
    'by',
    'for',
    'from',
    'in',
    'into',
    'is',
    'its',
    'of',
    'on',
    'or',
    'our',
    'that',
    'the',
    'their',
    'this',
    'to',
    'with',
    'your'
]);
function escapeRegExp(raw) {
    return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function titleCaseTerm(term) {
    return term
        .split(/([ -])/)
        .map(part => (part === ' ' || part === '-' ? part : part.charAt(0).toUpperCase() + part.slice(1)))
        .join('');
}
/** Note titles become Library file names — keep them filesystem- and wikilink-safe. */
function sanitizeTitle(raw) {
    return raw
        .replace(/[\\/:*?"<>|[\]#^]/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/[ .,;]+$/, '')
        .trim();
}
/** Lexicon terms actually said, most-mentioned first (ties: longer term wins —
 *  "hydrochlorothiazide" beats "aspirin" as the lecture's subject). */
function rankPharmTerms(transcript) {
    return detectPharmTerms(transcript)
        .map(term => ({
        count: (transcript.match(new RegExp(`\\b${escapeRegExp(term)}\\b`, 'gi')) ?? []).length,
        term
    }))
        .sort((a, b) => b.count - a.count || b.term.length - a.term.length)
        .map(entry => entry.term);
}
/** The lecture's opening topic: first sentence, spoken lead-ins stripped, clipped to
 *  a few words with dangling stopwords removed. Null when nothing meaningful is left. */
function topicPhrase(transcript) {
    let opening = transcript;
    for (let pass = 0; pass < 10; pass++) {
        const stripped = opening.replace(LEAD_IN_RE, '');
        if (stripped === opening) {
            break;
        }
        opening = stripped;
    }
    const sentenceEnd = opening.search(/[.!?]/);
    const sentence = sentenceEnd === -1 ? opening : opening.slice(0, sentenceEnd);
    const words = sentence.split(/\s+/).filter(Boolean).slice(0, 7);
    while (words.length > 0 && TRAILING_STOPWORDS.has(words[words.length - 1].toLowerCase().replace(/[^a-z']/g, ''))) {
        words.pop();
    }
    if (words.length < 3) {
        return null;
    }
    let phrase = words.join(' ');
    if (phrase.length > MAX_TITLE_CHARS) {
        phrase = phrase.slice(0, MAX_TITLE_CHARS).replace(/\s+\S*$/, '');
    }
    phrase = phrase.charAt(0).toUpperCase() + phrase.slice(1);
    return phrase.length >= 12 ? phrase : null;
}
/** "Vancomycin & Nephrotoxicity — Jul 11" | "Renal clearance and dosing — Jul 11" | null. */
export function deriveRecordingTitle(transcript, at) {
    const clean = transcript.replace(/\s+/g, ' ').trim();
    if (clean.length < MIN_TRANSCRIPT_CHARS) {
        return null;
    }
    const dateTag = at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const terms = rankPharmTerms(clean);
    if (terms.length > 0) {
        const lead = terms.slice(0, 2).map(titleCaseTerm).join(' & ');
        return sanitizeTitle(`${lead} — ${dateTag}`);
    }
    const topic = topicPhrase(clean);
    return topic ? sanitizeTitle(`${topic} — ${dateTag}`) : null;
}
