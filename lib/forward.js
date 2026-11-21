import { randomBytes } from 'node:crypto'
import { connect, createServer } from 'node:net'

import { KINDS } from './diagnostics.js'

/**
 * Port forwarding in both directions, plus the saved mappings that outlive them.
 *
 * ## The two directions are mirrors, and the asymmetry is the point
 *
 * Forward (`ssh -L`) binds a LOCAL listener and, for every accepted connection,
 * opens a fresh `direct-tcpip` channel to the remote target through the host's
 * pooled ssh2 client. Reverse (`ssh -R`) inverts that: the REMOTE host binds a
 * listener and every connection there comes back here, where this process opens
 * the local target. The inversion changes what the security story has to say —
 * a reverse forward's listening port lives on the remote host, so anyone who can
 * reach that port there can reach the local service, which is why `ssh -R`
 * defaults to loopback and so does this module; binding a non-loopback remote
 * address is opt-in and reported.
 *
 * Both accept the same four fields (`localPort`, `remotePort`, `localHost`,
 * `remoteHost`) under the same rules, which is why {@link requirePort} and
 * {@link normalizedHost} are shared rather than duplicated. They had grown
 * byte-identical copies, and one copy means "port 0 is legal here but not there"
 * can only happen once. Port 0 is legal only when the caller says so, because
 * the two directions disagree about what it MEANS: a local forward on 0 asks the
 * OS to pick, a reverse forward on 0 asks the SSH server to pick.
 *
 * ## And then there is the intent
 *
 * `ForwardManager` owns listeners and nothing else — its table is memory-only,
 * because a tunnel that outlived its SSH connection would be a dead pipe. That
 * is the right lifetime for the tunnel and the wrong one for the INTENT: a user
 * who maps 5173→5173 for a dev server wants that mapping back after a restart.
 * {@link SavedForwardManager} therefore keeps the two apart — the store holds
 * which mapping and whether the user wants it on; the manager holds whether a
 * listener is bound right now — and the panel renders the join of the two, so a
 * button never lies: "close" is shown only when a listener exists, "open" only
 * when it does not.
 *
 * ## Why one file
 *
 * These were four (`forward`, `forward-common`, `reverse-forward`,
 * `forward-persist`), and FF-04 wrote "do not merge" because the lifecycles
 * differ. The lifecycles do differ, and that is exactly what the sections below
 * spell out — but they are four answers about ONE subject: a mapping of a port
 * somewhere to a port somewhere else, whether it is bound, and whether it should
 * be. The shared validators were already the common base; splitting the rest
 * only made "port validation" and "how a port is connected" each own a file.
 *
 * @module @shiqyka/dsh-ssh-workspace/forward
 */

// ---------------------------------------------------------------------------
// The validators both directions share
// ---------------------------------------------------------------------------
/**
 * Validate a port number.
 *
 * Port 0 is legal only when the caller says so, because the two directions
 * disagree about what it means: a local forward on port 0 asks the OS to pick,
 * while a reverse forward on port 0 asks the SSH server to pick. Both are
 * useful; neither is a typo to be silently corrected, so the flag is explicit
 * rather than defaulted.
 *
 * @param {unknown} value - the candidate.
 * @param {string} label - field name for the error.
 * @param {object} [options] - validation options.
 * @param {boolean} [options.allowZero] - whether 0 (peer-assigned) is legal.
 * @returns {number} the port.
 * @throws {Error} when out of range or not an integer.
 */
export function requirePort (value, label, options = {}) {
  const min = options.allowZero === true ? 0 : 1
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > 65535) {
    throw new Error(`${label} must be an integer between ${min} and 65535`)
  }
  return value
}

/**
 * A host literal, falling back when blank.
 *
 * Blank and whitespace-only both mean "not given": a form that submits an empty
 * input sends `''`, not `undefined`, and treating that as a host would make the
 * forward bind to something the user never typed.
 *
 * @param {unknown} value - the candidate.
 * @param {string} fallback - used when the candidate is blank.
 * @returns {string} the trimmed host, or the fallback.
 */
export function normalizedHost (value, fallback) {
  if (typeof value !== 'string' || value.trim() === '') return fallback
  return value.trim()
}

