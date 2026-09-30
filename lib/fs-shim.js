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
 * Only `ssh://` spellings are diverted; every other path is forwarded to the
 * original implementation, so host behavior is unchanged. Remote reads are
 * unfenced exactly as they are on `ctx.fs`; `mkdir` is a mutation and obeys the
 * mounted-root fence; `isAbsolute` answers true for `ssh://` spellings and
 * defers otherwise.
 *
 * @module @dsh-community/dsh-ssh-workspace/fs-shim
 */

import fsPromises from 'node:fs/promises'
import nodePath from 'node:path'
import { syncBuiltinESMExports } from 'node:module'

import { isRemotePath } from './protocol.js'
import {
  assertWithinRemoteRoots,
  isWithinRemoteRoots,
  remotePartsOf,
  sftpLstatOrNull,
  sftpMkdirp,
  sftpMkdirStrict,
  sftpStatOrNull,
} from './remote-fs.js'

/** Builtin fs functions the bridge takes over. */
const BRIDGED = ['mkdir', 'stat', 'lstat', 'realpath']

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

/** The per-function remote implementations, keyed like {@link BRIDGED}. */
const REMOTE_IMPLS = {
  mkdir: mkdirRemote,
  stat: statRemote,
  lstat: lstatRemote,
  realpath: realpathRemote,
}

/**
 * Patch `node:path.isAbsolute` so `ssh://` spellings report absolute.
 *
 * The Session service validates a new header with this predicate before it is
 * persisted, and the Workspace registry checks it before a workspace may own a
 * session — both reject a bare `ssh://` spelling on every platform. The
 * surfaces patched are the default export object and the `win32`/`posix`
 * namespaces; on Win32 the first two are one object and on POSIX the first and
 * last are, so duplicates are collapsed before any assignment.
 *
 * @param {object} state - live bridge state.
 * @returns {void}
 */
function installAbsolutePatch (state) {
  const seen = new Set()
  const patches = []
  for (const surface of [nodePath, nodePath.win32, nodePath.posix]) {
    if (surface === undefined || surface === null || seen.has(surface)) continue
    seen.add(surface)
    const original = surface.isAbsolute
    if (typeof original !== 'function') continue
    patches.push([surface, original])
  }
  for (const [surface, original] of patches) {
    surface.isAbsolute = function isAbsolute (candidate) {
      if (isRemotePath(candidate)) return true
      return original(candidate)
    }
  }
  state.absolutePatches = patches
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
  const state = { engine, router, logger, originals: {}, absolutePatches: [] }
  for (const name of BRIDGED) {
    const original = fsPromises[name]
    if (typeof original !== 'function') continue
    state.originals[name] = original
    const impl = REMOTE_IMPLS[name]
    fsPromises[name] = (...args) => {
      const [path] = args
      if (typeof path === 'string' && isRemotePath(path)) return impl(path, args[1], state)
      return original.apply(fsPromises, args)
    }
  }
  installAbsolutePatch(state)
  // Republishes the swapped functions onto the builtins' ESM facades, which are
  // the bindings every already-loaded `import ... from 'node:fs/promises'` and
  // `import { isAbsolute } from 'node:path'` in the Host resolves through.
  syncBuiltinESMExports()
  globalThis[BRIDGE] = state
  logger?.info?.(`ssh-workspace: bridged node:fs/promises (${Object.keys(state.originals).join(', ')}) and node:path.isAbsolute for ssh:// targets`)
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
  for (const [surface, original] of state.absolutePatches) surface.isAbsolute = original
  syncBuiltinESMExports()
  delete globalThis[BRIDGE]
}
