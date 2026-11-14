/**
 * Take over the live `ctx.subprocess` so specs whose `cwd` is an `ssh://`
 * target run on the remote host.
 *
 * `ctx.subprocess` is the seam the file tools' helpers use for short-lived
 * child processes. Exactly two of them can legitimately carry a remote
 * workspace as cwd — the search tool spawns ripgrep, and the workspace-change
 * tracker spawns git — and both take the cwd from the session header, so on a
 * remote workspace the spec holds an `ssh://` spelling the local runtime
 * cannot use (Windows resolves it against the process cwd, and no platform
 * parser roots it).
 *
 * A few Host subsystems normalize a remote target to its PROCESS path before
 * handing it to git: `ctx.fs.processPath()` answers `/mnt/data/proj`, the same
 * spelling the remote git itself prints, and the scheme that carried the
 * remote identity is gone. The Forge panel's local-changes card is built
 * exactly that way (`checkout.root` → `gitIn(..., root)`), so on a remote
 * workspace those commands would fall through to a local spawn against a
 * directory that does not exist here. A plain POSIX path is therefore also
 * diverted, but ONLY under a deliberately narrow rule (see
 * {@link resolvePlainRemoteRoute}): it must be normalized, lie under exactly
 * ONE mounted remote root, that root's host must still be usable, and the path
 * must NOT exist on this machine. Anything ambiguous stays local, because
 * guessing would let a destructive `git` command reach the wrong world.
 *
 * Every other spec is forwarded to the original `spawn` bound to the
 * surrounding runtime, so host behavior is unchanged. The remote half mirrors
 * the local handle contract: `spawn` returns synchronously, `done` resolves
 * with `{exitCode, signal}` (and rejects only when the provider — here the SSH
 * transport — failed), the collected streams keep a byte tail window with
 * OutputCollector-shaped `readFrom`/`finalize`, and `terminate()` walks
 * SIGTERM → `graceMs` → SIGKILL with a connection-drop fallback so a dead
 * transport cannot hang `done`.
 *
 * Command translation: argv[0] is matched by basename against the two tools
 * that legitimately run against a workspace — `git` and ripgrep (`rg`,
 * including the packaged `<name>-rg[.exe]` sidecar spelling). Anything else
 * is rejected synchronously, because silently running it on the host against
 * a remote cwd would produce quietly wrong answers; the caller turns the
 * synchronous failure into its own typed error.
 *
 * Scratch mirror: the workspace-change tracker stages local scratch under the
 * host temp dir and hands those host paths to git through env vars
 * (`GIT_OBJECT_DIRECTORY`, `GIT_INDEX_FILE`,
 * `GIT_ALTERNATE_OBJECT_DIRECTORIES`). A remote git cannot see host paths, so
 * values under the host temp root are rewritten to their mirror under the
 * remote `/tmp` — the same root the filesystem half stages atomic writes in —
 * and the mirror directories are created before git runs. The first path
 * segment of every learned mirror entry is remembered with its host alias, so
 * fs-shim's `rm` bridge can delete the remote mirror alongside the local
 * scratch directory and `copyFile` can mirror staged files into it.
 *
 * Path translation in argv: argv is forwarded verbatim, except for `ssh://`
 * spellings that appear in a PATH POSITION of a routed plain-path git run
 * (after `--`, or as the operand of `-C`/`--git-dir`/`--work-tree`/
 * `--namespace`) and name a path inside the routed root. The narrowness is on
 * purpose: an arbitrary argv string can be DATA — `rg` search patterns and git
 * commit messages legitimately quote `ssh://…` URLs — and rewriting data would
 * silently change an answer. Environment values keep the older rules, which
 * are independent of how the cwd was routed.
 *
 * @module @shiqyka/dsh-ssh-workspace/patch-subprocess
 */

import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  formatRemotePath,
  isRemotePath,
  isRemotePathUnder,
  normalizeRemotePath,
  parseRemotePath,
  remoteDirname,
} from './protocol.js'
import { channelExecOptions, shellQuote } from './engine.js'
import { BRIDGE } from './path-binding.js'

/** Instance marker proving this module already patched the service. */
export const INSTALLED = Symbol.for('dsh-ssh-workspace.subprocess-installed')

/** Remote mirror of the host temp root — the same root the fs half stages in. */
const MIRROR_ROOT = '/tmp'

/** Largest delay a timer may carry, mirroring the runner's own ceiling. */
const MAX_TIMER_DELAY_MS = 2147483647

/**
 * Grace between a kill request and dropping the connection anyway. A healthy
 * ssh2 channel reports `close` right after the request; this bounds the wait
 * when the transport is already dead, so a handle cannot pin `done` forever.
 */
const KILL_GRACE_MS = 5000

/** Variable names safe to re-export on the remote side. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u

/** Env keys whose value names a directory git must find on the remote side. */
const MIRROR_DIR_KEYS = new Set(['GIT_OBJECT_DIRECTORY'])

/** Env keys whose value names a file whose parent must exist remotely. */
const MIRROR_PARENT_KEYS = new Set(['GIT_INDEX_FILE'])

/** Re-export PATH so tools installed outside the login PATH are found. */
const PATH_PRELUDE = 'export PATH="$HOME/.local/bin:$HOME/bin:$PATH"'

/** Missing-binary notes, printed to the remote stderr before exit 127. */
const INSTALL_HINTS = {
  git: 'ssh-workspace: git is not installed on this remote host — install git there to track workspace changes',
  rg: 'ssh-workspace: ripgrep (rg) is not installed on this remote host — install ripgrep there (e.g. "sudo apt install ripgrep" or "brew install ripgrep"), or search through the shell tool',
}

/** One host path relaxed to forward slashes, lowercased on Windows. */
function hostPathKey (value) {
  const forward = value.replaceAll('\\', '/')
  return process.platform === 'win32' ? forward.toLowerCase() : forward
}

