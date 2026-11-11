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
import { parseRemotePath } from './protocol.js'
import { shellQuote } from './engine.js'
import { statusProvenance } from './status-provenance.js'

/**
 * The oldest cached capability probe, as `{at}`.
 *
 * A capability section is only as fresh as its STALEST row: labelling it by the
 * newest would tell the user a tool verdict taken ten minutes ago is current
 * because some other host was probed a second ago.
 *
 * The engine's cache stores the probe result; `at` is read defensively because a
 * probe that predates this field would otherwise look like "stored at epoch 0"
 * and report an absurd age.
 *
 * @param {object} engine - the SSH engine.
 * @returns {{at: number}|undefined} the oldest stamp, when any exists.
 */
function oldestProbe (engine) {
  const cache = engine?.capabilities
  if (cache === undefined || typeof cache.keys !== 'function') return undefined
  let oldest
  for (const alias of cache.keys()) {
    const entry = cache.get(alias)
    const at = typeof entry?.at === 'number' ? entry.at : undefined
    if (at === undefined) continue
    if (oldest === undefined || at < oldest) oldest = at
  }
  return oldest === undefined ? undefined : { at: oldest }
}
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
}

/**
 * Check whether a request originated on the loopback interface.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {boolean} true when the remote address is loopback.
 */
function isLoopbackRequest (req) {
  const addr = req.socket?.remoteAddress ?? req.connection?.remoteAddress ?? ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === 'localhost'
}

/**
 * Check the request's `Host` header against the loopback names of the port
 * this server actually listens on.
 *
 * A loopback `remoteAddress` alone still lets a public page reach these
 * endpoints: a DNS-rebinding attack re-resolves an attacker-controlled
 * hostname to 127.0.0.1, and the browser then treats the request as
 * same-origin. Requiring the Host the browser sent to be one of the
 * loopback spellings of the listening port closes that path — a rebound
 * page's requests carry its own hostname and are refused here.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {boolean} true when the Host header names this loopback server.
 */
function isLoopbackHostHeader (req) {
  const port = req.socket?.localPort
  const host = req.headers?.host
  if (typeof host !== 'string' || host === '' || !Number.isInteger(port)) return false
  const allowed = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`])
  return allowed.has(host.toLowerCase())
}

/**
 * Unwrap the IPv4-mapped IPv6 spelling of an address.
 *
 * A socket may report `::ffff:192.168.1.10` for an IPv4 peer; the network
 * classes below are defined per family, so the mapped form is reduced to its
 * IPv4 part before classification.
 *
 * @param {string} address - the raw socket address.
 * @returns {string | undefined} the embedded IPv4 address, when present.
 */
function mappedIpv4Of (address) {
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(address)
  return match === null ? undefined : match[1]
}

/**
 * Check whether an address is a loopback spelling, mapped forms included.
 *
 * @param {string} address - the raw socket address (may carry an IPv6 zone suffix).
 * @returns {boolean} true when the address names this host itself.
 */
function isLoopbackAddress (address) {
  const bare = address.split('%', 1)[0]
  if (bare === '127.0.0.1' || bare === '::1' || bare === 'localhost') return true
  return mappedIpv4Of(bare) === '127.0.0.1'
}

/**
 * Check whether an IPv4 address is in one of the RFC1918 private ranges.
 *
 * @param {string} address - a dotted-quad IPv4 address.
 * @returns {boolean} true for 10/8, 172.16/12 and 192.168/16.
 */
function isRfc1918 (address) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(address)
  if (match === null) return false
  const first = Number(match[1])
  const second = Number(match[2])
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
}

/**
 * Check whether an address belongs to a private network.
 *
 * `allowLan` accepts exactly these (plus loopback) as request origins:
 * addresses the public internet cannot route to — IPv4 RFC1918, IPv6 unique
 * local (fc00::/7) and IPv6 link-local (fe80::/10). A public address is still
 * refused: those endpoints mount workspaces and move credentials, and a
 * loopback-or-private rule keeps them off the open internet even when the
 * webserver is bound wide.
 *
 * @param {string} address - the raw socket address (may carry an IPv6 zone suffix).
 * @returns {boolean} true when the address is a private-network one.
 */
function isPrivateNetworkAddress (address) {
  const bare = address.split('%', 1)[0].toLowerCase()
  const v4 = mappedIpv4Of(bare) ?? bare
  if (isRfc1918(v4)) return true
  // fc00::/7 — hex first byte fc..fd; fe80::/10 — first byte fe80..febf.
  // The first hextet of either range always spells out four digits (it starts
  // with `f`, so no leading zero could be dropped).
  return /^f[cd][0-9a-f]{2}:/u.test(bare) || /^fe[89ab][0-9a-f]:/u.test(bare)
}

/**
 * Collect the `Host` spellings that name THIS server on the given port.
 *
 * The browser sends as `Host` the address it dialled, so on a LAN deployment
 * that is one of the machine's own interface addresses plus the listening
 * port. The list comes from `os.networkInterfaces()` (every non-internal
 * address, bracketed when IPv6), joined by the loopback spellings the
 * loopback-only mode has always accepted. Because a rebound page must send
 * its own hostname to complete the DNS-rebinding attack, an attacker hostname
 * is still absent from this list — the anti-rebinding property carries over
 * from the loopback fence unchanged.
 *
 * @param {number} port - the port this server actually listens on.
 * @returns {Set<string>} lowercase `Host` header values naming this server.
 */
function serverHostCandidates (port) {
  const allowed = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`])
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const entry of interfaces ?? []) {
      if (entry?.internal === true) continue
      if (typeof entry?.address !== 'string' || entry.address === '') continue
      const address = entry.address
      allowed.add(address.includes(':') ? `[${address.toLowerCase()}]:${port}` : `${address.toLowerCase()}:${port}`)
    }
  }
  return allowed
}

/**
 * Check the request's `Host` header against the machine's own addresses and
 * the configured extras.
 *
 * A configured `allowedHosts` entry matches either verbatim or suffixed with
 * the listening port, so deployments behind a name the machine's interfaces
 * do not know (a LAN hostname, a reverse-proxied spelling) can admit it
 * explicitly without opening the door to every Host value.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {string[]} extraHosts - lowercase `allowedHosts` entries.
 * @returns {boolean} true when the Host header names this server.
 */
function isLanHostHeader (req, extraHosts) {
  const port = req.socket?.localPort
  const host = req.headers?.host
  if (typeof host !== 'string' || host === '' || !Number.isInteger(port)) return false
  const lowered = host.toLowerCase()
  if (serverHostCandidates(port).has(lowered)) return true
  return extraHosts.some(entry => lowered === entry || lowered === `${entry}:${port}`)
}

/**
 * Check the request's `Content-Type` names JSON.
 *
 * Cross-site HTML forms can only send `text/plain`, `urlencoded`, or
 * `multipart` bodies — and a crafted `text/plain` body can still parse as
 * JSON. Requiring the JSON media type on POST endpoints closes that CSRF
 * path without a token; `fetch` with a non-simple content type triggers a
 * CORS preflight this server never approves.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {boolean} true when the declared type (parameters aside) is application/json.
 */
function isJsonContentType (req) {
  return mediaTypeOf(req) === 'application/json'
}

/**
 * Check the request's `Content-Type` names raw bytes.
 *
 * `/upload` carries the file itself as the body, so it cannot demand JSON. It
 * must still demand a media type a cross-site form CANNOT produce:
 * `application/octet-stream` is not one of the three simple types, so a form
 * submission cannot declare it and a `fetch` that does triggers a preflight
 * this server never approves. Before this check the endpoint accepted any
 * content type, which made it the one write path that skipped the CSRF premise
 * every other POST relies on — a `text/plain` form post aimed at 127.0.0.1
 * could write bytes into a mounted workspace.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {boolean} true when the declared type is application/octet-stream.
 */
function isRawContentType (req) {
  return mediaTypeOf(req) === 'application/octet-stream'
}

/**
 * The declared media type without parameters, lowercased.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {string} the type, or '' when absent.
 */
function mediaTypeOf (req) {
  const header = req.headers?.['content-type']
  if (typeof header !== 'string') return ''
  return header.split(';', 1)[0].trim().toLowerCase()
}

/**
 * The HTTP status a failed `/download` should carry.
 *
 * The browser saves whatever body a 2xx response has, so "the file could not
 * be read" has to reach it as a non-2xx status — that is the only signal the
 * download flow honours. Codes come from the `FsError` the read path raises;
 * anything unrecognised is a genuine server-side failure, not a missing file.
 *
 * @param {unknown} error - the failure raised while opening or streaming.
 * @returns {number} the status to answer with.
 */
function statusForDownloadError (error) {
  switch (error?.code) {
    case 'FS_NOT_FOUND': return 404
    case 'FS_PERMISSION_DENIED': return 403
    case 'FS_SANDBOX_DENIED': return 403
    // The mount fence: the target exists in principle, but this deployment is
    // not serving that directory, so the request is forbidden rather than absent.
    case 'FS_OUTSIDE_WORKSPACE': return 403
    case 'FS_NOT_REGULAR_FILE': return 400
    case 'FS_NOT_DIRECTORY': return 400
    // A file past the shared limit is not a server fault; see the same case in
    // `statusForActionError`.
    case 'FS_TOO_LARGE': return 413
    default: return 500
  }
}

/** Write a JSON response. */
function writeJson (res, status, body) {
  try {
    // A route that failed part-way through streaming may already have declared
    // the byte count of the file it will never send (measured: 149 605
    // declared, 73 delivered) or an `attachment` disposition for what is now an
    // error page. Left in place, those headers describe a different response:
    // the browser waits for bytes that never come, or saves the error as a
    // file. An error answer must not inherit the promises of the success it
    // replaced.
    res.removeHeader?.('content-length')
    res.removeHeader?.('content-disposition')
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  } catch { /* response already closed */ }
}

/**
 * The status a FAILED action should carry.
 *
 * The route family used to answer almost every business failure with
 * `200 + { ok: false, error }`, while parameter errors used 4xx. That left two
 * conventions in one file: a caller had to read `response.ok`, parse the body,
 * and check `body.ok`, because either half could be the failure. The split was
 * also invisible to anything that reasons about HTTP alone — a monitor saw a
 * wall of 200s, and a retry policy could not tell "try again" from "fix the
 * input".
 *
 * The rule now: a failure is a non-2xx status with a JSON error body. `ok: true`
 * is kept on successes (the browser half and the tools already read it), and
 * business outcomes that are NOT failures — "the tunnel could not bind but the
 * row was saved", "the port is busy" — still answer 200 with their own fields.
 *
 * 4xx means the caller can fix it; 5xx means the server (or the host) failed.
 * Unclassified errors are 500, matching `/download`.
 *
 * @param {unknown} error - the failure raised by the handler.
 * @param {number} [fallback] - status for an unclassified error.
 * @returns {number} the status to answer with.
 */
