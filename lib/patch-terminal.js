/**
 * Remote PTY terminals: route the harness's terminal primitive to an SSH host.
 *
 * The harness keeps a persistent-shell feature (`dsh-terminal-bash`) that talks
 * to `ctx.subprocess.spawnTerminal`. That primitive is a *local* one: it hands
 * the request to node-pty on this machine. So a persistent shell whose working
 * directory is an `ssh://` workspace would either fail or, worse, start a local
 * shell against a path that only exists on the remote host.
 *
 * This module closes that seam the same way `patch-subprocess.js` closes
 * `spawn`: when the spec's `cwd` names a remote workspace, the terminal is
 * opened as an SSH PTY channel instead of a local process, and the returned
 * handle satisfies the contract the harness's terminal session relies on
 * (`output`, `write`, `resize`, `done`, `inspectForeground`, `signalForeground`,
 * `terminate`).
 *
 * ## Why the argv is not reused, but the dialect is
 *
 * `dsh-terminal-bash` builds `argv` from ITS dialect: on Windows that is
 * PowerShell and the session then speaks PowerShell to the process. A remote
 * POSIX host cannot run that command line, and handing it over anyway fails in
 * ways that look like a plugin bug. So the remote half starts the remote host's
 * own interactive shell instead: the same shell FAMILY the user picked in the
 * sidebar (`bash` → `bash -l`, `zsh` → `zsh -l`, …) from a fixed whitelist,
 * falling back to the POSIX `sh -l` a minimal host is guaranteed to have.
 * Windows dialects have no POSIX remote equivalent and keep `sh -l`. The
 * session's readiness protocol is identical either way, because the harness
 * drives it over the same channel.
 *
 * ## Foreground inspection
 *
 * The local handle answers `inspectForeground()` from the machine's process
 * table. There is no equivalent that a single SSH channel can read cheaply, and
 * a wrong answer is worse than none: `dsh-terminal-bash` treats a foreground
 * process group as "still running" and would wait out its whole timeout before
 * settling. Returning `undefined` selects the harness's documented fallback —
 * readiness is inferred from output silence — which is correct and only slightly
 * less precise.
 *
 * ## The sandbox-mode gate
 *
 * A remote PTY is unconfined command execution: the `sh -l` it starts runs as
 * the remote login user with that user's full permissions, exactly like
 * `ssh_workspace_exec`. `read-only` therefore has to refuse it, and the refusal
 * lives in this module rather than in `ctx.terminals.spawn` because this is the
 * single point BOTH terminal paths converge on:
 *
 * | path                          | reaches spawnTerminal through            |
 * | ----------------------------- | ---------------------------------------- |
 * | `terminal_open` / `_send`     | `ctx.terminals` → `dsh-terminal-bash`    |
 * | the sidebar's browser terminal| `dsh-api-terminal-controller`, directly  |
 *
 * A gate on `ctx.terminals.spawn` would miss the second one entirely. The
 * session identity still travels: both callers stamp `DSH_SESSION_ID` into
 * `spec.env`, and `ctx.get('agents').get(id)` is the harness's own lookup.
 *
 * The gate has TWO halves, because refusing only the open would protect just a
 * session that was already `read-only`:
 *
 * - {@link RemoteTerminalRouter.spawnTerminal} refuses to open a PTY at all;
 * - {@link RemoteTerminalHandle.write} re-reads the mode per write, so a shell
 *   opened under `workspace-write` and then narrowed to `read-only` stops taking
 *   commands immediately. Control bytes (SIGINT, the `close` path) stay allowed,
 *   or "view only" would also mean "cannot stop what you already started".
 *
 * @module @shiqyka/dsh-ssh-workspace/patch-terminal
 */

import { PassThrough } from 'node:stream'

import { assertRemoteCommandAllowed, sessionPolicyOf } from './mode-gate.js'
import { isRemotePath } from './protocol.js'

/** Marker property carrying the router installed on a service instance. */
const INSTALLED = Symbol.for('@shiqyka/dsh-ssh-workspace/terminal-installed')

/** How recently bytes must have moved for a remote terminal to report `busy`. */
const ACTIVITY_WINDOW_MS = 10_000

/**
 * How long `terminate()` waits for the peer's CHANNEL_CLOSE before dropping the
 * channel locally. The handle's own promises are settled immediately; this only
 * releases the ssh2 channel record of a peer that never answers.
 */
