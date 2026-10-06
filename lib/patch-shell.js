/**
 * Take over the live `ctx.shell` so commands whose workdir is an `ssh://`
 * target run on the remote host.
 *
 * The shell seam allows exactly ONE executor per context (a second
 * `provide('shell')` collides), and the deployment already mounted its own
 * local executor — so this module patches that ONE instance the same way
 * `patch-fs.js` patches `ctx.fs`: `execute` is installed as an own property
 * that diverts `ssh://` workdirs to the remote half and forwards every other
 * spec to the original method bound to the surrounding executor.
 *
 * The remote half reuses `engine.acquire()` — the same pooled ssh2 connection
 * the filesystem half runs on — and returns a handle that satisfies the
 * `ShellProcess` contract the shell tools consume: live `status`/`exitCode`/
 * `signal` fields, non-consuming `observed` readers, `done` that never
 * rejects, `kill()`, and a `result()` carrying the foreground projection.
 * Output is kept in a per-stream tail window the way the local subprocess
 * collector keeps it, so a truncated remote run renders exactly like a
 * truncated local one.
 *
 * Sandbox boundary: a remote command runs under the remote login user's full
 * permissions. The deployment's local file sandbox does not cross the SSH
 * boundary, so `sandboxPolicy` on the spec is ignored for remote workdirs —
 * and the model-facing announcement says so.
 *
 * @module @shiqyka/dsh-ssh-workspace/patch-shell
 */

import { StringDecoder } from 'node:string_decoder'
import { isRemotePath, parseRemotePath } from './protocol.js'
import { shellQuote } from './engine.js'

/** Instance marker proving this module already patched the service. */
export const INSTALLED = Symbol.for('dsh-ssh-workspace.shell-installed')

/** Per-stream tail window when the spec declares none. */
const DEFAULT_WINDOW_BYTES = 64 * 1024

/**
 * Grace between a kill request and dropping the connection anyway. A healthy
 * ssh2 channel reports `close` right after the request; this bounds the wait
 * when the transport is already dead, so a handle cannot hang a foreground
 * call or pin a job as running forever.
 */
const KILL_GRACE_MS = 5000

/** Variable names safe to re-export on the remote side. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u

/**
 * A per-stream output window.
 *
 * `push` keeps at most `cap` characters, dropping the OLDEST ones — the tail
 * is what the model sees, mirroring the local subprocess collector. A window
 * with `cap <= 0` never drops (used for the settled-failure note).
 *
 * @param {number} cap - retained characters per stream.
 * @returns {{push: Function, readFrom: Function, final: Function}} the window.
 */
function makeWindow (cap) {
  let text = ''
  let dropped = false
  return {
    /** Append a decoded chunk, evicting the head once the cap is exceeded. */
    push (chunk) {
      text += chunk
      if (cap > 0 && text.length > cap) {
        text = text.slice(text.length - cap)
        dropped = true
      }
    },
    /**
     * Read from a character offset without consuming (the jobs registry pulls
     * through this). `lossy` means bytes left before the current window were
     * evicted unread.
     */
    readFrom (fromByte) {
      const start = Number.isFinite(fromByte) ? Math.max(0, Math.min(fromByte, text.length)) : 0
      return { text: text.slice(start), lossy: dropped, nextOffset: text.length }
    },
    /** The foreground projection of this stream. */
    final () {
      return { text, truncated: dropped }
    },
  }
}

/** The per-stream window budget a resolved spec declares. */
function windowCap (spec) {
  const declared = Number(spec?.stdoutMaxBytes)
  return Number.isFinite(declared) && declared > 0 ? declared : DEFAULT_WINDOW_BYTES
}

/**
 * The remote shell script one spec runs: environment re-exports (the tool
 * layer hands DSH_* facts through `dshEnv`), the workdir change, then the
 * caller's command verbatim. POSIX syntax by contract — the model-facing
 * announcement tells the model the remote side is not PowerShell.
 *
 * @param {object} spec - a resolved execution spec (workdir remote).
 * @param {{remotePath: string}} parts - the parsed workdir.
 * @returns {string} the script handed to the remote login shell.
 */
function remoteScript (spec, parts) {
  const assignments = []
  for (const source of [spec.env, spec.dshEnv]) {
    if (source === undefined || source === null || typeof source !== 'object') continue
    for (const [key, value] of Object.entries(source)) {
      if (!ENV_NAME_RE.test(key)) continue
      assignments.push(`export ${key}=${shellQuote(value)}`)
    }
  }
  const prelude = assignments.length > 0 ? `${assignments.join('; ')}; ` : ''
  return `${prelude}cd ${shellQuote(parts.remotePath)} && ${spec.command}`
}

/**
 * A settled handle for a remote run that never produced a process — the
 * connection could not be established, or the call was aborted before it
 * started. Mirrors the local executors' settled-failure shape: `done`
 * fulfills, the failure note is readable from stderr, and `result()` carries
 * the failure as its rejection (aborts settle as an `aborted` result instead).
 *
 * @param {object} spec - the resolved execution spec.
 * @param {{note?: string, error?: Error, aborted?: boolean}} failure - the outcome.
 * @returns {object} a contract-shaped process handle.
 */