// ---------------------------------------------------------------------------
// Forward: a local listener, dialling the remote side
// ---------------------------------------------------------------------------

/** Bind a local port, preferring `port` but falling back to an ephemeral one. */
function listenOn (server, host, port, allowFallback) {
  const attempt = (candidate) => new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen({ host, port: candidate, exclusive: true })
  })
  return attempt(port).catch((error) => {
    if (allowFallback && error?.code === 'EADDRINUSE') return attempt(0)
    throw error
  })
}

/** The port a listening server actually bound. */
function boundPort (entry) {
  const address = entry.server?.address?.()
  if (address !== null && typeof address === 'object' && typeof address.port === 'number') return address.port
  return entry.remotePort
}

/**
 * Check whether a local port can be bound right now.
 *
 * Advisory only: a window always exists between this probe closing its
 * listener and the real forward binding its own, so the authoritative answer is
 * still the error `open()` raises. The probe exists to give the user a precise
 * reason ("the port is taken", "the port is reserved") before anything is
 * attempted, instead of a generic bind failure.
 *
 * @param {string} host - local interface to test.
 * @param {number} port - local port to test.
 * @returns {Promise<{ok: boolean, code?: string, message?: string}>} the verdict.
 */
export async function probeLocalPort (host, port) {
  const server = createServer()
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.once('listening', resolve)
      server.listen({ host, port, exclusive: true })
    })
    return { ok: true }
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : undefined
    return { ok: false, ...(code === undefined ? {} : { code }), message: error instanceof Error ? error.message : String(error) }
  } finally {
    try { server.close() } catch { /* never listening */ }
  }
}

/**
 * Owns every open forward: the local listeners, their accepted sockets, and the
 * connection-pinning bookkeeping that keeps a mapped host from being reaped by
 * the idle sweeper while a forward still uses it.
 */
export class ForwardManager {
  /**
   * @param {object} options - manager options.
   * @param {import('./engine.js').SshWorkspaceEngine} options.engine - live engine.
   * @param {object} [options.logger] - Cordis logger, when available.
   * @param {(entry: object, reason: string) => void} [options.onClosed] - called
   *   after a listener is torn down for any reason. A saved mapping uses this to
   *   record that its tunnel is gone (connection loss, reopen, disposal) without
   *   the manager having to know about the store.
   */
  constructor (options) {
    this.engine = options.engine
    this.logger = options.logger
    this.onClosed = typeof options.onClosed === 'function' ? options.onClosed : undefined
    /** @type {Map<string, object>} id → forward entry. */
    this.forwards = new Map()
    this.counter = 0
    this.disposed = false
  }

