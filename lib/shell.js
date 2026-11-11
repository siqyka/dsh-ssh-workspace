/**
 * Persistent remote shells: one long-lived PTY per (host, session) that keeps
 * its state — working directory, exported variables, background jobs — across
 * tool calls.
 *
 * Why not route the harness's own persistent bash/pwsh tools to the host? Those
 * tools take their argv from `dsh-terminal-bash`, which builds the command line
 * for THIS machine's dialect: on Windows it starts PowerShell and speaks
 * PowerShell to it. A remote POSIX host needs `sh`, and handing it a PowerShell
 * argv produces a session that fails in confusing ways rather than saying "wrong
 * dialect". A separate tool makes the remote dialect explicit: one POSIX shell,
 * documented as such.
 *
 * The channel is a real SSH PTY (`client.exec(command, {pty})`), so the remote
 * side echoes and line-buffers like a terminal. A marker is appended to every
 * command so the session can tell where the output of one call ends; the marker
 * carries the exit status, which is the only reliable way to recover it from a
 * PTY stream.
 *
 * @module @shiqyka/dsh-ssh-workspace/shell
 */

/** Fresh marker per command, so a program that prints one cannot fake an end. */
import { StringDecoder } from 'node:string_decoder'

let markerSequence = 0

/** How long a send waits for its marker before giving up. */
const DEFAULT_TIMEOUT_MS = 60_000

/** Output retained per session before the oldest is dropped. */
const MAX_BUFFER_BYTES = 1024 * 1024

/**
 * One persistent remote shell.
 *
 * Created by {@link ShellManager#open}. Not exported for direct construction:
 * the manager owns the connection hold, and a session that outlived its hold
 * would let the idle sweeper close the connection underneath it.
 */
