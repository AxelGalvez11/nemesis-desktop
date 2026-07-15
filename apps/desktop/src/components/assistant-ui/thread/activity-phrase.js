// Live activity phrase (student build). While a turn runs, the ActivityStrip shows
// ONE human line describing what the agent is doing right now — "Searching PubMed
// for 'tesamorelin'…", "Writing Renal dosing.md…" — the way ChatGPT/Claude narrate
// work, instead of a generic spinner or a raw tool trail. This module is pure
// (no imports, no store reads) so the whole mapping is unit-testable:
// message parts in → phrase out.
export const ACTIVITY_FALLBACK_PHRASE = 'Working…';
/** Search queries stay short enough to scan at a glance (ellipsis included). */
const MAX_QUERY_CHARS = 40;
/** Reasoning previews get roughly a line — the trailing ellipsis rides on top. */
const MAX_REASONING_CHARS = 90;
const FILE_EDIT_TOOLS = new Set(['edit_file', 'patch', 'write_file']);
const TERMINAL_TOOLS = new Set(['bash', 'execute_code', 'shell', 'terminal']);
/** Skill loads that map to a named student-facing activity. Anything else the
 *  agent reads via skill_view is plumbing, so it falls back to "Working…". */
const SKILL_PHRASES = {
    'nemesis-deliverables': 'Assembling your slides…',
    'nemesis-organize': 'Tidying your library…',
    'nemesis-study-decks': 'Building your flashcard deck…',
    'school-portal': 'Checking your school portal…'
};
function isRecord(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
/** Tool args are usually already an object, but tolerate a JSON string (some
 *  runtimes hand the raw args text through while a call streams). */
function argsRecord(args) {
    if (isRecord(args)) {
        return args;
    }
    if (typeof args === 'string' && args.trim()) {
        try {
            const parsed = JSON.parse(args);
            return isRecord(parsed) ? parsed : {};
        }
        catch {
            return {};
        }
    }
    return {};
}
function firstString(record, keys) {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }
    return '';
}
/** Collapse to one line and cap at `max` characters, preferring a word
 *  boundary. The ellipsis is only added when something was actually cut. */
function truncate(value, max) {
    const line = value.replace(/\s+/g, ' ').trim();
    if (line.length <= max) {
        return line;
    }
    const hardCut = line.slice(0, max - 1);
    const lastSpace = hardCut.lastIndexOf(' ');
    const cut = lastSpace > max * 0.6 ? hardCut.slice(0, lastSpace) : hardCut;
    return `${cut.trimEnd()}…`;
}
/** Bare hostname ("blackboard.example-university.edu") — no scheme, no path, no www. */
function hostnameOnly(value) {
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
    try {
        const host = new URL(candidate).hostname.replace(/^www\./i, '');
        // "back"/"forward" history moves and localhost parse into dot-less hosts;
        // those aren't a destination worth naming.
        return host.includes('.') ? host : '';
    }
    catch {
        return '';
    }
}
/** Human name of the evidence source a search-ish tool queries, or '' when the
 *  tool doesn't target one we recognize. */
function searchSource(toolName) {
    if (toolName.includes('pubmed')) {
        return 'PubMed';
    }
    if (toolName.includes('trials')) {
        return 'ClinicalTrials.gov';
    }
    if (toolName.includes('fda')) {
        return 'openFDA';
    }
    if (toolName.includes('web')) {
        return 'the web';
    }
    return '';
}
/** Ordered [pattern, phrase] pairs — first match names the shell command's purpose.
 *  Patterns test the lowercased command line; keep them specific enough that a
 *  mismatch falls through to the generic line rather than mislabeling. */
