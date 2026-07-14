/**
 * Pure helpers for choosing a remote URL during passive update checks.
 *
 * A public install can end up with `origin=git@github.com:AxelGalvez11/nemesis-desktop.git`.
 * If the user's GitHub SSH key is FIDO2/passkey-backed, a background `git fetch
 * origin` triggers an unexplained hardware-touch prompt. For passive checks
 * against the official repo we substitute the public HTTPS `ls-remote` path,
 * which needs no auth and cannot prompt. Active update/apply flows are left
 * unchanged.
 *
 * Extracted from main.ts so the security-critical remote detection is unit
 * testable without booting Electron (main.ts requires('electron') at load).
 */

const OFFICIAL_REPO_HTTPS_URL = 'https://github.com/AxelGalvez11/nemesis-desktop.git'
const OFFICIAL_REPO_CANONICAL = 'github.com/axelgalvez11/nemesis-desktop'

// Normalize common GitHub remote URL forms to `host/owner/repo` (lowercased,
// no trailing slash, no .git suffix) so SSH and HTTPS forms of the same repo
// compare equal.
function canonicalGitHubRemote(url) {
  if (!url) {
    return ''
  }
  let value = String(url).trim()

  if (value.startsWith('git@github.com:')) {
    value = `github.com/${value.slice('git@github.com:'.length)}`
  } else if (value.startsWith('ssh://git@github.com/')) {
    value = `github.com/${value.slice('ssh://git@github.com/'.length)}`
  } else {
    try {
      const parsed = new URL(value)

      if (parsed.hostname && parsed.pathname) {
        value = `${parsed.hostname}${parsed.pathname}`
      }
    } catch {
      // Leave non-URL forms unchanged.
    }
  }

  value = value.trim().replace(/\/+$/, '')

  if (value.endsWith('.git')) {
    value = value.slice(0, -4)
  }

  return value.toLowerCase()
}

function isSshRemote(url) {
  const value = String(url || '')
    .trim()
    .toLowerCase()

  return value.startsWith('git@') || value.startsWith('ssh://')
}

function isOfficialSshRemote(url) {
  return isSshRemote(url) && canonicalGitHubRemote(url) === OFFICIAL_REPO_CANONICAL
}

// Explicit fetch refspec that force-creates refs/remotes/origin/<branch>.
//
// Installer checkouts are SINGLE-BRANCH clones (`git clone --depth 1
// --branch <pinned>`), so remote.origin.fetch only maps the pinned branch.
// A plain `git fetch origin main` on such a clone updates FETCH_HEAD but
// never creates origin/main — every downstream consumer then breaks:
// checkUpdates' `rev-parse origin/main` yields garbage (a permanent phantom
// "update available"), and `hermes update`'s `checkout -B main origin/main`
// aborts with "branch does not exist". Passing the full refspec on the
// command line sidesteps the clone's narrow config without mutating it.
function fetchRefspecFor(branch) {
  return `+refs/heads/${branch}:refs/remotes/origin/${branch}`
}

export {
  canonicalGitHubRemote,
  fetchRefspecFor,
  isOfficialSshRemote,
  isSshRemote,
  OFFICIAL_REPO_CANONICAL,
  OFFICIAL_REPO_HTTPS_URL
}
