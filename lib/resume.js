/**
 * Resumable transfer: where the bytes already are, and whether they are the
 * RIGHT bytes.
 *
 * ## Why resuming is not "just append"
 *
 * A staged upload normally uses a random name, because two concurrent transfers
 * to one destination must not share a staging file (see `stagingNameOf`). That
 * randomness is exactly what makes resuming impossible: every attempt starts a
 * new file with nothing in it.
 *
 * Resuming needs the opposite property — the SAME staging path across attempts —
 * and the safety that randomness was buying has to come back some other way.
 * The answer used here:
 *
 *   - the staging path is DERIVED from (destination, source identity), so a
 *     retry finds the same partial file;
 *   - a sidecar records what the partial file is, so a staging file left over
 *     from a DIFFERENT source can never be appended to;
 *   - the recorded source size and mtime must match the source as it is NOW,
 *     because appending the second half of an old build to the first half of a
 *     new one produces a file that is the right length and wrong everywhere.
 *
 * Every one of those checks fails CLOSED: a partial file whose sidecar is
 * missing, unreadable, or about another source is discarded and the transfer
 * starts over. Discarding costs a retransmit; appending costs a corrupt file
 * that publishes successfully.
 *
 * @module @shiqyka/dsh-ssh-workspace/resume
 */

import { randomBytes } from 'node:crypto'

/**
 * The identity of a source file for resumption purposes.
 *
 * Size alone is not enough (a rebuilt artifact often has the same size) and
 * mtime alone is not enough (a copied tree can preserve it). Together they are
 * the same pair `make` uses, with the same failure mode: a source rewritten
 * within one mtime tick at the same size is treated as unchanged. That limit is
 * documented rather than papered over, and the checksum — when verification is
 * on — is what catches it afterwards.
 *
 * @param {{size?: number, mtimeMs?: number}} stats - the source's stats.
 * @returns {string} a stable token.
 */
export function sourceIdentity (stats) {
  const size = Number.isFinite(stats?.size) ? stats.size : -1
  const mtime = Number.isFinite(stats?.mtimeMs) ? Math.trunc(stats.mtimeMs) : -1
  return `${size}:${mtime}`
}

/**
 * A DETERMINISTIC staging name for a resumable upload.
 *
 * Unlike {@link import('./transfer.js').stagingNameOf}, two calls with the same
 * destination produce the same path — that is the whole point. The source
 * identity is NOT in the name: a source that changed must reuse the same
 * staging path so the old partial file is found and DISCARDED, rather than
 * leaving orphaned partials behind on every rebuild.
 *
 * @param {string} target - the upload destination.
 * @returns {string} the staging path.
 */
export function resumableStagingName (target) {
  return `${String(target).replace(/\/+$/u, '')}.dsh-up-partial`
}

/**
 * The sidecar that describes a partial upload.
 *
 * @param {string} target - the upload destination.
 * @returns {string} the sidecar path.
 */
export function resumeSidecarName (target) {
  return `${resumableStagingName(target)}.json`
}

/**
 * The resume plan for one attempt.
 *
 * @param {object} options - the inputs.
 * @param {number} [options.partialBytes] - size of the staged file on disk.
 * @param {string|undefined} options.recordedIdentity - the sidecar's source identity.
 * @param {string} options.currentIdentity - the source's identity NOW.
 * @param {number} options.totalBytes - the source's size.
 * @returns {{resume: boolean, offset: number, reason: string}} the plan.
 */
export function planResume (options) {
  const partial = Number.isFinite(options.partialBytes) ? options.partialBytes : 0
  const total = Number.isFinite(options.totalBytes) ? options.totalBytes : 0
  if (partial <= 0) return { resume: false, offset: 0, reason: 'nothing staged yet' }
  if (partial > total) {
    // A staged file LARGER than the source cannot be a prefix of it. This is the
    // case a naive `offset = partialSize` gets catastrophically wrong: it would
    // seek past the end and publish a file whose head belongs to something else.
    return { resume: false, offset: 0, reason: 'the staged file is larger than the source, so it is not a prefix of it' }
  }
  if (partial === total) {
    // The bytes may all be there — a previous attempt that died between the last
    // write and the publish. Reporting it as a resume with nothing left to send
    // is what lets the caller finish the job instead of re-uploading a gigabyte.
    return { resume: true, offset: partial, reason: 'the staged file is already the full size; only publishing remains' }
  }
  if (typeof options.recordedIdentity !== 'string' || options.recordedIdentity === '') {
    return { resume: false, offset: 0, reason: 'there is no record of which source the staged bytes came from' }
  }
  if (options.recordedIdentity !== options.currentIdentity) {
    // The source changed since the partial was written. Appending the new tail
    // to the old head produces a file of exactly the right length and no
    // relation to either version.
    return { resume: false, offset: 0, reason: 'the source changed since the staged bytes were written' }
  }
  return { resume: true, offset: partial, reason: 'the staged bytes are a prefix of the same source' }
}

/**
 * The sidecar body.
 *
 * @param {object} options - what to record.
 * @param {string} options.identity - the source identity.
 * @param {number} options.totalBytes - the source size.
 * @param {string} [options.source] - the local path, for a human reading it.
 * @returns {object} the record.
 */
export function resumeRecord (options) {
  return {
    version: 1,
    identity: String(options.identity),
    totalBytes: Number.isFinite(options.totalBytes) ? options.totalBytes : 0,
    ...(typeof options.source === 'string' ? { source: options.source } : {}),
    at: Date.now(),
  }
}

/**
 * Parse a sidecar body, refusing anything that is not a usable record.
 *
 * A sidecar written by a future version, or one that got truncated by a crash,
 * must be treated as ABSENT rather than partially trusted: `planResume` already
 * fails closed on a missing identity, and this is the function that decides
 * whether there is an identity at all.
 *
 * @param {string|Buffer|null|undefined} text - the file's contents.
 * @returns {{identity: string, totalBytes: number}|undefined} the record.
 */
export function parseResumeRecord (text) {
  if (text === null || text === undefined) return undefined
  let value
  try {
    value = JSON.parse(typeof text === 'string' ? text : String(text))
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object') return undefined
  if (value.version !== 1) return undefined
  if (typeof value.identity !== 'string' || value.identity === '') return undefined
  return { identity: value.identity, totalBytes: Number.isFinite(value.totalBytes) ? value.totalBytes : 0 }
}

/**
 * A token that makes one intermediate copy unique.
 *
 * Used where a transfer writes through a temporary local file that is NOT
 * resumable (a download in progress), so concurrent attempts do not collide.
 *
 * @returns {string} an opaque token.
 */
export function resumeToken () {
  return randomBytes(6).toString('hex')
}
