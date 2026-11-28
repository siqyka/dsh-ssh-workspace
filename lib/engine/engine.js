/**
 * SSH engine: one persistent ssh2 connection per host alias, plus the
 * promisified SFTP surface the remote filesystem backend builds on.
 *
 * Each connection has a shared SFTP channel plus a lazily-opened second one for
 * long streaming reads (`streamChannel`), so a big transfer does not queue stats,
 * listings and the watcher behind it. Host keys use TOFU: the SHA256 fingerprint
 * is recorded in the host store and a differing key is refused (message names
 * both fingerprints and points at the panel's "forget host key" action).
 *
 * The bottom of this file is the command audit (`CommandAudit`); command-line
 * redaction lives in `core/diagnostics.js` beside `maskText`, because the support
 * bundle renders command rows and must not import the engine. The engine
 * constructs it: whoever decides a command may run records that it did.
 *
 * @module @shiqyka/dsh-ssh-workspace/engine
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { requirePeer } from '../core/peers.js'
import { describeChain } from '../hosts/hosts.js'
import { Diagnostics, KINDS, maskText, redactCommand } from '../core/diagnostics.js'
import { HostStore, expandHome } from '../hosts/hosts.js'
import { AUDIT_CAPACITY, AUDIT_MAX_CAPACITY, AUDIT_MIN_CAPACITY } from './audit-limits.js'
import { isDetachedTarget, normalizeRemotePath, parseRemotePath } from '../core/protocol.js'
import { ReconnectScheduler } from './reconnect.js'
import { probedTools } from '../report/capabilities.js'
import { shellQuote } from '../core/shared.js'
import { positive } from '../core/shared.js'

// `ssh2` is this plugin's own dependency, not a Host peer: the package manager
// that installs this plugin supplies it. Naming the role keeps a missing tree
// from being reported as a Host problem (see ROLES in peers.js).
const { Client, createAgent } = requirePeer('ssh2', { kind: 'dependency' })

/** Engine defaults; every entry is overridable through the constructor. */
const DEFAULTS = {
  idleTimeoutMs: 30 * 60_000,
  connectTimeoutMs: 15_000,
  keepaliveIntervalMs: 15_000,
  sweepIntervalMs: 60_000,
}

