import { useEffect } from 'react'

import { VAULT_DIR } from '@/app/library/vault'
import { normalizeOrLocalPreviewTarget } from '@/lib/local-preview'
import { NEMESIS_STUDENT_BUILD } from '@/nemesis'
import { setCurrentSessionPreviewTarget } from '@/store/preview'

// The agent writes deliverables (slide decks, reports) into the Library's
// Exports folder as self-contained HTML. The chat's `[Preview:](#preview/…)`
// token opens them instantly — but only when the model actually emits the
// token. This watcher is the deterministic backstop: any NEW .html landing in
// Exports auto-opens in the chat preview rail, token or no token.
const EXPORTS_DIR = `${VAULT_DIR}/Exports`
const POLL_MS = 4000

function isHtmlName(name: string): boolean {
  const lower = name.toLowerCase()

  return lower.endsWith('.html') || lower.endsWith('.htm')
}

export function useExportsPreviewWatcher() {
  useEffect(() => {
    if (!NEMESIS_STUDENT_BUILD) {
      return
    }

    // null until the first successful scan — pre-existing exports never auto-open.
    let seen: Set<string> | null = null
    let stopped = false
    let opening = false

    const tick = async () => {
      const api = window.hermesDesktop

      if (!api?.readDir || opening) {
        return
      }

      let dir: Awaited<ReturnType<NonNullable<typeof api.readDir>>>

      try {
        dir = await api.readDir(EXPORTS_DIR)
      } catch {
        return
      }

      if (stopped) {
        return
      }

      // A missing folder is a valid empty baseline: the very first deliverable
      // (which creates the folder) should still auto-open.
      if (dir.error) {
        seen ??= new Set()

        return
      }

      const files = dir.entries.filter(entry => !entry.isDirectory && isHtmlName(entry.name))

      if (!seen) {
        seen = new Set(files.map(file => file.name))

        return
      }

      const baseline = seen
      const fresh = files.filter(file => !baseline.has(file.name))

      for (const file of fresh) {
        baseline.add(file.name)
      }

      const newest = fresh[fresh.length - 1]

      if (!newest) {
        return
      }

      opening = true

      try {
        const target = await normalizeOrLocalPreviewTarget(newest.path)

        if (target && !stopped) {
          // 'tool-result' → runnable artifact → rendered HTML in the live
          // preview tab (same treatment as an agent-emitted preview token).
          setCurrentSessionPreviewTarget(target, 'tool-result', newest.path)
        }
      } catch {
        // Preview is a convenience; a failed open just waits for the token path.
      }

      opening = false
    }

    void tick()
    const timer = window.setInterval(() => void tick(), POLL_MS)

    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [])
}