function statusForActionError (error, fallback = 500) {
  switch (error?.code) {
    // ---- caller-side: the request asked for something impossible
    case 'FS_NOT_FOUND':
    case 'ENOENT': return 404
    case 'FS_INVALID': return 400
    case 'EEXIST': return 409
    case 'FS_NOT_REGULAR_FILE':
    case 'FS_NOT_DIRECTORY':
    case 'EISDIR': return 400
    // Too large is the CALLER's problem, and 413 is the status that says so.
    // Answering 500 would render a deliberate limit as a broken server, which
    // is exactly the confusion `statusForDownloadError` exists to avoid.
    case 'FS_TOO_LARGE': return 413
    // ---- fences: the request is well-formed but this deployment refuses it
    case 'FS_PERMISSION_DENIED':
    case 'FS_SANDBOX_DENIED':
    case 'FS_OUTSIDE_WORKSPACE':
    case 'FS_PERMISSION_DENIED_READONLY': return 403
    // ---- store-side: the request is fine, the stored document is not
    case 'STORE_INVALID': return 400
    case 'STORE_CONFLICT': return 409
    case 'STORE_UNREADABLE': return 500
    // ---- transport / host-side
    case 'ECONNRESET':
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ECONNREFUSED': return 502
    default: return fallback
  }
}

/** Read a JSON request body, returning null on failure. */
async function readJsonBody (req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 4 * 1024 * 1024) { req.destroy(); resolve(null) }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
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

