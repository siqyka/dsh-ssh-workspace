/**
 * Bridge the Host's own builtin calls onto remote targets.
 *
 * `ctx.fs` covers everything that travels through the filesystem seam, but a
 * few Host subsystems reach for the builtin modules directly, and several of
 * them run on a new session's cwd before any agent exists: the Session
 * controller `mkdir`s the project directory, the Workspace registry
 * `realpath`s and `stat`s it, and the Session service asks
 * `path.isAbsolute(cwd)` while validating the header it is about to persist.
 * On an `ssh://` cwd the fs calls land on the host — Windows resolves
 * `ssh://myserver/home/user/project` against the process cwd, the `:` makes the
 * spelling uncreatable, and the session create fails with ENOENT — while the
 * path check rejects the header as relative, because no platform parser roots
 * a bare `ssh://` spelling (`win32` sees a two-letter pseudo-device with no
 * colon, `posix` a relative first segment).
 *
 * Those call sites import the builtins BY NAME, so replacing the modules'
 * properties is not enough on its own: the named bindings of an ESM importer
 * point at the builtin's ESM facade, and `syncBuiltinESMExports()` is what
 * republishes the swapped functions onto that facade — including for modules
 * that were already loaded before this plugin ran.
 *
 * Besides the builtin calls, the `node:path` spellings computed around a
 * remote cwd are bridged too: `resolve`/`join` fold `ssh://` arguments into
 * canonical remote spellings (arguments to the left of an absolute one are
 * swallowed, exactly as node swallows them; a Windows-absolute argument resets
 * to the local world), `relative` answers POSIX-relative across remote
 * operands, and `isAbsolute` answers true for the scheme. The remaining
 * bridges serve change tracking: `copyFile` reads a remote source over SFTP
 * and mirrors a host-scratch destination onto its owning host, `open(path,
 * 'r')` returns an SFTP-backed FileHandle, and `rm` of a learned scratch
 * directory also deletes its remote twin. `readdir` serves the Host's `@file`
 * completion, whose provider scans a remote session's cwd — reading entry
 * names and their file/directory flags — through the builtin it was compiled
 * against.
 *
 * Only `ssh://` spellings (and learned scratch mirrors) are diverted; every
 * other path is forwarded to the original implementation, so host behavior is
 * unchanged. Remote reads are unfenced exactly as they are on `ctx.fs`;
 * mutations — `mkdir`, `copyFile` onto an `ssh://` destination, `rm` of an
 * `ssh://` path — obey the mounted-root fence, while scratch-mirror cleanup is
 * exempt because it only ever touches the staging root the plugin itself
 * created.
 *
 * @module @shiqyka/dsh-ssh-workspace/fs-shim
 */

import fsPromises from 'node:fs/promises'
import nodePath from 'node:path'
import { syncBuiltinESMExports } from 'node:module'

import { formatRemotePath, isRemotePath, normalizeRemotePath, parseRemotePath, remoteDirname } from './protocol.js'
import { forgetMirrorAlias, mirrorTargetOf, remoteMirrorPath } from './patch-subprocess.js'
import { shellQuote } from './engine.js'
import {
  assertFencedRealpath,
  assertWithinRemoteRoots,
  isWithinRemoteRoots,
  remotePartsOf,
  sftpCloseHandle,
  sftpLstatOrNull,
  sftpMkdirp,
  sftpMkdirStrict,
  sftpOpenHandle,
  sftpReadHandle,
  sftpStatOrNull,
  sftpWriteHandle,
} from './remote-fs.js'

/** Builtin fs functions the bridge takes over. */
const BRIDGED = ['mkdir', 'stat', 'lstat', 'realpath', 'copyFile', 'open', 'rm', 'readdir']

/** Process-wide bridge state, so a reload rebinds instead of double-patching. */
const BRIDGE = Symbol.for('dsh-ssh-workspace.fs-shim')

/** Seam error code → the errno code builtin-fs callers branch on. */
const ERRNO_OF = {
  FS_NOT_FOUND: 'ENOENT',
  FS_PERMISSION_DENIED: 'EACCES',
  FS_NOT_DIRECTORY: 'ENOTDIR',
  FS_SANDBOX_DENIED: 'EPERM',
  FS_IO_ERROR: 'EIO',
}

/** `fs.constants.COPYFILE_EXCL`, which copyFile callers may OR into `mode`. */
const COPYFILE_EXCL = 1

