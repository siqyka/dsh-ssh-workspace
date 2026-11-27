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
 * ## The other half: which shells the host actually has
 *
 * The bottom of this file answers a question the Host cannot: its shell picker
 * enumerates shells in the LOCAL
 * execution world (`dsh-api-terminal-controller` calls `resolveExecutable` on a
 * subprocess this plugin wraps only for `spawn` / `spawnTerminal`), so the menu
 * has always listed the shells on THIS machine. The consequence is visible
 * twice — a shell only the host has cannot be selected, and a shell only this
 * machine has can be selected but cannot run there — and `dsh-terminal-bash`
 * then spawns whatever path the menu produced while the terminal module maps the
 * shell FAMILY back to a name on the host, so the label and the process are two
 * independent guesses.
 *
 * So the discovery half sweeps the host once per connection generation, and
 * feeds both sides: the picker gets a verified list, and `lib/patch-terminal.js`
 * gets a lookup for "was the shell this argv names actually found there?".
 *
 * Both halves sit here so what the host HAS stays the single source of truth
 * for what the host RUNS.
 *
 * @module @shiqyka/dsh-ssh-workspace/shell
 */

/** Fresh marker per command, so a program that prints one cannot fake an end. */
import { StringDecoder } from 'node:string_decoder'
import { escapeRegExp, shellQuote } from '../core/shared.js'
import { isRemotePath, parseRemotePath } from '../core/protocol.js'

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
   * @param {object} options.channel - the open ssh2 channel.
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
 */
