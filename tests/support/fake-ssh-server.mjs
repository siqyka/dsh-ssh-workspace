/**
 * A real SSH server, in-process, for tests that need a transport to break.
 *
 * ## Why a server instead of another stub
 *
 * Every existing suite fakes the *record*: it sets `record.broken = true` by
 * hand and asserts what the engine does next. That proves the branch, never the
 * trigger. The reconnect loop exists because a real socket dies at times a stub
 * cannot reproduce — during the handshake, after auth but before the channel
 * opens, mid-transfer, and while nobody is looking. `client.on('close')` firing
 * on its own is exactly the half a hand-set flag skips.
 *
 * ssh2 ships `Server` (the same dependency the plugin already has), so this is
 * not new test infrastructure from scratch: it is the existing dependency's
 * existing capability. The server speaks the real protocol, so the plugin's
 * host-key verifier, its SFTP channel, its exec path and its `close` handler all
 * run unmodified against it.
 *
 * ## What it deliberately is NOT
 *
 * Not a filesystem. The SFTP subsystem accepts the channel and answers
 * `OPEN`/`CLOSE`/`STAT` with fixed values; it never emulates a directory tree.
 * A test that needs real files belongs in the `live` suite against a real host.
 * The value here is the transport: connection accepted, channel opened, socket
 * killed on cue.
 *
 * ## Controls
 *
 * Every server exposes:
 *
 *  - `port`            — where to connect.
 *  - `fingerprint`     — the SHA256 of its host key, for pinning assertions.
 *  - `connections`     — count of accepted connections.
 *  - `sessions`        — count of opened sessions (channels).
 *  - `dropAll()`       — destroy every live socket, as a network blip would.
 *  - `setHostKey(key)` — swap the key a *new* connection presents (O-08).
 *  - `rejectNext(n)`   — refuse the next `n` connections before auth.
 *  - `close()`         — stop listening and drop everything.
 *
 * The drop is `socket.destroy()`, not a graceful `end()`: a lid close or a
 * Wi-Fi switch does not send FIN, and a server that ended cleanly would exercise
 * a path the user never hits.
 *
 * @module tests/support/fake-ssh-server
 */

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

// `createServer` from node:net is unused: ssh2.Server owns its own listener.
// Kept out of the import list so the linter's unused-import rule stays satisfied.

/**
 * ssh2 is a real dependency of this plugin, so it resolves from the plugin's
 * own tree even when `DSH_CORE_ROOT` points at a stub root: `requirePeer`
 * prefers `localRequire`, and this helper does the same.
 *
 * Resolving from a file INSIDE the plugin root matters: `createRequire` of a
 * bare module id walks up from the given path, so `node_modules/ssh2` next to
 * the plugin is found regardless of the process cwd.
 *
 * @param {string} [pluginRoot] - the plugin checkout.
 * @returns {object} the ssh2 module.
 */
export function loadSsh2 (pluginRoot) {
  const base = pluginRoot ?? process.cwd()
  const fromPlugin = createRequire(`${base}/package.json`)
  try {
    return fromPlugin('ssh2')
  } catch {
    // A suite run from an installed copy may not carry a dev dependency; the
    // ambient resolution is the last honest attempt before failing loudly.
    return createRequire(import.meta.url)('ssh2')
  }
}

/** SHA256 of an OpenSSH public key line, in the form the plugin records. */
export function fingerprintOf (publicKeyLine) {
  const [type, blob] = publicKeyLine.trim().split(/\s+/u)
  const raw = Buffer.from(blob, 'base64')
  return `SHA256:${createHash('sha256').update(raw).digest('base64').replace(/=+$/u, '')}`
}

/**
 * Start one fake SSH server.
 *
 * @param {object} [options] - server options.
 * @param {string} [options.pluginRoot] - where to resolve ssh2 from.
 * @param {string} [options.user] - accepted username (default `tester`).
 * @param {string} [options.password] - when set, password auth is accepted.
 * @param {boolean} [options.allowPublicKey] - accept any public key (default true).
 * @param {(channel: object) => void} [options.onExec] - called per exec request with `{command, stream}`.
 * @param {(sftp: object) => void} [options.onSftp] - called once per SFTP channel.
 * @returns {Promise<object>} the running server handle.
 */