  /**
   * Open (or reuse) one local→remote forward.
   *
   * @param {string} alias - host alias.
   * @param {object} options - forward target.
   * @param {number} options.remotePort - port on the remote side.
   * @param {number} [options.localPort] - local port; default the remote port
   *   with an ephemeral fallback when busy; 0 requests an ephemeral port.
   * @param {string} [options.remoteHost] - host the SSH server dials (default 127.0.0.1).
   * @param {string} [options.localHost] - local interface to bind (default 127.0.0.1).
   * @param {string} [options.id] - stable id to file this listener under. A
   *   saved mapping passes its stored id so the panel can join runtime state
   *   onto the saved row; without one an ephemeral `fwd-N` is minted.
   * @param {boolean} [options.strictLocalPort] - refuse to fall back to an
   *   ephemeral port. Required for a saved mapping: the stored URL names the
   *   local port, so silently binding another one would make it wrong.
   * @returns {Promise<object>} the forward description.
   */
  async open (alias, options = {}) {
    if (this.disposed) throw new Error('ssh-workspace engine is disposed')
    const target = typeof alias === 'string' ? alias.trim() : ''
    if (target === '') throw new Error('alias is required')
    const remotePort = requirePort(options.remotePort, 'remotePort')
    const remoteHost = normalizedHost(options.remoteHost, '127.0.0.1')
    const localHost = normalizedHost(options.localHost, '127.0.0.1')
    const explicitLocal = typeof options.localPort === 'number'
    const localPort = explicitLocal ? requirePort(options.localPort, 'localPort', { allowZero: true }) : undefined
    const stableId = typeof options.id === 'string' && options.id.trim() !== '' ? options.id.trim() : undefined
    const strict = options.strictLocalPort === true

    // Opening the same target twice is a no-op, not a second listener: the
    // model may repeat a mapping without needing the earlier id.
    for (const entry of this.forwards.values()) {
      if (entry.alias === target && entry.remoteHost === remoteHost && entry.remotePort === remotePort) {
        return { ...this.#describe(entry), reused: true }
      }
    }
    // The same saved id opening again (a re-enable, or a retry after a failure)
    // replaces the previous listener rather than stacking a second one on the
    // same stored row.
    if (stableId !== undefined) {
      const previous = this.forwards.get(stableId)
      if (previous !== undefined) this.#teardown(previous, 'reopened under the same saved id')
    }

    const record = await this.engine.acquire(target)
    this.counter += 1
    const entry = {
      id: stableId ?? `fwd-${this.counter}`,
      alias: target,
      record,
      remoteHost,
      remotePort,
      localHost,
      server: undefined,
      sockets: new Set(),
      connections: 0,
      state: 'open',
      detachClose: undefined,
    }
    const server = createServer((socket) => { this.#accept(entry, socket) })
    entry.server = server
    try {
      await listenOn(server, localHost, localPort ?? remotePort, localPort === undefined && !strict)
    } catch (error) {
      try { server.close() } catch { /* never listening */ }
      if (error?.code === 'EADDRINUSE') {
        throw new Error(`local port ${localPort ?? remotePort} on ${localHost} is already in use`)
      }
      if (error?.code === 'EACCES') {
        throw new Error(`local port ${localPort ?? remotePort} on ${localHost} is not bindable (permission denied or reserved by the system)`)
      }
      throw error instanceof Error ? error : new Error(String(error))
    }
    // The forward keeps its connection: the idle sweeper must not reap a host
    // that is only being kept alive for a mapped listener.
    record.holds = (record.holds ?? 0) + 1
    const onClose = () => { this.#teardownWhere(entry => entry.record === record, 'SSH connection closed') }
    record.client.once('close', onClose)
    entry.detachClose = () => {
      try { record.client.off('close', onClose) } catch { /* client already gone */ }
    }
    this.forwards.set(entry.id, entry)
    const description = this.#describe(entry)
    this.logger?.info?.(`ssh-workspace: forwarding ${description.localHost}:${description.localPort} → ${target}:${remoteHost}:${remotePort}`)
    this.engine?.diagnostics?.record(KINDS.forward, `forwarding ${description.localHost}:${description.localPort} → ${remoteHost}:${remotePort}`, { alias: entry.alias })
    return description
  }

  /**
   * Close one forward and release its local port.
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
   * Close every forward riding one host, and report how many went.
   *
   * Called when the host's SSH connection is dropped on purpose. The connection
   * already emits `close`, so this is belt-and-braces — but it is the *only*
   * path that tears the tunnels down deterministically: an ssh2 client that is
   * replaced, destroyed without emitting, or faked in a test would otherwise
   * leave listeners bound to a record nobody owns. Requirement: dropping the
   * SSH connection takes its port forwards with it.
   *
   * Closing a forward never touches the connection itself, so the reverse
   * direction (closing a tunnel must not disconnect the host) stays true by
   * construction: this only ever decrements `holds`.
   *
   * @param {string} alias - the host whose forwards go away.
   * @param {string} [reason] - why they went away.
   * @returns {number} how many forwards were closed.
   */
  closeForAlias (alias, reason = 'SSH connection closed') {
    const target = typeof alias === 'string' ? alias.trim() : ''
    if (target === '') return 0
    const doomed = [...this.forwards.values()].filter(entry => entry.alias === target)
    for (const entry of doomed) this.#teardown(entry, reason)
    return doomed.length
  }

  /** Describe every open forward. @returns {object[]} descriptions. */
  list () {
    return [...this.forwards.values()].map(entry => this.#describe(entry))
  }

  /** Close every forward; the manager is unusable afterwards. */
  dispose () {
    this.disposed = true
    for (const entry of [...this.forwards.values()]) this.#teardown(entry, 'plugin unloaded')
  }

  /**
   * Handle one accepted connection: dial it through the forward's own
   * connection and splice the two duplex streams together.
   */
  #accept (entry, socket) {
    if (entry.state !== 'open') {
      socket.destroy()
      return
    }
    entry.sockets.add(socket)
    entry.connections += 1
    let channel
    socket.once('close', () => {
      entry.connections -= 1
      entry.sockets.delete(socket)
      try { channel?.destroy?.() } catch { /* channel already gone */ }
    })
    socket.on('error', () => { /* surface via 'close'; the channel teardown follows */ })
    Promise.resolve(this.engine.acquire(entry.alias)).then((record) => {
      if (socket.destroyed) return
      // The forward is bound to its birth connection: a replacement record
      // means this listener is about to be torn down — refuse the dial.
      if (entry.state !== 'open' || record !== entry.record) {
        socket.destroy()
        return
      }
      record.client.forwardOut(
        socket.remoteAddress ?? '127.0.0.1',
        socket.remotePort ?? 0,
        entry.remoteHost,
        entry.remotePort,
        (error, stream) => {
          if (error !== undefined && error !== null) {
            socket.destroy()
            return
          }
          channel = stream
          if (socket.destroyed) {
            try { stream.destroy?.() } catch { /* stream already gone */ }
            return
          }
          socket.pipe(stream).pipe(socket)
          socket.on('error', () => { try { stream.destroy?.() } catch { /* stream already gone */ } })
          stream.on('error', () => socket.destroy())
          stream.on('close', () => socket.destroy())
        },
      )
    }).catch(() => { socket.destroy() })
  }

  /** Tear down every forward matching a predicate. */
  #teardownWhere (predicate, reason) {
    for (const entry of [...this.forwards.values()]) {
      if (predicate(entry)) this.#teardown(entry, reason)
    }
  }

  /** Tear down one forward: stop listening, drop sockets, release the hold. */
  #teardown (entry, reason) {
    if (entry.state !== 'open') return
    entry.state = 'closed'
    this.forwards.delete(entry.id)
    try { entry.server.close() } catch { /* already closed */ }
    for (const socket of entry.sockets) {
      try { socket.destroy() } catch { /* already gone */ }
    }
    entry.sockets.clear()
    entry.detachClose?.()
    if (typeof entry.record?.holds === 'number') entry.record.holds = Math.max(0, entry.record.holds - 1)
    this.logger?.info?.(`ssh-workspace: forward ${entry.id} (${entry.alias}:${entry.remotePort}) closed: ${reason}`)
    this.engine?.diagnostics?.record(KINDS.forward, `forward ${entry.id} closed: ${reason}`, { alias: entry.alias })
    // Reported last: a listener that failed to bind never got here, so a
    // caller that records this can tell "was open, is now closed" apart from
    // "never opened".
    try { this.onClosed?.(entry, reason) } catch { /* an observer must not break teardown */ }
  }

  /** The caller-facing description of one forward. */
  #describe (entry) {
    return {
      id: entry.id,
      alias: entry.alias,
      state: entry.state,
      localHost: entry.localHost,
      localPort: boundPort(entry),
      remoteHost: entry.remoteHost,
      remotePort: entry.remotePort,
      connections: entry.connections,
      reused: false,
    }
  }
}

/**
 * The saved port-forward section, joined with live runtime state.
 *
 * A saved row carries the user's intent (`enabled`); a live entry carries
 * whether a listener is actually bound. The panel needs both to label a button
 * honestly: a saved-but-closed row must offer "open", and a live row that is
 * not saved must offer "remember" rather than pretending it was.
 *
 * @param {{items: object[], settings: {autoStart: boolean}}} saved - the stored section.
 * @param {object[]} live - `ForwardManager.list()`.
 * @returns {Array<object>} one row per saved mapping, plus live rows that are not saved.
 */
export function joinForwards (saved, live) {
  const byId = new Map()
  for (const entry of live) byId.set(entry.id, entry)
  const rows = []
  const claimed = new Set()
  for (const item of saved.items ?? []) {
    const runtime = byId.get(item.id)
    if (runtime !== undefined) claimed.add(item.id)
    rows.push({
      ...item,
      persisted: true,
      live: runtime !== undefined,
      // The port the listener actually holds is the stored port unless the row
      // was opened without one.
      ...(runtime === undefined
        ? { connections: 0 }
        : { localPort: runtime.localPort, connections: runtime.connections }),
    })
  }
  for (const entry of live) {
    if (claimed.has(entry.id)) continue
    // A live forward with no saved row was opened by the agent (or the old
    // transient form); it is shown but cannot be toggled, only remembered.
    rows.push({
      id: entry.id,
      alias: entry.alias,
      remoteHost: entry.remoteHost,
      remotePort: entry.remotePort,
      localHost: entry.localHost,
      localPort: entry.localPort,
      enabled: true,
      persisted: false,
      live: true,
      connections: entry.connections,
    })
  }
  return rows
}

// ---------------------------------------------------------------------------
// Reverse: a remote listener, dialling back here
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Saved mappings: the intent, which outlives the listener
// ---------------------------------------------------------------------------

/** Why a saved forward's listener went away, for the panel to explain. */
const REASON_CONNECTION = 'SSH connection closed'
const REASON_DISPOSED = 'plugin unloaded'

/**
 * Mint an id for a new saved mapping.
 *
 * Random rather than sequential on purpose: the store is shared by every DSH
 * instance, and a per-process counter would collide across them.
 *
 * @returns {string} a fresh id.
 */
function newForwardId () {
  return `fwd-${randomBytes(4).toString('hex')}`
}

/**
 * Validate a port a user typed for a saved mapping.
 *
 * A saved mapping must name a concrete local port. 0 means "give me any free
 * one", which is meaningless to persist — the stored URL would point at the
 * wrong port on the next start — so it is rejected here rather than silently
 * resolved into something the user did not ask for.
 *
 * @param {unknown} value - the candidate.
 * @param {string} label - field name for the error.
 * @returns {number} the port.
 * @throws {Error} when out of range or not an integer.
 */
function requireSavedPort (value, label) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${label} must be an integer between 1 and 65535`)
  }
  return value
}

/**
 * The saved-forward controller.
 *
 * Every method that changes the store re-reads it under the store's own
 * cross-process lock (store.js), so two DSH instances editing the same forward
 * list cannot clobber each other.
 */
export class SavedForwardManager {
  /**
   * @param {object} options - controller options.
   * @param {import('./forward.js').ForwardManager} options.forwards - the live manager.
   * @param {import('./store.js').HostConfigStore} options.store - the editable store.
   * @param {object} [options.logger] - Cordis logger, when available.
   */
  constructor (options) {
    this.forwards = options.forwards
    this.store = options.store
    this.logger = options.logger
    /**
     * Why each saved forward's listener last disappeared. Cleared on a
     * successful open; surfaced in the panel so "connection lost" is not
     * indistinguishable from "you turned it off".
     *
     * @type {Map<string, string>}
     */
    this.failures = new Map()
    this.autoStaring = false
  }

  /** Every forward row: saved mappings joined with live listeners. */
  list () {
    let saved
    try {
      saved = this.store.forwards()
    } catch (error) {
      this.logger?.warn?.(`ssh-workspace: could not read saved forwards: ${error instanceof Error ? error.message : String(error)}`)
      saved = { settings: { autoStart: false }, items: [] }
    }
    const rows = joinForwards(saved, this.forwards.list())
    return rows.map((row) => {
      const failure = this.failures.get(row.id)
      return failure === undefined ? row : { ...row, error: failure }
    })
  }

  /** The saved preferences. @returns {{autoStart: boolean}} the settings. */
  settings () {
    try {
      return this.store.forwards().settings
    } catch {
      return { autoStart: false }
    }
  }

  /**
   * Store the auto-start preference.
   *
   * @param {boolean} autoStart - whether enabled mappings open on startup.
   * @returns {{autoStart: boolean}} the stored settings.
   */
  setAutoStart (autoStart) {
    return { autoStart: this.store.setForwardAutoStart(autoStart === true) }
  }

  /**
   * Save a new mapping, optionally opening it immediately.
   *
   * The local port is checked before anything is written: a mapping that cannot
   * bind should not be left in the store looking healthy.
   *
   * @param {object} input - the requested mapping.
   * @param {string} input.alias - host alias.
   * @param {number} input.remotePort - remote port.
   * @param {number} input.localPort - local port.
   * @param {string} [input.remoteHost] - host the SSH server dials.
   * @param {string} [input.localHost] - local interface to bind.
   * @param {boolean} [input.open] - open the tunnel now (default true).
   * @returns {Promise<object>} the stored entry plus its runtime state.
   * @throws {Error} when the mapping is invalid or the local port is busy.
   */
  async create (input) {
    const alias = typeof input?.alias === 'string' ? input.alias.trim() : ''
    if (alias === '') throw new Error('alias is required')
    const remotePort = requireSavedPort(input?.remotePort, 'remotePort')
    const localPort = requireSavedPort(input?.localPort, 'localPort')
    const entry = {
      id: newForwardId(),
      alias,
      remoteHost: typeof input?.remoteHost === 'string' && input.remoteHost.trim() !== '' ? input.remoteHost.trim() : '127.0.0.1',
      remotePort,
      localPort,
      localHost: typeof input?.localHost === 'string' && input.localHost.trim() !== '' ? input.localHost.trim() : '127.0.0.1',
      enabled: input?.open !== false,
      createdAt: Date.now(),
    }
    // The local port is checked BEFORE anything is written. A mapping that
    // cannot bind must not reach the store looking healthy: the panel would
    // then show a saved row whose URL never worked, and the next auto-start
    // would fail on a mistake the user already saw fail.
    //
    // The probe is advisory (the port can be taken between the check and the
    // bind); the authoritative refusal is the one the bind itself raises, which
    // is why `openById` still handles it below.
    const probe = await probeLocalPort(entry.localHost, entry.localPort)
    if (!probe.ok) {
      throw new Error(probe.code === 'EADDRINUSE'
        ? `local port ${entry.localPort} on ${entry.localHost} is already in use`
        : `local port ${entry.localPort} on ${entry.localHost} cannot be bound (${probe.code ?? 'unknown error'})`)
    }
    // Saved first, opened second: if the open fails the row still exists with
    // `enabled` set, so the panel shows it and the user can retry instead of
    // retyping the mapping.
    this.store.putForward(entry)
    if (entry.enabled) {
      try {
        await this.openById(entry.id, { strict: true })
      } catch (error) {
        this.failures.set(entry.id, error instanceof Error ? error.message : String(error))
      }
    }
    return this.rowById(entry.id)
  }

  /**
   * Open one saved mapping's listener.
   *
   * @param {string} id - the saved id.
   * @param {object} [options] - open options.
   * @param {boolean} [options.strict] - refuse an ephemeral fallback (default true).
   * @returns {Promise<object>} the resulting row.
   * @throws {Error} when the mapping is missing or the listener cannot bind.
   */
  async openById (id, options = {}) {
    const entry = this.#savedEntry(id)
    if (entry === undefined) throw new Error(`saved forward ${JSON.stringify(id)} does not exist`)
    try {
      await this.forwards.open(entry.alias, {
        id: entry.id,
        remotePort: entry.remotePort,
        remoteHost: entry.remoteHost,
        localHost: entry.localHost,
        localPort: entry.localPort,
        // A saved mapping pins its local port: the stored URL names it.
        strictLocalPort: options.strict !== false,
      })
      this.failures.delete(entry.id)
      this.store.setForwardEnabled(entry.id, true)
    } catch (error) {
      this.failures.set(entry.id, error instanceof Error ? error.message : String(error))
      throw error
    }
    return this.rowById(entry.id)
  }

  /**
   * Close one saved mapping's listener but keep the mapping and its `enabled`
   * flag as the user set it.
   *
   * Closing a saved forward means "stop the tunnel", not "forget it"; the panel
   * has a separate delete for the latter.
   *
   * @param {string} id - the saved id.
   * @returns {object} the resulting row.
   */
  closeById (id) {
    const entry = this.#savedEntry(id)
    if (entry === undefined) throw new Error(`saved forward ${JSON.stringify(id)} does not exist`)
    this.forwards.close(entry.id)
    this.store.setForwardEnabled(entry.id, false)
    this.failures.delete(entry.id)
    return this.rowById(entry.id)
  }

  /**
   * Turn off every tunnel on one host the way the panel's own row button does.
   *
   * A host disconnect is a deliberate user action, so the tunnels it takes down
   * must be left in the state a manual close leaves them in: intent off, no
   * recorded failure. Reaching for `ForwardManager.closeForAlias()` instead
   * keeps the intent on and records "SSH connection closed", which the panel
   * renders as a red "connection lost" line — telling the user something broke
   * when they asked for it. The two paths stay distinct because the difference
   * is the point: an unplanned drop is explained, a deliberate one is not.
   *
   * Transient tunnels (opened by the agent tool) have no stored intent to
   * clear, so closing their listener is all there is to do.
   *
   * @param {string} alias - the host whose tunnels go away.
   * @returns {number} how many live tunnels were closed.
   */
  closeAlias (alias) {
    const target = typeof alias === 'string' ? alias.trim() : ''
    if (target === '') return 0
    let closed = 0
    // Snapshot up front: `closeById` rewrites the very list this walks.
    for (const row of this.list()) {
      if (row.alias !== target) continue
      if (row.persisted !== true) {
        // A transient tunnel has no stored intent; closing its listener is the
        // whole of the action.
        if (this.forwards.close(row.id) === true) closed += 1
        continue
      }
      const wasLive = row.live === true
      try {
        // Goes through the same method the panel's "close" button uses, so the
        // two paths cannot drift apart.
        this.closeById(row.id)
      } catch { /* the row vanished between list() and close */ }
      if (wasLive) closed += 1
    }
    return closed
  }

  /**
   * Forget a saved mapping, closing its listener first.
   *
   * @param {string} id - the saved id.
   * @returns {boolean} whether a mapping was removed.
   */
  remove (id) {
    this.forwards.close(String(id))
    this.failures.delete(String(id))
    return this.store.deleteForward(String(id))
  }

  /**
   * Save an already-live transient forward under a new mapping.
   *
   * The agent tools open tunnels with ephemeral ids and no local port of their
   * own choosing. Persisting one takes the port the OS actually bound, so the
   * saved row describes the tunnel that exists rather than a guess.
   *
   * @param {string} liveId - the runtime id.
   * @returns {object} the stored row.
   * @throws {Error} when the id names no live forward.
   */
  remember (liveId) {
    const live = this.forwards.list().find(entry => entry.id === String(liveId))
    if (live === undefined) throw new Error(`forward ${JSON.stringify(liveId)} is not open`)
    const entry = {
      id: newForwardId(),
      alias: live.alias,
      remoteHost: live.remoteHost,
      remotePort: live.remotePort,
      localHost: live.localHost,
      localPort: live.localPort,
      enabled: true,
      createdAt: Date.now(),
    }
    this.store.putForward(entry)
    // The listener keeps running under its runtime id; the saved row is a
    // separate identity, so the panel would show two rows for one tunnel.
    // Re-open under the saved id and drop the transient one instead.
    this.forwards.close(String(liveId))
    void this.openById(entry.id, { strict: true }).catch((error) => {
      this.failures.set(entry.id, error instanceof Error ? error.message : String(error))
    })
    return this.rowById(entry.id)
  }

  /**
   * Open every saved mapping whose intent is "on".
   *
   * Runs serially and never throws: a startup that failed because one host is
   * unreachable would be worse than a tunnel that did not come back. Each
   * failure is recorded for the panel and logged once.
   *
   * @returns {Promise<{opened: number, failed: Array<{id: string, error: string}>}>} the outcome.
   */
  async autoStart () {
    if (this.autoStaring) return { opened: 0, failed: [] }
    const settings = this.settings()
    if (settings.autoStart !== true) return { opened: 0, failed: [] }
    let saved
    try {
      saved = this.store.forwards()
    } catch {
      return { opened: 0, failed: [] }
    }
    const wanted = saved.items.filter(entry => entry.enabled)
    if (wanted.length === 0) return { opened: 0, failed: [] }
    this.autoStaring = true
    let opened = 0
    const failed = []
    try {
      // Serial on purpose: several tunnels to the same host share one pooled
      // connection, and a burst of concurrent handshakes is both slower and
      // harder to attribute when one fails.
      for (const entry of wanted) {
        try {
          await this.openById(entry.id, { strict: true })
          opened += 1
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          failed.push({ id: entry.id, error: message })
          this.logger?.warn?.(`ssh-workspace: could not auto-open forward ${entry.id} (${entry.alias}:${entry.remotePort}): ${message}`)
        }
      }
    } finally {
      this.autoStaring = false
    }
    if (opened > 0) this.logger?.info?.(`ssh-workspace: auto-opened ${opened} saved port forward(s)`)
    return { opened, failed }
  }

  /**
   * Whether one host has a saved tunnel whose intent is still "on".
   *
   * Read by the engine's reconnect loop: the listener died with the connection,
   * so nothing pins the host any more, but the stored intent says the user still
   * wants that tunnel — which is the definition of "worth redialing".
   *
   * @param {string} alias - host alias.
   * @returns {boolean} true when at least one enabled mapping names this host.
   */
  hasEnabled (alias) {
    const target = typeof alias === 'string' ? alias.trim() : ''
    if (target === '') return false
    try {
      return this.store.forwards().items.some(entry => entry.alias === target && entry.enabled)
    } catch {
      return false
    }
  }

  /**
   * Re-open the saved tunnels of one host whose listener died with its
   * connection, keeping each row's stored intent.
   *
   * Called after a background reconnect. Without it the SSH link would come
   * back while every saved mapping still showed "connection lost" until the user
   * clicked each one — the reconnect would have fixed the transport and nothing
   * they were actually using.
   *
   * Only rows whose intent is still "on" are opened, serial like `autoStart`
   * (several tunnels share one pooled connection), and a failure is recorded on
   * the row rather than thrown: the connection itself is up and must stay up.
   *
   * @param {string} alias - the host that just reconnected.
   * @returns {Promise<{opened: number, failed: Array<{id: string, error: string}>}>} the outcome.
   */
  async reopenEnabled (alias) {
    const target = typeof alias === 'string' ? alias.trim() : ''
    if (target === '') return { opened: 0, failed: [] }
    let saved
    try {
      saved = this.store.forwards()
    } catch {
      return { opened: 0, failed: [] }
    }
    const wanted = saved.items.filter(entry => entry.alias === target && entry.enabled)
    if (wanted.length === 0) return { opened: 0, failed: [] }
    const open = this.forwards.list()
    let opened = 0
    const failed = []
    for (const entry of wanted) {
      // A listener that survived (it was already back, or never died) must not
      // be reopened: `ForwardManager.open` would treat it as the same target and
      // return the existing one, but skipping is clearer and cheaper.
      if (open.some(live => live.id === entry.id)) continue
      try {
        await this.openById(entry.id, { strict: true })
        opened += 1
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failed.push({ id: entry.id, error: message })
      }
    }
    if (opened > 0) this.logger?.info?.(`ssh-workspace: restored ${opened} port forward(s) on ${target} after reconnecting`)
    return { opened, failed }
  }

  /**
   * Record that a listener disappeared on its own, so the panel can explain it.
   *
   * Wired to `ForwardManager`'s `onClosed`: a connection drop is the one case
   * where the stored intent stays "on" while no tunnel exists, and the user
   * needs to see why.
   *
   * @param {object} entry - the torn-down forward entry.
   * @param {string} reason - why it went away.
   * @returns {void}
   */
  noteClosed (entry, reason) {
    if (reason !== REASON_CONNECTION && reason !== REASON_DISPOSED) return
    try {
      if (this.store.forwards().items.some(item => item.id === entry.id)) {
        this.failures.set(entry.id, reason)
      }
    } catch { /* an unreadable store cannot be annotated */ }
  }

  /** One saved entry straight from the store, or undefined. */
  #savedEntry (id) {
    const target = typeof id === 'string' ? id.trim() : ''
    if (target === '') return undefined
    try {
      return this.store.forwards().items.find(entry => entry.id === target)
    } catch {
      return undefined
    }
  }

  /** One joined row, or a bare row when the store no longer holds it. */
  rowById (id) {
    return this.list().find(row => row.id === String(id)) ?? { id: String(id), persisted: false, live: false }
  }
}