/** Host temp root, realpath'd once (macOS /var → /private/var), as a key. */
let cachedTmpBase
function hostTmpBase () {
  if (cachedTmpBase === undefined) {
    try {
      cachedTmpBase = hostPathKey(realpathSync(tmpdir()))
    } catch {
      cachedTmpBase = hostPathKey(tmpdir())
    }
  }
  return cachedTmpBase
}

/**
 * The temp-root-relative POSIX tail of a host path, or `undefined` when the
 * path is not under the host temp root. Windows spellings are lowercased so
 * every mirror spelling of one scratch directory agrees byte-for-byte.
 *
 * @param {string} hostPath - a host path (wanting no translation otherwise).
 * @returns {string | undefined} `/relative/tail`, or undefined.
 */
function mirrorRelativeOf (hostPath) {
  if (typeof hostPath !== 'string' || hostPath === '') return undefined
  const base = hostTmpBase()
  const key = hostPathKey(hostPath)
  if (!key.startsWith(base)) return undefined
  const rest = key.slice(base.length)
  if (rest !== '' && !rest.startsWith('/')) return undefined
  if (rest === '' || rest === '/') return undefined
  return rest
}

/** First path segment of a mirror-relative tail. */
function firstSegmentOf (relative) {
  const segment = relative.split('/')[1]
  return segment === undefined || segment === '' ? undefined : segment
}

/** @type {Map<string, string>} scratch first-segment → host alias. */
const mirrorAliases = new Map()

/**
 * Remember which host alias owns a scratch directory, keyed by the directory's
 * first path segment — the granularity the `rm` bridge needs, since the
 * tracker removes the whole `mkdtemp` root at once.
 *
 * @param {string} alias - host alias.
 * @param {string} hostPath - any path under the scratch root.
 * @returns {void}
 */
function learnMirrorAlias (alias, hostPath) {
  if (typeof alias !== 'string' || alias === '') return
  const relative = mirrorRelativeOf(hostPath)
  if (relative === undefined) return
  const segment = firstSegmentOf(relative)
  if (segment === undefined) return
  // First learn wins: a later accidental learn must not point a scratch
  // directory's deletion at a different host.
  if (!mirrorAliases.has(segment)) mirrorAliases.set(segment, alias)
}

/**
 * Drop the learned entry for a scratch directory that is being removed.
 *
 * The change tracker removes its whole `mkdtemp` root at once, so once that
 * local directory is gone the mapping has no further use — forgetting it
 * keeps a long-lived process from accumulating entries for every snapshot
 * round. Only the exact root (one path segment below the temp root) is
 * forgotten: removing a sub-path leaves the scratch alive and the mapping
 * still needed.
 *
 * @param {string} hostPath - host path under the temp root.
 * @returns {void}
 */
export function forgetMirrorAlias (hostPath) {
  const relative = mirrorRelativeOf(hostPath)
  if (relative === undefined) return
  if (relative.split('/').length !== 2) return
  const segment = firstSegmentOf(relative)
  if (segment === undefined) return
  mirrorAliases.delete(segment)
}

/**
 * The remote mirror spelling of a host temp path.
 *
 * @param {string} hostPath - host path under the temp root.
 * @param {string} [alias] - when given, the mirror entry is learned.
 * @returns {string | undefined} `/tmp/<tail>`, or undefined when the path is
 *   not under the host temp root.
 */
export function remoteMirrorPath (hostPath, alias) {
  const relative = mirrorRelativeOf(hostPath)
  if (relative === undefined) return undefined
  if (alias !== undefined) learnMirrorAlias(alias, hostPath)
  return `${MIRROR_ROOT}${relative}`
}

/**
 * Resolve a host temp path to the remote mirror that serves it, when one is
 * known. Used by the fs bridges to mirror a deletion or a staged copy onto the
 * host that owns the scratch directory; unknown scratch stays local-only, so a
 * bridge can never delete the wrong host's directory.
 *
 * @param {string} hostPath - host path under the temp root.
 * @returns {{alias: string, remotePath: string} | undefined} the mirror, or
 *   undefined when the path is not (or not yet known to be) a remote scratch.
 */
export function mirrorTargetOf (hostPath) {
  const relative = mirrorRelativeOf(hostPath)
  if (relative === undefined) return undefined
  const segment = firstSegmentOf(relative)
  if (segment === undefined) return undefined
  const alias = mirrorAliases.get(segment)
  if (alias === undefined) return undefined
  return { alias, remotePath: `${MIRROR_ROOT}${relative}` }
}

/**
 * Map an argv[0] spelling onto the remote command it names.
 *
 * Matches by basename so a sidecar packaged next to the host executable
 * (`<name>-rg.exe`) resolves the same way a bare `rg` does.
 *
 * @param {string} argv0 - the spec's argv[0].
 * @returns {'git' | 'rg'} the remote command name.
 * @throws {Error} for any other executable — a remote run would be silently
 *   wrong, so the caller must see the rejection synchronously.
 */
function remoteCommandFor (argv0) {
  const base = argv0.split(/[/\\]/u).pop() ?? argv0
  const stem = base.toLowerCase().endsWith('.exe') ? base.slice(0, -4) : base
  const lower = stem.toLowerCase()
  if (lower === 'git') return 'git'
  if (lower === 'rg' || lower.endsWith('-rg') || lower.endsWith('_rg')) return 'rg'
  throw new Error(`ssh-workspace: cannot run ${JSON.stringify(argv0)} with a remote cwd — only git and ripgrep (rg) are supported over the remote subprocess bridge`)
}

/** The install hint printed when the remote command is missing. */
function installHintOf (command) {
  return INSTALL_HINTS[command] ?? `ssh-workspace: ${command} is not installed on this remote host`
}

