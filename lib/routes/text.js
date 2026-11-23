/**
 * Reading and writing one text file, on either half of the filesystem seam.
 *
 * The Host's file panel can only READ: `@deepseek-ai/dsh-api-workspace-files`
 * states outright that it has no modification operation, and every write it
 * does perform travels through `ctx.fs` on behalf of an agent tool. So the
 * browser needs a door of its own, and this is it — three routes, not two,
 * because the panel also had no way to ask "what does this file contain?".
 *
 * Two properties shape everything below.
 *
 * **One route, two fences.** `ssh://alias/path` and an absolute local path take
 * the same endpoint; the spelling decides the branch, exactly as rename and
 * delete already do. That is not a convenience: the panel's `absolutePath` is
 * produced by `ctx.fs.processPath(target)`, which yields the `ssh://` spelling
 * for a remote target and a plain path for a local one — one field, two worlds.
 *
 * **A save must not overwrite what the user did not see.** `version`
 * (`ino:size:mtime`) is cheap and blind to a same-size rewrite inside one
 * second; a content hash sees everything and costs a full read. Both are
 * checked, in that order, and the cheap one runs first so a stale save is
 * usually refused without reading a byte. There is deliberately no `force`
 * flag: overwriting is something the CLIENT does by re-reading and writing
 * again, so the server's check is never bypassable by a parameter someone
 * later wires up to a checkbox.
 *
 * @module @shiqyka/dsh-ssh-workspace/routes/text
 */

import { createHash, randomBytes } from 'node:crypto'
import { open, lstat, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  formatRemotePath,
  isRemotePath,
  isRemotePathUnder,
  normalizeRemotePath,
  parseRemotePath,
} from '../core/protocol.js'
import { KINDS } from '../core/diagnostics.js'
import { writeModeDenialReason } from '../core/mode-gate.js'
import { isWithinLocalRoot } from '../transfer/transfer-rules.js'
import {
  applyLiteralEdit,
  assertWithinRemoteRoots,
  detectLineEndings,
  normalizeLineEndings,
  restoreLineEndings,
  writeFenceRoots,
} from '../fs/remote-fs.js'
import {
  PAGE_BYTES,
  SAMPLE_BYTES,
  decodeBody,
  decodePage,
  decodeTruncated,
  encodeBody,
  fileFormatOf,
  isWritableEncoding,
} from './text-encoding.js'
import { codedError, queryParam, readJsonBody, refuseJsonBody, statusForActionError, trimmedParam, writeJson } from './kit.js'
import { ROUTES } from './routes.js'
import {
  assertLocalParentInside,
  assertMutationAllowed,
  assertRemoteFence,
  localRootOf,
  mutationContextOf,
  requireLocalTarget,
  requireRemoteParts,
} from './entries.js'

/**
 * The largest text file this feature will open or save.
 *
 * Two mebibytes is a judgement, not a technical limit: it is comfortably above
 * every source file, config and document a person edits in a panel, and far
 * below the size where a plain `<textarea>` starts dropping keystrokes. The
 * read route answers a larger file with `truncated: true` (so the preview can
 * still show its head) and the write route refuses it outright.
 */
export const EDIT_MAX_BYTES = 2 * 1024 * 1024

/**
 * Files at or under this size travel WITH their probe.
 *
 * The pencil button cannot be drawn until the probe answers, and the probe is a
 * stat + open + read + close of its own. For a small file that is the same four
 * serial waits the editor is about to pay again for the body, so the probe
 * answers with the body it already read and the editor starts from it. Larger
 * files keep the head-only probe: their body is not something a button should
 * pull before the user has clicked.
 */
export const PRELOAD_MAX_BYTES = 64 * 1024

/** The line-ending policies a save may ask for. */
const EOL_POLICIES = new Set(['auto', 'LF', 'CRLF'])

