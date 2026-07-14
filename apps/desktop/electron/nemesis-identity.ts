import path from 'node:path'

const APP_NAME = 'Nemesis'
const APP_ID = 'com.enternemesis.desktop'
const PRIMARY_PROTOCOL = 'nemesis'
const LEGACY_PROTOCOL = 'hermes'
// Only the Nemesis scheme is registered with the OS. We still parse legacy
// links so an old saved URL can be handed to Nemesis explicitly without
// stealing hermes:// ownership from a separately installed app.
const DEEP_LINK_PROTOCOLS = [PRIMARY_PROTOCOL]
const ACCEPTED_DEEP_LINK_PROTOCOLS = [PRIMARY_PROTOCOL, LEGACY_PROTOCOL]

function extractNemesisDeepLink(argv: unknown) {
  if (!Array.isArray(argv)) {
    return null
  }

  return (
    argv.find(
      value =>
        typeof value === 'string' && ACCEPTED_DEEP_LINK_PROTOCOLS.some(protocol => value.startsWith(`${protocol}://`))
    ) || null
  )
}

function defaultNemesisHome(platform: NodeJS.Platform, home: string, localAppData?: string) {
  if (platform === 'win32' && localAppData) {
    return path.win32.join(localAppData, 'nemesis')
  }

  return path.join(home, '.nemesis')
}

function defaultLegacyHermesHome(platform: NodeJS.Platform, home: string, localAppData?: string) {
  if (platform === 'win32' && localAppData) {
    return path.win32.join(localAppData, 'hermes')
  }

  return path.join(home, '.hermes')
}

// Nemesis betas before the .nemesis switch kept the agent runtime at the legacy
// Hermes default. On disk, "our own earlier beta" and "an independently
// installed Hermes agent" are indistinguishable, so this only DETECTS the
// situation — the caller must ask the user before moving anything.
function detectLegacyHomeMigration(options: {
  exists: (candidate: string) => boolean
  home: string
  localAppData?: string
  nemesisHome: string
  platform: NodeJS.Platform
}): null | { legacyHome: string; nemesisHome: string } {
  const { exists, home, localAppData, nemesisHome, platform } = options
  const joiner = platform === 'win32' ? path.win32 : path

  const looksLikeAgentHome = (dir: string) =>
    exists(joiner.join(dir, 'hermes-agent')) || exists(joiner.join(dir, 'config.yaml'))

  // A nemesis home that already contains a runtime wins outright. A mere stub
  // (bootstrap-cache/ + logs/ left behind by a failed first boot) must NOT
  // block the offer — beta.2's broken bootstrap created exactly such stubs.
  if (looksLikeAgentHome(nemesisHome)) {
    return null
  }

  const legacyHome = defaultLegacyHermesHome(platform, home, localAppData)

  if (legacyHome === nemesisHome || !exists(legacyHome)) {
    return null
  }

  return looksLikeAgentHome(legacyHome) ? { legacyHome, nemesisHome } : null
}

// Upsert KEY=value lines into a dotenv-style file body without disturbing any
// other line (comments, unrelated vars, blank lines, ordering). An existing
// assignment for a key is rewritten in place — even when commented-out lookalikes
// exist elsewhere — and missing keys are appended under a managed banner. Pure
// so the sync IPC handler's file semantics are unit-testable.
const NEMESIS_ENV_BANNER = '# Managed by Nemesis sign-in — safe to delete; rewritten on next launch.'

function upsertEnvVars(content: string, vars: Record<string, string>): string {
  const lines = content.length ? content.split('\n') : []
  const pending = new Map(Object.entries(vars))

  const rewritten = lines.map(line => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)

    if (!match || !pending.has(match[1])) {
      return line
    }

    const key = match[1]
    const value = pending.get(key)
    pending.delete(key)

    return `${key}=${value}`
  })

  if (pending.size === 0) {
    return rewritten.join('\n')
  }

  const appended = [...rewritten]

  // Drop a single trailing blank line so the appended block sits flush, then
  // restore the trailing newline at the end.
  while (appended.length && appended[appended.length - 1].trim() === '') {
    appended.pop()
  }

  if (appended.length) {
    appended.push('')
  }

  appended.push(NEMESIS_ENV_BANNER)

  for (const [key, value] of pending) {
    appended.push(`${key}=${value}`)
  }

  appended.push('')

  return appended.join('\n')
}

export {
  APP_ID,
  APP_NAME,
  DEEP_LINK_PROTOCOLS,
  defaultLegacyHermesHome,
  defaultNemesisHome,
  detectLegacyHomeMigration,
  extractNemesisDeepLink,
  LEGACY_PROTOCOL,
  NEMESIS_ENV_BANNER,
  PRIMARY_PROTOCOL,
  upsertEnvVars
}
