/**
 * The entry routes: listing a directory, reading git history, and the
 * mutations (rename, delete, mkdir, create-file) plus the policy that gates
 * them.
 *
 * These are the routes a user drives by clicking something in a file tree, and
 * they are the only ones that CHANGE a filesystem. That is why the mutation
 * helpers live here rather than in the kit: every one of them exists to answer
 * "may this path be touched at all?" - the session workspace root, the mount
 * fence, the read-only mode, the local realpath check - and a fence stated in a
 * file 1,400 lines away from the route that applies it is a fence nobody
 * re-reads.
 *
 * @module @shiqyka/dsh-ssh-workspace/routes/entries
 */

import { lstat, mkdir, open, realpath, rename, rm, stat, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve as resolveLocal } from 'node:path'
import { formatRemotePath, isRemotePath, normalizeRemotePath, parseRemotePath, remoteDirname } from '../core/protocol.js'
import { isWithinLocalRoot, mutationNameRefusal, renameTargetPath, rootMutationRefusal } from '../transfer/transfer-rules.js'
import { readGitHistory } from '../engine/git-history.js'
import { sessionPolicyOf, writeModeRefusal } from '../core/mode-gate.js'
import { KINDS } from '../core/diagnostics.js'
import { shellQuote } from '../engine/engine.js'
import {
  assertWithinRemoteRoots,
  compareEntries,
  isWithinRemoteRoots,
  sftpLstatOrNull,
  sftpMkdirStrict,
  sftpReaddir,
  sftpRealpathStrict,
  sftpRenameStrict,
  sftpStatOrNull,
  writeFenceRoots,
} from '../fs/remote-fs.js'
import { codedError, queryParam, readJsonBody, statusForActionError, trimmedParam, writeJson } from './kit.js'
import { ROUTES } from './routes.js'

/** Resolve an SFTP path (`.` = the login directory) to an absolute one. */
function sftpRealpath (sftp, target) {
  return new Promise((resolve, reject) => {
    sftp.realpath(target, (err, resolved) => {
      if (err) reject(err)
      else if (typeof resolved !== 'string' || !resolved.startsWith('/')) reject(new Error(`realpath did not return an absolute path: ${String(resolved)}`))
      else resolve(resolved)
    })
  })
}

/** The unmount modes this endpoint accepts. */

/**
 * How many directory entries one `ls` response carries by default.
 *
 * The listing exists for two pickers in the panel (the directory browser and
 * the add-workspace chooser). Neither can usefully render thousands of rows,
 * and an unbounded response is a real hazard rather than a theoretical one: a
 * `node_modules`, a mail spool or a build output directory turns one click
 * into a multi-megabyte JSON body, a full re-render and a stalled dialog — on
 * the same main thread that draws everything else.
 *
 * What the cap does NOT do is reduce work on the host: ssh2's `readdir` hands
 * back the whole listing and there is no paging primitive in SFTP, so the
 * server still receives every entry. The saving is the response, the parse and
 * the render — which is where the cost actually showed up. Say so plainly
 * rather than implying the listing was made cheap.
 */
const LS_DEFAULT_LIMIT = 500

/** Ceiling for an explicit `limit`, so the cap cannot be re-opened by a caller. */
const LS_MAX_LIMIT = 2000

/**
 * Parse a `limit` query parameter.
 *
 * Absent means the default; anything that is not a positive integer is refused
 * rather than silently coerced, because "limit=abc" quietly becoming 500 would
 * hide the caller's mistake behind a number that looks deliberate.
 *
 * @param {string | undefined} raw - the raw query value.
 * @returns {number | undefined} the limit, or undefined when invalid.
 */
function parseLimit (raw) {
  if (raw === undefined) return LS_DEFAULT_LIMIT
  if (!/^\d+$/u.test(raw)) return undefined
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) return undefined
  return Math.min(value, LS_MAX_LIMIT)
}

/**
 * Order entries so truncation is deterministic and least destructive.
 *
 * The rule lives in `compareEntries`, next to the listing that also uses it:
 * directories first, then names, by code unit. Code-unit order rather than
 * `localeCompare` on purpose — the cut-off has to be the same on every machine
 * and in every process locale, and a listing whose 500th entry depends on the
 * ICU build hides a different file each time. The panel re-sorts what it
 * receives by its own rule, so this ordering is not a presentation decision —
 * only a decision about what survives the cap.
 */
const compareForTruncation = compareEntries

/**
 * The marker the one-round-trip directory listing writes to stderr.
 *
 * stdout carries names and stderr carries status, on purpose: a directory can
 * be named exactly like a status line, so the two must not share a stream.
 * `ls` errors are discarded by the command, which leaves the marker as the only
 * line the parser accepts.
 */
const LS_DIRS_MARKER = '__dsh_ssh_ws_dirs__'

/** How long the one-round-trip listing may take before it is given up. */
const LS_DIRS_TIMEOUT_MS = 10_000

/**
 * Build the shell command that lists one directory's subdirectories in ONE
 * round trip, plus the account's writability of that directory.
 *
 * ## Why this exists beside the SFTP listing
 *
 * `sftp.readdir` is the correct primitive, and it is slow for the one thing the
 * pickers do: the protocol returns each entry's ATTRIBUTES, which a server
 * produces with a per-entry `lstat`. For a small directory that is a couple of
 * round trips; for a shared `/tmp` with tens of thousands of entries it is
 * thousands of stats and dozens of READDIR packets, and on a high-latency link
 * the dialog looks hung (measured: 25 000 entries did not finish in 30 s, while
 * `ls` on the same host takes 44 ms). The pickers only need NAMES, so one `ls`
 * piped through a filter answers them in one channel open — and the filter
 * applies the cap BEFORE anything crosses the wire, so a huge directory sends
 * at most `limit` names.
 *
 * Nothing here is trusted to be clever. The command only lists, it quotes the
 * path, and the caller FALLS BACK to the SFTP route whenever the answer is not
 * exactly the shape below (a non-POSIX login shell, a missing `awk`, an
 * unreadable directory). The fallback keeps this an optimisation rather than a
 * second implementation of the truth.
 *
 * An empty path means the login directory: `pwd -P` resolves it on the remote
 * side — the same answer `sftp.realpath('.')` gives — so the caller spends no
 * extra round trip learning where it is.
 *
 * A chain of single-child directories is folded into one row here too. That is
 * the ONE thing this command does that the SFTP fallback does not: folding
 * there would need one readdir per level, which is the cost the fold exists to
 * avoid. The difference is presentation (a chain takes one click instead of
 * three), never which entries exist.
 *
 */
