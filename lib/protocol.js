/**
 * Shared vocabulary for the remote-workspace plugin: host records, the
 * `ssh://` target grammar, and the config store shape.
 *
 * @module @dsh-community/dsh-ssh-workspace/protocol
 */

/** The URI scheme that identifies a remote target on the filesystem seam. */
export const SSH_SCHEME = 'ssh'

/**
 * The canonical spelling of one remote target.
 *
 * `displayPath` is `ssh://<alias>/<remote-absolute-path>`; `targetKey` adds the
 * POSIX-normalized path so `..` segments and trailing slashes share one
 * identity. The alias is a DNS-ish label and can never contain `/`, so the
 * authority split is unambiguous.
 */
const REMOTE_RE = /^ssh:\/\/([^/]+)(\/.*)$/u

/**
 * Parse a remote target spelling.
 *
 * @param {string} path - a candidate `ssh://alias/abs/path` string.
 * @returns {{alias: string, remotePath: string} | undefined} the parts, or
 *   `undefined` when `path` is not a remote target at all.
 * @throws {Error} when the string uses the `ssh://` scheme but names no alias
 *   or no absolute remote path — a caller error worth reporting, not ignoring.
 */
export function parseRemotePath (path) {
  if (typeof path !== 'string' || !path.startsWith(`${SSH_SCHEME}://`)) return undefined
  const match = REMOTE_RE.exec(path)
  if (match === null) {
    throw new Error(`not a remote workspace path: ${JSON.stringify(path)} — expected ssh://<alias>/<absolute-remote-path>`)
  }
  const [, alias, remotePath] = match
  return { alias, remotePath: normalizeRemotePath(remotePath) }
}

/**
 * Whether a path names a remote target.
 *
 * @param {string} path - candidate path.
 * @returns {boolean} true for any `ssh://` spelling, valid or not.
 */
export function isRemotePath (path) {
  return typeof path === 'string' && path.startsWith(`${SSH_SCHEME}://`)
}

/**
 * Normalize a remote POSIX path: collapse `.` segments and resolve `..`
 * lexically, preserving a leading `/`. Lexical resolution is deliberate — the
 * seam resolves identity without a remote round-trip, exactly as `fs-local`
 * does for a missing target's suffix.
 *
 * @param {string} path - remote absolute path.
 * @returns {string} the normalized absolute path.
 * @throws {Error} when the path is not absolute.
 */
export function normalizeRemotePath (path) {
  if (typeof path !== 'string' || path === '') throw new Error('remote path must be a non-empty string')
  if (!path.startsWith('/')) throw new Error(`remote path must be absolute: ${JSON.stringify(path)}`)
  const segments = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return `/${segments.join('/')}`
}

/**
 * Build the canonical remote spelling for one target.
 *
 * @param {string} alias - host alias.
 * @param {string} remotePath - remote absolute path.
 * @returns {string} `ssh://<alias>/<normalized path>`.
 */
export function formatRemotePath (alias, remotePath) {
  const normalized = normalizeRemotePath(remotePath)
  return `${SSH_SCHEME}://${alias}${normalized}`
}

/**
 * Encode one remote path as the canonical `file:` URI of the remote world.
 *
 * The remote execution world is POSIX, so this mirrors `pathToFileURL` on a
 * POSIX platform: separators stay literal and every other reserved or
 * non-ASCII character is percent-encoded, segment by segment. Callers that
 * derive paths from `new URL(url).pathname` — the DSH workspace-file service
 * does — get `/`-joined answers on every host platform.
 *
 * @param {string} remotePath - remote absolute path.
 * @returns {string} `file://` + the encoded remote absolute path.
 */
export function formatRemoteFileUrl (remotePath) {
  const normalized = normalizeRemotePath(remotePath)
  return `file://${normalized.split('/').map(encodeURIComponent).join('/')}`
}

/**
 * Whether `child` is `parent` or lies strictly beneath it, by remote POSIX
 * path semantics. The comparison is purely lexical over normalized paths, which
 * is the correct answer for the containment question the sandbox fence asks.
 *
 * @param {string} parent - containing remote path.
 * @param {string} child - candidate descendant.
 * @returns {boolean} whether `child` is inside `parent`.
 */
export function isRemotePathUnder (parent, child) {
  const root = normalizeRemotePath(parent)
  const target = normalizeRemotePath(child)
  if (target === root) return true
  return target.startsWith(root === '/' ? '/' : `${root}/`)
}

/** POSIX basename of a remote path. */
export function remoteBasename (remotePath) {
  const normalized = normalizeRemotePath(remotePath)
  if (normalized === '/') return '/'
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

/** POSIX dirname of a remote path. */
export function remoteDirname (remotePath) {
  const normalized = normalizeRemotePath(remotePath)
  if (normalized === '/') return '/'
  const cut = normalized.lastIndexOf('/')
  return cut <= 0 ? '/' : normalized.slice(0, cut)
}
