/**
 * Local port forwarding over the pooled SSH connection.
 *
 * A forward binds a local TCP listener and, for every accepted connection,
 * opens a fresh `direct-tcpip` channel to the remote target through the host's
 * pooled ssh2 client (`forwardOut` — the library's `ssh -L`). A listener is
 * bound to the connection that opened it: when that connection closes (network
 * loss, host edit, engine disposal) every forward riding on it is torn down and
 * its local port released, and the next SSH operation simply reconnects.
 *
 * @module @shiqyka/dsh-ssh-workspace/forward
 */

import { createServer } from 'node:net'

import { KINDS } from './diagnostics.js'
import { normalizedHost, requirePort } from './forward-common.js'

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