/** Take a positive finite number from the options, falling back otherwise. */
const tuningOf = positive

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
   * @param {object} [options.logger] - a Cordis logger, when available.
   * @param {number} [options.keepaliveIntervalMs] - ssh2 keepalive interval.
   * @param {object} [options.reconnect] - background-reconnect policy overrides
   *   (`baseDelayMs` / `maxDelayMs` / `maxAttempts` / `jitter`), or `false` to
   *   keep the old behaviour of retrying only inside an operation.
   */
  constructor (options = {}) {
    this.store = options.store ?? new HostStore()
    this.logger = options.logger
    this.tuning = {
      idleTimeoutMs: tuningOf(options.idleTimeoutMs, DEFAULTS.idleTimeoutMs),
      connectTimeoutMs: tuningOf(options.connectTimeoutMs, DEFAULTS.connectTimeoutMs),
      keepaliveIntervalMs: tuningOf(options.keepaliveIntervalMs, DEFAULTS.keepaliveIntervalMs),
      sweepIntervalMs: tuningOf(options.sweepIntervalMs, DEFAULTS.sweepIntervalMs),
    }
    /** @type {Map<string, object>} alias → live connection record. */
    this.pool = new Map()
    /**
     * The message of the last FAILED connect attempt, per alias.
     *
     * A failed connect leaves no pooled record (there is no connection), and a
     * fatal one (refused host key, bad descriptor) arms no background retry —
     * without this map the panel could only say "not connected", which reads as
     * "never tried", the wrong message right after an automatic connect failed.
     * Written in `acquire`'s catch (both fatal and retryable), cleared by a
     * successful connect and by `forget` (a deliberate disconnect makes the old
     * failure irrelevant).
     *
     * @type {Map<string, string>}
     */
    this.failures = new Map()
    /**
     * How many times each alias has been connected, ever.
     *
     * Kept outside the pooled record on purpose: the record is REPLACED on
     * every reconnect, so a generation stored only on it would reset to 1 and
     * "the second generation" would be indistinguishable from "the first".
     *
     * @type {Map<string, number>}
     */
    this.generations = new Map()
    /** @type {Map<string, Promise<object>>} alias → in-flight acquire. */
    this.acquiring = new Map()
    /**
     * Aliases the boot auto-connect restore has queued or is dialing. Read by
     * `/status` so a switched-on host says "connecting" from the first poll,
     * including hosts queued behind a slow handshake — the switch is already on
     * (stored intent), and "not connected" would be the only other thing to say.
     * @type {Set<string>}
     */
    this.autoConnectPending = new Set()
    /**
     * Capability probes are answered once per host and then reused. Each probe
     * is one extra round trip at mount time; a mount is rare but a remount of
     * the same host is common, and a tool either exists or does not for the
     * lifetime of a session. Cleared when a record is closed so a reconnect
     * reports the host's current state.
     * @type {Map<string, Record<string, boolean|undefined>>}
     */
    this.capabilities = new Map()
    /**
     * Environment facts gathered by the SAME probe round trip as
     * {@link capabilities}: the login shell, the locale, free disk, and the
     * inotify watch limit.
     *
     * Kept apart from the tool booleans because the shapes differ (strings and
     * numbers, not booleans) and because a consumer may want the tool verdicts
     * without the environment. Cached and invalidated together, since they come
     * from one command.
     *
     * @type {Map<string, import('../report/capabilities.js').RemoteEnvironment>}
     */
    this.environments = new Map()
    /** @type {import('../fs/remote-fs.js').RemoteFileSystem | undefined} */
    this.fs = undefined
    /**
     * Remote workspaces the user unloaded: closed for EVERY operation, in every
     * seam this plugin serves (filesystem, shell, subprocess, terminal),
     * while their SSH connection stays usable.
     *
     * It lives on the engine rather than on the filesystem router because the
     * shell and subprocess halves never look at the router, and a workspace
     * that is "off" for reading but still runs commands is not off at all.
     *
     * @type {Set<string>}
     */
    this.disabledWorkspaces = new Set()
    /**
     * Hosts the user switched OFF with the panel's power switch.
     *
     * A disabled host is closed for every seam this plugin serves: a new
     * connection is refused here in `acquire`, an in-flight command is aborted,
     * and the persistent shells, forwards, watchers and terminals are torn down
     * by the disabler that owns the switch (see lib/hosts/disable.js). The set
     * lives on the engine because the shell, subprocess and terminal seams never
     * look at the routes, and a host that is "off" for listing but still runs
     * commands is not off at all.
     *
     * Seeded from the store at boot, so a host switched off stays off across a
     * restart even before anything dials it.
     *
     * @type {Set<string>}
     */
    this.disabledHosts = new Set()
    /**
     * In-flight operations the engine opened, per alias, so switching a host
     * off can ABORT them instead of waiting for them to finish: a long `exec`
     * can outlive the click by minutes, and the click promises "now".
     *
     * @type {Map<string, Set<AbortController>>}
     */
    this.hostAborts = new Map()
    /**
     * Recent notable events, for the status tool and the panel.
     *
     * `ctx.logger` cannot carry these to a user: the Host installs no console
     * exporter, so `info`/`warn` land in a ring buffer nothing reads, and
     * `debug` is below every exporter's default level (see diagnostics.js).
     * The log is therefore kept here and served on demand.
     *
     * @type {Diagnostics}
     */
    this.diagnostics = options.diagnostics ?? new Diagnostics()
    /**
     * A bounded record of remote COMMANDS, separate from {@link diagnostics}.
     *
     * The two rings answer different questions ("what went wrong" vs "what did
     * this session run") and have different retention needs, so sharing one
     * would let a burst of either flush the other. See the command audit
     * section at the bottom of this file.
     *
     * @type {CommandAudit}
     */
    this.audit = options.audit ?? new CommandAudit()
    /**
     * One entry per upstream workaround this process judged (see patch-projection.js).
     *
     * Kept apart from {@link Diagnostics} on purpose: the log is a bounded,
     * chronological feed where an unchanged verdict on every restart is noise,
     * while this list is a current-state table a reader can check at a glance —
     * "is any patch of ours obsolete?" must not depend on having caught an event.
     *
     * @type {Array<{id: string, probe: string, detail: string, at: number}>}
     */
    this.upstreamWorkarounds = []
    /**
     * One entry per Host SEAM this process took over (see `lib/patch-*.js`).
     *
     * The sibling of {@link upstreamWorkarounds}, and deliberately a separate
     * list: that one answers "has the Host moved on, can I delete a patch?", this
     * one answers "did my takeover actually land?". They fail in opposite
     * directions — an obsolete workaround is good news with a cleanup task, a
     * seam that failed to install is a documented feature silently gone — and
     * merging them into one table would let the second read as the first.
     *
     * Only the `failed` state is worth an event; see {@link noteSeam}.
     *
     * @type {Array<{id: string, state: 'installed'|'absent'|'failed', detail: string, at: number}>}
     */
    this.seams = []
    /**
     * The result of the last session-ownership re-claim (see `ownership.js`), or
     * `undefined` before the first activation that ran it.
     *
     * A SNAPSHOT, not a live query: the status surfaces are reads, and a status
     * poll that listed thousands of persisted sessions would make "how are things?"
     * itself expensive disk traffic. `undefined` means "not measured", which is
     * deliberately distinguishable from a zero measured before any workspace
     * existed.
     *
     * @type {{at: number, scanned: number, reclaimed: number, pending: number, skipped: string[], degraded: string|null, failures: Array<{path: string, sessionId: string, reason: string}>}|undefined}
     */
    this.ownership = undefined
    /**
     * Extra "is this host still wanted?" predicates (see {@link addWantedCheck}).
     *
     * @type {Array<(alias: string) => boolean>}
     */
    this.wantedChecks = []
    /**
     * Extra "(alias) => boolean" predicates that exempt a pooled connection
     * from the idle sweep (see {@link addKeepAliveCheck}). Kept separate from
     * `wantedChecks`: a host can be worth redialing after a drop yet still be
     * safely reclaimed after a long quiet period, and vice versa. A switched-on
     * host registers as BOTH — it must survive the sweep or boot restore would
     * be undone thirty minutes later.
     *
     * @type {Array<(alias: string) => boolean>}
     */
    this.keepAliveChecks = []
    /**
     * Called after the BACKGROUND loop brings a connection back — never after a
     * foreground `acquire`, which would make every ordinary first connection
     * look like a recovery and re-open tunnels the user had turned off.
     *
     * @type {((alias: string, record: object) => void)|undefined}
     */
    this.onReconnected = undefined
    this.disposed = false
    /**
     * Hosts whose key was accepted but could NOT be recorded.
     *
     * A trust-on-first-use store that fails to write leaves the guarantee
     * silently weakened: the key is accepted now and accepted again next time,
     * forever, because nothing was pinned. The status surfaces report this
     * rather than leaving it in a log nobody reads.
     *
     * @type {Map<string, {keyType: string, fingerprint: string, at: number}>}
     */
    this.unpinnedHostKeys = new Map()
    /**
     * Background retry for a connection that died while nobody was issuing
     * operations (lid closed, Wi-Fi switched, VPN dropped). Without it the
     * recovery only happens the next time something calls `acquire`, which —
     * for a workspace the user is looking at but not typing into — can be
     * never.
     *
     * `isWanted` is the important half: a pooled socket with no mounted root,
     * no held forward and no persistent shell has nobody to reconnect for, so
     * the loop refuses to start rather than dialing a host at random.
     */
    this.reconnector = options.reconnect === false
      ? undefined
      : new ReconnectScheduler({
        attempt: alias => {
          // A foreground operation may have healed the host while the timer was
          // armed; do not dial a second socket for the same alias.
          const existing = this.pool.get(alias)
          if (existing !== undefined && existing.broken !== true) return existing
          return this.#backgroundConnect(alias)
        },
        isWanted: alias => this.#isWanted(alias),
        // The restore hook belongs to the SUCCESS path, not to "this attempt
        // built the socket". A foreground operation can heal the host while the
        // retry timer is armed; `attempt()` then returns the healthy record
        // without dialing, and a hook wired into the connect would never run —
        // which is how a host came back with its saved tunnels still dead.
        // `reopenEnabled` is idempotent (it skips rows whose listener already
        // exists), so running it on every success is safe.
        onRestored: alias => { this.onReconnected?.(alias) },
        diagnostics: this.diagnostics,
        tuning: typeof options.reconnect === 'object' && options.reconnect !== null ? options.reconnect : undefined,
        ...(typeof options.reconnectClock === 'function' ? { now: options.reconnectClock } : {}),
      })
    this.sweeper = setInterval(() => { this.sweep() }, this.tuning.sweepIntervalMs)
    if (typeof this.sweeper.unref === 'function') this.sweeper.unref()
  }

  /**
   * Remember the filesystem backend so mount/unmount can invalidate its caches.
   *
   */
  /**
   * Whether the user switched this host off.
   *
   * @param {string} alias - host alias.
   * @returns {boolean} true when the host is disabled.
   */
  isHostDisabled (alias) {
    return this.disabledHosts.has(alias)
  }

  /**
   * Mark one host as switched off (or back on).
   *
   * Only the admission set: the caller that also owns the resources is the
   * disabler, which tears them down first and calls this to close the gate.
   *
   * @param {string} alias - host alias.
   * @param {boolean} disabled - true to refuse every operation.
   */
  setHostDisabled (alias, disabled) {
    if (disabled) this.disabledHosts.add(alias)
    else this.disabledHosts.delete(alias)
  }

  /** Seed the admission set, e.g. from the store at boot. @param {string[]} aliases - disabled hosts. */
  setDisabledHosts (aliases) {
    this.disabledHosts = new Set(aliases)
  }

  /**
   * Refuse an operation against a host the user switched off.
   *
   * The error carries a stable code so a route can answer 409/refusal instead
   * of a generic 502 and the user is told WHY nothing happened.
   *
   * @param {string} alias - host alias.
   * @throws {Error} when the host is disabled.
   */
  assertHostEnabled (alias) {
    if (!this.isHostDisabled(alias)) return
    const error = new Error(`host ${JSON.stringify(alias)} is switched off; switch it on before using it`)
    error.code = 'HOST_DISABLED'
    throw error
  }

  /**
   * Abort every command/channel this engine opened for one host.
   *
   * @returns {number} how many operations were aborted.
   */
  abortHost (alias) {
    const set = this.hostAborts.get(alias)
    if (set === undefined) return 0
    for (const controller of [...set]) {
      try { controller.abort(new Error(`host ${JSON.stringify(alias)} was switched off`)) } catch { /* already aborted */ }
    }
    return set.size
  }

  /**
   * Register one operation under its alias and combine its signal with the
   * caller's.
   *
   * The combined controller is the one the engine aborts on a host switch-off;
   * the caller's own signal is forwarded into it, so either side can cancel.
   *
   * @param {string} alias - host alias.
   * @param {AbortSignal} [external] - the caller's cancellation.
   * @returns {{signal: AbortSignal, end: Function}} the combined signal and its release.
   * @throws {Error} when the host is disabled.
   */
  #beginHostOperation (alias, external) {
    this.assertHostEnabled(alias)
    const controller = new AbortController()
    /** @type {Array<[AbortSignal, Function]>} */
    const listeners = []
    if (external !== undefined && external !== null) {
      if (external.aborted === true) controller.abort(external.reason)
      else {
        const forward = () => controller.abort(external.reason)
        external.addEventListener?.('abort', forward, { once: true })
        listeners.push([external, forward])
      }
    }
    let set = this.hostAborts.get(alias)
    if (set === undefined) {
      set = new Set()
      this.hostAborts.set(alias, set)
    }
    set.add(controller)
    let ended = false
    return {
      signal: controller.signal,
      end: () => {
        if (ended) return
        ended = true
        for (const [signal, listener] of listeners) signal.removeEventListener?.('abort', listener)
        const current = this.hostAborts.get(alias)
        if (current === undefined) return
        current.delete(controller)
        if (current.size === 0) this.hostAborts.delete(alias)
      },
    }
  }

  attachFileSystem (fs) {
    this.fs = fs
  }

  /**
   * Take the detached-workspace set from the store.
   *
   */
  setDisabledWorkspaces (workspacePaths) {
    this.disabledWorkspaces = new Set(workspacePaths)
    // Detaching or re-enabling a workspace changes what the alias serves, so
    // any cached metadata under it must not survive the switch.
    for (const path of this.disabledWorkspaces) this.fs?.invalidateWorkspace?.(path)
  }

  /**
   * Mark one remote workspace detached, or lift the mark.
   *
   */
  markWorkspaceDisabled (workspacePath, disabled) {
    const target = String(workspacePath)
    if (disabled === true) this.disabledWorkspaces.add(target)
    else this.disabledWorkspaces.delete(target)
    this.fs?.invalidateWorkspace?.(target)
  }

  /**
   * Whether a remote target lies inside a detached workspace.
   *
   * "Detached" answers one question: is this path still served by anything?
   * A root that another MOUNTED root still covers is served — by the outer
   * root — so refusing it would break the mounted workspace because a nested
   * one was detached. That is the ordinary nesting: `/home/me/project` is
   * mounted and `/home/me/project/plugin` was also mounted once and then
   * detached, so browsing the parent's tree must keep working.
   *
   * The fence therefore applies only to paths that no served root covers — the
   * case where detaching really did take the path out of service.
   *
   * @returns {boolean} true when the target must be refused.
   */
  isDisabledTarget (alias, remotePath) {
    if (this.disabledWorkspaces.size === 0) return false
    return isDetachedTarget(this.disabledWorkspaces, this.fs?.listRoots?.() ?? [], alias, remotePath)
  }

  /**
   * The host-key verifier for one alias, as the connect path would install it.
   *
   * Exposed as a seam because the trust decision is the security-critical part
   * of this module and it has no other observable entry point: `#connect` builds
   * it inside a private method that also opens a socket, so a suite would
   * otherwise have to fake ssh2 to reach it. Everything the verifier reads
   * (the store, the diagnostics log, the unpinned map) is injectable, which is
   * what makes this testable without a server.
   *
   * @returns {(key: Buffer) => boolean} the verifier; a refusal records its details on `overrides.state`.
   */
  verifierForTest (alias, overrides = {}) {
    const resolved = {
      alias,
      host: overrides.host ?? 'example.invalid',
      port: overrides.port ?? 22,
      user: overrides.user ?? 'tester',
    }
    return this.#makeHostKeyVerifier(resolved, overrides.state ?? { mismatch: undefined })
  }

  /**
   * Hosts whose key was accepted without being pinned.
   *
   */
  unpinnedHostKeyRows () {
    return [...this.unpinnedHostKeys.entries()].map(([alias, value]) => ({ alias, ...value }))
  }

  /**
   * The last failed connect attempt per host, as `{alias, error}` rows.
   *
   * Sorted by alias for a stable status payload. Only aliases with a recorded
   * failure appear; a successful connect and `forget` remove theirs.
   *
   * @returns {Array<{alias: string, error: string}>}
   */
  failureRows () {
    return [...this.failures.entries()]
      .map(([alias, error]) => ({ alias, error: String(error) }))
      .sort((left, right) => left.alias.localeCompare(right.alias))
  }

  /**
   * Record the fate of one upstream workaround.
   *
   * The workaround modules cannot reach a user themselves — `ctx.logger` goes to
   * a ring buffer nothing reads in this deployment — so their verdict is kept
   * here, where `ssh_workspace_status` and the panel's status route serve it.
   *
   * @param {string} id - stable workaround id (e.g. `UPSTREAM-1-…`).
   */
  noteUpstreamWorkaround (id, verdict) {
    const probe = String(verdict?.probe ?? '')
    this.upstreamWorkarounds.push({
      id: String(id),
      probe,
      detail: String(verdict?.detail ?? ''),
      at: Date.now(),
    })
    // Only the states that demand action get an event: `broken`/`pending`/
    // `already` are the normal case on every real startup, and logging them
    // would push the one that matters out of the bounded ring.
    if (probe === 'fixed') {
      this.diagnostics.record(KINDS.upstream, `${id}: no longer needed — delete it (${verdict?.detail ?? ''})`)
    } else if (probe === 'unprobeable') {
      this.diagnostics.record(KINDS.upstream, `${id}: cannot judge this Host, re-check after the next upgrade (${verdict?.detail ?? ''})`)
    }
  }

  /**
   * Record the fate of one Host seam takeover.
   *
   * Called by the install sites in `lib/index.js` for every `patch-*.js`. The
   * three states mean three different things, and the middle one is the one that
   * must not be mistaken for a failure:
   *
   * - `installed` — the service was there and the wrapper is in place;
   * - `absent` — the composition does not mount that service at all (an
   *   unsandboxed deployment has no `ctx.sandbox`). Nothing is broken; the
   *   feature that seam provides is not applicable here;
   * - `failed` — the service WAS there and did not have the shape the patch
   *   expects. This is a Host upgrade the plugin has not caught up with, and the
   *   documented feature it backs is gone even though everything looks alive.
   *
   * Only `failed` records a `seam` event. The other two are the normal startup of
   * every real deployment, and letting them into the bounded ring would push the
   * one that matters out of it.
   *
   */
  noteSeam (id, state, detail) {
    const verdict = state === 'installed' || state === 'absent' ? state : 'failed'
    this.seams.push({
      id: String(id),
      state: verdict,
      detail: String(detail ?? ''),
      at: Date.now(),
    })
    if (verdict === 'failed') {
      this.diagnostics.record(KINDS.seam, `${id}: not installed — ${String(detail ?? 'the Host shape changed')}`)
    }
  }

  /**
   * The current connection generation for an alias, and what it means.
   *
   * A generation is a counter of successful connects for one alias. Its value
   * is not interesting; the COMPARISON is: a consumer that captured generation
   * 2 and now sees 4 knows the transport died twice underneath it, and that
   * whatever it was running across that boundary is not necessarily the same
   * thing it is running now.
   *
   * This is the honest half of "recovery". The plugin can restore what it
   * OWNS — saved tunnels, the change watcher, a pooled connection — and it
   * cannot restore what it merely STARTED: a remote process keeps running or
   * dies according to the host, not according to this side of the wire. So the
   * vocabulary reports a new generation rather than claiming continuity:
   * there is no promise of resuming commands after a disconnect — the remote
   * process is owned by the host, not by this side of the wire.
   *
   */
  generationOf (alias) {
    const record = this.pool.get(alias)
    const generation = this.generations.get(alias) ?? 0
    return {
      generation,
      connected: record !== undefined && record.broken !== true,
      since: record?.createdAt,
      // "There was an earlier generation and it is gone" — the fact that makes
      // a consumer say "this is a new session, the old one may still be running
      // over there" instead of pretending nothing happened.
      previousLost: generation > 1 && (record === undefined || record.broken === true),
    }
  }

  /**
   * A human sentence for one alias's generation state.
   *
   * The wording lives here, not in the panel, because the status tool and the
   * panel must say the same thing — two phrasings for one fact is how a user
   * learns to distrust both.
   *
   */
  describeGeneration (alias) {
    const state = this.generationOf(alias)
    if (state.generation === 0) return 'never connected in this session'
    if (state.connected) {
      return state.generation === 1
        ? 'connected (first generation)'
        : `connected (generation ${state.generation}); anything started before the reconnect may still be running on the host`
    }
    return `generation ${state.generation} is gone; the next connection starts generation ${state.generation + 1}`
  }

  /**
   * Refuse a target inside a detached workspace.
   *
   * @throws {Error} when the target is inside a detached workspace.
   */
  assertNotDisabled (alias, remotePath) {
    if (!this.isDisabledTarget(alias, remotePath)) return
    throw new Error(`cannot access ssh://${alias}${normalizeRemotePath(remotePath)}: the remote workspace is detached (re-enable it in the panel or with ssh_workspace_enable)`)
  }

  /** Drop every pooled connection and stop the sweeper. */
  dispose () {
    this.disposed = true
    clearInterval(this.sweeper)
    this.reconnector?.dispose()
    for (const [alias, record] of this.pool) this.closeRecord(alias, record)
    this.pool.clear()
  }

  /** Close connections idle beyond the configured threshold. */
  sweep () {
    const cutoff = Date.now() - this.tuning.idleTimeoutMs
    for (const [alias, record] of [...this.pool]) {
      if (record.inFlight !== 0 || record.holds !== 0 || record.idleAt >= cutoff) continue
      // A host the user switched on must survive the sweep: an auto-connected
      // host reclaimed after thirty quiet minutes would make boot restore look
      // broken. A throwing predicate must not abort the whole sweep.
      let keep = false
      for (const check of this.keepAliveChecks) {
        try {
          if (check(alias) === true) { keep = true; break }
        } catch { /* a broken check must not pin every host */ }
      }
      if (!keep) this.closeRecord(alias, record)
    }
  }

  /**
   * Register one extra reason a pooled connection may bypass the idle sweep.
   *
   * @param {(alias: string) => boolean} check - predicate; throwing is ignored.
   */
  addKeepAliveCheck (check) {
    if (typeof check === 'function') this.keepAliveChecks.push(check)
  }

  /**
   * Close one pooled record, leaving any replacement record alone.
   *
   */
  closeRecord (alias, record) {
    // Whether this record was the live one decides both the pool update and
    // whether the close is worth reporting: a record replaced by a reconnect
    // was already reported, and a half-built record from a failed connect is
    // the failure itself rather than a disconnect after one.
    const wasLive = this.pool.get(alias) === record
    if (wasLive) this.pool.delete(alias)
    // A new connection means the host may have changed underneath us (a
    // package installed, a tool removed), so the cached probe no longer holds.
    this.capabilities.delete(alias)
    this.environments.delete(alias)
    if (wasLive && record.broken === true) {
      this.diagnostics.record(KINDS.disconnect, 'connection closed after a transport error', { alias })
    }
    try { record.sftp?.end?.() } catch { /* channel already gone */ }
    try { record.streamSftp?.end?.() } catch { /* channel already gone */ }
    try { record.client.end() } catch { /* socket already gone */ }
    // The hops are separate connections this record owns, and ending the target
    // does NOT end them: each keeps an authenticated session alive on its
    // bastion. Without this, every disconnect through a chain left N bastion
    // sessions running for the life of the process — invisible, because the
    // workspace looked closed.
    try { record.jumpChain?.close?.() } catch { /* already gone */ }
  }

  /**
   * Drop the pooled connection for an alias because its configuration
   * changed; the next operation reconnects with the new record.
   *
   */
  forget (alias) {
    // Editing a host or rejecting its key is an operator decision: retrying the
    // old descriptor in the background would fight the edit. Cancelling here is
    // also what makes the disconnect button final — the close event cannot arm
    // the loop afterwards, because {@link closeRecord} removes the record from
    // the pool first and the handler is identity-guarded.
    this.reconnector?.cancel(alias, 'the host entry changed or the connection was dropped on purpose')
    // A deliberate disconnect / config edit makes the previous failure
    // irrelevant; a stale "connection failed" on a host the user just switched
    // off would be a lie about a state nobody is working on.
    this.failures.delete(alias)
    const record = this.pool.get(alias)
    if (record !== undefined) this.closeRecord(alias, record)
  }

  /**
   * Whether anything on this host still needs its connection.
   *
   * The question the reconnect loop asks before every attempt. An idle pooled
   * socket answers "no" — retrying for it would dial a host nobody is looking
   * at, and a workspace the user closed must stay closed and silent.
   *
   * @returns {boolean} true when a mounted root or a held forward needs it.
   */
  #isWanted (alias) {
    for (const root of this.fs?.listRoots?.() ?? []) {
      if (parseRemotePath(root)?.alias === alias) return true
    }
    // `holds` counts open port forwards and pinned streaming consumers.
    for (const [, record] of this.pool) {
      if (record.alias === alias && (record.holds ?? 0) > 0) return true
    }
    // Consumers that outlive the socket cannot be seen in `holds` once the drop
    // tore them down (a saved tunnel's listener is gone, a persistent shell's
    // channel is closed) — but their intent survives, and that intent is what
    // makes the host worth redialing. Registered from lib/index.js so the engine
    // stays ignorant of how forwards are stored.
    for (const check of this.wantedChecks) {
      try {
        if (check(alias) === true) return true
      } catch { /* a broken check must not turn into "not wanted" */ }
    }
    return false
  }

  /**
   * Register one extra reason a host may still need its connection.
   *
   * @param {(alias: string) => boolean} check - predicate; throwing is ignored.
   */
  addWantedCheck (check) {
    if (typeof check === 'function') this.wantedChecks.push(check)
  }

  /**
   * One attempt made by the background loop.
   *
   * The descriptor is rebuilt from the store on every attempt on purpose: a host
   * edited while the link was down must be dialed with its new address, not the
   * one captured when the old socket closed.
   *
   * A descriptor-level failure (unknown alias, unreadable key, missing password,
   * jump-host refusal) is marked `fatal` and the loop stops: waiting cannot fix
   * it, and an attempt every minute forever would only bury the events that
   * matter in the diagnostics ring. A transport or auth failure stays retryable.
   *
   */
  async #backgroundConnect (alias) {
    try {
      this.connectConfig(this.store.resolve(alias))
    } catch (error) {
      const fatal = error instanceof Error ? error : new Error(String(error))
      fatal.fatal = true
      throw fatal
    }
    const record = await this.acquire(alias, { background: true })
    // Deliberately NOT calling `onReconnected` here. This attempt may have
    // reused a record a foreground operation established while the timer was
    // armed, and "this call built the connection" is not the same question as
    // "something on this host needs restoring". The restore hook therefore runs
    // from the scheduler's success path (see the constructor), where it is
    // idempotent and runs whether or not this attempt was the one that dialed.
    this.logger?.info?.(`ssh-workspace: reconnected to ${alias}`)
    return record
  }

  /**
   * Build the ssh2 connect configuration for one host record.
   *
   * @returns {object} ssh2 `ConnectConfig`.
   * @throws {Error} when key auth names a missing or unreadable key.
   */
  connectConfig (resolved) {
    /** @type {Record<string, unknown>} */
    const config = {
      host: resolved.host,
      port: resolved.port,
      username: resolved.user,
      readyTimeout: this.tuning.connectTimeoutMs,
      keepaliveInterval: this.tuning.keepaliveIntervalMs,
      keepaliveCountMax: 3,
      tryKeyboard: true,
    }
    // Opt-in transport flags. `compress` trades CPU for bandwidth on a slow
    // link and is a genuine connection-level ssh2 option. `agentForward` is
    // deliberately NOT set here: ssh2 reads a connect-level `agentForward` as
    // a connection-wide permission that (a) hard-throws at connect time when
    // the connection carries no agent — which key/password auth does not, so
    // checking the box used to break every connection, SFTP browsing included
    // — and (b) would otherwise request forwarding on every channel, the
    // read-only SFTP path included. Forwarding belongs to the command
    // channels: the wish is stored on the pooled record and the exec/shell
    // open sites express it per channel (see channelExecOptions).
    if (resolved.compress === true) config.compress = true
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
    // A forwarding host needs an agent ON the connection for the per-channel
    // request to have anything to forward (ssh2 ignores the channel flag
    // without one). Agent auth above already configured the path; for
    // key/password auth, note the endpoint and let the CONNECT site decide
    // whether it is actually reachable (see `#connect`), because reachability
    // costs a local round trip and this method is synchronous by contract.
    if (resolved.agentForward === true && config.agent === undefined) {
      const agentPath = resolveAgentPath()
      if (agentPath !== undefined) config.agent = agentPath
    }
    return config
  }

  /**
   * Build the host-key verifier for one host: trust on first use, then pin.
   *
   * ssh2 hands the verifier the server's raw public key blob during the
   * handshake and honours a synchronous boolean. The first key seen for an
   * alias is recorded (alias, host, key type, SHA256 fingerprint) in the
   * shared store and accepted; afterwards only the same fingerprint is
   * accepted, anything else refuses the connection with both fingerprints in
   * the message. A verifier that returns false makes the handshake fail, and
   * the detail is stashed on `state` for the connect failure to report.
   *
   */
  #makeHostKeyVerifier (resolved, state) {
    return (key) => {
      const blob = Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'utf8')
      const keyType = hostKeyTypeOf(blob)
      const fingerprint = hostKeyFingerprint(blob)
      const recorded = this.store.knownHostKey(resolved.alias)
      if (recorded === undefined) {
        try {
          this.store.rememberHostKey(resolved.alias, { host: resolved.host, port: resolved.port, keyType, fingerprint })
          this.logger?.info?.(`ssh-workspace: recorded host key for ${resolved.alias} (${keyType} ${fingerprint})`)
        } catch (error) {
          // The connection itself must not fail because the record could not be
          // persisted; the next connect attempts the record again. But it must
          // not be SILENT either: `ctx.logger` has no reader in this deployment
          // (see diagnostics.js), so a warn-only path left the user believing
          // the key was pinned when nothing had been written. The trust state
          // is therefore recorded where the status surfaces can show it.
          this.diagnostics.record(KINDS.degraded, `host key NOT pinned: could not write it to the host store (${error instanceof Error ? error.message : String(error)}). The next connection will trust this key again on first use.`, { alias: resolved.alias })
          state.unpinned = { keyType, fingerprint }
          this.unpinnedHostKeys.set(resolved.alias, { keyType, fingerprint, at: Date.now() })
        }
        return true
      }
      if (recorded.fingerprint === fingerprint) {
        // A key that is now on record no longer needs the warning.
        this.unpinnedHostKeys.delete(resolved.alias)
        return true
      }
      state.mismatch = { recorded, presented: { keyType, fingerprint } }
      return false
    }
  }

  /**
   * A verifier for a PROBE: it refuses a key that disagrees with the one on
   * record, and writes nothing.
   *
   * Trust on first use is a decision made by a CONNECTION — the host the user
   * is going to use. A test is a question, not that decision, and the form it
   * asks about may not even have an alias yet: recording a key under
   * "(unsaved host)" would leave a row in the store for a host that never
   * existed, and recording a real alias from a probe would pin a key the user
   * never chose to trust. So an unknown key is accepted silently here; the
   * first real connection pins it, exactly as before.
   *
   * @param {object} resolved - the descriptor being probed.
   * @param {{mismatch?: object}} state - receives the refusal details.
   * @returns {(key: Buffer) => boolean} the verifier.
   */
  #makeProbeHostKeyVerifier (resolved, state) {
    return (key) => {
      const blob = Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'utf8')
      const fingerprint = hostKeyFingerprint(blob)
      const recorded = this.store.knownHostKey(resolved.alias)
      if (recorded === undefined) return true
      if (recorded.fingerprint === fingerprint) return true
      state.mismatch = { recorded, presented: { keyType: hostKeyTypeOf(blob), fingerprint } }
      return false
    }
  }

  /**
   * Dial one AD-HOC descriptor and hang up.
   *
   * The host editor's 「测试」 answers about the fields ON SCREEN, which are not
   * saved yet: testing by alias would describe the address that is stored, and
   * "save first, then test" is the thing the button exists to avoid.
   *
   * Nothing is pooled and nothing is remembered as a connection — the socket is
   * destroyed as soon as the handshake finishes, so a probe never makes the
   * panel claim the host is connected. Nothing is WRITTEN either: the host key
   * is checked against the store (a changed key still refuses the probe) but a
   * key seen for the first time is not pinned, because pinning is what a real
   * connection does (see `#makeProbeHostKeyVerifier`).
   *
   * @param {object} resolved - a descriptor, shaped as `store.resolve` builds one.
   * @returns {Promise<{durationMs: number}>} how long the handshake took.
   */
  async probeDescriptor (resolved) {
    // A probe dials the host too: a switched-off host must not answer "test".
    this.assertHostEnabled(resolved?.alias)
    const config = this.connectConfig(resolved)
    const hostKey = { mismatch: undefined }
    config.hostVerifier = this.#makeProbeHostKeyVerifier(resolved, hostKey)
    const started = Date.now()
    const client = await this.#dial(config, resolved, hostKey)
    const durationMs = Date.now() - started
    try { client.destroy() } catch { /* already closed */ }
    return { durationMs }
  }

  /**
   * Connect (or reuse) the pooled connection for an alias.
   *
   * @param {boolean} [options.background] - this call IS the reconnect loop, so
   *   a failure must not schedule a second loop.
   */
  async acquire (alias, options = {}) {
    if (this.disposed) throw new Error('ssh-workspace engine is disposed')
    // The one choke point every connection passes through. A switched-off host
    // must not even reuse a pooled socket: "off" means no traffic, not "no new
    // sockets".
    this.assertHostEnabled(alias)
    const existing = this.pool.get(alias)
    if (existing !== undefined && !existing.broken) {
      // An edit to ~/.ssh/config must not be outlived by a pooled socket.
      //
      // The panel's save route already calls `forget(alias)`, so this covers the
      // OTHER way the config changes: the user edits the file in an editor. The
      // connection recorded the stamp it was built from; if that stamp moved,
      // the descriptor this socket was opened with is no longer the one
      // `resolve()` would produce, and returning it would keep using the old
      // host/port/user until some unrelated event dropped the connection.
      //
      // Deliberately NOT `forget()`: that cancels the reconnect loop, which is
      // right for an operator decision but wrong here — a mounted root may want
      // this host mid-operation, and cancelling would leave it unhealed.
      // Closing the record alone lets the normal path below dial again with
      // whatever the config now says.
      if (existing.configStamp !== undefined && existing.configStamp !== this.store.configStamp()) {
        this.diagnostics.record(
          KINDS.disconnect,
          'connection closed because the SSH config changed on disk; the next operation reconnects with the new settings',
          { alias },
        )
        this.closeRecord(alias, existing)
      } else {
        return existing
      }
    } else if (existing !== undefined) {
      this.closeRecord(alias, existing)
    }
    const pending = this.acquiring.get(alias)
    if (pending !== undefined) return await pending
    const task = this.#connect(alias)
    this.acquiring.set(alias, task)
    try {
      return await task
    } catch (error) {
      // Remember the failure BEFORE the retry decision below: whatever happens
      // next (a background loop, or nothing for a fatal error), the last thing
      // that happened to this host is that its connection failed. This is the
      // only channel that can say "connection failed" for a fatal error, which
      // arms no loop row at all.
      this.failures.set(alias, error instanceof Error ? error.message : String(error))
      // A foreground call that fails to get a connection is the classic
      // lid-closed case: the operation that noticed the death could not heal it.
      // Hand the alias to the background loop so recovery stops depending on the
      // user clicking something. Non-retryable failures are excluded: a refused
      // host key must not be hammered, and a bad descriptor would stop the loop
      // on its own first attempt anyway.
      if (options.background !== true && this.reconnector !== undefined && error?.fatal !== true) {
        this.reconnector.noteLost(alias, error instanceof Error ? error.message : String(error))
      }
      throw error
    } finally {
      if (this.acquiring.get(alias) === task) this.acquiring.delete(alias)
    }
  }

  /**
   * Dial one ssh2 connection with this engine's handshake rules.
   *
   * Extracted from `#connect` so the editor's "test" button dials the SAME way
   * a real connection will: the keyboard-interactive answer, the second `error`
   * listener and the host-key mismatch reporting are behaviour a probe has to
   * reproduce, or "test says it works" becomes a claim about a different code
   * path than the one the next operation actually takes.
   *
   * @param {object} config - a complete ssh2 `ConnectConfig`, verifier included.
   * @param {object} resolved - the descriptor, for error messages.
   * @param {{mismatch?: object}} hostKey - the slot the verifier writes a refusal into.
   * @returns {Promise<object>} the ready client, or a rejection.
   */
  #dial (config, resolved, hostKey) {
    return new Promise((resolve, reject) => {
      const candidate = new Client()
      let settled = false
      const fail = (error) => {
        if (settled) return
        settled = true
        try { candidate.destroy() } catch { /* already closed */ }
        if (hostKey.mismatch !== undefined) {
          reject(hostKeyMismatchError(resolved.alias, resolved, hostKey.mismatch, error))
          return
        }
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
  }

  /**
   * Establish one new connection plus its SFTP channel.
   *
   */
  async #connect (alias) {
    const resolved = this.store.resolve(alias)
    const config = this.connectConfig(resolved)
    // A jump chain is built BEFORE this connection is dialed: each hop is its
    // own SSH connection, opened on a TCP channel forwarded from the one before
    // it, so the target sees a connection from its immediate neighbour exactly
    // as it would under `ssh -J`. The chain is tied to this record's lifetime
    // (see `closeRecord`), not to any single operation.
    const chain = await this.#openJumpChain(resolved)
    // An agent attached for FORWARDING must actually answer before it joins
    // the connection. `resolveAgentPath` answers `pageant` on Windows
    // unconditionally, and ssh2 does not validate an agent endpoint at connect
    // time: a Pageant that is not running makes the agent auth method fail with
    // "Failed to retrieve identities from agent", which then REPLACES the real
    // failure (wrong password, refused key) with a message about an agent the
    // user never configured. Agent AUTH still wants the endpoint regardless —
    // without it there is no method left — so this only applies when the agent
    // came from the forwarding wish.
    if (config.agent !== undefined && resolved.auth?.kind !== 'agent') {
      if (!await agentIsReachable(config.agent)) {
        // Inert, not fatal: the command channels simply open without the flag.
        config.agent = undefined
        this.logger?.info?.(`ssh-workspace: ${alias} asks for agent forwarding but no agent is reachable; commands run without it`)
      }
    }
    if (chain.sock !== undefined) config.sock = chain.sock
    // Host keys are verified below; a mismatch is recorded here because the
    // transport error ssh2 raises for a refused key cannot carry the details.
    const hostKey = { mismatch: undefined }
    config.hostVerifier = this.#makeHostKeyVerifier(resolved, hostKey)
    const client = await this.#dial(config, resolved, hostKey)

    /** @type {object} */
    // `holds` counts long-lived consumers (open port forwards): the sweeper
    // must keep the connection while any hold remains, though ordinary
    // operations continue to track their own in-flight windows.
    //
    // `generation` is what lets a reconnect be EXPLAINED rather than merely
    // performed. A dropped transport does not end the remote process the user
    // was running — a `nohup` build keeps going, a `git commit` may have
    // landed — so the honest answer after a reconnect is not "everything is
    // back" but "this is a new generation; the old one may still be running
    // over there, and I cannot see it". Consumers compare the generation they
    // captured against the record's, and a mismatch is reported as a recovery
    // rather than as continuity. See `generationOf`.
    this.generations.set(alias, (this.generations.get(alias) ?? 0) + 1)
    // `agentForward` mirrors the host's forwarding wish so every command
    // channel opened later can request it (see channelExecOptions); the
    // SFTP channels are opened below without it, on purpose.
    const record = { alias, client, sftp: undefined, streamSftp: undefined, idleAt: Date.now(), inFlight: 0, holds: 0, broken: false, jumpChain: chain, generation: this.generations.get(alias), createdAt: Date.now(), agentForward: resolved.agentForward === true,
      // The config stamp this descriptor was read from, so a later `acquire`
      // can tell whether ~/.ssh/config moved under a live socket. Read AFTER
      // `resolve()` on purpose: a stamp taken before the parse could describe a
      // file that changed between the two steps, and the record would then
      // believe it is current when it is not.
      configStamp: this.store.configStamp() }
    client.on('error', () => { record.broken = true })
    client.on('close', () => {
      record.broken = true
      // The pool slot is what distinguishes an unplanned death from a local
      // teardown: every deliberate path (`forget`, `sweep`, a replaced record)
      // removes the slot BEFORE ending the client, so a close that still finds
      // its record in place is the network, not us.
      if (this.pool.get(alias) !== record) return
      this.reconnector?.noteLost(alias, 'transport lost')
    })
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
    // A live socket is itself evidence that the last failure is over; a stale
    // red "connection failed" on a working host would be exactly the lie this
    // map exists to prevent.
    this.failures.delete(alias)
    // A live connection retires a `gave-up` row: otherwise a host that failed
    // its ladder yesterday and was then reached by hand would keep reporting a
    // dead background retry for the rest of the session.
    this.reconnector?.noteConnected(alias)
    // A successful connect is the only honest definition of "used": a listed
    // host nobody connects to, or one whose connect fails, must not climb the
    // recent list. Recorded here rather than at `acquire`'s entry so a chain
    // that fails at hop two does not count as using the target.
    try { this.store.entryStore?.noteHostUsed?.(alias) } catch { /* bookkeeping */ }
    this.logger?.info?.(`ssh-workspace: connected to ${alias} (${resolved.user}@${resolved.host}:${resolved.port})`)
    // The route, not just the endpoint: "connected to host X" is exactly the
    // message a user reads when they suspect the bastion was skipped, and the
    // chain's own sentence is what tells the two apart. Built from the hops the
    // chain actually OPENED (alias + host + port), never from `hop.host` alone —
    // a chain records `{alias}` per hop so `close` can report which session it
    // ended, and describing THAT shape printed `via undefined`.
    const route = chain.hops.length === 0
      ? ''
      : ` via ${chain.hops.map(hop => `${hop.alias === hop.host ? '' : `${hop.alias} = `}${hop.host}:${hop.port}`).join(' → ')}`
    this.diagnostics.record(
      KINDS.connect,
      `connected to ${resolved.user}@${resolved.host}:${resolved.port}${route}`,
      { alias },
    )
    return record
  }

  /**
   * Build the jump chain for one descriptor, returning the stream to dial on.
   * Each hop is a real SSH connection dialed on a TCP channel forwarded from the
   * previous connection (`ssh -J a,b`); the target connects over the LAST hop's
   * channel, so from the server the client is its immediate neighbour.
   *
   * Every hop authenticates and pins its OWN host key: resolved by the same
   * {@link HostStore}, verified and recorded under its own alias. A new bastion
   * is trusted on first use; a bastion whose key changed is REFUSED, not quietly
   * accepted because the target's key was fine. One chain, several independent
   * trust decisions — which is also why a hop cannot come from the pool (a
   * pooled socket carries its opener's identity; reuse would merge two hosts'
   * trust). Credentials never travel: hop N's auth is not reused for N+1, making
   * `ProxyJump deploy@bastion` safe beside a differently-authenticating target.
   *
   * N handshakes + N tunnels before the target is dialed means failure at any
   * hop, and the error must name WHICH hop — a bare "connection refused" is
   * unactionable when the target itself is fine.
   *
   */
  async #openJumpChain (resolved) {
    const chain = resolved.jump
    /** Nothing to build: the overwhelming majority of hosts. */
    if (chain?.kind !== 'chain' || chain.hops.length === 0) {
      return { hops: [], description: 'direct connection', close: () => {} }
    }
    // Resolve EVERY hop before dialing anything.
    //
    // Two reasons, both learned the hard way. A hop that names no port must
    // inherit the port of the host it refers to (its store entry or its
    // `Host` block) — `ProxyJump bastion` with a defaulted 22 dialed a port the
    // user never mentioned and failed with `ECONNREFUSED` naming no hop. And
    // the tunnel from hop N has to point at hop N+1's REAL address, which is
    // only known once that hop is resolved. Failing before the first handshake
    // also means a typo in hop three does not leave two authenticated sessions
    // behind.
    /** @type {Array<{alias: string, user: string, host: string, port: number, auth: object, agentForward?: boolean, compress?: boolean}>} */
    const plan = []
    for (const hop of chain.hops) {
      let hopResolved
      try {
        hopResolved = this.store.resolve(hop.host)
      } catch (error) {
        throw new Error(`ProxyJump hop ${JSON.stringify(hop.host)} (${describeChain(chain)}): ${error instanceof Error ? error.message : String(error)}`)
      }
      plan.push({
        ...hopResolved,
        // `user@` / `:port` in the chain override the resolved entry. That is
        // what the syntax means, and ignoring it would connect as the wrong
        // account on the right bastion.
        ...(hop.user === undefined ? {} : { user: hop.user }),
        ...(hop.port === undefined ? {} : { port: hop.port }),
      })
    }
    /** @type {Array<{client: any, alias: string}>} */
    const opened = []
    /** @type {any} */
    let sock
    const closeAll = () => {
      for (const hop of [...opened].reverse()) {
        try { hop.client.end() } catch { /* already gone */ }
      }
    }
    try {
      for (let index = 0; index < plan.length; index += 1) {
        const hop = plan[index]
        const hopConfig = this.connectConfig(hop)
        if (sock !== undefined) hopConfig.sock = sock
        const hopKeyState = { mismatch: undefined }
        hopConfig.hostVerifier = this.#makeHostKeyVerifier({ ...hop }, hopKeyState)
        const hopClient = await new Promise((resolve, reject) => {
          const candidate = new Client()
          let settled = false
          const fail = (error) => {
            if (settled) return
            settled = true
            try { candidate.destroy() } catch { /* already closed */ }
            if (hopKeyState.mismatch !== undefined) {
              reject(hostKeyMismatchError(hop.alias, hop, hopKeyState.mismatch, error))
              return
            }
            reject(error instanceof Error ? error : new Error(String(error)))
          }
          candidate.once('ready', () => {
            if (settled) return
            settled = true
            resolve(candidate)
          })
          candidate.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
            if (hopConfig.password !== undefined && prompts.length > 0 && prompts.every(prompt => /password/iu.test(prompt.prompt))) {
              finish(prompts.map(() => hopConfig.password))
              return
            }
            fail(new Error(`authentication to jump hop ${JSON.stringify(hop.alias)} failed (keyboard-interactive): ${prompts.map(prompt => prompt.prompt.trim()).join(', ') || 'unsupported challenge'}`))
          })
          // An error AFTER 'ready' belongs to the hop's lifetime, not to this
          // handshake; it is reported through the chain's consumer instead.
          candidate.on('error', (error) => {
            if (settled) this.logger?.warn?.(`ssh-workspace: jump hop ${hop.alias} errored: ${error.message ?? String(error)}`)
            else fail(error)
          })
          try {
            candidate.connect(hopConfig)
          } catch (error) {
            fail(error)
          }
        })
        opened.push({ client: hopClient, alias: hop.alias, host: hop.host, port: hop.port, user: hop.user })
        this.diagnostics.record(
          KINDS.connect,
          `jump hop ${hop.alias} connected (${hop.user}@${hop.host}:${hop.port})`,
          { alias: resolved.alias },
        )
        // Open the tunnel toward what comes next: the following hop's resolved
        // address, or the target's when this was the last one. That channel is
        // what the next connection dials on, so nothing beyond the first hop
        // ever sees this machine's address.
        const next = index + 1 < plan.length
          ? { host: plan[index + 1].host, port: plan[index + 1].port }
          // The LAST hop resolves the target's name, as the bastion sees it.
          : { host: resolved.host, port: resolved.port }
        sock = await new Promise((resolve, reject) => {
          hopClient.forwardOut('127.0.0.1', 0, next.host, next.port, (error, stream) => {
            if (error !== undefined && error !== null) {
              reject(new Error(`jump hop ${JSON.stringify(hop.alias)} could not open a channel to ${next.host}:${next.port}: ${error.message ?? String(error)}`))
            } else resolve(stream)
          })
        })
      }
      return {
        sock,
        // What each opened hop actually is: the alias the user wrote, plus the
        // address it resolved to. Both are needed — the alias alone cannot say
        // which port was dialed, and the address alone loses the name the user
        // recognises in their own config.
        hops: opened.map(entry => ({
          alias: entry.alias,
          host: entry.host,
          port: entry.port,
          user: entry.user,
        })),
        description: describeChain(chain),
        close: () => {
          // The stream rides the LAST hop, so destroy it before that hop ends.
          try { sock?.destroy?.() } catch { /* already gone */ }
          closeAll()
        },
      }
    } catch (error) {
      // A half-built chain is a set of live sessions on the bastions, and the
      // user's only symptom would be "I cannot connect". Closing them keeps the
      // failure from leaking one authenticated session per attempt.
      //
      // Destroyed rather than `end()`ed: this path is already a failure, so
      // there is no state worth a graceful disconnect, and `end()` leaves the
      // socket in FIN-wait long enough for the next attempt to find the
      // bastion still counting this one as live.
      try { sock?.destroy?.() } catch { /* already gone */ }
      for (const hop of [...opened].reverse()) {
        try { hop.client.destroy() } catch { /* already gone */ }
      }
      throw error
    }
  }

  /**
   * Run one SFTP operation against a live connection, reconnecting once when
   * the connection turns out to be broken. Replaying the callback is safe only
   * for READS: the retry handles a transport dying between ask and answer, and
   * a second run on a fresh connection repeats no effect for a `stat`/`readdir`.
   * For writes it is unsound — a `mkdir` whose reply was lost is committed (the
   * replay fails `EEXIST`), an upload re-copies and re-fires progress, a staged
   * rename publishes twice. The old code replayed unconditionally, quietly
   * turning "link hiccup" into "side effect happened twice".
   *
   * So the caller declares the class: `'read'` (default) replays once;
   * `'write'` never replays — it closes the dead record and surfaces the failure,
   * since the caller needs to know remote state is uncertain, not retry.
   *
   * @template T
   * @param {'read'|'write'} [options.kind] - replay class; 'read' by default.
   */
  async withSftp (alias, operation, options = {}) {
    const replayable = options.kind !== 'write'
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
        // Close first, then report the retry: the log is read oldest-first, so
        // recording "reconnecting" before the disconnect it follows would show
        // the two events out of order.
        this.closeRecord(alias, record)
        if (!replayable) {
          // The write may well have landed. Saying "reconnecting" here would
          // imply the work is being redone; it is not, and the caller is told
          // the outcome is unknown instead.
          this.diagnostics.record(KINDS.disconnect, `connection lost during a write; the remote outcome is unknown: ${error instanceof Error ? error.message : String(error)}`, { alias })
          throw markOutcomeUnknown(error)
        }
        this.diagnostics.record(KINDS.reconnect, `reconnecting after a transport error: ${error instanceof Error ? error.message : String(error)}`, { alias })
      } finally {
        record.inFlight -= 1
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  /**
   * The record's dedicated SFTP channel for streaming reads, opened lazily.
   *
   * A long sequential read on the shared channel makes every other operation
   * on the connection — stats, listings, the change watcher — queue behind
   * it; a second channel keeps them responsive while a large file streams.
   * A channel that cannot be opened degrades to the shared one, and a stream
   * channel that closes on its own is dropped so the next reader reopens it:
   * a stream must never fail because the second channel is unavailable.
   *
   */
  async streamChannel (record) {
    if (record.streamSftp !== undefined) return record.streamSftp
    // Single-flight: two concurrent first reads used to open two second
    // channels and record only the last, leaving the other unreferenced and
    // unreclaimable — it stayed open for the life of the connection with
    // nothing able to close it. The in-flight promise is shared, so a burst of
    // readers opens exactly one channel.
    if (record.streamOpening !== undefined) return await record.streamOpening
    let channel
    try {
      record.streamOpening = new Promise((resolve, reject) => {
        record.client.sftp((error, sftp) => {
          if (error !== undefined && error !== null) reject(error)
          else resolve(sftp)
        })
      })
      channel = await record.streamOpening
    } catch {
      // Degrading is correct (a stream must never fail for want of a second
      // channel) but it is not silent: shared-channel contention is exactly the
      // symptom a user would otherwise report as "large files are slow".
      this.diagnostics.record(KINDS.degraded, 'stream channel unavailable; large reads share the main SFTP channel', { alias: record.alias })
      return record.sftp
    } finally {
      // Clear the in-flight slot whether it succeeded or failed: a failed open
      // must not be cached, or every later reader would await the same rejection
      // instead of retrying.
      record.streamOpening = undefined
    }
    channel.on?.('close', () => {
      if (record.streamSftp === channel) record.streamSftp = undefined
    })
    record.streamSftp = channel
    return channel
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
   * Probe which optional remote tools a host has, and what its environment
   * looks like. The plugin degrades when tools are missing (no `rg` → no
   * glob/grep, no `git` → no change tracking, no `inotifywait` → poll), and
   * without a probe the user only finds out by hitting the failure. One round
   * trip per host gives an up-front answer. The tool list lives in
   * `capabilities.js` (also carrying the user consequence + install hint), so
   * adding a capability is a row there, not an edit here.
   *
   * The environment half rides the SAME round trip deliberately: four facts
   * (shell, locale, disk, watch limit) are cheap to ask together and expensive
   * apart (a channel + connection acquire each) — together keeps the panel's
   * self-check from costing five round trips per mount. The probe never throws:
   * an unreachable host or odd shell yields `undefined` per capability ("unknown",
   * not a false negative).
   *
   * Parsing is line-anchored: the old `stdout.includes('rg')` matched any line
   * CONTAINING the name (a path, locale, directory). With `$SHELL`/`$LANG`/`df`
   * sharing the stream that became routine false positives, so each fact is
   * emitted on its own prefixed line and matched whole.
   *
   * @param {AbortSignal} [options.signal] - caller cancellation.
   */
  async probeCapabilities (alias, options = {}) {
    const cached = this.capabilities.get(alias)
    if (cached !== undefined && options.refresh !== true) return cached
    /** @type {Record<string, boolean|undefined>} */
    const result = {}
    for (const tool of probedTools()) result[tool] = undefined
    // One round trip: each marker is printed only when the tool resolved, so a
    // missing tool leaves its line out rather than failing the whole command.
    // `set +e` keeps a missing utility from aborting the rest of the sweep on a
    // shell configured with `errexit`.
    const toolSweep = probedTools()
      .map(tool => `command -v ${tool} >/dev/null 2>&1 && printf 'dsh-tool:%s\\n' ${tool}`)
      .join('; ')
    const script = [
      'set +e',
      toolSweep,
      // The shell that runs these commands, not the one this plugin uses: a
      // csh/fish login shell is a real hazard for POSIX syntax (see
      // capabilities.js), and it is only visible from inside the host.
      `printf 'dsh-env:shell:%s\\n' "\${SHELL:-}"`,
      `printf 'dsh-env:locale:%s\\n' "\${LC_ALL:-\${LC_CTYPE:-\${LANG:-}}}"`,
      // Available KiB on the filesystem holding the cwd. `-P` forces the
      // portable single-line format so the field index is stable.
      `printf 'dsh-env:disk:%s\\n' "$(df -Pk . 2>/dev/null | awk 'NR==2{print $4}')"`,
      `printf 'dsh-env:watch:%s\\n' "$(cat /proc/sys/fs/inotify/max_user_watches 2>/dev/null)"`,
      `printf 'dsh-probe-done\\n'`,
    ].join('; ')
    try {
      // A capability probe is read-only by construction (`command -v`, `df`,
      // `cat` on a /proc sysctl), so it is one of the few commands allowed to
      // replay after a lost connection.
      const outcome = await this.exec(alias, script, { timeoutMs: 15_000, signal: options.signal, replay: 'safe' })
      if (outcome.success !== true && outcome.exitCode !== 0) return result
      // A run that produced no completion marker cannot be trusted to have
      // reported every capability; leave the unknowns as unknown.
      if (!outcome.stdout.includes('dsh-probe-done')) return result
      const lines = outcome.stdout.split(/\r?\n/u)
      const present = new Set()
      /** @type {import('../report/capabilities.js').RemoteEnvironment} */
      const environment = {}
      for (const line of lines) {
        if (line.startsWith('dsh-tool:')) {
          present.add(line.slice('dsh-tool:'.length).trim())
          continue
        }
        if (!line.startsWith('dsh-env:')) continue
        const rest = line.slice('dsh-env:'.length)
        const separator = rest.indexOf(':')
        if (separator < 0) continue
        const key = rest.slice(0, separator)
        const value = rest.slice(separator + 1).trim()
        if (value === '') continue
        if (key === 'shell' || key === 'locale') environment[key] = value
        else if (key === 'disk' || key === 'watch') {
          const parsed = Number.parseInt(value, 10)
          if (Number.isFinite(parsed)) environment[key === 'disk' ? 'diskFreeKb' : 'inotifyWatches'] = parsed
        }
      }
      // The completion marker proves the sweep ran to the end, which is what
      // makes an ABSENT line meaningful: a tool that printed nothing is
      // genuinely missing rather than unasked.
      for (const tool of probedTools()) result[tool] = present.has(tool)
      // Only a fully determined answer is worth remembering: caching an all-
      // unknown result would make one bad probe permanent for the session.
      this.capabilities.set(alias, result)
      this.environments.set(alias, environment)
      return result
    } catch {
      return result
    }
  }

  /**
   * The environment facts from the last successful probe, if any.
   *
   * Separate from {@link probeCapabilities} because a caller that wants the
   * self-check needs both halves, while the change watcher only wants the tool
   * verdicts and must not pay for the rest.
   *
   */
  environmentOf (alias) {
    return this.environments.get(alias)
  }

  /**
   * Run one shell command on a remote host (the fs seam carries contents; a
   * shell is a different capability, and the deployment's pwsh/bash tools run
   * locally). A transport death replays once only for a caller-declared
   * replayable command, and never after output starts.
   *
   * "No output" is NOT proof the command did not run: `rm -f`, `touch`, `mv`,
   * `git commit -q`, a successful `curl` all finish silently, so a connection
   * dying between "finished" and "exit status came back" looked like one dying
   * before start — replaying then did the side effect twice. Replay is opt-in
   * (`replay: 'safe'`), only for plugin-known read-only probes; everything else
   * reports `outcome: 'unknown'` rather than pretending no run, as does a run
   * dying after output regardless of replayability.
   *
   * @param {number} [options.timeoutMs] - wall-clock budget (default 60000).
   * @param {boolean} [options.audit] - set `false` for a read with no user action
   *   (directory picker listing), excluded from the audit ring like an SFTP
   *   `readdir`: the audit answers "what did the agent/user run".
   * @param {AbortSignal} [options.signal] - caller cancellation.
   */
  async exec (alias, command, options = {}) {
    const started = Date.now()
    // Checked BEFORE `acquire`: an already cancelled command must not even dial
    // a host. `runRemoteCommand` refuses it too, but by then the connection
    // work has happened, and a caller that cancelled did not ask for that.
    if (options.signal?.aborted === true) {
      return {
        success: false,
        exitCode: null,
        timedOut: false,
        stdout: '',
        stderr: '',
        truncated: false,
        durationMs: 0,
        error: 'command aborted by the caller',
      }
    }
    const budget = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 60_000
    const maxBytes = Number.isFinite(options.maxOutputBytes) && options.maxOutputBytes > 0 ? options.maxOutputBytes : 2 * 1024 * 1024
    const replayable = options.replay === 'safe'
    const prefix = options.cwd === undefined || options.cwd === '' ? '' : `cd ${shellQuote(options.cwd)} && `
    // Register the command under its alias so switching the host off aborts it,
    // and so a command against a switched-off host is refused without dialing.
    // The combined signal forwards the caller's cancellation too.
    let operation
    try {
      operation = this.#beginHostOperation(alias, options.signal)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (options.audit !== false) {
        this.audit?.record({
          at: started,
          alias,
          command,
          channel: options.channel ?? 'exec',
          durationMs: Date.now() - started,
          exitCode: null,
          timedOut: false,
          refused: true,
          ...(typeof options.cwd === 'string' && options.cwd !== '' ? { cwd: options.cwd } : {}),
          ...(typeof options.sessionId === 'string' && options.sessionId !== '' ? { sessionId: options.sessionId } : {}),
          error: message,
        })
      }
      return {
        success: false,
        exitCode: null,
        timedOut: false,
        stdout: '',
        stderr: '',
        truncated: false,
        durationMs: Date.now() - started,
        error: message,
        refused: true,
      }
    }
    const signal = operation.signal
    let outcome
    let attempts = 0
    try {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        attempts = attempt
        const record = await this.acquire(alias)
        record.idleAt = Date.now()
        record.inFlight += 1
        let producedOutput
        try {
          ({ outcome, producedOutput } = await runRemoteCommand(record.client, `${prefix}${command}`, {
            budget,
            maxBytes,
            signal,
            started,
            // Per-channel agent forwarding, exactly like every other command
            // channel; ssh2 keeps it inert when the connection has no agent.
            agentForward: record.agentForward === true,
          }))
        } finally {
          record.inFlight -= 1
          record.idleAt = Date.now()
        }
        // ssh2 marks the pooled record broken before the channel's close event
        // settles the run, so by the time the await above resumes the flag is
        // already reliable.
        const lost = outcome.success !== true
          && outcome.timedOut !== true
          && signal.aborted !== true
          && record.broken
        if (!lost) break
        this.closeRecord(alias, record)
        // Only a caller-declared read-only probe may be replayed, and only before
        // it emitted anything: output means the remote side reached the command.
        if (!(attempt === 1 && replayable && producedOutput !== true)) {
          outcome = { ...outcome, outcome: 'unknown' }
          break
        }
      }
    } finally {
      operation.end()
    }
    // The audit records the command as the CALLER wrote it, not with the `cd`
    // prefix: the cwd travels as its own field, so a reader sees
    // `command` + `cwd` rather than one shell-quoted line they have to parse.
    // A replayed run is recorded once — it is one command the user asked for,
    // and the retry is the plugin's decision, not theirs.
    if (options.audit !== false) {
      this.audit?.record({
        at: started,
        alias,
        command,
        channel: options.channel ?? 'exec',
        durationMs: Date.now() - started,
        exitCode: outcome?.exitCode ?? null,
        timedOut: outcome?.timedOut === true,
        ...(outcome?.outcome === 'unknown' ? { outcomeUnknown: true } : {}),
        ...(typeof options.cwd === 'string' && options.cwd !== '' ? { cwd: options.cwd } : {}),
        ...(typeof options.sessionId === 'string' && options.sessionId !== '' ? { sessionId: options.sessionId } : {}),
        ...(typeof outcome?.error === 'string' && outcome.error !== '' ? { error: outcome.error } : {}),
        // A replay that actually ran twice is worth a note: the count is what
        // tells a reader the side effect could have happened twice.
        ...(attempts > 1 ? { error: `${outcome?.error ?? 'transport lost'}; replayed once (attempt ${attempts})` } : {}),
      })
    }
    return outcome
  }

  /**
   * Open a long-lived exec channel and hold the pooled connection for it.
   *
   * `exec` is snapshot-shaped: it buffers and settles. A consumer that wants a
   * stream — the push-based change watcher feeding `inotifywait`, or a terminal
   * — needs the channel itself, plus the guarantee that the idle sweeper does
   * not reap the connection out from under it. `holds` is that guarantee: the
   * same counter open port forwards already use.
   *
   * The returned channel is the raw ssh2 channel (`stdout` events, `write`,
   * `close`); the caller owns its lifecycle and MUST call `release()` — the
   * connection stays pinned until it does. A transport death closes the channel
   * and calls `onClose`, so a consumer never waits on a dead stream.
   *
   * @param {Function} [options.onClose] - called once when the channel closes for any reason.
   */
  async openChannel (alias, command, options = {}) {
    const record = await this.acquire(alias)
    let released = false
    const release = () => {
      if (released) return
      released = true
      record.holds = Math.max(0, record.holds - 1)
      record.idleAt = Date.now()
    }
    // Track the channel so switching the host off closes it, and combine the
    // caller's cancellation with the host's.
    let operation
    try {
      operation = this.#beginHostOperation(alias, options.signal)
    } catch (error) {
      release()
      throw error
    }
    // Pin the connection before the channel exists, so a sweep that lands
    // between here and the resolve cannot close it.
    record.holds += 1
    record.idleAt = Date.now()
    record.inFlight += 1
    let channel
    try {
      channel = await new Promise((resolve, reject) => {
        const callback = (error, opened) => {
          if (error !== undefined && error !== null) reject(error)
          else resolve(opened)
        }
        // A PTY makes the remote end a terminal: it echoes, line-buffers and
        // reports a window size, which is what an interactive session needs.
        // Both arms share channelExecOptions so a forwarding host requests the
        // agent on this command channel (and only here — never on SFTP).
        if (options.pty !== undefined && options.pty !== false) record.client.exec(command, channelExecOptions(record, { pty: options.pty }), callback)
        else record.client.exec(command, channelExecOptions(record), callback)
      })
    } catch (error) {
      record.inFlight -= 1
      release()
      operation.end()
      throw error
    }
    record.inFlight -= 1
    record.idleAt = Date.now()
    let closed = false
    const finish = () => {
      if (closed) return
      closed = true
      operation.end()
      release()
      try { options.onClose?.() } catch { /* a throwing consumer must not leak the hold */ }
    }
    if (typeof channel.once === 'function') channel.once('close', finish)
    else if (typeof channel.on === 'function') channel.on('close', finish)
    const onAbort = () => {
      try { channel.close() } catch { /* channel already gone */ }
      finish()
    }
    if (operation.signal.aborted === true) onAbort()
    else operation.signal.addEventListener('abort', onAbort, { once: true })
    return {
      channel,
      record,
      release: () => {
        try { operation.signal.removeEventListener?.('abort', onAbort) } catch { /* already gone */ }
        finish()
      },
    }
  }
}

