/**
 * Reverse port forwarding: `ssh -R`, implemented over the pooled connection.
 *
 * ## What makes it different from `-L`
 *
 * Forward forwarding (`forward.js`) binds a LOCAL listener and dials the remote
 * side for each accepted connection. Reverse forwarding is the mirror: the
 * REMOTE host binds a listener, and every connection there is forwarded back
 * here, where this process opens the local target. That inversion changes what
 * the security story has to say:
 *
 *   - the listening port lives on the remote host, so **anyone who can reach
 *     that port on that host can reach the local service** — including the
 *     remote host's other users. `ssh -R` defaults to loopback for exactly this
 *     reason, and so does this module: binding a non-loopback remote address is
 *     opt-in and reported.
 *   - the tunnel is authenticated by the SSH session, not by the local service,
 *     so the local target sees no credentials of the remote caller.
 *
 * ## Why the lifecycle is bound to the connection
 *
 * A remote listener is server-side state. If this process goes away without
 * cancelling it, the port stays bound on the remote host until the SSH session
 * ends — which is exactly what a user who closed the panel does not expect.
 * Every reverse forward therefore registers a `cancel` request with the remote
 * side and is torn down with its record, in the same place forward forwards are.
 *
 * @module @shiqyka/dsh-ssh-workspace/reverse-forward
 */

import { connect } from 'node:net'

import { KINDS } from './diagnostics.js'

/**
 * Validate a port number.
 *
 * @param {unknown} value - the candidate.
 * @param {string} label - field name for the error.
 * @param {object} [options] - validation options.
 * @param {boolean} [options.allowZero] - whether 0 (server-assigned) is legal.
 * @returns {number} the port.
 * @throws {Error} when out of range or not an integer.
 */
function requirePort (value, label, options = {}) {
  const min = options.allowZero === true ? 0 : 1
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > 65535) {
    throw new Error(`${label} must be an integer between ${min} and 65535`)
  }
  return value
}

/** A host literal, falling back when blank. */
function normalizedHost (value, fallback) {
  if (typeof value !== 'string' || value.trim() === '') return fallback
  return value.trim()
}

/**
 * Whether a remote bind address is reachable from beyond the host itself.
 *
 * `127.0.0.1`, `::1` and `localhost` are loopback: only processes ON the remote
 * host can reach the port. Anything else — `0.0.0.0`, `::`, a LAN address, the
 * host's own name — exposes the tunnel to whoever can route to it, which for a
 * public server means the internet. The panel says so instead of leaving the
 * user to infer it from an address they copy-pasted.
 *
 * @param {string} host - the remote bind address.
 * @returns {boolean} true when the port is exposed beyond the host.
 */
export function isExposedBind (host) {
  const value = String(host ?? '').trim().toLowerCase()
  if (value === '' || value === 'localhost' || value === '::1' || value === '[::1]') return false
  if (value === '127.0.0.1' || value === '127.1') return false
  // Any other 127.x.y.z is loopback too (Linux and Windows map 127/8).
  if (/^127\.\d+\.\d+\.\d+$/u.test(value)) return false
  return true
}

/**
 * Owns every reverse forward: the remote listeners this process asked for, and
 * the local connections they turn into.
 */
export class ReverseForwardManager {
  /**
   * @param {object} options - manager options.
   * @param {import('./engine.js').SshWorkspaceEngine} options.engine - live engine.
   * @param {object} [options.logger] - Cordis logger, when available.
   * @param {(entry: object, reason: string) => void} [options.onClosed] - called
   *   after a listener is cancelled for any reason.
   */
  constructor (options) {
    this.engine = options.engine
    this.logger = options.logger
    this.onClosed = typeof options.onClosed === 'function' ? options.onClosed : undefined
    /** @type {Map<string, object>} id → reverse forward entry. */
    this.forwards = new Map()
    this.counter = 0
    this.disposed = false
  }

