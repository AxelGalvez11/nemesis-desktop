// Path remapping after a rename — used to keep open tabs and visit history pointed at the
// right note/file/folder once its absolute path changes on disk. Pure and generic (works on
// plain path strings) so it covers both a single note's rename (exact match) and a folder's
// rename (every path nested underneath shifts too).

function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}

/** True when `path` IS `root`, or nested underneath it — the same test that decides whether
 *  a rename/delete of `root` should affect an open tab at `path`. */
export function isPathWithin(path: string, root: string): boolean {
  return isWithin(path, root)
}

/** If `path` is `oldPath` or nested underneath it, return the corresponding path under
 *  `newPath`; otherwise null (this path is unaffected by the rename). */
export function remappedPath(path: string, oldPath: string, newPath: string): string | null {
  if (!isWithin(path, oldPath)) {
    return null
  }

  return newPath + path.slice(oldPath.length)
}