/**
 * Channel options for one exec/shell open, layered over the caller's extras.
 *
 * This is where the host's "forward ssh-agent" wish lives — on the CHANNEL,
 * not the connection: ssh2 only honours `agentForward` in the exec/shell
 * option bag, and only when the connection itself carries an agent. Without a
 * connection agent the flag is silently inert, which is exactly right for a
 * key/password host whose operator checked the box with no local agent.
 * The read-only SFTP paths never route through here.
 *
 * @param {object} [extra] - caller options (e.g. `{ pty }`).
 */
export function channelExecOptions (record, extra = {}) {
  const options = { ...extra }
  if (record?.agentForward === true) options.agentForward = true
  return options
}

/**
 * Run one command over an established client, collecting bounded output.
 *
 * Resolves (never rejects) with the settled outcome plus whether any output
 * arrived, which is what decides replayability: a command that already
 * produced output has run.
 *
 * @param {any} client - the ssh2 client to run on.
 * @param {string} command - the shell command (already prefixed with `cd`).
 */
function runRemoteCommand (client, command, options) {
  const { budget, maxBytes, signal, started, agentForward } = options
  return new Promise((resolve) => {
    // An ALREADY aborted signal must not open a channel. The abort listener
    // below only fires on a future edge, so without this check a command the
    // caller had already cancelled would still run on the remote host — and a
    // cancelled command is exactly the one whose side effects nobody is waiting
    // for. `openChannel` (the SFTP half) refuses the same way.
    if (signal?.aborted === true) {
      resolve({
        outcome: {
          success: false,
          exitCode: null,
          timedOut: false,
          stdout: '',
          stderr: '',
          truncated: false,
          durationMs: Date.now() - started,
          error: 'command aborted by the caller',
        },
        producedOutput: false,
      })
      return
    }
    // `client.exec` can throw SYNCHRONOUSLY (a dead socket answers "Not
    // connected" that way), and a throw inside this executor would reject the
    // promise — which every caller awaits inside a try that reports the loss as
    // a transport death, so it would be classified as a broken connection
    // rather than as a refused command. Converting the throw into an ordinary
    // outcome keeps one failure shape at this seam.
    const failSync = (error) => resolve({
      outcome: {
        success: false,
        exitCode: null,
        timedOut: false,
        stdout: '',
        stderr: '',
        truncated: false,
        durationMs: Date.now() - started,
        error: error instanceof Error ? (error.message ?? String(error)) : String(error),
      },
      producedOutput: false,
    })
    // ALWAYS an object, never `undefined`: ssh2's `exec(cmd, opts, cb)` only
    // substitutes `{}` when the second argument is a FUNCTION, so an explicit
    // `undefined` reaches `opts.allowHalfOpen` and throws synchronously
    // ("Cannot read properties of undefined"). An empty bag is equivalent to
    // the default anyway (`{}.allowHalfOpen !== false`), so the conditional
    // below produces `{}` rather than nothing.
    const wanted = agentForward === true ? { agentForward: true } : {}

    // Open the channel, retrying ONCE without the forwarding request when that
    // request is what failed.
    //
    // `AllowAgentForwarding no` is a standard hardening setting, and sshd
    // rejects the per-channel `auth-agent-req` under it. ssh2 surfaces that
    // rejection as a channel-open error, so requesting forwarding would turn a
    // convenience into "this host cannot run any command at all". The command
    // is the point; forwarding is the extra, so a refusal drops the extra and
    // records why.
    let forwardingRefused = false
    const open = (openOptions, firstAttempt) => {
      let settledOpen = false
      const settleOpen = (error, stream) => {
        if (settledOpen) return
        settledOpen = true
        if (error !== undefined && error !== null) {
          if (firstAttempt && openOptions.agentForward === true && isAgentForwardingRefusal(error)) {
            forwardingRefused = true
            open({}, false)
            return
          }
          resolve({
            outcome: {
              success: false,
              exitCode: null,
              timedOut: false,
              stdout: '',
              stderr: '',
              truncated: false,
              durationMs: Date.now() - started,
              error: error.message ?? String(error),
            },
            producedOutput: false,
          })
          return
        }
        const stdout = { decoder: new StringDecoder('utf8'), text: '', bytes: 0, truncated: false }
        const stderr = { decoder: new StringDecoder('utf8'), text: '', bytes: 0, truncated: false }
        let producedOutput = false
        let timedOut = false
        let settled = false
        // Every settle path has to release the abort listener: `close` used to
        // be the only one that did, so a timeout or a transport error left the
        // closure (and the stream it captured) attached to the caller's signal
        // for as long as that signal lived.
        let detachAbort = () => {}
        const finish = (outcome) => {
          if (settled) return
          settled = true
          detachAbort()
          clearTimeout(timer)
          resolve({
            outcome: {
              ...outcome,
              stdout: finalizeOutput(stdout),
              stderr: finalizeOutput(stderr),
              truncated: stdout.truncated || stderr.truncated,
              durationMs: Date.now() - started,
              ...(forwardingRefused ? { forwardingRefused: true } : {}),
            },
            producedOutput,
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
            error: 'command aborted by the caller',
          })
        }
        signal?.addEventListener('abort', abort, { once: true })
        detachAbort = () => signal?.removeEventListener?.('abort', abort)
        stream.on('data', (chunk) => {
          if (chunk.length > 0) producedOutput = true
          appendCapped(stdout, chunk, maxBytes)
        })
        stream.stderr.on('data', (chunk) => {
          if (chunk.length > 0) producedOutput = true
          appendCapped(stderr, chunk, maxBytes)
        })
        stream.on('close', (code) => {
          finish({
            success: code === 0,
            exitCode: typeof code === 'number' ? code : null,
            timedOut,
            ...(typeof code !== 'number' ? { error: 'connection lost before the command reported an exit status' } : {}),
          })
        })
        stream.on('error', (streamError) => {
          finish({
            success: false,
            exitCode: null,
            timedOut: false,
            error: streamError.message ?? String(streamError),
          })
        })
      }
      try {
        client.exec(command, openOptions, settleOpen)
      } catch (error) {
        // See `failSync`: a synchronous throw must not become a rejected
        // promise, and it is not retried either — the forwarding flag is not
        // what broke it.
        settledOpen = true
        failSync(error)
      }
    }
    open(wanted, true)
  })
}

