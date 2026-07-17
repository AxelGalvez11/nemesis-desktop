// Interop proof for phone-sync wire format v1: what this Mac module encrypts with
// node:crypto, the PHONE's exact primitive (@noble/ciphers@1, gcm) must decrypt —
// same layout (nonce || ciphertext || tag), same AAD (the path_hash hex string).
// @noble/ciphers is pinned to the same major the mobile app ships (1.x).
import test from 'node:test'
import assert from 'node:assert/strict'
import { gcm } from '@noble/ciphers/aes'
import { bytesToUtf8, utf8ToBytes } from '@noble/ciphers/utils'
import {
  encryptDoc,
  generateVaultKey,
  keyFromStoredBase64url,
  pairingCodeFromKey,
  pathHashHex,
  titleFromMarkdown,
  PAIRING_PREFIX
} from './library-crypto'

function nobleDecrypt(key: Buffer, pathHash: string, payloadB64: string): string {
  const raw = Buffer.from(payloadB64, 'base64')
  const nonce = Uint8Array.from(raw.subarray(0, 12))
  const sealed = Uint8Array.from(raw.subarray(12))
  return bytesToUtf8(gcm(Uint8Array.from(key), nonce, utf8ToBytes(pathHash)).decrypt(sealed))
}

test('noble (the phone) decrypts what node:crypto (the Mac) encrypts', () => {
  const key = generateVaultKey()
  const content = '# Exam 2 notes\n\n| drug | class |\n|---|---|\n| lisinopril | ACE inhibitor |\n'
  const row = encryptDoc(key, 'PHCY 1205/exam-2.md', content, '2026-07-16T21:00:00.000Z')

  const doc = JSON.parse(nobleDecrypt(key, row.path_hash, row.payload))
  assert.equal(doc.v, 1)
  assert.equal(doc.path, 'PHCY 1205/exam-2.md')
  assert.equal(doc.title, 'Exam 2 notes')
  assert.equal(doc.kind, 'note')
  assert.equal(doc.content, content)
  assert.equal(doc.mtime, '2026-07-16T21:00:00.000Z')
})

test('a payload moved onto a different row fails authentication (AAD binding)', () => {
  const key = generateVaultKey()
  const row = encryptDoc(key, 'a.md', 'alpha', '2026-07-16T21:00:00.000Z')
  const otherHash = pathHashHex(key, 'b.md')
  assert.throws(() => nobleDecrypt(key, otherHash, row.payload))
})

test('the wrong key fails authentication', () => {
  const row = encryptDoc(generateVaultKey(), 'a.md', 'alpha', '2026-07-16T21:00:00.000Z')
  assert.throws(() => nobleDecrypt(generateVaultKey(), row.path_hash, row.payload))
})

test('path_hash is deterministic, NFC-normalized, and 64 hex chars', () => {
  const key = generateVaultKey()
  const composed = 'Séminaire/notes.md' // e + combining accent
  const precomposed = 'Séminaire/notes.md' // é precomposed
  assert.equal(pathHashHex(key, composed), pathHashHex(key, precomposed))
  assert.match(pathHashHex(key, 'x.md'), /^[0-9a-f]{64}$/)
  assert.notEqual(pathHashHex(key, 'x.md'), pathHashHex(generateVaultKey(), 'x.md'))
})

test('pairing code round-trips through the stored base64url form', () => {
  const key = generateVaultKey()
  const code = pairingCodeFromKey(key)
  assert.ok(code.startsWith(PAIRING_PREFIX))
  const restored = keyFromStoredBase64url(code.slice(PAIRING_PREFIX.length))
  assert.ok(restored)
  assert.ok(key.equals(restored))
  assert.equal(keyFromStoredBase64url('too-short'), null)
})

test('titleFromMarkdown: first # heading wins, filename stem is the fallback', () => {
  assert.equal(titleFromMarkdown('intro\n# Real Title \nbody', 'a/b.md'), 'Real Title')
  assert.equal(titleFromMarkdown('## only a subheading\ntext', 'PHCY 1205/exam-2.md'), 'exam-2')
  assert.equal(titleFromMarkdown('', 'plain.md'), 'plain')
})
