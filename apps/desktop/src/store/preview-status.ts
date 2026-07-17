import { atom } from 'nanostores'

import { previewName } from '@/lib/preview-targets'

/**
 * Session-scoped feed of previewable artifacts (HTML files, localhost dev URLs)
 * a tool produced. Surfaced as compact links in the composer status stack —
 * NOT auto-opened and NOT a bulky inline card. Click opens the rail preview or
 * the browser; both are manual.
 *
 * Fed from the tool row itself (see tool-fallback.tsx) using the same detected
 * target the inline card used, so detection parity is exact.
 */
export interface PreviewArtifact {
  /** cwd captured at detection so a relative path still resolves on click. */
  cwd: string
  /** Dedupe key + display id (the raw target). */
  id: string
  label: string
  target: string
}

const MAX_PER_SESSION = 4

export const $previewStatusBySession = atom<Record<string, PreviewArtifact[]>>({})

// Dismissals are tombstones, not just removals: the tool rows re-register their
// targets on later renders, so without a tombstone an ✕'d chip resurrects on the
// next re-render pass. Cleared with clearPreviewArtifacts (a fresh run may
// legitimately produce — and re-chip — the same file).
const dismissedBySession = new Map<string, Set<string>>()

const writePreviews = (sid: string, items: PreviewArtifact[]) => {
  const current = $previewStatusBySession.get()

  if (items.length === 0) {
    if (!current[sid]) {
      return
    }

    const next = { ...current }
    delete next[sid]
    $previewStatusBySession.set(next)

    return
  }

  $previewStatusBySession.set({ ...current, [sid]: items })
}

/**
 * Record a detected artifact, newest last, capped. Idempotent: a target already
 * in the list keeps its slot (the tool row re-registers on every render, so this
 * must not churn the atom or reorder rows).
 */
export function recordPreviewArtifact(sid: string, target: string, cwd: string) {
  const raw = target.trim()

  if (!sid || !raw) {
    return
  }

  if (dismissedBySession.get(sid)?.has(raw)) {
    return
  }

  const list = $previewStatusBySession.get()[sid] ?? []

  if (list.some(item => item.id === raw)) {
    return
  }

  writePreviews(sid, [...list, { cwd, id: raw, label: previewName(raw), target: raw }].slice(-MAX_PER_SESSION))
}

export function dismissPreviewArtifact(sid: string, id: string) {
  const tombstones = dismissedBySession.get(sid) ?? new Set<string>()
  tombstones.add(id)
  dismissedBySession.set(sid, tombstones)

  const list = $previewStatusBySession.get()[sid]

  if (list) {
    writePreviews(
      sid,
      list.filter(item => item.id !== id)
    )
  }
}

export function clearPreviewArtifacts(sid: string) {
  dismissedBySession.delete(sid)
  writePreviews(sid, [])
}
