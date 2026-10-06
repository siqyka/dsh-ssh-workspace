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

/**
 * Validate a port number.
 *
 * @param {unknown} value - the candidate.
 * @param {string} label - field name for the error.
 * @param {object} [options] - validation options.
 * @param {boolean} [options.allowZero] - whether 0 (OS-assigned) is legal.
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
 * Owns every open forward: the local listeners, their accepted sockets, and the
 * connection-pinning bookkeeping that keeps a mapped host from being reaped by
 * the idle sweeper while a forward still uses it.
 */
export class ForwardManager {
  /**
   * @param {object} options - manager options.
   * @param {import('./engine.js').SshWorkspaceEngine} options.engine - live engine.
   * @param {object} [options.logger] - Cordis logger, when available.
   */
  constructor (options) {
    this.engine = options.engine
    this.logger = options.logger
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

    // Opening the same target twice is a no-op, not a second listener: the
    // model may repeat a mapping without needing the earlier id.
    for (const entry of this.forwards.values()) {
      if (entry.alias === target && entry.remoteHost === remoteHost && entry.remotePort === remotePort) {
        return { ...this.#describe(entry), reused: true }
      }
    }

    const record = await this.engine.acquire(target)
    this.counter += 1
    const entry = {
      id: `fwd-${this.counter}`,
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
      await listenOn(server, localHost, localPort ?? remotePort, localPort === undefined)
    } catch (error) {
      try { server.close() } catch { /* never listening */ }
      if (error?.code === 'EADDRINUSE') {
        throw new Error(`local port ${localPort ?? remotePort} on ${localHost} is already in use`)
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