export async function startFakeSshServer (options = {}) {
  const ssh2 = loadSsh2(options.pluginRoot)
  const { utils } = ssh2
  const user = options.user ?? 'tester'
  const password = options.password
  const allowPublicKey = options.allowPublicKey !== false

  let keyPair = utils.generateKeyPairSync('ed25519')
  const rejectRemaining = { value: 0 }
  let closed = false
  let boundPort = 0
  const clients = new Set()
  const state = { connections: 0, sessions: 0, execs: [], sftpChannels: 0 }

  /**
   * Build and listen on one ssh2 Server.
   *
   * A function rather than a one-shot because ssh2 reads `hostKeys` in its
   * constructor and keeps the parsed keys in a closure: the only way to change
   * the key a NEW connection sees is a new listener. That is also what actually
   * happens in the world — a host is reinstalled and comes back with a new key
   * on the same address.
   *
   * @param {string} privateKey - PEM private key to present.
   * @param {number} [port] - port to bind; 0 picks a free one.
   * @returns {Promise<object>} the listening ssh2 Server.
   */
  async function listen (privateKey, port = 0) {
    const server = new ssh2.Server({
      hostKeys: [privateKey],
      ident: 'SSH-2.0-dsh-ssh-workspace-test',
    }, (client) => {
      state.connections += 1
      // The ssh2 `Connection` exposes only `end()`, which sends FIN. A lid close
      // or a Wi-Fi switch sends nothing, and a graceful end would exercise a
      // path the user never hits, so the live connection is kept for a hard
      // destroy of its socket (see `dropAll`).
      clients.add(client)
      client.on('close', () => clients.delete(client))
      client.on('authentication', (ctx) => {
        if (ctx.method === 'password' && password !== undefined && ctx.password === password) {
          ctx.accept()
          return
        }
        if (ctx.method === 'publickey' && allowPublicKey) {
          // Accept the probe AND the real signature; ssh2 sends both.
          ctx.accept()
          return
        }
        ctx.reject()
      })
      client.on('ready', () => {
        client.on('session', (accept) => {
          state.sessions += 1
          const session = accept()
          session.on('exec', (acceptExec, rejectExec, info) => {
            const stream = acceptExec()
            state.execs.push(info.command)
            options.onExec?.({ command: info.command, stream })
            // Default: a command that prints nothing and exits 0. A test that
            // wants output or a failure supplies its own `onExec`.
            if (options.onExec === undefined) stream.exit(0)
            if (options.onExec === undefined) stream.end()
          })
          session.on('sftp', (acceptSftp) => {
            const sftp = acceptSftp()
            state.sftpChannels += 1
            options.onSftp?.(sftp)
            if (options.onSftp === undefined) {
              // Answer the handful of requests a connection makes on its own.
              sftp.on('OPEN', (reqid) => sftp.status(reqid, 0))
              sftp.on('CLOSE', (reqid) => sftp.status(reqid, 0))
              sftp.on('STAT', (reqid) => sftp.status(reqid, 2))
              sftp.on('REALPATH', (reqid, p) => sftp.name(reqid, [{ filename: p, longname: p, attrs: {} }]))
              sftp.on('OPENDIR', (reqid) => sftp.status(reqid, 0))
              sftp.on('READDIR', (reqid) => sftp.status(reqid, 1))
            }
          })
        })
      })
      // A client that throws must not take the process down with it.
      client.on('error', () => {})
    })

    server.on('connection', (connection) => {
      // ssh2 forwards its inner net server's `connection` event, but the
      // argument it forwards is the ssh2 `Connection`, not a socket — so
      // nothing here can be destroyed directly. The raw socket is reached
      // through each connection's `_sock` instead (see `dropAll`).
      if (rejectRemaining.value > 0) {
        rejectRemaining.value -= 1
        // Destroy before the handshake: the client sees ECONNRESET, not a
        // rejection, which is what an unreachable-in-practice host looks like.
        connection._sock?.destroy?.()
      }
    })

    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    boundPort = server.address().port
    return server
  }

  let server = await listen(keyPair.private)

  /** Destroy one ssh2 Connection's raw socket, or end it if the field moved. */
  function drop (client) {
    const raw = client._sock
    if (raw !== undefined && typeof raw.destroy === 'function') raw.destroy()
    else client.end()
  }

  return {
    get port () { return boundPort },
    get fingerprint () { return fingerprintOf(keyPair.public) },
    get connections () { return state.connections },
    get sessions () { return state.sessions },
    get sftpChannels () { return state.sftpChannels },
    get execs () { return [...state.execs] },
    /** Every live connection destroyed, as a network blip would. */
    dropAll () {
      for (const client of clients) drop(client)
    },
    /**
     * Present a different key on the SAME port to the next connection.
     *
     * Rebuilds the listener: ssh2 parses `hostKeys` in its constructor, so the
     * key cannot be swapped in place. Existing connections are dropped first,
     * which is the sequence a reinstalled host produces.
     */
    async setHostKey (pemPrivate, publicLine) {
      keyPair = { private: pemPrivate, public: publicLine }
      for (const client of clients) drop(client)
      clients.clear()
      const previous = server
      await new Promise((resolve) => previous.close(resolve))
      server = await listen(pemPrivate, boundPort)
    },
    /** Refuse the next `count` connections at the socket level. */
    rejectNext (count) {
      rejectRemaining.value = Math.max(0, Number(count) || 0)
    },
    /** Stop listening and drop everything. */
    async close () {
      if (closed) return
      closed = true
      for (const client of clients) drop(client)
      clients.clear()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/**
 * A second host key, for the mismatch case.
 *
 * @param {string} pluginRoot - where to resolve ssh2 from.
 * @returns {{private: string, public: string, fingerprint: string}} the key pair.
 */
export function freshHostKey (pluginRoot) {
  const { utils } = loadSsh2(pluginRoot)
  const pair = utils.generateKeyPairSync('ed25519')
  return { private: pair.private, public: pair.public, fingerprint: fingerprintOf(pair.public) }
}
