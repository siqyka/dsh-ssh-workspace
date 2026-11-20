/**
 * HTTP route family for the remote-workspace plugin browser half.
 *
 * Loopback-only by default: these endpoints mount and unmount workspaces on
 * the host, so LAN-exposed deployments must not serve them. The fence mirrors
 * dsh-ssh's approach — reject any request whose remote address is not a
 * loopback one — and additionally requires the `Host` header to name this
 * server by one of its loopback spellings, so a DNS-rebinding page (which
 * reaches 127.0.0.1 from the browser while sending its own hostname) is
 * refused too. POST endpoints further require a JSON content type: a
 * cross-site HTML form (which can only send text/plain, urlencoded, or
 * multipart, and may craft a text/plain body that parses as JSON) cannot set
 * it, while the plugin's own browser half always does.
 *
 * The `allowLan` config relaxes the fence for LAN deployments (a webserver
 * bound to 0.0.0.0 reached from a LAN browser): the remote address may then be
 * any private-network address (IPv4 RFC1918, IPv6 ULA or link-local), and the
 * `Host` header must name one of THIS machine's own addresses on the listening
 * port (collected from `os.networkInterfaces()`, plus the loopback spellings
 * and the configured `allowedHosts` extras) — so the anti-rebinding property
 * is kept, only its notion of "this server" widens from the loopback
 * interface to the whole machine. Without `allowLan` nothing changes: the
 * refusals keep their historical wording.
 *
 * @module @shiqyka/dsh-ssh-workspace/routes
 */

import os from 'node:os'
import { ownershipSnapshotCopy } from './ownership.js'
import { parseRemotePath } from './protocol.js'
import { shellQuote } from './engine.js'
import { schemeRules } from './passthrough.js'
import { statusProvenance } from './status-provenance.js'
import { readGitHistory } from './git-history.js'
import {
  abortOnClientGone,
  codedError,
  makeGuards,
  queryParam,
  readJsonBody,
  statusForActionError,
  statusForDownloadError,
  trimmedParam,
  writeJson,
} from './routes/kit.js'
import { hostRoutes } from './routes/hosts.js'
import { transferRoutes } from './routes/transfers.js'
import { workspaceRoutes } from './routes/workspaces.js'
import { forwardRoutes } from './routes/forwards.js'

import { probeLocalPort } from './forward.js'
import { DEFAULT_MAX_BYTES, archiveNameOf, downloadTree, downloadTreeAsArchive, fenceUploadTarget, oversizeMessage, remoteParentOf, sftpUnlink, stagingNameOf, transferFile, uploadTree } from './transfer.js'
import { decideConflict, normalizeConflictPolicy } from './conflict-policy.js'
import { planResume, parseResumeRecord, resumeRecord, resumeSidecarName } from './resume.js'
import { compareDigests, findRemoteHasher, hashRemoteFile } from './verify.js'
import { renderSelfCheck, selfCheck } from './capabilities.js'
import { buildSupportBundle } from './support-bundle.js'
import { diagnose, DIAGNOSIS_VERSION } from './diagnosis.js'
import { readFileSync } from 'node:fs'
import { lstat, mkdir, realpath, rename, rm, stat, unlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, join, resolve as resolveLocal } from 'node:path'
import { formatRemotePath, isRemotePath, normalizeRemotePath, remoteDirname, remoteBasename } from './protocol.js'
import { isWithinLocalRoot, mutationNameRefusal, renameTargetPath, rootMutationRefusal } from './mutations.js'
import { sessionPolicyOf, writeModeRefusal } from './mode-gate.js'
import {
  assertWithinRemoteRoots,
  isWithinRemoteRoots,
  sftpCloseHandle,
  sftpLstatOrNull,
  sftpMkdirp,
  sftpMkdirStrict,
  sftpOpenHandle,
  sftpPublishRename,
  sftpReaddir,
  sftpReadHandle,
  sftpRealpathStrict,
  sftpRenameStrict,
  sftpStatOrNull,
  sftpWriteHandle,
  writeFenceRoots,
} from './remote-fs.js'

