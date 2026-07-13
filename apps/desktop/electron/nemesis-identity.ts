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

export {
  APP_ID,
  APP_NAME,
  DEEP_LINK_PROTOCOLS,
  defaultNemesisHome,
  extractNemesisDeepLink,
  LEGACY_PROTOCOL,
  PRIMARY_PROTOCOL
}
