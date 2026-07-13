// Library vault: plain Markdown files in ~/Documents/Nemesis Library, read and written
// through the existing hardened fs IPC (window.hermesDesktop) — Obsidian-compatible by
// construction (a student can point Obsidian at the same folder). Wiki-links use the
// Obsidian syntax family: [[Title]], [[Title|alias]], [[Title#heading]].
// The link index built here also feeds the Graph page (node = note, edge = wikilink).
export const VAULT_DIR = '~/Documents/Nemesis Library';
function fileKind(name) {
    const ext = name.toLowerCase().split('.').pop() ?? '';
    if (ext === 'pdf')
        return 'pdf';
    if (ext === 'html' || ext === 'htm')
        return 'html';
    if (ext === 'pptx' || ext === 'ppt' || ext === 'key')
        return 'slides';
    if (ext === 'docx' || ext === 'doc' || ext === 'pages')
        return 'doc';
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext))
        return 'image';
    return null;
}
const WIKILINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
/** Extract raw wikilink targets from markdown (deduped, order kept). */
export function extractWikilinks(markdown) {
    const seen = new Set();
    const targets = [];
    for (const match of markdown.matchAll(WIKILINK)) {
        const target = match[1].trim();
        if (target && !seen.has(target.toLowerCase())) {
            seen.add(target.toLowerCase());
            targets.push(target);
        }
    }
    return targets;
}
const MD_LINK = /\[[^\]]*\]\(([^)]+)\)/g;
/** Extract relative ".md" link targets ("[label](Note.md)" / "[label](folder/Note.md)")
 *  from markdown, as bare titles (matches VaultNote.title — the same key wikilinks
 *  resolve by). Absolute URLs, mailto/tel links, and protocol-relative links are skipped;
 *  only vault-relative markdown links count as a note-to-note connection. */
