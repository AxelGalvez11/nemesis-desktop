// Whether `git rev-list HEAD..origin/<branch> --count` produces a meaningful
// number worth computing. On a SHALLOW checkout (installer clones with
// --depth 1) the local history often shares no merge-base with the freshly
// fetched origin tip, so the count enumerates the entire remote ancestry and
// returns a bogus huge number (e.g. 12104) — see #51922. resolveBehindCount
// discards that bogus count in favour of a SHA compare, so the caller should
// SKIP the expensive rev-list entirely in that case rather than run it and
// throw the result away.
function shouldCountCommits({ isShallow, hasMergeBase }) {
  return !(isShallow && !hasMergeBase)
}

// Resolve how many commits the local checkout is behind origin for the desktop
// update indicator. When the count isn't meaningful (shallow + no merge-base)
// fall back to a binary up-to-date check by SHA, exactly like the official-SSH
// path in checkUpdates() and the CLI guard in hermes_cli/banner.py. Full clones
// (developers / Docker dev images) keep the exact count path unchanged.
function resolveBehindCount({ countStr, currentSha, targetSha, isShallow, hasMergeBase }) {
  if (!shouldCountCommits({ isShallow, hasMergeBase })) {
    if (currentSha && targetSha && currentSha === targetSha) {
      return 0
    }

    return 1 // behind by an unknown amount — show a generic "update available"
  }

  return Number.parseInt(countStr, 10) || 0
}

// Decide whether the quit-for-update backend runtime sync is warranted from a
// checkUpdates() result. The student build has NO backend-update UI (the app
// binary updates via electron-updater, but nothing ever moved the runtime
// checkout in ~/.nemesis/hermes-agent — backends froze at their install-day
// code forever). The app-update quit is the one moment the backend is torn
// down anyway, so that's when the runtime sync piggybacks. Only a supported,
// error-free check that is genuinely behind qualifies; anything ambiguous
// (unsupported install, fetch failure, up to date) returns null = don't sync.
function backendSyncBranchFrom(status) {
  if (!status || status.supported !== true || status.error) {
    return null
  }

  return Number(status.behind) > 0 ? status.branch || 'main' : null
}

export { backendSyncBranchFrom, resolveBehindCount, shouldCountCommits }
