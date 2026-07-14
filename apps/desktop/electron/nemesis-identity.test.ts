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
  NEMESIS_ENV_BANNER,
  PRIMARY_PROTOCOL,
  upsertEnvVars
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

  // Nemesis home already holds a runtime: never prompt, even with a legacy dir present.
  assert.equal(
    detectLegacyHomeMigration(
      withDirs(
        '/Users/student/.nemesis',
        '/Users/student/.nemesis/hermes-agent',
        '/Users/student/.hermes',
        '/Users/student/.hermes/hermes-agent'
      )
    ),
    null
  )

  // A runtime-less stub (failed beta.2 first boot: bootstrap-cache + logs only)
  // must NOT block the offer.
  assert.deepEqual(
    detectLegacyHomeMigration(withDirs('/Users/student/.nemesis', '/Users/student/.hermes', '/Users/student/.hermes/hermes-agent')),
    { legacyHome: '/Users/student/.hermes', nemesisHome: '/Users/student/.nemesis' }
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

// --- upsertEnvVars -----------------------------------------------------------

test('upsertEnvVars appends managed vars to an empty file', () => {
  const result = upsertEnvVars('', { DEEPSEEK_API_KEY: 'nmk_abc', DEEPSEEK_BASE_URL: 'https://proxy/v1' })

  assert.ok(result.includes('DEEPSEEK_API_KEY=nmk_abc\n'))
  assert.ok(result.includes('DEEPSEEK_BASE_URL=https://proxy/v1\n'))
  assert.ok(result.includes(NEMESIS_ENV_BANNER))
  assert.ok(result.endsWith('\n'))
})

test('upsertEnvVars rewrites an existing assignment in place', () => {
  const before = '# my notes\nDEEPSEEK_API_KEY=old_key\nOTHER=1\n'
  const result = upsertEnvVars(before, { DEEPSEEK_API_KEY: 'nmk_new' })

  assert.equal(result, '# my notes\nDEEPSEEK_API_KEY=nmk_new\nOTHER=1\n')
})

test('upsertEnvVars leaves commented lookalikes alone and appends the real var', () => {
  const before = '# DEEPSEEK_API_KEY=commented\n'
  const result = upsertEnvVars(before, { DEEPSEEK_API_KEY: 'nmk_live' })

  assert.ok(result.includes('# DEEPSEEK_API_KEY=commented'))
  assert.ok(result.includes('\nDEEPSEEK_API_KEY=nmk_live'))
})

test('upsertEnvVars handles export-prefixed assignments', () => {
  const before = 'export DEEPSEEK_BASE_URL=https://old\n'
  const result = upsertEnvVars(before, { DEEPSEEK_BASE_URL: 'https://new/v1' })

  assert.equal(result, 'DEEPSEEK_BASE_URL=https://new/v1\n')
})

test('upsertEnvVars is idempotent', () => {
  const once = upsertEnvVars('KEEP=1\n', { DEEPSEEK_API_KEY: 'nmk_x', DEEPSEEK_BASE_URL: 'https://p/v1' })
  const twice = upsertEnvVars(once, { DEEPSEEK_API_KEY: 'nmk_x', DEEPSEEK_BASE_URL: 'https://p/v1' })

  assert.equal(once, twice)
})

test('upsertEnvVars mixed update-and-append keeps unrelated lines byte-identical', () => {
  const before = 'A=1\nDEEPSEEK_API_KEY=stale\n\n# trailing comment\n'
  const result = upsertEnvVars(before, { DEEPSEEK_API_KEY: 'nmk_y', DEEPSEEK_BASE_URL: 'https://p/v1' })

  assert.ok(result.startsWith('A=1\nDEEPSEEK_API_KEY=nmk_y\n'))
  assert.ok(result.includes('# trailing comment'))
  assert.ok(result.includes('DEEPSEEK_BASE_URL=https://p/v1'))
})