function settledHandle (spec, failure) {
  const stdout = makeWindow(0)
  const stderr = makeWindow(0)
  if (typeof failure.note === 'string' && failure.note !== '') stderr.push(failure.note)
  let stdoutOffset = 0
  let stderrOffset = 0
  return {
    status: 'killed',
    exitCode: null,
    signal: null,
    observed: { stdout, stderr },
    done: Promise.resolve(),
    readOutput: () => {
      const out = stdout.readFrom(stdoutOffset)
      const err = stderr.readFrom(stderrOffset)
      stdoutOffset = out.nextOffset
      stderrOffset = err.nextOffset
      const separator = out.text.length > 0 && !out.text.endsWith('\n') ? '\n' : ''
      return {
        delta: out.text + (err.text.length > 0 ? `${separator}[stderr]\n${err.text}` : ''),
        lossy: out.lossy || err.lossy,
      }
    },
    kill: () => false,
    result: () => failure.error === undefined
      ? Promise.resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        aborted: failure.aborted === true,
        timeoutMs: spec.timeoutMs,
        stdout: { text: '', truncated: false },
        stderr: stderr.final(),
      })
      : Promise.reject(failure.error),
  }
}

/**
 * The remote half of the shell seam: one `ssh://` workdir spec, one command
 * on the named host, one live handle.
 */
class RemoteShellRouter {
  /**
   * @param {object} options - install options.
   * @param {import('./engine.js').SshWorkspaceEngine} options.engine - live SSH engine.
   * @param {object} [options.logger] - a Cordis logger, when available.
   */
  constructor ({ engine, logger }) {
    this.engine = engine
    this.logger = logger
  }

  /**
   * Run one resolved spec on the remote host.
   *
   * Follows the seam's lifecycle rules: the returned handle is settled by
   * infrastructure failures, never rejected; `done` settles once with exit
   * facts stamped; `onExpiry: 'kill'` arms this executor's own deadline while
   * `'none'` leaves expiry to the caller (the jobs registry).
   *
   * @param {object} spec - a resolved execution spec whose workdir is remote.
   * @returns {Promise<object>} the live process handle.
   * @throws {Error} when the workdir uses the scheme but names no usable target.
   */
  async execute (spec) {
    const parts = parseRemotePath(spec.workdir)
    const script = remoteScript(spec, parts)

    if (spec.signal?.aborted === true) return settledHandle(spec, { aborted: true })

    const cap = windowCap(spec)
    const stdout = makeWindow(cap)
    const stderr = makeWindow(cap)
    const outDecoder = new StringDecoder('utf8')
    const errDecoder = new StringDecoder('utf8')

    let settled = false
    let timedOut = false
    let aborted = false
    let killedByUs = false
    let providerFailure
    let record
    let stream
    let timer
    let killGrace
    let stdoutOffset = 0
    let stderrOffset = 0
    let resultPromise
    let resolveDone
    const done = new Promise((resolve) => { resolveDone = resolve })

    /** One-time teardown: timers, the abort listener, and the in-flight slot. */
    const release = () => {
      if (timer !== undefined) clearTimeout(timer)
      if (killGrace !== undefined) clearTimeout(killGrace)
      spec.signal?.removeEventListener?.('abort', onAbort)
      if (record !== undefined) {
        record.inFlight -= 1
        record.idleAt = Date.now()
      }
    }

    /** Stamp exit facts and fulfill `done` (exactly once). */
    const settleWith = (code, signalName) => {
      if (settled) return
      settled = true
      stdout.push(outDecoder.end())
      stderr.push(errDecoder.end())
      proc.exitCode = typeof code === 'number' ? code : null
      proc.signal = typeof signalName === 'string' && signalName !== ''
        ? signalName
        : killedByUs ? 'KILL' : null
      proc.status = killedByUs || proc.signal !== null ? 'killed' : 'completed'
      release()
      resolveDone()
    }

    /** The infrastructure-failure path: note on stderr, `result()` rejects. */
    const fail = (error) => {
      if (settled) return
      settled = true
      providerFailure = error
      let detail = 'unprintable provider failure'
      try {
        detail = String(error?.message ?? error)
      } catch { /* unprintable */ }
      stdout.push(outDecoder.end())
      stderr.push(`${errDecoder.end()}ssh exec failed before reporting an outcome: ${detail}`)
      proc.status = 'killed'
      release()
      resolveDone()
    }

    /**
     * Request termination of the remote command. The channel gets an explicit
     * KILL signal and is closed; a grace timer drops the whole connection if
     * `close` never arrives, so the handle cannot hang.
     */
    const requestTermination = () => {
      if (stream !== undefined) {
        try { stream.signal('KILL') } catch { /* channel gone */ }
        try { stream.close() } catch { /* channel gone */ }
      }
      if (killGrace === undefined) {
        killGrace = setTimeout(() => {
          if (settled || record === undefined) return
          record.broken = true
          this.engine.closeRecord(parts.alias, record)
        }, KILL_GRACE_MS)
        if (typeof killGrace.unref === 'function') killGrace.unref()
      }
    }

    function onAbort () {
      aborted = true
      kill()
    }

    function kill () {
      if (proc.status !== 'running') return false
      killedByUs = true
      proc.status = 'killed'
      requestTermination()
      return true
    }

    const proc = {
      status: 'running',
      exitCode: null,
      signal: null,
      observed: { stdout, stderr },
      done,
      readOutput: () => {
        const out = stdout.readFrom(stdoutOffset)
        const err = stderr.readFrom(stderrOffset)
        stdoutOffset = out.nextOffset
        stderrOffset = err.nextOffset
        const separator = out.text.length > 0 && !out.text.endsWith('\n') ? '\n' : ''
        return {
          delta: out.text + (err.text.length > 0 ? `${separator}[stderr]\n${err.text}` : ''),
          lossy: out.lossy || err.lossy,
        }
      },
      kill,
      result: () => {
        resultPromise ??= done.then(() => {
          if (providerFailure !== undefined) throw providerFailure
          return {
            exitCode: proc.exitCode,
            signal: proc.signal,
            timedOut,
            aborted: aborted && !timedOut,
            timeoutMs: spec.timeoutMs,
            stdout: stdout.final(),
            stderr: stderr.final(),
          }
        })
        return resultPromise
      },
    }

    if (spec.onExpiry === 'kill') {
      const budget = Number.isFinite(spec.timeoutMs) && spec.timeoutMs > 0 ? spec.timeoutMs : 120_000
      timer = setTimeout(() => {
        timedOut = true
        kill()
      }, budget)
      if (typeof timer.unref === 'function') timer.unref()
    }
    if (spec.signal !== undefined && spec.signal !== null) {
      spec.signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      record = await this.engine.acquire(parts.alias)
    } catch (error) {
      fail(error)
      return proc
    }
    record.idleAt = Date.now()
    record.inFlight += 1

    // A deadline or abort that fired while the connection was being
    // established settles the handle without ever sending the command.
    if (proc.status !== 'running') {
      if (!settled) settleWith(null, null)
      return proc
    }

    try {
      stream = await new Promise((resolve, reject) => {
        record.client.exec(script, (error, channel) => {
          if (error !== undefined && error !== null) reject(error)
          else resolve(channel)
        })
      })
    } catch (error) {
      fail(error)
      return proc
    }

    if (proc.status !== 'running') {
      // Killed during the exec round-trip: close the fresh channel; its close
      // event (or the grace timer) settles the handle.
      requestTermination()
    }

    stream.on('data', (chunk) => { stdout.push(outDecoder.write(chunk)) })
    stream.stderr.on('data', (chunk) => { stderr.push(errDecoder.write(chunk)) })
    stream.on('close', (code, signalName) => {
      if (settled) return
      if (!killedByUs && code === null && (signalName === null || signalName === undefined)) {
        // No exit status and no signal: the channel died with the transport.
        fail(new Error('ssh-workspace: the SSH connection dropped before the command reported an exit status'))
        return
      }
      settleWith(code, signalName)
    })
    stream.on('error', (error) => { fail(error) })
    stream.end(spec.stdin !== undefined ? String(spec.stdin) : undefined)

    this.logger?.debug?.(`ssh-workspace: exec on ${parts.alias} in ${parts.remotePath}`)
    return proc
  }
}