/** Extract a decoded query parameter. */
function queryParam (url, name) {
  const value = url.searchParams.get(name)
  return value === null ? undefined : value
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
 * Decide whether a request may pass the route fence.
 *
 * This is the single place that encodes "who may call these endpoints", so the
 * shared `guard()` and the two byte-streaming routes (which re-apply the fence
 * around their non-JSON bodies) cannot drift apart.
 *
 * In the default loopback-only mode the refusals keep their historical
 * wording, byte for byte. In `allowLan` mode the two reasons stay
 * distinguishable: an unacceptable origin and an unacceptable Host header are
 * different failures, and both name their cause.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {AccessPolicy} policy - the resolved access policy.
 * @returns {{ error: string } | undefined} the 403 body when refused, else undefined.
 */
function accessRefusal (req, policy) {
  if (policy.allowLan !== true) {
    if (!isLoopbackRequest(req)) return { error: 'forbidden: loopback-only' }
    if (!isLoopbackHostHeader(req)) {
      return { error: `forbidden: unexpected Host header ${JSON.stringify(req.headers?.host ?? '')}` }
    }
    return undefined
  }
  const addr = req.socket?.remoteAddress ?? req.connection?.remoteAddress ?? ''
  if (!isLoopbackAddress(addr) && !isPrivateNetworkAddress(addr)) {
    return { error: `forbidden: remote address ${JSON.stringify(addr)} is neither loopback nor a private network address` }
  }
  if (!isLanHostHeader(req, policy.allowedHosts)) {
    return { error: `forbidden: unexpected Host header ${JSON.stringify(req.headers?.host ?? '')}` }
  }
  return undefined
}

/**
 * An AbortSignal that fires when the CLIENT goes away before the answer.
 *
 * A transfer is the one thing a user can abandon by closing the panel, and the
 * server has no other way to learn that: the socket dies mid-request. Without
 * this, a cancelled batch download kept reading the remote tree into a
 * destination nobody was waiting for — the client stopped listening, but the
 * work continued.
 *
 * The listener is on the RESPONSE, not the request. `req`'s `close` fires as
 * soon as the request BODY has been consumed, which for a small JSON body is
 * immediately — wiring this to `req` aborted every transfer before it started.
 * `res.writableFinished` is what separates "we answered" from "they left": a
 * normal completion emits `close` too, and aborting there would cancel the
 * final write.
 *
 * @param {import('node:http').ServerResponse} res - the response.
 * @returns {AbortSignal} aborts on a premature close.
 */
function abortOnClientGone (res) {
  const controller = new AbortController()
  const onClose = () => {
    if (res.writableFinished !== true) controller.abort()
  }
  res.once?.('close', onClose)
  controller.signal.addEventListener('abort', () => {
    try { res.off?.('close', onClose) } catch { /* already gone */ }
  }, { once: true })
  return controller.signal
}

/**
 * Build every /api/dsh-ssh-workspace route.
 *
 * @param {RouteDeps} deps - engine, router, forwards, cordis context.
 * @returns {Array<object>} route descriptors for ctx.webServer.register().
 */
export function makeRoutes (deps) {
  const { engine, router, forwards, reverseForwards, savedForwards, shells, ctx } = deps

  const accessPolicy = {
    allowLan: deps.allowLan === true,
    allowedHosts: (Array.isArray(deps.allowedHosts) ? deps.allowedHosts : [])
      .filter(entry => typeof entry === 'string' && entry.trim() !== '')
      .map(entry => entry.trim().toLowerCase()),
  }

  const guard = (req, res, method) => {
    const refusal = accessRefusal(req, accessPolicy)
    if (refusal !== undefined) {
      writeJson(res, 403, refusal)
      return false
    }
    if (req.method !== method) {
      writeJson(res, 405, { error: `method not allowed: ${req.method}` })
      return false
    }
    if (method === 'POST' && !isJsonContentType(req)) {
      writeJson(res, 415, { error: 'unsupported media type: POST endpoints require content-type: application/json' })
      return false
    }
    return true
  }

  /**
   * The guard for the two endpoints that carry raw bytes rather than JSON.
   *
   * They differ from {@link guard} in exactly one way — the media type they
   * require — and that difference is the point: a browser cannot send
   * `application/octet-stream` from a form, and a `fetch` that sets it triggers
   * the preflight this server never approves. Keeping them side by side means
   * the CSRF premise is stated once for each shape instead of re-derived at
   * every raw endpoint, and a future byte-carrying route cannot quietly omit it.
   *
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   * @param {'GET'|'POST'} method - the method this endpoint accepts.
   * @returns {boolean} true when the request may proceed.
   */
  const guardRaw = (req, res, method) => {
    if (!refuseUnlessAllowed(req, res)) return false
    if (req.method !== method) {
      writeJson(res, 405, { error: `method not allowed: ${req.method}` })
      return false
    }
    // Only an upload has a body to type-check. A download is a GET, and
    // demanding a content type on it would break the browser's own link flow.
    if (method === 'POST' && !isRawContentType(req)) {
      writeJson(res, 415, {
        error: 'unsupported media type: this endpoint accepts raw bytes and requires content-type: application/octet-stream',
      })
      return false
    }
    return true
  }

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

  // The download/upload fences answer with a bare "forbidden" rather than the
  // detailed wording (their responses stream bytes, and the browser-side
  // download flow surfaces the JSON body only as a failure blob). The verdict
  // itself is the same `accessRefusal` the shared guard applies.
  const refuseUnlessAllowed = (req, res) => {
    const refusal = accessRefusal(req, accessPolicy)
    if (refusal === undefined) return true
    writeJson(res, 403, { error: 'forbidden' })
    return false
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
    // ---- hosts
    {
      kind: 'exact',
      path: ROUTES.hosts,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const query = queryParam(url, 'query') ?? ''
        // Store rows carry the non-secret auth details the editor needs to
        // prefill; secrets (password, passphrase) never leave the store file.
        // `listing()` reports what could NOT be shown as well as what could:
        // a skipped entry and an unreadable store used to render as "no hosts",
        // which is the one thing the user cannot act on.
        const listing = engine.store.listing?.() ?? { rows: engine.store.rows(), skipped: [] }
        const rows = listing.rows.map(row => {
          if (row.source !== 'store') return row
          const entry = engine.store.entry(row.alias) ?? {}
          const auth = entry.auth ?? {}
          return {
            ...row,
            keyPath: typeof auth.keyPath === 'string' ? auth.keyPath : undefined,
            agentPath: typeof auth.agentPath === 'string' ? auth.agentPath : undefined,
            agentForward: entry.agentForward === true,
            compress: entry.compress === true,
          }
        })
        const filtered = query === ''
          ? rows
          : rows.filter(row => [row.alias, row.host, row.user, row.description ?? '', ...(row.tags ?? [])]
              .join(' ')
              .toLowerCase()
              .includes(query.toLowerCase()))
        writeJson(res, 200, {
          hosts: filtered,
          // Always present so the client does not have to distinguish "absent"
          // from "empty"; the reason travels with each skipped entry.
          skipped: listing.skipped ?? [],
          ...(listing.storeError === undefined ? {} : { storeError: listing.storeError }),
        })
      },
    },
    // ---- save host (create or update)
    {
      kind: 'exact',
      path: ROUTES.hostSave,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const originalAlias = typeof body?.originalAlias === 'string' && body.originalAlias.trim() !== ''
          ? body.originalAlias.trim()
          : undefined
        const payload = {
          alias: typeof body?.alias === 'string' ? body.alias : '',
          host: typeof body?.host === 'string' ? body.host : '',
          port: typeof body?.port === 'number' ? body.port : 22,
          user: typeof body?.user === 'string' ? body.user : '',
          auth: {
            kind: typeof body?.auth?.kind === 'string' ? body.auth.kind : 'agent',
            keyPath: typeof body?.auth?.keyPath === 'string' ? body.auth.keyPath : '',
            passphrase: typeof body?.auth?.passphrase === 'string' ? body.auth.passphrase : '',
            password: typeof body?.auth?.password === 'string' ? body.auth.password : '',
            agentPath: typeof body?.auth?.agentPath === 'string' ? body.auth.agentPath : '',
          },
          description: typeof body?.description === 'string' ? body.description : '',
          // Tags were stored, filtered on by both the route and the agent tool,
          // and had no way IN — the save route dropped them, so the panel's new
          // editor field would have been a no-op and a hand-edited
          // `dsh-ssh.json` was the only source. Normalized here (trim, drop
          // blanks, de-duplicate) so the store never holds two spellings of one
          // tag and the search box matches what the card shows.
          tags: Array.isArray(body?.tags)
            ? [...new Set(body.tags.filter(tag => typeof tag === 'string').map(tag => tag.trim()).filter(tag => tag !== ''))]
            : [],
          // Transport options: the editor always posts booleans, so a missing
          // field means "off" rather than "keep the previous value".
          agentForward: body?.agentForward === true,
          compress: body?.compress === true,
        }
        const store = engine.store.entryStore
        try {
          // A store entry shadows the same alias in ~/.ssh/config, so creating
          // one where only a config block exists would silently change how that
          // alias resolves for every other ssh client too.
          const aliasTrimmed = payload.alias.trim()
          const storeEntry = aliasTrimmed === '' ? undefined : store.find(aliasTrimmed)
          if (aliasTrimmed !== '' && storeEntry === undefined && engine.store.sshConfigAliases().includes(aliasTrimmed)) {
            writeJson(res, 409, { ok: false, error: `alias ${JSON.stringify(aliasTrimmed)} is already defined in ~/.ssh/config; edit that file instead or pick another alias` })
            return
          }
          const entry = originalAlias === undefined
            ? store.create(payload)
            : store.update(originalAlias, payload)
          // A changed record must not keep serving the old connection.
          if (originalAlias !== undefined) engine.forget(originalAlias)
          engine.forget(entry.alias)
          writeJson(res, 200, { ok: true, alias: entry.alias, created: originalAlias === undefined })
        } catch (error) {
          // A colliding alias is the caller's to fix (409); an invalid form is
          // 400; an unreadable store is 500 — all from the store's own code.
          writeJson(res, statusForActionError(error, 500), { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---- delete host
    {
      kind: 'exact',
      path: ROUTES.hostDelete,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const alias = typeof body?.alias === 'string' ? body.alias.trim() : ''
        if (alias === '') {
          writeJson(res, 400, { error: 'alias is required' })
          return
        }
        try {
          engine.store.entryStore.delete(alias)
          engine.forget(alias)
          writeJson(res, 200, { ok: true, alias })
        } catch (error) {
          const inConfig = engine.store.sshConfigAliases().includes(alias)
          writeJson(res, inConfig ? 409 : statusForActionError(error, 500), {
            ok: false,
            error: inConfig
              ? `${alias} is defined in ~/.ssh/config, which this plugin never edits — remove the Host block there instead`
              : error instanceof Error ? error.message : String(error),
          })
        }
      },
    },
    // ---- forget recorded host key (TOFU re-trust)
    {
      kind: 'exact',
      path: ROUTES.hostForgetKey,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const alias = typeof body?.alias === 'string' ? body.alias.trim() : ''
        if (alias === '') {
          writeJson(res, 400, { error: 'alias is required' })
          return
        }
        try {
          const removed = engine.store.forgetHostKey(alias)
          // Drop the pooled connection so the next connect re-pins the key.
          engine.forget(alias)
          writeJson(res, 200, { ok: true, removed })
        } catch (error) {
          writeJson(res, statusForActionError(error, 500), { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---- disconnect (close the pooled connection for one host)
    {
      kind: 'exact',
      path: ROUTES.hostDisconnect,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const alias = typeof body?.alias === 'string' ? body.alias.trim() : ''
        if (alias === '') {
          writeJson(res, 400, { error: 'alias is required' })
          return
        }
        const record = engine.pool.get(alias)
        if (record === undefined) {
          writeJson(res, 200, { ok: true, disconnected: false })
          return
        }
        // Dropping a busy connection would fail whatever rides on it; let the
        // caller retry once the operations settle.
        if (record.inFlight > 0) {
          writeJson(res, 409, { ok: false, error: `the connection has ${record.inFlight} operation(s) in flight — disconnect again once it is idle` })
          return
        }
        try {
          // Requirement: dropping the SSH connection takes its port forwards
          // with it. The connection's own `close` event also tears them down,
          // but that event is not guaranteed — an ssh2 client destroyed without
          // emitting, or replaced by a reconnect, would leave listeners bound to
          // a record nobody owns. Closing by alias first makes it deterministic.
          //
          // This is a DELIBERATE disconnect, so the tunnels must end up exactly
          // where the panel's own "close" button leaves them: intent off and no
          // recorded failure. `closeForAlias` is the unplanned-drop path — it
          // keeps the intent on and records "SSH connection closed", which the
          // panel shows as a red "connection lost" line. A user who clicked
          // disconnect did not lose anything, and telling them otherwise makes
          // a working action look like a fault.
          const closedForwards = savedForwards === undefined
            ? (forwards?.closeForAlias?.(alias, 'SSH connection closed') ?? 0)
            : savedForwards.closeAlias(alias)
          engine.forget(alias)
          writeJson(res, 200, { ok: true, disconnected: true, closedForwards })
        } catch (error) {
          writeJson(res, statusForActionError(error, 500), { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---- reconnect now (skip the backoff)
    //
    // The background loop can be minutes from its next attempt; a user who just
    // fixed their network should not have to wait for it, nor close and reopen
    // the workspace to poke the engine. This is the manual version of the same
    // attempt, so it reports the real error instead of a cheerful "retrying".
    //
    // Deliberately allowed even when nothing is "wanted": the user naming the
    // host is the strongest statement of intent there is (see reconnect.js).
    {
      kind: 'exact',
      path: ROUTES.hostReconnect,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const alias = typeof body?.alias === 'string' ? body.alias.trim() : ''
        if (alias === '') {
          writeJson(res, 400, { error: 'alias is required' })
          return
        }
        if (engine.reconnector === undefined) {
          writeJson(res, 501, { ok: false, error: 'background reconnect is disabled in this deployment' })
          return
        }
        const started = Date.now()
        try {
          const result = await engine.reconnector.retryNow(alias)
          writeJson(res, 200, { ...result, durationMs: Date.now() - started })
        } catch (error) {
          writeJson(res, statusForActionError(error, 502), { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---- test connection
    //
    // A probe, not a way to connect: it proves the host answers and then
    // releases the connection IT opened. Leaving that connection pooled made
    // "test" quietly double as "connect", so a user who only wanted to know
    // whether the host answers ended up with a live session they never asked
    // for.
    //
    // Two cases where the connection is deliberately kept:
    //   - it was ALREADY pooled before this probe (the user's own connection is
    //     not this request's to drop);
    //   - anything rides on it — an open port forward pins it with `holds`, and
    //     tearing it down there would break a tunnel the user did not ask to
    //     close.
    {
      kind: 'exact',
      path: ROUTES.test,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const alias = typeof body?.alias === 'string' ? body.alias.trim() : ''
        if (alias === '') {
          writeJson(res, 400, { error: 'alias is required' })
          return
        }
        const started = Date.now()
        try {
          const existed = engine.pool?.has?.(alias) === true
          const record = await engine.acquire(alias)
          const durationMs = Date.now() - started
          const held = (record?.holds ?? 0) > 0
          let released = false
          if (!existed && !held && (record?.inFlight ?? 0) === 0) {
            engine.forget(alias)
            released = true
          }
          writeJson(res, 200, {
            ok: true,
            durationMs,
            released,
            ...(held
              ? { heldBy: 'an open port forward still holds this connection' }
              : existed ? { heldBy: 'the connection was already open' } : {}),
          })
        } catch (error) {
          writeJson(res, 200, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - started,
          })
        }
      },
    },
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
        try {
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
            }))
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
            // Whether an upload into THIS directory would pass the mount fence.
            //
            // `writable` above is the SSH account's own permission, and it is a
            // different question from whether this deployment will accept a
            // write here. Without this flag the browser offered an upload button
            // in every directory it could list — including the SSH login
            // directory, which is usually outside every mounted root — so the
            // gesture completed, the request was correctly refused with a 403,
            // and the user learned about the fence only AFTER picking a file.
            // The panel still cannot upload there; it can now say so BEFORE the
            // picker opens.
            //
            // Computed from the same `writeFenceRoots` the upload route applies,
            // so the two cannot disagree about where a write is allowed. A fence
            // that cannot answer reports the permissive default: this flag only
            // ever SUPPRESSES a control, and a throw here must not hide an
            // upload that the route would have accepted.
            uploadable: (() => {
              try {
                return isWithinRemoteRoots(writeFenceRoots(router.roots, { alias }), { alias, remotePath: path })
              } catch { return true }
            })(),
          })
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---- mount status
    {
      kind: 'exact',
      path: ROUTES.status,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const mounted = router.listRoots()
        const connections = [...engine.pool.entries()].map(([alias, record]) => ({
          alias,
          state: record.broken ? 'broken' : 'connected',
          inFlight: record.inFlight,
          idleAt: record.idleAt,
          // The generation, and the sentence that explains it. The panel shows
          // the sentence; `generation` travels too so a client can notice a
          // CHANGE between two refreshes rather than only reading the label.
          generation: record.generation ?? 0,
          generationNote: engine.describeGeneration?.(alias) ?? '',
        }))
        // Background retry state, one row per host the loop is working on. The
        // panel needs `attempts` and `nextAt` to say "retrying in 8s" instead of
        // showing a dead host with no explanation; `phase: 'gave-up'` is a
        // different message again ("stopped"), so the two must not be flattened
        // into one boolean.
        const reconnecting = engine.reconnector?.list?.() ?? []
        // One sentence per host that has ever connected, so the panel can say
        // "generation 3, anything started before the reconnect may still be
        // running" instead of a bare "connected". Derived from the same
        // generations map the records carry, so a host that dropped out of the
        // pool entirely is still describable.
        const generations = [...(engine.generations?.keys?.() ?? [])].map(alias => ({
          alias,
          generation: engine.generationOf(alias).generation,
          note: engine.describeGeneration(alias),
        }))
        // Registered remote Workspaces, so the browser half can mark them
        // wherever DSH draws them with its own folder glyph.
        let workspaces = []
        try {
          const registry = ctx.get('workspaceRegistry')
          workspaces = (registry?.list?.() ?? [])
            .filter(entity => typeof entity?.path === 'string' && entity.path.startsWith('ssh://'))
            .map(entity => ({
              id: String(entity.id ?? entity.path),
              path: entity.path,
              title: typeof entity.title === 'string' ? entity.title : '',
              // The browser half greys a detached workspace's own sessions, and
              // a session row carries only its id — so the membership has to
              // travel with the reply. Without it the row for the workspace goes
              // grey while the sessions inside it stay fully live.
              sessionIds: Array.isArray(entity.sessionIds) ? entity.sessionIds.map(String) : [],
            }))
        } catch { /* registry unavailable — the reply stands without the list */ }
        writeJson(res, 200, {
          mounted,
          // Detached workspaces: still registered, deliberately not served.
          // The panel derives "off" from this list alone, so a workspace can
          // never be shown as on while the fence says otherwise.
          disabled: router.listDisabled(),
          connections,
          reconnecting,
          generations,
          workspaces,
          forwards: forwards.list(),
          // Remote listeners, kept apart for the same reason the tool keeps
          // them apart: direction is the first thing a reader needs.
          reverseForwards: reverseForwards?.list?.() ?? [],
          // The saved half. `forwards` above stays the live view the agent
          // tools already consume; the panel needs the join to label a button
          // by what exists rather than by what was requested.
          ...(savedForwards === undefined
            ? {}
            : { forwardRows: savedForwards.list(), forwardSettings: savedForwards.settings() }),
          ...(shells === undefined ? {} : { shells: shells.list() }),
          // Recent connection and watcher events for the panel's status view.
          // The Host has no console exporter, so this is the only history a
          // user can actually reach (see lib/diagnostics.js).
          events: engine.diagnostics?.list(20) ?? [],
          // Current verdict per upstream workaround. Kept beside `events` for
          // the same reason: this is the channel that reaches a human, and
          // "one of our patches is obsolete, delete it" (probe: 'fixed') plus
          // "I could not judge the Host" (probe: 'unprobeable') both have to be
          // visible without reading a source file.
          upstreamWorkarounds: engine.upstreamWorkarounds ?? [],
          // How old each section is, and where it came from. Without this the
          // reply mixes facts of three different ages and renders them alike:
          // the connection list is read now, the capability rows are a cache
          // that may predate a tool being installed, and the event ring is
          // history by definition. "It says connected but the tree is empty" is
          // what an unlabelled mix produces.
          //
          // The probe's label describes the OLDEST cached row, not the newest:
          // a section is only as fresh as its stalest fact.
          provenance: statusProvenance({
            now: Date.now(),
            probe: oldestProbe(engine),
          }).sections,
          // What each probed host can do, one row per tool. Derived from the
          // cache rather than probing: the panel polls this route, and a status
          // request that dialled every host would make "how are things?" itself
          // network activity. A host appears here only after something else
          // probed it (a mount, or the self-check button).
          selfCheck: [...(engine.capabilities?.keys?.() ?? [])].map(alias => {
            const report = selfCheck(engine.capabilities.get(alias), engine.environmentOf(alias))
            return {
              alias,
              missing: report.missing,
              rows: report.rows,
              findings: report.findings,
            }
          }),
          // Recent remote commands. Only the failing ones are worth a panel
          // section, but the whole record travels so the panel can decide — and
          // so a future surface does not need a second route.
          commands: engine.audit?.list?.(50) ?? [],
          // The verdict behind the panel's status dot, derived from the same
          // fields `/support-bundle` prints. Computed HERE rather than in the
          // browser so the dot and the pasted report cannot disagree: one
          // implementation, two renderings. `findings` carries the alias as a
          // separate field (the report masks it, the panel shows it).
          //
          // `notes` travels beside it and does NOT count: the self-check is
          // advisory (a missing optional tool is not a malfunction), and
          // folding it into `findings` turned the dot red on healthy machines.
          diagnosis: (() => {
            const report = diagnose(diagnosisInput())
            return { version: DIAGNOSIS_VERSION, state: report.state, warn: report.warn, unknown: report.unknown, findings: report.findings, notes: report.notes }
          })(),
        })
      },
    },
    // ---- remote self-check for one host
    //
    // Reads and formats; never probes on demand. A GET that silently opened an
    // SSH connection would be a request the browser can issue from a link, and
    // "loading a page dials a server" is the exact behaviour `probe-smoke`
    // exists to prevent. So this serves the CACHED probe (running it once if
    // the host was never probed, which is what the mount path does too) and
    // says plainly when there is nothing to report yet.
    {
      kind: 'exact',
      path: ROUTES.selfCheck,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const alias = (queryParam(url, 'alias') ?? '').trim()
        if (alias === '') {
          writeJson(res, 400, { error: 'alias is required' })
          return
        }
        try {
          const tools = await engine.probeCapabilities(alias)
          const environment = engine.environmentOf(alias)
          const report = selfCheck(tools, environment)
          writeJson(res, 200, {
            alias,
            tools,
            environment: environment ?? {},
            rows: report.rows,
            findings: report.findings,
            missing: report.missing,
            // The same text the status tool prints, so a user who pastes one
            // and a user who reads the other are looking at one wording.
            text: renderSelfCheck(report),
          })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---- diagnostic report
    //
    // Assembles what the other surfaces already know into one redacted paste.
    // Every field is read from an existing source (the host listing, the audit
    // ring, the diagnostics ring, the probe cache) rather than collected here,
    // so the report cannot report something the panel would contradict.
    {
      kind: 'exact',
      path: ROUTES.supportBundle,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const text = buildSupportBundle(diagnosisInput())
        // `text/plain` rather than JSON: the bundle's whole purpose is to be
        // copied and pasted, and a browser opening this URL should show the
        // report, not a quoted string.
        try {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
          res.end(text)
        } catch { /* response already closed */ }
      },
    },
    // ---- mount
    {
      kind: 'exact',
      path: ROUTES.mount,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const alias = typeof body?.alias === 'string' ? body.alias.trim() : ''
        const remotePath = typeof body?.remotePath === 'string' ? body.remotePath.trim() : ''
        const title = typeof body?.title === 'string' ? body.title.trim() : ''
        const register = body?.register !== false
        if (alias === '' || remotePath === '' || !remotePath.startsWith('/')) {
          writeJson(res, 400, { error: 'alias and an absolute remotePath are required' })
          return
        }
        try {
          // Verify the target exists and is a directory.
          await engine.withSftp(alias, async (sftp) => {
            const stats = await new Promise((resolve, reject) => {
              sftp.stat(remotePath, (err, s) => { if (err) reject(err); else resolve(s) })
            })
            if (!stats.isDirectory()) throw new Error(`not a directory: ${remotePath}`)
          })
          const workspacePath = router.addRoot(alias, remotePath)
          // Advisory capability probe; never let it fail the mount.
          let capabilities
          try {
            const probed = await engine.probeCapabilities(alias)
            if (probed.rg !== undefined || probed.git !== undefined || probed.inotifywait !== undefined) capabilities = probed
          } catch { /* best-effort */ }
          let registered = false
          let workspaceId
          if (register) {
            try {
              const registry = ctx.get('workspaceRegistry')
              const existing = registry.list().find(entity => entity.path === workspacePath)
              if (existing !== undefined) {
                workspaceId = String(existing.id ?? existing.path)
                registered = true
              } else if (typeof registry.createCanonical === 'function') {
                const entity = await registry.createCanonical(workspacePath, title || remotePath.split('/').pop())
                workspaceId = String(entity.id ?? workspacePath)
                registered = true
              }
            } catch (regError) {
              // Mounted in-process but not registered — still usable.
              return writeJson(res, 200, {
                ok: true,
                workspacePath,
                registered: false,
                error: `mounted but not registered: ${regError instanceof Error ? regError.message : String(regError)}`,
              })
            }
          }
          writeJson(res, 200, {
            ok: true,
            workspacePath,
            registered,
            ...(workspaceId !== undefined ? { workspaceId } : {}),
            ...(capabilities !== undefined ? { capabilities } : {}),
          })
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---- unmount (detach / deregister)
    //
    // Two distinct requests share this endpoint because they both answer "stop
    // using this workspace" and differ only in how much is torn down:
    //
    //   detach      disable + archive sessions. The DSH workspace record
    //               survives, so the sidebar row stays visible (greyed) and the
    //               panel can re-enable it. Sessions disappear from every
    //               grouping surface but their files are untouched, and
    //               unarchiving restores each one to its recorded position.
    //               This is the DEFAULT: it is the only mode that is reversible.
    //   deregister  detach, then also delete the workspace record, so the row
    //               goes from the sidebar AND from this panel. Sessions are
    //               still archived, never deleted — DSH has no session-delete
    //               API and this plugin deliberately does not reach around the
    //               service layer to unlink session logs.
    //
    // The older `forget` spelling is accepted as an alias of `deregister`: the
    // two did the same thing to the record, and keeping a third near-duplicate
    // mode is how the panel ended up able to offer a re-enable button for a row
    // that no longer existed.
    {
      kind: 'exact',
      path: ROUTES.unmount,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const workspacePath = typeof body?.workspacePath === 'string' ? body.workspacePath.trim() : ''
        if (workspacePath === '') {
          writeJson(res, 400, { error: 'workspacePath is required' })
          return
        }
        const mode = normalizeUnmountMode(body)
        // Detaching alone must NOT archive: the workspace record survives, so
        // the sidebar group survives, and the sessions belonging to it must
        // keep showing up under it. Archiving them would empty the very group
        // the user asked to keep — the row would stay but read as an empty
        // workspace, which is a worse outcome than the one they declined.
        //
        // Archiving therefore follows the "also remove the workspace record"
        // opt-in, because that is the only action that takes the group away.
        // An explicit `archiveSessions` still wins, so a caller that wants the
        // split behaviour can ask for it.
        const archiveSessions = typeof body?.archiveSessions === 'boolean'
          ? body.archiveSessions
          : mode !== 'detach'
        try {
          const wasMounted = router.disableRoot(workspacePath)
          engine.store.entryStore.disableWorkspace(workspacePath)

          const registry = ctx.get('workspaceRegistry')
          const entity = registry?.list?.().find(candidate => candidate.path === workspacePath)

          // Archiving is the recoverable alternative to deleting: the session
          // files stay on disk and the accounting slot is kept, so unarchiving
          // puts each session back where it was.
          const archived = archiveSessions ? await archiveWorkspaceSessions(registry, entity) : { ok: [], failed: [] }

          let deregistered = false
          if (mode !== 'detach') {
            if (entity !== undefined && typeof registry?.delete === 'function') {
              await registry.delete(entity.id)
              deregistered = true
            }
            // Requirement: "also delete the workspace record" means the row goes
            // from the SIDEBAR **and** from this panel. Deleting the record
            // already removes the sidebar row; the panel's list is driven by the
            // detached mark, so that mark must come down too — otherwise the
            // panel keeps offering a re-enable button for a workspace that no
            // longer exists anywhere, and the runtime fence would refuse every
            // operation on a path the user can no longer re-enable.
            //
            // The mark therefore comes down in both places it is kept: the
            // persisted list and the in-memory fence.
            router.enableRoot(workspacePath)
            engine.store.entryStore.enableWorkspace(workspacePath)
          }
          writeJson(res, 200, {
            ok: true,
            mode,
            wasMounted,
            deregistered,
            archived: archived.ok,
            // A session that could not be archived is reported, never silently
            // skipped: it stays visible in the UI and the user should know.
            ...(archived.failed.length === 0 ? {} : { archiveFailed: archived.failed }),
          })
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---- enable (re-mount a detached workspace)
    {
      kind: 'exact',
      path: ROUTES.enable,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const workspacePath = typeof body?.workspacePath === 'string' ? body.workspacePath.trim() : ''
        if (workspacePath === '') {
          writeJson(res, 400, { error: 'workspacePath is required' })
          return
        }
        const parts = parseRemotePath(workspacePath)
        if (parts === undefined) {
          writeJson(res, 400, { error: `not a remote workspace path: ${JSON.stringify(workspacePath)}` })
          return
        }
        const unarchiveSessions = body?.unarchiveSessions !== false
        try {
          // The directory must still exist on the host, or enabling would
          // produce a workspace that looks served but answers ENOENT.
          await engine.withSftp(parts.alias, async (sftp) => {
            const stats = await new Promise((resolve, reject) => {
              sftp.stat(parts.remotePath, (err, s) => { if (err) reject(err); else resolve(s) })
            })
            if (!stats.isDirectory()) throw new Error(`not a directory on ${parts.alias}: ${parts.remotePath}`)
          })
          const mounted = router.addRoot(parts.alias, parts.remotePath)
          engine.store.entryStore.enableWorkspace(workspacePath)

          const registry = ctx.get('workspaceRegistry')
          let entity = registry?.list?.().find(candidate => candidate.path === workspacePath)
          let registered = entity !== undefined
          if (entity === undefined && typeof registry?.createCanonical === 'function') {
            entity = await registry.createCanonical(workspacePath, parts.remotePath.split('/').pop())
            registered = true
          }
          const unarchived = unarchiveSessions && entity !== undefined
            ? await unarchiveWorkspaceSessions(registry, entity)
            : { ok: [], failed: [] }

          writeJson(res, 200, {
            ok: true,
            workspacePath: mounted,
            registered,
            unarchived: unarchived.ok,
            ...(unarchived.failed.length === 0 ? {} : { unarchiveFailed: unarchived.failed }),
          })
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---- open port forward
    {
      kind: 'exact',
      path: ROUTES.forward,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const alias = typeof body?.alias === 'string' ? body.alias.trim() : ''
        const asPort = (value, label) => {
          const numeric = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : undefined)
          if (numeric === undefined) return undefined
          if (!Number.isInteger(numeric) || numeric < 0 || numeric > 65535) throw new Error(`${label} must be an integer between 0 and 65535`)
          return numeric
        }
        try {
          // The reverse direction reuses this route instead of adding a
          // seventh one: the panel and the agent both address "a tunnel through
          // this host", and a second path would duplicate the guard, the body
          // reader and the error mapping for one boolean of difference.
          if (body?.direction === 'reverse') {
            if (reverseForwards === undefined) throw new Error('reverse forwarding is unavailable in this build')
            const reverseRemotePort = asPort(body?.remotePort, 'remotePort')
            if (reverseRemotePort === undefined) throw new Error('remotePort is required (0 for the host to choose)')
            const reverseLocalPort = asPort(body?.localPort, 'localPort')
            if (reverseLocalPort === undefined || reverseLocalPort < 1) throw new Error('localPort is required for a reverse forward (1-65535)')
            const reverse = await reverseForwards.open(alias, {
              localPort: reverseLocalPort,
              remotePort: reverseRemotePort,
              ...(typeof body?.remoteHost === 'string' && body.remoteHost.trim() !== '' ? { remoteHost: body.remoteHost.trim() } : {}),
              ...(typeof body?.localHost === 'string' && body.localHost.trim() !== '' ? { localHost: body.localHost.trim() } : {}),
            })
            writeJson(res, 200, { ok: true, forward: reverse })
            return
          }
          const remotePort = asPort(body?.remotePort, 'remotePort')
          if (remotePort === undefined || remotePort < 1) throw new Error('remotePort is required (1-65535)')
          const localPort = asPort(body?.localPort, 'localPort')
          const forward = await forwards.open(alias, {
            remotePort,
            ...(localPort !== undefined ? { localPort } : {}),
            ...(typeof body?.remoteHost === 'string' && body.remoteHost.trim() !== '' ? { remoteHost: body.remoteHost.trim() } : {}),
            ...(typeof body?.localHost === 'string' && body.localHost.trim() !== '' ? { localHost: body.localHost.trim() } : {}),
          })
          writeJson(res, 200, { ok: true, forward })
        } catch (error) {
          writeJson(res, statusForActionError(error, 502), { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---- close port forward
    {
      kind: 'exact',
      path: ROUTES.unforward,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const id = typeof body?.id === 'string' ? body.id.trim() : ''
        if (id === '') {
          writeJson(res, 400, { error: 'id is required' })
          return
        }
        try {
          // Ids are namespaced by their manager (`fwd-*` local, `rfwd-*`
          // remote), so trying local first costs one failed lookup in the rarer
          // case and keeps the common path a single call.
          const closedLocal = forwards.close(id)
          const closedReverse = closedLocal || reverseForwards === undefined ? false : reverseForwards.close(id)
          writeJson(res, 200, { ok: true, closed: closedLocal || closedReverse })
        } catch (error) {
          writeJson(res, statusForActionError(error, 500), { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---- saved forwards: create / toggle / delete / remember
    //
    // These sit beside the two transient routes above rather than replacing
    // them: the agent tools still open throwaway tunnels, and a user who wants
    // one of those kept can "remember" it afterwards.
    {
      kind: 'exact',
      path: ROUTES.forwardSave,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        if (savedForwards === undefined) { writeJson(res, 500, { error: 'saved forwards are unavailable' }); return }
        const body = await readJsonBody(req)
        const alias = typeof body?.alias === 'string' ? body.alias.trim() : ''
        const asPort = (value, label) => {
          const numeric = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : undefined)
          return numeric === undefined ? undefined : requireStoredPort(numeric, label)
        }
        try {
          const remotePort = asPort(body?.remotePort, 'remotePort')
          const rawLocal = asPort(body?.localPort, 'localPort')
          if (remotePort === undefined) throw new Error('remotePort is required (1-65535)')
          // A saved mapping pins its local port; "same as remote" is resolved
          // here, in the request, so the stored row records a real number.
          const localPort = rawLocal ?? remotePort
          const row = await savedForwards.create({
            alias,
            remotePort,
            localPort,
            ...(typeof body?.remoteHost === 'string' && body.remoteHost.trim() !== '' ? { remoteHost: body.remoteHost.trim() } : {}),
            ...(typeof body?.localHost === 'string' && body.localHost.trim() !== '' ? { localHost: body.localHost.trim() } : {}),
            open: body?.open !== false,
          })
          writeJson(res, 200, {
            ok: true,
            forward: row,
            ...(row.error === undefined ? {} : { error: row.error }),
          })
        } catch (error) {
          writeJson(res, statusForActionError(error, 500), { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.forwardToggle,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        if (savedForwards === undefined) { writeJson(res, 500, { error: 'saved forwards are unavailable' }); return }
        const body = await readJsonBody(req)
        const id = typeof body?.id === 'string' ? body.id.trim() : ''
        if (id === '') { writeJson(res, 400, { error: 'id is required' }); return }
        const enabled = body?.enabled === true
        try {
          // The toggle follows the requested state, and the row it returns
          // reports the runtime truth: an `enabled: true` request that could
          // not bind comes back with `live: false` and an `error`.
          const row = enabled ? await savedForwards.openById(id) : savedForwards.closeById(id)
          writeJson(res, 200, { ok: row.error === undefined, forward: row, ...(row.error === undefined ? {} : { error: row.error }) })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          writeJson(res, statusForActionError(error, 500), { ok: false, error: message, forward: savedForwards.rowById(id) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.forwardDelete,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        if (savedForwards === undefined) { writeJson(res, 500, { error: 'saved forwards are unavailable' }); return }
        const body = await readJsonBody(req)
        const id = typeof body?.id === 'string' ? body.id.trim() : ''
        if (id === '') { writeJson(res, 400, { error: 'id is required' }); return }
        try {
          writeJson(res, 200, { ok: true, deleted: savedForwards.remove(id) })
        } catch (error) {
          writeJson(res, statusForActionError(error, 500), { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.forwardRemember,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        if (savedForwards === undefined) { writeJson(res, 500, { error: 'saved forwards are unavailable' }); return }
        const body = await readJsonBody(req)
        const id = typeof body?.id === 'string' ? body.id.trim() : ''
        if (id === '') { writeJson(res, 400, { error: 'id is required' }); return }
        try {
          writeJson(res, 200, { ok: true, forward: savedForwards.remember(id) })
        } catch (error) {
          writeJson(res, statusForActionError(error, 500), { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---- check a local port before the user commits to it
    {
      kind: 'exact',
      path: ROUTES.forwardProbe,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const host = (url.searchParams.get('localHost') ?? '127.0.0.1').trim() || '127.0.0.1'
        const rawPort = (url.searchParams.get('localPort') ?? '').trim()
        const port = rawPort === '' ? Number.NaN : Number(rawPort)
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          writeJson(res, 400, { error: 'localPort must be an integer between 1 and 65535' })
          return
        }
        try {
          const verdict = await probeLocalPort(host, port)
          writeJson(res, 200, {
            ok: true,
            available: verdict.ok,
            ...(verdict.ok ? {} : { code: verdict.code, error: describeProbeFailure(host, port, verdict.code) }),
          })
        } catch (error) {
          writeJson(res, statusForActionError(error, 500), { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---- saved forward preferences
    {
      kind: 'exact',
      path: ROUTES.forwardSettings,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        if (savedForwards === undefined) { writeJson(res, 500, { error: 'saved forwards are unavailable' }); return }
        const body = await readJsonBody(req)
        try {
          // Only `autoStart` is settable today; anything else in the body is
          // ignored so a stale browser cannot rewrite unrelated settings.
          const settings = savedForwards.setAutoStart(body?.autoStart === true)
          writeJson(res, 200, { ok: true, settings })
        } catch (error) {
          writeJson(res, statusForActionError(error, 500), { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---- move a file between this machine and a host
    {
      kind: 'exact',
      path: ROUTES.transfer,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const alias = typeof body?.alias === 'string' ? body.alias.trim() : ''
        const direction = body?.direction === 'download' ? 'download' : body?.direction === 'upload' ? 'upload' : ''
        const localPath = typeof body?.localPath === 'string' ? body.localPath.trim() : ''
        const remotePath = typeof body?.remotePath === 'string' ? body.remotePath.trim() : ''
        if (alias === '') { writeJson(res, 400, { error: 'alias is required' }); return }
        if (direction === '') { writeJson(res, 400, { error: 'direction must be upload or download' }); return }
        if (localPath === '') { writeJson(res, 400, { error: 'localPath is required' }); return }
        if (remotePath === '') { writeJson(res, 400, { error: 'remotePath is required' }); return }
        try {
          router.assertEnabled(alias, remotePath)
          // `recursive` means "the whole tree", in BOTH directions: it already
          // walked a local tree up, and it now walks a remote tree down. The
          // asymmetry existed only because the browser had no way to name a
          // destination directory — it wrote through a `FileSystemDirectoryHandle`
          // or fell back to one save dialog per file. With a real destination
          // path in hand (the host's own folder chooser), a directory row
          // becomes a FOLDER on this machine, which is what "download this
          // folder into there" means everywhere else.
          const recursive = body?.recursive === true
          // A cancelled request must stop the WALK, not just the answer: the
          // client's abort closes the connection, and without a signal here the
          // route would keep pulling a whole tree from the host into a folder
          // nobody is waiting for any more.
          const signal = abortOnClientGone(res)
          if (recursive && direction === 'download') {
            const result = await downloadTree(engine, {
              alias,
              localPath,
              remotePath,
              signal,
              onConflict: body?.onConflict,
            })
            writeJson(res, 200, {
              ok: true,
              bytes: result.bytes,
              files: result.files,
              ...(result.skipped === 0 ? {} : { skippedFiles: result.skipped }),
              ...(result.excluded === 0 ? {} : { excludedPaths: result.excluded }),
              ...(result.links.length === 0 ? {} : { skippedLinks: result.links }),
            })
            return
          }
          const result = recursive && direction === 'upload'
            ? await uploadTree(engine, { alias, localPath, remotePath, roots: router.roots, onConflict: body?.onConflict })
            : await transferFile(engine, {
              alias,
              direction,
              localPath,
              remotePath,
              roots: router.roots,
              signal,
              onConflict: body?.onConflict,
              verify: body?.verify === true,
              resume: body?.resume === true,
            })
          writeJson(res, 200, {
            ok: true,
            bytes: result.bytes,
            ...(result.files !== undefined ? { files: result.files } : {}),
            ...(result.skipped === undefined ? {} : { skipped: result.skipped }),
            ...(result.path === undefined ? {} : { path: result.path }),
            ...(result.note === undefined ? {} : { note: result.note }),
            ...(result.verified === undefined ? {} : { verified: result.verified }),
            ...(result.verification === undefined ? {} : { verification: result.verification }),
          })
        } catch (error) {
          writeJson(res, statusForActionError(error, 500), { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---- stream one remote file to the browser
    //
    // Separate from `transfer` on purpose: that route moves a file to a path on
    // THIS machine (a tool-shaped, JSON answer), while the browser needs the
    // bytes themselves. Streaming them out keeps a download from being decoded
    // into a JSON string, which would inflate it and cap it at the body limit.
    {
      kind: 'exact',
      path: ROUTES.download,
      handler: async (req, res) => {
        if (!guardRaw(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const alias = (url.searchParams.get('alias') ?? '').trim()
        const remotePath = (url.searchParams.get('path') ?? '').trim()
        if (alias === '' || remotePath === '') {
          writeJson(res, 400, { error: 'alias and path are required' })
          return
        }
        try {
          const { size, chunks, close } = await openRemoteRead(engine, alias, remotePath, router)
          // The same limit the tool and the upload route apply. Without it the
          // panel could stream a file the agent's own `download` refuses, and
          // the refusal has to happen BEFORE `writeHead` — once the status line
          // is out, a 200 with an error body is indistinguishable from content.
          if (size > DEFAULT_MAX_BYTES) {
            await close()
            writeJson(res, 413, { error: oversizeMessage('download', size) })
            return
          }
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': String(size),
            'content-disposition': contentDispositionValue('attachment', basenameOf(remotePath)),
          })
          // Backpressure and cancellation, both of which the old loop ignored.
          //
          // `write()` returning false means the kernel buffer is full: carrying
          // on would queue the whole file in memory for a slow client. Waiting
          // for 'drain' keeps memory bounded to one chunk.
          //
          // A closed connection (the user cancelled the download, or closed the
          // tab) must stop the REMOTE read too, or the host keeps streaming a
          // file nobody will receive. `req` is the right event for that: it is
          // the request's own lifecycle.
          let cancelled = false
          const onClose = () => { cancelled = true }
          req.once?.('close', onClose)
          res.once?.('close', onClose)
          try {
            for await (const chunk of chunks) {
              if (cancelled) break
              if (!res.write(chunk)) {
                await new Promise((resolve) => {
                  const done = () => { res.off?.('drain', done); resolve() }
                  res.once('drain', done)
                  // A response that closes while we wait must not hang here.
                  res.once('close', done)
                })
              }
            }
          } finally {
            req.off?.('close', onClose)
            res.off?.('close', onClose)
            // Closing the read is what releases the connection hold. The
            // generator's own `finally` does this too when the loop ends
            // normally or breaks; `close` is idempotent, so calling it here
            // covers the paths where the generator is never entered at all
            // (an abort between the open and the first chunk) and guarantees
            // the hold cannot outlive the request.
            await close()
          }
          res.end()
        } catch (error) {
          if (!res.headersSent) {
            // A failure must not look like a download. Answering 200 here used
            // to make the browser save the JSON error body under the remote
            // file's name: the client keys on `response.ok`, and a 200 blob of
            // `{"error":"..."}` is indistinguishable from file content once the
            // headers are gone. The status is the only channel the browser's
            // download flow respects, so it carries the failure.
            writeJson(res, statusForDownloadError(error), { error: error instanceof Error ? error.message : String(error) })
            return
          }
          res.end()
        }
      },
    },
    // ---- stream a whole remote DIRECTORY to the browser as one archive
    //
    // The panel's folder row used to say "downloading a whole directory is not
    // supported yet" while the agent's own tool could do it: the capability was
    // true of the model and false of the person clicking. A browser cannot be
    // handed a directory, so the shape that works is an archive — one file, one
    // download flow, produced as it is read rather than staged on disk first.
    //
    // ZIP is the default because it is what the downloading machine can open
    // without extra software; `?format=tar` asks for the tar stream instead.
    {
      kind: 'exact',
      path: ROUTES.downloadTree,
      handler: async (req, res) => {
        if (!guardRaw(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const alias = (url.searchParams.get('alias') ?? '').trim()
        const remotePath = (url.searchParams.get('path') ?? '').trim()
        if (alias === '' || remotePath === '') {
          writeJson(res, 400, { error: 'alias and path are required' })
          return
        }
        const exclude = url.searchParams.getAll('exclude').flatMap(value => value.split(','))
        // Anything other than an explicit `tar` is zip: the format that works
        // by default on the machine doing the downloading, so a request with no
        // opinion gets the one the user can act on.
        const format = url.searchParams.get('format') === 'tar' ? 'tar' : 'zip'
        try {
          router?.assertEnabled?.(alias, remotePath)
          // The directory has to exist and has to BE a directory before the
          // status line: once headers are out, "that was a file" can only be
          // signalled by a truncated archive, which a reader reports as corrupt.
          const kind = await engine.withSftp(alias, async (sftp) => {
            const info = await sftpStatOrNull(sftp, remotePath)
            if (info === null) throw codedError(`remote path does not exist: ${remotePath}`, 'FS_NOT_FOUND')
            return typeof info.isDirectory === 'function' && info.isDirectory() ? 'directory' : 'file'
          }, { kind: 'read' })
          if (kind !== 'directory') {
            writeJson(res, 400, { error: `not a directory: ${remotePath} — use /download for a single file` })
            return
          }
          const archive = await downloadTreeAsArchive(engine, { alias, remotePath, exclude, format })
          res.writeHead(200, {
            'content-type': archive.format === 'tar' ? 'application/x-tar' : 'application/zip',
            // No `content-length`: the archive is streamed as the tree is read,
            // so its size is unknown until the last entry. Chunked is the honest
            // answer, and the browser's progress is then "indeterminate" — which
            // the client states instead of drawing a fake percentage.
            'content-disposition': contentDispositionValue('attachment', archiveNameOf(remotePath, archive.format)),
            'cache-control': 'no-store',
          })
          let cancelled = false
          const onClose = () => { cancelled = true }
          req.once?.('close', onClose)
          res.once?.('close', onClose)
          try {
            for await (const chunk of archive.stream) {
              if (cancelled) break
              if (!res.write(chunk)) {
                await new Promise((resolve) => {
                  const done = () => { res.off?.('drain', done); res.off?.('close', done); resolve() }
                  res.once('drain', done)
                  res.once('close', done)
                })
              }
            }
          } finally {
            req.off?.('close', onClose)
            res.off?.('close', onClose)
          }
          res.end()
        } catch (error) {
          if (!res.headersSent) {
            writeJson(res, statusForDownloadError(error), { error: error instanceof Error ? error.message : String(error) })
            return
          }
          // Headers are out, so the only honest signal left is a cut stream: the
          // browser saves a truncated archive and the reader reports it as
          // corrupt. `res.destroy` is what says that, rather than a clean `end`
          // pretending the archive is complete.
          res.destroy?.(error instanceof Error ? error : new Error(String(error)))
        }
      },
    },
    // ---- receive one CHUNK of a file, as JSON
    //
    // The desktop shell serves this plugin's pages from `dsh-app://app/`, and a
    // request whose body is a `File`/`Blob` never reaches a handler there: the
    // network service fails the load with `net::ERR_UNEXPECTED` — the message
    // the panel showed as `上传失败: 请求在 0 秒后中断` — before any handler runs,
    // which is why the failure looks instantaneous and why the server logged
    // nothing. A JSON body is the transport every other action in this plugin
    // already uses and it demonstrably survives that scheme, so the same bytes
    // travel base64-encoded, a bounded chunk per request.
    //
    // Deliberately STATELESS: the client names its own upload (`uploadId`) and
    // the staging path is derived from it, so a chunk may arrive on any
    // connection without a server-side table — the pool is free to hand each
    // request a different SFTP channel.
    {
      kind: 'exact',
      path: ROUTES.uploadChunk,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const alias = typeof body?.alias === 'string' ? body.alias.trim() : ''
        const dir = typeof body?.path === 'string' ? body.path.trim() : ''
        const name = typeof body?.name === 'string' ? body.name.trim() : ''
        const uploadId = typeof body?.uploadId === 'string' ? body.uploadId.trim() : ''
        const offset = body?.offset
        const data = typeof body?.data === 'string' ? body.data : ''
        // A probe asks "what does the staging file already hold?" without
        // sending bytes; every other field is shared with a real chunk so the
        // two shapes stay one protocol rather than two.
        const probe = body?.probe === true
        const identity = typeof body?.identity === 'string' ? body.identity.trim() : ''
        const totalBytes = body?.totalBytes
        const sha256 = typeof body?.sha256 === 'string' ? body.sha256.trim().toLowerCase() : ''
        if (alias === '' || dir === '' || name === '') {
          writeJson(res, 400, { error: 'alias, path and name are required' })
          return
        }
        if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
          writeJson(res, 400, { error: 'name must be a single path segment' })
          return
        }
        // The id becomes a path segment, so it is held to a shape that cannot
        // spell anything but itself.
        if (!/^[0-9a-f]{16,48}$/u.test(uploadId)) {
          writeJson(res, 400, { error: 'uploadId must be 16-48 hexadecimal characters' })
          return
        }
        if (identity !== '' && (identity.length > 160 || !/^[0-9A-Za-z:._-]+$/u.test(identity))) {
          writeJson(res, 400, { error: 'identity must be a short source identity string' })
          return
        }
        if (sha256 !== '' && !/^[0-9a-f]{64}$/u.test(sha256)) {
          writeJson(res, 400, { error: 'sha256 must be 64 hexadecimal characters' })
          return
        }
        if (probe) {
          if (!Number.isInteger(totalBytes) || totalBytes < 0 || totalBytes > DEFAULT_MAX_BYTES) {
            writeJson(res, 400, { error: 'probe requires totalBytes within the size limit' })
            return
          }
        } else {
          if (!Number.isInteger(offset) || offset < 0 || offset > DEFAULT_MAX_BYTES) {
            writeJson(res, 400, { error: 'offset must be a non-negative integer within the size limit' })
            return
          }
          // Base64 only, checked before decoding: `Buffer.from(x,'base64')`
          // silently DROPS anything it does not recognise, so a corrupted request
          // would otherwise become a shorter file that still reports success.
          if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(data)) {
            writeJson(res, 400, { error: 'data must be base64' })
            return
          }
        }
        const bytes = data === '' ? Buffer.alloc(0) : Buffer.from(data, 'base64')
        const remotePath = dir === '/' ? `/${name}` : `${dir.replace(/\/+$/u, '')}/${name}`
        try {
          const result = await writeUploadChunk(engine, router, {
            alias,
            remotePath,
            uploadId,
            offset: probe ? 0 : offset,
            bytes,
            final: body?.final === true,
            abort: body?.abort === true,
            probe,
            identity,
            totalBytes: Number.isInteger(totalBytes) ? totalBytes : undefined,
            sha256,
            verify: body?.verify === true,
            onConflict: body?.onConflict,
          })
          writeJson(res, 200, { ok: true, ...result })
        } catch (error) {
          writeJson(res, statusForActionError(error, 500), { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---- receive one file from the browser and write it to the host
    //
    // The browser posts the raw bytes as the request body (application/
    // octet-stream) rather than multipart: one file per request keeps the
    // streaming simple and avoids a multipart parser in the bundler-loaded
    // client. `path` names the remote directory, `name` the file inside it.
    {
      kind: 'exact',
      path: ROUTES.upload,
      handler: async (req, res) => {
        // The raw-bytes guard: loopback + Host + method + the octet-stream
        // media type, so a cross-site form cannot reach this write path.
        if (!guardRaw(req, res, 'POST')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const alias = (url.searchParams.get('alias') ?? '').trim()
        const dir = (url.searchParams.get('path') ?? '').trim()
        const name = (url.searchParams.get('name') ?? '').trim()
        if (alias === '' || dir === '' || name === '') {
          writeJson(res, 400, { error: 'alias, path and name are required' })
          return
        }
        // A name is one path segment: a slash would let a request escape the
        // directory the user is looking at.
        if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
          writeJson(res, 400, { error: 'name must be a single path segment' })
          return
        }
        const remotePath = dir === '/' ? `/${name}` : `${dir.replace(/\/+$/u, '')}/${name}`
        // The host receives this request under its own whole-request deadline,
        // which is five minutes by default and was measured closing the socket
        // at 315 s. An upload is the one request whose duration is decided by
        // the network rather than by the work: 1 GiB takes longer than that on
        // any link below ~3.4 MB/s, and the browser reports the cut-off as
        // `Failed to fetch` — a message that names neither the size nor the
        // deadline. The window is opened around the body read only, and closed
        // again as soon as it ends, so no other route inherits it.
        const releaseWindow = openUploadWindow(res)
        try {
          const written = await writeRemoteFromRequest(engine, alias, remotePath, req, router)
          writeJson(res, 200, { ok: true, bytes: written, remotePath })
        } catch (error) {
          writeJson(res, statusForActionError(error, 500), { ok: false, error: error instanceof Error ? error.message : String(error) })
        } finally {
          releaseWindow()
        }
      },
    },
    // ---- the mutation mode, for enabling/disabling the UI
    {
      kind: 'exact',
      path: ROUTES.mutationPolicy,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const sessionId = (url.searchParams.get('sessionId') ?? '').trim()
        const root = (url.searchParams.get('root') ?? '').trim()
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

/**
 * Stream a request body into one remote file.
 *
 * The bytes go straight from the HTTP request into SFTP without buffering the
 * whole body: an upload can be far larger than what a JSON body limit allows,
 * and holding it in memory would defeat the point of streaming.
 *
 * Publication matches the filesystem half: write a sibling staging name, then
 * rename. A reader therefore never observes a half-written destination.
 *
 * @param {object} engine - live engine.
 * @param {string} alias - host alias.
 * @param {string} remotePath - absolute destination path.
 * @param {import('node:http').IncomingMessage} req - the request carrying the bytes.
 * @param {object} [router] - the filesystem router: the detached fence and the
 *   served-root set an upload is fenced against.
 * @returns {Promise<number>} how many bytes were written.
 */
async function writeRemoteFromRequest (engine, alias, remotePath, req, router) {
  router?.assertEnabled?.(alias, remotePath)
  // The same limit the agent's tool applies, applied before any byte is staged.
  //
  // Two layers on purpose. A declared `content-length` is the cheap check and
  // gives the user an immediate answer; it is also CLIENT-SUPPLIED, so a
  // chunked or lying request would sail past it. The running total below is the
  // one that actually bounds the write. Checking only the header would be the
  // "looks enforced, is not" shape this repository keeps finding.
  const declared = Number(req.headers?.['content-length'])
  if (Number.isFinite(declared) && declared > DEFAULT_MAX_BYTES) {
    throw codedError(oversizeMessage('upload', declared), 'FS_TOO_LARGE')
  }
  return await engine.withSftp(alias, async (sftp) => {
    // The same reachability fence `write` and the transfer tool apply, run
    // before a single byte is staged. The browser panel reaches this route
    // directly, so without it a path outside every mounted workspace — or one
    // whose parent is a symlink escaping them — would land here while the model's
    // own `write` was refused. Policy (mode / session scope) is deliberately not
    // decided here: this is a user action on a directory the panel is showing,
    // and the mounted-root fence is the answer it owes.
    await fenceUploadTarget(sftp, alias, remotePath, router?.roots)
    await sftpMkdirp(sftp, remoteParentOf(remotePath), remotePath)
    // The SAME staging name the agent's transfer tool uses, for the same reason
    // (see `stagingNameOf` in transfer.js): the old spelling here was
    // `pid-Date.now().toString(36)`, so two browser uploads to one destination
    // started in the same millisecond shared a staging path, opened it `'w'`,
    // interleaved their bytes, and the loser's cleanup deleted the file the
    // winner was still writing — the exact accident O-07 fixed on the tool path
    // while this route kept it. Random suffix makes a collision improbable;
    // `'wx'` turns a rare one into a retry instead of corruption.
    const staging = stagingNameOf(remotePath, 'up')
    let handle
    let written = 0
    try {
      handle = await sftpOpenHandle(sftp, staging, 'wx', remotePath)
      for await (const chunk of req) {
        // The offset this chunk belongs at, taken BEFORE the counter advances.
        //
        // `sftpWriteHandle` defaults `startAt` to 0, and the loop used to omit
        // it — so every chunk was written to offset 0 of the staging file and
        // each one OVERWROTE the last. A 700 MB upload landed as one 64 KiB
        // chunk while the route still reported `{ok: true, bytes: 734003200}`
        // and published that fragment under the destination name: silent
        // truncation, with a success response. Measured against a real host —
        // the file on disk was 65536 bytes.
        const offset = written
        written += chunk.length
        // The authoritative bound: a request that under-declared its size (or
        // declared nothing) stops HERE, mid-stream, rather than filling the
        // host's disk. The staging file is removed by the catch below, so a
        // refused upload leaves the destination untouched.
        if (written > DEFAULT_MAX_BYTES) throw codedError(oversizeMessage('upload', written), 'FS_TOO_LARGE')
        await sftpWriteHandle(sftp, handle, chunk, remotePath, offset)
      }
      await sftpCloseHandle(sftp, handle)
      handle = undefined
      await sftpPublishRename(sftp, staging, remotePath, remotePath)
      return written
    } catch (error) {
      if (handle !== undefined) { try { await sftpCloseHandle(sftp, handle) } catch { /* already gone */ } }
      try { await sftpUnlink(sftp, staging) } catch { /* staging never created */ }
      throw error
    }
  }, { kind: 'write' })
}

/**
 * Append one decoded chunk to a staged upload, and publish it on the last one.
 *
 * The staging name is DETERMINISTIC (it carries the client's `uploadId`), which
 * is the whole reason this survives the request boundary: no chunk has to find
 * server-side state from a previous one. Two concurrent uploads get different
 * ids and therefore different staging files; the same id restarted at offset 0
 * truncates what a previous attempt left, which is the only honest meaning of
 * "start over".
 *
 * Every later chunk opens `r+` rather than `w`. That is not cosmetic: `w` would
 * discard the prefix the earlier chunks already wrote, and a staging file that
 * vanished (a lost session, a cleaned tmp) must fail loudly here instead of
 * producing a destination that silently begins mid-file.
 *
 * @param {object} engine - live engine.
 * @param {object} router - the filesystem router, for the detached fence.
 * @param {object} request - one chunk.
 * @param {string} request.alias - host alias.
 * @param {string} request.remotePath - absolute destination path.
 * @param {string} request.uploadId - the client's upload identity (hex).
 * @param {number} request.offset - where these bytes belong.
 * @param {Buffer} request.bytes - the decoded chunk.
 * @param {boolean} request.final - publish after this chunk.
 * @param {boolean} request.abort - discard the staging file instead.
 * @returns {Promise<object>} what the client needs to continue.
 */
async function writeUploadChunk (engine, router, request) {
  const { alias, remotePath, uploadId, offset, bytes, final, abort } = request
  router?.assertEnabled?.(alias, remotePath)
  if (request.probe !== true && offset + bytes.length > DEFAULT_MAX_BYTES) {
    throw codedError(oversizeMessage('upload', offset + bytes.length), 'FS_TOO_LARGE')
  }
  const staging = `${remotePath.replace(/\/+$/u, '')}.dsh-up-${uploadId}`
  const sidecar = resumeSidecarName(staging)
  const hasIdentity = typeof request.identity === 'string' && request.identity !== ''
  const outcome = await engine.withSftp(alias, async (sftp) => {
    // The same fence the raw route applies, before anything is staged: this is
    // a second door to the same write, so it owes the same refusal.
    await fenceUploadTarget(sftp, alias, remotePath, router?.roots)
    if (request.probe === true) {
      // A probe is the only request that may run before a byte is sent. It
      // answers where a previous attempt stopped, and it discards a staged
      // prefix the caller cannot prove belongs to the source it is sending now.
      const staged = await sftpStatOrNull(sftp, staging)
      const record = parseResumeRecord(await readUploadText(sftp, sidecar))
      const plan = planResume({
        partialBytes: staged?.size ?? 0,
        recordedIdentity: record?.identity,
        currentIdentity: request.identity,
        totalBytes: Number.isInteger(request.totalBytes) ? request.totalBytes : 0,
      })
      if (plan.resume !== true && (staged?.size ?? 0) > 0) {
        try { await sftpUnlink(sftp, staging) } catch { /* already gone */ }
        try { await sftpUnlink(sftp, sidecar) } catch { /* already gone */ }
      }
      return {
        bytes: plan.resume === true ? plan.offset : 0,
        offset: plan.resume === true ? plan.offset : 0,
        resume: plan.resume === true,
        reason: plan.reason,
        ...(plan.resume === true ? {} : { discarded: (staged?.size ?? 0) > 0 }),
      }
    }
    if (abort === true) {
      try { await sftpUnlink(sftp, staging) } catch { /* nothing was staged */ }
      try { await sftpUnlink(sftp, sidecar) } catch { /* nothing was staged */ }
      return { aborted: true }
    }
    await sftpMkdirp(sftp, remoteParentOf(remotePath), remotePath)

    // Before the FIRST byte of an attempt (and again before publication), the
    // destination's current state decides what "overwrite" means. A retry that
    // starts at a staged offset still runs this check at publication, because
    // the destination may have changed while the transfer was paused.
    const decide = async () => await decideConflict({
      policy: normalizeConflictPolicy(request.onConflict),
      exists: (await sftpStatOrNull(sftp, remotePath)) !== null,
      destination: remotePath,
      existsAt: async candidate => (await sftpStatOrNull(sftp, candidate)) !== null,
    })
    if (offset === 0) {
      const decision = await decide()
      if (decision.action === 'skip') return { bytes: 0, skipped: true, note: decision.note }
      if (decision.action === 'refuse') throw new Error(decision.note ?? 'the destination already exists')
    }

    if (offset > 0) {
      // The staged prefix must be EXACTLY the bytes the caller believes are
      // there: a missing file is a restart, and a length mismatch means the
      // caller's offset would either duplicate or skip a region.
      const info = await sftpStatOrNull(sftp, staging)
      if (info === null) throw codedError(`${remotePath}.dsh-up-${uploadId} has gone — start the upload again`, 'FS_NOT_FOUND')
      if (typeof info.size === 'number' && info.size !== offset) {
        throw codedError(`the staged upload holds ${info.size} bytes, not ${offset} — start the upload again`, 'FS_CONFLICT')
      }
      if (hasIdentity) {
        const record = parseResumeRecord(await readUploadText(sftp, sidecar))
        if (record === undefined) throw codedError('the staged upload has no identity record — start the upload again', 'FS_NOT_FOUND')
        if (record.identity !== request.identity) {
          // The prefix is from another source; appending this attempt's tail
          // would produce a right-length file with wrong content.
          try { await sftpUnlink(sftp, staging) } catch { /* already gone */ }
          try { await sftpUnlink(sftp, sidecar) } catch { /* already gone */ }
          throw codedError('the source changed since the staged bytes were written — start the upload again', 'FS_CONFLICT')
        }
      }
    }

    if (hasIdentity) {
      await writeUploadText(sftp, sidecar, JSON.stringify({
        ...resumeRecord({
          identity: request.identity,
          totalBytes: Number.isInteger(request.totalBytes) ? request.totalBytes : 0,
          source: remotePath,
        }),
        ...(typeof request.sha256 === 'string' && request.sha256 !== '' ? { sha256: request.sha256 } : {}),
      }))
    }

    if (bytes.length > 0 || offset === 0) {
      // A zero-byte file still has to EXIST after its single chunk, so offset 0
      // always opens the staging file even when it carries no bytes.
      const handle = await sftpOpenHandle(sftp, staging, offset === 0 ? 'w' : 'r+', remotePath)
      try {
        if (bytes.length > 0) await sftpWriteHandle(sftp, handle, bytes, remotePath, offset)
      } finally {
        await sftpCloseHandle(sftp, handle)
      }
    } else {
      // A later chunk of empty data: nothing to write. The stat above already
      // proved the prefix is there and at the expected offset.
    }
    if (final !== true) return { bytes: offset + bytes.length }

    // Publication re-decides the conflict, so a destination that appeared or
    // changed during a pause is handled by the CURRENT policy, not the one in
    // force when staging began.
    const decision = await decide()
    if (decision.action === 'skip') {
      try { await sftpUnlink(sftp, staging) } catch { /* already gone */ }
      try { await sftpUnlink(sftp, sidecar) } catch { /* already gone */ }
      return { bytes: offset + bytes.length, skipped: true, note: decision.note }
    }
    if (decision.action === 'refuse') throw new Error(decision.note ?? 'the destination already exists')
    const publishTo = decision.path ?? remotePath
    if (publishTo !== remotePath) await fenceUploadTarget(sftp, alias, publishTo, router?.roots)
    await sftpPublishRename(sftp, staging, publishTo, remotePath)
    try { await sftpUnlink(sftp, sidecar) } catch { /* already gone */ }
    return {
      bytes: offset + bytes.length,
      published: true,
      remotePath: publishTo,
      // Verification runs AFTER this sftp callback returns: hashing the remote
      // file needs an exec channel, and holding a write channel while opening
      // another one is a needless constraint on the engine's pool.
      ...(request.verify === true && typeof request.sha256 === 'string' && request.sha256 !== ''
        ? { verifyDigest: request.sha256, verifyPath: publishTo }
        : {}),
    }
  }, { kind: 'write' })

  const { verifyDigest, verifyPath, ...result } = outcome
  if (typeof verifyDigest !== 'string') return result
  const hasher = await findRemoteHasher(engine, alias)
  if (hasher === undefined) {
    return { ...result, verified: false, verification: 'no sha256 tool (sha256sum / shasum / openssl) on the host, so the copy could not be verified' }
  }
  const actual = await hashRemoteFile(engine, alias, verifyPath, hasher)
  const verdict = compareDigests(verifyDigest, actual)
  return verdict.ok
    ? { ...result, verified: true }
    : { ...result, verified: false, verification: verdict.reason }
}

/**
 * Read a small remote text file (the resumable-upload sidecar), or null.
 *
 * @param {object} sftp - SFTP channel.
 * @param {string} remotePath - the text file.
 * @returns {Promise<string|null>} its contents.
 */
async function readUploadText (sftp, remotePath) {
  const info = await sftpStatOrNull(sftp, remotePath)
  if (info === null) return null
  const handle = await sftpOpenHandle(sftp, remotePath, 'r', remotePath)
  try {
    const chunks = []
    let position = 0
    for (;;) {
      const chunk = await sftpReadHandle(sftp, handle, position, 64 * 1024, remotePath)
      if (chunk.length === 0) break
      chunks.push(chunk)
      position += chunk.length
      if (position > 1024 * 1024) break
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    await sftpCloseHandle(sftp, handle)
  }
}

/**
 * Write a small remote text file, replacing it.
 *
 * @param {object} sftp - SFTP channel.
 * @param {string} remotePath - the text file.
 * @param {string} body - its contents.
 * @returns {Promise<void>} resolves once written.
 */
async function writeUploadText (sftp, remotePath, body) {
  const handle = await sftpOpenHandle(sftp, remotePath, 'w', remotePath)
  try {
    await sftpWriteHandle(sftp, handle, Buffer.from(body, 'utf8'), remotePath)
  } finally {
    await sftpCloseHandle(sftp, handle)
  }
}

/**
 * An error that carries an `FsError` code without importing the peer class.
 *
 * `statusForDownloadError` branches on `code`, and the fence already raises a
 * real `FsError` with `FS_PERMISSION_DENIED` (detached) or `FS_OUTSIDE_WORKSPACE`
 * (unmounted) — so the two failures that this file raises itself must use the
 * same vocabulary, or a missing file would answer 500 and read as a server fault.
 *
 * @param {string} message - what went wrong, for the user.
 * @param {string} code - the `FsError` code.
 * @returns {Error} the error to throw.
 */
function codedError (message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * Open one remote file for chunked reading.
 *
 * @param {object} engine - live engine.
 * @param {string} alias - host alias.
 * @param {string} remotePath - absolute remote path.
 * @param {object} [router] - the filesystem router, used for the detached fence.
 * @returns {Promise<{size: number, chunks: AsyncGenerator<Buffer>}>} the size and a chunk stream.
 */
async function openRemoteRead (engine, alias, remotePath, router) {
  router?.assertEnabled?.(alias, remotePath)
  return await engine.withSftp(alias, async (sftp, record) => {
    const info = await sftpStatOrNull(sftp, remotePath)
    if (info === null) throw codedError(`remote file does not exist: ${remotePath}`, 'FS_NOT_FOUND')
    if (typeof info.isDirectory === 'function' && info.isDirectory()) {
      throw codedError(`not a file: ${remotePath}`, 'FS_NOT_REGULAR_FILE')
    }
    const size = typeof info.size === 'number' ? info.size : 0
    // Pin the connection for as long as the stream is open.
    //
    // `withSftp` tracks its callback with `inFlight`, which is decremented when
    // the callback RETURNS — but this callback returns a generator, so the read
    // happens afterwards. Between those two moments the record looked idle, and
    // a download slower than `engine.idleTimeoutMs` (30 minutes by default)
    // would have its connection reaped mid-transfer: the remaining chunks come
    // from a closed SFTP channel. `holds` is the sweeper's long-lived-consumer
    // counter, the same one open port forwards and persistent shells use, so
    // pinning here is the existing mechanism rather than a new one.
    let held = record !== undefined && record !== null && typeof record.holds === 'number'
    if (held) {
      record.holds += 1
      record.idleAt = Date.now()
    }
    const releaseHold = () => {
      if (!held) return
      held = false
      record.holds = Math.max(0, record.holds - 1)
      record.idleAt = Date.now()
    }
    let handle
    try {
      handle = await sftpOpenHandle(sftp, remotePath, 'r', remotePath)
    } catch (error) {
      // Nothing is streaming, so the hold has nothing left to protect.
      releaseHold()
      throw error
    }
    let position = 0
    let closed = false
    const closeOnce = async () => {
      if (closed) return
      closed = true
      try { await sftpCloseHandle(sftp, handle) } catch { /* already gone */ }
      releaseHold()
    }
    async function * generate () {
      try {
        for (;;) {
          const chunk = await sftpReadHandle(sftp, handle, position, 256 * 1024, remotePath)
          if (chunk.length === 0) break
          position += chunk.length
          yield chunk
        }
      } finally {
        await closeOnce()
      }
    }
    return { size, chunks: generate(), close: closeOnce }
  })
}

/** The final path segment, for the downloaded filename. */
function basenameOf (remotePath) {
  const trimmed = String(remotePath).replace(/\/+$/u, '')
  const index = trimmed.lastIndexOf('/')
  return (index < 0 ? trimmed : trimmed.slice(index + 1)).replaceAll('"', '_') || 'download'
}

/**
 * A `Content-Disposition` value that node will actually accept.
 *
 * Header values are Latin-1 at most (RFC 7230 §3.2), while a remote file name
 * is UTF-8. Putting the name straight into the header made `res.writeHead`
 * throw `ERR_INVALID_CHAR ("Invalid character in header content")` — and since
 * that throw happens AFTER the status and length were prepared, the caller saw
 * a 500 whose body claimed the file was missing bytes. Every download of a file
 * whose name was not ASCII failed this way: measured on a real
 * `dzfp_…_戚盈凯_….pdf`, 149 605 bytes, which never left the host.
 *
 * The portable form is two halves (RFC 6266 §4.2 + RFC 5987): an ASCII fallback
 * every client understands, and the real name percent-encoded in `filename*`
 * for the clients that do. The fallback is not decoration — it is what keeps
 * the header valid at all.
 *
 * Control characters are replaced rather than removed: a `\r\n` smuggled into a
 * remote name must never become a header line, but deleting it would also run
 * the two halves of the name together — `evil\r\nx.txt` becoming `evilx.txt`
 * silently misnames the file. A placeholder keeps its shape.
 *
 * @param {'attachment'|'inline'} type - the disposition kind.
 * @param {string} name - the file name to offer.
 * @returns {string} a header value that is pure ASCII.
 */
function contentDispositionValue (type, name) {
  const clean = String(name ?? '').replace(/[\u0000-\u001f\u007f]/gu, '_')
  // `"` and `\` cannot survive inside the quoted-string form, and anything
  // above printable ASCII cannot survive in a header at all.
  const fallback = clean.replace(/[^\x20-\x7e]/gu, '_').replace(/["\\]/gu, '_') || 'download'
  // ASCII names keep their exact previous spelling, so nothing that already
  // worked changes shape.
  if (fallback === clean) return `${type}; filename="${fallback}"`
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(clean)}`
}

/**
 * RFC 5987 `value-chars`: percent-encoded UTF-8, over the `attr-char` set.
 *
 * `encodeURIComponent` already covers the encoding; the four characters it
 * leaves bare that the RFC does not allow in `attr-char` are escaped here.
 *
 * A lone surrogate (possible when a remote name round-trips through a decoder
 * that kept half a pair) makes `encodeURIComponent` throw `URIError`, which
 * would turn a download into the same 500 this helper exists to prevent. Such
 * code units are replaced rather than propagated — the extended name loses one
 * character, the download works.
 *
 * @param {string} value - the raw file name.
 * @returns {string} a header-safe percent-encoding.
 */
function encodeRfc5987 (value) {
  let encoded
  try {
    encoded = encodeURIComponent(value)
  } catch {
    encoded = encodeURIComponent(value.replace(/[\ud800-\udfff]/gu, '_'))
  }
  return encoded.replace(/['()*]/gu, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
}

/**
 * Validate a port a saved mapping may name.
 *
 * Distinct from the transient route's parser: a saved mapping is a promise
 * about a specific local URL, so 0 ("any free port") is not storable.
 *
 * @param {number} value - the candidate.
 * @param {string} label - field name for the error.
 * @returns {number} the port.
 * @throws {Error} when out of range.
 */
function requireStoredPort (value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${label} must be an integer between 1 and 65535`)
  }
  return value
}

/**
 * Turn a failed port probe into the sentence the panel shows.
 *
 * The two codes a user can actually act on are named; everything else keeps the
 * raw code so a bug report is still diagnosable.
 *
 * @param {string} host - the local interface probed.
 * @param {number} port - the local port probed.
 * @param {string | undefined} code - the bind error code.
 * @returns {string} the explanation.
 */
function describeProbeFailure (host, port, code) {
  if (code === 'EADDRINUSE') return `local port ${port} on ${host} is already in use`
  if (code === 'EACCES') return `local port ${port} on ${host} is not bindable (permission denied or reserved by the system)`
  if (code === 'EADDRNOTAVAIL') return `local address ${host} does not exist on this machine`
  return `local port ${port} on ${host} cannot be bound${code === undefined ? '' : ` (${code})`}`
}