/** How many single-child levels one listing may fold into one row. */
export const LS_FOLD_MAX_DEPTH = 16

export function dirsListingCommand (path, limit) {
  const dirLine = path === '' ? 'dir=$(pwd -P) || exit 1' : `dir=${shellQuote(path)}`
  return [
    dirLine,
    `if [ ! -d "$dir" ] || [ ! -r "$dir" ] || [ ! -x "$dir" ]; then printf '%s fallback\\n' ${LS_DIRS_MARKER} >&2; exit 0; fi`,
    'w=0',
    'test -w "$dir" && w=1',
    'export LC_ALL=C',
    // A directory whose only directory child is one directory is a level nobody
    // can choose between, so it is drawn as ONE row — `project/src/app` — and
    // entering it lands at the end of the chain. The fold runs HERE, inside the
    // single round trip: folding with one listing per level would cost exactly
    // the round trips it exists to save.
    //
    // `find -type d` uses lstat, so a symlink to a directory is NOT `-type d`
    // and is never folded — a link could leave the directory the user is
    // browsing, and one pointing at its own parent would fold for ever. The
    // depth cap bounds a pathological chain that is real rather than linked.
    // Any doubt stops the fold: a failing `find` or a level with zero or two
    // directories leaves `depth` at its previous value and the listing is what
    // it was before.
    'root="$dir"',
    'prefix=""',
    'depth=0',
    'while [ "$depth" -lt ' + LS_FOLD_MAX_DEPTH + ' ]; do',
    '  found=$(find "$dir" -mindepth 1 -maxdepth 1 -type d 2>/dev/null)',
    '  [ -n "$found" ] || break',
    '  [ "$(printf \'%s\\n\' "$found" | wc -l)" -eq 1 ] || break',
    '  prefix="$prefix${found##*/}/"',
    '  dir="$found"',
    '  depth=$((depth + 1))',
    'done',
    // The path echoed back is the directory the CALLER asked for, not the end of
    // the chain: it is the listing's identity, and mounting or reloading has to
    // name the place the user opened.
    'export LS_DIR="$root"',
    // The folded row goes through the SAME filter as a real listing (it ends in
    // `/`, so it passes), which keeps one place deciding what a row looks like.
    'if [ "$depth" -gt 0 ]; then',
    '  printf \'%s/\\n\' "${prefix%/}"',
    'else',
    // `-p` appends `/` to directories only, so symlinks (which the SFTP route
    // also treats as non-enterable) and files never reach the parser. `-a`
    // keeps dot-directories, which the SFTP listing has always included.
    '  ls -1ap "$dir" 2>/dev/null',
    'fi | awk -v lim=' + limit + ' -v w="$w" -v mark=' + LS_DIRS_MARKER + " '",
    '  $0 == "./" || $0 == "../" { next }',
    '  substr($0, length($0)) != "/" { next }',
    '  { total += 1; if (total <= lim) print substr($0, 1, length($0) - 1) }',
    '  END { printf "%s %d %d %s\\n", mark, total, w, ENVIRON["LS_DIR"] > "/dev/stderr" }',
    "'",
  ].join('\n')
}

/**
 * Read a {@link dirsListingCommand} answer back.
 *
 * `null` is the only failure value, and it means "ask the SFTP route": a
 * non-zero exit, a missing marker, the script's own `fallback` admission, or a
 * shape that does not add up are all the same answer. That is deliberate — a
 * parser that guessed would turn an optimisation into a second, subtly
 * different listing implementation.
 *
 * @returns {{names: string[], total: number, path: string, writable: boolean} | null} the listing.
 */
export function parseDirsListing (outcome, limit) {
  if (outcome === null || typeof outcome !== 'object') return null
  if (outcome.exitCode !== 0) return null
  const stderr = typeof outcome.stderr === 'string' ? outcome.stderr : ''
  const pattern = new RegExp(`^${LS_DIRS_MARKER} (\\d+) ([01]) (/.*)$`, 'u')
  let meta
  for (const line of stderr.split('\n')) {
    const match = pattern.exec(line.trim())
    if (match !== null) meta = match
  }
  if (meta === null || meta === undefined) return null
  const total = Number(meta[1])
  if (!Number.isSafeInteger(total) || total < 0) return null
  const names = (typeof outcome.stdout === 'string' ? outcome.stdout : '')
    .split('\n')
    .filter(name => name !== '')
  // More names than the cap it asked for (or than the directory holds) means
  // this is not the shape being parsed; SFTP answers instead of the UI showing
  // a listing nobody can trust.
  if (names.length > limit || names.length > total) return null
  return { names, total, path: meta[3], writable: meta[2] === '1' }
}

/**
 * The pickers' listing: one exec, no SFTP. `null` means "use the SFTP path".
 *
 * @returns {Promise<{names: string[], total: number, path: string, writable: boolean} | null>} the listing.
 */
async function listDirectoriesInOneRoundTrip (engine, alias, path, limit) {
  let outcome
  try {
    // Read-only, and replayable for the same reason the `test -w` probe is: it
    // cannot repeat a side effect.
    outcome = await engine.exec(alias, dirsListingCommand(path, limit), {
      timeoutMs: LS_DIRS_TIMEOUT_MS,
      replay: 'safe',
      // A listing is a UI read, like `sftp.readdir` — which never appears in the
      // audit either. Recording it would push a multi-line script into the ring
      // on every keystroke of the pickers and bury the commands a user actually
      // asked for.
      audit: false,
    })
  } catch {
    return null
  }
  return parseDirsListing(outcome, limit)
}

function serviceOf (ctx, name) {
  if (ctx === undefined || ctx === null) return undefined
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get(name) : undefined
    if (viaGet !== undefined && viaGet !== null) return viaGet
  } catch { /* not injected here — fall through */ }
  try {
    return ctx[name]
  } catch {
    return undefined
  }
}