/**
 * Install the remote half onto the live `ctx.shell` service.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 * @param {object} options - install options.
 * @param {import('./engine.js').SshWorkspaceEngine} options.engine - live SSH engine.
 * @param {object} [options.logger] - a Cordis logger, when available.
 * @returns {RemoteShellRouter | undefined} the router, or undefined when no `shell` service is mounted.
 * @throws {Error} when the mounted executor has no `execute()` to wrap.
 */
export function installRemoteShell (ctx, options) {
  const target = ctx.get('shell')
  if (target === undefined || target === null) return undefined
  if (target[INSTALLED] !== undefined) return target[INSTALLED]

  const originalExecute = target.execute
  if (typeof originalExecute !== 'function') {
    throw new Error('ssh-workspace: the mounted ctx.shell service has no execute() to wrap')
  }
  const local = originalExecute.bind(target)
  const router = new RemoteShellRouter(options)
  const execute = function (spec) {
    if (spec !== null && typeof spec === 'object' && isRemotePath(spec.workdir)) {
      return router.execute(spec)
    }
    return local(spec)
  }
  Object.defineProperty(target, 'execute', { value: execute, writable: true, configurable: true, enumerable: false })
  Object.defineProperty(target, INSTALLED, { value: router, writable: false, configurable: true, enumerable: false })
  options.logger?.info?.('ssh-workspace: took over ctx.shell for ssh:// workdirs')
  return router
}

/**
 * Undo {@link installRemoteShell}, restoring the original `execute`.
 *
 * @param {object | undefined} target - the patched service instance.
 * @returns {void}
 */
export function uninstallRemoteShell (target) {
  if (target === undefined || target === null) return
  if (target[INSTALLED] === undefined) return
  if (Object.hasOwn(target, 'execute')) delete target.execute
  delete target[INSTALLED]
}