  /**
   * Ask the remote host to listen, forwarding each connection to a local port.
   *
   * @param {string} alias - host alias.
   * @param {object} options - the mapping.
   * @param {number} options.localPort - port on THIS machine to hand connections to.
   * @param {number} options.remotePort - port the REMOTE host should listen on.
   * @param {string} [options.remoteHost] - remote interface to bind (default 127.0.0.1).
   * @param {string} [options.localHost] - local host to dial (default 127.0.0.1).
   * @param {string} [options.id] - stable id for a saved mapping.
   * @returns {Promise<object>} the forward description.
   */
  async open (alias, options = {}) {
    if (this.disposed) throw new Error('ssh-workspace reverse-forward manager is disposed')
    const target = typeof alias === 'string' ? alias.trim() : ''
    if (target === '') throw new Error('alias is required')
    const localPort = requirePort(options.localPort, 'localPort')
    // Port 0 asks the SERVER to pick, which is the only honest way to expose a
    // tunnel without colliding with something already on the remote host.
    const remotePort = requirePort(options.remotePort, 'remotePort', { allowZero: true })
    const remoteHost = normalizedHost(options.remoteHost, '127.0.0.1')
    const localHost = normalizedHost(options.localHost, '127.0.0.1')
    const stableId = typeof options.id === 'string' && options.id.trim() !== '' ? options.id.trim() : undefined

    for (const entry of this.forwards.values()) {
      if (entry.alias === target && entry.localHost === localHost && entry.localPort === localPort
        && entry.remoteHost === remoteHost && entry.remotePort === remotePort) {
        return { ...this.#describe(entry), reused: true }
      }
    }
    if (stableId !== undefined) {
      const previous = this.forwards.get(stableId)
      if (previous !== undefined) this.#teardown(previous, 'reopened under the same saved id')
    }

    const record = await this.engine.acquire(target)
    this.counter += 1
    const entry = {
      id: stableId ?? `rfwd-${this.counter}`,
      alias: target,
      record,
      localHost,
      localPort,
      remoteHost,
      remotePort,
      /** The port the SERVER actually bound (differs from remotePort when 0 was asked). */
      boundRemotePort: remotePort,
      sockets: new Set(),
      connections: 0,
      state: 'opening',
      cancel: undefined,
    }

    // The remote listener. ssh2 surfaces `tcp connection` for each inbound
    // channel and hands back the destination it was asked for; requesting the
    // forward is a separate round trip that also learns the assigned port.
    const bound = await new Promise((resolve, reject) => {
      const onError = (error) => reject(error instanceof Error ? error : new Error(String(error)))
      record.client.once('error', onError)
      record.client.forwardIn(remoteHost, remotePort, (error, assignedPort) => {
        record.client.off('error', onError)
        if (error !== undefined && error !== null) {
          reject(new Error(`the remote host refused to listen on ${remoteHost}:${remotePort}: ${error.message ?? String(error)}`))
          return
        }
        resolve(typeof assignedPort === 'number' && assignedPort > 0 ? assignedPort : remotePort)
      })
    }).catch((error) => {
      throw error
    })
    entry.boundRemotePort = bound
    entry.state = 'open'

    // Every inbound remote connection becomes a local dial.
    //
    // No destination filter here, deliberately: ssh2 only emits `tcp
    // connection` for a `forwarded-tcpip` whose destination matches a forward
    // THIS client registered (`_forwarding` lookup in client.js), and it
    // rewrites `destPort` to the assigned port when 0 was requested. Filtering
    // again would be a second, weaker copy of a rule the library already
    // enforces — and getting it wrong would drop live connections into a
    // rejected channel with no error to show for it.
    const onTcp = (details, accept, reject) => {
      if (entry.state !== 'open') {
        try { reject() } catch { /* channel already gone */ }
        return
      }
      const upstream = connect({ host: localHost, port: localPort })
      const socket = accept()
      entry.sockets.add(socket)
      entry.connections += 1
      socket.on('close', () => { entry.sockets.delete(socket) })
      upstream.once('connect', () => {
        socket.pipe(upstream).pipe(socket)
      })
      upstream.once('error', () => {
        // The LOCAL target refused or is unreachable. The remote caller must
        // see a closed channel rather than a hang.
        try { socket.close() } catch { /* already gone */ }
        try { upstream.destroy() } catch { /* already gone */ }
      })
      socket.on('error', () => { try { upstream.destroy() } catch { /* already gone */ } })
      socket.on('close', () => { try { upstream.destroy() } catch { /* already gone */ } })
    }
    record.client.on('tcp connection', onTcp)
    entry.cancel = () => {
      try { record.client.off('tcp connection', onTcp) } catch { /* client gone */ }
      // Release the REMOTE listener. This is server-side state: skipping it
      // leaves the port bound on the remote host until the whole SSH session
      // ends, which is not what closing the panel means. `unforwardIn` must be
      // given the port the SERVER bound — ssh2 keys its own table by the
      // assigned port when 0 was requested, so the requested one would not
      // match and the cancel would silently do nothing.
      try {
        record.client.unforwardIn?.(remoteHost, entry.boundRemotePort, () => {})
      } catch { /* connection already gone: the server drops the bind with it */ }
    }
    this.forwards.set(entry.id, entry)
    const description = this.#describe(entry)
    this.logger?.info?.(`ssh-workspace: reverse-forwarding ${entry.remoteHost}:${entry.boundRemotePort} on ${target} → ${localHost}:${localPort}`)
    this.engine?.diagnostics?.record(
      KINDS.forward,
      `reverse-forwarding ${entry.remoteHost}:${entry.boundRemotePort} on ${target} → ${localHost}:${localPort}${isExposedBind(entry.remoteHost) ? ' (exposed beyond the remote host)' : ''}`,
      { alias: entry.alias },
    )
    return description
  }

  /**
   * Close one reverse forward and release its remote listener.
   *
   * @param {string} id - the forward id.
   * @returns {boolean} whether the id named an open forward.
   */
  close (id) {
    const entry = this.forwards.get(String(id))
    if (entry === undefined) return false
    this.#teardown(entry, 'closed by caller')
    return true
  }

  /**
   * Close every reverse forward riding one host.
   *
   * @param {string} alias - the host alias.
   * @param {string} [reason] - why they went away.
   * @returns {number} how many were closed.
   */
  closeForAlias (alias, reason = 'SSH connection closed') {
    const target = typeof alias === 'string' ? alias.trim() : ''
    if (target === '') return 0
    const doomed = [...this.forwards.values()].filter(entry => entry.alias === target)
    for (const entry of doomed) this.#teardown(entry, reason)
    return doomed.length
  }

  /** Describe every open reverse forward. @returns {object[]} descriptions. */
  list () {
    return [...this.forwards.values()].map(entry => this.#describe(entry))
  }

  /** Close every reverse forward; the manager is unusable afterwards. */
  dispose () {
    this.disposed = true
    for (const entry of [...this.forwards.values()]) this.#teardown(entry, 'plugin unloaded')
  }

  /** The public shape of one entry. */
  #describe (entry) {
    return {
      id: entry.id,
      alias: entry.alias,
      direction: 'reverse',
      localHost: entry.localHost,
      localPort: entry.localPort,
      remoteHost: entry.remoteHost,
      // What the SERVER bound, which is the only number that can be dialed when
      // 0 was requested.
      remotePort: entry.boundRemotePort,
      requestedRemotePort: entry.remotePort,
      state: entry.state,
      connections: entry.connections,
      exposed: isExposedBind(entry.remoteHost),
    }
  }

  /** Tear one entry down once. */
  #teardown (entry, reason) {
    if (entry.state === 'closed') return
    entry.state = 'closed'
    this.forwards.delete(entry.id)
    try { entry.cancel?.() } catch { /* already gone */ }
    for (const socket of entry.sockets) {
      try { socket.close?.() } catch { /* already gone */ }
    }
    entry.sockets.clear()
    this.logger?.info?.(`ssh-workspace: reverse forward ${entry.id} closed (${reason})`)
    try { this.onClosed?.(entry, reason) } catch { /* a consumer error must not block teardown */ }
  }
}
