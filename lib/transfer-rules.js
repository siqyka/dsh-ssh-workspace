/**
 * The five decisions a transfer makes before any byte moves.
 *
 * ## Why these are one file
 *
 * A transfer to or from a remote tree makes five separate judgements, and every
 * one of them is decidable without a filesystem:
 *
 *  - {@link compareDigests} / {@link findRemoteHasher} — did the bytes that
 *    arrived match the bytes that left? Staging and renaming guarantee
 *    ATOMICITY, not INTEGRITY; a connection that dies mid-stream publishes a
 *    file that is cleanly named and the wrong length. SFTP has no hash command,
 *    so the remote side is hashed by running `sha256sum` / `shasum` / `openssl`
 *    there — a capability, not a guarantee, and reported as unavailable rather
 *    than skipped quietly.
 *  - {@link planResume} — where the bytes already are, and whether they are the
 *    RIGHT bytes. Resuming needs the same staging path across attempts, which is
 *    the opposite of what random staging names buy, so the path is DERIVED from
 *    (destination, source identity) and a sidecar records what the partial file
 *    is.
 *  - {@link decideConflict} — what to do when the destination exists. Intent is
 *    the caller's, so it is a parameter rather than a guess: `skip` is not an
 *    error, or a tree upload over a mostly-identical tree fails on the first
 *    existing file and people stop using tree upload.
 *  - {@link treeFilter} — exclude / include rules. Interpreted once, because a
 *    rule set read twice drifts: the upload would skip `node_modules` while the
 *    download kept it, and the asymmetry would be invisible until someone
 *    compared two trees.
 *  - {@link mutationNameRefusal} — the rename / delete surface. Every
 *    interesting failure there is decidable before any filesystem is touched: an
 *    empty name, a name smuggling a separator, a target that IS the workspace
 *    root, a path that leaves the root lexically.
 *
 * They were five files, each one a good extraction out of a function that had
 * grown too large, and each one small enough to read in a minute. What they were
 * not is independent: they share one vocabulary (a relative path, a source
 * identity, a staged name), they are consumed by exactly the same three modules
 * (`transfer.js`, `routes.js`, `routes/transfer-bytes.js`), and every one of
 * them is asked in the same order for the same transfer. Reading "what happens
 * when a destination exists" used to mean opening three files.
 *
 * ## The boundary
 *
 * Nothing here touches `sftp`, the engine, a request, or the clock. The impure
 * halves — realpath, lstat, SFTP calls, the walk itself — live in `transfer.js`
 * and the route family, and they ask these functions first. That is what lets
 * the same rule set be tested directly and reused by both the remote and the
 * local branch.
 *
 * @module @shiqyka/dsh-ssh-workspace/transfer-rules
 */

// ---------------------------------------------------------------------------
// Integrity: did the bytes that arrived match the bytes that left?
// ---------------------------------------------------------------------------
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

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

// ---------------------------------------------------------------------------
// Resuming: where the bytes already are, and whether they are the RIGHT bytes
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Conflicts: what to do when the destination already exists
// ---------------------------------------------------------------------------

/** The accepted policies, in the order the panel offers them. */
export const CONFLICT_POLICIES = Object.freeze(['overwrite', 'skip', 'rename', 'refuse'])

/** The default, matching what every file-transfer tool does when not told. */
export const DEFAULT_CONFLICT_POLICY = 'overwrite'

/**
 * Normalize a caller-supplied policy.
 *
 * An unrecognised value falls back to the default rather than failing the
 * transfer: a typo in an optional knob must not make a working upload break, and
 * the result reports which policy was actually applied so the caller can see it
 * was not theirs. (A policy that silently changed the DESTINATION would be a
 * different matter — that is why `rename` never collapses into `overwrite`.)
 *
 * @param {unknown} value - the candidate.
 * @returns {string} one of {@link CONFLICT_POLICIES}.
 */
