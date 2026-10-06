/**
 * The `ctx.fs` router and its SFTP-backed remote half.
 *
 * `ctx.fs` is a single service for the whole process, so a deployment that must
 * serve both host files and remote SSH files mounts ONE backend that dispatches
 * by target spelling:
 *
 * - `ssh://<alias>/<abs/path>` — the SFTP half in this module;
 * - every other path — the deployment's own local (sandboxed) backend, verbatim.
 *
 * The remote half implements the whole `dsh-fs` contract, which is why the
 * ordinary model-facing tools work on a remote workspace with no change at all.
 *
 * @module @shiqyka/dsh-ssh-workspace/remote-fs
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

/** Poll interval for remote change observation (SFTP has no notifications). */
const WATCH_POLL_INTERVAL_MS = 2000

/** Steady poll interval after {@link WATCH_QUIET_ROUNDS} unchanged rounds. */
const WATCH_SLOW_INTERVAL_MS = 5000

/** Ceiling of the quiet backoff: a change is still noticed within this. */
const WATCH_MAX_INTERVAL_MS = 10_000

/**
 * Unchanged polls before backing off once. At the base interval that is ~30s
 * of quiet before a watched path starts costing less, and the next step backs
 * off to the ceiling.
 */
const WATCH_QUIET_ROUNDS = 15

/**
 * TTL of the read-path metadata cache. Deliberately below the watch poll
 * interval so a poll can never mistake a cached snapshot for a fresh one.
 */
const CACHE_TTL_MS = 1500

