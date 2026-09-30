/**
 * The `ctx.fs` router and its SFTP-backed remote half.
 *
 * `ctx.fs` is a single service for the whole process, so a deployment that must
 * serve both host files and remote SSH files mounts ONE backend that dispatches
 * by target spelling:
 *
 * - `ssh://<alias>/<abs/path>` 閳?the SFTP half in this module;
 * - every other path 閳?the deployment's own local (sandboxed) backend, verbatim.
 *
 * The remote half implements the whole `dsh-fs` contract, which is why the
 * ordinary model-facing tools work on a remote workspace with no change at all.
 *
 * @module @dsh-community/dsh-ssh-workspace/remote-fs
 */

import { randomBytes } from 'node:crypto'
import {
  formatRemoteFileUrl,
  formatRemotePath,
  isRemotePath,
  normalizeRemotePath,
  parseRemotePath,
  remoteBasename,
  remoteDirname,
} from './protocol.js'

import { requirePeer } from './peers.js'

const { FsError, FsTargetKey, FsVersion } = requirePeer('@deepseek-ai/dsh-fs')

/** Bytes sampled for the NUL-byte binary check, matching `fs-local`. */
const BINARY_SAMPLE_BYTES = 8192

/** Read/write chunk for SFTP transfers. */
const CHUNK_BYTES = 256 * 1024

/** Cap on the ancestor walk performed when creating a parent directory chain. */
const MAX_MKDIR_DEPTH = 64

/**
 * Map a raw SFTP/ssh2 failure onto the seam's typed error taxonomy.
 *
 * Backends must raise `FsError` with a stable code so consumers branch on the
 * code and never on message text.
 *
 * @param {unknown} error - the underlying failure.
 * @returns {string} an `FsErrorCode`.
 */
function fsCodeOf (error) {
  const code = error?.code
  if (code === 2 || code === 'ENOENT' || /no such file/iu.test(error?.message ?? '')) return 'FS_NOT_FOUND'
  if (code === 3 || code === 'EACCES' || code === 'EPERM' || /permission denied/iu.test(error?.message ?? '')) return 'FS_PERMISSION_DENIED'
  return 'FS_IO_ERROR'
}

/**
 * Wrap an SFTP failure as an `FsError` naming the operation and path.
 *
 * @param {unknown} error - underlying failure.
 * @param {string} verb - the operation being attempted.
 * @param {string} displayPath - caller-facing path.
 * @returns {Error} the typed error to throw.
 */
function wrap (error, verb, displayPath) {
  if (error instanceof FsError) return error
  const code = fsCodeOf(error)
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'FS_NOT_FOUND') return new FsError(`cannot ${verb} "${displayPath}": not found`, code, { cause: error })
  if (code === 'FS_PERMISSION_DENIED') return new FsError(`cannot ${verb} "${displayPath}": permission denied`, code, { cause: error })
  return new FsError(`cannot ${verb} "${displayPath}": ${message}`, code, { cause: error })
}

/** Raise the structured abort error when the signal has fired. */
function throwIfAborted (signal, verb) {
  if (signal?.aborted) throw new FsError(`${verb} aborted`, 'FS_ABORTED')
}

/** Stable version token from remote metadata (no sub-second field over SFTP). */
function versionOf (stats) {
  const ino = stats.ino ?? 0
  const mtime = stats.mtime ?? 0
  return FsVersion(`${ino}:${stats.size}:${mtime}`)
}

/** Classify a remote stat result into the seam's path-type vocabulary. */
function typeOf (stats) {
  if (typeof stats.isDirectory === 'function' && stats.isDirectory()) return 'directory'
  if (typeof stats.isFile === 'function' && stats.isFile()) return 'file'
  return 'other'
}

/** Classify without following the final symlink. */
function linkTypeOf (stats) {
  if (typeof stats.isSymbolicLink === 'function' && stats.isSymbolicLink()) return 'symlink'
  return typeOf(stats)
}

/** POSIX permission bits from remote metadata. */
function modeOf (stats) {
  return typeof stats.mode === 'number' ? stats.mode & 0o777 : undefined
}

/**
 * The `ctx.fs` router.
 *
 * Remote targets are served over SFTP; everything else is delegated unchanged
 * to the deployment's local backend, so local workspaces keep their exact
 * previous behaviour (including the sandbox write fence, which the local
 * backend owns).
 */