export function extractRelativeMdLinks(markdown) {
    const seen = new Set();
    const targets = [];
    for (const match of markdown.matchAll(MD_LINK)) {
        const raw = match[1].trim().split('#')[0];
        if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) {
            continue; // absolute URL / mailto: / protocol-relative — not a vault note
        }
        if (!raw.toLowerCase().endsWith('.md')) {
            continue;
        }
        const fileName = raw.split('/').pop() ?? '';
        let target = fileName.replace(/\.md$/i, '');
        try {
            target = decodeURIComponent(target);
        }
        catch {
            // Malformed percent-escape — fall back to the raw text.
        }
        if (target && !seen.has(target.toLowerCase())) {
            seen.add(target.toLowerCase());
            targets.push(target);
        }
    }
    return targets;
}
const ATX_HEADING = /^(#{1,3})\s+(.+?)\s*#*\s*$/;
const FENCE = /^(`{3,}|~{3,})/;
/** Table of contents: h1–h3 ATX headings ("# ", "## ", "### ") in document order.
 *  Headings inside fenced code blocks don't count (a Python "# comment" isn't a section). */
export function extractHeadings(markdown) {
    const headings = [];
    let fenceChar = null;
    markdown.split('\n').forEach((raw, index) => {
        const fence = FENCE.exec(raw.trim());
        if (fence) {
            fenceChar = fenceChar === fence[1][0] ? null : (fenceChar ?? fence[1][0]);
            return;
        }
        if (fenceChar) {
            return;
        }
        const match = ATX_HEADING.exec(raw);
        if (match) {
            headings.push({ level: match[1].length, line: index + 1, text: match[2].trim() });
        }
    });
    return headings;
}
/** Build the link/backlink index. Pure. Links come from both [[wikilinks]] and
 *  relative ".md" markdown links; backlinks are simply the reverse of that graph. */
export function buildIndex(notes) {
    const byLower = new Map(notes.map(note => [note.title.toLowerCase(), note.title]));
    const links = new Map();
    const backlinks = new Map(notes.map(note => [note.title, []]));
    for (const note of notes) {
        const rawTargets = [...extractWikilinks(note.content), ...extractRelativeMdLinks(note.content)];
        const seen = new Set();
        const resolved = [];
        for (const raw of rawTargets) {
            const title = byLower.get(raw.toLowerCase());
            if (title && title !== note.title && !seen.has(title)) {
                seen.add(title);
                resolved.push(title);
            }
        }
        links.set(note.title, resolved);
        for (const target of resolved) {
            backlinks.get(target)?.push(note.title);
        }
    }
    return { backlinks, links, notes };
}
function bridge() {
    const api = window.hermesDesktop;
    if (!api?.readDir || !api.readFileText || !api.writeTextFile) {
        throw new Error('File access is unavailable in this build.');
    }
    return api;
}
const MAX_DEPTH = 5;
async function walk(api, dirPath, rel, depth, out) {
    if (depth > MAX_DEPTH) {
        return;
    }
    const dir = await api.readDir(dirPath);
    if (dir.error) {
        return;
    }
    for (const entry of dir.entries) {
        const folderRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory) {
            out.folders.push(folderRel);
            await walk(api, entry.path, folderRel, depth + 1, out);
        }
        else if (entry.name.toLowerCase().endsWith('.md')) {
            const read = await api.readFileText(entry.path);
            out.notes.push({ content: read.text ?? '', folder: rel, path: entry.path, title: entry.name.replace(/\.md$/i, '') });
        }
        else {
            const kind = fileKind(entry.name);
            if (kind) {
                out.files.push({ folder: rel, kind, name: entry.name, path: entry.path });
            }
        }
    }
}
/** Recursively load notes, previewable files, and folders from the vault. */
export async function loadVaultContents() {
    const api = bridge();
    const out = { files: [], folders: [], notes: [] };
    await walk(api, VAULT_DIR, '', 0, out);
    out.notes.sort((a, b) => a.title.localeCompare(b.title));
    return out;
}
/** Notes-only (recursive) — the Graph page and backlink index consume this. */
export async function loadVault() {
    return (await loadVaultContents()).notes;
}
/** Notes directly inside one vault folder (non-recursive, no PDF/image scan) — cheaper
 *  than loadVaultContents() when a caller only needs one folder, e.g. the Recorder
 *  matching saved recordings back to their auto-saved Lectures notes. */
export async function loadFolderNotes(folder) {
    const api = bridge();
    const dirPath = folder ? `${VAULT_DIR}/${folder}` : VAULT_DIR;
    const dir = await api.readDir(dirPath);
    if (dir.error) {
        return [];
    }
    const reads = dir.entries
        .filter(entry => !entry.isDirectory && entry.name.toLowerCase().endsWith('.md'))
        .map(async (entry) => {
        const read = await api.readFileText(entry.path);
        return { content: read.text ?? '', folder, path: entry.path, title: entry.name.replace(/\.md$/i, '') };
    });
    return Promise.all(reads);
}
export async function saveNote(title, content, folder = '') {
    const api = bridge();
    const safe = title.replace(/[/\\:]/g, '-').trim() || 'Untitled';
    const prefix = folder ? `${VAULT_DIR}/${folder}` : VAULT_DIR;
    const result = await api.writeTextFile(`${prefix}/${safe}.md`, content);
    return result.path;
}
/** Create a folder in the vault (via the mkdir IPC). Returns silently if unsupported. */
export async function createFolder(folder) {
    const safe = folder.replace(/[\\:]/g, '-').replace(/^\/+|\/+$/g, '').trim();
    if (!safe) {
        return;
    }
    await window.hermesDesktop?.makeDir?.(`${VAULT_DIR}/${safe}`);
}
/** First-run seed: linked pharm notes so the Library (and Graph) teach themselves. */
export const SEED_NOTES = [
    {
        title: 'ACE inhibitors',
        content: '# ACE inhibitors\n\nLisinopril, enalapril. Block angiotensin I → II; raise bradykinin.\n\n- **Dry cough** — bradykinin buildup; switch to [[ARBs]] if intolerable.\n- **Angioedema** — rare, serious; stop immediately.\n- Contraindicated in pregnancy (fetal renal toxicity) — like all RAAS blockers.\n- Monitor potassium + creatinine after starting (see [[Hyperkalemia]]).\n\nOften paired with [[Diuretics]] in [[Heart failure]].\n'
    },
    {
        title: 'ARBs',
        content: '# ARBs\n\nLosartan, valsartan. Block the AT1 receptor directly — same RAAS effect as [[ACE inhibitors]] but bradykinin is untouched, so no cough.\n\n- Same pregnancy contraindication and [[Hyperkalemia]] risk.\n- First swap when an ACE-inhibitor cough is intolerable.\n'
    },
    {
        title: 'Diuretics',
        content: '# Diuretics\n\n- **Furosemide** (loop): thick ascending limb, potent; hypokalemia + hypOcalcemia.\n- **HCTZ** (thiazide): distal tubule, milder; hypokalemia + hypERcalcemia.\n- **Spironolactone**: aldosterone antagonist — potassium-sparing; watch [[Hyperkalemia]] with [[ACE inhibitors]].\n\nCore of congestion control in [[Heart failure]].\n'
    },
    {
        title: 'Heart failure',
        content: '# Heart failure\n\nGuideline-directed therapy touches almost every cardio class:\n\n1. [[ACE inhibitors]] or [[ARBs]] (or ARNI)\n2. Beta blocker (bisoprolol, carvedilol, metoprolol succinate)\n3. [[Diuretics]] for congestion\n4. Spironolactone — mind [[Hyperkalemia]]\n'
    },
    {
        title: 'Hyperkalemia',
        content: '# Hyperkalemia\n\nK⁺ > 5.0-5.5. Drug causes to know cold:\n\n- [[ACE inhibitors]] / [[ARBs]] (less aldosterone)\n- Spironolactone (see [[Diuretics]])\n- TMP-SMX, NSAIDs\n\nThe classic exam combo: ACE inhibitor + spironolactone in [[Heart failure]].\n'
    },
    {
        title: 'Warfarin interactions',
        content: '# Warfarin interactions\n\nNarrow index; INR moves with CYP2C9.\n\n- TMP-SMX → INR **up** (2C9 inhibition + protein-binding displacement).\n- Rifampin → INR **down** (induction).\n- Amiodarone → INR **up**.\n\nNot RAAS-linked, but shares the "monitor potassium/INR after any change" reflex from [[ACE inhibitors]].\n'
    }
];