/**
 * Why a plain (scheme-less) path kept the LOCAL subprocess behavior.
 *
 * Stable ids, because these strings travel into diagnostics and tests: "the
 * path is ambiguously mounted" and "the path exists on this machine" are very
 * different answers to a user who thinks a card is broken.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const PLAIN_ROUTE_REASONS = Object.freeze({
  NOT_A_PATH: 'not-a-path',
  NOT_POSIX_ABSOLUTE: 'not-posix-absolute',
  UNPARSABLE: 'unparsable',
  EXISTS_LOCALLY: 'exists-locally',
  NO_MOUNTED_ROOT: 'no-mounted-root',
  AMBIGUOUS_ROOT: 'ambiguous-root',
  HOST_UNAVAILABLE: 'host-unavailable',
})

/** How many plain-path decisions one router remembers for diagnostics. */
const PLAIN_ROUTE_MEMORY = 128

/**
 * One "keep the local behavior" verdict.
 *
 * @param {string} reason - one of {@link PLAIN_ROUTE_REASONS}.
 * @param {object} [extra] - optional evidence (`detail`, `candidates`).
 * @returns {{kind: 'local', reason: string}} the verdict.
 */
function localRoute (reason, extra) {
  return { kind: 'local', reason, ...(extra ?? {}) }
}

/**
 * Decide whether a plain, scheme-less path names a directory in one mounted
 * remote world — the single question this bridge is allowed to answer.
 *
 * ## The rule, in one sentence
 *
 * Route a POSIX-absolute plain path to a remote host only when it lies under
 * exactly one mounted remote root, that root's host is still usable, and the
 * same path does NOT exist on this machine; otherwise keep the local behavior.
 *
 * ## Why each clause is load-bearing
 *
 * - `ssh://` spellings are handled by the caller before this function; a plain
 *   path carries no host, so the host must be inferred — and that inference is
 *   only safe when exactly one mounted root can supply it. Two roots (two
 *   hosts, or the same host mounted twice) make the answer ambiguous, and a
 *   guessed alias would send `git add`/`git gc` to the wrong machine.
 * - A path that exists locally is almost certainly the local directory the
 *   caller meant. "Almost certainly" is not enough for a destructive command:
 *   the local directory wins, even when a remote root also contains the path.
 * - A detached workspace or an unresolvable alias is not "probably fine": the
 *   Host's own instruction is "fail closed", so the call keeps the local
 *   behavior and the decision is reported.
 *
 * The check is purely lexical over normalized POSIX paths, exactly like the
 * rest of the plugin's identity rules; no remote round trip happens before the
 * spawn, and none is needed to answer the containment question.
 *
 * @param {unknown} cwd - the spec's cwd.
 * @param {object} [context] - decision inputs (injected by tests).
 * @param {Iterable<string>} [context.roots] - canonical `ssh://` mounted roots.
 * @param {(path: string) => boolean} [context.existsLocally] - host existence probe.
 * @param {(alias: string, remotePath: string) => (string | undefined)} [context.hostRefusal]
 *   - returns a human-readable refusal when the root's host is not usable.
 * @returns {{kind: 'remote', alias: string, remotePath: string, displayPath: string, root: string}
 *   | {kind: 'local', reason: string, detail?: string, candidates?: string[]}} the verdict.
 */
export function resolvePlainRemoteRoute (cwd, context = {}) {
  const existsLocally = typeof context.existsLocally === 'function' ? context.existsLocally : existsSync
  const hostRefusal = typeof context.hostRefusal === 'function'
    ? context.hostRefusal
    : () => undefined
  if (typeof cwd !== 'string' || cwd === '') return localRoute(PLAIN_ROUTE_REASONS.NOT_A_PATH)
  // A POSIX absolute path, and nothing that a platform parser would resolve
  // differently: a Windows drive/UNC spelling belongs to the host world.
  if (!cwd.startsWith('/') || cwd.includes('\\') || /^[A-Za-z]:/u.test(cwd)) {
    return localRoute(PLAIN_ROUTE_REASONS.NOT_POSIX_ABSOLUTE)
  }
  let normalized
  try {
    normalized = normalizeRemotePath(cwd)
  } catch {
    return localRoute(PLAIN_ROUTE_REASONS.UNPARSABLE)
  }
  // A probe that cannot answer counts as "it exists": an unreadable local
  // filesystem must never widen reach, and local spawn is the status quo.
  let exists = true
  try {
    exists = existsLocally(normalized) === true
  } catch {
    exists = true
  }
  if (exists) return localRoute(PLAIN_ROUTE_REASONS.EXISTS_LOCALLY)
  const roots = context.roots
  if (roots === undefined || roots === null) return localRoute(PLAIN_ROUTE_REASONS.NO_MOUNTED_ROOT)
  const matches = []
  for (const spelling of roots) {
    let parsed
    try {
      parsed = parseRemotePath(spelling)
    } catch {
      continue
    }
    if (parsed === undefined) continue
    if (!isRemotePathUnder(parsed.remotePath, normalized)) continue
    // One root spelled twice (a normalized trailing slash, say) is one root.
    if (matches.some(match => match.alias === parsed.alias && match.remotePath === parsed.remotePath)) continue
    matches.push({ alias: parsed.alias, remotePath: parsed.remotePath })
  }
  if (matches.length === 0) return localRoute(PLAIN_ROUTE_REASONS.NO_MOUNTED_ROOT)
  if (matches.length > 1) {
    return localRoute(PLAIN_ROUTE_REASONS.AMBIGUOUS_ROOT, {
      candidates: matches.map(match => formatRemotePath(match.alias, match.remotePath)),
    })
  }
  const [match] = matches
  let refusal
  try {
    refusal = hostRefusal(match.alias, normalized)
  } catch (error) {
    refusal = `the host state could not be read: ${error instanceof Error ? error.message : String(error)}`
  }
  if (typeof refusal === 'string' && refusal !== '') {
    return localRoute(PLAIN_ROUTE_REASONS.HOST_UNAVAILABLE, {
      alias: match.alias,
      detail: refusal,
      candidates: [formatRemotePath(match.alias, match.remotePath)],
    })
  }
  return {
    kind: 'remote',
    alias: match.alias,
    remotePath: normalized,
    displayPath: formatRemotePath(match.alias, normalized),
    root: formatRemotePath(match.alias, match.remotePath),
  }
}