/** Route path constants. */
export const ROUTES = {
  hosts: '/api/dsh-ssh-workspace/hosts',
  hostSave: '/api/dsh-ssh-workspace/hosts/save',
  hostDelete: '/api/dsh-ssh-workspace/hosts/delete',
  hostForgetKey: '/api/dsh-ssh-workspace/hosts/forget-key',
  hostDisconnect: '/api/dsh-ssh-workspace/hosts/disconnect',
  hostReconnect: '/api/dsh-ssh-workspace/hosts/reconnect',
  test: '/api/dsh-ssh-workspace/test',
  ls: '/api/dsh-ssh-workspace/ls',
  gitHistory: '/api/dsh-ssh-workspace/git-history',
  status: '/api/dsh-ssh-workspace/status',
  mount: '/api/dsh-ssh-workspace/mount',
  unmount: '/api/dsh-ssh-workspace/unmount',
  enable: '/api/dsh-ssh-workspace/enable',
  forward: '/api/dsh-ssh-workspace/forward',
  unforward: '/api/dsh-ssh-workspace/unforward',
  forwardSave: '/api/dsh-ssh-workspace/forward/save',
  forwardToggle: '/api/dsh-ssh-workspace/forward/toggle',
  forwardDelete: '/api/dsh-ssh-workspace/forward/delete',
  forwardRemember: '/api/dsh-ssh-workspace/forward/remember',
  forwardProbe: '/api/dsh-ssh-workspace/forward/probe',
  forwardSettings: '/api/dsh-ssh-workspace/forward/settings',
  transfer: '/api/dsh-ssh-workspace/transfer',
  download: '/api/dsh-ssh-workspace/download',
  upload: '/api/dsh-ssh-workspace/upload',
  // A second door for the same bytes, because the desktop shell's document
  // scheme cannot carry a request BODY that is a Blob: `fetch` from a
  // `dsh-app://` page with `body: file` fails in the network service with
  // `net::ERR_UNEXPECTED` before any handler runs, so the raw route above is
  // unreachable from the packaged app. Plain JSON bodies are what every other
  // panel action already uses, so the file travels in base64 chunks through
  // that proven transport instead.
  uploadChunk: '/api/dsh-ssh-workspace/upload-chunk',
  // Rename (old path + new name) and delete (path) — one pair of routes for
  // BOTH halves of the filesystem seam. The spelling of `path` decides the
  // branch: `ssh://` means SFTP, an absolute local path means `node:fs`.
  rename: '/api/dsh-ssh-workspace/rename',
  deleteEntry: '/api/dsh-ssh-workspace/delete',
  // Create one directory below an existing parent (parent path + name). Like
  // rename/delete, the spelling of `path` decides the branch: `ssh://` means
  // SFTP, an absolute local path means the session's own workspace root.
  mkdir: '/api/dsh-ssh-workspace/mkdir',
  // Read-only, for the UI to DISABLE rename/delete before the click rather
  // than after the refusal. It answers the mode for a session/root and never
  // mutates anything.
  mutationPolicy: '/api/dsh-ssh-workspace/mutation-policy',
  // A whole remote directory as ONE tar file. Separate from `download` because
  // the answer differs in a way the client must be able to tell apart: a
  // directory is streamed as an archive rather than refused, and the archive's
  // name comes from the directory, not from a file inside it.
  downloadTree: '/api/dsh-ssh-workspace/download-tree',
  // The diagnostic report is a GET on purpose: it reads and formats, it never
  // mutates, so a link the user can open in a browser is the natural shape —
  // and a GET cannot be forged from a cross-site form the way a POST can.
  supportBundle: '/api/dsh-ssh-workspace/support-bundle',
  // The remote self-check for one host. A GET for the same reason, plus it is
  // the one surface a user may want to open directly to read the report.
  selfCheck: '/api/dsh-ssh-workspace/self-check',
  // The two local-passthrough settings (`scheme`, `remoteMissFallback`). Kept
  // apart from the forward settings: they answer different questions, and the
  // panel writes them from a different section.
  passthroughSettings: '/api/dsh-ssh-workspace/passthrough/settings',
}
















/** This package's own version, read once; 'unknown' when it cannot be read. */
let pluginVersionCache
function pluginVersion () {
  if (pluginVersionCache === undefined) {
    try {
      const here = dirname(fileURLToPath(import.meta.url))
      pluginVersionCache = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version ?? 'unknown'
    } catch {
      pluginVersionCache = 'unknown'
    }
  }
  return pluginVersionCache
}