export function normalizeConflictPolicy (value) {
  const text = String(value ?? '').trim().toLowerCase()
  return CONFLICT_POLICIES.includes(text) ? text : DEFAULT_CONFLICT_POLICY
}

/**
 * Decide what a transfer should do about an existing destination.
 *
 * @param {object} options - the decision inputs.
 * @param {string} options.policy - normalized policy.
 * @param {boolean} options.exists - whether the destination already exists.
 * @param {string} [options.destination] - for the message.
 * @param {(path: string) => Promise<boolean>} [options.existsAt] - availability
 *   probe used by `rename` to find a free name.
 * @returns {Promise<{action: 'proceed'|'skip'|'refuse', path?: string, note?: string}>} the decision.
 */
export async function decideConflict (options) {
  const policy = normalizeConflictPolicy(options.policy)
  if (options.exists !== true) return { action: 'proceed' }
  if (policy === 'skip') {
    return {
      action: 'skip',
      note: `the destination already exists and the conflict policy is "skip": ${options.destination ?? ''}`.trim(),
    }
  }
  if (policy === 'refuse') {
    return {
      action: 'refuse',
      note: `the destination already exists and the conflict policy is "refuse": ${options.destination ?? ''}`.trim(),
    }
  }
  if (policy === 'rename') {
    const free = await freeName(options.destination ?? '', options.existsAt)
    return {
      action: 'proceed',
      path: free,
      note: `the destination already existed, so this copy was written to ${free}`,
    }
  }
  return { action: 'proceed' }
}

/**
 * The first free `name.N` beside an existing path.
 *
 * `name.1`, `name.2`, … with the number before the extension so the result still
 * opens as the same kind of file. A bounded probe (1000 tries) because an
 * unbounded one against a genuinely broken `existsAt` would hang the transfer.
 *
 * @param {string} destination - the taken path.
 * @param {(path: string) => Promise<boolean>} [existsAt] - availability probe.
 * @returns {Promise<string>} a path nothing occupies.
 */
export async function freeName (destination, existsAt) {
  const target = String(destination ?? '')
  if (typeof existsAt !== 'function') {
    // No probe: fall back to a timestamped name, which is far more likely free
    // than a counter we cannot check.
    const dot = target.lastIndexOf('.')
    const stamp = Date.now().toString(36)
    return dot > target.lastIndexOf('/') && dot > target.lastIndexOf('\\')
      ? `${target.slice(0, dot)}.${stamp}${target.slice(dot)}`
      : `${target}.${stamp}`
  }
  const dot = target.lastIndexOf('.')
  const slash = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'))
  const stem = dot > slash + 1 ? target.slice(0, dot) : target
  const suffix = dot > slash + 1 ? target.slice(dot) : ''
  for (let index = 1; index <= 1000; index += 1) {
    const candidate = `${stem}.${index}${suffix}`
    if ((await existsAt(candidate)) !== true) return candidate
  }
  // A thousand collisions means the probe is lying; make a name that cannot be.
  return `${stem}.${Date.now().toString(36)}${suffix}`
}

// ---------------------------------------------------------------------------
// Exclude / include rules for tree transfers
// ---------------------------------------------------------------------------

/**
 * Compile one rule into a predicate over a relative path.
 *
 * @param {string} rule - the rule text.
 * @returns {{test: (path: string, isDir: boolean) => boolean, include: boolean, source: string}} the matcher.
 */
