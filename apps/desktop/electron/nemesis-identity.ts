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

export {
  APP_ID,
  APP_NAME,
  DEEP_LINK_PROTOCOLS,
  defaultLegacyHermesHome,
  defaultNemesisHome,
  detectLegacyHomeMigration,
  extractNemesisDeepLink,
  LEGACY_PROTOCOL,
  PRIMARY_PROTOCOL
}