/**
 * The DSH version this plugin is running under, when the Host exposes it.
 *
 * Deliberately best-effort and deliberately not a peer requirement: a
 * deployment that cannot answer yields 'unknown', and the bundle says so. The
 * alternative — refusing to build a bundle without it — would make the most
 * useful diagnostic the one that cannot run on the broken deployment.
 *
 * @param {object} ctx - the plugin context.
 * @returns {string} the version, or 'unknown'.
 */
function hostVersion (ctx) {
  try {
    const meta = ctx?.get?.('runtimeMeta') ?? ctx?.get?.('version')
    if (typeof meta === 'string' && meta !== '') return meta
    if (typeof meta?.version === 'string' && meta.version !== '') return meta.version
  } catch { /* no such service */ }
  return 'unknown'
}



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
const UNMOUNT_MODES = new Set(['detach', 'deregister', 'forget'])

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
 * Directories come first, then names, compared by code unit. Code-unit order
 * rather than `localeCompare` on purpose: the cut-off has to be the same on
 * every machine and in every process locale, and a listing whose 500th entry
 * depends on the ICU build is a listing that hides a different file each time.
 * The panel re-sorts what it receives by its own rule, so this ordering is not
 * a presentation decision — only a decision about what survives the cap.
 *
 * @param {{type: string, name: string}} a - left entry.
 * @param {{type: string, name: string}} b - right entry.
 * @returns {number} comparator result.
 */
function compareForTruncation (a, b) {
  if (a.type === 'directory' && b.type !== 'directory') return -1
  if (a.type !== 'directory' && b.type === 'directory') return 1
  if (a.name < b.name) return -1
  if (a.name > b.name) return 1
  return 0
}

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
 * @param {string} path - absolute directory, or '' for the login directory.
 * @param {number} limit - how many names may be returned.
 * @returns {string} the shell command.
 */