/** Largest single SFTP read the bridged FileHandle will issue. */
const OPEN_READ_CHUNK = 256 * 1024

/** Windows-absolute spellings (`C:\…`, `\\server\share`). */
const WINDOWS_ABSOLUTE_RE = /^([A-Za-z]:[\\/]|\\\\)/u

/** Open flags accepted for a remote target — read-only, in string form. */
const READ_OPEN_FLAGS = new Set(['r', 'rs'])

/**
 * Re-raise a seam failure as the builtin-shaped error callers expect: the
 * message is preserved, `code` becomes the matching errno, and the original
 * error stays reachable as `cause`.
 *
 * @param {unknown} error - the failure from the remote half.
 * @param {string} syscall - the builtin function performing the operation.
 * @param {string} path - the caller's path spelling.
 * @returns {Error} the error to throw from the bridge.
 */
function builtinError (error, syscall, path) {
  const source = error instanceof Error ? error : new Error(String(error))
  const wrapped = new Error(source.message, { cause: source })
  wrapped.code = ERRNO_OF[source.code] ?? (typeof source.code === 'string' ? source.code : 'EIO')
  wrapped.syscall = syscall
  wrapped.path = path
  return wrapped
}

/**
 * Build node's missing-entry error for one operation.
 *
 * @param {string} syscall - the builtin function performing the operation.
 * @param {string} path - the caller's path spelling.
 * @returns {Error} an `ENOENT` error.
 */
function notFoundError (syscall, path) {
  const error = new Error(`ENOENT: no such file or directory, ${syscall} '${path}'`)
  error.code = 'ENOENT'
  error.errno = -2
  error.syscall = syscall
  error.path = path
  return error
}

/**
 * Build node's already-exists error for one operation.
 *
 * @param {string} syscall - the builtin function performing the operation.
 * @param {string} path - the caller's path spelling.
 * @returns {Error} an `EEXIST` error.
 */
function existsError (syscall, path) {
  const error = new Error(`EEXIST: file already exists, ${syscall} '${path}'`)
  error.code = 'EEXIST'
  error.errno = -17
  error.syscall = syscall
  error.path = path
  return error
}

/**
 * Project one SFTP attribute record into the shape of a builtin `Stats`.
 *
 * SFTP carries no `dev`/`ino`, and no change time beyond the mtime — the absent
 * fields are reported as zero rather than invented, which is also what makes
 * them unusable for identity comparison, the conservative outcome.
 *
 * @param {object} attrs - the SFTP attributes.
 * @param {boolean} bigint - whether the caller asked for bigint fields.
 * @returns {object} a duck-typed `Stats`.
 */
function statsOf (attrs, bigint) {
  const asNumber = (value) => {
    const number = typeof value === 'number' && Number.isFinite(value) ? value : 0
    return bigint === true ? BigInt(Math.trunc(number)) : number
  }
  const asDate = (seconds) => new Date((typeof seconds === 'number' ? seconds : 0) * 1000)
  const flag = (name) => typeof attrs?.[name] === 'function' ? () => attrs[name]() : () => false
  const mtime = attrs?.mtime ?? 0
  const atime = attrs?.atime ?? 0
  return {
    size: asNumber(attrs?.size),
    mode: asNumber(attrs?.mode),
    uid: asNumber(attrs?.uid),
    gid: asNumber(attrs?.gid),
    ino: asNumber(attrs?.ino),
    dev: asNumber(attrs?.dev),
    nlink: asNumber(attrs?.nlink),
    atime: asDate(atime),
    mtime: asDate(mtime),
    ctime: asDate(mtime),
    birthtime: asDate(mtime),
    atimeMs: asNumber(atime * 1000),
    mtimeMs: asNumber(mtime * 1000),
    ctimeMs: asNumber(mtime * 1000),
    birthtimeMs: asNumber(mtime * 1000),
    isFile: flag('isFile'),
    isDirectory: flag('isDirectory'),
    isSymbolicLink: flag('isSymbolicLink'),
    isBlockDevice: flag('isBlockDevice'),
    isCharacterDevice: flag('isCharacterDevice'),
    isFIFO: flag('isFIFO'),
    isSocket: flag('isSocket'),
  }
}