/**
 * Translate one argv value, or return it unchanged.
 *
 * Only a routed PLAIN-path run carries a `root`, and only an `ssh://` value on
 * the same host and inside that root is unambiguously the same remote file. A
 * different host, a path outside the root, or a string that merely starts with
 * the scheme stays literal.
 *
 * @param {unknown} value - one argv entry.
 * @param {{alias: string, root?: string}} parts - the routed target.
 * @returns {unknown} the value to hand to the remote command.
 */
function translateArgValue (value, parts) {
  if (typeof value !== 'string' || !isRemotePath(value) || typeof parts.root !== 'string') return value
  let parsed
  let root
  try {
    parsed = parseRemotePath(value)
    root = parseRemotePath(parts.root)
  } catch {
    return value
  }
  if (parsed.alias !== root.alias) return value
  if (!isRemotePathUnder(root.remotePath, parsed.remotePath)) return value
  return parsed.remotePath
}

/** Git options whose NEXT argv entry is a path. */
const GIT_PATH_OPTIONS = new Set(['-C', '--git-dir', '--work-tree', '--namespace'])

/**
 * Translate the PATH-POSITION argv entries of a remote command.
 *
 * Only git, and only entries the tool itself defines as a path: after the `--`
 * pathspec separator, or as the operand of `-C` / `--git-dir` / `--work-tree`
 * / `--namespace` (separate token or `=`-joined). Everything else stays
 * verbatim, because for these tools an arbitrary string can be DATA: a search
 * pattern may legitimately be `ssh://host/path`, a commit message may quote a
 * URL, and `rg` arguments are patterns and paths mixed together. Rewriting
 * those would silently change an answer, which is worse than the literal
 * spelling failing loudly.
 *
 * A plain remote path needs no translation at all — the remote world already
 * speaks POSIX — so this only ever touches `ssh://` spellings that name the
 * routed root.
 *
 * @param {unknown[]} argv - the full argv (argv[0] included).
 * @param {{alias: string, root?: string}} parts - the routed target.
 * @param {'git' | 'rg'} command - the remote command name.
 * @returns {unknown[]} argv with path-position entries translated.
 */
function translateArgv (argv, parts, command) {
  if (command !== 'git' || typeof parts.root !== 'string') return argv
  const translated = argv.slice(0)
  let inPathspecs = false
  for (let index = 1; index < translated.length; index += 1) {
    const value = translated[index]
    if (typeof value !== 'string') continue
    if (value === '--') {
      inPathspecs = true
      continue
    }
    if (inPathspecs) {
      translated[index] = translateArgValue(value, parts)
      continue
    }
    if (GIT_PATH_OPTIONS.has(value)) {
      // The operand is the NEXT entry (`-C <dir>`, `--git-dir <dir>`).
      if (index + 1 < translated.length) {
        translated[index + 1] = translateArgValue(translated[index + 1], parts)
        index += 1
      }
      continue
    }
    const equals = value.indexOf('=')
    if (equals > 0 && GIT_PATH_OPTIONS.has(value.slice(0, equals))) {
      translated[index] = `${value.slice(0, equals)}=${translateArgValue(value.slice(equals + 1), parts)}`
    }
  }
  return translated
}

/**
 * Translate one env value that may name a path, best-effort.
 *
 * @param {string} value - the raw value.
 * @param {string} alias - the host alias owning the workspace.
 * @param {Set<string>} mkdirs - collects remote directories to create.
 * @param {'dir' | 'file' | 'none'} kind - what the value names.
 * @returns {string} the value to export remotely.
 */
function translatePathValue (value, alias, mkdirs, kind) {
  if (typeof value !== 'string' || value === '') return value
  if (isRemotePath(value)) {
    try {
      return parseRemotePath(value).remotePath
    } catch {
      return value
    }
  }
  const mirror = remoteMirrorPath(value, alias)
  if (mirror === undefined) return value
  if (kind === 'dir') mkdirs.add(mirror)
  if (kind === 'file') mkdirs.add(remoteDirname(mirror))
  return mirror
}

/**
 * Translate one env entry for the remote side.
 *
 * `GIT_ALTERNATE_OBJECT_DIRECTORIES` is a list: a single entry is translated
 * whole (splitting a lone `ssh://…` on `:` would shred the scheme), a real
 * list on its own separator entry by entry.
 *
 * @param {string} key - env variable name.
 * @param {unknown} value - raw value.
 * @param {string} alias - the host alias owning the workspace.
 * @param {Set<string>} mkdirs - collects remote directories to create.
 * @returns {string} the value to export remotely.
 */
function translateEnvValue (key, value, alias, mkdirs) {
  if (typeof value !== 'string') return String(value)
  if (key === 'GIT_ALTERNATE_OBJECT_DIRECTORIES') {
    if (isRemotePath(value) || mirrorRelativeOf(value) !== undefined) {
      return translatePathValue(value, alias, mkdirs, 'dir')
    }
    const separator = value.includes(';') ? ';' : ':'
    return value.split(separator)
      .filter(part => part !== '')
      .map(part => translatePathValue(part, alias, mkdirs, 'dir'))
      .join(':')
  }
  if (MIRROR_DIR_KEYS.has(key)) return translatePathValue(value, alias, mkdirs, 'dir')
  if (MIRROR_PARENT_KEYS.has(key)) return translatePathValue(value, alias, mkdirs, 'file')
  return translatePathValue(value, alias, mkdirs, 'none')
}

/**
 * Build the remote shell script one spec runs: environment re-exports, the
 * PATH prelude, the mirror directories, the workdir change, a `command -v`
 * presence check with an install hint, then the command itself. POSIX syntax
 * by contract — the remote side is not PowerShell.
 *
 * @param {object} spec - a subprocess spec (remote cwd, already validated).
 * @param {{alias: string, remotePath: string}} parts - the parsed cwd.
 * @param {'git' | 'rg'} command - the remote command name.
 * @param {string[]} argv - the full argv (argv[0] replaced by `command`).
 * @param {Set<string>} mkdirs - collects remote directories to create.
 * @returns {string} the script handed to the remote login shell.
 */