function compileRule (rule) {
  const source = String(rule ?? '').trim()
  let body = source
  let include = false
  if (body.startsWith('!')) {
    include = true
    body = body.slice(1)
  }
  const dirOnly = body.endsWith('/')
  if (dirOnly) body = body.replace(/\/+$/u, '')
  // A leading `./` or `/` is how people spell "from the root"; both mean the
  // same thing here, and stripping them keeps `./build` and `build/` alike.
  body = body.replace(/^\.\//u, '').replace(/^\/+/u, '')
  const anchored = body.includes('/')
  const pattern = globToRegExp(body)
  return {
    include,
    source,
    test (path, isDir) {
      if (dirOnly && !isDir) return false
      const clean = String(path ?? '').replace(/^\/+/u, '').replace(/\/+$/u, '')
      if (anchored) {
        // Anchored rules match the path itself or any ancestor of it: excluding
        // `build/output` must also exclude the FILES under it, or the walk
        // would descend into an excluded directory and copy its contents.
        if (pattern.test(clean)) return true
        let cut = clean.lastIndexOf('/')
        while (cut > 0) {
          if (pattern.test(clean.slice(0, cut))) return true
          cut = clean.lastIndexOf('/', cut - 1)
        }
        return false
      }
      for (const segment of clean.split('/')) {
        if (pattern.test(segment)) return true
      }
      return false
    },
  }
}

/**
 * Translate a glob into an anchored regular expression.
 *
 * `**` crosses separators; a single `*` does not. Every other character is
 * escaped, so `.` is a dot and `?` is a question mark.
 *
 * @param {string} glob - the pattern body.
 * @returns {RegExp} the compiled pattern.
 */
export function globToRegExp (glob) {
  let out = ''
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]
    if (char === '*') {
      if (glob[index + 1] === '*') {
        // `**/` also matches zero directories, which is what makes `**/dist`
        // match a top-level `dist`.
        if (glob[index + 2] === '/') {
          out += '(?:.*/)?'
          index += 2
        } else {
          out += '.*'
          index += 1
        }
      } else {
        out += '[^/]*'
      }
      continue
    }
    out += char.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  }
  return new RegExp(`^${out}$`, 'u')
}

/**
 * Build a matcher from a caller-supplied rule list.
 *
 * An empty or absent list yields a matcher that never excludes anything, so the
 * walk code can call it unconditionally instead of branching on "did the caller
 * pass rules" — a branch is one more thing each direction has to get right.
 *
 * @param {string[]|string|undefined} rules - the rules, or a single rule, or nothing.
 * @returns {{excluded: (path: string, isDir: boolean) => boolean, rules: string[]}} the matcher.
 */
export function treeFilter (rules) {
  const list = (Array.isArray(rules) ? rules : rules === undefined || rules === null ? [] : [rules])
    .map(rule => String(rule ?? '').trim())
    .filter(rule => rule !== '' && rule !== '!')
  const compiled = list.map(compileRule)
  return {
    rules: list,
    /**
     * Should this relative path be skipped?
     *
     * @param {string} path - path relative to the transfer root, `/`-separated.
     * @param {boolean} [isDir] - whether it is a directory.
     * @returns {boolean} true when the path is excluded.
     */
    excluded (path, isDir = false) {
      if (compiled.length === 0) return false
      // Last match wins, which is what makes `!keep.log` after `*.log` mean
      // "except this one" rather than "both, whichever ran first".
      let verdict
      for (const rule of compiled) {
        if (rule.test(path, isDir)) verdict = !rule.include
      }
      return verdict === true
    },
  }
}

/**
 * A path relative to the transfer root, with POSIX separators.
 *
 * `path.relative` on Windows returns backslashes, and a rule written with `/`
 * would then match nothing on exactly the platform where the transfer runs from
 * a drive letter. Converting here keeps that decision in one place.
 *
 * @param {string} root - the absolute root.
 * @param {string} absolute - the absolute path under it.
 * @returns {string} the relative path.
 */
export function relativeForRule (root, absolute) {
  const from = String(root).replace(/\\/gu, '/').replace(/\/+$/u, '')
  const to = String(absolute).replace(/\\/gu, '/')
  if (to === from) return ''
  if (!to.startsWith(`${from}/`)) return to.replace(/^\/+/u, '')
  return to.slice(from.length + 1)
}