/**
 * Identify the session a mutation belongs to, and its effective mode.
 *
 * The workspace root is NEVER taken from the request. The request's `root`
 * (or `sessionId`) is only a SELECTOR used to find a session the server already
 * knows; the boundary itself is that session's own `header.cwd`, read from the
 * session object. A request naming a root no session owns resolves to no
 * session and is refused — which is the whole point of the negative test.
 *
 */
export function mutationContextOf (ctx, body) {
  const sessions = serviceOf(ctx, 'sessions')
  let session
  try {
    const id = typeof body?.sessionId === 'string' ? body.sessionId : ''
    if (id !== '' && typeof sessions?.get === 'function') {
      session = sessions.get(id)
    } else if (typeof body?.root === 'string' && body.root !== '' && typeof sessions?.list === 'function') {
      session = sessions.list().find(candidate => sameWorkspaceRoot(candidate?.header?.cwd, body.root))
    }
  } catch { /* an unreadable session registry must not become a writable one */ }
  const policy = sessionPolicyOf(ctx, session)
  let mode = policy?.mode
  if (mode === undefined || mode === null) {
    // Read the sandbox-mode projection directly when the policy service is
    // absent: the override is a logged event, so a session the user switched
    // to read-only still refuses even on a composition without the service.
    const projections = serviceOf(ctx, 'sessionProjections')
    try {
      const override = projections?.stateOf?.(session, 'sandboxMode')
      if (typeof override === 'string' && override !== '') mode = override
    } catch { /* projection unavailable — mode stays undefined */ }
  }
  return { session, policy, mode }
}

/**
 * Compare two workspace roots for identity.
 *
 * A remote spelling is compared exactly (`ssh://` is already canonical). Two
 * LOCAL spellings are compared after resolving, and case-insensitively on
 * Windows: the host may hand this plugin `F:\repo` while the session records
 * `F:\Repo`, and refusing that would look like "the server does not know this
 * workspace" for a workspace the user is literally looking at.
 *
 * @returns {boolean} true when they name the same root.
 */
function sameWorkspaceRoot (left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  if (left === right) return true
  if (!isAbsolute(left) || !isAbsolute(right)) return false
  const a = resolveLocal(left)
  const b = resolveLocal(right)
  if (a === b) return true
  return process.platform === 'win32' && a.toLowerCase() === b.toLowerCase()
}

/**
 * The shared mode + owner gate for both halves of the mutation surface.
 *
 * @param {string} target - the display path, for the refusal text.
 * @throws {Error} `FS_SANDBOX_DENIED` or `FS_PERMISSION_DENIED`.
 */
export function assertMutationAllowed (ctx, body, target, verb) {
  const resolved = mutationContextOf(ctx, body)
  const refusal = writeModeRefusal(resolved.mode, target, verb)
  if (refusal !== undefined) {
    const suffix = resolved.policy?.unresolved === true && typeof resolved.policy.reason === 'string'
      ? ` (the session policy could not be resolved: ${resolved.policy.reason})`
      : ''
    throw codedError(refusal + suffix, 'FS_SANDBOX_DENIED')
  }
  if (resolved.session === undefined) {
    throw codedError(
      `cannot ${verb} "${target}": the server could not identify the session that owns this workspace, ` +
      'so it cannot prove the target is inside one. Open this workspace from a session (the session id or its ' +
      'workspace root is required), then retry.',
      'FS_PERMISSION_DENIED',
    )
  }
  return resolved
}

/**
 * Parse one remote target and reject anything that is not one.
 *
 * @throws {Error} `FS_INVALID` when the spelling is malformed.
 */
export function requireRemoteParts (target) {
  if (typeof target !== 'string' || target === '') throw codedError('path is required', 'FS_INVALID')
  let parsed
  try {
    parsed = parseRemotePath(target)
  } catch (error) {
    throw codedError(error instanceof Error ? error.message : String(error), 'FS_INVALID')
  }
  if (parsed === undefined) throw codedError(`not a remote path: ${JSON.stringify(target)}`, 'FS_INVALID')
  return { ...parsed, displayPath: target }
}

/** True when one mounted root is exactly this target. */
function isMountedRootItself (roots, parts) {
  if (!(roots instanceof Set)) return false
  for (const root of roots) {
    const parsed = parseRemotePath(root)
    if (parsed !== undefined && parsed.alias === parts.alias && parsed.remotePath === parts.remotePath) return true
  }
  return false
}

/**
 * The reachability + mounted-root + root-itself fence for a remote mutation.
 *
 * @throws {Error} `FS_PERMISSION_DENIED` / `FS_OUTSIDE_WORKSPACE`.
 */
export function assertRemoteFence (router, parts) {
  if (router === undefined || router === null || !(router.roots instanceof Set)) {
    throw codedError('cannot mutate a remote path: the filesystem router is not mounted', 'FS_PERMISSION_DENIED')
  }
  router.assertEnabled?.(parts.alias, parts.remotePath)
  if (isMountedRootItself(router.roots, parts)) {
    throw codedError('the workspace root itself cannot be renamed or deleted', 'FS_PERMISSION_DENIED')
  }
  assertWithinRemoteRoots(writeFenceRoots(router.roots, parts), parts)
}

/**
 * Re-apply the fence to the RESOLVED parent directory.
 *
 * The lexical fence answers "was the spelling inside a root"; a symlinked
 * parent inside the root can still point outside it. The final component is
 * deliberately NOT resolved: deleting a symlink must delete the link, and
 * renaming one must rename the link — resolving it would turn both into
 * operations on the link's target.
 *
 */
async function assertRemoteParentFenced (sftp, router, parts) {
  const parent = remoteDirname(parts.remotePath)
  const resolved = await sftpRealpathStrict(sftp, parent)
  const resolvedParts = {
    alias: parts.alias,
    remotePath: normalizeRemotePath(resolved),
    displayPath: formatRemotePath(parts.alias, resolved),
  }
  // The PARENT being a root is normal for an entry at the top of a mount;
  // only the target itself is refused as "the root" (checked in assertRemoteFence).
  assertWithinRemoteRoots(writeFenceRoots(router.roots, resolvedParts), resolvedParts)
}

/** Promise wrapper for SFTP unlink. */
function unlinkRemote (sftp, target) {
  return new Promise((resolve, reject) => {
    sftp.unlink(target, (error) => {
      if (error !== undefined && error !== null) reject(codedError(`cannot delete "${target}": ${error.message ?? String(error)}`, 'FS_IO_ERROR'))
      else resolve()
    })
  })
}

