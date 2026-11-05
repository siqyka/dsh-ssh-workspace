/**
 * Content verification for transfers: does the bytes that arrived match the
 * bytes that left?
 *
 * ## Why this exists at all
 *
 * The transfer path already stages and renames, so a reader never sees a
 * half-written file. That guarantees ATOMICITY, not INTEGRITY: a connection that
 * dies mid-stream, a remote disk that fills, a proxy that truncates — all of
 * them produce a file that was published cleanly and is the wrong length or the
 * wrong content. The publish step cannot tell, because it only knows that the
 * writes it issued succeeded.
 *
 * ## Why a remote tool is needed, and why it is optional
 *
 * SFTP has no hash command (the extension set is rename / statvfs / hardlink /
 * fsync / lsetstat / expandPath — no check-file), so the only way to hash the
 * remote side is to RUN something there: `sha256sum`, `shasum`, or `openssl dgst`.
 * None of them are installed everywhere. So verification is a capability, not a
 * guarantee: present when a hasher is found, and reported as unavailable — never
 * silently skipped — when none is.
 *
 * ## The cost, stated rather than hidden
 *
 * An upload has to read the remote file back to hash it, and a download has to
 * hash the local copy after it lands. Both are a full extra read. That is why
 * this is opt-in per transfer and why the round trip is described in the result
 * rather than performed behind the user's back.
 *
 * @module @shiqyka/dsh-ssh-workspace/verify
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

import { shellQuote } from './engine.js'

/** Hashers tried in order; the first one present on the host wins. */
export const REMOTE_HASHERS = Object.freeze([
  { name: 'sha256sum', command: 'sha256sum' },
  { name: 'shasum', command: 'shasum -a 256' },
  { name: 'openssl', command: 'openssl dgst -sha256 -r' },
])

/**
 * Split one hasher's output into a digest.
 *
 * The three tools disagree about layout, which is why this is a function with
 * its own tests rather than one regex inline:
 *
 *   sha256sum        `<hex>  <name>`
 *   shasum -a 256    `<hex>  <name>`
 *   openssl -r       `<hex> *<name>`
 *
 * @param {string} stdout - the command's output.
 * @returns {string|undefined} the lowercase hex digest, when one can be read.
 */
export function digestOfHasherOutput (stdout) {
  const text = String(stdout ?? '').trim()
  if (text === '') return undefined
  // The digest is the first whitespace-delimited token, and it must LOOK like
  // sha256 (64 hex chars). Accepting a shorter token would let a tool's error
  // text be compared as a checksum.
  const first = text.split(/\s+/u)[0]
  return /^[0-9a-f]{64}$/iu.test(first) ? first.toLowerCase() : undefined
}

/**
 * Hash a LOCAL file, streaming.
 *
 * A file small enough to matter is still read in chunks: hashing is not a
 * reason to hold a gigabyte in memory.
 *
 * @param {string} filePath - the file.
 * @param {AbortSignal} [signal] - cancels mid-read.
 * @returns {Promise<string>} the lowercase hex SHA-256.
 */
export async function hashLocalFile (filePath, signal) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath, { highWaterMark: 256 * 1024 })) {
    signal?.throwIfAborted?.()
    hash.update(chunk)
  }
  return hash.digest('hex')
}

/**
 * Which hasher this host has, if any.
 *
 * One round trip for all three, using the same `command -v` sweep shape the
 * capability probe uses — a host without any of them pays one command, not
 * three.
 *
 * @param {import('./engine.js').SshWorkspaceEngine} engine - live engine.
 * @param {string} alias - host alias.
 * @param {AbortSignal} [signal] - cancels the probe.
 * @returns {Promise<{name: string, command: string}|undefined>} the hasher, when one exists.
 */
export async function findRemoteHasher (engine, alias, signal) {
  const script = REMOTE_HASHERS
    .map(entry => `command -v ${entry.command.split(' ')[0]} >/dev/null 2>&1 && printf 'dsh-hash:%s\\n' ${shellQuote(entry.name)}`)
    .join('; ')
  const outcome = await engine.exec(alias, `set +e; ${script}`, {
    timeoutMs: 15_000,
    replay: 'safe',
    signal,
    channel: 'exec',
  })
  if (outcome?.success !== true) return undefined
  const reported = new Set((outcome.stdout ?? '').split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('dsh-hash:'))
    .map(line => line.slice('dsh-hash:'.length)))
  return REMOTE_HASHERS.find(entry => reported.has(entry.name))
}

/**
 * Hash a REMOTE file with the named hasher.
 *
 * @param {import('./engine.js').SshWorkspaceEngine} engine - live engine.
 * @param {string} alias - host alias.
 * @param {string} remotePath - the file.
 * @param {{name: string, command: string}} hasher - which tool to use.
 * @param {AbortSignal} [signal] - cancels the command.
 * @returns {Promise<string|undefined>} the digest, or undefined when unreadable.
 */
export async function hashRemoteFile (engine, alias, remotePath, hasher, signal) {
  const outcome = await engine.exec(alias, `${hasher.command} ${shellQuote(remotePath)}`, {
    timeoutMs: 300_000,
    replay: 'safe',
    signal,
    channel: 'exec',
  })
  if (outcome?.success !== true) return undefined
  return digestOfHasherOutput(outcome.stdout)
}

/**
 * Compare two digests, refusing to call a missing one a match.
 *
 * This is the whole verification contract in one function: `undefined ===
 * undefined` is true in JavaScript, and a comparison written that way would
 * report success for every transfer where BOTH sides failed to hash — the exact
 * case that needs to be loudest.
 *
 * @param {string|undefined} expected - the source digest.
 * @param {string|undefined} actual - the destination digest.
 * @returns {{ok: boolean, reason?: string}} the verdict.
 */
export function compareDigests (expected, actual) {
  if (typeof expected !== 'string' || expected === '') {
    return { ok: false, reason: 'the source could not be hashed, so there is nothing to compare against' }
  }
  if (typeof actual !== 'string' || actual === '') {
    return { ok: false, reason: 'the destination could not be hashed, so the copy is unverified' }
  }
  if (expected.toLowerCase() !== actual.toLowerCase()) {
    return { ok: false, reason: `checksum mismatch: source ${expected}, destination ${actual}` }
  }
  return { ok: true }
}
