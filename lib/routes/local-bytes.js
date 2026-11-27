/**
 * Reading LOCAL bytes through the same routes that serve remote ones.
 *
 * The previews were written for `ssh://` targets, but a session can live in a
 * LOCAL workspace — this repository is one. Claiming its images and then only
 * offering a remote route is what made "the session is not connected" appear
 * over a picture that was sitting on the same disk as the app; the right answer
 * is to serve the bytes, under the same workspace fence every other local read
 * already uses.
 *
 * The fence comes from the SESSION, never the request: `mutationContextOf`
 * resolves the session, `localRootOf` reads the root it owns, and the resolved
 * (symlink-free) path must still be inside it. A path that escapes through a
 * junction is refused before any bytes are read.
 *
 * @module @shiqyka/dsh-ssh-workspace/routes/local-bytes
 */

import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { isWithinLocalRoot } from '../transfer/transfer-rules.js'
import { codedError } from './kit.js'
import { localRootOf, mutationContextOf, requireLocalTarget } from './entries.js'

/**
 * Resolve a local preview target, fenced by the session's workspace root.
 *
 * @param {object} ctx - the host context (for the session registry).
 * @param {{sessionId?: string, path: string}} request - what the client asked for.
 * @returns {Promise<{absolute: string, size: number}>} the real file and its size.
 */
export async function resolveLocalRead (ctx, request) {
  const owner = mutationContextOf(ctx, { sessionId: request.sessionId, path: request.path })
  if (owner.session === undefined) {
    throw codedError('cannot read a local file without the session that owns it', 'FS_PERMISSION_DENIED')
  }
  const root = localRootOf(owner)
  // The file tree hands out paths RELATIVE to the workspace root (the same
  // spelling the text route accepts), so a bare relative name is resolved
  // against that root rather than rejected as "not absolute".
  const target = isAbsolute(request.path) ? request.path : resolve(root, request.path)
  const local = requireLocalTarget(target)
  if (!isWithinLocalRoot(root, local)) {
    throw codedError(`cannot read "${local}": outside the session workspace ${root}`, 'FS_OUTSIDE_WORKSPACE')
  }
  // The lexical check is not enough on Windows: a junction inside the root can
  // point anywhere. The resolved path has to still be inside the same root.
  const absolute = await realpath(local)
  if (!isWithinLocalRoot(root, absolute)) {
    throw codedError(`cannot read "${local}": it resolves outside ${root}`, 'FS_OUTSIDE_WORKSPACE')
  }
  const info = await stat(absolute)
  if (typeof info.isDirectory === 'function' && info.isDirectory()) {
    throw codedError(`not a file: ${local}`, 'FS_NOT_REGULAR_FILE')
  }
  return { absolute, size: info.size }
}