/**
 * `mkdir` for a remote target: create the chain, or the single level, obeying
 * the mounted-root fence.
 *
 * Outside every root nothing is ever created — but a directory that is already
 * there still satisfies the caller's "ensure this exists" intent, so it is
 * accepted and the fence only rejects a path that would have to be created.
 *
 * @param {string} path - the caller's `ssh://` path.
 * @param {object} [options] - builtin mkdir options.
 * @param {object} state - live bridge state.
 * @returns {Promise<void>} resolves once the directory exists.
 */
async function mkdirRemote (path, options, state) {
  const parts = remotePartsOf(path)
  const recursive = options?.recursive === true
  const mode = typeof options?.mode === 'number' ? options.mode : undefined
  try {
    await state.engine.withSftp(parts.alias, async (sftp) => {
      if (isWithinRemoteRoots(state.router.roots, parts)) {
        if (recursive) await sftpMkdirp(sftp, parts.remotePath, parts.displayPath, mode)
        else {
          if (await sftpStatOrNull(sftp, parts.remotePath) !== null) throw existsError('mkdir', path)
          await sftpMkdirStrict(sftp, parts.remotePath, parts.displayPath, mode)
        }
        return
      }
      const existing = await sftpStatOrNull(sftp, parts.remotePath)
      if (existing !== null && typeof existing.isDirectory === 'function' && existing.isDirectory()) return
      assertWithinRemoteRoots(state.router.roots, parts)
    })
    // A created directory changes its parent listing.
    state.router.invalidateRemote(parts.alias, parts.remotePath)
  } catch (error) {
    throw builtinError(error, 'mkdir', path)
  }
}

/**
 * `stat` for a remote target, following the final symlink.
 *
 * @param {string} path - the caller's `ssh://` path.
 * @param {object} [options] - builtin stat options.
 * @param {object} state - live bridge state.
 * @returns {Promise<object>} the duck-typed `Stats`.
 */
async function statRemote (path, options, state) {
  const parts = remotePartsOf(path)
  try {
    const attrs = await state.engine.withSftp(parts.alias, async (sftp) => await sftpStatOrNull(sftp, parts.remotePath))
    if (attrs === null) throw notFoundError('stat', path)
    return statsOf(attrs, options?.bigint === true)
  } catch (error) {
    throw builtinError(error, 'stat', path)
  }
}

/**
 * `lstat` for a remote target, leaving the final symlink unresolved.
 *
 * @param {string} path - the caller's `ssh://` path.
 * @param {object} [options] - builtin lstat options.
 * @param {object} state - live bridge state.
 * @returns {Promise<object>} the duck-typed `Stats`.
 */
async function lstatRemote (path, options, state) {
  const parts = remotePartsOf(path)
  try {
    const attrs = await state.engine.withSftp(parts.alias, async (sftp) => await sftpLstatOrNull(sftp, parts.remotePath))
    if (attrs === null) throw notFoundError('lstat', path)
    return statsOf(attrs, options?.bigint === true)
  } catch (error) {
    throw builtinError(error, 'lstat', path)
  }
}

/**
 * `realpath` for a remote target.
 *
 * Returns the canonical `ssh://<alias>/<normalized path>` spelling — the same
 * one mounting and session headers use — rather than asking the server for its
 * own realpath. Identity here is the seam's lexical canon by design
 * (protocol.js), and a server-side spelling such as `/export/home/...` would
 * not compare equal to the workspace the user registered.
 *
 * @param {string} path - the caller's `ssh://` path.
 * @param {object} [options] - builtin realpath options (encoding is ignored).
 * @param {object} state - live bridge state.
 * @returns {Promise<string>} the canonical remote spelling.
 */
async function realpathRemote (path, options, state) {
  const parts = remotePartsOf(path)
  try {
    const attrs = await state.engine.withSftp(parts.alias, async (sftp) => await sftpStatOrNull(sftp, parts.remotePath))
    if (attrs === null) throw notFoundError('realpath', path)
    return parts.displayPath
  } catch (error) {
    throw builtinError(error, 'realpath', path)
  }
}

/**
 * `readdir` for a remote target.
 *
 * Answers both node shapes: bare entry names, and — the one the Host's `@file`
 * completion provider asks for — `Dirent`-like records. A record's type
 * predicates read the entry's own attributes, which is what a local `readdir`
 * reports: a symlink is a symlink, never the file or directory it points at,
 * so a directory symlink is never descended into.
 *
 * @param {string} path - the caller's `ssh://` path.
 * @param {object} [options] - builtin readdir options.
 * @param {object} state - live bridge state.
 * @returns {Promise<Array<string | Buffer | object>>} entry names, or `Dirent`-likes.
 */
