// Resolving markdown image references to a usable <img src> — for both standard
// `![alt](path)` (resolved relative to the editing note's own folder, the CommonMark
// convention) and Obsidian's `![[image.png]]` embed (resolved by filename across the whole
// vault, the way Obsidian itself does it). Both exported resolvers return a ready-to-use src
// string (already file:// wrapped where needed, matching the convention FilePreview's
// standalone image tab already uses) or null when nothing resolves — never a bare path the
// caller has to remember to wrap itself.
/** Convert an absolute filesystem path to a `file://` URL — the same convention
 *  FilePreview's standalone image tab already uses (index.tsx's fileUrl). */
export function toFileUrl(path) {
    return `file://${encodeURI(path).replace(/#/g, '%23')}`;
}
/** Join `base` and `relative` as POSIX-style vault paths, resolving "." and ".." segments —
 *  a tiny hand-rolled stand-in for `path.join`/`path.resolve`, since the renderer has no
 *  Node `path` module (all filesystem access goes through the hardened IPC bridge). */
function joinVaultPath(base, relative) {
    const out = [];
    for (const part of `${base}/${relative}`.split('/')) {
        if (part === '' || part === '.') {
            continue;
        }
        if (part === '..') {
            out.pop();
            continue;
        }
        out.push(part);
    }
    return `/${out.join('/')}`;
}
function isAbsoluteUrl(target) {
    return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//');
}
/** Resolve a standard `![alt](path)` target to a src usable in an <img> tag. Already-absolute
 *  URLs (http:, https:, data:, etc.) pass through unchanged; a plain OS path (leading "/") or
 *  a genuinely relative path (joined against the note's own folder) both get file:// wrapped. */
export function resolveRelativeImageSrc(rawPath, noteFolder, vaultDir) {
    const target = rawPath.trim();
    if (isAbsoluteUrl(target)) {
        return target;
    }
    if (target.startsWith('/')) {
        return toFileUrl(target);
    }
    const base = noteFolder ? `${vaultDir}/${noteFolder}` : vaultDir;
    return toFileUrl(joinVaultPath(base, target));
}
/** Resolve an Obsidian `![[filename]]` embed to a src, by searching the vault's file list for
 *  a case-insensitive name match — null if nothing matches. Obsidian resolves these
 *  vault-wide (not folder-relative), so this needs the full file list rather than just the
 *  note's own folder. */
export function resolveEmbeddedImageSrc(rawName, files) {
    const wanted = rawName.trim().toLowerCase();
    if (!wanted) {
        return null;
    }
    const match = files.find(file => file.name.toLowerCase() === wanted);
    return match ? toFileUrl(match.path) : null;
}