function buildScript (spec, parts, command, argv, mkdirs) {
  const segments = []
  const env = spec.env
  if (env !== null && typeof env === 'object') {
    for (const [key, value] of Object.entries(env)) {
      if (!ENV_NAME_RE.test(key)) continue
      //
      // Node's spawn treats an `undefined` env value as "leave the variable
      // unset" — the key never reaches the child. The remote half exports
      // variables instead, where a naive serialization would send the literal
      // string "undefined". The Forge panel clears inherited Git selectors
      // with `GIT_ENV` values of `undefined`; exporting them makes git read
      // the git dir `./undefined`, exit 128 with "fatal: not a git repository",
      // and the panel then reports the checkout as non-Git. Keep the local
      // meaning: an undefined value omits the variable entirely.
      if (value === undefined) continue
      segments.push(`export ${key}=${shellQuote(translateEnvValue(key, value, parts.alias, mkdirs))}`)
    }
  }
  segments.push(PATH_PRELUDE)
  let script = `${segments.join('; ')}; `
  if (mkdirs.size > 0) {
    script += `mkdir -p ${[...mkdirs].sort().map(shellQuote).join(' ')} && `
  }
  const forwarded = translateArgv(argv, parts, command)
  const args = forwarded.slice(1).map(shellQuote).join(' ')
  const invocation = args === '' ? `exec ${shellQuote(command)}` : `exec ${shellQuote(command)} ${args}`
  script += `cd ${shellQuote(parts.remotePath)} && { command -v ${shellQuote(command)} >/dev/null 2>&1 || { echo ${shellQuote(installHintOf(command))} >&2; exit 127; }; ${invocation}; }`
  return script
}

/**
 * OutputCollector-shaped byte tail: keeps at most `maxBytes` of the newest
 * output (dropping whole chunks from the head), answers `readFrom(fromByte)`
 * with the retained text plus a `lossy` flag, and mirrors `finalize`/`seal`.
 * An unbounded window (no declared `maxBytes`) never drops.
 */
class StreamTail {
  /**
   * @param {number | undefined} maxBytes - retained-byte cap.
   */
  constructor (maxBytes) {
    this.cap = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : Infinity
    this.chunks = []
    this.bytes = 0
    this.total = 0
    this.dropped = false
    this.sealed = false
    /**
     * Cached `Buffer.concat(this.chunks)`, rebuilt only after a `push` that
     * actually changed the retained window.
     *
     * @type {Buffer | undefined}
     */
    this.joined = undefined
  }

  /** Append a chunk, evicting whole chunks from the head once over cap. */
  push (chunk) {
    if (this.sealed) return
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
    if (buffer.length === 0) return
    this.chunks.push(buffer)
    this.bytes += buffer.length
    this.total += buffer.length
    while (this.bytes > this.cap && this.chunks.length > 1) {
      const evicted = this.chunks.shift()
      this.bytes -= evicted.length
      this.dropped = true
    }
    // The retained bytes changed, so the join is stale from here on.
    this.joined = undefined
  }

  /**
   * The retained window as one buffer.
   *
   * `readFrom` and `finalize` both need the whole window, and a `tail -f`-style
   * consumer reads it far more often than output arrives. Concatenating on
   * every call made each read O(total retained) for a buffer that had not
   * changed in between; the join is cached and invalidated by {@link push}.
   *
   * @returns {Buffer} the concatenated retained chunks.
   */
  #joined () {
    if (this.joined === undefined) this.joined = Buffer.concat(this.chunks)
    return this.joined
  }

  /**
   * Read from a byte offset without consuming.
   *
   * @param {number} fromByte - logical byte offset into the stream.
   * @returns {{text: string, nextOffset: number, lossy: boolean}} the read.
   */
  readFrom (fromByte) {
    const start = Number.isFinite(fromByte) ? Math.max(0, Math.min(fromByte, this.total)) : 0
    const windowStart = this.total - this.bytes
    const sliceFrom = Math.max(start, windowStart) - windowStart
    const buffer = this.#joined()
    return {
      text: buffer.subarray(sliceFrom).toString('utf8'),
      nextOffset: this.total,
      lossy: start < windowStart,
    }
  }

  /** The foreground projection of this stream. */
  finalize () {
    return { text: this.#joined().toString('utf8'), truncated: this.dropped }
  }

  /** Stop accepting further output. */
  seal () {
    this.sealed = true
  }
}

/** Normalize. Accepts `'ignore'` or `{maxBytes}`; rejects `'pipe'`/`'inherit'`. */
function collectModeOf (mode, where) {
  if (mode === undefined || mode === null || mode === 'ignore') return { collect: false }
  if (typeof mode === 'object') {
    return { collect: true, maxBytes: Number.isFinite(mode.maxBytes) ? mode.maxBytes : undefined }
  }
  throw new Error(`ssh-workspace: stdio.${where} mode ${JSON.stringify(mode)} is not supported for a remote ssh:// subprocess`)
}

/** Normalize `stdio.stdin`. Accepts `'ignore'` or `{data}`; rejects the rest. */
function stdinPayloadOf (mode) {
  if (mode === undefined || mode === null || mode === 'ignore') return undefined
  if (typeof mode === 'object' && 'data' in mode) return mode.data
  throw new Error(`ssh-workspace: stdio.stdin mode ${JSON.stringify(mode)} is not supported for a remote ssh:// subprocess`)
}

/**
 * The remote half of the subprocess seam: one remote spec, one command on the
 * named host, one live handle.
 *
 * Two spec shapes reach it: the original `ssh://` cwd (the remote identity is
 * explicit) and a plainly-spelled cwd that {@link resolvePlainRemoteRoute}
 * proved belongs to exactly one mounted root. The second shape also remembers
 * its root, so argv values written as `ssh://…` on that root can be translated.
 */