async function readdirRemote (path, options, state) {
  if (options?.recursive === true) {
    const unsupported = new Error(`ENOTSUP: recursive readdir is not supported for ssh:// paths, readdir '${path}'`)
    unsupported.code = 'ENOTSUP'
    throw builtinError(unsupported, 'readdir', path)
  }
  const withFileTypes = options?.withFileTypes === true
  const encoding = typeof options === 'string' ? options : (typeof options?.encoding === 'string' ? options.encoding : 'utf8')
  try {
    const parts = remotePartsOf(path)
    const entries = await state.router.listRemoteEntries(parts.alias, parts.remotePath)
    if (withFileTypes) return entries.map((entry) => direntOf(path, entry.filename, entry.attrs))
    if (encoding === 'buffer') return entries.map((entry) => Buffer.from(entry.filename))
    if (encoding === 'utf8' || encoding === 'utf-8') return entries.map((entry) => entry.filename)
    return entries.map((entry) => Buffer.from(entry.filename).toString(encoding))
  } catch (error) {
    throw builtinError(error, 'readdir', path)
  }
}

/**
 * Project one directory entry into the shape of a builtin `Dirent`.
 *
 * @param {string} parentPath - the directory spelling the caller listed.
 * @param {string} name - the entry's basename.
 * @param {object} attrs - the entry's SFTP attribute record.
 * @returns {object} a duck-typed `Dirent`.
 */
function direntOf (parentPath, name, attrs) {
  const flag = (method) => typeof attrs?.[method] === 'function' ? () => attrs[method]() === true : () => false
  return {
    name,
    parentPath,
    isFile: flag('isFile'),
    isDirectory: flag('isDirectory'),
    isSymbolicLink: flag('isSymbolicLink'),
    isBlockDevice: flag('isBlockDevice'),
    isCharacterDevice: flag('isCharacterDevice'),
    isFIFO: flag('isFIFO'),
    isSocket: flag('isSocket'),
  }
}

/**
 * Read a whole remote file as bytes. Reads are unfenced, exactly as they are
 * on `ctx.fs`.
 *
 * @param {object} parts - parsed remote target.
 * @param {object} state - live bridge state.
 * @returns {Promise<Buffer>} the file bytes.
 */
async function readRemoteWhole (parts, state) {
  return await state.engine.withSftp(parts.alias, async (sftp) => {
    const handle = await sftpOpenHandle(sftp, parts.remotePath, 'r', parts.displayPath)
    try {
      return await sftpReadHandle(sftp, handle, 0, undefined, parts.displayPath)
    } finally {
      await sftpCloseHandle(sftp, handle)
    }
  })
}

/**
 * Write bytes to one remote path, creating the parent chain.
 *
 * @param {string} alias - host alias.
 * @param {string} remotePath - remote destination.
 * @param {Buffer} bytes - content to write.
 * @param {object} state - live bridge state.
 * @param {{fenced: boolean}} options - whether the mounted-root fence applies.
 * @returns {Promise<void>} resolves once the file is written.
 */
async function putRemoteBytes (alias, remotePath, bytes, state, options) {
  const displayPath = formatRemotePath(alias, remotePath)
  await state.engine.withSftp(alias, async (sftp) => {
    // The fence is lexical first and real-shaped second: a link at any level —
    // final component included, which an open-for-write would follow — must
    // not steer the bytes outside a mounted root.
    if (options.fenced) await assertFencedRealpath(sftp, alias, remotePath, state.router.roots)
    await sftpMkdirp(sftp, remoteDirname(remotePath), displayPath)
    const handle = await sftpOpenHandle(sftp, remotePath, 'w', displayPath)
    try {
      await sftpWriteHandle(sftp, handle, bytes, displayPath)
    } finally {
      await sftpCloseHandle(sftp, handle)
    }
  })
  // The write changed the file's metadata and its parent listing.
  state.router.invalidateRemote(alias, remotePath)
}