function stripEcho (text) {
  // A terminal turns every newline into CRLF; normalize before splitting so the
  // echo is exactly one line.
  const normalized = text.replace(/\r\n/gu, '\n')
  const newline = normalized.indexOf('\n')
  if (newline < 0) return normalized.trim()
  return normalized.slice(newline + 1).trim()
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
   * @param {string} [options.session] - session name; distinct names get distinct shells.
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
      : `cd ${shellQuote(cwd)} && exec sh -l`
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
   * @param {string} command - POSIX shell command.
   */
  async run (alias, command, options = {}) {
    const started = Date.now()
    const key = `${alias}\u0000${typeof options.session === 'string' && options.session.trim() !== '' ? options.session.trim() : 'default'}`
    const reused = this.shells.has(key) && this.shells.get(key).alive
    const shell = await this.open(alias, options)
    const result = await shell.run(command, { timeoutMs: options.timeoutMs, signal: options.signal })
    // The audit is the SURFACE's obligation, not `engine.exec`'s: a persistent
    // shell writes into a live PTY and never passes through `exec`, so without
    // this the one channel that can keep state across calls was also the one
    // channel missing from "what did the user run". `durationMs` is the whole
    // run, including the open when this call had to create the shell.
    try {
      this.engine?.audit?.record({
        at: started,
        alias,
        command,
        channel: 'shell',
        durationMs: Date.now() - started,
        exitCode: typeof result?.exitCode === 'number' ? result.exitCode : null,
        timedOut: result?.timedOut === true,
        ...(typeof options.sessionId === 'string' && options.sessionId !== '' ? { sessionId: options.sessionId } : {}),
        ...(typeof this.starts.get(key)?.cwd === 'string' ? { cwd: this.starts.get(key).cwd } : {}),
        ...(typeof result?.error === 'string' && result.error !== '' ? { error: result.error } : {}),
      })
    } catch { /* the log never fails the command it describes */ }
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

// ---------------------------------------------------------------------------
// Which shells the host actually has
// ---------------------------------------------------------------------------
//
// This is a capability with its own seam id (`PATCH-shell-discovery`), not a
// `patch-*.js`: `tests/upstream-contract-smoke.mjs` requires every `patch-*.js`
// to declare a retirement contract, which this does not have.

/** Completion marker: a sweep that does not end with this reported nothing usable. */
const SWEEP_DONE = 'dsh-shells-done'

/** One line per verified shell, and one for the account's login shell. */
const SWEEP_LINE = /^dsh-shell:([^:]+):(.*)$/u

/** A shell name safe to paste into a remote script: no quotes, spaces or `;`. */
const SHELL_NAME = /^[A-Za-z0-9._+-]+$/u

/**
 * The candidates asked about when the Host configures none.
 *
 * Mirrors the Host's own default set (`dsh-api-terminal-controller` ships
 * `['zsh','bash','fish','pwsh','powershell','cmd']`) minus the two Windows
 * spellings that a POSIX host can never answer, plus `dash` and `ksh`. `sh` is
 * appended unconditionally in {@link normalizeCandidates}: the plugin's
 * fallback is `sh -l`, so `sh` must always have a row to match.
 */
const DEFAULT_SHELL_CANDIDATES = ['zsh', 'bash', 'fish', 'sh', 'dash', 'ksh', 'pwsh']

/** How long one shell probe may take on the host. */
const SWEEP_TIMEOUT_MS = 10_000

/** One router per engine, so both install sites share its cache. */
const ROUTERS = new WeakMap()

/** `argv[n]`'s file name, with either separator, minus a `.exe` suffix. */
function shellKind (token) {
  const text = String(token ?? '')
  const name = text.split(/[/\\]/u).pop() ?? ''
  return name.toLowerCase().endsWith('.exe') ? name.slice(0, -4).toLowerCase() : name.toLowerCase()
}

/** The displayed name: basename, original case, minus a `.exe` suffix. */
function baseName (token) {
  const text = String(token ?? '')
  const name = text.split(/[/\\]/u).pop() ?? ''
  return name.toLowerCase().endsWith('.exe') ? name.slice(0, -4) : name
}

/**
 * The arguments that make one shell start as a login shell.
 *
 * `-l` rather than the Host's `profile()` `-i` (`dsh-api-terminal-controller/lib/index.js:26-32`):
 * on a PTY stdin IS a terminal, so interactivity happens anyway, while `-l`
 * keeps the semantics continuous with the `exec sh -l` this plugin has always
 * used — the remote `~/.profile` / `~/.zprofile` load, and `PATH` matches what
 * `ssh_workspace_exec` sees. `-i` alone would skip `path_helper` on macOS.
 *
 */
export function shellArgsFor (shellPath) {
  const kind = shellKind(shellPath)
  if (kind === 'cmd') return []
  if (kind === 'pwsh' || kind === 'powershell') return ['-NoLogo']
  return ['-l']
}

/**
 * Normalize a candidate list: keep only names that are safe to paste into a
 * remote script, drop duplicates, and always include `sh`.
 *
 * @param {unknown} configured - the Host's `shellCandidates`, when present.
 */
export function normalizeCandidates (configured) {
  const source = Array.isArray(configured) ? configured : DEFAULT_SHELL_CANDIDATES
  const out = []
  const seen = new Set()
  for (const raw of [...source, 'sh']) {
    if (typeof raw !== 'string') continue
    const name = raw.trim()
    if (name === '' || !SHELL_NAME.test(name)) continue
    // The sweep runs through `sh` on the host, so a Windows executable name is
    // never answerable there; probing it would only add a line that can never
    // match. Drop it rather than carry a candidate that cannot resolve.
    if (name.toLowerCase().endsWith('.exe')) continue
    const kind = name.toLowerCase()
    if (seen.has(kind)) continue
    seen.add(kind)
    out.push(name)
  }
  return out
}

/**
 * The one remote script that answers "which of these shells exist?".
 *
 * `command -v` rather than `/etc/shells`: the latter lists shells the account may
 * not be allowed to run, and misses anything installed outside its table (a
 * Homebrew zsh, `~/.local/bin/fish`). Each marker is printed only when the shell
 * resolved, and `set +e` keeps a missing utility from aborting the sweep under
 * `errexit`. Nothing here reads user input: the names were filtered by
 * {@link SHELL_NAME} and are single-quoted.
 *
 */
function buildShellSweepScript (candidates) {
  const lines = ['set +e']
  for (const name of candidates) {
    const quoted = shellQuote(name)
    lines.push(`command -v ${quoted} >/dev/null 2>&1 && printf 'dsh-shell:%s:%s\\n' ${quoted} "$(command -v ${quoted})"`)
  }
  // The account's login shell goes first: the Host's own `discoverShells` puts
  // the default first, and the picker's first row is the one users take.
  lines.push(`printf 'dsh-shell:login:%s\\n' "\${SHELL:-}"`)
  lines.push(`printf '${SWEEP_DONE}\\n'`)
  return lines.join('; ')
}

/**
 * Parse one sweep's stdout into shell profiles.
 *
 * This is where the honesty rule lives: a sweep that did not reach its
 * completion marker is not "a host with no shells", it is an unknown host, and
 * answering it with a shorter list is exactly the lie this module exists to
 * remove. So a missing marker throws instead of returning a partial answer.
 *
 * Order: the login shell first (when it is an absolute path), then candidate
 * order; one row per shell KIND, so `/bin/bash` and `/usr/bin/bash` do not both
 * appear.
 *
 * @throws {Error} when the completion marker is absent, or nothing was found.
 */
export function parseShellSweep (stdout) {
  const text = String(stdout ?? '')
  if (!text.includes(SWEEP_DONE)) {
    throw new Error(`ssh-workspace: the remote shell sweep produced no ${SWEEP_DONE} marker, so its answer is unknown`)
  }
  let login = ''
  const found = []
  for (const raw of text.split(/\r?\n/u)) {
    const match = SWEEP_LINE.exec(raw.trim())
    if (match === null) continue
    const [, name, value] = match
    const shellPath = value.trim()
    if (shellPath === '') continue
    // A relative value (`fish` from `$SHELL`) is not runnable as a path, and a
    // value with whitespace cannot be a single path either; both are dropped
    // rather than guessed at.
    if (!shellPath.startsWith('/') || /\s/u.test(shellPath)) continue
    if (name === 'login') login = shellPath
    else found.push(shellPath)
  }
  const ordered = login === '' ? found : [login, ...found]
  const seen = new Set()
  const profiles = []
  for (const shellPath of ordered) {
    const kind = shellKind(shellPath)
    if (kind === '' || seen.has(kind)) continue
    seen.add(kind)
    profiles.push({ path: shellPath, name: baseName(shellPath), args: shellArgsFor(shellPath) })
  }
  if (profiles.length === 0) {
    throw new Error('ssh-workspace: the remote shell sweep completed but named no shell')
  }
  return profiles
}

/**
 * Ask one host which shells it has, and remember the answer for its connection.
 *
 * The cache key includes the connection GENERATION (`engine.generationOf(alias)`):
 * a reconnect can land on another machine, or on the same machine after a
 * reinstall, and a list from the previous generation would then describe a host
 * that is no longer there.
 */
export class RemoteShellsRouter {
  constructor (options) {
    this.engine = options.engine
    this.ctx = options.ctx
    this.logger = options.logger
    /** In-flight or settled probes, keyed by alias + NUL + generation. */
    this.probes = new Map()
    /** Settled answers only — the synchronous lookup `spawnTerminal` uses. */
    this.answers = new Map()
  }

  /**
   * The cache key for one host right now.
   *
   */
  keyOf (alias) {
    const generation = typeof this.engine?.generationOf === 'function'
      ? this.engine.generationOf(alias)?.generation ?? 0
      : 0
    return `${alias}\u0000${generation}`
  }

  /**
   * The verified shells for one host, probing at most once per generation.
   *
   * Concurrent callers share the in-flight promise (two menus opened at once
   * cost one round trip), and a failed probe is NOT kept: the next caller
   * retries instead of inheriting the rejection.
   *
   * @param {AbortSignal} [options.signal] - caller cancellation.
   * @throws {Error} when the host cannot be asked, or answered incompletely.
   */
  async discover (alias, options = {}) {
    const key = this.keyOf(alias)
    const cached = this.probes.get(key)
    if (cached !== undefined) return cached
    // A reconnect retires the previous generation's answer: keeping it would
    // both leak one entry per reconnect and, worse, invite a lookup that
    // resolves against a host description that no longer applies.
    this.#retireOtherGenerations(alias, key)
    const probe = this.#probe(alias, options)
    this.probes.set(key, probe)
    try {
      const profiles = await probe
      this.answers.set(key, profiles)
      return profiles
    } catch (error) {
      // Only a settled-and-known answer may be remembered; a rejection must not
      // be, or every later caller would inherit the same failure instead of
      // trying again.
      if (this.probes.get(key) === probe) this.probes.delete(key)
      this.answers.delete(key)
      throw error
    }
  }

  /**
   * Drop every entry for this alias except the current generation's.
   *
   * @param {string} keep - the key that must survive.
   */
  #retireOtherGenerations (alias, keep) {
    const prefix = `${alias}\u0000`
    for (const store of [this.probes, this.answers]) {
      for (const key of store.keys()) {
        if (key !== keep && key.startsWith(prefix)) store.delete(key)
      }
    }
  }

  /**
   * The verified profile for an argv[0], from the settled cache only.
   *
   * Deliberately synchronous and never probing: this runs on the terminal-open
   * path, and a host that was never asked (menu never opened) must not turn into
   * a surprise round trip there. "Not found" is the safe answer and simply keeps
   * the previous behaviour.
   *
   * @param {string} token - the argv[0] a caller asked to run.
   * @returns {{path: string, name: string, args: string[]} | undefined} the profile.
   */
  shellProfile (alias, token) {
    if (typeof token !== 'string' || token === '') return undefined
    const list = this.answers.get(this.keyOf(alias))
    if (list === undefined || list.length === 0) return undefined
    const wanted = shellKind(token)
    return list.find(profile => shellKind(profile.path) === wanted)
  }

  /**
   * Which host (if any) one session's working directory names.
   *
   * Reads the `workingDirectory` projection rather than resolving it: `get()`
   * is synchronous and side-effect free, while `ensure()` performs filesystem
   * I/O and can REWRITE the session's cwd (with a notice) when the original is
   * gone (`dsh-working-directory/lib/index.js:140-148`) — not something drawing
   * a menu should be able to do.
   *
   * @returns {{alias: string, remotePath: string} | undefined} the remote parts.
   */
  remoteCwdOf (agent) {
    const provider = this.ctx?.get?.('workingDirectory')
    let cwd
    if (provider !== undefined && typeof provider.get === 'function' && agent?.session !== undefined) {
      try {
        cwd = provider.get(agent.session)
      } catch {
        // A projection read that throws is "unknown", never "remote".
        cwd = undefined
      }
    }
    if (typeof cwd !== 'string') cwd = agent?.session?.header?.cwd
    if (!isRemotePath(cwd)) return undefined
    try {
      const parts = parseRemotePath(cwd)
      return parts === undefined ? undefined : { alias: parts.alias, remotePath: parts.remotePath }
    } catch {
      // A malformed `ssh://` spelling is not a host to probe; treat the session
      // as local and let the Host's own rule answer.
      return undefined
    }
  }

  /**
   * One round trip: ask the host, then parse.
   *
   */
  async #probe (alias, options) {
    const candidates = normalizeCandidates(options.candidates)
    const script = buildShellSweepScript(candidates)
    const outcome = await this.engine.exec(alias, script, {
      timeoutMs: SWEEP_TIMEOUT_MS,
      signal: options.signal,
      // `command -v` and reading `$SHELL` are read-only by construction, the
      // same class as the capability probe, so a lost connection may replay it.
      replay: 'safe',
      channel: 'exec',
    })
    // Same shape as `probeCapabilities`: a transport failure is unknown, while
    // "ran and exited 0 with a completion marker" is an answer.
    if (outcome?.success !== true && outcome?.exitCode !== 0) {
      throw new Error(`ssh-workspace: the remote shell sweep on ${alias} failed (${outcome?.error ?? `exit ${String(outcome?.exitCode)}`})`)
    }
    return parseShellSweep(outcome?.stdout)
  }
}

