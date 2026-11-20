/**
 * The shared plumbing every route module builds on.
 *
 * Four things live here because every route needs them and no route owns them:
 * the access fence (who may call these endpoints at all), the two guards that
 * apply it, the JSON response writer, and the error-code-to-status mapping that
 * makes a failure a non-2xx answer instead of a 200 with `ok: false` inside.
 *
 * They are in one module rather than in `routes.js` for the same reason the
 * route handlers are being split out: the fence is the part of this plugin that
 * a reader must be able to audit in one sitting. A fence stated once, in one
 * file, with the two byte-streaming endpoints re-applying the SAME
 * `accessRefusal` rather than a second copy of the rules, is a fence that can be
 * checked. The previous shape had it stated once too, but inside a 1 856-line
 * function where the two re-applications sat 1 200 lines apart.
 *
 * @module @shiqyka/dsh-ssh-workspace/routes/kit
 */

import os from 'node:os'

/**
 * The access policy one route set enforces.
 *
 * @typedef {object} AccessPolicy
 * @property {boolean} allowLan - whether private-network origins are admitted.
 * @property {string[]} allowedHosts - normalized (lowercase, trimmed) extra Host values.
 */

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
export function accessRefusal (req, policy) {
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
export function isJsonContentType (req) {
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
export function isRawContentType (req) {
  return mediaTypeOf(req) === 'application/octet-stream'
}

/**
 * The declared media type without parameters, lowercased.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {string} the type, or '' when absent.
 */
export function mediaTypeOf (req) {
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
export function statusForDownloadError (error) {
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
export function writeJson (res, status, body) {
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
export function statusForActionError (error, fallback = 500) {
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
export async function readJsonBody (req) {
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

/** Extract a decoded query parameter. */
export function queryParam (url, name) {
  const value = url.searchParams.get(name)
  return value === null ? undefined : value
}

/**
 * A query parameter, trimmed; absent and whitespace-only both become `''`.
 *
 * The callers below all need the same three things from a string parameter —
 * decode it, treat `null` as empty, and reject a value that is only spaces —
 * and eleven hand-written `(url.searchParams.get(x) ?? '').trim()` copies had
 * drifted into two shapes (some defaulted, some did not). One helper keeps the
 * rule in one place; `queryParam` stays the raw accessor for the cases that
 * genuinely need to tell `null` from `''`.
 *
 * @param {URL} url - the parsed request URL.
 * @param {string} name - the parameter name.
 * @returns {string} the trimmed value, or `''`.
 */
export function trimmedParam (url, name) {
  return (queryParam(url, name) ?? '').trim()
}

/**
 * Build the two request guards from one access policy.
 *
 * `guard` is the ordinary JSON endpoint guard: fence, method, JSON content
 * type. `guardRaw` is the one the two byte-streaming endpoints use, and it
 * differs in exactly one way — the media type it requires. That difference is
 * the point: a browser cannot send `application/octet-stream` from a form, and
 * a `fetch` that sets it triggers the preflight this server never approves.
 * Building them together means the CSRF premise is stated once for each shape
 * instead of re-derived at every raw endpoint, and a future byte-carrying route
 * cannot quietly omit it.
 *
 * @param {AccessPolicy} accessPolicy - the resolved access policy.
 * @returns {{guard: Function, guardRaw: Function, refuseUnlessAllowed: Function}} the guards.
 */
export function makeGuards (accessPolicy) {
  /**
   * The ordinary guard: fence, method, JSON content type.
   *
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   * @param {'GET'|'POST'} method - the method this endpoint accepts.
   * @returns {boolean} true when the request may proceed.
   */
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

  // The download/upload fences answer with a bare "forbidden" rather than the
  // detailed wording (their responses stream bytes, and the browser-side
  // download flow surfaces the JSON body only as a failure blob). The verdict
  // itself is the same `accessRefusal` the shared guard applies.
  /**
   * The fence alone, with the terse body the byte-streaming routes use.
   *
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   * @returns {boolean} true when the request may proceed.
   */
  function refuseUnlessAllowed (req, res) {
    const refusal = accessRefusal(req, accessPolicy)
    if (refusal === undefined) return true
    writeJson(res, 403, { error: 'forbidden' })
    return false
  }

  return { guard, guardRaw, refuseUnlessAllowed }
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
export function abortOnClientGone (res) {
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
 * An `Error` carrying the `FsError` code the status mappers read.
 *
 * The route family reports failures with the same codes the filesystem layer
 * raises (`FS_NOT_FOUND`, `FS_OUTSIDE_WORKSPACE`, …) — so the two failures
 * this file raises itself must use the same vocabulary, or a missing file would
 * answer 500 and read as a server fault.
 *
 * @param {string} message - what went wrong, for the user.
 * @param {string} code - the `FsError` code.
 * @returns {Error} the error to throw.
 */
export function codedError (message, code) {
  const error = new Error(message)
  error.code = code
  return error
}
