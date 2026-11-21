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
import { ownershipSnapshotCopy } from '../ownership.js'
import { parseRemotePath } from '../protocol.js'
import { shellQuote } from '../engine.js'
import { schemeRules } from '../passthrough.js'
import { statusProvenance } from '../status.js'
import { readGitHistory } from '../git-history.js'
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
} from './kit.js'
import { hostRoutes } from './hosts.js'
import { entryRoutes } from './entries.js'
import { transferRoutes } from './transfers.js'
import { workspaceRoutes } from './workspaces.js'
import { forwardRoutes } from './forwards.js'

import { probeLocalPort } from '../forward.js'
import { DEFAULT_MAX_BYTES, archiveNameOf, downloadTree, downloadTreeAsArchive, fenceUploadTarget, oversizeMessage, remoteParentOf, sftpUnlink, stagingNameOf, transferFile, uploadTree } from '../transfer.js'
import {
  compareDigests, decideConflict, findRemoteHasher, hashRemoteFile,
  normalizeConflictPolicy, parseResumeRecord, planResume, resumeRecord, resumeSidecarName,
} from '../transfer-rules.js'
import { renderSelfCheck, selfCheck } from '../capabilities.js'
import { buildSupportBundle, diagnose, DIAGNOSIS_VERSION } from '../report.js'
import { readFileSync } from 'node:fs'
import { lstat, mkdir, realpath, rename, rm, stat, unlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, join, resolve as resolveLocal } from 'node:path'
import { formatRemotePath, isRemotePath, normalizeRemotePath, remoteDirname, remoteBasename } from '../protocol.js'
import { isWithinLocalRoot, mutationNameRefusal, renameTargetPath, rootMutationRefusal } from '../transfer-rules.js'
import { sessionPolicyOf, writeModeRefusal } from '../mode-gate.js'
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
} from '../remote-fs.js'

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
      pluginVersionCache = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')).version ?? 'unknown'
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
 */
function hostVersion (ctx) {
  try {
    const meta = ctx?.get?.('runtimeMeta') ?? ctx?.get?.('version')
    if (typeof meta === 'string' && meta !== '') return meta
    if (typeof meta?.version === 'string' && meta.version !== '') return meta.version
  } catch { /* no such service */ }
  return 'unknown'
}

/** The mode names that all mean "delete the record". */
const UNMOUNT_MODES = new Set(['detach', 'deregister', 'forget'])

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
 * @property {import('../engine.js').SshWorkspaceEngine} engine
 * @property {import('../remote-fs.js').RemoteFileSystem} router
 * @property {import('../forward.js').ForwardManager} forwards
 * @property {import('../forward.js').ReverseForwardManager} [reverseForwards]
 * @property {import('../forward.js').SavedForwardManager} [savedForwards]
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
    // ---- mount status, self-check, support bundle, mount / unmount / enable
    ...workspaceRoutes({ engine, router, forwards, reverseForwards, savedForwards, passthroughSettings, shells, remoteSkills, ctx, guard, diagnosisInput, normalizeUnmountMode, archiveWorkspaceSessions, unarchiveWorkspaceSessions }),
    // ---- open port forward, saved mappings, passthrough settings
    ...forwardRoutes({ forwards, reverseForwards, savedForwards, passthroughSettings, guard }),
    // ---- move a file between this machine and a host
    ...transferRoutes({ engine, router, guard, guardRaw, openUploadWindow }),
    // ---- remote directory listing, git history, rename / delete / mkdir
    ...entryRoutes({ engine, router, ctx, guard }),
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
 * @returns {object | undefined} the service, when composed.
 */
