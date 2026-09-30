/**
 * SSH engine: one persistent ssh2 connection per host alias, plus the
 * promisified SFTP surface the remote filesystem backend is built on.
 *
 * @module @dsh-community/dsh-ssh-workspace/engine
 */

import { existsSync, readFileSync } from 'node:fs'
import { requirePeer } from './peers.js'
import { HostStore, expandHome } from './hosts.js'

const { Client } = requirePeer('ssh2')

/** Engine defaults. */
const DEFAULTS = {
  idleTimeoutMs: 30 * 60_000,
  connectTimeoutMs: 15_000,
  keepaliveIntervalMs: 15_000,
  sweepIntervalMs: 60_000,
}

/** Translate a raw ssh2/SFTP failure into a stable `code` we can branch on. */
function ftpCodeOf (error) {
  const code = error?.code
  // ssh2 surfaces SFTP status codes numerically; 2 is NO_SUCH_FILE.
  if (code === 2 || error?.message?.includes('No such file')) return 'ENOENT'
  if (code === 4 || error?.message?.includes('Failure')) return 'EIO'
  if (code === 3 || error?.message?.includes('Permission denied')) return 'EACCES'
  if (typeof code === 'string') return code
  return 'EIO'
}

/**
 * The live remote-target engine.
 *
 * Owns the host store, the connection pool, and one SFTP channel per host,
 * kept open for the life of the connection because a filesystem backend issues
 * many small operations per tool call.
 */
export class SshWorkspaceEngine {
  /**
   * @param {object} [options] - engine options.
   * @param {HostStore} [options.store] - host store override (tests).
   * @param {object} [options.logger] - a Cordis logger, when available.
   */
  constructor (options = {}) {
    this.store = options.store ?? new HostStore()
    this.logger = options.logger
    /** @type {Map<string, object>} alias 鈫?live connection record. */
    this.pool = new Map()
    /** @type {Map<string, Promise<object>>} alias 鈫?in-flight acquire. */
    this.acquiring = new Map()
    /** @type {import('./remote-fs.js').RemoteFileSystem | undefined} */
    this.fs = undefined
    this.disposed = false
    this.sweeper = setInterval(() => { this.sweep() }, DEFAULTS.sweepIntervalMs)
    if (typeof this.sweeper.unref === 'function') this.sweeper.unref()
  }

  /**
   * Remember the filesystem backend so mount/unmount can invalidate its caches.
   *
   * @param {import('./remote-fs.js').RemoteFileSystem} fs - the mounted backend.
   */
  attachFileSystem (fs) {
    this.fs = fs
  }

  /** Drop every pooled connection and stop the sweeper. */
  dispose () {
    this.disposed = true
    clearInterval(this.sweeper)
    for (const [alias, record] of this.pool) this.closeRecord(alias, record)
    this.pool.clear()
  }

  /** Close connections idle beyond the configured threshold. */
  sweep () {
    const cutoff = Date.now() - DEFAULTS.idleTimeoutMs
    for (const [alias, record] of [...this.pool]) {
      if (record.inFlight === 0 && record.idleAt < cutoff) this.closeRecord(alias, record)
    }
  }

  /**
   * Close one pooled record, leaving any replacement record alone.
   *
   * @param {string} alias - host alias.
   * @param {object} record - the record to close.
   */
  closeRecord (alias, record) {
    if (this.pool.get(alias) === record) this.pool.delete(alias)
    try { record.sftp?.end?.() } catch { /* channel already gone */ }
    try { record.client.end() } catch { /* socket already gone */ }
  }

  /**
   * Drop the pooled connection for an alias because its configuration
   * changed; the next operation reconnects with the new record.
   *
   * @param {string} alias - host alias.
   */
  forget (alias) {
    const record = this.pool.get(alias)
    if (record !== undefined) this.closeRecord(alias, record)
  }

  /**
   * Build the ssh2 connect configuration for one host record.
   *
   * @param {object} resolved - a descriptor from {@link HostStore#resolve}.
   * @returns {object} ssh2 `ConnectConfig`.
   * @throws {Error} when key auth names a missing or unreadable key.
   */
  connectConfig (resolved) {
    /** @type {Record<string, unknown>} */
    const config = {
      host: resolved.host,
      port: resolved.port,
      username: resolved.user,
      readyTimeout: DEFAULTS.connectTimeoutMs,
      keepaliveInterval: DEFAULTS.keepaliveIntervalMs,
      keepaliveCountMax: 3,
      tryKeyboard: true,
    }
    const auth = resolved.auth ?? { kind: 'agent' }
    if (auth.kind === 'password') {
      if (typeof auth.password !== 'string' || auth.password === '') {
        throw new Error(`host ${JSON.stringify(resolved.alias)} uses password auth but the store holds no password`)
      }
      config.password = auth.password
    } else if (auth.kind === 'agent') {
      const agentPath = resolveAgentPath(auth.agentPath)
      if (agentPath === undefined) {
        throw new Error(`host ${JSON.stringify(resolved.alias)} uses agent auth but no ssh-agent is available (set SSH_AUTH_SOCK or configure an agent path)`)
      }
      config.agent = agentPath
    } else {
      const keyPath = expandHome(auth.keyPath ?? '')
      if (keyPath === '' || !existsSync(keyPath)) {
        throw new Error(`host ${JSON.stringify(resolved.alias)}: private key not found at ${JSON.stringify(auth.keyPath ?? '(unset)')}`)
      }
      config.privateKey = readFileSync(keyPath, 'utf8')
      if (typeof auth.passphrase === 'string' && auth.passphrase !== '') config.passphrase = auth.passphrase
    }
    return config
  }