/** SHA-256 of one buffer, hex. The `revision` token. */
function digestOf (buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** A stale-version refusal that also carries the state the client must reload. */
function staleError (current) {
  const error = codedError('the file changed on disk since it was opened', 'FS_STALE_VERSION')
  error.current = current
  return error
}

/** The one refusal for a buffer over the editing limit, so its wording cannot drift. */
function tooLarge (target, bytes) {
  return codedError(
    `cannot save "${target}": ${bytes} bytes exceeds the ${EDIT_MAX_BYTES}-byte editing limit`,
    'FS_TOO_LARGE',
  )
}

/**
 * The version token for a LOCAL file.
 *
 * Deliberately the same `ino:size:mtime` shape the remote half uses, so a
 * client never has to know which branch produced the token it is holding. The
 * local stat carries milliseconds where SFTP carries whole seconds; that makes
 * the token finer, never coarser, and the `revision` check is what actually
 * decides a conflict.
 */
function localVersionOf (stats) {
  return `${stats.ino ?? 0}:${stats.size}:${Math.round(stats.mtimeMs ?? 0)}`
}

/**
 * Identify the session a read belongs to.
 *
 * `assertMutationAllowed` minus the mode gate, and that difference is the whole
 * point: a `read-only` session must be able to READ. What it must not be able
 * to do is name a workspace the server does not know it owns, so the session
 * check is kept.
 */
function assertReadable (ctx, body, target) {
  const resolved = mutationContextOf(ctx, body)
  if (resolved.session === undefined) {
    throw codedError(
      `cannot read "${target}": the server could not identify the session that owns this workspace, ` +
      'so it cannot prove the target is inside one. Open this workspace from a session, then retry.',
      'FS_PERMISSION_DENIED',
    )
  }
  return resolved
}

/** Reject a remote read/write target that is not inside a mounted root. */
function assertRemoteTextFence (router, parts) {
  if (router === undefined || router === null || !(router.roots instanceof Set)) {
    throw codedError('cannot reach a remote path: the filesystem router is not mounted', 'FS_PERMISSION_DENIED')
  }
  router.assertEnabled?.(parts.alias, parts.remotePath)
  // Not the rename/delete fence: its "the workspace root itself" refusal exists
  // because a root is a directory that must not be moved. A file target can
  // never be a root, and the sentence would only confuse whoever read it.
  assertWithinRemoteRoots(writeFenceRoots(router.roots, parts), parts)
}

/**
 * The shape check every request shares.
 *
 * `expected` is required and both halves must be strings. A request without it
 * is not "a write with no expectation" — it is a caller that would otherwise
 * overwrite whatever happens to be there, so it is refused rather than
 * defaulted.
 */
function requireExpected (body) {
  const expected = body?.expected
  if (expected === null || typeof expected !== 'object' || Array.isArray(expected)) {
    throw codedError('expected is required: send the version and revision the editor opened', 'FS_INVALID')
  }
  const version = expected.version
  const revision = expected.revision
  if (typeof version !== 'string' || version === '') {
    throw codedError('expected.version must be a non-empty string', 'FS_INVALID')
  }
  if (typeof revision !== 'string' || revision === '') {
    throw codedError('expected.revision must be a non-empty string', 'FS_INVALID')
  }
  return { version, revision }
}

/** Reject a line-ending policy that is not one of the three we accept. */
function requireEol (value) {
  if (value === undefined || value === null) return 'auto'
  if (typeof value !== 'string' || !EOL_POLICIES.has(value)) {
    throw codedError(`eol must be one of ${[...EOL_POLICIES].join(', ')}`, 'FS_INVALID')
  }
  return value
}

/** Reject a BOM flag that is neither a boolean nor absent. */
function requireBomFlag (value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw codedError('bom must be a boolean', 'FS_INVALID')
  return value
}

/**
 * Turn LF text into the bytes that will land on disk.
 *
 * The client never composes `\r\n` itself: the policy lives here, next to the
 * `detectLineEndings` that answers "auto", so a browser and the `edit` tool
 * cannot disagree about what a file's line endings are. The same is true of the
 * ENCODING — the caller passes back what the read reported, and the bytes come
 * out in the file's own encoding rather than always UTF-8. A file that opened
 * as UTF-16 and saved as UTF-8 would be damaged by a one-character edit, which
 * is precisely the failure this dimension exists to prevent.
 */
function encodeText (text, eol, bom, encoding) {
  const restored = restoreLineEndings(text, eol)
  return encodeBody(restored, encoding, bom)
}

/** Stat a remote target, refusing anything that is not a regular file. */
async function remoteStatOf (router, parts, signal) {
  const info = await router.stat({ targetKey: parts.displayPath, displayPath: parts.displayPath }, signal)
  if (info === undefined) throw codedError(`remote entry does not exist: ${parts.displayPath}`, 'FS_NOT_FOUND')
  if (info.type !== 'file') throw codedError(`cannot read "${parts.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  return info
}

/** Stat a local target, refusing anything that is not a regular file. */
async function localStatOf (target) {
  const info = await stat(target).catch((error) => {
    if (error?.code === 'ENOENT') throw codedError(`entry does not exist: ${target}`, 'FS_NOT_FOUND')
    throw error
  })
  if (!info.isFile()) throw codedError(`cannot read "${target}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  return info
}

/**
 * Read one remote file's bytes, or its head when it is over the limit.
 *
 * @returns {Promise<{raw: Buffer, truncated: boolean, size: number, version: string}>}
 */
async function readRemoteRaw (router, parts, limit, signal) {
  const info = await remoteStatOf(router, parts, signal)
  if (info.size > limit) {
    // Only the head is fetched. `readBytes` would refuse the whole read with
    // FS_TOO_LARGE, which is the right answer for a save and the wrong one for
    // a preview that only wants to show what the file is.
    const head = await router.readByteRange({ targetKey: parts.displayPath, displayPath: parts.displayPath }, { offset: 0, length: limit }, signal)
    return { raw: Buffer.from(head), truncated: true, size: info.size, version: info.version }
  }
  const raw = await router.readBytes({ targetKey: parts.displayPath, displayPath: parts.displayPath }, signal, limit)
  return { raw: Buffer.from(raw), truncated: false, size: info.size, version: info.version }
}

/** Read one local file's bytes, or its head when it is over the limit. */
async function readLocalRaw (target, limit) {
  const info = await localStatOf(target)
  const wanted = Math.min(info.size, limit)
  // Read exactly `wanted` bytes rather than the whole file and a slice: the
  // whole point of the limit is that a 2 GiB log must not be pulled into this
  // process just to show its first two mebibytes.
  const handle = await open(target, 'r')
  try {
    const buffer = Buffer.allocUnsafe(wanted)
    let filled = 0
    while (filled < wanted) {
      const { bytesRead } = await handle.read(buffer, filled, wanted - filled, filled)
      if (bytesRead === 0) break
      filled += bytesRead
    }
    return { raw: buffer.subarray(0, filled), truncated: info.size > limit, size: info.size, version: localVersionOf(info) }
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * Read one byte range of a remote file.
 *
 * Separate from {@link readRemoteRaw} because a page is not a prefix: it starts
 * anywhere, and the point of paging is that the bytes before it are never
 * fetched.
 *
 * @returns {Promise<{raw: Buffer, size: number, version: string}>}
 */
async function readRemoteRange (router, parts, offset, length, signal) {
  const info = await remoteStatOf(router, parts, signal)
  const raw = Buffer.from(await router.readByteRange(
    { targetKey: parts.displayPath, displayPath: parts.displayPath },
    { offset, length },
    signal,
  ))
  return { raw, size: info.size, version: info.version }
}

/** Read one byte range of a local file. */
async function readLocalRange (target, offset, length) {
  const info = await localStatOf(target)
  const wanted = Math.max(0, Math.min(length, info.size - offset))
  if (wanted === 0) return { raw: Buffer.alloc(0), size: info.size, version: localVersionOf(info) }
  const handle = await open(target, 'r')
  try {
    const buffer = Buffer.allocUnsafe(wanted)
    let filled = 0
    while (filled < wanted) {
      const { bytesRead } = await handle.read(buffer, filled, wanted - filled, offset + filled)
      if (bytesRead === 0) break
      filled += bytesRead
    }
    return { raw: buffer.subarray(0, filled), size: info.size, version: localVersionOf(info) }
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * Decode one read into the shape every route and the editor share.
 *
 * `text` is BOM-free and LF-normalised, and the facts it was derived from
 * travel beside it: `eol`, `bom` and `encoding`. A save that echoes those back
 * reproduces the file it read; a save that ignores them writes the same
 * characters with different bytes, which is exactly the "first save silently
 * rewrote every line" failure this shape exists to prevent — and, with
 * `encoding` in it, the "first save converted the whole file to UTF-8" failure
 * too.
 */
function describeRead (raw, truncated, size, version, displayPath) {
  const format = fileFormatOf(raw, { truncated })
  if (format.reason !== undefined) throw notTextError(displayPath, format)
  const decoded = truncated ? decodeTruncated(raw, format.encoding) : decodeBody(raw, format.encoding)
  return {
    text: normalizeLineEndings(decoded),
    // Detected on the DECODED text rather than the raw bytes, because that is
    // what `editText` does: one function deciding "what are this file's line
    // endings" for both paths is the only way a save through the editor and a
    // save through the `edit` tool can agree about the same file.
    eol: detectLineEndings(decoded),
    encoding: format.encoding,
    bom: format.bom,
    // A truncated read describes a PREFIX, so a hash of it would claim a whole
    // file it never saw. Null rather than a misleading token: the write route
    // requires a string, so a truncated buffer cannot be saved at all.
    revision: truncated ? null : digestOf(raw),
    version,
    size,
    truncated,
  }
}

/**
 * The probe: "could this file be edited, and if not, why not?".
 *
 * Separate from a full read because the button is rendered for every file the
 * user previews. Answering it with a whole file would double every preview's
 * transfer over SFTP just to decide whether to draw a control; the head is
 * enough, because the rules it applies (a NUL byte, valid UTF-8, a size cap)
 * are all head-and-size questions.
 *
 * A read-only session is a reason too, and it is checked FIRST: telling
 * someone their file is too large when the real answer is "this session cannot
 * write anything" sends them looking for a smaller file that will not help.
 */
async function probeRemote (router, parts, signal, mode) {
  const info = await router.stat({ targetKey: parts.displayPath, displayPath: parts.displayPath }, signal)
  if (info === undefined) throw codedError(`remote entry does not exist: ${parts.displayPath}`, 'FS_NOT_FOUND')
  if (info.type !== 'file') return { editable: false, reason: 'not-file', size: info.size, version: info.version }
  const readonly = readOnlyReason(mode)
  if (readonly !== undefined) return { editable: false, reason: readonly, size: info.size, version: info.version }
  // A small file is read whole: the editor would immediately ask for exactly
  // these bytes, so a head-then-body pair would double the serial waits for the
  // common preview→edit path. Only `editable` files carry the text back.
  const wanted = info.size <= PRELOAD_MAX_BYTES ? info.size : SAMPLE_BYTES
  const raw = wanted === 0
    ? Buffer.alloc(0)
    : Buffer.from(await router.readByteRange({ targetKey: parts.displayPath, displayPath: parts.displayPath }, { offset: 0, length: wanted }, signal))
  const shape = probeShape(raw, info.size)
  if (shape.editable !== true || wanted !== info.size) return { ...shape, version: info.version }
  return { ...shape, version: info.version, preload: preloadOf(raw, info.size, info.version, parts.displayPath) }
}

/** The probe for a local path. */
async function probeLocal (target, mode) {
  const info = await stat(target).catch((error) => {
    if (error?.code === 'ENOENT') throw codedError(`entry does not exist: ${target}`, 'FS_NOT_FOUND')
    throw error
  })
  if (!info.isFile()) return { editable: false, reason: 'not-file', size: info.size, version: localVersionOf(info) }
  const readonly = readOnlyReason(mode)
  if (readonly !== undefined) return { editable: false, reason: readonly, size: info.size, version: localVersionOf(info) }
  // Only the sample is read, not the file: a probe runs for EVERY previewed
  // file, and reading a 200 MiB log to decide whether to draw a button made
  // merely scrolling the tree pull it through this process. A file small
  // enough to preload is the exception — the editor is about to read it.
  const wanted = Math.min(info.size, info.size <= PRELOAD_MAX_BYTES ? info.size : SAMPLE_BYTES)
  const buffer = Buffer.allocUnsafe(wanted)
  let filled = 0
  if (wanted > 0) {
    const handle = await open(target, 'r')
    try {
      while (filled < wanted) {
        const { bytesRead } = await handle.read(buffer, filled, wanted - filled, filled)
        if (bytesRead === 0) break
        filled += bytesRead
      }
    } finally {
      await handle.close().catch(() => {})
    }
  }
  const version = localVersionOf(info)
  const shape = probeShape(buffer.subarray(0, filled), info.size)
  if (shape.editable !== true || wanted !== info.size) return { ...shape, version }
  return { ...shape, version, preload: preloadOf(buffer.subarray(0, filled), info.size, version, target) }
}

/**
 * The body a probe can hand to the editor, in the same shape a read returns.
 *
 * A file that passes `probeShape` is text we can decode, so a failure here is
 * a contradiction rather than a user-facing refusal: the preload is an
 * optimisation, and the editor still knows how to fetch the body itself.
 */
function preloadOf (raw, size, version, displayPath) {
  try {
    const read = describeRead(raw, false, size, version, displayPath)
    return {
      text: read.text,
      eol: read.eol,
      encoding: read.encoding,
      bom: read.bom,
      revision: read.revision,
      version,
      size,
    }
  } catch {
    return undefined
  }
}

/**
 * Whether this session may write at all, as a probe reason.
 *
 * `writeModeRefusal` is the same gate the save route applies, so the button and
 * the server cannot disagree: a mode this plugin does not recognise refuses a
 * save, and it therefore also has to hide the button.
 */
function readOnlyReason (mode) {
  // Two denial causes, two copy keys: a mode the plugin cannot read must not be
  // reported as "the user is in a read-only session", because switching to a
  // writable mode cannot fix it.
  return writeModeDenialReason(mode)
}

/**
 * The two rules a probe applies, in the order the user would hit them.
 *
 * `reason` is a CODE, not a sentence: the panel turns it into localised copy,
 * and a server-side English sentence would arrive in a Chinese UI.
 *
 * `not-encodable` is the third rule and it is about WRITING, not reading: a
 * GB18030 file displays fine, but this plugin can decode one and cannot encode
 * one, so an edit would have to save it as UTF-8 and convert the whole file.
 * Refusing the button is the honest answer; discovering it at save time is not.
 */
function probeShape (raw, size) {
  // A sample is truncated only when it is SHORTER than the file. Deriving the
  // answer from the bytes in hand (rather than from `size > SAMPLE_BYTES`)
  // matters now that a small probe carries the whole file: calling a complete
  // 9 KiB body a truncated 8 KiB head would apply the boundary-repair rule to a
  // tail that is real data.
  const format = fileFormatOf(raw, { truncated: raw.length < size })
  if (format.reason !== undefined) return { editable: false, reason: format.reason, size }
  if (size > EDIT_MAX_BYTES) {
    // Too large to EDIT, not too large to read: `paged` tells the panel it can
    // still open a read-only window onto the file, one page at a time.
    return { editable: false, reason: 'too-large', paged: true, encoding: format.encoding, size }
  }
  if (!isWritableEncoding(format.encoding)) {
    return { editable: false, reason: 'not-encodable', encoding: format.encoding, size }
  }
  return { editable: true, reason: null, encoding: format.encoding, size }
}

/**
 * The one sentence every "this is not text" refusal uses, so a preview, a paged
 * read and a save cannot describe the same file differently.
 */
function notTextError (displayPath, format) {
  const what = format.reason === 'binary'
    ? `binary file (a NUL byte in the first ${SAMPLE_BYTES} bytes)`
    : 'neither UTF-8 nor GB18030 text'
  return codedError(`cannot read "${displayPath}": ${what}`, 'FS_NOT_TEXT')
}

/**
 * One page of a file too large to open whole.
 *
 * The caller passes three closures rather than a target, so the remote and local
 * branches differ only in how bytes arrive, never in how a page is decided.
 *
 * The encoding and the line endings are taken from the FIRST page and echoed
 * back by the client, and this function only re-derives them when it was not
 * told. That is not caching for speed: a page from the middle of a file has no
 * BOM and can be valid UTF-8 by accident while the file is GB18030, so sniffing
 * each page independently would decode the same file differently halfway down.
 *
 * A page is never saveable — `revision` is null and `paged` says why — so the
 * small licence taken by cutting on a byte boundary cannot reach a write.
 */
async function pageOutcome ({ describe, statOnce, readRange, offset, encoding, eol }) {
  const info = await statOnce()
  const size = info.size
  let at = Number.isInteger(offset) ? offset : 0
  at = Math.max(0, Math.min(at, size))
  let known = encoding
  let endings = eol
  if (known === undefined || endings === undefined) {
    const head = await readRange(0, Math.min(SAMPLE_BYTES, size))
    const format = fileFormatOf(head, { truncated: size > SAMPLE_BYTES })
    if (format.reason !== undefined) throw notTextError(describe, format)
    if (known === undefined) known = format.encoding
    if (endings === undefined) endings = detectLineEndings(decodeTruncated(head, format.encoding))
  }
  // A UTF-16 offset landing inside a code unit decodes as replacement
  // characters, so step back to the boundary instead of refusing the request.
  // The BOM is two bytes, so the parity of a boundary is the same either way.
  if ((known === 'utf16le' || known === 'utf16be') && at % 2 !== 0) at -= 1
  const wanted = Math.min(PAGE_BYTES, Math.max(0, size - at))
  const raw = wanted > 0 ? await readRange(at, wanted) : Buffer.alloc(0)
  const page = decodePage(raw, known, { first: at === 0 })
  const nextOffset = at + page.consumed
  return {
    paged: true,
    text: normalizeLineEndings(page.text),
    encoding: known,
    eol: endings,
    offset: at,
    nextOffset,
    pageBytes: PAGE_BYTES,
    // `partial` rather than `truncated`: this page is part of a file the caller
    // can page through, not a head that was all we were willing to send.
    partial: nextOffset < size,
    revision: null,
    version: info.version,
    size,
  }
}

/**
 * Recover the `ssh://` spelling of a bare remote path.
 *
 * The document preview hands us `ctx.fs.processPath(target)`, and for a remote
 * target that function deliberately answers the REMOTE POSIX path — the path the
 * remote process itself would use — not the `ssh://` spelling. That is the
 * correct answer for `open in app`, for a terminal, and for anything that runs
 * on the far side; it is NOT a name this route can fence, because the alias
 * lives only in the `ssh://` form.
 *
 * So a bare absolute path is matched back against the session's own workspace
 * root. Both halves are POSIX strings by then, so the comparison is exact
 * (normalised, no realpath): a path that is not under the root cannot belong to
 * a remote session and is refused below rather than guessed at.
 *
 * A local session never reaches here: `localRootOf` answers a host path, which
 * is not a remote root, so `remoteRootOf` is undefined and the local branch
 * keeps every path exactly as it was given.
 *
 * @param {string} target - the path the request named.
 * @param {object} owner - the resolved session context.
 * @returns {string} the `ssh://` spelling when one can be proven, else `target`.
 */
function remoteSpellingOf (target, owner, roots) {
  if (isRemotePath(target)) return target
  // A remote path is POSIX by definition; `node:path`'s `isAbsolute` on Windows
  // would reject `/home/x` for having no drive letter, so this test is local.
  if (!target.startsWith('/')) return target
  const normalized = normalizeRemotePath(target)

  const own = remoteRootOf(owner)
  if (own !== undefined && isRemotePathUnder(own.remotePath, normalized)) {
    return formatRemotePath(own.alias, normalized)
  }

  // Not under the session's own root — the preview can be showing a file from a
  // DIFFERENT mounted root (the Files tab browses every mount). Match it against
  // the mounts instead, but only when the answer is unambiguous: two aliases can
  // both hold `/home/x`, and picking one would silently edit the wrong machine.
  const aliases = new Set()
  for (const root of roots ?? []) {
    if (!isRemotePath(root)) continue
    let parts
    try {
      parts = parseRemotePath(root)
    } catch {
      continue
    }
    if (parts === undefined) continue
    if (isRemotePathUnder(parts.remotePath, normalized)) aliases.add(parts.alias)
  }
  if (aliases.size !== 1) return target
  const [alias] = aliases
  return formatRemotePath(alias, normalized)
}

/**
 * The session's workspace root, when that root is remote.
 *
 * Deliberately reads the SAME two fields `localRootOf` does, so the two halves
 * cannot disagree about which root a session owns.
 *
 * @param {object} owner - the resolved session context.
 * @returns {{alias: string, remotePath: string} | undefined}
 */
function remoteRootOf (owner) {
  const root = owner?.policy?.workspaceRoot
    ?? (typeof owner?.session?.header?.cwd === 'string' ? owner.session.header.cwd : undefined)
  if (typeof root !== 'string' || !isRemotePath(root)) return undefined
  try {
    return parseRemotePath(root)
  } catch {
    return undefined
  }
}

/** Resolve the branch every route shares: session, fence, and the target parts. */
async function contextFor (ctx, router, body, verb, target) {
  const owner = verb === 'read'
    ? assertReadable(ctx, body, target)
    : assertMutationAllowed(ctx, body, target, verb)
  // The preview names a remote file by its REMOTE path; recover the alias from
  // the session's own root (or the mounted roots) before deciding which branch
  // this is. See `remoteSpellingOf`.
  const resolved = remoteSpellingOf(target, owner, router?.roots)
  if (isRemotePath(resolved)) {
    const parts = requireRemoteParts(resolved)
    assertRemoteTextFence(router, parts)
    return { owner, target: resolved, parts, remote: true }
  }
  const local = requireLocalTarget(resolved)
  const root = localRootOf(owner)
  if (!isWithinLocalRoot(root, local)) {
    throw codedError(`cannot ${verb} "${local}": outside the session workspace ${root}`, 'FS_OUTSIDE_WORKSPACE')
  }
  // The resolved-shape fence runs BEFORE the file is read, not after the
  // version check: a path that reaches the outside through a junction must be
  // refused without this process first pulling the outside file's bytes into
  // memory and handing them back as `text`.
  if (verb !== 'read') await assertLocalWriteFence(root, local)
  return { owner, root, local, remote: false }
}

/**
 * Prove a local target's PARENT resolves inside the root, and that the file
 * itself does too when it is not a symlink.
 *
 * The same two-step `renameLocalEntry` performs: lexical containment cannot see
 * a junction, and `realpath` alone cannot tell "this file is a link the user
 * pointed at" from "this file is a link out of the workspace". A symlink whose
 * target is outside is refused rather than followed, because following it would
 * write somewhere the user never named.
 *
 * `lstat` rather than `stat` for the link test: `stat` follows, so it can never
 * answer `isSymbolicLink()` and the check would quietly become a no-op.
 */
async function assertLocalWriteFence (root, target) {
  const realRoot = await realpath(root)
  await assertLocalParentInside(realRoot, target)
  const info = await lstat(target).catch(() => undefined)
  if (info === undefined) return
  if (info.isSymbolicLink()) {
    const realTarget = await realpath(target)
    if (!isWithinLocalRoot(realRoot, realTarget)) {
      throw codedError(`cannot write "${target}": the resolved path is outside ${root}`, 'FS_OUTSIDE_WORKSPACE')
    }
    return
  }
  if (!info.isFile()) throw codedError(`cannot write "${target}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  const realTarget = await realpath(target)
  if (!isWithinLocalRoot(realRoot, realTarget)) {
    throw codedError(`cannot write "${target}": the resolved path is outside ${root}`, 'FS_OUTSIDE_WORKSPACE')
  }
}

/**
 * Publish local content the way the remote half does: stage a sibling, then
 * rename over the target.
 *
 * A plain `writeFile` truncates first, so a crash mid-write leaves half a file
 * where the user's document was. The rename is atomic within one directory, and
 * the staging name is dot-prefixed and random so two saves of the same file
 * cannot collide.
 */
async function publishLocal (target, buffer, mode) {
  const staging = join(dirname(target), `.${basename(target)}.dsh-tmp-${randomBytes(6).toString('hex')}`)
  try {
    await writeFile(staging, buffer, mode === undefined ? undefined : { mode })
    await rename(staging, target)
  } catch (error) {
    await unlink(staging).catch(() => {})
    throw error
  }
}

/**
 * The one save path both write routes funnel through.
 *
 * `build` receives the current LF-normalised text and returns the text to
 * write. `write-text` returns the body's own text; `edit-text` applies a
 * literal replacement. Everything else — the two-token check, the line-ending
 * resolution, the size cap, the fence, the audit — happens once, so the two
 * routes cannot drift.
 */
async function saveText ({ engine, router, ctx, body, verb, build }) {
  const target = typeof body?.path === 'string' ? body.path : ''
  if (target === '') throw codedError('path is required', 'FS_INVALID')
  const expected = requireExpected(body)
  const eolPolicy = requireEol(body?.eol)
  const bomFlag = requireBomFlag(body?.bom)
  const context = await contextFor(ctx, router, body, verb, target)
  const signal = undefined

  // The size of what was SENT is known before anything is read, so a request
  // that is already too large is refused without pulling the current file over
  // SFTP first. The final buffer is checked again below, because `edit-text`
  // grows the text by whatever its replacement adds.
  if (typeof body?.text === 'string' && Buffer.byteLength(body.text, 'utf8') > EDIT_MAX_BYTES) {
    throw tooLarge(target, Buffer.byteLength(body.text, 'utf8'))
  }

  const current = context.remote
    ? await readRemoteRaw(router, context.parts, EDIT_MAX_BYTES + 1, signal)
    : await readLocalRaw(context.local, EDIT_MAX_BYTES + 1)
  // The limit is enforced while READING, not after: with the previous
  // `MAX_SAFE_INTEGER` this line pulled the whole file into memory and only
  // then discovered it was too large to edit, so one save of a multi-gigabyte
  // log could balloon the host process just to answer 413. A `truncated` read
  // means the file is over the editing limit, and "too large" is the final
  // answer for a save — there is no useful head to merge into.
  if (current.truncated) throw tooLarge(target, current.size)

  // The cheap check first: a stale `version` is refused without decoding, and
  // without reading anything the caller could mistake for the current file.
  if (current.version !== expected.version) {
    const revision = current.truncated ? null : digestOf(current.raw)
    throw staleError({ version: current.version, revision })
  }
  const currentRevision = digestOf(current.raw)
  if (currentRevision !== expected.revision) {
    throw staleError({ version: current.version, revision: currentRevision })
  }

  const described = describeRead(current.raw, false, current.size, current.version, target)
  const nextText = build(described.text)
  const eol = eolPolicy === 'auto' ? described.eol : eolPolicy
  const bom = bomFlag === undefined ? described.bom : bomFlag
  const buffer = encodeText(nextText, eol, bom, described.encoding)
  if (buffer.length > EDIT_MAX_BYTES) throw tooLarge(target, buffer.length)

  if (context.remote) {
    // The router re-checks the version inside `#publish`'s caller and refuses
    // with FS_STALE_VERSION when the file moved between our read and this call,
    // which closes the window a separate check-then-write would leave open.
    if (described.encoding === 'utf8') {
      await router.writeText(
        { targetKey: context.parts.displayPath, displayPath: context.parts.displayPath },
        buffer.toString('utf8'),
        { kind: 'replaceIfVersion', version: current.version },
        signal,
        context.owner.policy,
      )
    } else {
      // Any other encoding has to travel as BYTES: `writeText` takes a string
      // and encodes UTF-8, which would convert the file on its first save.
      await router.writeTextBytes(
        { targetKey: context.parts.displayPath, displayPath: context.parts.displayPath },
        buffer,
        { kind: 'replaceIfVersion', version: current.version },
        signal,
        context.owner.policy,
      )
    }
  } else {
    await assertLocalWriteFence(context.root, context.local)
    const info = await stat(context.local).catch(() => undefined)
    await publishLocal(context.local, buffer, info?.mode)
  }

  const after = context.remote
    ? await readRemoteRaw(router, context.parts, EDIT_MAX_BYTES + 1, signal)
    : await readLocalRaw(context.local, EDIT_MAX_BYTES + 1)
  if (after.truncated) throw tooLarge(target, after.size)
  const revision = digestOf(after.raw)
  auditWrite(engine, context, target, buffer.length, `saved ${buffer.length} bytes`)
  // The resolved spelling, for the same reason the read echoes it: the client
  // holds one token pair per path and must not end up with two names for one
  // file after a save that took the bare remote form.
  return { path: context.remote ? context.target : target, version: after.version, revision, bytes: buffer.length, eol, bom }
}

/**
 * Record one save.
 *
 * The path, the size and the outcome — never the text. A log that quotes the
 * file it wrote turns every saved secret into a second copy of that secret, and
 * the ring is exported in the support bundle.
 */
function auditWrite (engine, context, target, bytes, outcome) {
  const alias = context.remote ? context.parts.alias : 'local'
  try {
    engine?.diagnostics?.record?.(KINDS.write, `${outcome} to ${target}`, { alias })
  } catch { /* a log that can fail the save it describes is worse than no log */ }
}

/** Record one refused save, for the same reason the success path records. */
function auditRefusal (engine, body, error) {
  const target = typeof body?.path === 'string' ? body.path : '(no path)'
  const reason = error instanceof Error ? error.message : String(error)
  try {
    engine?.diagnostics?.record?.(KINDS.write, `refused to save ${target}: ${reason}`, {})
  } catch { /* see above */ }
}

/**
 * Build the three text routes.
 *
 * @param {{engine: object, router: object, ctx: object, guard: Function}} deps
 * @returns {Array<{kind: string, path: string, handler: Function}>}
 */
/**
 * A file above the editing cap is not a dead end: it is served one page at a
 * time, read-only. These are the encodings a paged read will accept from the
 * client — the same set the sniffer can report.
 */
const PAGE_ENCODINGS = new Set(['utf8', 'utf16le', 'utf16be', 'gb18030'])

export function textRoutes ({ engine, router, ctx, guard }) {
  /** Parse `maxBytes`, clamped to the editing cap. */
  const readLimitOf = (url) => {
    const raw = queryParam(url, 'maxBytes')
    if (raw === undefined || raw === '') return EDIT_MAX_BYTES
    const parsed = Number(raw)
    if (!Number.isInteger(parsed) || parsed <= 0) return undefined
    return Math.min(parsed, EDIT_MAX_BYTES)
  }

  /** `offset` names the page: absent means "read the file", which is the old route. */
  const pageOffsetOf = (url) => {
    const raw = queryParam(url, 'offset')
    if (raw === undefined || raw === '') return undefined
    const parsed = Number(raw)
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
  }

  /** The encoding the client carried over from the first page. */
  const pageEncodingOf = (url) => {
    const raw = trimmedParam(url, 'encoding')
    if (raw === '') return undefined
    return PAGE_ENCODINGS.has(raw) ? raw : null
  }

  /** The line endings the client carried over from the first page. */
  const pageEolOf = (url) => {
    const raw = trimmedParam(url, 'eol')
    if (raw === '') return undefined
    return raw === 'LF' || raw === 'CRLF' ? raw : null
  }

  return [
    // ---- read one text file (with the tokens a save will need)
    {
      kind: 'exact',
      path: ROUTES.readText,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const target = trimmedParam(url, 'path')
        const limit = readLimitOf(url)
        if (target === '') { writeJson(res, 400, { error: 'path query parameter is required' }); return }
        if (limit === undefined) { writeJson(res, 400, { error: `maxBytes must be a positive integer, at most ${EDIT_MAX_BYTES}` }); return }
        const selector = { sessionId: trimmedParam(url, 'sessionId') || undefined, root: trimmedParam(url, 'root') || undefined }
        const probing = trimmedParam(url, 'probe') === '1'
        const offset = pageOffsetOf(url)
        if (offset === null) { writeJson(res, 400, { error: 'offset must be a non-negative integer' }); return }
        const encoding = pageEncodingOf(url)
        if (encoding === null) { writeJson(res, 400, { error: `encoding must be one of ${[...PAGE_ENCODINGS].join(', ')}` }); return }
        const eol = pageEolOf(url)
        if (eol === null) { writeJson(res, 400, { error: 'eol must be LF or CRLF' }); return }
        try {
          const context = await contextFor(ctx, router, selector, 'read', target)
          // Echo the RESOLVED spelling, not the request's. When the preview
          // names a remote file by its remote POSIX path, the answer carries the
          // `ssh://` form so the client can tell the two worlds apart without
          // re-deriving the alias. For a local target the two are identical.
          const resolvedPath = context.remote ? context.target : target
          if (probing) {
            const probe = context.remote
              ? await probeRemote(router, context.parts, undefined, context.owner.mode)
              : await probeLocal(context.local, context.owner.mode)
            writeJson(res, 200, { ok: true, path: resolvedPath, probe: true, ...probe, maxBytes: EDIT_MAX_BYTES })
            return
          }
          if (offset !== undefined) {
            const outcome = await pageOutcome({
              describe: resolvedPath,
              statOnce: async () => (context.remote
                ? remoteStatOf(router, context.parts, undefined)
                : localStatOf(context.local)),
              readRange: async (at, length) => (context.remote
                ? (await readRemoteRange(router, context.parts, at, length, undefined)).raw
                : (await readLocalRange(context.local, at, length)).raw),
              offset,
              encoding,
              eol,
            })
            writeJson(res, 200, { ok: true, path: resolvedPath, ...outcome, maxBytes: EDIT_MAX_BYTES })
            return
          }
          const current = context.remote
            ? await readRemoteRaw(router, context.parts, limit, undefined)
            : await readLocalRaw(context.local, limit)
          const described = describeRead(current.raw, current.truncated, current.size, current.version, resolvedPath)
          writeJson(res, 200, { ok: true, path: resolvedPath, ...described, maxBytes: EDIT_MAX_BYTES })
        } catch (error) {
          writeJson(res, statusForActionError(error, 500), { ok: false, error: error instanceof Error ? error.message : String(error), code: error?.code })
        }
      },
    },
    // ---- save the whole buffer
    {
      kind: 'exact',
      path: ROUTES.writeText,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (refuseJsonBody(res, body)) return
        try {
          if (typeof body?.text !== 'string') throw codedError('text must be a string', 'FS_INVALID')
          const outcome = await saveText({ engine, router, ctx, body, verb: 'write', build: () => body.text })
          writeJson(res, 200, { ok: true, ...outcome })
        } catch (error) {
          auditRefusal(engine, body, error)
          writeStaleOrError(res, error)
        }
      },
    },
    // ---- replace one literal occurrence inside the file
    //
    // No UI drives this yet; it exists because the `edit` tool's semantics are
    // the ones a "replace this line" affordance would need, and expressing them
    // once here keeps a future caller from re-deriving them in the browser.
    {
      kind: 'exact',
      path: ROUTES.editText,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (refuseJsonBody(res, body)) return
        try {
          const edit = body?.edit
          if (edit === null || typeof edit !== 'object' || Array.isArray(edit)) {
            throw codedError('edit must be an object with oldText and newText', 'FS_INVALID')
          }
          if (typeof edit.oldText !== 'string' || edit.oldText === '') {
            throw codedError('edit.oldText must be a non-empty string', 'FS_INVALID')
          }
          if (typeof edit.newText !== 'string') throw codedError('edit.newText must be a string', 'FS_INVALID')
          if (edit.replaceAll !== undefined && edit.replaceAll !== null && typeof edit.replaceAll !== 'boolean') {
            throw codedError('edit.replaceAll must be a boolean', 'FS_INVALID')
          }
          const outcome = await saveText({
            engine,
            router,
            ctx,
            body,
            verb: 'edit',
            build: current => applyLiteralEdit(current, edit.oldText, edit.newText, edit.replaceAll === true, String(body?.path ?? '')).content,
          })
          writeJson(res, 200, { ok: true, ...outcome })
        } catch (error) {
          auditRefusal(engine, body, error)
          writeStaleOrError(res, error)
        }
      },
    },
  ]
}

/**
 * Answer a save failure.
 *
 * A conflict is not an ordinary error: the client needs the state that won, or
 * its only recovery is to reload blindly. So 409 carries `current`, and every
 * other failure goes through the shared mapper.
 */
function writeStaleOrError (res, error) {
  if (error?.code === 'FS_STALE_VERSION') {
    writeJson(res, 409, {
      ok: false,
      error: 'stale',
      code: 'FS_STALE_VERSION',
      current: error.current ?? null,
    })
    return
  }
  writeJson(res, statusForActionError(error, 500), {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    code: error?.code,
    ...(typeof error?.readOnlyReason === 'string' ? { readOnlyReason: error.readOnlyReason } : {}),
  })
}