const TERMINAL_ACTIVITIES = [
    [/osascript[\s\S]*?\bmail\b/, 'Reading your inbox…'],
    [/osascript[\s\S]*?\bcalendar\b/, 'Checking your calendar…'],
    [/pubmed|eutils|ncbi/, 'Searching PubMed…'],
    [/clinicaltrials/, 'Searching ClinicalTrials.gov…'],
    [/openfda|fda\.gov/, 'Checking openFDA…'],
    [/pptx|marp|pandoc|reveal/, 'Building your slides…'],
    [/\.apkg|anki/, 'Working on your flashcards…'],
    [/pdftotext|pdfinfo|\bocr\b/, 'Reading a PDF…'],
    [/ffmpeg|sherpa|whisper/, 'Processing audio…'],
    [/pip3? install|npm install|brew install/, 'Setting up tools…']
];
function terminalPhrase(args) {
    const command = firstString(args, ['command', 'cmd', 'script', 'code']).toLowerCase();
    for (const [pattern, phrase] of TERMINAL_ACTIVITIES) {
        if (pattern.test(command)) {
            return phrase;
        }
    }
    return 'Running a command…';
}
function browserPhrase(args) {
    const target = firstString(args, ['url', 'target']);
    const host = target ? hostnameOnly(target) : '';
    return host ? `Browsing ${host}…` : 'Browsing…';
}
function searchPhrase(source, args) {
    const query = firstString(args, ['query', 'search_term', 'term', 'q']);
    if (!query) {
        return `Searching ${source}…`;
    }
    return `Searching ${source} for '${truncate(query, MAX_QUERY_CHARS)}'…`;
}
function fileEditPhrase(args) {
    const path = firstString(args, ['path', 'file', 'filepath']);
    const basename = path.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
    return basename ? `Writing ${basename}…` : 'Writing a file…';
}
function skillPhrase(args) {
    const raw = firstString(args, ['name']);
    // Plugin-qualified skills arrive as "plugin:skill" — the tail is the skill.
    const name = raw.split(':').pop()?.trim().toLowerCase() || '';
    return SKILL_PHRASES[name] || ACTIVITY_FALLBACK_PHRASE;
}
function reasoningPhrase(text) {
    // The first sentence lives near the start; bound the cleanup so streaming a
    // long thought doesn't re-scan the whole text on every token flush.
    const cleaned = text
        .slice(0, 600)
        .replace(/```[\s\S]*?(```|$)/g, ' ')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/^>\s?/gm, '')
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
        .replace(/\*+/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
    if (!cleaned) {
        return ACTIVITY_FALLBACK_PHRASE;
    }
    const sentence = (cleaned.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? cleaned).replace(/[\s.!?:;,]+$/, '');
    if (!sentence) {
        return ACTIVITY_FALLBACK_PHRASE;
    }
    const line = truncate(sentence, MAX_REASONING_CHARS);
    // Every live phrase trails off — a finished-looking sentence reads as done.
    return line.endsWith('…') ? line : `${line}…`;
}
/**
 * Map the CURRENT tool call / agent event to a one-line human phrase.
 * Unknown events deliberately say "Working…" rather than leak tool internals.
 */
export function phraseForActivity(event) {
    if (!event) {
        return ACTIVITY_FALLBACK_PHRASE;
    }
    if (event.type === 'reasoning') {
        return reasoningPhrase(event.text);
    }
    const toolName = (event.toolName || '').toLowerCase();
    const args = argsRecord(event.args);
    if (toolName === 'skill_view') {
        return skillPhrase(args);
    }
    if (FILE_EDIT_TOOLS.has(toolName)) {
        return fileEditPhrase(args);
    }
    // Never echo the raw command — a shell line is noise (or worse) to a student —
    // but DO classify it into a named activity when the command's purpose is clear.
    if (TERMINAL_TOOLS.has(toolName)) {
        return terminalPhrase(args);
    }
    if (toolName === 'browser' || toolName.startsWith('browser_')) {
        return browserPhrase(args);
    }
    const source = searchSource(toolName);
    if (source && /search|query|find|lookup/.test(toolName)) {
        return searchPhrase(source, args);
    }
    return ACTIVITY_FALLBACK_PHRASE;
}
/**
 * Pick the event the phrase should describe: the newest part that is a tool
 * call or reasoning text. Returns null once visible answer text is streaming
 * (the answer itself is the status then) or when there is nothing to say.
 */
export function currentActivityEvent(parts) {
    for (let index = parts.length - 1; index >= 0; index -= 1) {
        const part = parts[index];
        if (!isRecord(part)) {
            continue;
        }
        if (part.type === 'text') {
            if (typeof part.text === 'string' && part.text.trim()) {
                return null;
            }
            continue;
        }
        if (part.type === 'tool-call') {
            // Completed tools keep their phrase during the gap before the next step,
            // so the line doesn't flash back to "Working…" between calls.
            return {
                args: part.args,
                toolName: typeof part.toolName === 'string' ? part.toolName : '',
                type: 'tool-call'
            };
        }
        if (part.type === 'reasoning' && typeof part.text === 'string' && part.text.trim()) {
            return { text: part.text, type: 'reasoning' };
        }
    }
    return null;
}