/**
 * `copyFile` for the remote flows: a remote source is read over SFTP, and the
 * destination — remote, plain local, or host scratch — is written from those
 * bytes. A host-scratch destination (under the temp root the change tracker
 * stages in) is additionally mirrored onto the remote `/tmp` of the host that
 * owns the source, because the staged copy is what a remote git is pointed at
 * through `GIT_INDEX_FILE`.
 *
 * @param {string} source - source path (at least one side is remote).
 * @param {string} destination - destination path.
 * @param {number} [mode] - builtin copyFile mode flags.
 * @param {object} state - live bridge state.
 * @returns {Promise<void>} resolves once both sides of the copy exist.
 */
async function copyFileRemote (source, destination, mode, state) {
  if (typeof source !== 'string' || typeof destination !== 'string') {
    const error = new Error('copyFile requires source and destination path strings')
    error.code = 'EINVAL'
    throw builtinError(error, 'copyFile', String(source))
  }
  const sourceIsRemote = isRemotePath(source)
  try {
    const bytes = sourceIsRemote
      ? await readRemoteWhole(remotePartsOf(source), state)
      : await fsPromises.readFile(source)
    if (isRemotePath(destination)) {
      const parts = remotePartsOf(destination)
      await putRemoteBytes(parts.alias, parts.remotePath, bytes, state, { fenced: true })
      return
    }
    if (typeof mode === 'number' && (mode & COPYFILE_EXCL) === COPYFILE_EXCL) {
      let exists = true
      try {
        await state.originals.stat(destination)
      } catch {
        exists = false
      }
      if (exists) throw existsError('copyfile', destination)
    }
    await fsPromises.writeFile(destination, bytes)
    const alias = sourceIsRemote ? parseRemotePath(source).alias : mirrorTargetOf(destination)?.alias
    if (alias !== undefined) {
      const mirror = remoteMirrorPath(destination, alias)
      // Trust boundary: this mirror write is deliberately unfenced because it
      // is not user input — `remoteMirrorPath` only ever answers a path under
      // the staging root for a scratch directory this plugin itself learned (a
      // change-tracker mkdtemp, or the owning host of an ssh:// source), and
      // the whole point is to stage change-tracker copies where the remote git
      // reads them, outside every mounted workspace root.
      if (mirror !== undefined) await putRemoteBytes(alias, mirror, bytes, state, { fenced: false })
    }
  } catch (error) {
    throw builtinError(error, 'copyFile', source)
  }
}

/**
 * `open` for a remote target: read-only, returning an SFTP-backed FileHandle
 * with the pieces the change tracker's file capture consumes — `stat`, `read`
 * (single, capped), `readFile`, `close`.
 *
 * The pooled connection is pinned for the handle's lifetime (`inFlight`), so
 * the idle sweeper cannot drop the SFTP channel under an open file.
 *
 * @param {string} path - the caller's `ssh://` path.
 * @param {string | number} flags - builtin open flags.
 * @param {number} [mode] - creation mode (unused; reads only).
 * @param {object} state - live bridge state.
 * @returns {Promise<object>} the duck-typed FileHandle.
 */
async function openRemote (path, flags, mode, state) {
  const readOnly = typeof flags === 'number' ? flags === 0 : READ_OPEN_FLAGS.has(String(flags ?? 'r'))
  if (!readOnly) {
    const error = new Error(`cannot open "${path}": only read-only opens are bridged for remote ssh:// targets`)
    error.code = 'EINVAL'
    throw builtinError(error, 'open', path)
  }
  const parts = remotePartsOf(path)
  try {
    const record = await state.engine.acquire(parts.alias)
    record.idleAt = Date.now()
    const remoteHandle = await sftpOpenHandle(record.sftp, parts.remotePath, 'r', parts.displayPath)
    record.inFlight += 1
    let position = 0
    let closed = false
    const fstat = () => new Promise((resolve, reject) => {
      record.sftp.fstat(remoteHandle, (error, attrs) => {
        if (error !== undefined && error !== null) reject(builtinError(error, 'fstat', path))
        else resolve(attrs)
      })
    })
    return {
      async stat (options) {
        return statsOf(await fstat(), options?.bigint === true)
      },
      async read (buffer, offset = 0, length = buffer.length, at = null) {
        const want = Math.max(0, Math.min(length, OPEN_READ_CHUNK))
        const from = at === null || at === undefined ? position : at
        const bytesRead = await new Promise((resolve, reject) => {
          record.sftp.read(remoteHandle, buffer, offset, want, from, (error, read) => {
            if (error !== undefined && error !== null) reject(builtinError(error, 'read', path))
            else resolve(read ?? 0)
          })
        })
        if (at === null || at === undefined) position = from + bytesRead
        return { bytesRead, buffer }
      },
      async readFile () {
        return await sftpReadHandle(record.sftp, remoteHandle, 0, undefined, parts.displayPath)
      },
      async close () {
        if (closed) return
        closed = true
        await sftpCloseHandle(record.sftp, remoteHandle)
        record.inFlight -= 1
        record.idleAt = Date.now()
      },
    }
  } catch (error) {
    throw builtinError(error, 'open', path)
  }
}

