/**
 * One place that turns what a caller sent into what SFTP needs.
 *
 * The panel's file tree hands out `ssh://<alias>/<absolute-path>` — the spelling
 * the workspace seam understands — while the byte routes talk SFTP with an
 * alias and a remote-absolute path. Passing the seam spelling straight to
 * `sftpStatOrNull` produced "remote file does not exist: ssh://…" from the
 * media viewer, because `/home/…` had `ssh://alias` glued to the front.
 *
 * Normalizing at the route boundary keeps every caller honest: a prefixed path
 * is split into alias + path, a bare path is used as-is, and a malformed
 * prefixed path is the caller's error (the route answers 400) rather than an
 * SFTP mystery.
 *
 * @module @shiqyka/dsh-ssh-workspace/routes/remote-target
 */

import { isRemotePath, parseRemotePath } from '../core/protocol.js'

/**
 * Resolve `alias` + `path` into an SFTP-ready target.
 *
 * @param {string} alias - alias from the query string, may be empty.
 * @param {string} path - absolute remote path, possibly spelled `ssh://alias/…`.
 * @returns {{alias: string, remotePath: string} | undefined} undefined when the
 *   pair cannot name anything (empty path, no alias, malformed prefix).
 */
export function resolveRemoteTarget (alias, path) {
  const raw = typeof path === 'string' ? path.trim() : ''
  if (raw === '') return undefined
  const given = typeof alias === 'string' ? alias.trim() : ''
  if (!isRemotePath(raw)) {
    return given === '' ? undefined : { alias: given, remotePath: raw }
  }
  let parsed
  try {
    parsed = parseRemotePath(raw)
  } catch {
    // A broken prefix is a bad request, not a missing file: the route turns
    // `undefined` into 400 so the reader is not told a lie about the disk.
    return undefined
  }
  if (parsed === undefined) return undefined
  const who = given === '' ? parsed.alias : given
  return who === '' ? undefined : { alias: who, remotePath: parsed.remotePath }
}