export class RemoteFileSystem {
  /**
   * @param {object} options - router options.
   * @param {import('./engine.js').SshWorkspaceEngine} options.engine - live SSH engine.
   * @param {object} [options.base] - the surrounding backend, used for local paths.
   * @param {object} [options.baseProto] - the prototype carrying the surrounding
   *   backend's original methods, used to build an unpatched forwarder.
   */
  constructor (options) {
    this.engine = options.engine
    this.base = options.base
    this.baseProto = options.baseProto
    /**
     * Remote workspaces this router has been asked to serve. A path is confined
     * to its own remote root: writes are refused outside every mounted root,
     * which is the remote counterpart of the local `workspace-write` fence.
     *
     * @type {Set<string>}
     */
    this.roots = new Set()
    // Advertise the LOCAL backend's confinement fact, because that is the
    // capability the escalation UI describes. Remote targets are fenced by
    // `roots` below and never consult this value.
    const localMode = this.base?.sandboxMode
    if (localMode !== undefined) {
      Object.defineProperty(this, 'sandboxMode', { value: localMode, enumerable: true, configurable: true })
    }
  }

  /**
   * Register a remote directory as a served workspace root.
   *
   * @param {string} alias - host alias.
   * @param {string} remotePath - remote absolute directory.
   * @returns {string} the canonical `ssh://` workspace path.
   */
  addRoot (alias, remotePath) {
    const canonical = formatRemotePath(alias, remotePath)
    this.roots.add(canonical)
    return canonical
  }

  /**
   * Stop serving a remote workspace root.
   *
   * @param {string} workspacePath - the `ssh://` path to drop.
   * @returns {boolean} whether it was registered.
   */
  removeRoot (workspacePath) {
    return this.roots.delete(normalizeWorkspace(workspacePath))
  }

  /** Every registered remote root, canonical. @returns {string[]} roots. */
  listRoots () {
    return [...this.roots]
  }