class RemoteSubprocessRouter {
  /**
   * @param {object} options - install options.
   * @param {import('./engine.js').SshWorkspaceEngine} options.engine - live SSH engine.
   * @param {object} [options.logger] - a Cordis logger, when available.
   */
  constructor ({ engine, logger }) {
    this.engine = engine
    this.logger = logger
    /**
     * Plain-path decisions already reported, so a polling consumer cannot
     * turn one ambiguity into a log flood. Bounded and insertion-ordered.
     *
     * @type {Map<string, object>}
     */
    this.plainRoutes = new Map()
  }

  /**
   * Every mounted remote root, or `undefined` when none can be known.
   *
   * The router attached to the engine is the authority; the builtin bridge
   * state is the fallback for an activation order where the subprocess half
   * arrived first. A deployment with no mounted workspace answers `undefined`
   * (or an empty set), and no plain path is ever diverted there — which is the
   * pre-existing behavior.
   *
   * @returns {Set<string> | undefined} canonical `ssh://` roots.
   */
  remoteRoots () {
    for (const router of [this.engine?.fs, globalThis[BRIDGE]?.router]) {
      if (router !== null && router !== undefined && router.roots instanceof Set) return router.roots
    }
    return undefined
  }

  /**
   * The routing verdict for one plain cwd, with its diagnostic side effects.
   *
   * @param {unknown} cwd - the spec's cwd.
   * @returns {object} a decision from {@link resolvePlainRemoteRoute}.
   */
  plainRouteFor (cwd) {
    const decision = resolvePlainRemoteRoute(cwd, {
      roots: this.remoteRoots(),
      hostRefusal: (alias, remotePath) => this.#hostRefusal(alias, remotePath),
    })
    this.#rememberPlainRoute(cwd, decision)
    return decision
  }