export function dirsListingCommand (path, limit) {
  const dirLine = path === '' ? 'dir=$(pwd -P) || exit 1' : `dir=${shellQuote(path)}`
  return [
    dirLine,
    `if [ ! -d "$dir" ] || [ ! -r "$dir" ] || [ ! -x "$dir" ]; then printf '%s fallback\\n' ${LS_DIRS_MARKER} >&2; exit 0; fi`,
    'w=0',
    'test -w "$dir" && w=1',
    'export LC_ALL=C',
    'export LS_DIR="$dir"',
    // `-p` appends `/` to directories only, so symlinks (which the SFTP route
    // also treats as non-enterable) and files never reach the parser. `-a`
    // keeps dot-directories, which the SFTP listing has always included.
    `ls -1ap "$dir" 2>/dev/null | awk -v lim=${limit} -v w="$w" -v mark=${LS_DIRS_MARKER} '`,
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
 * @param {object} outcome - `engine.exec`'s outcome.
 * @param {number} limit - the same limit the command was built with.
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
 * @param {object} engine - the SSH engine.
 * @param {string} alias - host alias.
 * @param {string} path - absolute directory, or '' for the login directory.
 * @param {number} limit - how many entries may be returned.
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

/**
 * Resolve the unmount mode from a request body.
 *
 * Two spellings are honoured so the documented mode name and the older
 * `deregister` boolean cannot disagree silently: an explicit `mode` wins, and
 * otherwise `deregister: true` means "deregister" while its default means
 * "detach". Detach is the safe default — it is the only mode that keeps the
 * workspace record and the archived sessions recoverable in one click.
 *
 * `forget` is accepted as an alias of `deregister` rather than a third mode:
 * both delete the record, and the difference the old `forget` had (clearing the
 * detached mark) is now what `deregister` does too, because a record that is
 * gone everywhere must not leave a re-enable button behind.
 *
 * @param {object | null} body - the parsed request body.
 * @returns {'detach' | 'deregister'} the mode.
 */
function normalizeUnmountMode (body) {
  const requested = typeof body?.mode === 'string' ? body.mode.trim() : ''
  if (requested === 'detach') return 'detach'
  if (UNMOUNT_MODES.has(requested)) return 'deregister'
  return body?.deregister === true ? 'deregister' : 'detach'
}

/**
 * Archive every session accounted by one workspace.
 *
 * Archiving is registry-native: the session disappears from every grouping
 * surface, its file is untouched, and `unarchiveSession` restores it to its
 * recorded position. No other plugin is involved and nothing on disk is
 * unlinked.
 *
 * Failures are collected per session rather than aborting the batch: a session
 * with running work is refused by the registry (that is the documented
 * behaviour without `stopActivity`), and the user should still get the other
 * sessions archived plus a precise account of what was left.
 *
 * @param {object | undefined} registry - the workspace registry, when mounted.
 * @param {object | undefined} entity - the workspace entity.
 * @returns {Promise<{ok: string[], failed: Array<{sessionId: string, error: string}>}>} the outcome.
 */
async function archiveWorkspaceSessions (registry, entity) {
  const ok = []
  const failed = []
  if (entity === undefined || typeof registry?.archiveSession !== 'function') return { ok, failed }
  // `sessionIds` is already filtered by the registry to the sessions it still
  // considers members, so this cannot archive a detached orphan.
  for (const sessionId of entity.sessionIds ?? []) {
    try {
      await registry.archiveSession(sessionId)
      ok.push(sessionId)
    } catch (error) {
      failed.push({ sessionId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { ok, failed }
}

/**
 * Unarchive every session accounted by one workspace.
 *
 * @param {object | undefined} registry - the workspace registry, when mounted.
 * @param {object | undefined} entity - the workspace entity.
 * @returns {Promise<{ok: string[], failed: Array<{sessionId: string, error: string}>}>} the outcome.
 */
async function unarchiveWorkspaceSessions (registry, entity) {
  const ok = []
  const failed = []
  if (entity === undefined || typeof registry?.unarchiveSession !== 'function') return { ok, failed }
  for (const sessionId of entity.sessionIds ?? []) {
    try {
      await registry.unarchiveSession(sessionId)
      ok.push(sessionId)
    } catch (error) {
      failed.push({ sessionId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { ok, failed }
}

/**
 * Route family dependencies.
 * @typedef {object} RouteDeps
 * @property {import('./engine.js').SshWorkspaceEngine} engine
 * @property {import('./remote-fs.js').RemoteFileSystem} router
 * @property {import('./forward.js').ForwardManager} forwards
 * @property {import('./reverse-forward.js').ReverseForwardManager} [reverseForwards]
 * @property {import('./forward-persist.js').SavedForwardManager} [savedForwards]
 * @property {import('@deepseek-ai/cordis').Context} ctx
 * @property {boolean} [allowLan] - serve LAN browsers: accept private-network
 *   remote addresses and Host headers naming this machine's own addresses
 *   (default false — loopback only).
 * @property {string[]} [allowedHosts] - extra `Host` values accepted in
 *   addition to the machine's own addresses; used with `allowLan`.
 */

/**
 * The access policy one route set enforces.
 *
 * @typedef {object} AccessPolicy
 * @property {boolean} allowLan - whether private-network origins are admitted.
 * @property {string[]} allowedHosts - normalized (lowercase, trimmed) extra Host values.
 */



/**
 * Build every /api/dsh-ssh-workspace route.
 *
 * @param {RouteDeps} deps - engine, router, forwards, cordis context.
 * @returns {Array<object>} route descriptors for ctx.webServer.register().
 */
export function makeRoutes (deps) {
  const { engine, router, forwards, reverseForwards, savedForwards, passthroughSettings, shells, remoteSkills, ctx } = deps

  const accessPolicy = {
    allowLan: deps.allowLan === true,
    allowedHosts: (Array.isArray(deps.allowedHosts) ? deps.allowedHosts : [])
      .filter(entry => typeof entry === 'string' && entry.trim() !== '')
      .map(entry => entry.trim().toLowerCase()),
  }

  // The fence, the method check and the media-type check, built together so the
  // two byte-streaming endpoints cannot re-derive them. See routes/kit.js.
  const { guard, guardRaw, refuseUnlessAllowed } = makeGuards(accessPolicy)

  /**
   * How long the host may take to receive one upload.
   *
   * Two hours rather than "no deadline": the plugin's own ceiling is 1 GiB, and
   * two hours carries that at ~150 KB/s, while still bounding a peer that stops
   * sending without closing.
   */
  const UPLOAD_REQUEST_TIMEOUT_MS = 2 * 60 * 60 * 1000

  /**
   * The node HTTP server behind this request, if it can be identified.
   *
   * The request itself is the reliable source: node sets `socket.server` on
   * every accepted connection, so `res.socket.server` IS the `http.Server` that
   * will apply the deadline to this request — no guessing at the host's
   * service shape, and the same object whatever the deployment calls its web
   * server. The service lookup is a second attempt for deployments where the
   * socket path is not a plain http server (a TLS terminator in front, for
   * instance); the field names there are the plausible ones, and a host that
   * exposes none of them leaves the deadline untouched.
   *
   * A candidate counts only if it is actually a server: node keeps
   * `requestTimeout` as an own property and any server answers `setTimeout`.
   *
   * @param {object} res - the response being written.
   * @returns {object|undefined} the server, or undefined when none is reachable.
   */
  const httpServerOf = (res) => {
    const candidates = []
    try { candidates.push(res?.socket?.server) } catch { /* exotic response object */ }
    try {
      const service = ctx?.get?.('webServer')
      if (service !== null && service !== undefined && typeof service === 'object') {
        for (const field of ['server', 'httpServer', 'nodeServer', '_server', 'listener']) candidates.push(service[field])
      }
    } catch { /* no web server in this deployment */ }
    for (const candidate of candidates) {
      if (candidate !== null && candidate !== undefined
        && typeof candidate === 'object'
        && typeof candidate.setTimeout === 'function'
        && 'requestTimeout' in candidate) return candidate
    }
    return undefined
  }

  /**
   * Relax the host's whole-request deadline while an upload body is arriving.
   *
   * The DSH web server builds `node:http` with its default options, so
   * `requestTimeout` is 300 000 ms — a deadline on receiving the ENTIRE
   * request, not on idleness. A browser sending a large file is therefore cut
   * off mid-body once five minutes have passed, and reports it as
   * `TypeError: Failed to fetch`, which names neither the size nor the
   * deadline. 1 GiB on the loopback interface alone takes about three minutes,
   * so any slower link or larger file was guaranteed to fail this way.
   *
   * The actual cut-off is later than the deadline: node checks its connections
   * every `connectionsCheckingInterval` (30 s by default), so the break lands
   * between 300 and 330 s.
   *
   * The value is raised only while at least one upload is reading its body and
   * restored when the last one finishes, so the host keeps its slow-request
   * protection for every other route and outside those windows.
   *
   * The raise reaches the request that is already in flight because node
   * re-reads `server.requestTimeout` on every check, not once per connection.
   * Measured on this node with a 100 ms check interval: the control request
   * was answered `408` at the 300 ms deadline, and the same request survived
   * to completion once the value was raised mid-body.
   *
   * Everything degrades to a no-op: a host that hides the server, or one whose
   * deadline is already longer or disabled, is left exactly as it was — writing
   * a number over a disabled deadline would impose a limit that was
   * deliberately absent.
   *
   * @param {object} res - the response being written (see `httpServerOf`).
   * @returns {() => void} closes this window; safe to call more than once.
   */
  const uploadWindows = { open: 0, saved: undefined, server: undefined }
  const openUploadWindow = (res) => {
    // Already inside a window: JOIN it instead of re-measuring. The second
    // upload would otherwise read the value WE raised (which is at or above the
    // target), decide there is nothing to do, and return without registering —
    // so the first one's release would drop the counter to zero and restore the
    // host's deadline while the second was still receiving.
    if (uploadWindows.open > 0) {
      uploadWindows.open += 1
      return once(closeUploadWindow)
    }
    const server = httpServerOf(res)
    if (server === undefined) return () => {}
    const current = server.requestTimeout
    // `0` means the host disabled the deadline, and a value at or above ours
    // leaves nothing to raise. Neither needs a window: their state is already
    // what an upload wants, and touching it could only make it worse.
    if (typeof current !== 'number' || current === 0 || current >= UPLOAD_REQUEST_TIMEOUT_MS) return () => {}
    uploadWindows.saved = current
    uploadWindows.server = server
    uploadWindows.open = 1
    try { server.requestTimeout = UPLOAD_REQUEST_TIMEOUT_MS } catch { /* frozen host object */ }
    return once(closeUploadWindow)
  }

  /** A release that acts at most once, so a double call cannot close someone else's window. */
  function once (release) {
    let closed = false
    return () => {
      if (closed) return
      closed = true
      release()
    }
  }

  /** Leave one upload's window; the last one out restores the host deadline. */
  function closeUploadWindow () {
    if (uploadWindows.open > 0) uploadWindows.open -= 1
    if (uploadWindows.open > 0) return
    const restore = uploadWindows.saved
    const target = uploadWindows.server
    uploadWindows.saved = undefined
    uploadWindows.server = undefined
    if (restore === undefined || target === undefined) return
    try { target.requestTimeout = restore } catch { /* frozen host object */ }
  }

  // The one place the status route and the report route both read the world
  // from, so the panel's dot and the pasted report cannot disagree about what
  // the plugin can see. Deliberately NOT a probe: both callers are reads, and
  // a status poll that dialled every host would make "how are things?" itself
  // observable network traffic.
  const diagnosisInput = () => {
    // Every read is defended: this runs on a status poll against whatever
    // engine a deployment assembled, and a missing optional collaborator must
    // degrade to "not reported" rather than throw out of a GET.
    let listing
    try {
      listing = engine.store?.listing?.() ?? { rows: engine.store?.rows?.() ?? [], skipped: [] }
    } catch {
      listing = { rows: [], skipped: [] }
    }
    const probed = []
    try {
      for (const alias of new Set([
        ...(engine.pool?.keys?.() ?? []),
        ...(engine.capabilities?.keys?.() ?? []),
        ...router.listRoots().map(path => parseRemotePath(path)?.alias).filter(Boolean),
      ])) {
        const tools = engine.capabilities?.get?.(alias)
        if (tools === undefined) continue
        probed.push({ alias, tools, environment: engine.environmentOf?.(alias) ?? {} })
      }
    } catch { /* probe cache unavailable — the report stands without it */ }
    return {
      generatedAt: Date.now(),
      pluginVersion: pluginVersion(),
      hostVersion: hostVersion(ctx),
      nodeVersion: process.version,
      platform: `${process.platform}-${process.arch}`,
      upstreamWorkarounds: engine.upstreamWorkarounds ?? [],
      seams: engine.seams ?? [],
      // In-memory snapshot of the last session-ownership re-claim. Read here
      // rather than recomputed: this runs on every status poll, and listing
      // persisted sessions to answer "how are things?" would be disk traffic
      // disguised as a read.
      ...(engine.ownership === undefined ? {} : { ownership: ownershipSnapshotCopy(engine.ownership) }),
      events: engine.diagnostics?.list(20) ?? [],
      hosts: listing.rows ?? [],
      hostsSkipped: listing.skipped ?? [],
      ...(listing.storeError === undefined ? {} : { storeError: listing.storeError }),
      mounted: router.listRoots(),
      disabled: router.listDisabled(),
      connections: [...(engine.pool?.entries?.() ?? [])].map(([alias, record]) => ({
        alias,
        state: record.broken ? 'broken' : 'connected',
        inFlight: record.inFlight,
        generation: record.generation ?? 0,
      })),
      reconnecting: engine.reconnector?.list?.() ?? [],
      forwards: forwards.list(),
      ...(savedForwards === undefined ? {} : { forwardRows: savedForwards.list() }),
      capabilities: probed,
      commands: engine.audit?.list?.(50) ?? [],
      unpinnedHostKeys: (engine.unpinnedHostKeyRows?.() ?? []).map(entry => ({
        alias: entry.alias,
        keyType: entry.keyType,
        fingerprint: entry.fingerprint,
      })),
    }
  }

  return [
    // ---- hosts (store, pool, host key)
    ...hostRoutes({ engine, forwards, savedForwards, guard }),
    // ---- remote directory listing
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
    // ---- mount status
    ...workspaceRoutes({ engine, router, forwards, reverseForwards, savedForwards, passthroughSettings, shells, remoteSkills, ctx, guard, diagnosisInput, normalizeUnmountMode, archiveWorkspaceSessions, unarchiveWorkspaceSessions }),
    // ---- open port forward
    ...forwardRoutes({ forwards, reverseForwards, savedForwards, passthroughSettings, guard }),
    // ---- move a file between this machine and a host
    ...transferRoutes({ engine, router, guard, guardRaw, openUploadWindow }),
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
  ]
}

/**
 * Read a service without declaring it in the plugin's static inject list.
 *
 * The mutation routes need `sessions` (the authoritative owner of a workspace
 * root) and `sandboxPolicy`/`sessionProjections` (the read-only mode). None of
 * those are required for the plugin's agent tools, and requiring them at load
 * would make a deployment that merely lacks the browser half fail to mount.
 * Cordis' `get` is the documented reader; the property fallback keeps older
 * builds working. A throwing lookup is absent, not fatal.
 *
 * @param {object} ctx - plugin context.
 * @param {string} name - service name.
 * @returns {object | undefined} the service, when composed.
 */
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
 * @param {object} ctx - plugin context.
 * @param {object} body - the decoded request.
 * @returns {{session: object | undefined, policy: object | undefined, mode: string | undefined}} the resolution.
 */
function mutationContextOf (ctx, body) {
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
 * @param {unknown} left - a session's recorded cwd.
 * @param {unknown} right - the request's root selector.
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
 * @param {object} ctx - plugin context.
 * @param {object} body - the request.
 * @param {string} target - the display path, for the refusal text.
 * @param {string} verb - `rename` or `delete`.
 * @returns {{session: object, policy: object | undefined, mode: string | undefined}} the resolved owner.
 * @throws {Error} `FS_SANDBOX_DENIED` or `FS_PERMISSION_DENIED`.
 */
function assertMutationAllowed (ctx, body, target, verb) {
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
 * @param {unknown} target - the request's `path`.
 * @returns {{alias: string, remotePath: string, displayPath: string}} the parts.
 * @throws {Error} `FS_INVALID` when the spelling is malformed.
 */
function requireRemoteParts (target) {
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
 * @param {object | undefined} router - the filesystem router.
 * @param {{alias: string, remotePath: string, displayPath: string}} parts - the target.
 * @throws {Error} `FS_PERMISSION_DENIED` / `FS_OUTSIDE_WORKSPACE`.
 */
function assertRemoteFence (router, parts) {
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
 * @param {any} sftp - the SFTP channel.
 * @param {object} router - the filesystem router.
 * @param {{alias: string, remotePath: string}} parts - the target.
 * @returns {Promise<void>} resolves once the parent is proven inside.
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
 * Delete one remote entry, recursing into directories and NEVER following a
 * symlink.
 *
 * `readdir` lists names; each child is lstat'd before deciding whether to
 * descend. A recursive delete that trusted `readdir`'s dirent type would treat
 * a symlink-to-directory as a directory on servers that report the link target,
 * walking into a tree outside the fence to delete it. lstat is the guard.
 *
 * @param {any} sftp - the SFTP channel.
 * @param {string} target - normalized absolute remote path.
 * @param {string} displayPath - the spelling shown in errors.
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
 * @param {object} ctx - plugin context.
 * @param {object} body - `{path, name, sessionId?, root?}`.
 * @returns {Promise<{path: string, created: true}>} the child that was made.
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
function requireLocalTarget (target) {
  if (typeof target !== 'string' || target === '') throw codedError('path is required', 'FS_INVALID')
  if (isRemotePath(target)) throw codedError('path is a remote target, not a local one', 'FS_INVALID')
  if (!isAbsolute(target)) throw codedError('path must be absolute', 'FS_INVALID')
  return target
}

/** The authoritative local workspace root, from the session (never the request). */
function localRootOf (owner) {
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
async function assertLocalParentInside (realRoot, target) {
  const realParent = await realpath(dirname(target))
  if (!isWithinLocalRoot(realRoot, realParent)) {
    throw codedError(`cannot mutate "${target}": its directory resolves outside ${realRoot}`, 'FS_OUTSIDE_WORKSPACE')
  }
}