/** Promise wrapper for SFTP rmdir. */
function rmdirRemote (sftp, target) {
  return new Promise((resolve, reject) => {
    sftp.rmdir(target, (error) => {
      if (error !== undefined && error !== null) reject(codedError(`cannot delete "${target}": ${error.message ?? String(error)}`, 'FS_IO_ERROR'))
      else resolve()
    })
  })
}

/**
 * Open one remote file and keep the handle.
 *
 * The flags are the caller's decision, not a default: `create-file` passes
 * `'wx'` (`O_CREAT|O_EXCL`) because that is the only flag set whose answer
 * cannot be undone by a file appearing between a check and the open. A plain
 * `'w'` would TRUNCATE an existing file instead of refusing it — the failure
 * mode is not "the request failed", it is "the user's file is now empty".
 */
function openRemoteFile (sftp, target, flags, displayPath) {
  return new Promise((resolve, reject) => {
    sftp.open(target, flags, (error, handle) => {
      if (error !== undefined && error !== null) reject(codedError(`cannot create "${displayPath}": ${error.message ?? String(error)}`, 'FS_IO_ERROR'))
      else resolve(handle)
    })
  })
}

/** Close a handle opened by `openRemoteFile`. */
function closeRemoteFile (sftp, handle, displayPath) {
  return new Promise((resolve, reject) => {
    sftp.close(handle, (error) => {
      if (error !== undefined && error !== null) reject(codedError(`cannot create "${displayPath}": ${error.message ?? String(error)}`, 'FS_IO_ERROR'))
      else resolve()
    })
  })
}

/**
 * Record one creation.
 *
 * The path only, never the content: a new file is empty by contract, but the
 * rule that matters is the one applied to every write route — a log that quotes
 * what it wrote turns a saved secret into a second copy of that secret, and the
 * ring is exported in the support bundle.
 */
function auditCreated (engine, displayPath, alias) {
  try {
    engine?.diagnostics?.record?.(KINDS.write, `created ${displayPath}`, { alias })
  } catch { /* a log that can fail the creation it describes is worse than no log */ }
}

/**
 * Delete one remote entry, recursing into directories and NEVER following a
 * symlink.
 *
 * `readdir` lists names; each child is lstat'd before deciding whether to
 * descend. A recursive delete that trusted `readdir`'s dirent type would treat
 * a symlink-to-directory as a directory on servers that report the link target,
 * walking into a tree outside the fence to delete it. lstat is the guard.
 *
 */
async function removeRemoteTree (sftp, target, displayPath) {
  const info = await sftpLstatOrNull(sftp, target)
  if (info === null) throw codedError(`remote entry does not exist: ${displayPath}`, 'FS_NOT_FOUND')
  const isLink = typeof info.isSymbolicLink === 'function' && info.isSymbolicLink()
  const isDir = typeof info.isDirectory === 'function' && info.isDirectory()
  if (isLink || !isDir) {
    await unlinkRemote(sftp, target)
    return
  }
  const entries = await sftpReaddir(sftp, target, displayPath)
  for (const entry of entries) {
    const child = target === '/' ? `/${entry.filename}` : `${target}/${entry.filename}`
    await removeRemoteTree(sftp, child, displayPath)
  }
  await rmdirRemote(sftp, target)
}

/**
 * Create one remote directory below an existing parent, refusing an existing
 * target and any name that is not exactly one path segment.
 *
 * The fence is checked against the CHILD, not the parent: the child is the
 * entry this call creates, and it must be inside a mounted root. The parent is
 * separately resolved and re-fenced inside the SFTP session, which is where a
 * symlinked parent could otherwise escape the root.
 */
async function mkdirRemoteEntry (engine, router, ctx, body) {
  const parent = requireRemoteParts(body?.path)
  const nameRefusal = mutationNameRefusal(body?.name)
  if (nameRefusal !== undefined) throw codedError(nameRefusal, 'FS_INVALID')
  const childPath = normalizeRemotePath(`${parent.remotePath}/${body.name}`)
  const child = {
    alias: parent.alias,
    remotePath: childPath,
    displayPath: formatRemotePath(parent.alias, childPath),
  }
  assertMutationAllowed(ctx, body, child.displayPath, 'create a folder')
  assertRemoteFence(router, child)
  return await engine.withSftp(parent.alias, async (sftp) => {
    await assertRemoteParentFenced(sftp, router, child)
    const parentInfo = await sftpStatOrNull(sftp, parent.remotePath)
    if (parentInfo === null) throw codedError(`remote directory does not exist: ${parent.displayPath}`, 'FS_NOT_FOUND')
    const isDirectory = typeof parentInfo.isDirectory === 'function' && parentInfo.isDirectory()
    if (!isDirectory) throw codedError(`cannot create "${child.displayPath}": "${parent.displayPath}" is not a directory`, 'FS_NOT_DIRECTORY')
    const collision = await sftpLstatOrNull(sftp, childPath)
    if (collision !== null) throw codedError(`target already exists: ${child.displayPath}`, 'EEXIST')
    try {
      await sftpMkdirStrict(sftp, childPath, child.displayPath)
    } catch (error) {
      throw codedError(`cannot create "${child.displayPath}": ${error instanceof Error ? error.message : String(error)}`, 'FS_IO_ERROR')
    }
    return { path: child.displayPath, created: true }
  }, { kind: 'write' })
}

/**
 * Create one local directory below a parent that the owning session proves is
 * inside its own workspace.
 *
 * The local branch never touches SFTP (`void engine; void router`) and re-reads
 * the root from the session, not from the request. Both the lexical fence and
 * the resolved-parent fence are applied before `mkdir`, so a symlinked parent
 * cannot be used to create a directory outside the workspace.
 *
 * @param {object} engine - live engine (deliberately unused).
 * @param {object} router - filesystem router (deliberately unused).
 */