/** Cap on cached metadata entries; the oldest entry is evicted beyond it. */
const CACHE_MAX_ENTRIES = 1024

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
    /**
     * Short-TTL metadata cache for read paths (stats, directory listings),
     * keyed `<alias>\0<kind>\0<path>`. Writes, deletes, the symlink fence and
     * the change watcher never read through it, and every mutation this
     * plugin performs drops the affected entries eagerly.
     *
     * @type {Map<string, {at: number, value: unknown}>}
     */
    this.cache = new Map()
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
    // A mount/mount change can alter what the alias serves; forget the view.
    this.#clearAliasCache(alias)
    return canonical
  }

  /**
   * Stop serving a remote workspace root.
   *
   * @param {string} workspacePath - the `ssh://` path to drop.
   * @returns {boolean} whether it was registered.
   */
  removeRoot (workspacePath) {
    const removed = this.roots.delete(normalizeWorkspace(workspacePath))
    const parsed = parseRemotePath(workspacePath)
    if (parsed !== undefined) this.#clearAliasCache(parsed.alias)
    return removed
  }

  /** Every registered remote root, canonical. @returns {string[]} roots. */
  listRoots () {
    return [...this.roots]
  }

  /**
   * Drop cached metadata for one path and its parent directory.
   *
   * Every mutation changes the target's own metadata and its parent's
   * listing, so both entries go. Called by this module's write path and by
   * the builtin-fs bridge after its mkdir/rm/copy operations; the watcher
   * calls it when it observes a change.
   *
   * @param {string} alias - host alias.
   * @param {string} remotePath - the mutated path.
   * @returns {void}
   */
  invalidateRemote (alias, remotePath) {
    const normalized = normalizeRemotePath(remotePath)
    this.#dropCached(alias, normalized)
    const parent = remoteDirname(normalized)
    if (parent !== normalized) this.#dropCached(alias, parent)
  }

  /**
   * One remote directory's raw entries, served through the metadata cache.
   *
   * The builtin-fs bridge's `readdir` (the Host's `@file` index) calls this so
   * the index and the file tree share one cache.
   *
   * @param {string} alias - host alias.
   * @param {string} remotePath - remote absolute directory.
   * @returns {Promise<Array<object>>} raw SFTP directory entries.
   */
  async listRemoteEntries (alias, remotePath) {
    const normalized = normalizeRemotePath(remotePath)
    return await this.#readdirCached({ alias, remotePath: normalized, displayPath: formatRemotePath(alias, normalized) })
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
      // A bare path inherits its remote identity from the cwd — see
      // `remoteSourceOf` for both the relative and the absolute spelling.
      const parts = this.#parse(remoteSourceOf(path, opts?.cwd))
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
    const stats = await this.#statCached(parts)
    throwIfAborted(signal, 'stat')
    if (stats === null) return undefined
    return { version: versionOf(stats), type: typeOf(stats), size: stats.size }
  }

  /** @inheritdoc */
  async lstat (path, opts, signal) {
    throwIfAborted(signal, 'lstat')
    // Both spellings the patch router sends here must be taken: a path that is
    // remote on its own, and a bare path whose remote identity comes from a
    // remote `cwd` (a session workspace root). Following a bare relative path
    // to the local backend would hand it back to the patch router, which routes
    // on the cwd again — an endless delegation ending in a stack overflow.
    if (isRemotePath(path) || isRemotePath(opts?.cwd ?? '')) {
      const parts = this.#parse(remoteSourceOf(path, opts?.cwd))
      const stats = await this.#lstatCached(parts)
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
    const stats = await this.#statCached(parts)
    if (stats === null) throw new FsError(`cannot read "${display}": not found`, 'FS_NOT_FOUND')
    if (typeOf(stats) !== 'file') throw new FsError(`cannot read "${display}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    const raw = await this.#readWhole(parts)
    throwIfAborted(signal, 'read')
    if (raw.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) throw new FsError(`cannot read "${display}": binary file`, 'FS_NOT_TEXT')
    return decodeUtf8(raw, 'read', display)
  }

  /**
   * Stream one remote text file as decoded chunks, in file order.
   *
   * The file is read lazily through an SFTP handle on the connection's
   * dedicated streaming channel (the shared channel stays free for stats,
   * listings and the change watcher), so a consumer that stops early (the
   * preview page cutter) or scans incrementally (the read tool) never holds
   * the whole file in memory; one SFTP connection pin covers the iteration
   * and is released when it ends or the consumer stops. Text semantics match
   * {@link readText}: regular-file check, NUL scan over the first sample, and
   * fatal UTF-8 decoding that spans chunk boundaries.
   *
   * @param {object} target - the target to stream.
   * @param {AbortSignal} signal - aborts the stream between chunks (`FS_ABORTED`).
   * @returns {Promise<AsyncGenerator<string>>} decoded text chunks.
   */
  streamText (target, signal) {
    const display = displayOf(target)
    if (!isRemotePath(display)) return this.base.streamText(target, signal)
    const parts = this.#parse(display)
    const engine = this.engine
    async function * generate () {
      throwIfAborted(signal, 'read')
      const record = await engine.acquire(parts.alias)
      record.idleAt = Date.now()
      record.inFlight += 1
      const sftp = await engine.streamChannel(record)
      let handle
      try {
        const stats = await statOrNull(sftp, parts.remotePath)
        throwIfAborted(signal, 'read')
        if (stats === null) throw new FsError(`cannot read "${display}": not found`, 'FS_NOT_FOUND')
        if (typeOf(stats) !== 'file') throw new FsError(`cannot read "${display}": not a regular file`, 'FS_NOT_REGULAR_FILE')
        handle = await openHandle(sftp, parts.remotePath, 'r', display)
        const decoder = new TextDecoder('utf-8', { fatal: true })
        let position = 0
        let sampled = 0
        while (true) {
          throwIfAborted(signal, 'read')
          const chunk = await readChunk(sftp, handle, position, CHUNK_BYTES, display)
          if (chunk.length === 0) break
          position += chunk.length
          if (sampled < BINARY_SAMPLE_BYTES) {
            const sample = chunk.subarray(0, Math.min(chunk.length, BINARY_SAMPLE_BYTES - sampled))
            if (sample.includes(0)) throw new FsError(`cannot read "${display}": binary file`, 'FS_NOT_TEXT')
            sampled += sample.length
          }
          yield decodeUtf8Stream(decoder, chunk, 'read', display)
        }
        yield decodeUtf8Stream(decoder, undefined, 'read', display)
      } finally {
        if (handle !== undefined) await closeHandle(sftp, handle)
        record.inFlight -= 1
        record.idleAt = Date.now()
      }
    }
    return Promise.resolve(generate())
  }

  /** @inheritdoc */
  async readBytes (target, signal, maxBytes) {
    const display = displayOf(target)
    if (!isRemotePath(display)) return await this.base.readBytes(target, signal, maxBytes)
    const parts = this.#parse(display)
    throwIfAborted(signal, 'read')
    const stats = await this.#statCached(parts)
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
    const stats = await this.#statCached(parts)
    if (stats === null) throw new FsError(`cannot list "${display}": not found`, 'FS_NOT_FOUND')
    if (typeOf(stats) !== 'directory') throw new FsError(`cannot list "${display}": not a directory`, 'FS_NOT_DIRECTORY')
    const entries = await this.#readdirCached(parts)
    throwIfAborted(signal, 'list')
    const result = []
    for (const entry of entries.slice().sort((left, right) => left.filename.localeCompare(right.filename))) {
      throwIfAborted(signal, 'list')
      const childRemote = joinRemote(parts.remotePath, entry.filename)
      const childDisplay = formatRemotePath(parts.alias, childRemote)
      const childStats = await this.#statCached({ alias: parts.alias, remotePath: childRemote })
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
   * Observe one remote file or a directory's direct entries.
   *
   * SFTP has no portable change notification, so observation polls: one stat
   * (file target) or directory listing (directory target) per interval,
   * compared against the previous snapshot. Semantics match the local
   * backend's depth-0 watcher — a directory target reports any direct entry
   * appearing, changing or leaving; a file target (including an absent path,
   * observed for creation) reports only that path. The callback keeps the
   * seam's contract: no argument for a change, an Error for a failure the
   * poller cannot continue past — after which polling stops and the caller
   * closes. The first snapshot doubles as initialization, so the returned
   * promise rejects (rather than resolving) when the target cannot be observed
   * at all.
   *
   * @param {object} target - the target to watch.
   * @param {Function} changed - invalidation callback.
   * @param {AbortSignal} signal - cancels initialization (and stops a live watcher).
   * @returns {Promise<Function>} resolves with an async close function.
   */
  // `async` for parity with the local backend: a pre-aborted signal must surface
  // as a rejected promise (as `fs-local`'s async watch does), never a sync throw.
  async watch (target, changed, signal) {
    signal?.throwIfAborted?.()
    const display = displayOf(target)
    if (!isRemotePath(display)) return this.base.watch(target, changed, signal)
    const parts = this.#parse(display)
    // The poller reads the server directly (never its own cache) and drops the
    // cached metadata for the target and its parent before notifying, so a
    // consumer that refetches on change reads fresh data.
    const invalidate = () => this.invalidateRemote(parts.alias, parts.remotePath)
    return startRemoteWatch(this.engine, parts, changed, signal, invalidate)
  }

  /** Stat a remote path, returning null when it is absent. */
  async #statOrNull (parts) {
    return await this.engine.withSftp(parts.alias, async (sftp) => await statOrNull(sftp, parts.remotePath))
  }

  /** lstat a remote path, returning null when it is absent. */
  async #lstatOrNull (parts) {
    return await this.engine.withSftp(parts.alias, async (sftp) => await lstatOrNull(sftp, parts.remotePath))
  }

  /** Stat through the metadata cache (read paths only). */
  async #statCached (parts) {
    return await this.#cached(parts.alias, 'stat', parts.remotePath, async () => await this.#statOrNull(parts))
  }

  /** lstat through the metadata cache (read paths only). */
  async #lstatCached (parts) {
    return await this.#cached(parts.alias, 'lstat', parts.remotePath, async () => await this.#lstatOrNull(parts))
  }

  /** Readdir through the metadata cache (read paths only). */
  async #readdirCached (parts) {
    return await this.#cached(parts.alias, 'readdir', parts.remotePath, async () =>
      await this.engine.withSftp(parts.alias, async (sftp) => await readdir(sftp, parts.remotePath, parts.displayPath)))
  }

  /**
   * Serve one metadata read through the short-TTL cache.
   *
   * Only read paths (file tree, previews, the `@` index) come through here.
   * Failures are never cached, so an error always reflects a live attempt.
   *
   * @template T
   * @param {string} alias - host alias.
   * @param {string} kind - 'stat' | 'lstat' | 'readdir'.
   * @param {string} remotePath - the path the value describes.
   * @param {() => Promise<T>} load - the live SFTP read.
   * @returns {Promise<T>} the cached or freshly loaded value.
   */
  async #cached (alias, kind, remotePath, load) {
    const key = `${alias}\u0000${kind}\u0000${normalizeRemotePath(remotePath)}`
    const entry = this.cache.get(key)
    if (entry !== undefined && Date.now() - entry.at < CACHE_TTL_MS) return entry.value
    if (entry !== undefined) this.cache.delete(key)
    const value = await load()
    this.cache.set(key, { at: Date.now(), value })
    if (this.cache.size > CACHE_MAX_ENTRIES) {
      // Map preserves insertion order; drop the oldest inserted key.
      const oldest = this.cache.keys().next()
      if (oldest.done !== true) this.cache.delete(oldest.value)
    }
    return value
  }

  /** Drop every cached kind for one path. */
  #dropCached (alias, remotePath) {
    for (const kind of ['stat', 'lstat', 'readdir']) {
      this.cache.delete(`${alias}\u0000${kind}\u0000${remotePath}`)
    }
  }

  /** Drop every cached entry of one host (mount/unmount). */
  #clearAliasCache (alias) {
    const prefix = `${alias}\u0000`
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(prefix)) this.cache.delete(key)
    }
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
    try {
      await this.engine.withSftp(parts.alias, async (sftp) => {
        // The staged rename itself is safe against a symlinked final component,
        // but an intermediate directory link would still steer the staging
        // directory (and the publication) outside the fence — check the real
        // shape before anything is created.
        await assertFencedRealpath(sftp, parts.alias, parts.remotePath, this.roots)
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
    } finally {
      // Any outcome may have changed the remote shape — the fallback publish
      // can leave the destination removed when its rename fails — so both the
      // target and its parent listing are forgotten unconditionally.
      this.invalidateRemote(parts.alias, parts.remotePath)
    }
  }
}

/**
 * Poll one remote target until closed: a directory's direct entries, or a
 * single file — an absent path included, observed for creation. Each poll
 * rides `withSftp`, so between polls the connection is free for reaping.
 *
 * Polls always read the server (the metadata cache is never consulted), and a
 * change that is observed first invalidates the cached metadata for the target
 * and its parent, then notifies. The interval adapts: 2s while changes are
 * recent, backing off to 5s and then 10s over quiet stretches, snapping back
 * to 2s on the first observed change.
 *
 * @param {import('./engine.js').SshWorkspaceEngine} engine - live engine.
 * @param {{alias: string, remotePath: string, displayPath: string}} parts - the target.
 * @param {Function} changed - invalidation callback.
 * @param {AbortSignal} signal - initialization (and live) cancellation.
 * @param {Function} [invalidate] - drops cached metadata for the target.
 * @returns {Promise<Function>} resolves with an async close function.
 */
async function startRemoteWatch (engine, parts, changed, signal, invalidate) {
  const aborted = () => signal?.aborted === true
  if (aborted()) throw new FsError('watch aborted', 'FS_ABORTED')
  const observe = () => engine.withSftp(parts.alias, async (sftp) => {
    const stats = await statOrNull(sftp, parts.remotePath)
    if (stats === null) return { kind: 'absent' }
    if (typeOf(stats) !== 'directory') return { kind: 'file', version: versionOf(stats) }
    let entries
    try {
      entries = await readdir(sftp, parts.remotePath, parts.displayPath)
    } catch (error) {
      // The directory vanished between stat and listing: that is a change,
      // not a polling failure.
      if (fsCodeOf(error) === 'FS_NOT_FOUND') return { kind: 'absent' }
      throw error
    }
    const snapshot = new Map()
    for (const entry of entries) snapshot.set(entry.filename, versionOf(entry.attrs ?? {}))
    return { kind: 'directory', snapshot }
  })

  let previous = await observe()
  if (aborted()) throw new FsError('watch aborted', 'FS_ABORTED')
  let closed = false
  let timer
  // Adaptive interval: recent change → the base interval; a long quiet stretch
  // backs off in two steps up to the ceiling, and any change snaps back.
  let interval = WATCH_POLL_INTERVAL_MS
  let quietRounds = 0
  const stop = () => {
    closed = true
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }
  const schedule = () => {
    timer = setTimeout(() => { tick() }, interval)
    if (typeof timer.unref === 'function') timer.unref()
  }
  async function tick () {
    if (closed) return
    if (aborted()) {
      stop()
      return
    }
    let next
    try {
      next = await observe()
    } catch (error) {
      if (closed) return
      stop()
      changed(error instanceof Error ? error : new Error(String(error)))
      return
    }
    if (closed) return
    if (!sameObservation(previous, next)) {
      previous = next
      quietRounds = 0
      interval = WATCH_POLL_INTERVAL_MS
      try { invalidate?.() } catch { /* invalidation must not stop polling */ }
      try { changed() } catch { /* a throwing consumer must not stop polling */ }
    } else {
      quietRounds += 1
      if (quietRounds === WATCH_QUIET_ROUNDS) interval = WATCH_SLOW_INTERVAL_MS
      else if (quietRounds === WATCH_QUIET_ROUNDS * 2) interval = WATCH_MAX_INTERVAL_MS
    }
    if (!closed) schedule()
  }
  schedule()
  return async () => { stop() }
}

/** Snapshot equality for {@link startRemoteWatch}. */
function sameObservation (left, right) {
  if (left.kind !== right.kind) return false
  if (left.kind === 'file') return left.version === right.version
  if (left.kind === 'directory') {
    if (left.snapshot.size !== right.snapshot.size) return false
    for (const [name, version] of left.snapshot) {
      if (right.snapshot.get(name) !== version) return false
    }
    return true
  }
  return true
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

/**
 * Enforce the remote fence against the filesystem's real shape.
 *
 * The lexical fence cannot see symbolic links, so an intermediate directory —
 * or, for a write, the final component itself — that points outside the
 * mounted roots would let a mutation land outside the fence even though every
 * spelling says otherwise. This check keeps the lexical test as the fast path,
 * then asks the server to resolve: the deepest existing component of the
 * target (or, with `includeLeaf`, the target itself) must `realpath` inside
 * one of the same-alias roots. Roots are resolved the same way, so a root
 * reached through a symlinked home directory still matches. Paths that do not
 * exist are fine — a delete then no-ops and a write creates fresh, link-free
 * directories — but anything that cannot be resolved at all (`realpath`
 * failing on an existing component) surfaces as `FS_NOT_FOUND`, never as a
 * silent pass.
 *
 * @param {any} sftp - a live SFTP channel.
 * @param {string} alias - host alias.
 * @param {string} remotePath - the target path.
 * @param {Set<string>} roots - registered `ssh://` workspace roots.
 * @param {object} [options] - check options.
 * @param {boolean} [options.includeLeaf] - resolve the target itself too
 *   (default true: writes follow a final symlink); false starts at the parent
 *   (deletes may legitimately remove an escaping symlink itself).
 * @param {string} [options.verb] - word for the error message (default 'write').
 * @returns {Promise<void>} resolves when the existing components stay inside a root.
 * @throws {FsError} `FS_SANDBOX_DENIED` on a lexical or resolved escape,
 *   `FS_NOT_FOUND` when an existing component cannot be resolved.
 */
export async function assertFencedRealpath (sftp, alias, remotePath, roots, options = {}) {
  const displayPath = formatRemotePath(alias, remotePath)
  const verb = typeof options.verb === 'string' && options.verb !== '' ? options.verb : 'write'
  const denied = (reason) => new FsError(`cannot ${verb} "${displayPath}": ${reason}`, 'FS_SANDBOX_DENIED')
  const candidates = []
  for (const root of roots) {
    const parsed = parseRemotePath(root)
    if (parsed === undefined || parsed.alias !== alias) continue
    const base = parsed.remotePath
    if (remotePath === base || remotePath.startsWith(base === '/' ? '/' : `${base}/`)) candidates.push(base)
  }
  if (candidates.length === 0) {
    throw denied('outside every mounted remote workspace (mount it first with ssh_workspace_mount)')
  }
  const resolvedRoots = []
  for (const candidate of candidates) resolvedRoots.push(await realpathOrNull(sftp, candidate) ?? candidate)
  const insideResolvedRoots = (resolved) => resolvedRoots.some(root => resolved === root || resolved.startsWith(root === '/' ? '/' : `${root}/`))
  const start = options.includeLeaf === false ? remoteDirname(remotePath) : normalizeRemotePath(remotePath)
  const anchor = await deepestExistingAncestor(sftp, start)
  if (anchor === null) {
    // Nothing along the path exists. A delete is a no-op; a write is about to
    // create every missing level, which cannot pass through a link that is not
    // there — but only accept that when the starting point itself was checked.
    if (options.includeLeaf === false) return
    throw new FsError(`cannot ${verb} "${displayPath}": not found`, 'FS_NOT_FOUND')
  }
  let anchorReal
  try {
    anchorReal = await realpathStrict(sftp, anchor)
  } catch (error) {
    throw new FsError(`cannot ${verb} "${displayPath}": not found`, 'FS_NOT_FOUND', { cause: error })
  }
  if (!insideResolvedRoots(anchorReal)) {
    throw denied('a symbolic link resolves outside every mounted remote workspace')
  }
}

/** The remote root prefix of a path (`/a/b` → `/a`). */
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
 * The remote spelling a bare path-resolution call operates on.
 *
 * Used by `resolve`/`lstat`, whose callers may hand in a path that is remote
 * only through its `cwd` — the session's workspace root. A relative name
 * extends the cwd's remote path, exactly as a local relative path extends the
 * local cwd. A bare ABSOLUTE name addresses the remote host's own root: in a
 * remote session the session's filesystem IS the remote one, so `/home/…`
 * reads as remote-absolute precisely as `/etc/hosts` reads as local-absolute
 * in a local session. This is the spelling the workspace-file preview sends
 * for a `@file` mention (its `path` is the workspace-relative candidate path)
 * and for any absolute path outside the workspace root.
 *
 * @param {string} path - the caller's path.
 * @param {string | undefined} cwd - the caller's base; remote whenever the
 *   caller took the remote branch.
 * @returns {string} a spelling {@link remotePartsOf} accepts.
 */
function remoteSourceOf (path, cwd) {
  if (isRemotePath(path)) return path
  if (typeof path === 'string' && path.startsWith('/')) {
    const parsed = parseRemotePath(cwd)
    if (parsed !== undefined) return formatRemotePath(parsed.alias, path)
  }
  return joinRemote(cwd, path)
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

/** Incremental strict-UTF-8 decode; `undefined` chunk flushes the decoder. */
function decodeUtf8Stream (decoder, chunk, verb, displayPath) {
  try {
    return chunk === undefined ? decoder.decode() : decoder.decode(chunk, { stream: true })
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    throw new FsError(`cannot ${verb} "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT')
  }
}

/** Collapse CRLF to LF — the canonical in-memory form. */
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

/** `realpath`; any failure means the caller cannot trust the spelling. */
function realpathStrict (sftp, path) {
  return new Promise((resolve, reject) => {
    sftp.realpath(path, (error, resolved) => {
      if (error !== undefined && error !== null) reject(error)
      else if (typeof resolved !== 'string' || resolved === '') reject(new Error(`realpath returned no path for ${path}`))
      else resolve(resolved)
    })
  })
}

/** `realpath`, or null when the server cannot resolve the path. */
function realpathOrNull (sftp, path) {
  return new Promise((resolve) => {
    sftp.realpath(path, (error, resolved) => {
      if (error !== undefined && error !== null) resolve(null)
      else resolve(typeof resolved === 'string' && resolved !== '' ? resolved : null)
    })
  })
}

/**
 * The deepest existing path at or above `remotePath`, or null when even the
 * root cannot be observed.
 *
 * @param {any} sftp - the SFTP channel.
 * @param {string} remotePath - the normalized starting path.
 * @returns {Promise<string | null>} the anchor, or null.
 */
async function deepestExistingAncestor (sftp, remotePath) {
  let current = normalizeRemotePath(remotePath)
  while (true) {
    if (await lstatOrNull(sftp, current) !== null) return current
    if (current === '/') return null
    current = remoteDirname(current)
  }
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

/** Read one chunk from a handle at `position`; empty at end of file. */
function readChunk (sftp, handle, position, length, displayPath) {
  return new Promise((resolve, reject) => {
    const buffer = Buffer.allocUnsafe(length)
    sftp.read(handle, buffer, 0, length, position, (error, read) => {
      if (error !== undefined && error !== null) reject(wrap(error, 'read', displayPath))
      else resolve(buffer.subarray(0, read ?? 0))
    })
  })
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
  closeHandle as sftpCloseHandle,
  lstatOrNull as sftpLstatOrNull,
  mkdirp as sftpMkdirp,
  mkdirStrict as sftpMkdirStrict,
  openHandle as sftpOpenHandle,
  readdir as sftpReaddir,
  readHandle as sftpReadHandle,
  statOrNull as sftpStatOrNull,
  writeHandle as sftpWriteHandle,
}