const TERMINATE_RELEASE_MS = 250

/** Marker property carrying the original `spawnTerminal` an install replaced. */
const ORIGINAL = Symbol.for('@shiqyka/dsh-ssh-workspace/terminal-original')

/**
 * A promise plus its settling functions.
 *
 * `Promise.withResolvers()` would say this in one call, but it landed in Node 22
 * and this plugin declares `engines.node >= 20` — calling it there throws a
 * TypeError, which is how the terminal suite broke CI on Node 20 while passing
 * on a newer local runtime. The shape is kept identical to that method's result
 * so the call sites read the same.
 *
 * @returns {{promise: Promise<unknown>, resolve: Function, reject: Function}}
 *   the deferred promise and its settle functions.
 */
function deferred () {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * The remote shell to start for a requested local shell.
 *
 * `dsh-terminal-bash` builds `argv` from the LOCAL dialect, and the sidebar's
 * shell picker lists LOCAL shells, so a user who picks "bash" expects bash on
 * the other side. The remote host is a different machine with a different shell
 * inventory, so the argv itself is not reused — only its DIALECT is: start the
 * same shell family by name on the remote host, and fall back to the POSIX `sh`
 * that a minimal host is guaranteed to have.
 *
 * Windows dialects (`pwsh`, `powershell`, `cmd`) have no POSIX remote
 * equivalent; those keep the upstream `sh -l` behaviour. The name comes from a
 * whitelist, never from the spec, so nothing here can interpolate a command.
 *
 * @param {string[] | undefined} argv - the local terminal argv.
 * @returns {string} a shell snippet ending in `exec`.
 */
function remoteShellCommand (argv) {
  const first = Array.isArray(argv) && typeof argv[0] === 'string' ? argv[0] : ''
  const file = first.split(/[/\\]/u).pop() ?? ''
  const stem = (file.toLowerCase().endsWith('.exe') ? file.slice(0, -4) : file).toLowerCase()
  /** Shell families whose `-l` login spelling is the same as the local one. */
  const dialect = { bash: 'bash', zsh: 'zsh', fish: 'fish', ksh: 'ksh', tcsh: 'tcsh', csh: 'csh' }[stem]
  if (dialect === undefined) return 'exec sh -l'
  return `if command -v ${dialect} >/dev/null 2>&1; then exec ${dialect} -l; else exec sh -l; fi`
}

/**
 * One remote terminal: an SSH PTY channel exposed as the handle shape that
 * `dsh-terminal-bash` drives.
 */
class RemoteTerminalHandle {
  /**
   * @param {object} options - handle options.
   * @param {object} options.channel - the open ssh2 channel (a PTY).
   * @param {Function} options.release - releases the connection hold.
   * @param {string} options.alias - host alias.
   * @param {Function} [options.modeReader] - resolves the session's current sandbox
   *   policy: a mode string, or the resolved policy object (so an unresolvable
   *   policy can be reported as such rather than as a mode the user chose).
   * @param {string} [options.target] - the `ssh://` target, for refusal messages.
   * @param {object} [options.logger] - a Cordis logger.
   */
  constructor (options) {
    this.alias = options.alias
    this.channel = options.channel
    this.logger = options.logger
    this.modeReader = options.modeReader
    this.target = options.target
    /** Local pid stand-in: a remote PTY has no local pid. */
    this.pid = -1
    /** Terminal output stream; the harness pipes this into its emulator. */
    this.output = new PassThrough()
    this.exited = false
    this.closed = false
    /** Whether `output`/`done` have settled; both settle at most once. */
    this.settled = false
    /** Whether the peer confirmed the channel close (ssh2's 'close' event). */
    this.channelClosed = false
    this.outcome = deferred()
    this.done = this.outcome.promise
    // A transport failure rejects `done`, and a rejected promise with no
    // handler would take the whole host process down. Every real consumer still
    // observes the rejection; this only keeps "nobody is listening yet" from
    // being fatal.
    this.done.catch(() => {})
    // Activity bookkeeping for the harness's retention monitor (see
    // inspectActivity): the last time bytes moved in either direction, and a
    // revision that changes whenever they do.
    this.activityAt = Date.now()
    this.activityRevision = 1
    // The engine's own close handler also releases the hold, so this wrapper
    // must release at most once.
    const releaseOnce = options.release
    let released = false
    this.release = () => {
      if (released) return
      released = true
      releaseOnce()
    }
    this.channel.on('data', (chunk) => { this.#onData(chunk) })
    this.channel.stderr?.on?.('data', (chunk) => { this.#onData(chunk) })
    this.channel.once('close', (code, signal) => { this.#onClose(code, signal) })
    this.channel.once('error', (error) => { this.#fail(error) })
  }

  /** Whether the remote PTY has not yet reported its exit. */
  get running () {
    return !this.exited
  }

  /**
   * Forward one chunk of terminal bytes to the output stream.
   *
   * @param {Buffer|string} chunk - raw terminal bytes.
   */
  #onData (chunk) {
    if (this.exited) return
    this.activityAt = Date.now()
    this.activityRevision += 1
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    if (!this.output.write(bytes)) {
      // The harness drains on its own schedule; pausing would need flow control
      // back into ssh2, which a channel does not expose. Buffering is bounded by
      // the harness's own scrollback cap, so letting PassThrough queue is right.
    }
  }

  /**
   * Settle the handle exactly once: end the output stream and resolve or reject
   * `done`.
   *
   * The harness treats `output` ending (and `done` settling) as "the process
   * finished", and its cleanup path awaits both after `terminate()`. Waiting for
   * ssh2's 'close' event instead is unsafe: that event is only emitted when the
   * PEER confirms the close, so a channel whose remote end stays quiet would
   * leave the harness's `close()` — and its owner record — pending forever.
   * That is what turned one unconfirmed close into a terminal identity that
   * could neither be attached nor removed.
   *
   * @param {{exitCode?: number|null, signal?: string|null, error?: Error}} [outcome]
   *   the terminal's ending.
   */
  #settle (outcome = {}) {
    if (this.settled) return
    this.settled = true
    this.exited = true
    const failure = outcome.error
    // End — never `destroy(error)` — the output stream: the harness reads it in
    // a `for await`, and a destroyed stream would raise an 'error' event on a
    // PassThrough that may have no reader yet (the allocation-failure path
    // terminates a handle before any emulator exists), which crashes the host.
    // The failure travels on `done`, which is where the harness looks for it.
    try { this.output.end() } catch { /* the stream was already torn down */ }
    this.release()
    if (failure === undefined) {
      this.outcome.resolve({
        exitCode: typeof outcome.exitCode === 'number' ? outcome.exitCode : null,
        signal: typeof outcome.signal === 'string' ? outcome.signal : null,
      })
    } else {
      this.outcome.reject(failure)
    }
  }

  /**
   * Settle the terminal when the channel closes.
   *
   * @param {number|null} code - exit status, null when the channel died.
   * @param {string|null} signal - exit signal, when one was reported.
   */
  #onClose (code, signal) {
    this.channelClosed = true
    this.#settle({
      exitCode: typeof code === 'number' ? code : null,
      signal: typeof signal === 'string' ? signal : null,
    })
  }

  /**
   * Settle the terminal on a transport failure.
   *
   * @param {unknown} error - the failure.
   */
  #fail (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    this.#settle({ error: failure })
  }

  /**
   * Write input into the terminal.
   *
   * This is the SECOND half of the terminal gate. Refusing only the OPEN
   * protects a session that was already `read-only`; it does nothing for a PTY
   * opened legitimately and then switched to `read-only` while it stayed open,
   * which is the more likely sequence in practice — open a shell, get some work
   * done, then narrow the mode. Every keystroke and every `terminal_send` passes
   * through here, so the mode is re-read per write rather than once per open.
   *
   * Control bytes are exempt: a SIGINT from `signalForeground` and the `close`
   * path must keep working, or "view only" would also mean "cannot stop the
   * command you already started".
   *
   * @param {string} data - keystrokes or pasted text.
   * @returns {Promise<void>} resolves once the channel accepted the bytes.
   * @throws {Error} when the session's mode forbids driving this terminal.
   */
  async write (data) {
    if (this.settled || this.closed) throw new Error('terminal process has exited')
    const controlOnly = typeof data === 'string' && /^[\u0000-\u001f]*$/u.test(data)
    if (!controlOnly) {
      // The mode is re-read per write (see the class docs): a shell opened under
      // `workspace-write` and narrowed to `read-only` afterwards must stop taking
      // commands immediately.
      assertRemoteCommandAllowed(this.modeReader?.(), 'send input to a remote terminal', this.target)
    }
    // ssh2's Channel._write() drops the callback without calling it when the
    // channel is not `open` (`if (outgoing.state !== 'open') return;`), which
    // would leave this promise pending forever — and the harness runs EVERY
    // terminal operation through one serialized queue, so a single pending
    // promise stops output, input and later attachments for this terminal.
    // Refuse instead: an unprovable accept is reported, never awaited.
    const state = this.channel?.outgoing?.state
    if (state !== undefined && state !== 'open') {
      throw new Error('terminal channel is no longer open')
    }
    await new Promise((resolve, reject) => {
      this.channel.write(data, (error) => {
        if (error !== undefined && error !== null) reject(error)
        else resolve()
      })
    })
    this.activityAt = Date.now()
    this.activityRevision += 1
  }

  /**
   * Resize the remote PTY.
   *
   * `ssh2.Channel.setWindow(rows, cols, height, width)` takes NO callback and
   * returns `undefined`: it reports nothing back, ever. Awaiting a callback
   * there is what wedged the browser terminal — the promise never settled, so
   * `dsh-api-terminal-controller`'s serialized operation queue stopped dead:
   * the snapshot stayed the only frame, output stopped, keystrokes were never
   * acknowledged, and every later attach hung at its own `enqueue()` (a panel
   * stuck on "connecting"). A window change is advisory and idempotent, so this
   * is fire-and-forget by design; only a transport-level throw is reported.
   *
   * @param {number} cols - columns.
   * @param {number} rows - rows.
   * @returns {Promise<void>} resolves as soon as the change was handed to ssh2.
   */
  async resize (cols, rows) {
    if (this.settled || this.closed) return
    const state = this.channel?.outgoing?.state
    if (state !== undefined && state !== 'open') {
      return
    }
    try {
      this.channel.setWindow(rows, cols, 0, 0)
    } catch (error) {
      // A window change that cannot be sent must not fail the attachment: the
      // terminal still works at its previous size.
      this.logger?.warn?.(`ssh-workspace: remote terminal resize failed: ${String(error?.message ?? error)}`)
    }
  }

  /**
   * Report no foreground information.
   *
   * A remote channel cannot read the host's process table cheaply, and a wrong
   * answer would make the harness wait out its whole readiness timeout. `undefined`
   * selects its output-silence fallback, which is correct.
   *
   * @returns {Promise<undefined>} always undefined.
   */
  async inspectForeground () {
    return undefined
  }

  /**
   * Report terminal activity for the harness's unattended-retention monitor.
   *
   * `dsh-api-terminal-controller` calls this on the handle to decide whether an
   * unattended browser terminal may be reclaimed. The local backend answers from
   * the process table; one SSH channel cannot, and a wrong "idle" would close a
   * terminal in the middle of a long remote command. So: recently moved bytes →
   * `busy`; quiet → `unknown` (which the monitor treats as "no reason to close");
   * exited → `idle`. The revision advances on every output/input event so a
   * still-active terminal is distinguishable from one that has been silent
   * since the last observation.
   *
   * @returns {Promise<{state: 'busy' | 'idle' | 'unknown', revision: number}>} activity.
   */
  async inspectActivity () {
    if (this.exited) return { state: 'idle', revision: this.activityRevision }
    const quietMs = Date.now() - this.activityAt
    return {
      state: quietMs < ACTIVITY_WINDOW_MS ? 'busy' : 'unknown',
      revision: this.activityRevision,
    }
  }

  /**
   * Deliver a signal to the terminal's foreground process.
   *
   * A PTY has no out-of-band signalling, so the conventional byte is written
   * instead: `\x03` (ETX) is what a terminal turns into SIGINT, and `\x1c`
   * (FS) is SIGQUIT. Other signals have no PTY equivalent and are refused
   * rather than silently ignored.
   *
   * @param {string} signal - the signal name.
   * @returns {Promise<number>} the pseudo process group id.
   * @throws {Error} for a signal a terminal cannot express.
   */
  async signalForeground (signal) {
    if (this.exited) throw new Error('terminal process has exited')
    if (signal === 'SIGINT') {
      await this.write('\u0003')
      return this.pid
    }
    if (signal === 'SIGQUIT') {
      await this.write('\u001c')
      return this.pid
    }
    if (signal === 'SIGTERM' || signal === 'SIGKILL' || signal === 'SIGHUP') {
      // Closing the channel makes the remote shell receive SIGHUP, which is the
      // closest available behaviour; terminate() is the documented path.
      await this.terminate()
      return this.pid
    }
    throw new Error(`signal ${signal} is not expressible over an SSH PTY`)
  }

  /**
   * Close the terminal and release its connection hold.
   *
   * `handle.terminate()` is the ONLY thing the harness's cleanup awaits before
   * it waits for the output stream to end, and it then removes the terminal's
   * owner record. Waiting for the peer's CHANNEL_CLOSE here (ssh2 only emits
   * 'close' when the peer confirms) leaves that chain pending whenever the
   * remote end stays quiet: the identity is marked closed but never removed, so
   * it can neither be attached nor re-created, and the remote shell leaks. So:
   * ask for the close, then settle the handle's own promises at once and give
   * the peer a short grace period before dropping the channel locally.
   *
   * @returns {Promise<void>} resolves once the handle is settled and its hold released.
   */
  async terminate () {
    if (this.closed) return
    this.closed = true
    try { this.channel.close() } catch { /* channel already gone */ }
    this.#settle({ exitCode: null, signal: null })
    if (!this.channelClosed) {
      const timer = setTimeout(() => {
        if (this.channelClosed) return
        try { this.channel.destroy?.() } catch { /* channel already gone */ }
      }, TERMINATE_RELEASE_MS)
      timer.unref?.()
    }
  }
}

/**
 * Router that opens remote PTYs and falls back to the local primitive.
 */
export class RemoteTerminalRouter {
  /**
   * @param {object} options - router options.
   * @param {import('./engine.js').SshWorkspaceEngine} options.engine - live engine.
   * @param {object} [options.ctx] - host plugin context, for sandbox-policy resolution.
   * @param {object} [options.logger] - a Cordis logger.
   */
  constructor (options) {
    this.engine = options.engine
    this.ctx = options.ctx
    this.logger = options.logger
  }

  /**
   * Open one terminal, remotely when the cwd is an `ssh://` workspace.
   *
   * The mode gate lives HERE rather than in the caller because this is the one
   * point both terminal paths converge on: the `terminal_open` tool (via
   * `ctx.terminals` → `dsh-terminal-bash` → `spawnTerminal`) and the sidebar's
   * browser terminal (`dsh-api-terminal-controller` calls `spawnTerminal`
   * directly, with no `ctx.terminals` involved at all). A gate installed on
   * `ctx.terminals.spawn` would therefore miss the second path entirely.
   *
   * The session identity travels in `spec.env.DSH_SESSION_ID`, which BOTH
   * callers set (`childEnvironment` and the controller's own `env`), so the
   * mode is resolvable here even though the spec carries no owner.
   *
   * @param {object} spec - the harness's terminal spec.
   * @returns {Promise<RemoteTerminalHandle>} the handle.
   * @throws {Error} when the session's mode forbids running a command here.
   */
  async spawnTerminal (spec) {
    const parts = parseRemoteCwd(spec?.cwd)
    if (parts === undefined) throw new Error('ssh-workspace: spawnTerminal needs an ssh:// cwd')
    this.engine.assertNotDisabled(parts.alias, parts.remotePath)
    // A remote PTY is unconfined command execution: the shell it starts runs as
    // the remote login user. Under `read-only` that is exactly the mutation the
    // mode forbids, so it is refused before a connection is opened.
    assertRemoteCommandAllowed(
      sessionPolicyOf(this.ctx, sessionOfSpec(this.ctx, spec)),
      'open a remote terminal',
      `ssh://${parts.alias}${parts.remotePath}`,
    )
    const cols = Number.isFinite(spec?.cols) && spec.cols > 0 ? Math.floor(spec.cols) : 80
    const rows = Number.isFinite(spec?.rows) && spec.rows > 0 ? Math.floor(spec.rows) : 24
    const term = typeof spec?.terminalType === 'string' && spec.terminalType !== '' ? spec.terminalType : 'xterm-256color'
    //
    // The user picks a shell by name in the sidebar; upstream always executed
    // `sh -l` remotely, so picking "bash" still landed in `sh`. Start the same
    // shell family on the remote host (whitelist) and fall back to `sh -l`.
    const shellCommand = remoteShellCommand(spec?.argv)
    const command = parts.remotePath === '/' ? shellCommand : `cd ${quote(parts.remotePath)} && ${shellCommand}`
    //
    // `spec.signal` bounds the ALLOCATION, not the terminal. The host's local
    // backend hands it to node-pty's spawn, so the process outlives the call
    // that started it; `openChannel()` instead closes the SSH channel when its
    // signal aborts. The browser terminal passes a per-request signal
    // (`dsh-api-terminal-controller/lib/index.js:844` `create(agent, request,
    // signal)` → `spawn(...)`), which aborts as soon as that RPC settles — the
    // PTY would close immediately and the panel would show an empty terminal
    // that takes no input, while `terminal_open` (a long-lived tool signal) is
    // unaffected. Scope the signal to the opening phase.
    const opening = new AbortController()
    const forwardAbort = () => {
      opening.abort(spec?.signal?.reason)
    }
    if (spec?.signal?.aborted === true) forwardAbort()
    else spec?.signal?.addEventListener?.('abort', forwardAbort, { once: true })
    let opened
    try {
      opened = await this.engine.openChannel(parts.alias, command, {
        signal: opening.signal,
        pty: { cols, rows, term },
      })
    } catch (error) {
      throw error
    } finally {
      spec?.signal?.removeEventListener?.('abort', forwardAbort)
    }
    this.logger?.info?.(`ssh-workspace: opened remote terminal on ${parts.alias} in ${parts.remotePath}`)
    return new RemoteTerminalHandle({
      alias: parts.alias,
      channel: opened.channel,
      release: opened.release,
      logger: this.logger,
      // Resolved per write, not once: a session switched to `read-only` while
      // this PTY is open must stop accepting commands immediately. The whole
      // resolved policy travels (not just the mode) so a POLICY THAT CANNOT BE
      // RESOLVED is reported as the wiring problem it is, rather than being
      // flattened into a plausible "the mode is read-only".
      modeReader: () => sessionPolicyOf(this.ctx, sessionOfSpec(this.ctx, spec)),
      target: `ssh://${parts.alias}${parts.remotePath}`,
    })
  }
}

/**
 * Resolve the session that asked for a terminal, from the spec's environment.
 *
 * Both terminal callers stamp `DSH_SESSION_ID`, but a spec built by hand (or by
 * a future backend) may not. An absent id yields no session, and the mode then
 * falls back to the deployment default rather than being guessed from the cwd.
 *
 * @param {object} [ctx] - host plugin context.
 * @param {object} [spec] - the terminal spec.
 * @returns {object | undefined} the session, when one can be found.
 */
function sessionOfSpec (ctx, spec) {
  const id = spec?.env?.DSH_SESSION_ID
  if (typeof id !== 'string' || id === '') return undefined
  const agents = ctx?.get?.('agents') ?? ctx?.agents
  if (agents === undefined || agents === null || typeof agents.get !== 'function') return undefined
  try {
    return agents.get(id)?.session
  } catch {
    return undefined
  }
}

/**
 * Split an `ssh://alias/path` working directory.
 *
 * @param {unknown} value - the spec's cwd.
 * @returns {{alias: string, remotePath: string} | undefined} the parts, or undefined when local.
 */
function parseRemoteCwd (value) {
  if (!isRemotePath(value)) return undefined
  const match = /^ssh:\/\/([^/]+)(\/.*)?$/u.exec(value)
  if (match === null) return undefined
  return { alias: match[1], remotePath: match[2] !== undefined && match[2] !== '' ? match[2] : '/' }
}

/** Single-quote a value for a POSIX shell. */
function quote (value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

/**
 * Install the remote terminal half onto the live `ctx.subprocess` service.
 *
 * `spawn` may already be wrapped by {@link installRemoteSubprocess}; the two
 * installations are independent and only this symbol is consulted here.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 * @param {object} options - install options.
 * @param {import('./engine.js').SshWorkspaceEngine} options.engine - live engine.
 * @param {object} [options.logger] - a Cordis logger, when available.
 * @returns {RemoteTerminalRouter | undefined} the router, or undefined when no `subprocess` service is mounted.
 * @throws {Error} when the mounted service has no `spawnTerminal()` to wrap.
 */
export function installRemoteTerminal (ctx, options) {
  const target = ctx.get('subprocess')
  if (target === undefined || target === null) return undefined
  if (target[INSTALLED] !== undefined) return target[INSTALLED]

  const originalSpawnTerminal = target.spawnTerminal
  if (typeof originalSpawnTerminal !== 'function') {
    throw new Error('ssh-workspace: the mounted ctx.subprocess service has no spawnTerminal() to wrap')
  }
  const local = originalSpawnTerminal.bind(target)
  const router = new RemoteTerminalRouter({ ...options, ctx })
  const spawnTerminal = function (spec) {
    const remote = spec !== null && typeof spec === 'object' && isRemotePath(spec.cwd)
    if (remote) {
      return router.spawnTerminal(spec)
    }
    return local(spec)
  }
  Object.defineProperty(target, 'spawnTerminal', { value: spawnTerminal, writable: true, configurable: true, enumerable: false })
  Object.defineProperty(target, INSTALLED, { value: router, writable: false, configurable: true, enumerable: false })
  // Remember the original so uninstall restores the real method: when the
  // service carried its own `spawnTerminal`, deleting the wrapper would leave
  // the instance without one at all.
  Object.defineProperty(target, ORIGINAL, { value: originalSpawnTerminal, writable: false, configurable: true, enumerable: false })
  options.logger?.info?.('ssh-workspace: took over ctx.subprocess.spawnTerminal for ssh:// cwds')
  return router
}

/**
 * Undo {@link installRemoteTerminal}, restoring the original `spawnTerminal`.
 *
 * @param {object | undefined} target - the patched service instance.
 * @returns {void}
 */
export function uninstallRemoteTerminal (target) {
  if (target === undefined || target === null) return
  if (target[INSTALLED] === undefined) return
  const original = target[ORIGINAL]
  if (original !== undefined) {
    Object.defineProperty(target, 'spawnTerminal', { value: original, writable: true, configurable: true, enumerable: false })
    delete target[ORIGINAL]
  } else if (Object.hasOwn(target, 'spawnTerminal')) {
    delete target.spawnTerminal
  }
  delete target[INSTALLED]
}

/** Marker property carrying the shell-list patch state. */
const SHELLS_INSTALLED = Symbol.for('@shiqyka/dsh-ssh-workspace/terminal-shells-installed')

/** Marker property carrying the original `shells` method. */
const SHELLS_ORIGINAL = Symbol.for('@shiqyka/dsh-ssh-workspace/terminal-shells-original')

/** How long one alias's probed shell list stays fresh. */
const SHELLS_TTL_MS = 60_000

/**
 * Ask the remote host which shells it actually has.
 *
 * `command -v` is the portable answer: a shell may live in `/usr/bin`, `/bin`
 * or the account's own bin, and `/etc/shells` also lists shells this user may
 * not run. The passwd login shell goes first, so the picker's default is the
 * shell the account really starts with.
 *
 * @param {import('./engine.js').SshWorkspaceEngine} engine - live engine.
 * @param {string} alias - host alias.
 * @returns {Promise<Array<{path: string, name: string, args: string[]}>>} verified profiles.
 */
async function probeRemoteShells (engine, alias) {
  const script = 'd=$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f7); echo "login=$d"; '
    + 'for s in bash zsh fish ksh tcsh csh dash sh; do p=$(command -v "$s" 2>/dev/null) && echo "$s=$p"; done'
  const result = await engine.exec(alias, script, { timeoutMs: 20_000, replay: 'safe' })
  const found = []
  let login
  for (const raw of String(result?.stdout ?? '').split('\n')) {
    const match = /^(login|[a-z]+)=(\/[^\s]+)$/u.exec(raw.trim())
    if (match === null) continue
    const [, kind, shellPath] = match
    if (kind === 'login') login = shellPath
    else found.push(shellPath)
  }
  // One entry per executable NAME, the login shell first: the Host's own
  // discoverShells keeps the earliest path per kind, and `/bin/bash` plus
  // `/usr/bin/bash` must not appear as two identical picker rows.
  const ordered = typeof login === 'string' && login.startsWith('/') ? [login, ...found] : found
  const profiles = []
  const seen = new Set()
  for (const shellPath of ordered) {
    const kind = shellPath.slice(shellPath.lastIndexOf('/') + 1).toLowerCase()
    if (seen.has(kind)) continue
    seen.add(kind)
    profiles.push(profileFor(shellPath))
  }
  return profiles
}

/**
 * One shell profile in the shape `dsh-api-terminal-controller` returns.
 *
 * @param {string} shellPath - absolute shell path.
 * @returns {{path: string, name: string, args: string[]}} the profile.
 */
function profileFor (shellPath) {
  const name = shellPath.slice(shellPath.lastIndexOf('/') + 1)
  return { path: shellPath, name, args: ['-i'] }
}

/**
 * The session's working directory, through the Host's own provider.
 *
 * @param {object | undefined} agent - session owner handed to the controller.
 * @param {AbortSignal | undefined} signal - request cancellation.
 * @returns {Promise<string | undefined>} the cwd, or undefined when unknown.
 */
async function sessionCwdOf (agent, signal) {
  try {
    const provider = agent?.ctx?.get?.('workingDirectory')
    if (provider !== undefined && typeof provider.ensure === 'function') {
      const cwd = await provider.ensure(agent, signal)
      return typeof cwd === 'string' ? cwd : undefined
    }
  } catch {
    // An unresolvable working directory means "not demonstrably remote".
  }
  return undefined
}

/**
 * Answer the terminal picker's shell list from the remote host.
 *
 * `dsh-api-terminal-controller` enumerates shells in the LOCAL execution world
 * (`subprocess.resolveExecutable`), so a remote workspace offered local paths
 * the remote cannot run. Wrapping `terminalController.shells` keeps that rule
 * for local sessions and asks the host itself for ssh:// ones.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 * @param {object} options - install options.
 * @param {import('./engine.js').SshWorkspaceEngine} options.engine - live engine.
 * @param {object} [options.logger] - a Cordis logger, when available.
 * @returns {Map<string, {at: number, list: Promise} > | undefined} the probe cache, or undefined when not installed.
 */
export function installRemoteShellList (ctx, options = {}) {
  const target = ctx.get('terminalController')
  if (target === undefined || target === null) return undefined
  if (typeof target.shells !== 'function') return undefined
  if (target[SHELLS_INSTALLED] !== undefined) return target[SHELLS_INSTALLED]

  const original = target.shells
  const engine = options.engine
  const cache = new Map()
  const shells = async function (agent, signal) {
    const parts = parseRemoteCwd(await sessionCwdOf(agent, signal))
    if (parts === undefined) return original.call(this, agent, signal)
    try {
      let entry = cache.get(parts.alias)
      if (entry === undefined || Date.now() - entry.at > SHELLS_TTL_MS) {
        entry = { at: Date.now(), list: probeRemoteShells(engine, parts.alias) }
        cache.set(parts.alias, entry)
      }
      const list = await entry.list
      if (Array.isArray(list) && list.length > 0) return list
      cache.delete(parts.alias)
      return original.call(this, agent, signal)
    } catch (error) {
      cache.delete(parts.alias)
      options.logger?.warn?.(`ssh-workspace: remote shell probe failed for ${parts.alias}: ${error instanceof Error ? error.message : String(error)}`)
      return original.call(this, agent, signal)
    }
  }
  Object.defineProperty(target, 'shells', { value: shells, writable: true, configurable: true, enumerable: false })
  Object.defineProperty(target, SHELLS_INSTALLED, { value: cache, writable: false, configurable: true, enumerable: false })
  Object.defineProperty(target, SHELLS_ORIGINAL, { value: original, writable: false, configurable: true, enumerable: false })
  options.logger?.info?.('ssh-workspace: took over terminalController.shells for ssh:// sessions')
  return cache
}

/**
 * Undo {@link installRemoteShellList}, restoring the original `shells`.
 *
 * @param {object | undefined} target - the patched controller instance.
 * @returns {void}
 */
export function uninstallRemoteShellList (target) {
  if (target === undefined || target === null) return
  if (target[SHELLS_INSTALLED] === undefined) return
  const original = target[SHELLS_ORIGINAL]
  if (original !== undefined) {
    Object.defineProperty(target, 'shells', { value: original, writable: true, configurable: true, enumerable: false })
  }
  delete target[SHELLS_INSTALLED]
  delete target[SHELLS_ORIGINAL]
}