async function mkdirLocalEntry (engine, router, ctx, body) {
  void engine
  void router
  const target = requireLocalTarget(body?.path)
  const nameRefusal = mutationNameRefusal(body?.name)
  if (nameRefusal !== undefined) throw codedError(nameRefusal, 'FS_INVALID')
  const owner = assertMutationAllowed(ctx, body, target, 'create a folder')
  const root = localRootOf(owner)
  if (!isWithinLocalRoot(root, target)) {
    throw codedError(`cannot create a folder in "${target}": outside the session workspace ${root}`, 'FS_OUTSIDE_WORKSPACE')
  }
  const child = join(target, body.name)
  if (!isWithinLocalRoot(root, child)) {
    throw codedError(`cannot create a folder in "${target}": outside the session workspace ${root}`, 'FS_OUTSIDE_WORKSPACE')
  }
  let realRoot
  let realParent
  try {
    realRoot = await realpath(root)
  } catch (error) {
    throw codedError(`cannot create "${child}": the workspace root is not readable: ${error instanceof Error ? error.message : String(error)}`, 'FS_IO_ERROR')
  }
  try {
    realParent = await realpath(target)
  } catch (error) {
    if (error?.code === 'ENOENT') throw codedError(`local directory does not exist: ${target}`, 'FS_NOT_FOUND')
    throw codedError(`cannot create "${child}": ${error instanceof Error ? error.message : String(error)}`, 'FS_IO_ERROR')
  }
  if (!isWithinLocalRoot(realRoot, realParent)) {
    throw codedError(`cannot create "${child}": its directory resolves outside ${realRoot}`, 'FS_OUTSIDE_WORKSPACE')
  }
  let parentInfo
  try {
    parentInfo = await stat(target)
  } catch (error) {
    if (error?.code === 'ENOENT') throw codedError(`local directory does not exist: ${target}`, 'FS_NOT_FOUND')
    throw codedError(`cannot create "${child}": ${error instanceof Error ? error.message : String(error)}`, 'FS_IO_ERROR')
  }
  if (typeof parentInfo.isDirectory !== 'function' || !parentInfo.isDirectory()) {
    throw codedError(`cannot create "${child}": "${target}" is not a directory`, 'FS_NOT_DIRECTORY')
  }
  let collision
  try {
    collision = await lstat(child)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw codedError(`cannot create "${child}": ${error instanceof Error ? error.message : String(error)}`, 'FS_IO_ERROR')
  }
  if (collision !== undefined) throw codedError(`target already exists: ${child}`, 'EEXIST')
  try {
    await mkdir(child)
  } catch (error) {
    throw codedError(`cannot create "${child}": ${error instanceof Error ? error.message : String(error)}`, 'FS_IO_ERROR')
  }
  return { path: child, created: true }
}

/**
 * Create one EMPTY remote file below an existing parent.
 *
 * The same shape as `mkdir` — parent path plus one name — because the client
 * already knows how to ask that question, and a route whose request is shaped
 * like a content write invites callers to send content. Everything about the
 * file after this call is the editor's business.
 *
 * The order of the checks is the contract: name rules before the fence, the
 * fence on the CHILD before any SFTP session, the parent's resolved fence
 * inside the session, then existence / type / collision, and finally an
 * exclusive create. Each step refuses something the next one cannot.
 */
async function createFileRemoteEntry (engine, router, ctx, body) {
  const parent = requireRemoteParts(body?.path)
  const nameRefusal = mutationNameRefusal(body?.name)
  if (nameRefusal !== undefined) throw codedError(nameRefusal, 'FS_INVALID')
  const childPath = normalizeRemotePath(`${parent.remotePath}/${body.name}`)
  const child = {
    alias: parent.alias,
    remotePath: childPath,
    displayPath: formatRemotePath(parent.alias, childPath),
  }
  assertMutationAllowed(ctx, body, child.displayPath, 'create a file')
  assertRemoteFence(router, child)
  return await engine.withSftp(parent.alias, async (sftp) => {
    await assertRemoteParentFenced(sftp, router, child)
    const parentInfo = await sftpStatOrNull(sftp, parent.remotePath)
    if (parentInfo === null) throw codedError(`remote directory does not exist: ${parent.displayPath}`, 'FS_NOT_FOUND')
    const isDirectory = typeof parentInfo.isDirectory === 'function' && parentInfo.isDirectory()
    if (!isDirectory) throw codedError(`cannot create "${child.displayPath}": "${parent.displayPath}" is not a directory`, 'FS_NOT_DIRECTORY')
    // The lstat is only there to give "already exists" its own 409: without it
    // the server's EXCL failure would surface as a 500. It is NOT the guarantee
    // — the open below is, because a file can appear between these two calls.
    const collision = await sftpLstatOrNull(sftp, childPath)
    if (collision !== null) throw codedError(`target already exists: ${child.displayPath}`, 'EEXIST')
    const handle = await openRemoteFile(sftp, childPath, 'wx', child.displayPath)
    await closeRemoteFile(sftp, handle, child.displayPath)
    auditCreated(engine, child.displayPath, parent.alias)
    return { path: child.displayPath, created: true }
  }, { kind: 'write' })
}

/**
 * Create one empty local file inside the session's own workspace.
 *
 * The local branch never touches SFTP (`void router`), and it re-reads the root
 * from the session rather than from the request. Both the lexical fence and the
 * resolved-parent fence run before `open`, so a symlinked parent cannot be used
 * to create a file outside the workspace. `'wx'` is the same exclusive create
 * the remote branch uses: an existing file must be refused, never truncated.
 */