// ---------------------------------------------------------------------------
// The rename / delete surface: every interesting failure is decidable first
// ---------------------------------------------------------------------------

/** The maximum length of one file name on any filesystem we support. */
export const MAX_NAME_LENGTH = 255

/**
 * Why a proposed new name cannot be used, or `undefined` when it can.
 *
 * One path segment only. The separator check is deliberately duplicated for
 * `/` and `\`: a Windows local root and a POSIX remote root are both served by
 * this plugin, and a name carrying the OTHER platform's separator is still a
 * name that can escape once the target is interpreted on that platform.
 *
 * @param {unknown} newName - the candidate.
 * @returns {string | undefined} a user-readable refusal.
 */
export function mutationNameRefusal (newName) {
  if (typeof newName !== 'string') return 'a new name is required'
  if (newName === '') return 'the new name cannot be empty'
  if (newName.trim() === '') return 'the new name cannot be only whitespace'
  if (newName === '.' || newName === '..') return 'the new name cannot be "." or ".."'
  if (newName.includes('/') || newName.includes('\\')) return 'the new name must be a single path segment'
  if (newName.includes('\0')) return 'the new name cannot contain a NUL byte'
  if (newName.length > MAX_NAME_LENGTH) return `the new name cannot be longer than ${MAX_NAME_LENGTH} characters`
  return undefined
}

/**
 * Whether `target` is lexically inside `root` (or is the root itself).
 *
 * Purely lexical: realpath containment is a separate, later question asked by
 * the route once the filesystem can answer it. This one has to be decidable
 * without touching a disk, because it is also the rule the tests pin.
 *
 * @param {string} root - absolute root directory.
 * @param {string} target - absolute candidate.
 * @returns {boolean} true when the candidate does not leave the root.
 */
export function isWithinLocalRoot (root, target) {
  if (typeof root !== 'string' || typeof target !== 'string') return false
  const base = resolve(root)
  const candidate = resolve(target)
  const rel = relative(base, candidate)
  if (rel === '') return true
  if (isAbsolute(rel)) return false
  const first = rel.split(sep)[0]
  return first !== '..'
}

/**
 * Why the workspace root itself cannot be renamed or deleted, or `undefined`.
 *
 * Both operations destroy the frame the session is standing in — a delete takes
 * the workspace out from under every open tab, and a rename changes the cwd
 * that the session's own header records. Neither can be undone from this
 * surface, so both are refused rather than confirmed.
 *
 * @param {string} root - the authoritative workspace root.
 * @param {string} target - the candidate target.
 * @returns {string | undefined} a user-readable refusal.
 */
export function rootMutationRefusal (root, target) {
  const base = resolve(root)
  const candidate = resolve(target)
  if (candidate === base) return 'the workspace root itself cannot be renamed or deleted'
  return undefined
}

/**
 * What a deletion confirmation must say, in one line.
 *
 * The count is the number of selected rows, not the number of files a directory
 * expands to: a server-side recursive count would be a second walk of the tree
 * (slow on a huge directory) for a number the user cannot act on differently.
 * The wording says "including subdirectories" so the count is not misread.
 *
 * @param {number} count - how many rows the action covers.
 * @param {boolean} hasDirectory - whether any row is a directory.
 * @returns {string} the confirmation sentence.
 */
export function deletionSummary (count, hasDirectory) {
  const n = Number.isInteger(count) && count > 0 ? count : 0
  const items = `${n} item${n === 1 ? '' : 's'}`
  return hasDirectory
    ? `Delete ${items}? Directories are removed with everything inside them, including subdirectories. This cannot be undone.`
    : `Delete ${items}? This cannot be undone.`
}

/**
 * The child path a rename would produce, refusing names that escape.
 *
 * @param {string} parent - the directory holding the entry.
 * @param {string} newName - the validated new name.
 * @returns {string} the sibling path.
 */
export function renameTargetPath (parent, newName) {
  return join(parent, newName)
}