/**
 * Recognise an ssh2 refusal that is ABOUT agent forwarding rather than about
 * the channel itself.
 *
 * ssh2 reports both the same way (an error passed to the channel callback), so
 * the discriminator is the message: the client emits "Unable to request agent
 * forwarding" when the server rejects `auth-agent-req`, and an OpenSSH server
 * with forwarding disabled is the usual cause. Anything else — no session
 * channel left, a permission denial, a dead socket — must NOT be retried
 * without the flag, because the flag is not what broke it.
 *
 * @returns {boolean} true when retrying without forwarding is the right move.
 */
function isAgentForwardingRefusal (error) {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /agent forwarding/u.test(message) && !/connection|socket|session channel|administratively prohibited/u.test(message)
}

/**
 * Append one chunk up to a byte cap, marking truncation once.
 *
 * The cap is accounted in bytes and the stream is decoded with a persistent
 * {@link StringDecoder}: a multi-byte character split across chunks is held
 * back until the rest arrives instead of turning into replacement glyphs, and
 * the truncation cut falls on a complete-character boundary because the
 * decoder never emits half a character.
 */
function appendCapped (target, chunk, maxBytes) {
  if (target.truncated) return
  const remaining = maxBytes - target.bytes
  if (chunk.length > remaining) {
    target.text += target.decoder.write(chunk.subarray(0, Math.max(0, remaining)))
    target.text += '…[output truncated]'
    target.truncated = true
    return
  }
  target.bytes += chunk.length
  target.text += target.decoder.write(chunk)
}