async function createFileLocalEntry (engine, router, ctx, body) {
  void router
  const target = requireLocalTarget(body?.path)
  const nameRefusal = mutationNameRefusal(body?.name)
  if (nameRefusal !== undefined) throw codedError(nameRefusal, 'FS_INVALID')
  const child = join(target, body.name)
  const owner = assertMutationAllowed(ctx, body, child, 'create a file')
  const root = localRootOf(owner)
  if (!isWithinLocalRoot(root, target)) {
    throw codedError(`cannot create a file in "${target}": outside the session workspace ${root}`, 'FS_OUTSIDE_WORKSPACE')
  }
  if (!isWithinLocalRoot(root, child)) {
    throw codedError(`cannot create a file in "${target}": outside the session workspace ${root}`, 'FS_OUTSIDE_WORKSPACE')
  }
  let realRoot
  let realParent
  try {
    realRoot = await realpath(root)
  } catch (error) {
    throw codedError(`cannot create "${child}": the workspace root is not readable: ${error instanceof Error ? error.message : String(error)}`, 'FS_IO_ERROR')
  }
  try {
    realParent = await realpath(target)
  } catch (error) {
    if (error?.code === 'ENOENT') throw codedError(`local directory does not exist: ${target}`, 'FS_NOT_FOUND')
    throw codedError(`cannot create "${child}": ${error instanceof Error ? error.message : String(error)}`, 'FS_IO_ERROR')
  }
  if (!isWithinLocalRoot(realRoot, realParent)) {
    throw codedError(`cannot create "${child}": its directory resolves outside ${realRoot}`, 'FS_OUTSIDE_WORKSPACE')
  }
  let parentInfo
  try {
    parentInfo = await stat(target)
  } catch (error) {
    if (error?.code === 'ENOENT') throw codedError(`local directory does not exist: ${target}`, 'FS_NOT_FOUND')
    throw codedError(`cannot create "${child}": ${error instanceof Error ? error.message : String(error)}`, 'FS_IO_ERROR')
  }
  if (typeof parentInfo.isDirectory !== 'function' || !parentInfo.isDirectory()) {
    throw codedError(`cannot create "${child}": "${target}" is not a directory`, 'FS_NOT_DIRECTORY')
  }
  let collision
  try {
    collision = await lstat(child)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw codedError(`cannot create "${child}": ${error instanceof Error ? error.message : String(error)}`, 'FS_IO_ERROR')
  }
  if (collision !== undefined) throw codedError(`target already exists: ${child}`, 'EEXIST')
  let handle
  try {
    handle = await open(child, 'wx')
  } catch (error) {
    throw codedError(`cannot create "${child}": ${error instanceof Error ? error.message : String(error)}`, 'FS_IO_ERROR')
  }
  try {
    await handle.close()
  } catch (error) {
    throw codedError(`cannot create "${child}": ${error instanceof Error ? error.message : String(error)}`, 'FS_IO_ERROR')
  }
  auditCreated(engine, child, 'local')
  return { path: child, created: true }
}

/** Rename one remote entry, refusing an existing destination. */
async function renameRemoteEntry (engine, router, ctx, body) {
  const parts = requireRemoteParts(body?.path)
  const newName = body?.newName
  const nameRefusal = mutationNameRefusal(newName)
  if (nameRefusal !== undefined) throw codedError(nameRefusal, 'FS_INVALID')
  assertMutationAllowed(ctx, body, parts.displayPath, 'rename')
  assertRemoteFence(router, parts)
  const destination = `${remoteDirname(parts.remotePath)}/${newName}`
  const destinationPath = normalizeRemotePath(destination)
  if (isMountedRootItself(router.roots, { alias: parts.alias, remotePath: destinationPath })) {
    throw codedError('the workspace root itself cannot be renamed or deleted', 'FS_PERMISSION_DENIED')
  }
  return await engine.withSftp(parts.alias, async (sftp) => {
    await assertRemoteParentFenced(sftp, router, parts)
    const existing = await sftpLstatOrNull(sftp, parts.remotePath)
    if (existing === null) throw codedError(`remote entry does not exist: ${parts.displayPath}`, 'FS_NOT_FOUND')
    const collision = await sftpLstatOrNull(sftp, destinationPath)
    if (collision !== null) throw codedError(`target already exists: ${formatRemotePath(parts.alias, destinationPath)}`, 'EEXIST')
    try {
      await sftpRenameStrict(sftp, parts.remotePath, destinationPath)
    } catch (error) {
      throw codedError(
        `cannot rename "${parts.displayPath}" to "${newName}": ${error instanceof Error ? error.message : String(error)}`,
        'FS_IO_ERROR',
      )
    }
    return { path: parts.displayPath, renamedTo: formatRemotePath(parts.alias, destinationPath) }
  }, { kind: 'write' })
}

/** Delete one remote entry, refusing the workspace root itself. */
async function deleteRemoteEntry (engine, router, ctx, body) {
  const parts = requireRemoteParts(body?.path)
  assertMutationAllowed(ctx, body, parts.displayPath, 'delete')
  assertRemoteFence(router, parts)
  return await engine.withSftp(parts.alias, async (sftp) => {
    await assertRemoteParentFenced(sftp, router, parts)
    const info = await sftpLstatOrNull(sftp, parts.remotePath)
    if (info === null) throw codedError(`remote entry does not exist: ${parts.displayPath}`, 'FS_NOT_FOUND')
    const isDir = typeof info.isDirectory === 'function' && info.isDirectory() && !(typeof info.isSymbolicLink === 'function' && info.isSymbolicLink())
    await removeRemoteTree(sftp, parts.remotePath, parts.displayPath)
    return { path: parts.displayPath, deleted: true, kind: isDir ? 'directory' : 'file' }
  }, { kind: 'write' })
}

/** Rename one local entry inside the session's own workspace root. */
async function renameLocalEntry (engine, router, ctx, body) {
  void engine
  void router
  const target = requireLocalTarget(body?.path)
  const owner = assertMutationAllowed(ctx, body, target, 'rename')
  const root = localRootOf(owner)
  const nameRefusal = mutationNameRefusal(body?.newName)
  if (nameRefusal !== undefined) throw codedError(nameRefusal, 'FS_INVALID')
  if (!isWithinLocalRoot(root, target)) {
    throw codedError(`cannot rename "${target}": outside the session workspace ${root}`, 'FS_OUTSIDE_WORKSPACE')
  }
  const rootRefusal = rootMutationRefusal(root, target)
  if (rootRefusal !== undefined) throw codedError(rootRefusal, 'FS_PERMISSION_DENIED')
  const destination = renameTargetPath(dirname(target), body.newName)
  const realRoot = await realpath(root)
  await assertLocalParentInside(realRoot, target)
  const info = await lstat(target)
  if (typeof info.isSymbolicLink !== 'function' || !info.isSymbolicLink()) {
    const realTarget = await realpath(target)
    if (!isWithinLocalRoot(realRoot, realTarget)) {
      throw codedError(`cannot rename "${target}": the resolved path is outside ${root}`, 'FS_OUTSIDE_WORKSPACE')
    }
  }
  let collision
  try { collision = await lstat(destination) } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (collision !== undefined) throw codedError(`target already exists: ${destination}`, 'EEXIST')
  try {
    await rename(target, destination)
  } catch (error) {
    throw codedError(
      `cannot rename "${target}" to "${body.newName}": ${error instanceof Error ? error.message : String(error)}`,
      'FS_IO_ERROR',
    )
  }
  return { path: target, renamedTo: destination }
}

