/**
 * At-rest encryption for stored SSH secrets.
 *
 * The host store is a shared JSON document (`$DSH_HOME/dsh-ssh.json`), so a
 * password sitting in it is exposed to every copy of that file — backups, sync
 * folders, a pasted excerpt, a screenshot. Secrets are therefore encrypted with
 * AES-256-GCM under a random 32-byte key kept in its own owner-only file next
 * to the store (`dsh-ssh.key`), and decrypted only while a connection is being
 * configured.
 *
 * Ciphertext spelling: `enc:v1:<base64(iv | tag | ciphertext)>`. Any value
 * without that prefix is passed through unchanged, which is what lets a legacy
 * plaintext store (and the plaintext `password` keyword in `~/.ssh/config`)
 * keep working while the startup migration re-writes it as ciphertext.
 *
 * @module @shiqyka/dsh-ssh-workspace/secrets
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Ciphertext marker; bump the version when the layout changes. */
const PREFIX = 'enc:v1:'

const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16

/** The DSH home the store and its key file live under. */
function dshHome () {
  const home = process.env.DSH_HOME
  return typeof home === 'string' && home !== '' ? home : join(homedir(), '.dsh')
}

/** Absolute path of the secret key file (sibling of the host store). */
export function keyPath () {
  return join(dshHome(), 'dsh-ssh.key')
}

/**
 * True when a stored value carries this module's ciphertext spelling.
 *
 * @param {unknown} value - the stored value.
 * @returns {boolean} true when it is ciphertext written by {@link SecretCodec#encrypt}.
 */
export function isEncrypted (value) {
  return typeof value === 'string' && value.startsWith(PREFIX)
}

/**
 * Encrypt / decrypt stored secrets under one key.
 *
 * The key is read once and cached for the process lifetime. A missing key file
 * is created on first use; an unreadable or wrongly sized one is an error
 * rather than a silent regeneration, because a fresh key would make every
 * already-stored ciphertext undecryptable.
 */
export class SecretCodec {
  /**
   * @param {object} [options] - overrides (tests).
   * @param {string} [options.path] - key file path.
   */
  constructor (options = {}) {
    this.path = options.path ?? keyPath()
    /** @type {Buffer | undefined} */
    this.key = undefined
  }

  /**
   * Encrypt one secret. Empty values and already-encrypted values pass through
   * (the latter so a re-save cannot double-encrypt).
   *
   * @param {unknown} value - plaintext secret.
   * @returns {string | undefined} ciphertext, or undefined for an empty value.
   */
  encrypt (value) {
    if (typeof value !== 'string' || value === '') return undefined
    if (isEncrypted(value)) return value
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', this.#loadKey(), iv)
    const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
  }

  /**
   * Decrypt one stored secret. Plaintext (a legacy store, or an ssh-config
   * value) is returned as-is.
   *
   * @param {unknown} value - stored value.
   * @returns {string | undefined} plaintext secret.
   * @throws {Error} when the value is ciphertext this key cannot open.
   */
  decrypt (value) {
    if (typeof value !== 'string' || value === '') return undefined
    if (!isEncrypted(value)) return value
    const raw = Buffer.from(value.slice(PREFIX.length), 'base64')
    if (raw.length <= IV_BYTES + TAG_BYTES) {
      throw new Error(`stored secret is not a valid ${PREFIX} value`)
    }
    const iv = raw.subarray(0, IV_BYTES)
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
    const body = raw.subarray(IV_BYTES + TAG_BYTES)
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#loadKey(), iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
    } catch {
      throw new Error(`cannot decrypt the stored secret: key file ${this.path} does not match the key it was written with`)
    }
  }

  /**
   * The process-wide key: read from disk, or generated and saved on first use.
   *
   * @returns {Buffer} the 32-byte key.
   */
  #loadKey () {
    if (this.key !== undefined) return this.key
    if (existsSync(this.path)) {
      const key = Buffer.from(readFileSync(this.path, 'utf8').trim(), 'base64')
      if (key.length !== KEY_BYTES) {
        throw new Error(`secret key file ${this.path} does not hold a ${KEY_BYTES}-byte key; restore the original file, or delete it and re-save the affected hosts`)
      }
      this.key = key
      return key
    }
    const key = randomBytes(KEY_BYTES)
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    writeFileSync(this.path, `${key.toString('base64')}\n`, { encoding: 'utf8', mode: 0o600 })
    // The mode above only applies to a fresh file; tighten an existing one too.
    // Best-effort: win32 (and some network filesystems) may not honor it.
    try { chmodSync(this.path, 0o600) } catch { /* mode unsupported here */ }
    this.key = key
    return key
  }
}