  /**
   * Why one mounted root's host cannot host a command right now, if it cannot.
   *
   * @param {string} alias - host alias.
   * @param {string} remotePath - normalized remote target.
   * @returns {string | undefined} a human-readable refusal, or undefined.
   */
  #hostRefusal (alias, remotePath) {
    const engine = this.engine
    if (engine === null || engine === undefined) return undefined
    // A detached workspace must not run anything through ANY seam (engine.js);
    // a subprocess that ran there would keep the workspace usable.
    try {
      if (typeof engine.isDisabledTarget === 'function' && engine.isDisabledTarget(alias, remotePath) === true) {
        return 'the remote workspace is detached'
      }
    } catch (error) {
      return `the workspace state could not be read: ${error instanceof Error ? error.message : String(error)}`
    }
    // The alias must still be configured. `resolve()` is the same lookup the
    // connect path performs, so an unknown host is a refusal BEFORE a child is
    // created; the alternative is a confusing local spawn against a path that
    // exists only because a stale mount survived.
    const store = engine.store
    if (store === null || store === undefined || typeof store.resolve !== 'function') return undefined
    try {
      store.resolve(alias)
      return undefined
    } catch (error) {
      return `the host is not resolvable: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  /**
   * Keep one plain-path decision and report the ones a user must be able to see.
   *
   * Only two verdicts are warnings: "ambiguous" and "host unavailable" are the
   * cases where a remote world was plausible and was deliberately withheld. A
   * path that exists locally, or one under no root at all, is the ordinary
   * local case and would otherwise flood the log on every local git/rg call.
   *
   * `ctx.logger` does not reach a user in this deployment (diagnostics.js), so
   * the same sentence is also recorded on the engine's diagnostics ring, which
   * `ssh_workspace_status` and the panel's status route serve.
   *
   * @param {unknown} cwd - the spec's cwd.
   * @param {object} decision - the routing verdict.
   * @returns {void}
   */
  #rememberPlainRoute (cwd, decision) {
    const key = `${decision.kind}\0${decision.reason ?? ''}\0${typeof cwd === 'string' ? cwd : ''}`
    if (this.plainRoutes.has(key)) return
    if (this.plainRoutes.size >= PLAIN_ROUTE_MEMORY) {
      const oldest = this.plainRoutes.keys().next().value
      if (oldest !== undefined) this.plainRoutes.delete(oldest)
    }
    this.plainRoutes.set(key, decision)
    if (decision.kind === 'remote') {
      this.logger?.debug?.(`ssh-workspace: routing plain path ${JSON.stringify(cwd)} to ${decision.displayPath} (mounted root ${decision.root})`)
      return
    }
    if (decision.reason !== PLAIN_ROUTE_REASONS.AMBIGUOUS_ROOT && decision.reason !== PLAIN_ROUTE_REASONS.HOST_UNAVAILABLE) return
    const message = decision.reason === PLAIN_ROUTE_REASONS.AMBIGUOUS_ROOT
      ? `ssh-workspace: not routing plain path ${JSON.stringify(cwd)} to a remote host — it is under more than one mounted root (${(decision.candidates ?? []).join(', ')}); keeping the local subprocess behavior so an ambiguity can never reach a destructive command`
      : `ssh-workspace: not routing plain path ${JSON.stringify(cwd)} to ${(decision.candidates ?? [])[0] ?? 'a remote host'} — ${decision.detail ?? 'the host is not usable'}; keeping the local subprocess behavior`
    this.logger?.warn?.(message)
    try {
      this.engine?.diagnostics?.record?.('degraded', message, { alias: decision.alias })
    } catch { /* a diagnostic must never be the reason the spawn fails */ }
  }

  /**
   * Spawn one remote process.
   *
   * Follows the seam's lifecycle rules: validation failures and unsupported
   * modes throw synchronously (before any connection work), the handle is
   * returned synchronously, and infrastructure failures settle it — `done`
   * resolves with exit facts or rejects with the provider failure, never the
   * other way around.
   *
   * @param {object} spec - a subprocess spec whose cwd is remote.
   * @param {{alias: string, remotePath: string, displayPath?: string, root?: string}} [route]
   *   - the routing verdict, when the cwd is a plain path admitted by
   *   {@link resolvePlainRemoteRoute}; omitted for an `ssh://` cwd.
   * @returns {object} the live handle.
   * @throws {Error} on an invalid spec, an unsupported stdio/control mode, or
   *   an executable outside the git/ripgrep whitelist.
   */
  spawn (spec, route) {
    if (spec === null || typeof spec !== 'object') throw new Error('ssh-workspace: subprocess spec must be an object')
    // local patch: DSH 沙箱把命令包成 landlock-run/bwrap，argv[0] 不再是 git，
    // 白名单会误拒。按沙箱的约定 [launcher, ...grants, '--', cmd, ...] 剥掉前缀。
    let argv = spec.argv
    if (Array.isArray(argv) && argv.length > 2 && typeof argv[0] === 'string') {
      const base0 = (argv[0].split(/[/\\]/u).pop() ?? '').toLowerCase()
      if (base0 === 'landlock-run' || base0 === 'bwrap' || base0 === 'sandbox-exec') {
        const sep = argv.indexOf('--')
        if (sep > 0 && sep + 1 < argv.length) argv = argv.slice(sep + 1)
      }
    }
    if (!Array.isArray(argv) || argv.length === 0 || typeof argv[0] !== 'string' || argv[0].trim() === '') {
      throw new Error('ssh-workspace: subprocess spec is invalid: argv[0] must be a non-empty string')
    }
    if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0 || spec.graceMs > MAX_TIMER_DELAY_MS) {
      throw new Error(`ssh-workspace: subprocess spec is invalid: graceMs must be a finite number in (0, ${MAX_TIMER_DELAY_MS}]`)
    }
    if (spec.signal?.aborted === true) {
      let reason = 'aborted'
      try {
        reason = String(spec.signal.reason ?? reason)
      } catch { /* unprintable reason */ }
      throw new Error(`aborted before spawn: ${reason}`)
    }
    if (spec.control !== undefined && spec.control !== null) {
      throw new Error('ssh-workspace: spec.control is not supported for a remote ssh:// subprocess')
    }
    const parts = route ?? parseRemotePath(spec.cwd)
    // Detached workspaces spawn nothing: git and ripgrep are content
    // operations, and letting them run would keep the workspace usable.
    this.engine.assertNotDisabled(parts.alias, parts.remotePath)
    const command = remoteCommandFor(argv[0])
    const stdoutMode = collectModeOf(spec.stdio?.stdout, 'stdout')
    const stderrMode = collectModeOf(spec.stdio?.stderr, 'stderr')
    const stdinPayload = stdinPayloadOf(spec.stdio?.stdin)
    const mkdirs = new Set()
    const script = buildScript(spec, parts, command, argv, mkdirs)
    const alias = parts.alias

    /** @type {{stdout?: StreamTail, stderr?: StreamTail}} */
    const collected = {}
    const stdoutTail = stdoutMode.collect ? new StreamTail(stdoutMode.maxBytes) : undefined
    const stderrTail = stderrMode.collect ? new StreamTail(stderrMode.maxBytes) : undefined
    if (stdoutTail !== undefined) collected.stdout = stdoutTail
    if (stderrTail !== undefined) collected.stderr = stderrTail

    let settled = false
    let killedByUs = false
    /** @type {undefined | 'soft' | 'hard'} */
    let terminationMode
    let lastSignal
    /** @type {object | undefined} */
    let record
    /** @type {any} */
    let stream
    let killLadder
    let killGrace
    let resolveDone
    let rejectDone
    const done = new Promise((resolve, reject) => {
      resolveDone = resolve
      rejectDone = reject
    })
    // A caller that never awaits must not trip the unhandled-rejection hook.
    void done.catch(() => {})

    /** One-time teardown: timers, the abort listener, and the in-flight slot. */
    const release = () => {
      if (killLadder !== undefined) clearTimeout(killLadder)
      if (killGrace !== undefined) clearTimeout(killGrace)
      spec.signal?.removeEventListener?.('abort', onAbort)
      if (record !== undefined) {
        record.inFlight -= 1
        record.idleAt = Date.now()
      }
    }

    /** Stamp the exit facts and fulfill `done` (exactly once). */
    const settle = (code, signalName) => {
      if (settled) return
      settled = true
      stdoutTail?.seal()
      stderrTail?.seal()
      const exitCode = typeof code === 'number' ? code : null
      const endSignal = typeof signalName === 'string' && signalName !== ''
        ? signalName
        : killedByUs ? (lastSignal ?? 'KILL') : null
      release()
      resolveDone({ exitCode, signal: endSignal })
    }

    /** The infrastructure-failure path: `done` rejects. */
    const fail = (error) => {
      if (settled) return
      settled = true
      let detail = 'unprintable provider failure'
      try {
        detail = String(error?.message ?? error)
      } catch { /* unprintable */ }
      stderrTail?.push(`ssh-workspace: ssh exec failed before reporting an outcome: ${detail}\n`)
      stdoutTail?.seal()
      stderrTail?.seal()
      release()
      rejectDone(error instanceof Error ? error : new Error(String(error)))
    }

    /** Send SIGKILL and close the channel; arm the transport-drop fallback. */
    const signalKill = () => {
      lastSignal = 'KILL'
      try { stream?.signal('KILL') } catch { /* channel gone */ }
      try { stream?.close() } catch { /* channel gone */ }
      if (killGrace === undefined) {
        killGrace = setTimeout(() => {
          if (settled) return
          // The transport never reported the kill: drop the pooled connection
          // so the handle cannot hang, and settle as killed.
          if (record !== undefined) {
            record.broken = true
            this.engine.closeRecord(record.alias, record)
          }
          settle(null, null)
        }, KILL_GRACE_MS)
        if (typeof killGrace.unref === 'function') killGrace.unref()
      }
    }

    /**
     * Request termination of the remote command: soft walks SIGTERM →
     * `graceMs` → SIGKILL, hard goes straight to SIGKILL. A request made
     * before the channel exists is replayed once it does.
     */
    const requestTermination = (hard) => {
      killedByUs = true
      if (hard === true) terminationMode = 'hard'
      terminationMode ??= 'soft'
      lastSignal = terminationMode === 'hard' ? 'KILL' : 'TERM'
      if (stream === undefined) return
      if (terminationMode === 'hard') {
        signalKill()
        return
      }
      try { stream.signal('TERM') } catch { /* channel gone */ }
      if (killLadder === undefined) {
        killLadder = setTimeout(() => { signalKill() }, spec.graceMs)
        if (typeof killLadder.unref === 'function') killLadder.unref()
      }
    }

    function onAbort () {
      requestTermination(true)
    }

    /**
     * Wait for the process to settle without consuming `done`; `signal`
     * cancels the wait, not the process.
     *
     * @param {AbortSignal} [signal] - wait cancellation.
     * @returns {Promise<void>} resolves once the process has settled.
     */
    const waitForExit = (signal) => {
      if (signal?.aborted === true) return Promise.reject(new Error('wait aborted'))
      return new Promise((resolve, reject) => {
        const onWaitAbort = () => { cleanup(); reject(new Error('wait aborted')) }
        const cleanup = () => signal?.removeEventListener?.('abort', onWaitAbort)
        signal?.addEventListener?.('abort', onWaitAbort, { once: true })
        done.then(() => { cleanup(); resolve() }, () => { cleanup(); resolve() })
      })
    }

    const handle = {
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      control: undefined,
      collected,
      done,
      terminate: () => {
        if (settled) return false
        requestTermination(false)
        return true
      },
      terminateForHostExit: () => { requestTermination(true) },
      waitForExit,
    }

    if (spec.signal !== undefined && spec.signal !== null && typeof spec.signal.addEventListener === 'function') {
      spec.signal.addEventListener('abort', onAbort, { once: true })
    }

    void (async () => {
      try {
        record = await this.engine.acquire(alias)
      } catch (error) {
        if (killedByUs) settle(null, null)
        else fail(error)
        return
      }
      record.idleAt = Date.now()
      record.inFlight += 1
      if (killedByUs) {
        settle(null, null)
        return
      }
      try {
        stream = await new Promise((resolve, reject) => {
          // channelExecOptions expresses the host's agent-forwarding wish on
          // this command channel; ssh2 keeps it inert without a connection agent.
          record.client.exec(script, channelExecOptions(record), (error, channel) => {
            if (error !== undefined && error !== null) reject(error)
            else resolve(channel)
          })
        })
      } catch (error) {
        fail(error)
        return
      }
      if (settled) {
        try { stream.close() } catch { /* channel gone */ }
        return
      }
      stream.on('data', (chunk) => { stdoutTail?.push(chunk) })
      stream.stderr.on('data', (chunk) => { stderrTail?.push(chunk) })
      stream.on('close', (code, signalName) => {
        if (settled) return
        if (!killedByUs && (code === null || code === undefined) && (signalName === null || signalName === undefined)) {
          // No exit status and no signal: the channel died with the transport.
          fail(new Error('ssh-workspace: the SSH connection dropped before the process reported an exit status'))
          return
        }
        settle(code, signalName)
      })
      stream.on('error', (error) => { fail(error) })
      if (killedByUs) requestTermination(terminationMode === 'hard')
      stream.end(stdinPayload)
      this.logger?.debug?.(`ssh-workspace: spawned ${command} on ${alias} in ${parts.remotePath}`)
    })()

    return handle
  }
}

