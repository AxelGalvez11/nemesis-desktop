/**
 * Mac half of the phone-sync wire format v1 (normative doc:
 * docs/design/nemesis-phone-sync-format-v1.md in the nemesis repo). The phone
 * implements the mirror image with @noble/ciphers; library-crypto.test.ts here
 * proves byte-level interop by decrypting this module's output with the exact
 * noble primitive the phone ships.
 *
 * Everything is end-to-end encrypted under a 32-byte vault key that pairing
 * moves to the phone via QR: the server stores an HMAC'd path and AES-256-GCM
 * ciphertext, nothing readable.
 */
import { createCipheriv, createHmac, randomBytes } from 'node:crypto'

export const PAIRING_PREFIX = 'nemsync1.'
export const VAULT_KEY_BYTES = 32
const NONCE_BYTES = 12

export function generateVaultKey(): Buffer {
  return randomBytes(VAULT_KEY_BYTES)
}

/** The QR / manual-paste pairing string. The code IS the key — never log it. */
export function pairingCodeFromKey(key: Buffer): string {
  return `${PAIRING_PREFIX}${key.toString('base64url')}`
}

export function keyFromStoredBase64url(value: string): Buffer | null {
  try {
    const key = Buffer.from(value, 'base64url')
    return key.length === VAULT_KEY_BYTES ? key : null
  } catch {
    return null
  }
}

/** Row identity: hex HMAC-SHA256 of the NFC-normalized vault-relative path.
 * Deterministic (stable upsert key) but unreadable server-side. */
export function pathHashHex(key: Buffer, relPath: string): string {
  return createHmac('sha256', key).update(`nemesis-sync-v1:path:${relPath.normalize('NFC')}`, 'utf8').digest('hex')
}

/** First `# ` heading wins, else the filename stem — matches what the phone
 * shows as the note's list title. */
export function titleFromMarkdown(content: string, relPath: string): string {
  for (const line of content.split('\n')) {
    const match = /^#\s+(.+?)\s*$/.exec(line)
    if (match) return match[1]
  }
  const base = relPath.split('/').pop() ?? relPath
  return base.replace(/\.md$/i, '')
}

export type EncryptedRow = { path_hash: string; payload: string }

/**
 * Seal one document. payload = base64(nonce || ciphertext || tag), with the
 * row's path_hash as GCM additional-authenticated-data so a payload moved onto
 * a different row fails authentication on the phone.
 */
export function encryptDoc(
  key: Buffer,
  relPath: string,
  content: string,
  mtimeIso: string
): EncryptedRow {
  const path = relPath.normalize('NFC')
  const path_hash = pathHashHex(key, path)
  const plaintext = Buffer.from(
    JSON.stringify({ v: 1, path, title: titleFromMarkdown(content, path), kind: 'note', content, mtime: mtimeIso }),
    'utf8'
  )
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(path_hash, 'utf8'))
  const sealed = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
  return { path_hash, payload: Buffer.concat([nonce, sealed]).toString('base64') }
}