/**
 * The router for one engine, created on first use.
 *
 * Shared so the picker half and the terminal half read the same cache without
 * either of them having to be installed first.
 *
 */
export function shellsRouterFor (engine) {
  let router = ROUTERS.get(engine)
  if (router === undefined) {
    router = new RemoteShellsRouter({ engine })
    ROUTERS.set(engine, router)
  }
  return router
}

/**
 * The `terminalController.shells` takeover's marker property.
 *
 * Installed routers are stored under this symbol so a second install is a no-op
 * and uninstall can tell "mine" from "somebody else's".
 */
const INSTALLED = Symbol.for('@shiqyka/dsh-ssh-workspace/shell-discovery-installed')

/** The original `shells` method, kept for uninstall. */
const ORIGINAL = Symbol.for('@shiqyka/dsh-ssh-workspace/shell-discovery-original')

/**
 * Answer the shell picker from the remote host for `ssh://` sessions.
 *
 * ## Why `defineProperty` and not assignment
 *
 * Cordis services are traceable proxies: `set` lands on the proxy's shadow, not
 * on the service (`@deepseek-ai/cordis/lib/index.js:125-160`), while `get` looks
 * up a real property descriptor first (`:75-81`). An own property is therefore
 * visible to every reader and still lets `delete` restore visibility of the
 * prototype method.
 *
 * ## Why this is not a second endpoint
 *
 * The Gateway resolves endpoint bindings through `originalOf(receiver)` and the
 * PROTOTYPE descriptor (`dsh-api-gateway/lib/index.js:1707-1715`), and calls
 * `Reflect.get(callReceiver, 'shells')` at invoke time (`:1212-1214`). Adding an
 * own property changes neither the namespace, the method name, nor the
 * descriptor the binding was built from — this REPLACES an existing endpoint's
 * implementation rather than declaring a new endpoint, so `ambiguous-endpoint`
 * cannot fire.
 *
 * @param {RemoteShellsRouter} [options.router] - the router to use (shared by default).
 * @returns {RemoteShellsRouter | undefined} the router, or undefined when the service is absent.
 * @throws {Error} when the service exists but does not look like what we patch.
 */