  /**
   * Parse and validate a remote spelling.
   *
   * @param {string} path - a candidate `ssh://` path.
   * @returns {{alias: string, remotePath: string, displayPath: string, targetKey: string, workspacePath: string}} parts.
   */
  #parse (path) {
    return remotePartsOf(path)
  }

  /** @inheritdoc */
  async resolve (path, opts) {
    throwIfAborted(opts?.signal, 'resolve')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    if (isRemotePath(path) || isRemotePath(opts?.cwd ?? '')) {
      // A bare absolute/relative remote path inherits its alias from the
      // session's remote workspace root, exactly as a local relative path
      // inherits the local cwd.
      const source = isRemotePath(path) ? path : joinRemote(opts?.cwd, path)
      const parts = this.#parse(source)
      return { targetKey: FsTargetKey(parts.targetKey), displayPath: parts.displayPath }
    }
    if (this.base === undefined) throw new FsError(`cannot resolve "${path}": no local filesystem backend is mounted`, 'FS_IO_ERROR')
    return await this.base.resolve(path, opts)
  }

  /** @inheritdoc */
  processPath (target) {
    const display = String(target?.targetKey ?? target?.displayPath ?? '')
    if (isRemotePath(display)) return this.#parse(display).remotePath
    if (this.base !== undefined) return this.base.processPath(target)
    return display
  }

  /** @inheritdoc */
  processPathFromHostPath (hostPath) {
    return this.base?.processPathFromHostPath(hostPath)
  }

  /** @inheritdoc */
  fileUrl (target) {
    const display = displayOf(target)
    if (isRemotePath(display)) {
      // The canonical `file:` URI of the REMOTE execution world, not the
      // host's: dsh-fs leaves URI encoding to the backend because the
      // execution platform may differ, and consumers (the workspace-file
      // service) derive `/`-joined relative paths from `new URL().pathname`.
      return formatRemoteFileUrl(this.#parse(display).remotePath)
    }
    return this.base?.fileUrl(target)
  }

  /** @inheritdoc */
  contains (parent, child) {
    const parentPath = String(parent?.targetKey ?? '')
    const childPath = String(child?.targetKey ?? '')
    if (isRemotePath(parentPath) || isRemotePath(childPath)) {
      if (!isRemotePath(parentPath) || !isRemotePath(childPath)) return false
      const root = this.#parse(parentPath)
      const target = this.#parse(childPath)
      if (root.alias !== target.alias) return false
      return target.remotePath === root.remotePath || target.remotePath.startsWith(root.remotePath === '/' ? '/' : `${root.remotePath}/`)
    }
    return this.base?.contains(parent, child) ?? false
  }

  /** @inheritdoc */
  async stat (target, signal) {
    throwIfAborted(signal, 'stat')
    const display = displayOf(target)
    if (!isRemotePath(display)) return await this.base.stat(target, signal)
    const parts = this.#parse(display)
    const stats = await this.#statOrNull(parts)
    throwIfAborted(signal, 'stat')
    if (stats === null) return undefined
    return { version: versionOf(stats), type: typeOf(stats), size: stats.size }
  }

  /** @inheritdoc */
  async lstat (path, opts, signal) {
    throwIfAborted(signal, 'lstat')
    if (isRemotePath(path)) {
      const parts = this.#parse(path)
      const stats = await this.#lstatOrNull(parts)
      if (stats === null) return undefined
      return { version: versionOf(stats), type: linkTypeOf(stats), size: stats.size }
    }
    return await this.base.lstat(path, opts, signal)
  }

  /** @inheritdoc */
  async readText (target, signal) {
    const display = displayOf(target)
    if (!isRemotePath(display)) return await this.base.readText(target, signal)
    const parts = this.#parse(display)
    throwIfAborted(signal, 'read')
    const stats = await this.#statOrNull(parts)
    if (stats === null) throw new FsError(`cannot read "${display}": not found`, 'FS_NOT_FOUND')
    if (typeOf(stats) !== 'file') throw new FsError(`cannot read "${display}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    const raw = await this.#readWhole(parts)
    throwIfAborted(signal, 'read')
    if (raw.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) throw new FsError(`cannot read "${display}": binary file`, 'FS_NOT_TEXT')
    return decodeUtf8(raw, 'read', display)
  }

  /** @inheritdoc */
  streamText (target, signal) {
    const display = displayOf(target)
    if (!isRemotePath(display)) return this.base.streamText(target, signal)
    // A remote read is already materialized by the SFTP half; expose it as a
    // one-chunk stream so callers that prefer streaming still work. The
    // generator awaits the read before its first yield, so a rejection
    // surfaces from the first `next()` exactly as a streaming consumer expects.
    const read = this.readText(target, signal)
    return Promise.resolve((async function * () { yield await read })())
  }

  /** @inheritdoc */
  async readBytes (target, signal, maxBytes) {
    const display = displayOf(target)
    if (!isRemotePath(display)) return await this.base.readBytes(target, signal, maxBytes)
    const parts = this.#parse(display)
    throwIfAborted(signal, 'read')
    const stats = await this.#statOrNull(parts)
    if (stats === null) throw new FsError(`cannot read "${display}": not found`, 'FS_NOT_FOUND')
    if (typeOf(stats) !== 'file') throw new FsError(`cannot read "${display}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    if (typeof maxBytes === 'number' && stats.size > maxBytes) {
      throw new FsError(`cannot read "${display}": ${stats.size} bytes exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
    }
    return await this.#readWhole(parts)
  }

  /** @inheritdoc */
  async readByteRange (target, range, signal) {
    const display = displayOf(target)
    if (!isRemotePath(display)) return await this.base.readByteRange(target, range, signal)
    const parts = this.#parse(display)
    throwIfAborted(signal, 'read')
    if (range.length === 0) return new Uint8Array(0)
    return await this.engine.withSftp(parts.alias, async (sftp) => {
      const handle = await openHandle(sftp, parts.remotePath, 'r', display)
      try {
        return await readHandle(sftp, handle, range.offset, range.length, display)
      } finally {
        await closeHandle(sftp, handle)
      }
    })
  }

  /** @inheritdoc */
  async listDir (target, signal) {
    const display = displayOf(target)
    if (!isRemotePath(display)) return await this.base.listDir(target, signal)
    const parts = this.#parse(display)
    throwIfAborted(signal, 'list')
    const stats = await this.#statOrNull(parts)
    if (stats === null) throw new FsError(`cannot list "${display}": not found`, 'FS_NOT_FOUND')
    if (typeOf(stats) !== 'directory') throw new FsError(`cannot list "${display}": not a directory`, 'FS_NOT_DIRECTORY')
    const entries = await this.engine.withSftp(parts.alias, async (sftp) => await readdir(sftp, parts.remotePath, display))
    throwIfAborted(signal, 'list')
    const result = []
    for (const entry of entries.slice().sort((left, right) => left.filename.localeCompare(right.filename))) {
      throwIfAborted(signal, 'list')
      const childRemote = joinRemote(parts.remotePath, entry.filename)
      const childDisplay = formatRemotePath(parts.alias, childRemote)
      const childStats = await this.#statOrNull({ alias: parts.alias, remotePath: childRemote })
      result.push({
        name: entry.filename,
        type: childStats === null ? 'other' : typeOf(childStats),
        target: { targetKey: FsTargetKey(childDisplay), displayPath: childDisplay },
        ...(childStats !== null ? { version: versionOf(childStats) } : {}),
        ...(childStats !== null && typeOf(childStats) === 'file' ? { size: childStats.size } : {}),
      })
    }
    return result
  }

  /**
   * The remote write fence: a mutation is refused unless the target lies inside
   * a registered remote workspace root.
   *
   * @param {{alias: string, remotePath: string, displayPath: string}} parts - the target.
   * @throws {FsError} `FS_SANDBOX_DENIED` when no root covers the target.
   */
  #assertWritable (parts) {
    assertWithinRemoteRoots(this.roots, parts)
  }

  /** @inheritdoc */
  async writeText (target, content, expected, signal, sandboxPolicy) {
    const display = displayOf(target)
    if (!isRemotePath(display)) return await this.base.writeText(target, content, expected, signal, sandboxPolicy)
    const parts = this.#parse(display)
    this.#assertWritable(parts)
    throwIfAborted(signal, 'write')
    const existing = await this.#statOrNull(parts)
    if (existing !== null && typeOf(existing) !== 'file') throw new FsError(`cannot write "${display}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    if (expected?.kind === 'replaceIfVersion') {
      if (existing === null) throw new FsError(`cannot write "${display}": file no longer exists`, 'FS_STALE_VERSION')
      if (versionOf(existing) !== expected.version) throw new FsError(`cannot write "${display}": file changed since it was read`, 'FS_STALE_VERSION')
    } else if (expected?.kind === 'createIfAbsent' && existing !== null) {
      throw new FsError(`cannot overwrite existing "${display}" without reading it first`, 'FS_NOT_OBSERVED')
    }
    const before = existing === null ? null : await this.#readTextOrNull(parts)
    await this.#publish(parts, content, modeOf(existing ?? {}) )
    const after = await this.#statOrNull(parts)
    return {
      operation: existing === null ? 'create' : 'update',
      version: after === null ? FsVersion(`missing:${display}`) : versionOf(after),
      before,
      after: normalizeLineEndings(content),
    }
  }

  /** @inheritdoc */
  async editText (target, edit, expected, signal) {
    const display = displayOf(target)
    if (!isRemotePath(display)) return await this.base.editText(target, edit, expected, signal)
    const parts = this.#parse(display)
    this.#assertWritable(parts)
    throwIfAborted(signal, 'edit')
    const existing = await this.#statOrNull(parts)
    if (existing === null) throw new FsError(`cannot edit "${display}": file changed since it was read`, 'FS_STALE_VERSION')
    if (typeOf(existing) !== 'file') throw new FsError(`cannot edit "${display}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    if (expected !== undefined && expected !== null && versionOf(existing) !== expected) {
      throw new FsError(`cannot edit "${display}": file changed since it was read`, 'FS_STALE_VERSION')
    }
    const raw = await this.#readWhole(parts)
    if (raw.includes(0)) throw new FsError(`cannot edit "${display}": binary file`, 'FS_NOT_TEXT')
    const decoded = decodeUtf8(raw, 'edit', display)
    const original = normalizeLineEndings(decoded)
    const edited = applyLiteralEdit(original, edit.oldString, edit.newString, edit.replaceAll, display)
    const content = restoreLineEndings(edited.content, detectLineEndings(decoded))
    await this.#publish(parts, content, modeOf(existing))
    const after = await this.#statOrNull(parts)
    return {
      version: after === null ? FsVersion(`missing:${display}`) : versionOf(after),
      before: original,
      after: edited.content,
    }
  }

  /**
   * SFTP has no portable change notification, and the seam's own guidance is
   * that an unsupported provider must reject rather than poll. Consumers fall
   * back to `fs/observed` invalidations, which ordinary reads and writes emit.
   *
   * @param {object} target - the target to watch.
   * @param {Function} changed - invalidation callback (unused).
   * @param {AbortSignal} signal - initialization cancellation.
   * @returns {Promise<never>} always rejects.
   */
  watch (target, changed, signal) {
    signal?.throwIfAborted?.()
    const display = displayOf(target)
    if (!isRemotePath(display)) return this.base.watch(target, changed, signal)
    return Promise.reject(new FsError(`cannot watch "${display}": remote change watch is not supported over SFTP`, 'FS_IO_ERROR'))
  }

  /** Stat a remote path, returning null when it is absent. */
  async #statOrNull (parts) {
    return await this.engine.withSftp(parts.alias, async (sftp) => await statOrNull(sftp, parts.remotePath))
  }

  /** lstat a remote path, returning null when it is absent. */
  async #lstatOrNull (parts) {
    return await this.engine.withSftp(parts.alias, async (sftp) => await lstatOrNull(sftp, parts.remotePath))
  }

  /** Read a whole remote file as bytes. */
  async #readWhole (parts) {
    return await this.engine.withSftp(parts.alias, async (sftp) => {
      const handle = await openHandle(sftp, parts.remotePath, 'r', parts.displayPath)
      try {
        return await readHandle(sftp, handle, 0, undefined, parts.displayPath)
      } finally {
        await closeHandle(sftp, handle)
      }
    })
  }

  /** Read a whole remote text file, or null when unreadable/non-text. */
  async #readTextOrNull (parts) {
    try {
      const raw = await this.#readWhole(parts)
      if (raw.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) return null
      return normalizeLineEndings(decodeUtf8(raw, 'read', parts.displayPath))
    } catch {
      // A best-effort diff basis: failure must never block the write.
      return null
    }
  }

  /**
   * Publish content atomically: stage a sibling temp file, then rename it over
   * the target. POSIX `rename` within one directory is atomic, so a reader sees
   * either the old file or the new one, never a partial write.
   */
  async #publish (parts, content, mode) {
    const buffer = Buffer.from(content, 'utf8')
    const parent = remoteDirname(parts.remotePath)
    const token = randomBytes(8).toString('hex')
    const stagingDir = joinRemote(parent, `.dsh-tmp-${token}`)
    const stagingFile = joinRemote(stagingDir, remoteBasename(parts.remotePath))
    await this.engine.withSftp(parts.alias, async (sftp) => {
      await mkdirp(sftp, stagingDir, parts.displayPath)
      let handle
      try {
        await chmodStrict(sftp, stagingDir, 0o700)
        handle = await openHandle(sftp, stagingFile, 'wx', parts.displayPath, 0o600)
        await writeHandle(sftp, handle, buffer, parts.displayPath)
        await closeHandle(sftp, handle)
        handle = undefined
        if (mode !== undefined) await chmodStrict(sftp, stagingFile, mode)
        await publishRename(sftp, stagingFile, parts.remotePath, true)
      } catch (error) {
        if (handle !== undefined) await closeHandle(sftp, handle).catch(() => {})
        await removeStrict(sftp, stagingDir).catch(() => {})
        throw wrap(error, 'write', parts.displayPath)
      }
      await removeStrict(sftp, stagingDir).catch(() => {})
    })
  }
}

/** The caller-facing display path of a target. */
function displayOf (target) {
  if (typeof target === 'string') return target
  return String(target?.displayPath ?? target?.targetKey ?? '')
}

/**
 * Parse one `ssh://` spelling into the parts every remote operation routes on.
 * Module-level (rather than only a private method) because the builtin-fs
 * bridge classifies the same spellings without a router instance.
 *
 * @param {string} path - a candidate `ssh://` path.
 * @returns {{alias: string, remotePath: string, displayPath: string, targetKey: string, workspacePath: string}} parts.
 * @throws {FsError} `FS_NOT_FOUND` when the spelling is not a remote target.
 */
export function remotePartsOf (path) {
  const parsed = parseRemotePath(path)
  if (parsed === undefined) throw new FsError(`not a remote path: ${JSON.stringify(path)}`, 'FS_NOT_FOUND')
  const displayPath = formatRemotePath(parsed.alias, parsed.remotePath)
  return {
    ...parsed,
    displayPath,
    targetKey: displayPath,
    workspacePath: `${'ssh'}://${parsed.alias}${rootOf(parsed.remotePath)}`,
  }
}

/**
 * Whether a remote target lies inside one of the registered remote roots.
 *
 * @param {Set<string>} roots - registered `ssh://` workspace roots.
 * @param {{alias: string, remotePath: string}} parts - the target.
 * @returns {boolean} true when a root on the same host contains the target.
 */
export function isWithinRemoteRoots (roots, parts) {
  for (const root of roots) {
    const parsed = parseRemotePath(root)
    if (parsed === undefined || parsed.alias !== parts.alias) continue
    if (parts.remotePath === parsed.remotePath || parts.remotePath.startsWith(parsed.remotePath === '/' ? '/' : `${parsed.remotePath}/`)) return true
  }
  return false
}

/**
 * Enforce the remote write fence.
 *
 * @param {Set<string>} roots - registered `ssh://` workspace roots.
 * @param {{alias: string, remotePath: string, displayPath: string}} parts - the target.
 * @throws {FsError} `FS_SANDBOX_DENIED` when no root covers the target.
 */
export function assertWithinRemoteRoots (roots, parts) {
  if (isWithinRemoteRoots(roots, parts)) return
  throw new FsError(
    `cannot write "${parts.displayPath}": outside every mounted remote workspace (mount it first with ssh_workspace_mount)`,
    'FS_SANDBOX_DENIED',
  )
}

/** The remote root prefix of a path (`/a/b` 閳?`/a`). */
function rootOf (remotePath) {
  const normalized = normalizeRemotePath(remotePath)
  const segments = normalized.split('/').filter(segment => segment !== '')
  return segments.length === 0 ? '/' : `/${segments[0]}`
}

/** Canonicalize a workspace path spelling. */
function normalizeWorkspace (path) {
  const parsed = parseRemotePath(path)
  if (parsed === undefined) return String(path)
  return formatRemotePath(parsed.alias, parsed.remotePath)
}

/**
 * Join a POSIX path, tolerating a missing or remote base.
 *
 * @param {string | undefined} base - remote base directory or `ssh://` root.
 * @param {string} name - child path, absolute or relative.
 * @returns {string} the joined remote path.
 */
function joinRemote (base, name) {
  if (isRemotePath(name)) return name
  if (name.startsWith('/')) return name
  let alias
  let directory
  if (typeof base === 'string' && base !== '') {
    const parsed = parseRemotePath(base)
    if (parsed !== undefined) {
      alias = parsed.alias
      directory = parsed.remotePath
    } else {
      directory = base
    }
  }
  const joined = normalizeRemotePath(`${directory ?? '/'}/${name}`)
  return alias === undefined ? joined : formatRemotePath(alias, joined)
}

/** Decode strict UTF-8, raising the seam's not-text error. */
function decodeUtf8 (buffer, verb, displayPath) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    throw new FsError(`cannot ${verb} "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT')
  }
}

/** Collapse CRLF to LF 閳?the canonical in-memory form. */
function normalizeLineEndings (content) {
  return content.replaceAll('\r\n', '\n')
}

/** Detect a file's dominant line-ending style. */
function detectLineEndings (raw) {
  const sample = raw.slice(0, 4096)
  const crlf = sample.split('\r\n').length - 1
  return crlf > sample.split('\n').length - 1 - crlf ? 'CRLF' : 'LF'
}

/** Convert LF-normalized content back to the original style. */
function restoreLineEndings (content, lineEndings) {
  return lineEndings === 'LF' ? content : normalizeLineEndings(content).split('\n').join('\r\n')
}

/** Count non-overlapping occurrences of `needle`. */
function countOccurrences (content, needle) {
  let count = 0
  let index = 0
  while (true) {
    const found = content.indexOf(needle, index)
    if (found === -1) return count
    count += 1
    index = found + needle.length
  }
}

/**
 * Apply one literal search/replace over LF-normalized content.
 *
 * @param {string} content - current content.
 * @param {string} oldString - literal to find.
 * @param {string} newString - literal replacement.
 * @param {boolean} replaceAll - replace every match.
 * @param {string} displayPath - caller-facing path for messages.
 * @returns {{content: string, replacements: number}} the edited content.
 */
function applyLiteralEdit (content, oldString, newString, replaceAll, displayPath) {
  const oldNorm = normalizeLineEndings(oldString ?? '')
  if (oldNorm.length === 0) throw new FsError('old_string must be a non-empty string', 'FS_EDIT_NOT_FOUND')
  const newNorm = normalizeLineEndings(newString ?? '')
  const replacements = countOccurrences(content, oldNorm)
  if (replacements === 0) throw new FsError(`old_string was not found in "${displayPath}"`, 'FS_EDIT_NOT_FOUND')
  if (replaceAll !== true && replacements > 1) {
    throw new FsError(`old_string matched ${replacements} times in "${displayPath}"; provide a more specific old_string or set replace_all to true`, 'FS_AMBIGUOUS_EDIT')
  }
  return { content: content.split(oldNorm).join(newNorm), replacements }
}

// --- promisified SFTP primitives ------------------------------------------
// ssh2 exposes a Node-callback API. Every helper below is the single place a
// callback is adapted, so no `FsError` handling leaks into the call sites.

/** Stat following symlinks; null when absent. */
function statOrNull (sftp, path) {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (error, stats) => {
      if (error !== undefined && error !== null) {
        if (fsCodeOf(error) === 'FS_NOT_FOUND') resolve(null)
        else reject(error)
        return
      }
      resolve(stats)
    })
  })
}

/** Stat without following the final symlink; null when absent. */
function lstatOrNull (sftp, path) {
  return new Promise((resolve, reject) => {
    sftp.lstat(path, (error, stats) => {
      if (error !== undefined && error !== null) {
        if (fsCodeOf(error) === 'FS_NOT_FOUND') resolve(null)
        else reject(error)
        return
      }
      resolve(stats)
    })
  })
}

/** List one directory's raw entries. */
function readdir (sftp, path, displayPath) {
  return new Promise((resolve, reject) => {
    sftp.readdir(path, (error, list) => {
      if (error !== undefined && error !== null) reject(wrap(error, 'list', displayPath))
      else resolve(list ?? [])
    })
  })
}

/** Open a remote file handle, mapping failures to typed errors. */
function openHandle (sftp, path, flags, displayPath, mode) {
  return new Promise((resolve, reject) => {
    const callback = (error, handle) => {
      if (error !== undefined && error !== null) reject(wrap(error, 'open', displayPath))
      else resolve(handle)
    }
    if (mode === undefined) sftp.open(path, flags, callback)
    else sftp.open(path, flags, { mode }, callback)
  })
}

/** Close a handle, swallowing close-time errors (the operation already ended). */
function closeHandle (sftp, handle) {
  return new Promise((resolve) => {
    if (handle === undefined || handle === null) {
      resolve()
      return
    }
    sftp.close(handle, () => { resolve() })
  })
}

/**
 * Read from a handle.
 *
 * @param {any} sftp - the SFTP channel.
 * @param {Buffer} handle - open handle.
 * @param {number} offset - starting byte.
 * @param {number | undefined} length - byte cap, or undefined for the whole file.
 * @param {string} displayPath - caller-facing path.
 * @returns {Promise<Buffer>} the bytes read.
 */
async function readHandle (sftp, handle, offset, length, displayPath) {
  const chunks = []
  let position = offset
  let remaining = length
  while (true) {
    const want = remaining === undefined ? CHUNK_BYTES : Math.min(CHUNK_BYTES, remaining)
    if (want <= 0) break
    const buffer = Buffer.allocUnsafe(want)
    const bytesRead = await new Promise((resolve, reject) => {
      sftp.read(handle, buffer, 0, want, position, (error, read) => {
        if (error !== undefined && error !== null) reject(wrap(error, 'read', displayPath))
        else resolve(read ?? 0)
      })
    })
    if (bytesRead === 0) break
    chunks.push(buffer.subarray(0, bytesRead))
    position += bytesRead
    if (remaining !== undefined) remaining -= bytesRead
    if (bytesRead < want) break
  }
  return Buffer.concat(chunks)
}

/** Write a whole buffer to an open handle. */
async function writeHandle (sftp, handle, buffer, displayPath) {
  let position = 0
  while (position < buffer.length) {
    const length = Math.min(CHUNK_BYTES, buffer.length - position)
    const written = await new Promise((resolve, reject) => {
      sftp.write(handle, buffer, position, length, position, (error) => {
        if (error !== undefined && error !== null) reject(wrap(error, 'write', displayPath))
        else resolve(length)
      })
    })
    position += written
  }
}

/** Create a directory (single level), ignoring an existing one. */
function mkdirStrict (sftp, path, displayPath, mode) {
  return new Promise((resolve, reject) => {
    const callback = (error) => {
      if (error === undefined || error === null) {
        resolve()
        return
      }
      // Already exists is success for our purposes.
      if (error.code === 4 && /exists/iu.test(error.message ?? '')) {
        resolve()
        return
      }
      reject(wrap(error, 'mkdir', displayPath))
    }
    if (mode === undefined) sftp.mkdir(path, callback)
    else sftp.mkdir(path, { mode }, callback)
  })
}

/** Create a directory chain, tolerating existing intermediate levels. */
async function mkdirp (sftp, path, displayPath, mode) {
  const normalized = normalizeRemotePath(path)
  if (normalized === '/') return
  const segments = normalized.split('/').filter(segment => segment !== '')
  let current = ''
  let depth = 0
  for (const segment of segments) {
    current += `/${segment}`
    depth += 1
    if (depth > MAX_MKDIR_DEPTH) throw new FsError(`cannot create "${displayPath}": path is nested more than ${MAX_MKDIR_DEPTH} levels`, 'FS_IO_ERROR')
    const existing = await statOrNull(sftp, current)
    if (existing !== null) {
      if (typeOf(existing) !== 'directory') throw new FsError(`cannot create "${displayPath}": "${current}" is not a directory`, 'FS_NOT_DIRECTORY')
      continue
    }
    await mkdirStrict(sftp, current, displayPath, mode)
  }
}

/** Rename, mapping failures to a typed error. */
function renameStrict (sftp, from, to) {
  return new Promise((resolve, reject) => {
    sftp.rename(from, to, (error) => {
      if (error !== undefined && error !== null) reject(error)
      else resolve()
    })
  })
}

/**
 * Publish a staged file over its destination.
 *
 * Plain SFTP `rename` is specified to fail when the destination exists, and
 * OpenSSH's server enforces that, so an ordinary atomic overwrite needs the
 * `posix-rename@openssh.com` extension the server advertises. When it is absent
 * the destination is removed first and the rename retried: the publication is
 * no longer atomic, but it is the strongest guarantee the protocol offers and
 * is why the fallback is worth having at all.
 *
 * @param {any} sftp - the SFTP channel.
 * @param {string} from - staged file path.
 * @param {string} to - destination path.
 * @param {boolean} replace - whether the destination may already exist.
 * @returns {Promise<void>} resolves once the destination holds the staged file.
 * @throws {Error} when neither strategy publishes the file.
 */
async function publishRename (sftp, from, to, replace) {
  const extensions = sftp?._extensions
  const supportsPosixRename = typeof sftp.ext_openssh_rename === 'function'
    && extensions !== undefined
    && extensions['posix-rename@openssh.com'] !== undefined
  if (supportsPosixRename) {
    await new Promise((resolve, reject) => {
      sftp.ext_openssh_rename(from, to, (error) => {
        if (error !== undefined && error !== null) reject(error)
        else resolve()
      })
    })
    return
  }
  try {
    await renameStrict(sftp, from, to)
    return
  } catch (error) {
    if (!replace) throw error
    // No positional-replace extension: clear the destination, then rename.
    const removed = await new Promise((resolve) => {
      sftp.unlink(to, (unlinkError) => resolve(unlinkError === undefined || unlinkError === null))
    })
    if (!removed) return await renameStrict(sftp, from, to)
    await renameStrict(sftp, from, to)
  }
}

/** chmod that tolerates a server without the extension. */
function chmodStrict (sftp, path, mode) {
  return new Promise((resolve, reject) => {
    if (typeof sftp.chmod !== 'function') {
      resolve()
      return
    }
    sftp.chmod(path, mode, (error) => {
      // A server refusing chmod must not fail an otherwise good write.
      if (error !== undefined && error !== null) resolve()
      else resolve()
    })
  })
}

/** Best-effort recursive removal of a staging directory. */
function removeStrict (sftp, path) {
  return new Promise((resolve, reject) => {
    sftp.readdir(path, (listError, entries) => {
      if (listError !== undefined && listError !== null) {
        reject(listError)
        return
      }
      const files = (entries ?? []).filter(entry => {
        if (typeof entry.attrs?.isDirectory === 'function' && entry.attrs.isDirectory()) return false
        return true
      })
      let index = 0
      const next = () => {
        if (index >= files.length) {
          sftp.rmdir(path, (error) => {
            if (error !== undefined && error !== null) reject(error)
            else resolve()
          })
          return
        }
        sftp.unlink(`${path}/${files[index].filename}`, () => {
          index += 1
          next()
        })
      }
      next()
    })
  })
}

export { normalizeRemotePath, formatRemotePath, remoteDirname, remoteBasename, isRemotePath }

// The SFTP primitives are also the builtin-fs bridge's (fs-shim.js) only way to
// touch the wire, so they are exported rather than re-adapted there.
export {
  lstatOrNull as sftpLstatOrNull,
  mkdirp as sftpMkdirp,
  mkdirStrict as sftpMkdirStrict,
  statOrNull as sftpStatOrNull,
}
