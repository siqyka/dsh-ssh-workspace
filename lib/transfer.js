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
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'

import { formatRemotePath, normalizeRemotePath } from './protocol.js'
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
 * @returns {Promise<{bytes: number}>} how many bytes were copied.
 */
export async function transferFile (engine, options) {
  const { alias, direction, localPath, remotePath, roots, signal, onProgress } = options
  signal?.throwIfAborted?.()
  if (direction === 'upload') return await uploadFile(engine, { alias, localPath, remotePath, roots, signal, onProgress })
  return await downloadFile(engine, { alias, localPath, remotePath, signal, onProgress })
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
  await engine.withSftp(alias, async (sftp) => {
    // Fence BEFORE any remote write: the destination must be reachable on this
    // deployment, and its real shape must stay inside that reach. Doing it here
    // rather than in the caller is what makes the two write paths agree — the
    // router runs the same pair of checks inside its own publication step.
    await fenceUploadTarget(sftp, alias, remotePath, roots)
    await sftpMkdirp(sftp, remoteParentOf(remotePath), remotePath)
    const staging = stagingNameOf(remotePath, 'up')
    let handle
    try {
      // 'wx': fail rather than overwrite a staging file another transfer is
      // writing. A collision is astronomically unlikely with the random suffix,
      // and failing loudly beats corrupting both files.
      handle = await sftpOpenHandle(sftp, staging, 'wx', remotePath)
      let written = 0
      for await (const chunk of createReadStream(localPath, { highWaterMark: CHUNK_BYTES })) {
        signal?.throwIfAborted?.()
        await sftpWriteHandle(sftp, handle, chunk, remotePath)
        written += chunk.length
        onProgress?.({ bytes: written, totalBytes: total })
      }
      await sftpCloseHandle(sftp, handle)
      handle = undefined
      // Publish last: until the rename the destination keeps its old content.
      await sftpPublishRename(sftp, staging, remotePath, remotePath)
    } catch (error) {
      if (handle !== undefined) { try { await sftpCloseHandle(sftp, handle) } catch { /* already gone */ } }
      try { await sftpUnlink(sftp, staging) } catch { /* staging never created */ }
      throw error
    }
  }, { kind: 'write' })
  return { bytes: total }
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