/** Delete one local entry inside the session's own workspace root. */
async function deleteLocalEntry (engine, router, ctx, body) {
  void engine
  void router
  const target = requireLocalTarget(body?.path)
  const owner = assertMutationAllowed(ctx, body, target, 'delete')
  const root = localRootOf(owner)
  if (!isWithinLocalRoot(root, target)) {
    throw codedError(`cannot delete "${target}": outside the session workspace ${root}`, 'FS_OUTSIDE_WORKSPACE')
  }
  const rootRefusal = rootMutationRefusal(root, target)
  if (rootRefusal !== undefined) throw codedError(rootRefusal, 'FS_PERMISSION_DENIED')
  const realRoot = await realpath(root)
  await assertLocalParentInside(realRoot, target)
  const info = await lstat(target)
  const isLink = typeof info.isSymbolicLink === 'function' && info.isSymbolicLink()
  if (isLink) {
    // Only the link body: `realpath(target)` would resolve to the link's
    // target, and a delete of that would destroy something the user never
    // pointed at.
    await unlink(target)
    return { path: target, deleted: true, kind: 'symlink' }
  }
  const realTarget = await realpath(target)
  if (!isWithinLocalRoot(realRoot, realTarget)) {
    throw codedError(`cannot delete "${target}": the resolved path is outside ${root}`, 'FS_OUTSIDE_WORKSPACE')
  }
  if (typeof info.isDirectory === 'function' && info.isDirectory()) {
    await rm(target, { recursive: true, force: false })
    return { path: target, deleted: true, kind: 'directory' }
  }
  await unlink(target)
  return { path: target, deleted: true, kind: 'file' }
}

/** Require an absolute local path. */
export function requireLocalTarget (target) {
  if (typeof target !== 'string' || target === '') throw codedError('path is required', 'FS_INVALID')
  if (isRemotePath(target)) throw codedError('path is a remote target, not a local one', 'FS_INVALID')
  if (!isAbsolute(target)) throw codedError('path must be absolute', 'FS_INVALID')
  return target
}

/** The authoritative local workspace root, from the session (never the request). */
export function localRootOf (owner) {
  const root = owner?.policy?.workspaceRoot
    ?? (typeof owner?.session?.header?.cwd === 'string' ? owner.session.header.cwd : undefined)
  if (typeof root !== 'string' || root === '') {
    throw codedError('cannot determine the session workspace root; local rename/delete is disabled', 'FS_PERMISSION_DENIED')
  }
  if (isRemotePath(root)) {
    throw codedError('the session workspace is remote; a local path cannot belong to it', 'FS_PERMISSION_DENIED')
  }
  return root
}

/** Prove the target's parent directory resolves inside the root. */
export async function assertLocalParentInside (realRoot, target) {
  const realParent = await realpath(dirname(target))
  if (!isWithinLocalRoot(realRoot, realParent)) {
    throw codedError(`cannot mutate "${target}": its directory resolves outside ${realRoot}`, 'FS_OUTSIDE_WORKSPACE')
  }
}

/**
 * Build the entry route descriptors.
 *
 */