/**
 * Install the remote half onto the live `ctx.subprocess` service.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 * @param {object} options - install options.
 * @param {import('./engine.js').SshWorkspaceEngine} options.engine - live SSH engine.
 * @param {object} [options.logger] - a Cordis logger, when available.
 * @returns {RemoteSubprocessRouter | undefined} the router, or undefined when no `subprocess` service is mounted.
 * @throws {Error} when the mounted service has no `spawn()` to wrap.
 */
export function installRemoteSubprocess (ctx, options) {
  const target = ctx.get('subprocess')
  if (target === undefined || target === null) return undefined
  if (target[INSTALLED] !== undefined) return target[INSTALLED]

  const originalSpawn = target.spawn
  if (typeof originalSpawn !== 'function') {
    throw new Error('ssh-workspace: the mounted ctx.subprocess service has no spawn() to wrap')
  }
  const local = originalSpawn.bind(target)
  const router = new RemoteSubprocessRouter(options)
  const spawn = function (spec) {
    if (spec !== null && typeof spec === 'object') {
      if (isRemotePath(spec.cwd)) return router.spawn(spec)
      //
      // A Host subsystem can strip the scheme before it calls git (Forge does
      // it through ctx.fs.processPath), and then the ONLY thing left is a
      // remote absolute path that happens to be inside a mounted root. The
      // rule for admitting it is deliberately narrow and lives in one place;
      // every rejected case keeps the local spawn, which is what used to
      // happen for all of them.
      const decision = router.plainRouteFor(spec.cwd)
      if (decision.kind === 'remote') return router.spawn(spec, decision)
    }
    return local(spec)
  }
  Object.defineProperty(target, 'spawn', { value: spawn, writable: true, configurable: true, enumerable: false })
  Object.defineProperty(target, INSTALLED, { value: router, writable: false, configurable: true, enumerable: false })
  options.logger?.info?.('ssh-workspace: took over ctx.subprocess for ssh:// cwds and uniquely-mounted plain paths')
  return router
}

/**
 * Undo {@link installRemoteSubprocess}, restoring the original `spawn`.
 *
 * @param {object | undefined} target - the patched service instance.
 * @returns {void}
 */
export function uninstallRemoteSubprocess (target) {
  if (target === undefined || target === null) return
  if (target[INSTALLED] === undefined) return
  if (Object.hasOwn(target, 'spawn')) delete target.spawn
  delete target[INSTALLED]
}

// Exported for tests: the retained-window caching is a performance property
// with no observable difference in output, so it is only checkable directly.
export { StreamTail }