/**
 * Flush a stream's decoder tail at settle time so a trailing multi-byte
 * character split across the final chunks still renders. Truncated streams
 * keep their marker and discard the held tail — the cap already applied.
 *
 */
function finalizeOutput (target) {
  if (!target.truncated) target.text += target.decoder.end()
  return target.text
}

/**
 * The algorithm name of an SSH public key blob.
 *
 * A host key arriving from the wire is `string algorithm-name` +
 * `string key-data`, the same framing that becomes a base64 known_hosts line.
 *
 * @param {Buffer} blob - the raw public key blob.
 * @returns {string} the algorithm name, or 'unknown' when the framing is odd.
 */
function hostKeyTypeOf (blob) {
  if (!Buffer.isBuffer(blob) || blob.length < 8) return 'unknown'
  const length = blob.readUInt32BE(0)
  if (length <= 0 || length > blob.length - 4) return 'unknown'
  return blob.subarray(4, 4 + length).toString('utf8')
}

/**
 * The OpenSSH-style SHA256 fingerprint of a public key blob
 * (`SHA256:` + unpadded base64), comparable with `ssh-keygen -lf`.
 *
 * @param {Buffer} blob - the raw public key blob.
 */
function hostKeyFingerprint (blob) {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/u, '')}`
}

/**
 * The refusal raised when a server presents a host key that differs from the
 * recorded one, naming both fingerprints so the user can decide.
 *
 */
function hostKeyMismatchError (alias, resolved, mismatch, cause) {
  const { recorded, presented } = mismatch
  const where = `${resolved.user}@${resolved.host}:${resolved.port}`
  const when = Number.isFinite(recorded.recordedAt) ? ` (recorded ${new Date(recorded.recordedAt).toISOString()})` : ''
  const error = new Error(
    `host ${JSON.stringify(alias)} (${where}): the server presented a different host key than the one recorded on first connect.\n`
    + `recorded: ${recorded.keyType} ${recorded.fingerprint}${when}\n`
    + `presented: ${presented.keyType} ${presented.fingerprint}\n`
    + 'If this host was reinstalled or its key was legitimately rotated, use "forget host key" for this host in the remote-workspace panel and connect again. '
    + 'If you did not expect a key change, treat it as a possible man-in-the-middle and do not proceed.',
    { cause },
  )
  // Retrying a refused host key would hammer the server with a connection the
  // user has not authorised yet, so the background loop must stop instead of
  // treating this like a transient network failure.
  error.fatal = true
  return error
}

/**
 * Quote one argument for a POSIX shell.
 *
 * The implementation lives in `shared.js` so that `shell.js` and
 * `patch-terminal.js` can use it without importing the whole engine (which
 * would drag the connection pool, the diagnostics ring and the peer loader
 * into modules that only need to build a command string). Imported for local
 * use as well as re-exported, because `exec` below builds its `cd` prefix with
 * it: eight modules still reach for it through this module, and moving them is
 * not this refactor's business.
 */
export { shellQuote }

/**
 * Tag a failure whose remote effect is genuinely unknown.
 *
 * A transport that dies mid-write leaves the server in a state this process
 * cannot observe: the staged rename may have landed, the directory may exist.
 * The flag travels with the error so a caller (the transfer tool, the panel) can
 * say "check before retrying" instead of either claiming success or implying
 * nothing happened.
 *
 * @template {unknown} T
 * @param {T} error - the failure to tag.
 */
function markOutcomeUnknown (error) {
  if (error !== null && typeof error === 'object') error.outcome = 'unknown'
  return error
}

/**
 * Resolve the ssh-agent endpoint for agent auth.
 *
 * @returns {string | undefined} the endpoint, or undefined when unavailable.
 */
function resolveAgentPath (configured) {
  if (typeof configured === 'string' && configured !== '') return configured
  const sock = process.env.SSH_AUTH_SOCK
  if (sock !== undefined && sock !== '') return sock
  if (process.platform === 'win32') return 'pageant'
  return undefined
}

/**
 * Ask an agent endpoint whether it actually answers.
 *
 * `resolveAgentPath` is a NAME resolver, not a liveness check — on Windows it
 * answers `pageant` whether or not Pageant is running — and ssh2 does not
 * validate an endpoint until an auth attempt reaches it. Attaching a dead
 * agent therefore does not fail at connect: it fails INSIDE authentication,
 * where its error ("Failed to retrieve identities from agent") replaces the
 * real one. One local `getIdentities` call beforehand is cheap and turns a
 * misleading failure into a silent, honest absence.
 *
 * The timeout matters because a hung agent would otherwise stall a connect
 * indefinitely; an unanswered agent is treated as unreachable.
 *
 * @returns {Promise<boolean>} true when the agent answered.
 */
async function agentIsReachable (agentPath) {
  let agent
  try {
    agent = createAgent(agentPath)
  } catch {
    // An unusable endpoint (a path that is not a socket) throws here.
    return false
  }
  if (typeof agent?.getIdentities !== 'function') return false
  return await new Promise((resolve) => {
    let settled = false
    const done = (reachable) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(reachable)
    }
    const timer = setTimeout(() => done(false), 2_000)
    timer.unref?.()
    try {
      agent.getIdentities((error, keys) => done(error === undefined || error === null ? Array.isArray(keys) : false))
    } catch {
      done(false)
    }
  })
}

export { DEFAULTS as ENGINE_DEFAULTS, ftpCodeOf, agentIsReachable, isAgentForwardingRefusal }

// ---------------------------------------------------------------------------
// What this plugin actually ran: the command audit
// ---------------------------------------------------------------------------
//
// The engine below constructs this: the object that decides a command may run
// is the one that records that it did.
//
// It is a RECORD, not a sandbox, and that is the point rather than a
// compromise: the plugin cannot confine a remote command (it runs as the remote
// login user with that user's full permissions, and nothing on this side of an
// SSH channel is a kernel boundary). A command filter that misclassifies
// `sh -c 'rm -rf ~'` is worse than no filter; a log that records it is simply a
// log — and it is the only layer that survives being wrong.
//
// It is a separate ring from `diagnostics.js` on purpose: that one holds notable
// EVENTS ("what went wrong"), this one holds COMMANDS ("what happened here"), and
// an outage produces a burst of events and no commands while a busy session
// produces hundreds of commands and one connect. One shared bounded ring would
// let either flush the other.
//
// Redaction happens on EXPORT, not on write: the ring is the user's own record
// of what they ran on their own machine, and `what did I run?` is the only
// question it exists to answer. The two edges that leave the machine — the
// diagnosis text (`exportText`) and the support bundle — mask on the way out.
// Output is deliberately not recorded — a command's stdout can be megabytes and
// can contain anything, and a log that stores output is a log that has to
// answer "how much".

/** Entries kept. Enough for a session's worth of work, small enough to export. */
export { AUDIT_CAPACITY, AUDIT_MAX_CAPACITY, AUDIT_MIN_CAPACITY } from './audit-limits.js'

// Kept exported from here as well: a caller that thinks of "command redaction"
// as part of the audit should not have to know it moved.
export { redactCommand }

/** Longest command retained; the rest is truncated with a marker. */
const MAX_COMMAND_CHARS = 400

/** Longest error string retained. */
const MAX_ERROR_CHARS = 200

/** Longest session id retained. Ids from the Host are slugs, not sentences. */
const MAX_SESSION_CHARS = 64


/**
 * Cut a string to a bound, marking that it was cut.
 *
 */
function bounded (value, limit) {
  const text = String(value ?? '')
  if (text.length <= limit) return text
  return `${text.slice(0, limit - 3)}...`
}

/**
 * One audited command.
 *
 * @typedef {object} AuditEntry
 * @property {number} seq - monotonic id; survives ring eviction.
 * @property {number} at - epoch ms when the run STARTED.
 * @property {string} alias - host alias.
 * @property {string} command - redacted, bounded command line.
 * @property {string} [cwd] - remote working directory, when given.
 * @property {'exec'|'shell'|'terminal'|'background'} channel - how it ran.
 * @property {number} durationMs - wall clock.
 * @property {number|null} exitCode - the status, or null when unknown.
 * @property {boolean} timedOut - whether the budget expired.
 * @property {boolean} [outcomeUnknown] - the connection died; it may have run.
 * @property {string} [error] - redacted failure text.
 * @property {boolean} [refused] - the mode gate refused it, so nothing ran.
 * @property {string} [sessionId] - the conversation that asked, when known.
 */

/**
 * The audit ring.
 *
 * Same discipline as the diagnostics ring: bounded, infallible, plain objects.
 * `record()` never throws, because every call site is inside a command path and
 * a log that can fail the command it describes is worse than no log.
 */
export class CommandAudit {
  /** @param {number} [capacity] - entries to keep. */
  constructor (capacity = AUDIT_CAPACITY) {
    /** @type {AuditEntry[]} */
    this.entries = []
    this.capacity = Number.isInteger(capacity) && capacity > 0 ? capacity : AUDIT_CAPACITY
    /**
     * Monotonic counter, kept OUTSIDE the array so `seq` keeps increasing after
     * old entries fall off — a reader can tell a gap from a repeat.
     */
    this.sequence = 0
    /**
     * Called after every retained change (record, capacity, restore, clear).
     *
     * The ring itself stays synchronous and dependency-free; persistence hangs
     * off this hook so the module never imports a filesystem. Callbacks run in a
     * try/catch: a broken writer must not swallow a command's result.
     *
     * @type {(() => void) | undefined}
     */
    this.onChange = undefined
  }

  #changed () {
    try {
      this.onChange?.()
    } catch { /* the log never fails the command it describes */ }
  }

  /**
   * Append one command.
   *
   * The command travels RAW: this is the user's own ring on their own machine,
   * and a reader that has to decode `<redacted>` cannot answer "what did I
   * actually run?" — which is the only question the table exists for. Masking
   * happens at the edges that leave the machine instead: `exportText()` for the
   * diagnosis report and `buildSupportBundle()` for a bundle someone hands
   * over. Bounds still apply here: a 40 KB command line is a memory problem,
   * not a secrecy one.
   *
   */
  record (entry) {
    try {
      this.sequence += 1
      const stored = {
        seq: this.sequence,
        at: Number.isFinite(entry?.at) ? entry.at : Date.now(),
        alias: String(entry?.alias ?? ''),
        command: bounded(entry?.command, MAX_COMMAND_CHARS),
        channel: entry?.channel === 'shell' || entry?.channel === 'terminal' || entry?.channel === 'background' ? entry.channel : 'exec',
        durationMs: Number.isFinite(entry?.durationMs) ? Math.max(0, Math.round(entry.durationMs)) : 0,
        exitCode: typeof entry?.exitCode === 'number' ? entry.exitCode : null,
        timedOut: entry?.timedOut === true,
      }
      if (typeof entry?.cwd === 'string' && entry.cwd !== '') stored.cwd = bounded(entry.cwd, 200)
      if (typeof entry?.sessionId === 'string' && entry.sessionId !== '') stored.sessionId = bounded(entry.sessionId, MAX_SESSION_CHARS)
      if (entry?.outcomeUnknown === true) stored.outcomeUnknown = true
      if (entry?.refused === true) stored.refused = true
      if (typeof entry?.error === 'string' && entry.error !== '') stored.error = bounded(entry.error, MAX_ERROR_CHARS)
      this.entries.push(stored)
      if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity)
      this.#changed()
      return stored
    } catch {
      return undefined
    }
  }

  /**
   * Change how many entries are kept, trimming immediately.
   *
   * The retention setting and the ring's real size must be the same number, so
   * this is the ONLY writer of `capacity`: a shape that reached the ring through
   * a second door would drift the moment one door changed and the other did not.
   *
   * @returns {number} the capacity actually in force.
   */
  setCapacity (capacity) {
    const next = Number.isInteger(capacity) && capacity >= AUDIT_MIN_CAPACITY && capacity <= AUDIT_MAX_CAPACITY
      ? capacity
      : AUDIT_CAPACITY
    this.capacity = next
    if (this.entries.length > next) this.entries.splice(0, this.entries.length - next)
    this.#changed()
    return next
  }

  /**
   * Seed the ring from a persisted file, then trim to the current capacity.
   *
   * Rows come back through the same field bounds as live ones: a file is
   * external input (a user can edit it, an older version can have written it),
   * so nothing loaded from disk may bypass the length caps or the enum checks.
   * Redaction is NOT re-applied here — the ring keeps what was typed, and the
   * masking happens at the exports.
   *
   * @param {unknown} rows - parsed `entries`, expected to be an array.
   * @returns {number} how many survived validation.
   */
  restore (rows) {
    if (!Array.isArray(rows)) return 0
    const kept = []
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue
      const stored = {
        seq: Number.isFinite(row.seq) ? Math.max(0, Math.round(row.seq)) : 0,
        at: Number.isFinite(row.at) ? row.at : Date.now(),
        alias: String(row.alias ?? ''),
        command: bounded(row.command, MAX_COMMAND_CHARS),
        channel: row.channel === 'shell' || row.channel === 'terminal' || row.channel === 'background' ? row.channel : 'exec',
        durationMs: Number.isFinite(row.durationMs) ? Math.max(0, Math.round(row.durationMs)) : 0,
        exitCode: typeof row.exitCode === 'number' ? row.exitCode : null,
        timedOut: row.timedOut === true,
      }
      if (typeof row.cwd === 'string' && row.cwd !== '') stored.cwd = bounded(row.cwd, 200)
      if (typeof row.sessionId === 'string' && row.sessionId !== '') stored.sessionId = bounded(row.sessionId, MAX_SESSION_CHARS)
      if (row.outcomeUnknown === true) stored.outcomeUnknown = true
      if (row.refused === true) stored.refused = true
      if (typeof row.error === 'string' && row.error !== '') stored.error = bounded(row.error, MAX_ERROR_CHARS)
      kept.push(stored)
    }
    kept.sort((left, right) => left.seq - right.seq)
    this.entries = kept.slice(-this.capacity)
    // `seq` continues from the highest row read back, so a new command can never
    // reuse an id a reader has already seen in the file.
    this.sequence = this.entries.length === 0 ? 0 : this.entries[this.entries.length - 1].seq
    return this.entries.length
  }

  /**
   * The retained entries, oldest first.
   *
   * @returns {AuditEntry[]} copies, so a caller cannot mutate the log.
   */
  list (limit) {
    const all = this.entries.map(entry => ({ ...entry }))
    if (typeof limit === 'number' && limit > 0) return all.slice(-limit)
    return all
  }

  /**
   * Rows for one host only.
   *
   */
  listFor (alias, limit) {
    const rows = this.entries.filter(entry => entry.alias === alias).map(entry => ({ ...entry }))
    if (typeof limit === 'number' && limit > 0) return rows.slice(-limit)
    return rows
  }

  /**
   * Rows one conversation asked for.
   *
   * The audit tab filters by workspace, and a workspace is a set of session ids
   * (a session created in a remote cwd; a re-open under the same root). The
   * session id is the join key — an alias cannot stand in, because one host can
   * carry several unrelated workspaces.
   *
   * @param {string} sessionId - the conversation's id.
   * @param {number} [limit] - newest N.
   * @returns {AuditEntry[]} copies, oldest first.
   */
  listForSession (sessionId, limit) {
    const rows = this.entries.filter(entry => entry.sessionId === sessionId).map(entry => ({ ...entry }))
    if (typeof limit === 'number' && limit > 0) return rows.slice(-limit)
    return rows
  }

  /**
   * A portable text form for the diagnostic report.
   *
   * The ring keeps commands raw, so THIS is the boundary that masks: the report
   * is read by an agent and can be pasted into a support bundle. Masking here,
   * and in the bundle's own renderer, keeps the one copy on this machine
   * readable while everything that leaves the machine is not.
   *
   */
  exportText (limit = 50) {
    const entries = this.list(limit)
    if (entries.length === 0) return 'no remote commands recorded'
    const lines = [`commands: ${entries.length} of ${this.sequence} recorded`, '']
    for (const entry of entries) {
      const when = new Date(entry.at).toISOString()
      const status = entry.refused === true
        ? 'refused'
        : entry.outcomeUnknown === true
          ? 'outcome unknown'
          : entry.timedOut
            ? 'timed out'
            : `exit ${entry.exitCode === null ? 'null' : entry.exitCode}`
      const where = entry.cwd === undefined ? '' : ` (cwd ${redactCommand(entry.cwd)})`
      lines.push(`#${entry.seq} ${when} ${entry.alias} ${entry.channel} ${status} ${entry.durationMs}ms${where}`)
      lines.push(`  ${redactCommand(entry.command)}`)
      if (entry.error !== undefined) lines.push(`  error: ${redactCommand(entry.error)}`)
    }
    return lines.join('\n')
  }

  /** Drop everything. */
  clear () {
    this.entries.length = 0
    this.#changed()
  }
}