export function entryRoutes ({ engine, router, ctx, guard }) {
  return [
    {
      kind: 'exact',
      path: ROUTES.ls,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const alias = queryParam(url, 'alias')
        let path = queryParam(url, 'path') ?? ''
        if (alias === undefined || alias === '') {
          writeJson(res, 400, { error: 'alias query parameter is required' })
          return
        }
        if (path !== '' && !path.startsWith('/')) {
          writeJson(res, 400, { error: `path must be absolute: ${JSON.stringify(path)}` })
          return
        }
        const limit = parseLimit(queryParam(url, 'limit'))
        if (limit === undefined) {
          writeJson(res, 400, { error: `limit must be a positive integer, at most ${LS_MAX_LIMIT}` })
          return
        }
        // `dirs=1` keeps only subdirectories — the two pickers that consume
        // this route can only enter a directory, so a file is a row they can
        // neither use nor act on. The filter runs BEFORE the cap on purpose:
        // applying it in the browser would leave `total` counting files, and a
        // chooser that says "2000 of 4213" about a list of three directories is
        // worse than no number at all. Anything but `1` is refused rather than
        // read as false, for the same reason a bad `limit` is: a typo must not
        // look deliberate.
        const dirsOnly = queryParam(url, 'dirs')
        if (dirsOnly !== undefined && dirsOnly !== '1') {
          writeJson(res, 400, { error: 'dirs must be 1 when present' })
          return
        }
        // Whether an upload into THIS directory would pass the mount fence.
        //
        // `writable` is the SSH account's own permission, and it is a different
        // question from whether this deployment will accept a write here.
        // Without this flag the browser offered an upload button in every
        // directory it could list — including the SSH login directory, which is
        // usually outside every mounted root — so the gesture completed, the
        // request was correctly refused with a 403, and the user learned about
        // the fence only AFTER picking a file. The panel still cannot upload
        // there; it can now say so BEFORE the picker opens.
        //
        // Computed from the same `writeFenceRoots` the upload route applies, so
        // the two cannot disagree about where a write is allowed. A fence that
        // cannot answer reports the permissive default: this flag only ever
        // SUPPRESSES a control, and a throw here must not hide an upload that
        // the route would have accepted.
        const isUploadable = (target) => {
          try {
            return isWithinRemoteRoots(writeFenceRoots(router.roots, { alias }), { alias, remotePath: target })
          } catch { return true }
        }
        try {
          // The pickers (`dirs=1`) are the hot path, and they only need NAMES.
          // One `ls` answers them in a single round trip, with the cap applied
          // remotely; SFTP is the fallback when that answer does not have the
          // expected shape (and the only path for full listings).
          if (dirsOnly === '1') {
            const fast = await listDirectoriesInOneRoundTrip(engine, alias, path, limit)
            if (fast !== null) {
              path = fast.path
              writeJson(res, 200, {
                path,
                // Names only: the pickers render an icon and a name, and the
                // listing above deliberately fetched nothing else. Size and
                // mtime of a directory row were never shown to anyone.
                entries: fast.names.map(name => ({ name, type: 'directory', size: 0, mtime: 0 })),
                total: fast.total,
                truncated: fast.total > fast.names.length,
                limit,
                writable: fast.writable,
                uploadable: isUploadable(path),
              })
              return
            }
          }

          const listing = await engine.withSftp(alias, async (sftp) => {
            // No path 鈫?the SSH login directory. Echoed back so the client can
            // display (and mount) a real absolute path.
            if (path === '') path = await sftpRealpath(sftp, '.')
            const raw = await new Promise((resolve, reject) => {
              sftp.readdir(path, (err, list) => { if (err) reject(err); else resolve(list) })
            })
            const all = raw.map(entry => ({
              name: entry.filename,
              type: entry.attrs.isDirectory() ? 'directory'
                : entry.attrs.isSymbolicLink() ? 'symlink'
                : 'file',
              size: entry.attrs.size,
              mtime: entry.attrs.mtime,
            })).filter(entry => dirsOnly !== '1' || entry.type === 'directory')
            // Truncation is announced, never silent: a listing that quietly
            // stopped at 500 would look complete, and the directory the user
            // wants may be the one that fell off the end. `total` is what makes
            // the panel able to say "500 of 4213".
            if (all.length <= limit) return { entries: all, total: all.length, truncated: false }
            const kept = all.slice().sort(compareForTruncation).slice(0, limit)
            return { entries: kept, total: all.length, truncated: true }
          })
          // The client warns on unwritable targets. Fail open: only a clean
          // exit status may report unwritable, a broken probe never may.
          let writable = true
          try {
            // Read-only probe: replaying it cannot repeat a side effect.
            const probe = await engine.exec(alias, `test -w ${shellQuote(path)}`, { timeoutMs: 10_000, replay: 'safe' })
            if (probe.exitCode !== null) writable = probe.exitCode === 0
          } catch { /* fail open */ }
          writeJson(res, 200, {
            path,
            entries: listing.entries,
            total: listing.total,
            truncated: listing.truncated,
            limit,
            writable,
            uploadable: isUploadable(path),
          })
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---- recent commits of one Session's working directory
    //
    // Read-only, and the only inputs are a Session id and a row limit: the
    // directory is resolved from the Host's Session record (see
    // lib/git-history.js), so this endpoint cannot be turned into "run git in a
    // path the caller names". A non-repository and an empty repository are
    // 200 answers with `notRepository` / an empty list — states, not failures —
    // because the strip under the change-request panel renders them as one grey
    // line rather than an error. Everything else is a 400 with the module's
    // readable message, matching the rest of this route family.
    {
      kind: 'exact',
      path: ROUTES.gitHistory,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        // Each service is resolved lazily and defensively: a deployment that
        // composes none of them still answers with a readable 400 instead of
        // rejecting out of a GET.
        const service = (name) => {
          try { return ctx?.get?.(name) } catch { return undefined }
        }
        const result = await readGitHistory(
          {
            subprocess: service('subprocess'),
            sessions: service('sessions'),
            workingDirectory: service('workingDirectory'),
            sessionQuery: service('sessionQuery'),
          },
          {
            sessionId: queryParam(url, 'session'),
            limit: queryParam(url, 'limit'),
          },
        )
        if (result.ok !== true) {
          writeJson(res, 400, { error: result.message, code: result.code })
          return
        }
        writeJson(res, 200, {
          commits: result.commits,
          truncated: result.truncated === true,
          ...(result.notRepository === true ? { notRepository: true } : {}),
          // The directory the rows came from. Shown as a tooltip at most; it is
          // the same value the Session already reports everywhere else.
          cwd: result.cwd,
          world: result.world,
        })
      },
    },
    // ---- the mutation mode, for enabling/disabling the UI
    {
      kind: 'exact',
      path: ROUTES.mutationPolicy,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const sessionId = trimmedParam(url, 'sessionId')
        const root = trimmedParam(url, 'root')
        const resolved = mutationContextOf(ctx, { sessionId, root })
        writeJson(res, 200, {
          sessionId: resolved.session?.id ?? null,
          sessionFound: resolved.session !== undefined,
          mode: resolved.mode ?? null,
          readOnly: resolved.mode === 'read-only',
        })
      },
    },
    // ---- rename one entry (remote or local)
    {
      kind: 'exact',
      path: ROUTES.rename,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === null) { writeJson(res, 400, { error: 'invalid JSON body' }); return }
        try {
          const outcome = isRemotePath(body?.path)
            ? await renameRemoteEntry(engine, router, ctx, body)
            : await renameLocalEntry(engine, router, ctx, body)
          writeJson(res, 200, { ok: true, ...outcome })
        } catch (error) {
          writeJson(res, statusForActionError(error, 500), { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---- delete one entry (remote or local)
    {
      kind: 'exact',
      path: ROUTES.deleteEntry,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === null) { writeJson(res, 400, { error: 'invalid JSON body' }); return }
        try {
          const outcome = isRemotePath(body?.path)
            ? await deleteRemoteEntry(engine, router, ctx, body)
            : await deleteLocalEntry(engine, router, ctx, body)
          writeJson(res, 200, { ok: true, ...outcome })
        } catch (error) {
          writeJson(res, statusForActionError(error, 500), { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---- create one directory (remote or local)
    {
      kind: 'exact',
      path: ROUTES.mkdir,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === null) { writeJson(res, 400, { error: 'invalid JSON body' }); return }
        try {
          const outcome = isRemotePath(body?.path)
            ? await mkdirRemoteEntry(engine, router, ctx, body)
            : await mkdirLocalEntry(engine, router, ctx, body)
          writeJson(res, 200, { ok: true, ...outcome })
        } catch (error) {
          writeJson(res, statusForActionError(error, 500), { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---- create one empty file (remote or local)
    {
      kind: 'exact',
      path: ROUTES.createFile,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === null) { writeJson(res, 400, { error: 'invalid JSON body' }); return }
        try {
          const outcome = isRemotePath(body?.path)
            ? await createFileRemoteEntry(engine, router, ctx, body)
            : await createFileLocalEntry(engine, router, ctx, body)
          writeJson(res, 200, { ok: true, ...outcome })
        } catch (error) {
          writeJson(res, statusForActionError(error, 500), { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
  ]
}