class RemoteShell {
  /**
   * @param {object} options - session options.
   * @param {string} options.alias - host alias.
   * @param {object} options.channel - the open ssh2 channel.
   * @param {Function} options.release - releases the connection hold.
   * @param {string} options.key - the session key.
   * @param {object} [options.logger] - a Cordis logger.
   */
  constructor (options) {
    this.alias = options.alias
    this.key = options.key
    this.channel = options.channel
    // The engine's own close handler also releases the hold, so this wrapper
    // must release at most once: a shell that closes and is then disposed would
    // otherwise decrement the counter twice.
    const releaseOnce = options.release
    let released = false
    this.release = () => {
      if (released) return
      released = true
      releaseOnce()
    }
    this.logger = options.logger
    this.closed = false
    /**
     * Decode bytes, not chunks.
     *
     * A PTY splits its output at arbitrary byte boundaries, so a multi-byte
     * character (any CJK output, an emoji in a build log) lands across two
     * chunks and `chunk.toString('utf8')` renders it as two replacement glyphs.
     * The decoder holds the incomplete tail until the rest arrives.
     *
     * @type {StringDecoder}
     */
    this.decoder = new StringDecoder('utf8')
    /** @type {string} */
    this.buffer = ''
    /** @type {{marker: string, resolve: Function, reject: Function, timer: any, generation: number} | undefined} */
    this.pending = undefined
    /**
     * Bumped every time a send is abandoned (timeout, cancellation).
     *
     * A timed-out command is NOT stopped: it keeps running on the same PTY, and
     * its output keeps arriving. The next `run` used to start collecting
     * immediately, so the tail of the abandoned command — including its own
     * completion marker — could be captured as the next command's result. Each
     * send therefore records the generation it belongs to, and output that
     * arrives before the current send's own guard is discarded rather than
     * attributed to it.
     *
     * @type {number}
     */
    this.generation = 0
    /**
     * Set when a send was abandoned while its command may still be running.
     *
     * The next send must not simply append its marker: the stale marker could
     * arrive first and settle the new send with the OLD exit code. A fresh
     * marker is indistinguishable from the abandoned one only if it is the
     * first to arrive, so the abandoned state forces a resynchronisation
     * (see `run`).
     *
     * @type {boolean}
     */
    this.abandoned = false
    this.channel.on('data', (chunk) => { this.#onData(chunk) })
    this.channel.stderr?.on?.('data', (chunk) => { this.#onData(chunk) })
    this.channel.once('close', () => { this.#onClose() })
  }

  /** Whether the session can still run commands. */
  get alive () {
    return !this.closed
  }

  /**
   * Append decoded output and, when the completion marker arrives, settle.
   *
   * The marker is printed as `<marker><code><marker>`, so the completion is
   * recognized by the DIGITS between two markers — a terminal also echoes the
   * `printf` line that carries the marker, but that echo shows `%s` where the
   * digits belong, so it cannot be mistaken for a completion.
   *
   * @param {Buffer|string} chunk - raw terminal bytes.
   */
  #onData (chunk) {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    this.buffer += text
    if (this.buffer.length > MAX_BUFFER_BYTES) {
      this.buffer = this.buffer.slice(this.buffer.length - MAX_BUFFER_BYTES)
    }
    const pending = this.pending
    if (pending === undefined) return
    const marker = escapeRegExp(pending.marker)
    const match = new RegExp(`${marker}(-?\\d+)${marker}`, 'u').exec(this.buffer)
    if (match === null) return
    // Everything before the completion image is this command's output.
    const raw = this.buffer.slice(0, match.index)
    this.buffer = ''
    this.pending = undefined
    clearTimeout(pending.timer)
    pending.resolve({ raw, exitCode: Number.parseInt(match[1], 10) })
  }

  /** Fail the pending send when the transport dies. */
  #onClose () {
    this.closed = true
    const pending = this.pending
    this.pending = undefined
    if (pending !== undefined) {
      clearTimeout(pending.timer)
      pending.reject(new Error('the remote shell closed (connection dropped or session ended)'))
    }
    this.release()
    this.logger?.debug?.(`ssh-workspace: remote shell ${this.key} closed`)
  }

  /**
   * Run one command and collect its output up to the exit marker.
   *
   * @param {string} command - the command line (POSIX shell syntax).
   * @param {object} [options] - send options.
   * @param {number} [options.timeoutMs] - how long to wait for the marker.
   * @param {AbortSignal} [options.signal] - cancels the wait (the command keeps running).
   * @returns {Promise<{output: string, exitCode: number|null}>} collected output and status.
   */
  async run (command, options = {}) {
    if (this.closed) throw new Error('the remote shell is closed; open a new session')
    if (this.pending !== undefined) throw new Error('the remote shell is still running another command; wait for it or open a second session')
    if (this.abandoned) await this.#resynchronise(options)
    markerSequence += 1
    const marker = `__DSH_WS_${process.pid}_${Date.now().toString(36)}_${markerSequence}__`
    // `$?` is captured immediately after the command, before anything else can
    // overwrite it, and printed inside the marker so one line carries both.
    const script = `${command}\nprintf '\\n${marker}%s${marker}\\n' "$?"\n`
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS
    const settled = new Promise((resolve, reject) => {
      // Deliberately NOT unref'd: this timer is the only thing that fails a send
      // whose marker never arrives. An unref'd timer would be free to never run
      // while the process is otherwise idle, leaving the caller hanging — which
      // is exactly the failure it exists to prevent.
      const timer = setTimeout(() => {
        if (this.pending?.marker !== marker) return
        this.pending = undefined
        // The command is still running on the PTY. Anything it prints from now
        // on belongs to it, not to the next send, so the session is marked as
        // needing resynchronisation before the caller can issue another one.
        this.abandoned = true
        this.generation += 1
        reject(new Error(`the remote shell did not answer within ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending = { marker, resolve, reject, timer }
    })
    const onAbort = () => {
      const pending = this.pending
      if (pending?.marker !== marker) return
      this.pending = undefined
      clearTimeout(pending.timer)
      // Same reasoning as the timeout: cancelling the WAIT does not cancel the
      // command, so its output must not leak into the next send.
      this.abandoned = true
      this.generation += 1
      pending.reject(new Error('the remote shell command was cancelled'))
    }
    if (options.signal !== undefined && options.signal !== null && typeof options.signal.addEventListener === 'function') {
      if (options.signal.aborted === true) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      this.channel.write(script)
    } catch (error) {
      this.pending = undefined
      throw error
    }
    try {
      const completion = await settled
      return { output: stripEcho(completion.raw), exitCode: completion.exitCode }
    } finally {
      options.signal?.removeEventListener?.('abort', onAbort)
    }
  }

  /**
   * Drain a session whose previous command was abandoned mid-run.
   *
   * A timed-out or cancelled command keeps running on the PTY. Its output —
   * and, crucially, its OWN completion marker carrying its exit status — is
   * still in flight. Sending the next command straight away would let that
   * marker settle the new send, which then reports the abandoned command's exit
   * code as its own.
   *
   * The fix is a barrier: send a command that does nothing but print a fresh
   * marker, wait for that marker, and throw away everything that arrived before
   * it. Whatever the abandoned command printed is then provably on the wrong
   * side of the barrier. The barrier carries its own marker, so a marker from
   * the abandoned command cannot be mistaken for it.
   *
   * A session that does not answer the barrier stays marked abandoned, and the
   * next send tries again: a shell that is genuinely wedged will time out the
   * same way, which is the honest outcome.
   *
   * @param {object} [options] - send options.
   * @returns {Promise<void>} resolves once the session is synchronised.
   */
  async #resynchronise (options = {}) {
    markerSequence += 1
    const barrier = `__DSH_WS_RESYNC_${process.pid}_${Date.now().toString(36)}_${markerSequence}__`
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.marker !== barrier) return
        this.pending = undefined
        reject(new Error(`the remote shell did not answer the resynchronisation barrier within ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending = { marker: barrier, resolve, reject, timer }
      try {
        this.channel.write(`printf '\n${barrier}%s${barrier}\n' 0\n`)
      } catch (error) {
        this.pending = undefined
        clearTimeout(timer)
        reject(error)
      }
    }).then(() => {
      this.abandoned = false
    }, (error) => {
      // The barrier failed: the session stays marked, so a later send retries
      // rather than trusting an unsynchronised stream.
      throw error
    })
  }


  /** Close the session and release its connection hold. */
  close () {
    if (this.closed) return
    this.closed = true
    const pending = this.pending
    this.pending = undefined
    if (pending !== undefined) {
      clearTimeout(pending.timer)
      pending.reject(new Error('the remote shell was closed'))
    }
    try { this.channel.close() } catch { /* channel already gone */ }
    this.release()
  }
}

/**
 * Drop the terminal's echo of the command line.
 *
 * A PTY echoes what was written, so the collected text begins with the command
 * (and the newline the terminal adds for it). The caller already knows the
 * command, so leaving it in would let the model read its own input back as
 * output — and, worse, would put the marker's own `printf` line in the output.
 *
 * @param {string} text - raw collected output.
 * @returns {string} output without the leading echo.
 */
function stripEcho (text) {
  // A terminal turns every newline into CRLF; normalize before splitting so the
  // echo is exactly one line.
  const normalized = text.replace(/\r\n/gu, '\n')
  const newline = normalized.indexOf('\n')
  if (newline < 0) return normalized.trim()
  return normalized.slice(newline + 1).trim()
}

/** Escape a literal for use inside a RegExp. */
function escapeRegExp (value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Owns every open remote shell, keyed by host and session.
 *
 * One session per key: a second call with the same key reuses the live shell,
 * which is what makes `cd` and exported variables survive between calls. All
 * sessions close with the plugin, and a host's sessions close when that host's
 * connection is dropped — the channel cannot outlive its connection.
 */
export class ShellManager {
  /**
   * @param {object} options - manager options.
   * @param {import('./engine.js').SshWorkspaceEngine} options.engine - live engine.
   * @param {object} [options.logger] - a Cordis logger.
   */
  constructor (options) {
    this.engine = options.engine
    this.logger = options.logger
    /** @type {Map<string, RemoteShell>} session key → live shell. */
    this.shells = new Map()
    /**
     * Session key → the open currently in flight for it.
     *
     * Separate from `shells` because the two answer different questions: an
     * in-flight open is not a shell yet, and putting it in `shells` would make
     * `list()` and `close()` handle a half-built session.
     *
     * @type {Map<string, Promise<RemoteShell>>}
     */
    this.opening = new Map()
    /**
     * How each session was STARTED, kept across the session's death.
     *
     * A dropped connection closes the PTY, and the next call reopens the
     * session from nothing. Without this, that reopen silently landed in the
     * login directory: the user's `cd /var/log` was not merely unremembered,
     * it was contradicted, and nothing said so. What is remembered here is only
     * what the CALLER asked for — the plugin never reads the remote shell's
     * current directory back, because it cannot (see `cwdNote` in the tool).
     *
     * @type {Map<string, {cwd: string|undefined, openedAt: number, reopens: number}>}
     */
    this.starts = new Map()
    /** Set by {@link ShellManager#dispose}; a disposed manager opens nothing. */
    this.disposed = false
  }

  /**
   * Open (or reuse) a persistent shell for one host.
   *
   * @param {string} alias - host alias.
   * @param {object} [options] - open options.
   * @param {string} [options.session] - session name; distinct names get distinct shells.
   * @param {string} [options.cwd] - initial remote working directory.
   * @param {AbortSignal} [options.signal] - cancels the open.
   * @returns {Promise<RemoteShell>} the live shell.
   */
  async open (alias, options = {}) {
    if (this.disposed) throw new Error('the shell manager is disposed; no new sessions can be opened')
    const name = typeof options.session === 'string' && options.session.trim() !== '' ? options.session.trim() : 'default'
    const key = `${alias}\u0000${name}`
    const existing = this.shells.get(key)
    if (existing !== undefined && existing.alive) return existing
    if (existing !== undefined) this.shells.delete(key)
    // Single-flight, per session key. Two callers that both find no live shell
    // used to open a PTY each: the second one overwrote the first in the map,
    // so the first session kept running with no reference able to close it —
    // a leaked PTY and a leaked connection hold for the life of the process.
    // The in-flight promise is shared instead, so a burst opens exactly one.
    const inFlight = this.opening.get(key)
    if (inFlight !== undefined) return await inFlight
    // The directory this session was STARTED in. `options.cwd` wins when the
    // caller names one now, because that is an explicit instruction; otherwise
    // the remembered start is reused, so a reopen does not move the session.
    const requested = typeof options.cwd === 'string' && options.cwd !== '' ? options.cwd : undefined
    const remembered = this.starts.get(key)
    const cwd = requested ?? remembered?.cwd
    const reopened = remembered !== undefined
    const command = cwd === undefined
      ? 'sh -l'
      : `cd ${quote(cwd)} && exec sh -l`
    const opening = (async () => {
      const opened = await this.engine.openChannel(alias, command, {
        signal: options.signal,
        // A real terminal: the remote shell echoes and keeps `$?` usable. 80x24
        // is the conventional default; nothing in this flow resizes.
        pty: { cols: 80, rows: 24, term: 'xterm-256color' },
      })
      const shell = new RemoteShell({
        alias,
        key,
        channel: opened.channel,
        release: opened.release,
        logger: this.logger,
      })
      // A manager disposed while the channel was opening must not register a
      // session nobody will ever close: the hold would outlive the plugin.
      if (this.disposed) {
        shell.close()
        throw new Error('the shell manager was disposed while the session was opening')
      }
      this.shells.set(key, shell)
      this.starts.set(key, {
        cwd,
        openedAt: remembered?.openedAt ?? Date.now(),
        reopens: (remembered?.reopens ?? 0) + (reopened ? 1 : 0),
      })
      this.logger?.info?.(reopened
        ? `ssh-workspace: reopened remote shell ${name} on ${alias}${cwd === undefined ? '' : ` in ${cwd}`} after the previous one ended`
        : `ssh-workspace: opened remote shell ${name} on ${alias}`)
      return shell
    })()
    this.opening.set(key, opening)
    try {
      return await opening
    } finally {
      // Clear the slot on both outcomes: a failed open must not be cached, or
      // every later caller would await the same rejection instead of retrying.
      this.opening.delete(key)
    }
  }

  /**
   * Run one command in a host's persistent shell, opening it when needed.
   *
   * @param {string} alias - host alias.
   * @param {string} command - POSIX shell command.
   * @param {object} [options] - run options.
   * @returns {Promise<{output: string, exitCode: number|null, reused: boolean}>} the result.
   */
  async run (alias, command, options = {}) {
    const key = `${alias}\u0000${typeof options.session === 'string' && options.session.trim() !== '' ? options.session.trim() : 'default'}`
    const reused = this.shells.has(key) && this.shells.get(key).alive
    const shell = await this.open(alias, options)
    const result = await shell.run(command, { timeoutMs: options.timeoutMs, signal: options.signal })
    // `reused: false` is not enough on its own: a FIRST open and a REOPEN after
    // the connection dropped both report it, and only the second one lost state
    // the caller believes it still has. The distinction is what lets the tool
    // warn instead of quietly answering from a shell that forgot the `cd`.
    const start = this.starts.get(key)
    return {
      ...result,
      reused,
      cwd: start?.cwd,
      reopened: reused !== true && (start?.reopens ?? 0) > 0,
    }
  }

  /**
   * Close one session, or every session for one host.
   *
   * @param {string} alias - host alias.
   * @param {string} [session] - session name; omitted closes them all for the host.
   * @returns {number} how many sessions were closed.
   */
  close (alias, session) {
    let closed = 0
    for (const [key, shell] of [...this.shells]) {
      const [shellAlias, shellName] = key.split('\u0000')
      if (shellAlias !== alias) continue
      if (session !== undefined && shellName !== session) continue
      shell.close()
      this.shells.delete(key)
      // An explicit close is a statement that the session is finished. Keeping
      // its start directory would resurrect that state on the next open.
      this.starts.delete(key)
      closed += 1
    }
    return closed
  }

  /** Describe every live session. */
  list () {
    return [...this.shells.entries()].map(([key, shell]) => {
      const [alias, session] = key.split('\u0000')
      const start = this.starts.get(key)
      return {
        alias,
        session,
        alive: shell.alive,
        // The directory the session was STARTED in. Deliberately not called
        // "cwd": the remote shell's current directory is not observable from
        // here, and a field named `cwd` would be read as one.
        //
        // Omitted when unknown rather than set to `undefined`: a key that EXISTS
        // with an undefined value has no JSON form, so the Host rejects the whole
        // status result as "not lossless JSON" before it can check anything. The
        // start record is dropped on close, so a closed session legitimately has
        // no answer here.
        ...(typeof start?.cwd === 'string' ? { startedIn: start.cwd } : {}),
        reopens: start?.reopens ?? 0,
      }
    })
  }

  /** Close every session; called when the plugin unloads. */
  dispose () {
    this.disposed = true
    for (const shell of [...this.shells.values()]) shell.close()
    this.shells.clear()
    this.starts.clear()
    // An open still in flight is NOT awaited here: its channel does not exist
    // yet, and blocking the unload on a handshake would stall the plugin. It
    // closes itself on arrival (see `open`), which is the one path that can
    // still leak a hold.
    this.opening.clear()
  }
}

/** Single-quote a value for a POSIX shell. */
function quote (value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}
