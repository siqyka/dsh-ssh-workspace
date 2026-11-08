/**
 * Pure rules for the rename / delete surface.
 *
 * The interesting failures of a rename or delete are all DECIDABLE before any
 * filesystem is touched: an empty name, a name that smuggles a separator, a
 * target that is the workspace root itself, a path that leaves the root
 * lexically. Keeping those decisions here — no `fs`, no `sftp`, no request —
 * is what lets the same rules be tested directly and reused by both the remote
 * and the local branch. The impure half (realpath, lstat, SFTP calls) lives in
 * `routes.js` and asks these functions first.
 *
 * @module @shiqyka/dsh-ssh-workspace/mutations
 */

import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** The maximum length of one file name on any filesystem we support. */
export const MAX_NAME_LENGTH = 255

/**
 * Why a proposed new name cannot be used, or `undefined` when it can.
 *
 * One path segment only. The separator check is deliberately duplicated for
 * `/` and `\`: a Windows local root and a POSIX remote root are both served by
 * this plugin, and a name carrying the OTHER platform's separator is still a
 * name that can escape once the target is interpreted on that platform.
 *
 * @param {unknown} newName - the candidate.
 * @returns {string | undefined} a user-readable refusal.
 */
export function mutationNameRefusal (newName) {
  if (typeof newName !== 'string') return 'a new name is required'
  if (newName === '') return 'the new name cannot be empty'
  if (newName.trim() === '') return 'the new name cannot be only whitespace'
  if (newName === '.' || newName === '..') return 'the new name cannot be "." or ".."'
  if (newName.includes('/') || newName.includes('\\')) return 'the new name must be a single path segment'
  if (newName.includes('\0')) return 'the new name cannot contain a NUL byte'
  if (newName.length > MAX_NAME_LENGTH) return `the new name cannot be longer than ${MAX_NAME_LENGTH} characters`
  return undefined
}

/**
 * Whether `target` is lexically inside `root` (or is the root itself).
 *
 * Purely lexical: realpath containment is a separate, later question asked by
 * the route once the filesystem can answer it. This one has to be decidable
 * without touching a disk, because it is also the rule the tests pin.
 *
 * @param {string} root - absolute root directory.
 * @param {string} target - absolute candidate.
 * @returns {boolean} true when the candidate does not leave the root.
 */
export function isWithinLocalRoot (root, target) {
  if (typeof root !== 'string' || typeof target !== 'string') return false
  const base = resolve(root)
  const candidate = resolve(target)
  const rel = relative(base, candidate)
  if (rel === '') return true
  if (isAbsolute(rel)) return false
  const first = rel.split(sep)[0]
  return first !== '..'
}

/**
 * Why the workspace root itself cannot be renamed or deleted, or `undefined`.
 *
 * Both operations destroy the frame the session is standing in — a delete takes
 * the workspace out from under every open tab, and a rename changes the cwd
 * that the session's own header records. Neither can be undone from this
 * surface, so both are refused rather than confirmed.
 *
 * @param {string} root - the authoritative workspace root.
 * @param {string} target - the candidate target.
 * @returns {string | undefined} a user-readable refusal.
 */
export function rootMutationRefusal (root, target) {
  const base = resolve(root)
  const candidate = resolve(target)
  if (candidate === base) return 'the workspace root itself cannot be renamed or deleted'
  return undefined
}

/**
 * What a deletion confirmation must say, in one line.
 *
 * The count is the number of selected rows, not the number of files a directory
 * expands to: a server-side recursive count would be a second walk of the tree
 * (slow on a huge directory) for a number the user cannot act on differently.
 * The wording says "including subdirectories" so the count is not misread.
 *
 * @param {number} count - how many rows the action covers.
 * @param {boolean} hasDirectory - whether any row is a directory.
 * @returns {string} the confirmation sentence.
 */
export function deletionSummary (count, hasDirectory) {
  const n = Number.isInteger(count) && count > 0 ? count : 0
  const items = `${n} item${n === 1 ? '' : 's'}`
  return hasDirectory
    ? `Delete ${items}? Directories are removed with everything inside them, including subdirectories. This cannot be undone.`
    : `Delete ${items}? This cannot be undone.`
}

/**
 * The child path a rename would produce, refusing names that escape.
 *
 * @param {string} parent - the directory holding the entry.
 * @param {string} newName - the validated new name.
 * @returns {string} the sibling path.
 */
export function renameTargetPath (parent, newName) {
  return join(parent, newName)
}