  /**
   * Connect (or reuse) the pooled connection for an alias.
   *
   * @param {string} alias - host alias.
   * @returns {Promise<object>} the live connection record.
   */
  async acquire (alias) {
    if (this.disposed) throw new Error('ssh-workspace engine is disposed')
    const existing = this.pool.get(alias)
    if (existing !== undefined && !existing.broken) return existing
    if (existing !== undefined) this.closeRecord(alias, existing)
    const pending = this.acquiring.get(alias)
    if (pending !== undefined) return await pending
    const task = this.#connect(alias)
    this.acquiring.set(alias, task)
    try {
      return await task
    } finally {
      if (this.acquiring.get(alias) === task) this.acquiring.delete(alias)
    }
  }

  /**
   * Establish one new connection plus its SFTP channel.
   *
   * @param {string} alias - host alias.
   * @returns {Promise<object>} the new record.
   */
  async #connect (alias) {
    const resolved = this.store.resolve(alias)
    const config = this.connectConfig(resolved)
    const client = await new Promise((resolve, reject) => {
      const candidate = new Client()
      let settled = false
      const fail = (error) => {
        if (settled) return
        settled = true
        try { candidate.destroy() } catch { /* already closed */ }
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      candidate.once('ready', () => {
        if (settled) return
        settled = true
        resolve(candidate)
      })
      candidate.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
        // Password auth can arrive as a keyboard-interactive challenge; answer
        // it only when the configured password clearly matches the prompt.
        if (config.password !== undefined && prompts.length > 0 && prompts.every(prompt => /password/iu.test(prompt.prompt))) {
          finish(prompts.map(() => config.password))
          return
        }
        fail(new Error(`authentication failed (keyboard-interactive): ${prompts.map(prompt => prompt.prompt.trim()).join(', ') || 'unsupported challenge'}`))
      })
      // Keep an error listener attached past the handshake: ssh2 may emit a
      // second 'error' after the once-listener is consumed.
      candidate.on('error', fail)
      try {
        candidate.connect(config)
      } catch (error) {
        fail(error)
      }
    })

    /** @type {object} */
    const record = { alias, client, sftp: undefined, idleAt: Date.now(), inFlight: 0, broken: false }
    client.on('error', () => { record.broken = true })
    client.on('close', () => { record.broken = true })
    try {
      record.sftp = await new Promise((resolve, reject) => {
        client.sftp((error, sftp) => {
          if (error !== undefined && error !== null) reject(error)
          else resolve(sftp)
        })
      })
    } catch (error) {
      this.closeRecord(alias, record)
      throw new Error(`host ${JSON.stringify(alias)}: could not open an SFTP channel: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.pool.set(alias, record)
    this.logger?.info?.(`ssh-workspace: connected to ${alias} (${resolved.user}@${resolved.host}:${resolved.port})`)
    return record
  }

  /**
   * Run one SFTP operation against a live connection, reconnecting once when
   * the connection turns out to be broken.
   *
   * @template T
   * @param {string} alias - host alias.
   * @param {(sftp: any, record: object) => Promise<T>} operation - the work.
   * @returns {Promise<T>} the operation result.
   */
  async withSftp (alias, operation) {
    let lastError
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const record = await this.acquire(alias)
      record.idleAt = Date.now()
      record.inFlight += 1
      try {
        return await operation(record.sftp, record)
      } catch (error) {
        lastError = error
        // Replay only when the transport itself died: a logic error on a
        // healthy connection must surface, never be retried.
        if (!record.broken) throw error
        this.closeRecord(alias, record)
      } finally {
        record.inFlight -= 1
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  /**
   * Remote paths that are writable scratch space for atomic publication.
   *
   * `/tmp` is the POSIX convention and is what the local backend's own
   * writable-root policy already names, so the same staging strategy works on
   * both sides of the seam.
   */
  static get stagingRoot () {
    return '/tmp'
  }

  /**
   * Run one shell command on a remote host.
   *
   * The filesystem seam carries file contents; a shell is a different
   * capability, so the remote workspace uses this for commands because the
   * deployment's pwsh/bash tools always execute on the local host.
   *
   * @param {string} alias - host alias.
   * @param {string} command - shell command to run remotely.
   * @param {object} [options] - exec options.
   * @param {number} [options.timeoutMs] - wall-clock budget (default 60000).
   * @param {number} [options.maxOutputBytes] - per-stream capture cap.
   * @param {string} [options.cwd] - remote working directory.
   * @param {AbortSignal} [options.signal] - caller cancellation.
   * @returns {Promise<{success: boolean, exitCode: number|null, timedOut: boolean, stdout: string, stderr: string, truncated: boolean, durationMs: number, error?: string}>} outcome.
   */
  async exec (alias, command, options = {}) {
    const started = Date.now()
    const budget = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 60_000
    const maxBytes = Number.isFinite(options.maxOutputBytes) && options.maxOutputBytes > 0 ? options.maxOutputBytes : 2 * 1024 * 1024
    const prefix = options.cwd === undefined || options.cwd === '' ? '' : `cd ${shellQuote(options.cwd)} && `
    const record = await this.acquire(alias)
    record.idleAt = Date.now()
    record.inFlight += 1
    try {
      return await new Promise((resolve) => {
        record.client.exec(`${prefix}${command}`, (error, stream) => {
          if (error !== undefined && error !== null) {
            resolve({
              success: false,
              exitCode: null,
              timedOut: false,
              stdout: '',
              stderr: '',
              truncated: false,
              durationMs: Date.now() - started,
              error: error.message ?? String(error),
            })
            return
          }
          const stdout = { text: '', truncated: false }
          const stderr = { text: '', truncated: false }
          let timedOut = false
          let settled = false
          const finish = (outcome) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve({
              ...outcome,
              truncated: stdout.truncated || stderr.truncated,
              durationMs: Date.now() - started,
            })
          }
          const timer = setTimeout(() => {
            timedOut = true
            try { stream.signal('KILL') } catch { /* channel gone */ }
            try { stream.close() } catch { /* channel gone */ }
            finish({
              success: false,
              exitCode: null,
              timedOut: true,
              stdout: stdout.text,
              stderr: stderr.text,
              error: `command timed out after ${budget} ms`,
            })
          }, budget)
          const abort = () => {
            try { stream.signal('KILL') } catch { /* channel gone */ }
            try { stream.close() } catch { /* channel gone */ }
            finish({
              success: false,
              exitCode: null,
              timedOut: false,
              stdout: stdout.text,
              stderr: stderr.text,
              error: 'command aborted by the caller',
            })
          }
          options.signal?.addEventListener('abort', abort, { once: true })
          stream.on('data', (chunk) => appendCapped(stdout, chunk, maxBytes))
          stream.stderr.on('data', (chunk) => appendCapped(stderr, chunk, maxBytes))
          stream.on('close', (code) => {
            options.signal?.removeEventListener?.('abort', abort)
            finish({
              success: code === 0,
              exitCode: typeof code === 'number' ? code : null,
              timedOut,
              stdout: stdout.text,
              stderr: stderr.text,
              ...(typeof code !== 'number' ? { error: 'connection lost before the command reported an exit status' } : {}),
            })
          })
          stream.on('error', (streamError) => {
            finish({
              success: false,
              exitCode: null,
              timedOut: false,
              stdout: stdout.text,
              stderr: stderr.text,
              error: streamError.message ?? String(streamError),
            })
          })
        })
      })
    } finally {
      record.inFlight -= 1
      record.idleAt = Date.now()
    }
  }
}

/** Append output up to a byte cap, marking truncation once. */
function appendCapped (target, chunk, maxBytes) {
  if (target.truncated) return
  if (target.text.length + chunk.length > maxBytes) {
    let cut = chunk.toString('utf8').slice(0, Math.max(0, maxBytes - target.text.length))
    // Never split a surrogate pair at the cut boundary.
    if (/[\uD800-\uDBFF]$/u.test(cut)) cut = cut.slice(0, -1)
    target.text += `${cut}鈥output truncated]`
    target.truncated = true
    return
  }
  target.text += chunk.toString('utf8')
}

/** Quote one argument for a POSIX shell. */
export function shellQuote (value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

/**
 * Resolve the ssh-agent endpoint for agent auth.
 *
 * @param {string | undefined} configured - an explicit agent path.
 * @returns {string | undefined} the endpoint, or undefined when unavailable.
 */
export function resolveAgentPath (configured) {
  if (typeof configured === 'string' && configured !== '') return configured
  const sock = process.env.SSH_AUTH_SOCK
  if (sock !== undefined && sock !== '') return sock
  if (process.platform === 'win32') return 'pageant'
  return undefined
}

export { DEFAULTS as ENGINE_DEFAULTS, ftpCodeOf }
