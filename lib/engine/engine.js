/**
 * SSH engine: one persistent ssh2 connection per host alias, plus the
 * promisified SFTP surface the remote filesystem backend is built on.
 *
 * Each connection carries a shared SFTP channel plus a lazily-opened second
 * channel that long streaming reads ride (`streamChannel`), so a large file
 * transfer does not make stats, listings and the change watcher queue behind
 * it. Every connection verifies the server's host key: trust on first use
 * records the SHA256 fingerprint in the shared host store, and a later key
 * that differs refuses the connection instead of silently trusting it. The
 * refusal message names both fingerprints and points at the panel's "forget
 * host key" action.
 *
 * ## What it ran, next to how it runs it
 *
 * The bottom of this file is the command audit (`CommandAudit`, `redactCommand`).
 * The engine constructs it: the object that decides a command may run is the
 * one that records that it did.
 *
 * @module @shiqyka/dsh-ssh-workspace/engine
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { requirePeer } from '../core/peers.js'
import { describeChain } from '../hosts/hosts.js'
import { Diagnostics, KINDS, maskText } from '../core/diagnostics.js'
import { HostStore, expandHome } from '../hosts/hosts.js'
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
   *
   * Each hop is a real SSH connection, dialed on a TCP channel forwarded from
   * the connection before it — the shape `ssh -J a,b` produces. The target then
   * connects over the LAST hop's forwarded channel, so from the server's point
   * of view the client is its immediate neighbour and nothing else.
   *
   * ## Every hop authenticates and pins its own host key
   *
   * A hop is resolved by the same {@link HostStore} the target is, and its host
   * key is verified and recorded under ITS OWN alias. A bastion the user has
   * never connected to is trusted on first use exactly like any other host; a
   * bastion whose key changed is REFUSED, instead of being quietly accepted
   * because the target's key happened to be fine. One chain, several
   * independent trust decisions — never one decision covering all of them.
   * (This is also why a hop cannot be reused from the connection pool: a pooled
   * socket carries the identification of whoever opened it, and reusing it for
   * a different chain would silently merge two hosts' trust.)
   *
   * ## Credentials do not travel
   *
   * Nothing about hop N's auth is reused for hop N+1: each hop is resolved and
   * authenticated on its own. That is what makes `ProxyJump deploy@bastion`
   * safe to write next to a target that authenticates differently.
   *
   * ## Why it is asynchronous and fallible
   *
   * A chain is N handshakes plus N tunnels before the target is even dialed, so
   * it can fail at any hop, and the error has to say WHICH hop: "connection
   * refused" with no hop named is unactionable when the target itself is fine.
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
   * the connection turns out to be broken.
   *
   * ## Why replaying the whole callback is only safe for READS
   *
   * The retry exists for a transport that dies between "we asked" and "we got
   * the answer", and it works by running the callback a second time on a fresh
   * connection. That is sound for a read — a `stat` or `readdir` has no
   * effect to repeat — and unsound for anything that writes: a single-level
   * `mkdir` whose response was lost is committed on the server, so the replay
   * fails `EEXIST` on a file that is actually there; an upload re-copies the
   * whole file and re-fires every progress callback; a staged rename publishes
   * twice. The previous version replayed unconditionally, which quietly turned
   * "the link hiccuped" into "the side effect happened twice".
   *
   * So the caller declares the class: `'read'` (default, unchanged behavior)
   * replays once on a transport death; `'write'` never replays — it closes the
   * dead record and surfaces the failure, because the caller needs to know the
   * remote state is now uncertain rather than have the write attempted again.
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
   * Probe which optional remote tools a host actually has, and what its
   * environment looks like.
   *
   * The plugin degrades in several places when a remote tool is missing — no
   * `rg` means glob/grep cannot run, no `git` silently disables change
   * tracking, no `inotifywait` means change watching falls back to polling —
   * and without a probe the user only discovers that by hitting the failure.
   * One round trip per host turns those into an up-front answer.
   *
   * The tool list lives in `capabilities.js` (one table that also carries the
   * user-facing consequence and the install hint), so adding a capability
   * means adding a row there, not editing this method.
   *
   * The environment half rides the SAME round trip deliberately. Four separate
   * questions — which shell, which locale, how much disk, what watch limit —
   * are each cheap to ask and expensive to ask separately (one channel open and
   * one connection acquire per command). Asking them together is what keeps
   * "the panel shows a self-check" from costing five round trips per mount.
   *
   * The probe never throws: a host that cannot be reached, or a shell that
   * answers oddly, yields `undefined` per capability so the caller reports
   * "unknown" rather than a false negative.
   *
   * ## Why the parse is line-anchored
   *
   * The previous version decided presence with `stdout.includes('rg')`. That is
   * a substring test over the whole captured output, so any line that merely
   * CONTAINED the name — a path, a locale, a directory — reported the tool as
   * present. With the environment facts now sharing the stream (`$SHELL`,
   * `$LANG`, a `df` line) that would have become a routine false positive
   * rather than a theoretical one, so each fact is emitted on its own prefixed
   * line and matched as a whole line.
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
   * Run one shell command on a remote host.
   *
   * The filesystem seam carries file contents; a shell is a different
   * capability, so the remote workspace uses this for commands because the
   * deployment's pwsh/bash tools always execute on the local host.
   *
   * A transport death replays the command once only when the caller says the
   * command is replayable, and never once it has started producing output.
   *
   * ## Why "no output" is not the test
   *
   * The previous version treated "this run produced no bytes" as proof the
   * command had not run, and replayed on that basis. The two are not the same
   * fact: `rm -f x`, `touch x`, `mv`, `git commit -q` and a successful `curl`
   * all complete silently, so a connection that dies between "the command
   * finished" and "the exit status came back" looked exactly like one that
   * died before it started. Replaying then did the side effect a second time.
   *
   * Replay is therefore opt-in (`replay: 'safe'`) and only for commands the
   * plugin itself knows to be read-only probes. Everything else — the default —
   * reports the loss as `outcome: 'unknown'` instead of pretending the command
   * did not run, and a run that dies after emitting output is reported the same
   * way whether or not it was marked replayable.
   *
   * @param {number} [options.timeoutMs] - wall-clock budget (default 60000).
   * @param {boolean} [options.audit] - set `false` for a read that corresponds to no
   *   user action (the directory pickers' listing). It is excluded from the audit
   *   ring for the same reason an SFTP `readdir` never appears there: the audit
   *   answers "what did the agent/user run", and a listing is neither.
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
    let outcome
    let attempts = 0
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
          signal: options.signal,
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
        && options.signal?.aborted !== true
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
      throw error
    }
    record.inFlight -= 1
    record.idleAt = Date.now()
    let closed = false
    const finish = () => {
      if (closed) return
      closed = true
      release()
      try { options.onClose?.() } catch { /* a throwing consumer must not leak the hold */ }
    }
    if (typeof channel.once === 'function') channel.once('close', finish)
    else if (typeof channel.on === 'function') channel.on('close', finish)
    const onAbort = () => {
      try { channel.close() } catch { /* channel already gone */ }
      finish()
    }
    if (options.signal !== undefined && options.signal !== null && typeof options.signal.addEventListener === 'function') {
      if (options.signal.aborted === true) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }
    return {
      channel,
      record,
      release: () => {
        options.signal?.removeEventListener?.('abort', onAbort)
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
// Redaction happens on WRITE, never on export: a raw copy that only gets masked
// at the boundary is a raw copy that can leak through any other reader. Output is
// deliberately not recorded — a command's stdout can be megabytes and can contain
// anything, and a log that stores output is a log that has to answer "how much".

/** Entries kept. Enough for a session's worth of work, small enough to export. */
export const AUDIT_CAPACITY = 200

/** Longest command retained; the rest is truncated with a marker. */
const MAX_COMMAND_CHARS = 400

/** Longest error string retained. */
const MAX_ERROR_CHARS = 200

/**
 * Strip the things a command line routinely carries that must not travel.
 *
 * Deliberately the same family as `diagnostics.js` redaction, plus the patterns
 * that only appear in COMMAND LINES:
 *
 *  - an explicit password/passphrase assignment;
 *  - an `Authorization` header or a bearer token;
 *  - a `--password` / `-p` style flag value;
 *  - a token-shaped query parameter (`?token=…`, `&access_token=…`).
 *
 * The regexes are conservative on purpose: over-redacting a command makes the
 * log useless ("what did I run?"), while under-redacting leaks. Where the two
 * trade off, this errs toward keeping the shape of the command and masking only
 * the value.
 *
 */
export function redactCommand (command) {
  let text = String(command ?? '')
  // An explicit assignment, quoted or not. The name is matched with its
  // PREFIX intact (`DB_PASSWORD`, `GITHUB_TOKEN`) because a `\b` before
  // `password` does not fire after an underscore — which is exactly how an
  // environment-variable assignment is spelled, and the first version of this
  // regex let `DB_PASSWORD=...` through untouched.
  text = text.replace(
    /([A-Za-z0-9_-]*(?:password|passwd|passphrase|secret|token|api[_-]?key))(\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s;|&]+)/giu,
    (_match, name, separator) => `${name}${separator}<redacted>`,
  )
  // A flag whose next token is the value.
  text = text.replace(
    /(--?(?:password|passwd|passphrase|token|api-key|apikey)[=\s])(?:"[^"]*"|'[^']*'|[^\s;|&]+)/giu,
    (_match, flag) => `${flag}<redacted>`,
  )
  // An Authorization header. `Bearer <token>` is handled BEFORE the generic
  // header rule, because the generic rule's "one word" value would consume the
  // scheme and leave the token in plain sight — which is what the first
  // version did.
  text = text.replace(
    /(authorization\s*:\s*)(?:bearer|basic|token)\s+[A-Za-z0-9._~+/=-]+/giu,
    (_match, header) => `${header}<redacted>`,
  )
  text = text.replace(
    /(authorization\s*:\s*)(?:"[^"]*"|'[^']*'|[^\s;|&]+)/giu,
    (_match, header) => `${header}<redacted>`,
  )
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gu, 'Bearer <redacted>')
  // A token-shaped query parameter.
  text = text.replace(
    /([?&](?:token|access_token|api_key|apikey|key|signature|sig)=)[^&\s]+/giu,
    (_match, prefix) => `${prefix}<redacted>`,
  )
  // Home directories, which carry the local or remote username.
  // The shared rule, so a path is masked identically here, in the diagnostics
  // text and in the support bundle. This module used to repeat the three
  // home-directory patterns verbatim; a fourth copy is how one surface ends up
  // masking a path the other three print.
  return maskText(text)
}

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
  }

  /**
   * Append one command.
   *
   */
  record (entry) {
    try {
      this.sequence += 1
      const stored = {
        seq: this.sequence,
        at: Number.isFinite(entry?.at) ? entry.at : Date.now(),
        alias: String(entry?.alias ?? ''),
        command: bounded(redactCommand(entry?.command), MAX_COMMAND_CHARS),
        channel: entry?.channel === 'shell' || entry?.channel === 'terminal' || entry?.channel === 'background' ? entry.channel : 'exec',
        durationMs: Number.isFinite(entry?.durationMs) ? Math.max(0, Math.round(entry.durationMs)) : 0,
        exitCode: typeof entry?.exitCode === 'number' ? entry.exitCode : null,
        timedOut: entry?.timedOut === true,
      }
      if (typeof entry?.cwd === 'string' && entry.cwd !== '') stored.cwd = bounded(redactCommand(entry.cwd), 200)
      if (entry?.outcomeUnknown === true) stored.outcomeUnknown = true
      if (entry?.refused === true) stored.refused = true
      if (typeof entry?.error === 'string' && entry.error !== '') stored.error = bounded(redactCommand(entry.error), MAX_ERROR_CHARS)
      this.entries.push(stored)
      if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity)
      return stored
    } catch {
      return undefined
    }
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
   * A portable text form for the diagnostic report.
   *
   * Every field is already redacted at write time, so this is a formatter, not a
   * second redaction pass — two passes would drift.
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
      const where = entry.cwd === undefined ? '' : ` (cwd ${entry.cwd})`
      lines.push(`#${entry.seq} ${when} ${entry.alias} ${entry.channel} ${status} ${entry.durationMs}ms${where}`)
      lines.push(`  ${entry.command}`)
      if (entry.error !== undefined) lines.push(`  error: ${entry.error}`)
    }
    return lines.join('\n')
  }

  /** Drop everything. */
  clear () {
    this.entries.length = 0
  }
}