/**
 * `rm` for the remote flows.
 *
 * An `ssh://` target is removed on its host (fenced). A local path under a
 * learned scratch root — the change tracker's `mkdtemp` directory — is removed
 * locally as asked, and its remote mirror is removed best-effort: the scratch
 * is invisible to the user, and leaking it on the host would be the surprise.
 *
 * @param {string} path - the caller's path spelling.
 * @param {object} [options] - builtin rm options.
 * @param {object} state - live bridge state.
 * @returns {Promise<void>} resolves once the local side is gone.
 */
async function rmRemote (path, options, state) {
  if (isRemotePath(path)) {
    const parts = remotePartsOf(path)
    try {
      assertWithinRemoteRoots(state.router.roots, parts)
      // `rm -rf` removes through intermediate path components; if one of them
      // is a link out of the fence the deletion would land outside it. The
      // final component itself may be a link — deleting the link is exactly
      // what rm does — so only the parent chain is resolved.
      await state.engine.withSftp(parts.alias, async (sftp) =>
        await assertFencedRealpath(sftp, parts.alias, parts.remotePath, state.router.roots, { includeLeaf: false, verb: 'delete' }))
      const outcome = await state.engine.exec(parts.alias, `rm -rf -- ${shellQuote(parts.remotePath)}`)
      if (!outcome.success) {
        throw new Error(outcome.stderr.trim() || outcome.error || `rm exited with code ${outcome.exitCode}`)
      }
      // The removal changed the target and its parent listing.
      state.router.invalidateRemote(parts.alias, parts.remotePath)
    } catch (error) {
      throw builtinError(error, 'rm', path)
    }
    return
  }
  const target = mirrorTargetOf(path)
  if (target !== undefined) {
    try {
      const outcome = await state.engine.exec(target.alias, `rm -rf -- ${shellQuote(target.remotePath)}`)
      if (!outcome.success) {
        state.logger?.warn?.(`ssh-workspace: could not remove remote scratch "${target.remotePath}" on ${target.alias}: ${outcome.stderr.trim() || outcome.error || outcome.exitCode}`)
      }
    } catch (error) {
      state.logger?.warn?.(`ssh-workspace: could not remove remote scratch "${target.remotePath}" on ${target.alias}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  try {
    const result = await state.originals.rm(path, options)
    // The scratch directory is gone for good; drop its learned alias entry
    // so the registry does not grow with every snapshot round.
    if (target !== undefined) forgetMirrorAlias(path)
    return result
  } catch (error) {
    throw builtinError(error, 'rm', path)
  }
}

/**
 * Parse a spelling the `isRemotePath` prefix test accepted, or `undefined`
 * when its shape is not a remote workspace path — a bare `ssh://<alias>` with
 * no path, say.
 *
 * The path shims are a compatibility layer over functions that never throw,
 * and callers legitimately walk spellings upward past the alias level: a
 * workspace-path walker climbs `join(current, '.git')` until the bare alias
 * fails to probe and the walk ends. Treating that ordinary input as a caller
 * error would abort runs a local workspace completes, so an unparseable
 * spelling answers `undefined` and the call defers to the native
 * implementation — the behavior before these shims existed.
 *
 * @param {string} spelling - a candidate remote path.
 * @returns {{alias: string, remotePath: string} | undefined} the parts, or
 *   undefined when the spelling does not parse.
 */
function tryParseRemotePath (spelling) {
  try {
    return parseRemotePath(spelling)
  } catch {
    return undefined
  }
}

/**
 * `resolve` for a remote spelling, or `undefined` when the call is purely
 * local and the original implementation should run.
 *
 * The fold follows node's semantics — arguments to the left of an absolute
 * argument are swallowed — with `ssh://` establishing a remote base, a POSIX
 * absolute argument replacing the remote path on the same alias, relative
 * segments appending, and a Windows-absolute argument resetting to the local
 * world.
 *
 * @param {string[]} args - the caller's arguments.
 * @param {object} entry - the surface's captured originals.
 * @returns {string | undefined} the resolved spelling, or undefined to defer.
 */
function resolveRemoteSpelling (args, entry) {
  if (!args.some(arg => isRemotePath(arg))) return undefined
  let alias
  let remotePath
  let localReset
  for (const arg of args) {
    if (typeof arg !== 'string' || arg === '') continue
    if (isRemotePath(arg)) {
      const parsed = tryParseRemotePath(arg)
      if (parsed === undefined) return undefined
      alias = parsed.alias
      remotePath = parsed.remotePath
      localReset = undefined
      continue
    }
    if (localReset !== undefined) {
      localReset = entry.resolve(localReset, arg)
      continue
    }
    if (arg.startsWith('/')) {
      if (alias === undefined) continue
      remotePath = normalizeRemotePath(arg)
      continue
    }
    if (WINDOWS_ABSOLUTE_RE.test(arg)) {
      localReset = arg
      continue
    }
    if (alias === undefined) continue
    remotePath = normalizeRemotePath(`${remotePath}/${arg}`)
  }
  if (localReset !== undefined) return entry.resolve(localReset)
  if (alias === undefined || remotePath === undefined) return undefined
  return formatRemotePath(alias, remotePath)
}

/**
 * `join` for a remote spelling, or `undefined` when the first argument is not
 * remote and the original implementation should run.
 *
 * @param {string[]} args - the caller's arguments.
 * @returns {string | undefined} the joined spelling, or undefined to defer.
 */
function joinRemoteSpelling (args) {
  const [first] = args
  if (!isRemotePath(first)) return undefined
  const parsed = tryParseRemotePath(first)
  if (parsed === undefined) return undefined
  const tail = args.slice(1).filter(arg => typeof arg === 'string' && arg !== '').join('/')
  return tail === ''
    ? formatRemotePath(parsed.alias, parsed.remotePath)
    : formatRemotePath(parsed.alias, `${parsed.remotePath}/${tail}`)
}

/**
 * `relative` across remote operands, or `undefined` when neither side is
 * remote and the original implementation should run.
 *
 * Remote operands on the same host answer with a POSIX-relative path — which
 * is what a caller displaying workspace-relative results needs — and mixed
 * operands answer with the right-hand operand unchanged.
 *
 * @param {string} from - the base path.
 * @param {string} to - the target path.
 * @param {Function} posixRelative - the captured POSIX `relative`.
 * @returns {string | undefined} the relative spelling, or undefined to defer.
 */
function relativeRemoteSpelling (from, to, posixRelative) {
  const fromRemote = isRemotePath(from)
  const toRemote = isRemotePath(to)
  if (!fromRemote && !toRemote) return undefined
  if (fromRemote && toRemote) {
    const base = tryParseRemotePath(from)
    const target = tryParseRemotePath(to)
    if (base === undefined || target === undefined) return undefined
    if (base.alias !== target.alias) return String(to)
    return posixRelative(base.remotePath, target.remotePath)
  }
  if (fromRemote && typeof to === 'string' && to.startsWith('/')) {
    const base = tryParseRemotePath(from)
    if (base === undefined) return undefined
    return posixRelative(base.remotePath, to)
  }
  return typeof to === 'string' ? to : undefined
}

/**
 * Patch the `node:path` spellings the Host computes around a remote cwd.
 *
 * The surfaces patched are the default export object and the `win32`/`posix`
 * namespaces; on Win32 the first two are one object and on POSIX the first and
 * last are, so duplicates are collapsed before any assignment. The POSIX
 * `relative` is captured before any patching, so the bridged `relative` can
 * compare remote paths with the real POSIX implementation.
 *
 * @param {object} state - live bridge state.
 * @returns {void}
 */
function installPathPatches (state) {
  const posixRelative = nodePath.posix.relative
  const seen = new Set()
  const entries = []
  for (const surface of [nodePath, nodePath.win32, nodePath.posix]) {
    if (surface === undefined || surface === null || seen.has(surface)) continue
    seen.add(surface)
    entries.push({
      surface,
      isAbsolute: surface.isAbsolute,
      resolve: surface.resolve,
      join: surface.join,
      relative: surface.relative,
    })
  }
  state.pathPatches = entries
  for (const entry of entries) {
    const { surface } = entry
    surface.isAbsolute = function isAbsolute (candidate) {
      if (isRemotePath(candidate)) return true
      return entry.isAbsolute(candidate)
    }
    surface.resolve = function resolve (...args) {
      const remote = resolveRemoteSpelling(args, entry)
      return remote ?? entry.resolve.apply(surface, args)
    }
    surface.join = function join (...args) {
      const remote = joinRemoteSpelling(args)
      return remote ?? entry.join.apply(surface, args)
    }
    surface.relative = function relative (from, to) {
      const remote = relativeRemoteSpelling(from, to, posixRelative)
      return remote ?? entry.relative.call(surface, from, to)
    }
  }
}

/** The per-name remote implementations, keyed by bridged fs function. */
const REMOTE_IMPLS = {
  mkdir: (args, state) => mkdirRemote(args[0], args[1], state),
  stat: (args, state) => statRemote(args[0], args[1], state),
  lstat: (args, state) => lstatRemote(args[0], args[1], state),
  readdir: (args, state) => readdirRemote(args[0], args[1], state),
  realpath: (args, state) => realpathRemote(args[0], args[1], state),
  open: (args, state) => openRemote(args[0], args[1], args[2], state),
}

/**
 * Patch the Host's builtins so `ssh://` targets are served by the engine.
 *
 * Idempotent per process: a second call (a plugin reload) only rebinds the live
 * engine and router the existing wrappers close over.
 *
 * @param {object} options - install options.
 * @param {import('./engine.js').SshWorkspaceEngine} options.engine - live SSH engine.
 * @param {import('./remote-fs.js').RemoteFileSystem} options.router - the mounted router.
 * @param {object} [options.logger] - a Cordis logger, when available.
 * @returns {object} the live bridge state.
 */
export function installBuiltinBridge ({ engine, router, logger }) {
  const existing = globalThis[BRIDGE]
  if (existing !== undefined) {
    existing.engine = engine
    existing.router = router
    existing.logger = logger
    return existing
  }
  const state = { engine, router, logger, originals: {}, pathPatches: [] }
  for (const name of BRIDGED) {
    const original = fsPromises[name]
    if (typeof original !== 'function') continue
    state.originals[name] = original
    fsPromises[name] = function (...args) {
      const primary = args[0]
      if (name === 'copyFile') {
        if ((typeof primary === 'string' && isRemotePath(primary)) || (typeof args[1] === 'string' && isRemotePath(args[1]))) {
          return copyFileRemote(primary, args[1], args[2], state)
        }
        return original.apply(fsPromises, args)
      }
      if (typeof primary !== 'string') return original.apply(fsPromises, args)
      if (name === 'rm') {
        if (isRemotePath(primary) || mirrorTargetOf(primary) !== undefined) return rmRemote(primary, args[1], state)
        return original.apply(fsPromises, args)
      }
      if (!isRemotePath(primary)) return original.apply(fsPromises, args)
      const impl = REMOTE_IMPLS[name]
      if (impl === undefined) return original.apply(fsPromises, args)
      return impl(args, state)
    }
  }
  installPathPatches(state)
  // Republishes the swapped functions onto the builtins' ESM facades, which are
  // the bindings every already-loaded `import ... from 'node:fs/promises'` and
  // `import { isAbsolute } from 'node:path'` in the Host resolves through.
  syncBuiltinESMExports()
  globalThis[BRIDGE] = state
  logger?.info?.(`ssh-workspace: bridged node:fs/promises (${Object.keys(state.originals).join(', ')}) and node:path spellings for ssh:// targets`)
  return state
}

/**
 * Undo {@link installBuiltinBridge}, restoring the builtin functions.
 *
 * @returns {void}
 */
export function uninstallBuiltinBridge () {
  const state = globalThis[BRIDGE]
  if (state === undefined) return
  for (const [name, original] of Object.entries(state.originals)) fsPromises[name] = original
  for (const entry of state.pathPatches) {
    entry.surface.isAbsolute = entry.isAbsolute
    entry.surface.resolve = entry.resolve
    entry.surface.join = entry.join
    entry.surface.relative = entry.relative
  }
  syncBuiltinESMExports()
  delete globalThis[BRIDGE]
}
