/**
 * The shells a remote host actually has, and the two places that need to agree
 * about them.
 *
 * ## Why this is not a `patch-*.js`
 *
 * The Host's shell picker (`dsh-api-terminal-controller`) enumerates shells in
 * the LOCAL execution world: `shells()` resolves `this.execution(agent).subprocess`
 * and asks `discoverShells()`, which calls `subprocess.resolveExecutable()` for
 * every candidate. That subprocess is the one THIS plugin wraps, but the wrapper
 * only replaces `spawn` and `spawnTerminal` — `resolveExecutable` and
 * `terminalEnvironment` are untouched (there is no seam for them), so the picker
 * has always answered from this machine.
 *
 * The consequence is visible twice:
 *
 * 1. the menu lists shells THIS machine has, so a shell only the host has
 *    (remote `zsh`, remote `fish`) cannot be selected, and a shell only this
 *    machine has can be selected but cannot run there;
 * 2. `dsh-terminal-bash` then spawns whatever path the menu produced, and the
 *    terminal module maps the shell FAMILY back to a name on the host — so the
 *    label and the process are two independent guesses.
 *
 * This module answers the question once per host and feeds both sides: the
 * picker gets the verified list, and `lib/patch-terminal.js` gets a lookup for
 * "was the shell this argv names actually found on that host?".
 *
 * ## Why the name matters
 *
 * `tests/upstream-contract-smoke.mjs` requires every `patch-*.js` to declare a
 * contract in `lib/upstream-contract.js`, and requires every declared contract
 * to name a `patch-*.js`. This module belongs to neither side of that rule, so
 * it must not be called `patch-*`; it is a capability with its own seam id
 * (`PATCH-shell-discovery`) rather than an upstream workaround with a
 * retirement story.
 *
 * @module @shiqyka/dsh-ssh-workspace/lib/remote-shells
 */

import { shellQuote } from './engine.js'
import { isRemotePath, parseRemotePath } from './protocol.js'

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
 * @param {string} shellPath - absolute shell path.
 * @returns {string[]} the argument list.
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
 * @returns {string[]} the candidates to ask about.
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
 * @param {string[]} candidates - names from {@link normalizeCandidates}.
 * @returns {string} the script text.
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
 * @param {unknown} stdout - the sweep's standard output.
 * @returns {Array<{path: string, name: string, args: string[]}>} verified profiles.
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
  /**
   * @param {object} options - router options.
   * @param {import('./engine.js').SshWorkspaceEngine} options.engine - live engine.
   * @param {object} [options.ctx] - host plugin context, for the working-directory read.
   * @param {object} [options.logger] - a Cordis logger.
   */
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
   * @param {string} alias - host alias.
   * @returns {string} the key.
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
   * @param {string} alias - host alias.
   * @param {object} [options] - probe options.
   * @param {AbortSignal} [options.signal] - caller cancellation.
   * @param {unknown} [options.candidates] - the Host's configured candidates.
   * @returns {Promise<Array<{path: string, name: string, args: string[]}>>} verified profiles.
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
   * @param {string} alias - host alias.
   * @param {string} keep - the key that must survive.
   * @returns {void}
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
   * @param {string} alias - host alias.
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
   * @param {object} agent - the session owner the Gateway passes in.
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
   * @param {string} alias - host alias.
   * @param {object} options - probe options (signal, candidates).
   * @returns {Promise<Array<{path: string, name: string, args: string[]}>>} verified profiles.
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
 * @param {import('./engine.js').SshWorkspaceEngine} engine - live engine.
 * @returns {RemoteShellsRouter} the shared router.
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
 * @param {object} ctx - host plugin context (the scoped one).
 * @param {object} options - install options.
 * @param {import('./engine.js').SshWorkspaceEngine} options.engine - live engine.
 * @param {object} [options.logger] - a Cordis logger.
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
 * @param {object | undefined} target - the patched controller instance.
 * @returns {void}
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