export function installShellDiscovery (ctx, options = {}) {
  const target = ctx.get('terminalController')
  if (target === undefined || target === null) return undefined
  if (target[INSTALLED] !== undefined) return target[INSTALLED]
  if (typeof target.shells !== 'function') {
    // Every other patch throws on a shape mismatch. Returning `undefined` here
    // would report the seam as `absent` — "this composition does not have it" —
    // when the truth is "it has something else", which is exactly the silent
    // break the contract table exists to catch.
    throw new Error('ssh-workspace: the mounted ctx.terminalController has no shells() to wrap')
  }

  const engine = options.engine
  const router = options.router ?? shellsRouterFor(engine)
  router.ctx = ctx
  if (options.logger !== undefined) router.logger = options.logger
  const original = target.shells
  // Bind BEFORE defining, or the wrapper would call itself (stack overflow).
  const localShells = original.bind(target)
  const shells = async function (agent, signal) {
    const cwd = router.remoteCwdOf(agent)
    if (cwd === undefined) return localShells(agent, signal)
    // A detached workspace must not be touched — not even for a probe. Its
    // whole promise is "nothing runs against this host until you re-enable it".
    engine.assertNotDisabled(cwd.alias, cwd.remotePath)
    return router.discover(cwd.alias, { signal, candidates: target.config?.shellCandidates })
  }
  Object.defineProperty(target, 'shells', { value: shells, writable: true, configurable: true, enumerable: false })
  Object.defineProperty(target, INSTALLED, { value: router, writable: false, configurable: true, enumerable: false })
  Object.defineProperty(target, ORIGINAL, { value: original, writable: false, configurable: true, enumerable: false })
  options.logger?.info?.('ssh-workspace: the shell picker answers from the remote host for ssh:// sessions')
  return router
}

/**
 * Undo {@link installShellDiscovery}.
 *
 * Mirrors `uninstallRemoteTerminal`: restore the own property when there was
 * one, otherwise drop the one we added so the prototype method shows through
 * again.
 *
 */
export function uninstallShellDiscovery (target) {
  if (target === undefined || target === null) return
  if (target[INSTALLED] === undefined) return
  const original = target[ORIGINAL]
  if (original !== undefined) {
    Object.defineProperty(target, 'shells', { value: original, writable: true, configurable: true, enumerable: false })
  } else if (Object.hasOwn(target, 'shells')) {
    delete target.shells
  }
  delete target[INSTALLED]
  delete target[ORIGINAL]
}
