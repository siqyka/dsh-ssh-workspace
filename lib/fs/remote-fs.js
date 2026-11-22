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
} from '../core/protocol.js'

import { requirePeer } from '../core/peers.js'
import { KINDS } from '../core/diagnostics.js'
import { writeModeRefusal, workspaceWriteScopeRefusal } from '../core/mode-gate.js'
import { RemoteWatchRegistry } from './remote-watch.js'

const { FsError, FsTargetKey, FsVersion } = requirePeer('@deepseek-ai/dsh-fs')

/** Bytes sampled for the NUL-byte binary check, matching `fs-local`. */
const BINARY_SAMPLE_BYTES = 8192

/** Read/write chunk for SFTP transfers. */
const CHUNK_BYTES = 256 * 1024

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
   * Whether the host-local content-capture limit has been reported already.
   *
   * It is a property of this deployment, not of one write, so repeating it on
   * every edit would bury the other diagnostics. The flag lives on the router
   * instance, which is per activation: a plugin reload starts a fresh router
   * and reports once again.
   *
   * @type {boolean}
   */
  #captureLimitNoted = false

  /**
   * @param {object} [options.baseProto] - the prototype carrying the surrounding
   *   backend's original methods, used to build an unpatched forwarder.
   * @param {object} [options.passthrough] - local-prefix matcher from
   *   `passthrough.js`. Matching paths keep the local backend's meaning even
   *   when the call's cwd is an `ssh://` target.
   */
  constructor (options) {
    this.engine = options.engine
    this.base = options.base
    this.baseProto = options.baseProto
    this.logger = options.logger
    this.passthrough = options.passthrough ?? { matches: () => false }
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
    /**
     * Live change watchers, one per remote target, keyed
     * `<alias>\0<normalized path>`.
     *
     * A registry, not a set of independent watchers: the file tree can ask to
     * watch the same target twice (one request per host and one per workspace,
     * or an old subscription that has not finished closing yet), and two pollers
     * on one path used to double every event while each kept its own reconnect
     * loop and its own timer alive. Consumers share the underlying watcher; the
     * last close stops it.
     *
     * @type {Map<string, object>}
     */
    this.watchRegistry = new RemoteWatchRegistry({
      engine: this.engine,
      invalidate: (parts) => this.invalidateRemote(parts.alias, parts.remotePath),
      observe: (parts) => this.#observeForWatch(parts),
      isDirectory: async (parts) => {
        const stats = await this.#statOrNull(parts)
        return stats !== null && typeOf(stats) === 'directory'
      },
    })
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
   */
  addRoot (alias, remotePath) {
    const canonical = formatRemotePath(alias, remotePath)
    this.roots.add(canonical)
    // A mount is the opposite of a detach: drop any stale mark on this path so
    // a mount always ends served rather than silently half-served.
    this.engine?.markWorkspaceDisabled?.(canonical, false)
    // A mount/mount change can alter what the alias serves; forget the view.
    this.#clearAliasCache(alias)
    return canonical
  }

  /**
   * Stop serving a remote workspace root.
   *
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
   * Mark one remote workspace as detached: every operation inside it is
   * refused until {@link enableRoot} or {@link addRoot}.
   *
   * The path is removed from the served roots too, so a caller cannot leave a
   * workspace both served and disabled (which would make the fence's answer
   * depend on check order).
   *
   * @returns {boolean} whether it had been served.
   */
  disableRoot (workspacePath) {
    const canonical = normalizeWorkspace(workspacePath)
    const wasServed = this.roots.delete(canonical)
    this.engine?.markWorkspaceDisabled?.(canonical, true)
    const parsed = parseRemotePath(workspacePath)
    if (parsed !== undefined) this.#clearAliasCache(parsed.alias)
    return wasServed
  }

  /**
   * Lift the disabled mark from one workspace without mounting it.
   *
   * @returns {boolean} whether a mark was removed.
   */
  enableRoot (workspacePath) {
    const target = normalizeWorkspace(workspacePath)
    const had = this.engine?.disabledWorkspaces?.has?.(target) === true
    this.engine?.markWorkspaceDisabled?.(target, false)
    return had
  }

  /** Every detached workspace path. @returns {string[]} disabled roots. */
  listDisabled () {
    return [...(this.engine?.disabledWorkspaces ?? [])]
  }

  /**
   * Whether one remote target lies inside a detached workspace.
   *
   * Public so the HTTP routes and the agent tools can refuse a target BEFORE
   * they open a connection of their own (the transfer/download/upload routes
   * drive SFTP directly rather than through this router).
   *
   * @returns {boolean} whether the target is inside a detached workspace.
   */
  isDetached (alias, remotePath) {
    return this.engine?.isDisabledTarget?.(alias, remotePath) === true
  }

  /**
   * Refuse a target inside a detached workspace, for callers that reach SFTP
   * without going through one of the router's own methods.
   *
   * @throws {FsError} `FS_PERMISSION_DENIED` when the target is inside a detached workspace.
   */
  assertEnabled (alias, remotePath) {
    if (!this.isDetached(alias, remotePath)) return
    // `FS_PERMISSION_DENIED`, not `FS_SANDBOX_DENIED`: this is a refused
    // operation, but not a sandbox-policy one, and the host's tool layer rewrites
    // every sandbox denial into a mode-named marker plus an escalation hint —
    // both meaningless here, since no permission change re-enables a workspace
    // the user turned off. The code also keeps the 403 the Host's own file
    // endpoint already answers for a permission failure.
    throw new FsError(
      `cannot access "${formatRemotePath(alias, remotePath)}": the remote workspace is detached (re-enable it in the panel or with ssh_workspace_enable)`,
      'FS_PERMISSION_DENIED',
    )
  }

  /**
   * Drop every cached entry for one workspace path.
   *
   * Called when the workspace is detached or re-enabled: the cached metadata
   * from the other state must not be served under the new one.
   *
   */
  invalidateWorkspace (workspacePath) {
    const parsed = parseRemotePath(workspacePath)
    if (parsed === undefined) return
    this.#clearAliasCache(parsed.alias)
  }

  /**
   * Drop cached metadata for one path and its parent directory.
   *
   * Every mutation changes the target's own metadata and its parent's
   * listing, so both entries go. Called by this module's write path and by
   * the builtin-fs bridge after its mkdir/rm/copy operations; the watcher
   * calls it when it observes a change.
   *
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
   * @returns {Promise<Array<object>>} raw SFTP directory entries.
   */
  async listRemoteEntries (alias, remotePath) {
    const normalized = normalizeRemotePath(remotePath)
    return await this.#readdirCached({ alias, remotePath: normalized, displayPath: formatRemotePath(alias, normalized) })
  }

  /**
   * Parse and validate a remote spelling.
   *
   */
  #parse (path) {
    return remotePartsOf(path)
  }

  /**
   * Whether a call names a host path the caller is allowed to read locally.
   *
   * The scheme check comes first: a remote spelling must never be diverted even
   * if its text happens to look like a local prefix under an unusual matcher.
   *
   * @param {unknown} spelling - the caller's path.
   * @returns {boolean} true when the local backend should answer.
   */
  #isPassthrough (spelling) {
    return typeof spelling === 'string' && !isRemotePath(spelling) && this.passthrough?.matches?.(spelling) === true
  }

  /**
   * The host spelling a passthrough call must use, or undefined.
   *
   * A scheme spelling is stripped (`local:/x` reads `/x` from the host), so the
   * local backend never receives a prefix it does not understand. A bare host
   * reference comes back unchanged.
   *
   * @param {unknown} spelling - the caller's path.
   * @returns {string | undefined} the local path, or undefined when this call is not a passthrough.
   */
  #localSpelling (spelling) {
    if (typeof spelling !== 'string' || isRemotePath(spelling)) return undefined
    const local = this.passthrough?.localSpelling?.(spelling)
    if (typeof local === 'string' && local !== '') return local
    // A matcher that predates `localSpelling` (an older matcher handed to a
    // freshly loaded router during a hot reload) still routes by `matches`.
    return this.#isPassthrough(spelling) ? spelling : undefined
  }

  /**
   * The refusal a scheme spelling deserves when nobody authorized it.
   *
   * A scheme the user configured but did not grant this path is a loud denial,
   * never a silent rewrite into the remote world: `local:/etc/passwd` must not
   * be read from the host just because the model typed a prefix, and it must not
   * quietly become `ssh://host/etc/passwd` either — that would answer a question
   * the caller did not ask.
   *
   * @param {unknown} spelling - the caller's path.
   * @returns {FsError | undefined} the error to throw, or undefined when the spelling carries no scheme.
   */
  #unauthorizedScheme (spelling, verb) {
    if (typeof spelling !== 'string' || isRemotePath(spelling)) return undefined
    if (this.passthrough?.isSchemeSpelling?.(spelling) !== true) return undefined
    if (this.passthrough?.matches?.(spelling) === true) return undefined
    const scheme = this.passthrough?.scheme ?? 'local'
    return new FsError(
      `cannot ${verb} "${spelling}": the "${scheme}:" scheme only reads host paths the user configured or referenced with @ ` +
        '(add the prefix to localPassthrough or mention the path in a message)',
      'FS_PERMISSION_DENIED',
    )
  }

  /**
   * The host spelling a remote-miss fallback would read, or undefined.
   *
   * Two gates, both required: the flag the user opted into, and a path the user
   * actually pointed at. Without the second, `read('/etc/passwd')` would probe
   * the host whenever the remote side happened to lack the file.
   *
   * The spelling tested is the REMOTE PATH of the target, not the `ssh://` one:
   * a bare `@/Volumes/SSD/x.md` mention is recorded as `/Volumes/SSD/x.md`, and
   * by the time a verb sees the target the cwd has been folded into the display
   * spelling.
   *
   * @returns {string | undefined} the host path to try, or undefined.
   */
  #fallbackSpelling (parts) {
    if (this.base === undefined) return undefined
    if (this.passthrough?.remoteMissFallback !== true) return undefined
    const remotePath = parts.remotePath
    if (typeof remotePath !== 'string' || remotePath === '') return undefined
    return this.passthrough?.isNamed?.(remotePath) === true ? remotePath : undefined
  }

  /**
   * Resolve the host copy of one fallback spelling.
   *
   * @returns {Promise<object | undefined>} the host target, or undefined when it cannot be resolved.
   */
  async #hostTarget (spelling, signal) {
    try {
      // Strip the cwd for the same recursion reason as `resolve`: the host
      // backend must never see the session's `ssh://` workspace root.
      return await this.base.resolve(spelling, { signal, cwd: undefined })
    } catch {
      // An unresolvable host path is simply "the fallback found nothing"; the
      // caller still reports the remote miss it started from.
      return undefined
    }
  }

  /**
   * The note appended to content that came from the host after a remote miss.
   *
   * A caller must never be told host bytes are remote bytes: the two are
   * different worlds and one of them is missing the file the caller asked for.
   *
   * @param {string} spelling - the path the caller asked for.
   */
  #fallbackNote (text, spelling, scheme) {
    const separator = text === '' || text.endsWith('\n') ? '' : '\n'
    return `${text}${separator}[ssh-workspace] 注意：远端不存在 "${spelling}"，本次内容来自本机回退。` +
      `如需固定读本机，请改用 ${scheme}:${spelling}。\n`
  }

  /**
   * Log one applied fallback.
   *
   * @param {string} display - the remote spelling the caller asked for.
   */
  #noteFallback (verb, spelling, display) {
    this.logger?.debug?.(`ssh-workspace: ${verb} fell back to the host copy of ${spelling} (remote ${display} is absent)`)
  }

  /**
   * The miss error, with the sentence a caller needs to get out of it.
   *
   * Two different worlds produce the same `FS_NOT_FOUND`, and the way forward
   * differs by which one happened, so the message says which:
   *
   * - the fallback was eligible and the host lacks the file too: "both sides
   *   lack it" — retrying is pointless, and only the scheme prefix can pin a
   *   host read that the user knows exists;
   * - the fallback was not eligible: the path still means remote. Most often
   *   this is a bare POSIX `@` mention on a Windows host, where the mention
   *   never entered the reference table at all (platform rules), so the checkbox
   *   cannot help and saying "tick the box" would be a lie.
   *
   * The message keeps the `cannot read "...": not found` shape every consumer
   * and test already branches on; the guidance is appended, never substituted.
   *
   * @returns {FsError} the error to throw.
   */
  #missError (parts) {
    const display = parts.displayPath
    const spelling = this.#fallbackSpelling(parts)
    const scheme = this.passthrough?.scheme ?? 'local'
    if (spelling !== undefined) {
      return new FsError(
        `cannot read "${display}": not found — the host copy "${spelling}" is missing as well, ` +
        `so nothing was read from either side. If the file does exist on this machine, spell it ` +
        `explicitly as ${scheme}:${spelling} (that prefix never falls back: it reads the host outright).`,
        'FS_NOT_FOUND',
      )
    }
    if (this.base !== undefined) {
      return new FsError(
        `cannot read "${display}": not found — this path was read on the remote host only. ` +
        `To read a file on THIS machine, spell it ${scheme}:<abs path> (see the remote workspace panel)` +
        `${this.#mentionAdvice()}.`,
        'FS_NOT_FOUND',
      )
    }
    return new FsError(`cannot read "${display}": not found`, 'FS_NOT_FOUND')
  }

  /**
   * Whether pointing the caller at the `@` fallback would be honest here.
   *
   * The reference table is platform-scoped: a bare POSIX mention is only
   * recorded on a POSIX host, so on Windows the checkbox cannot rescue the
   * spelling that just missed and suggesting it would send the caller in
   * circles. Windows still has the `@` door — for drive and UNC mentions — but
   * those answer through passthrough outright rather than through the fallback,
   * so the only remedy left there is the explicit scheme.
   *
   */
  #mentionAdvice () {
    if (this.passthrough?.platform === 'win32') return ''
    return ', or name it with @ in a message and tick "read the host copy when the remote misses"'
  }

  /**
   * The host twin of an absent remote target, or undefined.
   *
   * The metadata half of the fallback: the host's own read path stats a target
   * before it reads it (`resolveRegularReadTarget`), so a read can only ever be
   * reached when `stat` already answered. Returning host metadata therefore does
   * not widen the fallback — it is what makes the read verbs below reachable at
   * all, and it answers with the host's size so the host decides between its
   * streaming and whole-file reads on real numbers.
   *
   * @returns {Promise<{spelling: string, target: object, info: object} | undefined>} the host twin.
   */
  async #hostTwin (parts, signal) {
    const spelling = this.#fallbackSpelling(parts)
    if (spelling === undefined) return undefined
    const target = await this.#hostTarget(spelling, signal)
    if (target === undefined) return undefined
    let info
    try {
      info = await this.base.stat(target, signal)
    } catch {
      return undefined
    }
    if (info === undefined) return undefined
    this.#noteFallback('stat', spelling, parts.displayPath)
    return { spelling, target, info }
  }

  /**
   * Read the host twin of an absent remote file as text, or undefined.
   *
   */
  async #hostText (parts, signal) {
    const twin = await this.#hostTwin(parts, signal)
    if (twin === undefined) return undefined
    const text = await this.base.readText(twin.target, signal)
    this.#noteFallback('read', twin.spelling, parts.displayPath)
    return this.#fallbackNote(text, twin.spelling, this.passthrough?.scheme ?? 'local')
  }

  /**
   * The detached-workspace fence: refuse a target that lives inside a
   * workspace the user unloaded.
   *
   * Called first in every remote operation, before any connection work, so a
   * detached workspace costs no SSH round trip and cannot be reached by a
   * stale cache entry either.
   *
   * @throws {FsError} `FS_PERMISSION_DENIED` when the target is inside a detached workspace.
   */
  #assertEnabled (parts) {
    if (this.engine?.isDisabledTarget?.(parts.alias, parts.remotePath) !== true) return
    // See the public `assertEnabled`: a detached workspace is not a sandbox
    // policy, and the host rewrites sandbox denials into an escalation hint that
    // cannot help here.
    throw new FsError(
      `cannot access "${parts.displayPath}": the remote workspace is detached (re-enable it in the panel or with ssh_workspace_enable)`,
      'FS_PERMISSION_DENIED',
    )
  }

  /** @inheritdoc */
  async resolve (path, opts) {
    throwIfAborted(opts?.signal, 'resolve')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const unauthorized = this.#unauthorizedScheme(path, 'resolve')
    if (unauthorized !== undefined) throw unauthorized
    if (this.#isPassthrough(path)) {
      const local = this.#localSpelling(path)
      if (this.base === undefined) throw new FsError(`cannot resolve "${path}": no local filesystem backend is mounted`, 'FS_IO_ERROR')
      // Strip the remote cwd: handing it back would route this call into this
      // same patched method again (routingSpelling reads opts.cwd) and recurse
      // until the stack overflow. The path alone carries the local intent.
      const localOpts = opts === undefined ? undefined : { ...opts, cwd: undefined }
      return await this.base.resolve(local ?? path, localOpts)
    }
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
    this.#assertEnabled(parts)
    const stats = await this.#statCached(parts)
    throwIfAborted(signal, 'stat')
    if (stats === null) {
      // The remote side has no such file. When the user opted into the
      // remote-first fallback AND pointed at this path, answer with the host
      // twin instead of "absent" — the read verbs below then find a target to
      // read, and the note they append says where the bytes came from.
      const twin = await this.#hostTwin(parts, signal)
      return twin === undefined ? undefined : twin.info
    }
    return { version: versionOf(stats), type: typeOf(stats), size: stats.size }
  }

  /** @inheritdoc */
  async lstat (path, opts, signal) {
    throwIfAborted(signal, 'lstat')
    const unauthorized = this.#unauthorizedScheme(path, 'lstat')
    if (unauthorized !== undefined) throw unauthorized
    if (this.#isPassthrough(path)) {
      if (this.base === undefined) throw new FsError(`cannot lstat "${path}": no local filesystem backend is mounted`, 'FS_IO_ERROR')
      // Strip the remote cwd for the same recursion reason as `resolve`, and
      // strip the scheme for the same reason a `local:` prefix is intent, not a
      // path component.
      const localOpts = opts === undefined ? undefined : { ...opts, cwd: undefined }
      const local = this.#localSpelling(path) ?? path
      return await this.base.lstat(local, localOpts, signal)
    }
    // Both spellings the patch router sends here must be taken: a path that is
    // remote on its own, and a bare path whose remote identity comes from a
    // remote `cwd` (a session workspace root). Following a bare relative path
    // to the local backend would hand it back to the patch router, which routes
    // on the cwd again — an endless delegation ending in a stack overflow.
    if (isRemotePath(path) || isRemotePath(opts?.cwd ?? '')) {
      const parts = this.#parse(remoteSourceOf(path, opts?.cwd))
      this.#assertEnabled(parts)
      const stats = await this.#lstatCached(parts)
      if (stats === null) {
        // Metadata only: a listing or a link probe of a path the user pointed
        // at may answer from the host, because that is what makes the read
        // verbs reachable. `readdir` is still remote-only — the fallback
        // widens files, never directories.
        const twin = await this.#hostTwin(parts, signal)
        if (twin === undefined) return undefined
        return {
          version: twin.info.version,
          type: twin.info.type,
          size: twin.info.size,
        }
      }
      return { version: versionOf(stats), type: linkTypeOf(stats), size: stats.size }
    }
    return await this.base.lstat(path, opts, signal)
  }

  /** @inheritdoc */
  async readText (target, signal) {
    const display = displayOf(target)
    if (!isRemotePath(display)) return await this.base.readText(target, signal)
    const parts = this.#parse(display)
    this.#assertEnabled(parts)
    throwIfAborted(signal, 'read')
    const stats = await this.#statCached(parts)
    if (stats === null) {
      // Remote-first, host-second: only a path the user actually pointed at,
      // and only when the user switched the fallback on. The note below is what
      // keeps host bytes from being reported as remote bytes.
      const text = await this.#hostText(parts, signal)
      if (text !== undefined) return text
      throw this.#missError(parts)
    }
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
   */
  streamText (target, signal) {
    const display = displayOf(target)
    if (!isRemotePath(display)) return this.base.streamText(target, signal)
    const parts = this.#parse(display)
    // Refused before the generator is built, so a detached workspace rejects
    // at call time the way every other read does rather than on first pull.
    try {
      this.#assertEnabled(parts)
    } catch (error) {
      return Promise.reject(error)
    }
    const engine = this.engine
    // Private names are in scope inside a nested function in a class body, so
    // the generator can reach the fallback helpers without widening them.
    const router = this
    async function * generate () {
      throwIfAborted(signal, 'read')
      const record = await engine.acquire(parts.alias)
      record.idleAt = Date.now()
      record.inFlight += 1
      const sftp = await engine.streamChannel(record)
      let handle
      let absent = false
      try {
        const stats = await statOrNull(sftp, parts.remotePath)
        throwIfAborted(signal, 'read')
        if (stats === null) {
          absent = true
        } else if (typeOf(stats) !== 'file') {
          throw new FsError(`cannot read "${display}": not a regular file`, 'FS_NOT_REGULAR_FILE')
        } else {
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
        }
      } finally {
        if (handle !== undefined) await closeHandle(sftp, handle)
        record.inFlight -= 1
        record.idleAt = Date.now()
      }
      if (!absent) return
      // The connection pin above is released before this point, so a long host
      // read never holds an SSH channel open for a file the remote lacks.
      const twin = await router.#hostTwin(parts, signal)
      if (twin === undefined) throw router.#missError(parts)
      const hostChunks = await router.base.streamText(twin.target, signal)
      for await (const chunk of hostChunks) {
        throwIfAborted(signal, 'read')
        yield chunk
      }
      router.#noteFallback('read', twin.spelling, parts.displayPath)
      yield router.#fallbackNote('', twin.spelling, router.passthrough?.scheme ?? 'local')
    }
    return Promise.resolve(generate())
  }

  /** @inheritdoc */
  async readBytes (target, signal, maxBytes) {
    const display = displayOf(target)
    if (!isRemotePath(display)) return await this.base.readBytes(target, signal, maxBytes)
    const parts = this.#parse(display)
    this.#assertEnabled(parts)
    throwIfAborted(signal, 'read')
    const stats = await this.#statCached(parts)
    if (stats === null) {
      // Bytes are the one read that must NOT be annotated: `read_image` sniffs
      // the payload's magic bytes, so a note appended here would break every
      // image the fallback serves. The debug line records the origin instead.
      const twin = await this.#hostTwin(parts, signal)
      if (twin !== undefined) {
        const data = await this.base.readBytes(twin.target, signal, maxBytes)
        this.#noteFallback('readBytes', twin.spelling, parts.displayPath)
        return data
      }
      throw this.#missError(parts)
    }
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
    this.#assertEnabled(parts)
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
    this.#assertEnabled(parts)
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
      // SFTP readdir already ships each entry's attributes, so the common path
      // needs no per-entry round trip — a directory of N children used to cost
      // 1 readdir + N serial stats. Only a non-standard server that omits
      // `attrs` falls back to the cached stat.
      const childStats = entry.attrs ?? await this.#statCached({ alias: parts.alias, remotePath: childRemote })
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
   * The mode the router enforces for one mutation: the caller's per-call policy
   * when it has one, else the deployment default the surrounding backend
   * advertises.
   *
   * The per-call policy is the ONLY carrier of a session override — a session
   * switched to `read-only` logs a `sandbox/mode` event that never reaches this
   * router any other way. Its absence is not "unconfined": it means an agentless
   * call, which the local backend answers with the same deployment default.
   *
   * @param {{mode?: string, workspaceRoot?: string} | undefined} sandboxPolicy - the per-call policy.
   * @returns {{mode: string, workspaceRoot: string} | undefined} the effective
   *   policy, or undefined when the composition does not confine at all.
   * @throws {FsError} never — an unresolvable policy is reported by the caller.
   */
  #writeModeOf (sandboxPolicy) {
    const fromCall = sandboxPolicy?.mode
    if (typeof fromCall === 'string' && fromCall !== '') {
      return {
        mode: fromCall,
        workspaceRoot: typeof sandboxPolicy?.workspaceRoot === 'string' ? sandboxPolicy.workspaceRoot : undefined,
      }
    }
    const fromBackend = this.base?.sandboxMode
    return typeof fromBackend === 'string' && fromBackend !== '' ? { mode: fromBackend } : undefined
  }

  /**
   * The remote write fence: a mutation is refused unless the session's sandbox
   * mode permits it AND the target lies inside the SESSION's workspace (or the
   * host temp area) AND that area is reachable on this deployment.
   *
   * Three halves, each answering a different question, and the codes are kept
   * distinct on purpose:
   *
   * - the mode ("does the user allow writing at all?") raises `FS_SANDBOX_DENIED`,
   *   which the host's tool layer rewrites into a `[sandbox: …]` marker plus an
   *   escalation hint; an unrecognised mode refuses too (fail closed), matching
   *   the local sandbox confining any mode it cannot read — see
   *   {@link writeModeRefusal};
   * - the scope ("is this inside the workspace the session was opened on?")
   *   raises the same code, because that IS a sandbox denial — `workspace-write`
   *   names one root (plus `/tmp`), not every mounted one;
   * - the reachability fence ("is this directory served?") raises
   *   `FS_OUTSIDE_WORKSPACE`, whose message passes through verbatim: escalating a
   *   permission cannot make an unmounted directory mounted. It treats the host
   *   temp area as served for the same reason the local backend lists `/tmp` in
   *   `writableRoots` — see {@link withRemoteTempRoot}.
   *
   * A message that blames the wrong one costs the model a whole retry loop, so
   * each cause gets its own sentence before the code decides how it is rendered.
   *
   * @param {{mode?: string, workspaceRoot?: string} | undefined} sandboxPolicy - the per-call policy.
   * @throws {FsError} `FS_SANDBOX_DENIED` when the mode or the scope forbids writing,
   *   `FS_OUTSIDE_WORKSPACE` when no root covers the target.
   */
  #assertWritable (parts, sandboxPolicy) {
    this.#assertEnabled(parts)
    const policy = this.#writeModeOf(sandboxPolicy)
    const mode = policy?.mode
    const modeRefusal = writeModeRefusal(mode, parts.displayPath)
    if (modeRefusal !== undefined) throw new FsError(modeRefusal, 'FS_SANDBOX_DENIED')
    // `workspace-write` is a containment promise. The local backend enforces it
    // through `writableRoots(policy)`, whose first entry is `policy.workspaceRoot`
    // — and for a remote session that root IS the `ssh://` spelling of the
    // session's cwd (measured, not assumed: `SandboxPolicyService.resolve`
    // returns `session.header.cwd` verbatim). So the same comparison can happen
    // here, and skipping it let one session write a sibling root, or a root on a
    // different host, which no local session may do.
    const scopeRefusal = workspaceWriteScopeRefusal(mode, policy?.workspaceRoot, parts)
    if (scopeRefusal !== undefined) throw new FsError(scopeRefusal, 'FS_SANDBOX_DENIED')
    assertWithinRemoteRoots(writeFenceRoots(this.roots, parts), parts)
  }

  /**
   * Report, once per activation, that the Host's whole-file content capture
   * cannot read a remote path.
   *
   * `dsh-workspace-changes` stores the before/after text of a file-tool edit
   * with its own `captureFile()` (`lib/index.js` in that package), which opens
   * the path with `node:fs` and treats ENOENT as "this path was absent". The
   * path it opens is `ctx.fs.processPath(target)` — and for a remote target
   * that is the plain REMOTE path by design (it is the execution-world spelling
   * git needs). Opening it inside the Host process can therefore only fail, so
   * both sides capture as `{kind:'absent'}`, `sameCapture()` calls them equal,
   * and the edit is dropped from the Changes list without a trace.
   *
   * There is no fs-seam read to substitute: the capture is not a `ctx.fs` call,
   * so the patched backend is never consulted. The one thing this plugin CAN
   * do is stop the drop from being silent — `ctx.logger` is a dead end in this
   * deployment (see diagnostics.js), so it goes to the diagnostics ring, which
   * the status tool and the panel's status route both serve.
   *
   * The change LIST is unaffected: it comes from git, which the subprocess
   * bridge does run on the remote host. Only the per-file text comparison is
   * missing, and only for remote edits.
   *
   */
  #noteHostLocalCapture (parts) {
    if (this.#captureLimitNoted) return
    this.#captureLimitNoted = true
    this.engine?.diagnostics?.record(
      KINDS.degraded,
      'the Changes panel cannot show before/after text for remote edits: dsh-workspace-changes captures whole files with node:fs, and the path ctx.fs.processPath() hands it is the remote one, so both sides read as absent and the record is dropped. git still lists the changed files; only the per-file text comparison is unavailable.',
      { alias: parts.alias },
    )
  }

  /** @inheritdoc */
  async writeText (target, content, expected, signal, sandboxPolicy) {
    const display = displayOf(target)
    if (!isRemotePath(display)) return await this.base.writeText(target, content, expected, signal, sandboxPolicy)
    const parts = this.#parse(display)
    this.#assertWritable(parts, sandboxPolicy)
    throwIfAborted(signal, 'write')
    this.#noteHostLocalCapture(parts)
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

  /**
   * @inheritdoc
   *
   * `sandboxPolicy` is the FIFTH argument, matching the base contract: the host's
   * `edit` tool passes the per-call policy here (`ctx.fs.editText(target, edit,
   * intent, signal, sandboxPolicy)`), so dropping it would silently discard a
   * session's `read-only` override for edits while honouring it for writes.
   */
  async editText (target, edit, expected, signal, sandboxPolicy) {
    const display = displayOf(target)
    if (!isRemotePath(display)) return await this.base.editText(target, edit, expected, signal, sandboxPolicy)
    const parts = this.#parse(display)
    this.#assertWritable(parts, sandboxPolicy)
    throwIfAborted(signal, 'edit')
    this.#noteHostLocalCapture(parts)
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
   */
  // `async` for parity with the local backend: a pre-aborted signal must surface
  // as a rejected promise (as `fs-local`'s async watch does), never a sync throw.
  async watch (target, changed, signal) {
    signal?.throwIfAborted?.()
    const display = displayOf(target)
    if (!isRemotePath(display)) return this.base.watch(target, changed, signal)
    const parts = this.#parse(display)
    try {
      this.#assertEnabled(parts)
    } catch (error) {
      return Promise.reject(error)
    }
    return await this.watchRegistry.watch(parts, changed, signal)
  }

  /**
   * How many underlying watchers are currently live per remote target.
   *
   * The registration below is only useful if it can be observed from outside:
   * "the file tree refreshes twice" and "two pollers hold two connections" are
   * the same fact, and a test (or a diagnostic dump) must be able to say
   * whether a target has one underlying watcher or several. Consumers are
   * reported separately because sharing is the point.
   *
   */
  watchTargets () {
    return this.watchRegistry.targets()
  }

  /**
   * The number of live underlying watchers for one target (0 or 1).
   *
   * @returns {number} 0 when no live watcher is installed, else 1.
   */
  watchTargetCount (alias, remotePath) {
    return this.watchRegistry.countFor(alias, remotePath)
  }

  /**
   * One comparable snapshot of a target, for the polling watcher.
   *
   * A directory reports its direct entries, a file its version token, and an
   * absent path reports itself so a creation is observed. The metadata cache is
   * never consulted: a cached snapshot compared against itself would report
   * "unchanged" forever.
   *
   */
  async #observeForWatch (parts) {
    return await this.engine.withSftp(parts.alias, async (sftp) => {
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
   */
  async #cached (alias, kind, remotePath, load) {
    const key = `${alias}\u0000${kind}\u0000${normalizeRemotePath(remotePath)}`
    const entry = this.cache.get(key)
    if (entry !== undefined && Date.now() - entry.at < CACHE_TTL_MS) return await entry.value
    if (entry !== undefined) this.cache.delete(key)
    // Store the PROMISE, not the settled value. The panel and the file tree
    // refresh the same paths at the same moment, and with a value-only cache
    // both missed and both issued their own SFTP round trip — the duplicates
    // this exists to prevent. Sharing the in-flight promise makes the second
    // caller join the first.
    const value = load()
    this.cache.set(key, { at: Date.now(), value })
    if (this.cache.size > CACHE_MAX_ENTRIES) {
      // Map preserves insertion order; drop the oldest inserted key.
      const oldest = this.cache.keys().next()
      if (oldest.done !== true) this.cache.delete(oldest.value)
    }
    try {
      return await value
    } catch (error) {
      // A rejected load must not be cached: every later reader would await the
      // same rejection instead of retrying the live path.
      if (this.cache.get(key)?.value === value) this.cache.delete(key)
      throw error
    }
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
        // shape before anything is created. The host temp area is a candidate
        // root here for the same reason it is for the mount fence: a build that
        // stages under `/tmp` must not be refused by the realpath check after
        // the mode and scope fences let it through.
        await assertFencedRealpath(sftp, parts.alias, parts.remotePath, writeFenceRoots(this.roots, parts))
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
      }, { kind: 'write' })
    } finally {
      // Any outcome may have changed the remote shape — the fallback publish
      // can leave the destination removed when its rename fails — so both the
      // target and its parent listing are forgotten unconditionally.
      this.invalidateRemote(parts.alias, parts.remotePath)
    }
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
 * The root set a WRITE fence consults: every served workspace plus the host's
 * temp area, so a build that stages under `/tmp` is reachable exactly as its
 * local twin is — the local `writableRoots(policy)` lists a constant `/tmp`
 * alongside the workspace root (`dsh-sandbox` index.js:166-173), and a remote
 * refusal for the same spelling would be a divergence in the mode's promise.
 *
 * Derived per call and never stored: the read paths, the `node:fs` bridge and
 * the detached-workspace fence all answer about the REAL served set, and the
 * temp area is not one. The added root is the fixed POSIX path `/tmp`, not a
 * probed `$TMPDIR`, so this stays a pure lexical widening with no round trip.
 *
 * The temp area is only opened on a host this deployment already serves
 * something from. A host with no mounted root stays unreachable even under
 * `danger-full-access` — widening `/tmp` everywhere would turn "mount it
 * first" into "the host you merely know the alias of", which is a larger
 * remote surface than the mode ever promised.
 *
 */
export function writeFenceRoots (roots, parts) {
  let servesHost = false
  for (const root of roots) {
    const parsed = parseRemotePath(root)
    if (parsed !== undefined && parsed.alias === parts.alias) { servesHost = true; break }
  }
  if (!servesHost) return roots
  const spelling = formatRemotePath(parts.alias, '/tmp')
  if (roots.has(spelling)) return roots
  const widened = new Set(roots)
  widened.add(spelling)
  return widened
}

/**
 * Enforce the remote write fence.
 *
 * @throws {FsError} `FS_OUTSIDE_WORKSPACE` when no root covers the target.
 */
export function assertWithinRemoteRoots (roots, parts) {
  if (isWithinRemoteRoots(roots, parts)) return
  // Deliberately NOT `FS_SANDBOX_DENIED`: the host's tool layer rewrites that
  // code into "[sandbox: file access denied under <mode> mode]" plus an
  // escalation hint, which is wrong twice here — the mode may already be the
  // widest one, and escalating a permission does nothing for a directory that is
  // simply not mounted. A distinct code lets the accurate message through.
  throw new FsError(
    `cannot write "${parts.displayPath}": outside every mounted remote workspace (mount it first with ssh_workspace_mount)`,
    'FS_OUTSIDE_WORKSPACE',
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
 * @param {boolean} [options.includeLeaf] - resolve the target itself too
 *   (default true: writes follow a final symlink); false starts at the parent
 *   (deletes may legitimately remove an escaping symlink itself).
 * @param {string} [options.verb] - word for the error message (default 'write').
 * @returns {Promise<void>} resolves when the existing components stay inside a root.
 * @throws {FsError} `FS_OUTSIDE_WORKSPACE` on a lexical or resolved escape,
 *   `FS_NOT_FOUND` when an existing component cannot be resolved.
 */
export async function assertFencedRealpath (sftp, alias, remotePath, roots, options = {}) {
  const displayPath = formatRemotePath(alias, remotePath)
  const verb = typeof options.verb === 'string' && options.verb !== '' ? options.verb : 'write'
  // A resolved escape is the mount fence catching a link, not a sandbox-policy
  // denial: the same `FS_OUTSIDE_WORKSPACE` code keeps the message accurate and
  // stops the host from appending an escalation hint that cannot help.
  const denied = (reason) => new FsError(`cannot ${verb} "${displayPath}": ${reason}`, 'FS_OUTSIDE_WORKSPACE')
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
 * @param {string} displayPath - caller-facing path for messages.
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
async function writeHandle (sftp, handle, buffer, displayPath, startAt = 0) {
  // `startAt` is what makes an upload RESUMABLE. Without it every write began at
  // file offset 0, so appending the missing tail of a partial upload overwrote
  // the prefix that was already there — producing a file of exactly the right
  // length whose content is the tail repeated, which no size check can catch.
  const base = Number.isFinite(startAt) && startAt > 0 ? startAt : 0
  let position = 0
  while (position < buffer.length) {
    const length = Math.min(CHUNK_BYTES, buffer.length - position)
    const written = await new Promise((resolve, reject) => {
      sftp.write(handle, buffer, position, length, base + position, (error) => {
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
 * is why the fallback is worth having at all. That removal is gated on a stat,
 * so a rename that failed for any other reason leaves the destination intact.
 *
 * @param {boolean} replace - whether the destination may already exist.
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
    // Only clear the destination when it is PROVEN to be there. The initial
    // rename can fail for a dead connection, a permission error or a lost
    // server — none of which mean the destination is in the way. Unlinking on
    // those would destroy a file the publication never had to touch, and a
    // retry that then fails loses the staged copy too. `statOrNull` rejects
    // (rather than answering null) on anything but "absent", so the original
    // error survives instead of being replaced by a stat failure.
    const existing = await statOrNull(sftp, to)
    if (existing === null) throw error
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
// `publishRename` is exported for the same reason the primitives are: it holds
// the atomic-replace fallback, whose "do not delete an unrelated destination"
// guard is only observable by driving it directly.
export {
  closeHandle as sftpCloseHandle,
  lstatOrNull as sftpLstatOrNull,
  mkdirp as sftpMkdirp,
  mkdirStrict as sftpMkdirStrict,
  openHandle as sftpOpenHandle,
  publishRename as sftpPublishRename,
  readdir as sftpReaddir,
  realpathStrict as sftpRealpathStrict,
  renameStrict as sftpRenameStrict,
  readHandle as sftpReadHandle,
  statOrNull as sftpStatOrNull,
  writeHandle as sftpWriteHandle,
}
