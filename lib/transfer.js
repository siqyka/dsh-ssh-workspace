/**
 * Move file bytes between this machine and a remote host without putting them
 * through the model.
 *
 * The plugin already has two ways to touch remote files: the `ssh://` file
 * tools run one file at a time through the filesystem seam, and
 * `ssh_workspace_exec` runs a shell. Neither moves a file's bytes efficiently —
 * a file tool forces the content through the conversation, and a shell needs a
 * quoting-safe base64 pipeline the model has to get right. A development
 * workflow constantly hits the gap: push a build artifact up, pull a log or a
 * generated asset down.
 *
 * Both directions stream in chunks, so a large file costs bounded memory. An
 * upload stages into a sibling temp name and renames on completion, so a reader
 * never observes a half-written file — the same publication discipline the
 * filesystem half uses for `write`.
 *
 * @module @shiqyka/dsh-ssh-workspace/transfer
 */

import { randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'

import { formatRemotePath, normalizeRemotePath } from './protocol.js'
import { decideConflict, normalizeConflictPolicy } from './conflict-policy.js'
import { planResume, parseResumeRecord, resumeRecord, resumableStagingName, resumeSidecarName, sourceIdentity } from './resume.js'
import { compareDigests, findRemoteHasher, hashLocalFile, hashRemoteFile } from './verify.js'
import {
  assertFencedRealpath,
  assertWithinRemoteRoots,
  sftpCloseHandle,
  sftpMkdirp,
  sftpOpenHandle,
  sftpPublishRename,
  sftpReadHandle,
  sftpStatOrNull,
  sftpWriteHandle,
  writeFenceRoots,
} from './remote-fs.js'

/** SFTP read chunk, matching the filesystem half's own transfer size. */
const CHUNK_BYTES = 256 * 1024

/**
 * A staging name that two concurrent transfers cannot share.
 *
 * The old name was `pid + Date.now().toString(36)`. Two uploads to the same
 * destination started in the same millisecond — the panel's upload button
 * double-clicked, or a tree upload running beside a single-file upload — got
 * the SAME staging path, opened it `'w'`, and interleaved their bytes; worse,
 * the loser's failure cleanup deleted the file the winner was still writing.
 *
 * A random suffix makes a collision improbable; `'wx'` (O_EXCL) makes it
 * impossible to act on one silently. The two halves are complementary on
 * purpose: randomness avoids the retry, exclusivity turns a rare collision into
 * a retry instead of corruption.
 *
 * @param {string} target - the destination the staging file sits beside.
 * @param {'up'|'down'} direction - which transfer this is, for the name.
 * @returns {string} a staging path.
 */
export function stagingNameOf (target, direction) {
  const token = randomBytes(8).toString('hex')
  return `${String(target).replace(/\/+$/u, '')}.dsh-${direction}-${process.pid}-${Date.now().toString(36)}-${token}`
}

/** Refuse a single transfer larger than this. */
const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024

/**
 * The reachability fence for one upload destination, shared with the filesystem
 * half.
 *
 * Why the upload path needs it AT ALL: `ssh_workspace_transfer` does not travel
 * through `ctx.fs`, so the router's write fence never sees it. Measured before
 * this existed, an upload whose parent directory was a symlink pointing outside
 * every mounted root landed its bytes there happily, while `write` to the same
 * spelling was refused with `FS_OUTSIDE_WORKSPACE` — the divergence the docs
 * promise does not exist ("两条写路径不会分叉"). Both halves of the router's
 * fence are therefore applied here: the lexical mounted-root check, and the
 * server `realpath` check that catches the link the lexical one cannot see.
 *
 * Both halves are consulted against {@link writeFenceRoots}, so the host's temp
 * area is reachable exactly as it is for `write` — the local sandbox lists a
 * constant `/tmp` in `writableRoots`, and a build artifact staged in `/tmp`
 * must not fail for a reason its local twin never hits.
 *
 * The fence is SKIPPED when no root set is supplied. That is not a hole: the
 * root set is the deployment's answer to "which directories do we serve", and a
 * caller that cannot answer it is using this module as the plain byte-mover it
 * also is (the unit tests, and any future non-workspace caller). Every
 * production caller — the agent tool and the browser's upload route — passes the
 * router's live `roots`, which is what makes the two write paths agree.
 *
 * Policy (the sandbox MODE and the session's SCOPE) is deliberately NOT decided
 * here: the tool owns it, and the browser route is a user action that answers to
 * the mounted-root fence only. Splitting it this way keeps one implementation of
 * each question instead of two that must not drift.
 *
 * @param {object} sftp - a live SFTP channel.
 * @param {string} alias - host alias.
 * @param {string} remotePath - the upload destination.
 * @param {Set<string> | undefined} roots - the served workspace roots, if known.
 * @param {string} [verb] - the word for the message (default 'upload').
 * @returns {Promise<void>} resolves when the destination is reachable.
 * @throws {import('./remote-fs.js').FsError} `FS_OUTSIDE_WORKSPACE` otherwise.
 */
export async function fenceUploadTarget (sftp, alias, remotePath, roots, verb = 'upload') {
  if (roots === undefined || roots === null) return
  const normalized = normalizeRemotePath(remotePath)
  const parts = { alias, remotePath: normalized, displayPath: formatRemotePath(alias, normalized) }
  const fence = writeFenceRoots(roots, parts)
  assertWithinRemoteRoots(fence, parts)
  await assertFencedRealpath(sftp, alias, normalized, fence, { verb })
}

/**
 * Copy one file up (local → remote) or down (remote → local).
 *
 * @param {import('./engine.js').SshWorkspaceEngine} engine - live engine.
 * @param {object} options - transfer request.
 * @param {string} options.alias - host alias.
 * @param {'upload'|'download'} options.direction - which way the bytes move.
 * @param {string} options.localPath - absolute local path (source for upload, destination for download).
 * @param {string} options.remotePath - absolute remote path (destination for upload, source for download).
 * @param {Set<string>} [options.roots] - served workspace roots; an upload is fenced against them (see {@link fenceUploadTarget}).
 * @param {AbortSignal} [options.signal] - cancels mid-transfer.
 * @param {Function} [options.onProgress] - called with `{bytes, totalBytes}` as chunks land.
 * @param {'overwrite'|'skip'|'rename'|'refuse'} [options.onConflict] - what to do when the destination exists.
 * @param {boolean} [options.verify] - hash both sides and compare before reporting success.
 * @returns {Promise<{bytes: number, skipped?: boolean, path?: string, verified?: boolean, verification?: string, note?: string}>} the outcome.
 */
export async function transferFile (engine, options) {
  const { alias, direction, localPath, remotePath, roots, signal, onProgress } = options
  signal?.throwIfAborted?.()
  const policy = normalizeConflictPolicy(options.onConflict)

  // The conflict decision happens BEFORE any byte moves, and it needs the
  // destination's state — which is remote for an upload and local for a
  // download. Doing it here (rather than inside the two branches) keeps the
  // policy in one place; the branches only learn whether to proceed.
  const destination = direction === 'upload' ? remotePath : localPath
  const exists = direction === 'upload'
    ? await remoteExists(engine, alias, remotePath)
    : existsSync(localPath)
  const decision = await decideConflict({
    policy,
    exists,
    destination,
    existsAt: direction === 'upload'
      ? async candidate => await remoteExists(engine, alias, candidate)
      : async candidate => existsSync(candidate),
  })
  if (decision.action === 'refuse') throw new Error(decision.note ?? 'the destination already exists')
  if (decision.action === 'skip') {
    return { bytes: 0, skipped: true, note: decision.note }
  }
  const target = decision.path ?? destination

  const result = direction === 'upload'
    ? await uploadFile(engine, { alias, localPath, remotePath: target, roots, signal, onProgress, resume: options.resume === true })
    : await downloadFile(engine, { alias, localPath: target, remotePath, signal, onProgress })

  /** @type {object} */
  const outcome = { bytes: result.bytes, ...(decision.path === undefined ? {} : { path: decision.path }), ...(decision.note === undefined ? {} : { note: decision.note }) }

  if (options.verify === true) {
    Object.assign(outcome, await verifyTransfer(engine, {
      alias,
      direction,
      localPath,
      remotePath: target,
      signal,
    }))
  }
  return outcome
}

/**
 * Does the remote path exist?
 *
 * A stat that fails for ANY reason is treated as "does not exist": a permission
 * error on the parent would otherwise turn a conflict check into a failed
 * transfer, and the write itself will report the real problem.
 *
 * @param {object} engine - live engine.
 * @param {string} alias - host alias.
 * @param {string} remotePath - the path.
 * @returns {Promise<boolean>} whether something is there.
 */
async function remoteExists (engine, alias, remotePath) {
  try {
    return await engine.withSftp(alias, async (sftp) => (await sftpStatOrNull(sftp, remotePath)) !== null, { kind: 'read' })
  } catch {
    return false
  }
}

/**
 * Hash both sides and compare.
 *
 * A transfer that could not be verified is NOT a failed transfer — the bytes
 * moved and the caller can use the file. It is an UNVERIFIED one, and the result
 * says so with a reason. Reporting it as failure would be worse: a host without
 * `sha256sum` would then make every transfer look broken.
 *
 * @param {object} engine - live engine.
 * @param {object} request - what to check.
 * @returns {Promise<{verified: boolean, verification?: string}>} the verdict.
 */
async function verifyTransfer (engine, request) {
  const { alias, direction, localPath, remotePath, signal } = request
  const hasher = await findRemoteHasher(engine, alias, signal)
  if (hasher === undefined) {
    return { verified: false, verification: 'no sha256 tool (sha256sum / shasum / openssl) on the host, so the copy could not be verified' }
  }
  const remote = await hashRemoteFile(engine, alias, remotePath, hasher, signal)
  const local = await hashLocalFile(localPath, signal)
  const verdict = compareDigests(local, remote)
  if (verdict.ok) return { verified: true }
  return { verified: false, verification: verdict.reason }
}

/**
 * Local → remote, staged then renamed.
 *
 * @param {import('./engine.js').SshWorkspaceEngine} engine - live engine.
 * @param {object} request - upload request.
 * @returns {Promise<{bytes: number}>} bytes copied.
 */
async function uploadFile (engine, request) {
  const { alias, localPath, remotePath, roots, signal, onProgress } = request
  const info = await stat(localPath)
  if (!info.isFile()) throw new Error(`not a regular file: ${localPath}`)
  const total = info.size
  if (total > DEFAULT_MAX_BYTES) throw new Error(`refusing to upload ${total} bytes (limit ${DEFAULT_MAX_BYTES})`)
  const resumable = request.resume === true
  const identity = sourceIdentity({ size: info.size, mtimeMs: info.mtimeMs })
  await engine.withSftp(alias, async (sftp) => {
    // Fence BEFORE any remote write: the destination must be reachable on this
    // deployment, and its real shape must stay inside that reach. Doing it here
    // rather than in the caller is what makes the two write paths agree — the
    // router runs the same pair of checks inside its own publication step.
    await fenceUploadTarget(sftp, alias, remotePath, roots)
    await sftpMkdirp(sftp, remoteParentOf(remotePath), remotePath)
    // A resumable upload uses a DETERMINISTIC staging name so a retry finds what
    // the last attempt left; everything that conflicts with that (a source that
    // changed, a partial of unknown origin, a partial bigger than the source) is
    // refused by `planResume`, which is why the determinism is safe.
    const staging = resumable ? resumableStagingName(remotePath) : stagingNameOf(remotePath, 'up')
    const sidecar = resumable ? resumeSidecarName(remotePath) : undefined
    let offset = 0
    if (resumable) {
      const partial = await sftpStatOrNull(sftp, staging)
      const recordText = await sftpReadTextOrNull(sftp, sidecar)
      const record = parseResumeRecord(recordText)
      const plan = planResume({
        partialBytes: partial?.size ?? 0,
        recordedIdentity: record?.identity,
        currentIdentity: identity,
        totalBytes: total,
      })
      if (plan.resume !== true) {
        // The old partial belongs to a source this attempt is not sending, so
        // it is not a prefix of anything: drop it rather than leave an
        // unappendable file beside the destination forever.
        if ((partial?.size ?? 0) > 0) {
          try { await sftpUnlink(sftp, staging) } catch { /* already gone */ }
        }
      }
      offset = plan.resume === true ? plan.offset : 0
      engine.diagnostics?.record('forward', `resume ${plan.resume ? 'accepted' : 'declined'}: ${plan.reason}`, { alias })
    }
    if (resumable) await sftpWriteText(sftp, sidecar, JSON.stringify(resumeRecord({ identity, totalBytes: total, source: localPath })))
    let handle
    try {
      if (total === 0) {
        // An empty source: create the staging file and publish it, so the
        // destination is replaced by an empty file rather than left alone.
        handle = await sftpOpenHandle(sftp, staging, offset > 0 ? 'r+' : 'w', remotePath)
      } else if (offset > 0) {
        // `r+` keeps the existing bytes: opening `w` here would truncate the
        // partial this whole path exists to preserve.
        handle = await sftpOpenHandle(sftp, staging, 'r+', remotePath)
      } else {
        // 'wx' for the random (non-resumable) name: fail rather than overwrite
        // a staging file another transfer is writing. The deterministic name is
        // opened 'w' when restarting, because discarding the old partial is the
        // decision `planResume` already made.
        handle = await sftpOpenHandle(sftp, staging, resumable ? 'w' : 'wx', remotePath)
      }
      let written = offset
      if (offset < total) {
        for await (const chunk of createReadStream(localPath, { start: offset, highWaterMark: CHUNK_BYTES })) {
          signal?.throwIfAborted?.()
          // The offset matters: without it the tail overwrites the prefix the
          // partial file already holds, producing a right-length wrong-content
          // file that only a checksum can catch.
          await sftpWriteHandle(sftp, handle, chunk, remotePath, written)
          written += chunk.length
          onProgress?.({ bytes: written, totalBytes: total })
        }
      }
      await sftpCloseHandle(sftp, handle)
      handle = undefined
      // Publish last: until the rename the destination keeps its old content.
      await sftpPublishRename(sftp, staging, remotePath, remotePath)
      if (sidecar !== undefined) {
        // The sidecar outlives the staging file by a moment; a stale one would
        // describe a partial that no longer exists, which `planResume` treats
        // as "nothing staged" anyway, but leaving it would be litter.
        try { await sftpUnlink(sftp, sidecar) } catch { /* already gone */ }
      }
    } catch (error) {
      if (handle !== undefined) { try { await sftpCloseHandle(sftp, handle) } catch { /* already gone */ } }
      // A RESUMABLE upload keeps its partial on failure: that is the whole
      // point of the feature. A random-named one removes it, because nothing
      // can ever resume into a name it will never pick again.
      if (!resumable) {
        try { await sftpUnlink(sftp, staging) } catch { /* staging never created */ }
      }
      throw error
    }
  }, { kind: 'write' })
  return { bytes: total }
}

/**
 * Read a small remote text file, or null.
 *
 * @param {object} sftp - SFTP channel.
 * @param {string} remotePath - the file.
 * @returns {Promise<string|null>} its contents.
 */
async function sftpReadTextOrNull (sftp, remotePath) {
  const info = await sftpStatOrNull(sftp, remotePath)
  if (info === null) return null
  const handle = await sftpOpenHandle(sftp, remotePath, 'r', remotePath)
  try {
    const chunks = []
    let position = 0
    for (;;) {
      const chunk = await sftpReadHandle(sftp, handle, position, 64 * 1024, remotePath)
      if (chunk.length === 0) break
      chunks.push(chunk)
      position += chunk.length
      // A sidecar is a few hundred bytes; anything past this is not one.
      if (position > 1024 * 1024) break
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    await sftpCloseHandle(sftp, handle)
  }
}

/**
 * Write a small remote text file, replacing it.
 *
 * @param {object} sftp - SFTP channel.
 * @param {string} remotePath - the file.
 * @param {string} body - its contents.
 * @returns {Promise<void>} resolves when written.
 */
async function sftpWriteText (sftp, remotePath, body) {
  const handle = await sftpOpenHandle(sftp, remotePath, 'w', remotePath)
  try {
    await sftpWriteHandle(sftp, handle, Buffer.from(body, 'utf8'), remotePath)
  } finally {
    await sftpCloseHandle(sftp, handle)
  }
}

/**
 * Remote → local, staged then renamed.
 *
 * Reads to EOF rather than trusting the stat-time size, so a file that grows
 * while it is being pulled is copied in full instead of truncated.
 *
 * @param {import('./engine.js').SshWorkspaceEngine} engine - live engine.
 * @param {object} request - download request.
 * @returns {Promise<{bytes: number}>} bytes copied.
 */
async function downloadFile (engine, request) {
  const { alias, localPath, remotePath, signal, onProgress } = request
  let copied = 0
  await engine.withSftp(alias, async (sftp) => {
    const info = await sftpStatOrNull(sftp, remotePath)
    if (info === null) throw new Error(`remote file does not exist: ${remotePath}`)
    const total = typeof info.size === 'number' ? info.size : 0
    if (total > DEFAULT_MAX_BYTES) throw new Error(`refusing to download ${total} bytes (limit ${DEFAULT_MAX_BYTES})`)
    await mkdir(path.dirname(localPath), { recursive: true })
    const staging = stagingNameOf(localPath, 'down')
    // 'wx' so a concurrent download to the same local path cannot share the
    // staging file.
    const out = createWriteStream(staging, { flags: 'wx' })
    // Drain before the first write so a fast reader never buffers unbounded.
    out.on('error', () => { /* surfaced through the awaited finish/close below */ })
    let handle
    try {
      handle = await sftpOpenHandle(sftp, remotePath, 'r', remotePath)
      for (;;) {
        signal?.throwIfAborted?.()
        const chunk = await sftpReadHandle(sftp, handle, copied, CHUNK_BYTES, remotePath)
        if (chunk.length === 0) break
        copied += chunk.length
        if (!out.write(chunk)) {
          // Race the drain against the stream failing: `once('drain')` alone
          // hangs forever when the write stream errors (a full disk, a removed
          // directory), because a broken stream never drains. Whichever settles
          // first decides, and the error propagates from `out`'s own listeners.
          await new Promise((resolve, reject) => {
            const done = () => { out.off('drain', done); out.off('error', fail); resolve() }
            const fail = (error) => { out.off('drain', done); out.off('error', fail); reject(error) }
            out.once('drain', done)
            out.once('error', fail)
          })
        }
        onProgress?.({ bytes: copied, totalBytes: total })
      }
      await sftpCloseHandle(sftp, handle)
      handle = undefined
      await new Promise((resolve, reject) => {
        out.once('error', reject)
        out.end(() => { resolve() })
      })
    } catch (error) {
      if (handle !== undefined) { try { await sftpCloseHandle(sftp, handle) } catch { /* already gone */ } }
      out.destroy()
      try { await unlink(staging) } catch { /* staging never created */ }
      throw error
    }
    await rename(staging, localPath)
  }, { kind: 'write' })
  return { bytes: copied }
}

/**
 * Copy a local directory tree up, preserving its shape.
 *
 * @param {import('./engine.js').SshWorkspaceEngine} engine - live engine.
 * @param {object} options - upload request.
 * @param {string} options.alias - host alias.
 * @param {string} options.localPath - local directory root.
 * @param {string} options.remotePath - remote directory root.
 * @param {Set<string>} [options.roots] - served workspace roots; every created directory and file is fenced against them.
 * @param {AbortSignal} [options.signal] - cancels mid-walk.
 * @param {Function} [options.onProgress] - called per file with `{files, bytes, path}`.
 * @returns {Promise<{files: number, bytes: number}>} totals.
 */
export async function uploadTree (engine, options) {
  const { alias, localPath, remotePath, roots, signal, onProgress } = options
  let files = 0
  let bytes = 0
  const walk = async (from, to) => {
    signal?.throwIfAborted?.()
    await engine.withSftp(alias, async (sftp) => {
      // The directory itself is fenced before it is created: a tree whose root
      // lies outside every served workspace must not leave even an empty
      // directory behind, and a single-file tree would otherwise only be caught
      // once its first file is written.
      await fenceUploadTarget(sftp, alias, to, roots, 'upload')
      await sftpMkdirp(sftp, to, to)
    })
    const entries = await readdir(from, { withFileTypes: true })
    // Stable order keeps a repeated upload from reshuffling its own progress.
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      signal?.throwIfAborted?.()
      const source = path.join(from, entry.name)
      const target = `${to.replace(/\/+$/u, '')}/${entry.name}`
      if (entry.isDirectory()) {
        await walk(source, target)
      } else if (entry.isFile()) {
        const result = await uploadFile(engine, { alias, localPath: source, remotePath: target, roots, signal })
        files += 1
        bytes += result.bytes
        onProgress?.({ files, bytes, path: entry.name })
      }
    }
  }
  await walk(localPath, remotePath)
  return { files, bytes }
}

/**
 * Copy a REMOTE directory tree down, preserving its shape.
 *
 * The mirror of {@link uploadTree}, and it exists for the same reason: "pull the
 * build output" and "grab the logs directory" are as common as pushing a file,
 * and doing it one file at a time means the caller has to enumerate the tree
 * first — which is exactly the work a transfer tool should do.
 *
 * ## What it deliberately does NOT do
 *
 *  - It does not follow symlinks. A remote tree may contain a link to `/` or to
 *    another tree, and following one turns "download this directory" into an
 *    unbounded walk with a destination nobody pictured. Links are SKIPPED and
 *    counted, so the result says they were there.
 *  - It does not delete local files that the remote tree lacks. This is a copy,
 *    not a sync; a `--delete`-shaped operation against a local directory is how
 *    a download removes work the user did locally.
 *
 * ## Conflict handling
 *
 * Delegated to the same policy the single-file path uses, applied per FILE.
 * A per-directory decision would be wrong: the interesting case is a tree where
 * most files are new and one collides.
 *
 * @param {import('./engine.js').SshWorkspaceEngine} engine - live engine.
 * @param {object} options - download request.
 * @param {string} options.alias - host alias.
 * @param {string} options.remotePath - remote directory root (source).
 * @param {string} options.localPath - local directory root (destination).
 * @param {AbortSignal} [options.signal] - cancels mid-walk.
 * @param {Function} [options.onProgress] - called per file with `{files, bytes, path}`.
 * @param {'overwrite'|'skip'|'rename'|'refuse'} [options.onConflict] - per-file policy.
 * @returns {Promise<{files: number, bytes: number, skipped: number, links: string[]}>} totals.
 */
export async function downloadTree (engine, options) {
  const { alias, remotePath, localPath, signal, onProgress } = options
  signal?.throwIfAborted?.()
  const policy = normalizeConflictPolicy(options.onConflict)
  let files = 0
  let bytes = 0
  let skipped = 0
  /** @type {string[]} */
  const links = []

  /** One directory listing, via SFTP. */
  const listRemote = async (dir) => await engine.withSftp(alias, async (sftp) => {
    const entries = await sftpReaddirIrregular(sftp, dir, dir)
    return entries
  }, { kind: 'read' })

  const walk = async (from, to) => {
    signal?.throwIfAborted?.()
    await mkdir(to, { recursive: true })
    const entries = await listRemote(from)
    // Stable order keeps a repeated download from reshuffling its own progress,
    // and makes a partial failure reproducible.
    entries.sort((left, right) => left.filename.localeCompare(right.filename))
    for (const entry of entries) {
      signal?.throwIfAborted?.()
      const source = `${from.replace(/\/+$/u, '')}/${entry.filename}`
      const target = path.join(to, entry.filename)
      const attrs = entry.attrs ?? {}
      // A symlink is REPORTED, never followed. `isSymbolicLink` is only present
      // when the server's attrs say so; anything unknown is treated as a file
      // and will fail loudly on read rather than silently fanning out.
      if (typeof attrs.isSymbolicLink === 'function' && attrs.isSymbolicLink() === true) {
        links.push(source)
        continue
      }
      if (typeof attrs.isDirectory === 'function' && attrs.isDirectory() === true) {
        await walk(source, target)
        continue
      }
      const decision = await decideConflict({
        policy,
        exists: existsSync(target),
        destination: target,
        existsAt: async candidate => existsSync(candidate),
      })
      if (decision.action === 'refuse') throw new Error(decision.note ?? `the destination already exists: ${target}`)
      if (decision.action === 'skip') {
        skipped += 1
        continue
      }
      const written = await downloadFile(engine, {
        alias,
        localPath: decision.path ?? target,
        remotePath: source,
        signal,
      })
      files += 1
      bytes += written.bytes
      onProgress?.({ files, bytes, path: entry.filename })
    }
  }
  await walk(remotePath, localPath)
  return { files, bytes, skipped, links }
}

/**
 * Read a remote directory, tolerating entries whose attrs are missing.
 *
 * `sftpReaddir` exists for the filesystem half and throws on a missing
 * directory; this wraps it so the transfer path reports "the remote directory
 * does not exist" as a sentence rather than as an SFTP status code.
 *
 * @param {object} sftp - live SFTP channel.
 * @param {string} dir - remote directory.
 * @param {string} displayPath - for the message.
 * @returns {Promise<Array<object>>} the entries.
 */
async function sftpReaddirIrregular (sftp, dir, displayPath) {
  return await new Promise((resolve, reject) => {
    sftp.readdir(dir, (error, entries) => {
      if (error !== undefined && error !== null) {
        reject(new Error(`cannot read remote directory ${displayPath}: ${error.message ?? String(error)}`))
        return
      }
      resolve(Array.isArray(entries) ? entries : [])
    })
  })
}

/** The remote parent of a remote path, without a trailing slash. */
export function remoteParentOf (remotePath) {
  const normalized = remotePath.replace(/\/+$/u, '')
  const index = normalized.lastIndexOf('/')
  if (index <= 0) return '/'
  return normalized.slice(0, index)
}

/** Unlink a remote path, ignoring a missing file. */
export async function sftpUnlink (sftp, target) {
  await new Promise((resolve) => {
    sftp.unlink(target, () => { resolve() })
  })
}
