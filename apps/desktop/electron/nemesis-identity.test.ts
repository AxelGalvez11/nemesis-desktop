import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  APP_ID,
  APP_NAME,
  DEEP_LINK_PROTOCOLS,
  defaultNemesisHome,
  detectLegacyHomeMigration,
  extractNemesisDeepLink,
  PRIMARY_PROTOCOL
} from './nemesis-identity'

const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DESKTOP_PACKAGE = JSON.parse(fs.readFileSync(path.join(DESKTOP_ROOT, 'package.json'), 'utf8'))

test('native identity stays aligned with installer metadata', () => {
  assert.equal(DESKTOP_PACKAGE.productName, APP_NAME)
  assert.equal(DESKTOP_PACKAGE.build.appId, APP_ID)
  assert.deepEqual(DESKTOP_PACKAGE.build.protocols[0].schemes, DEEP_LINK_PROTOCOLS)
  assert.equal(DEEP_LINK_PROTOCOLS[0], PRIMARY_PROTOCOL)
})

test('default runtime home is isolated from a Hermes installation', () => {
  assert.equal(defaultNemesisHome('darwin', '/Users/student'), '/Users/student/.nemesis')
  assert.equal(defaultNemesisHome('linux', '/home/student'), '/home/student/.nemesis')
  assert.equal(defaultNemesisHome('win32', 'C:\\Users\\student', 'C:\\Users\\student\\AppData\\Local'),
    'C:\\Users\\student\\AppData\\Local\\nemesis')
})

test('Nemesis links are primary while legacy Hermes links remain compatible', () => {
  assert.equal(extractNemesisDeepLink(['Nemesis', 'nemesis://blueprint/review']), 'nemesis://blueprint/review')
  assert.equal(extractNemesisDeepLink(['Nemesis', 'hermes://blueprint/review']), 'hermes://blueprint/review')
  assert.equal(extractNemesisDeepLink(['Nemesis', 'https://enternemesis.com']), null)
})

test('legacy home migration is offered only when unambiguous markers exist', () => {
  const base = {
    home: '/Users/student',
    nemesisHome: '/Users/student/.nemesis',
    platform: 'darwin' as NodeJS.Platform
  }
  const withDirs = (...dirs: string[]) => ({ ...base, exists: (p: string) => dirs.includes(p) })

  // Fresh machine: nothing to offer.
  assert.equal(detectLegacyHomeMigration(withDirs()), null)

  // Nemesis home already exists: never prompt, even with a legacy dir present.
  assert.equal(
    detectLegacyHomeMigration(withDirs('/Users/student/.nemesis', '/Users/student/.hermes', '/Users/student/.hermes/hermes-agent')),
    null
  )

  // Legacy dir without agent markers (random stray folder): no prompt.
  assert.equal(detectLegacyHomeMigration(withDirs('/Users/student/.hermes')), null)

  // Legacy agent home (checkout marker) and no nemesis home: offer the move.
  assert.deepEqual(detectLegacyHomeMigration(withDirs('/Users/student/.hermes', '/Users/student/.hermes/hermes-agent')), {
    legacyHome: '/Users/student/.hermes',
    nemesisHome: '/Users/student/.nemesis'
  })

  // config.yaml alone is also an accepted marker.
  assert.deepEqual(detectLegacyHomeMigration(withDirs('/Users/student/.hermes', '/Users/student/.hermes/config.yaml')), {
    legacyHome: '/Users/student/.hermes',
    nemesisHome: '/Users/student/.nemesis'
  })
})

test('legacy home migration maps Windows paths through LOCALAPPDATA', () => {
  const local = 'C:\\Users\\student\\AppData\\Local'
  const legacy = `${local}\\hermes`
  const result = detectLegacyHomeMigration({
    exists: (p: string) => [legacy, `${legacy}\\hermes-agent`].includes(p),
    home: 'C:\\Users\\student',
    localAppData: local,
    nemesisHome: `${local}\\nemesis`,
    platform: 'win32'
  })
  assert.deepEqual(result, { legacyHome: legacy, nemesisHome: `${local}\\nemesis` })
})
