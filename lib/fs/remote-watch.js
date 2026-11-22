/**
 * The shared change watcher: one underlying watcher per remote target.
 *
 * `ctx.fs.watch` is asked for the same target by more than one consumer — the
 * file tree registers one subscription per host and another per workspace, and
 * a subscription that is still closing overlaps its replacement. Two pollers on
 * one path double every event and each keeps its own reconnect loop, its own
 * timer and its own connection hold alive. This registry makes the underlying
 * watcher a property of the TARGET: the first subscriber opens it, the last
 * close stops it, and everyone in between shares it.
 *
 * The watch itself has two implementations. A host with `inotifywait` pushes
 * events, which is immediate and sees rewrites that metadata comparison cannot;
 * everything else polls, on an interval that backs off over quiet stretches.
 * Push degrades to polling when its channel dies, so a lost notification
 * channel goes quiet in the logs instead of going silent in the tree.
 *
 * The router owns the SFTP primitives and the metadata cache, so this module
 * asks for observations through a small host object rather than importing them:
 *
 * - `engine` — the live SSH engine;
 * - `invalidate(parts)` — drop cached metadata for a target and its parent;
 * - `observe(parts)` — one comparable snapshot (absent / file / directory);
 * - `isDirectory(parts)` — whether a push watcher should ask for `-r`.
 *
 * @module @shiqyka/dsh-ssh-workspace/remote-watch
 */

import { normalizeRemotePath } from '../core/protocol.js'
import { shellQuote } from '../engine/engine.js'
import { KINDS } from '../core/diagnostics.js'
import { watchFailureVerdict, watchRecoveryDelay } from '../engine/reconnect.js'
import { requirePeer } from '../core/peers.js'

const { FsError } = requirePeer('@deepseek-ai/dsh-fs')

/** Poll interval for remote change observation (SFTP has no notifications). */
const WATCH_POLL_INTERVAL_MS = 2000

/** Steady poll interval after {@link WATCH_QUIET_ROUNDS} unchanged rounds. */
const WATCH_SLOW_INTERVAL_MS = 5000

/** Ceiling of the quiet backoff: a change is still noticed within this. */
const WATCH_MAX_INTERVAL_MS = 10_000

/**
 * Opening-observation retries before `watch()` rejects.
 *
 * The delays are 1 + 2 + 4 + 8 + 16 s, so a caller waits at most ~31s for a
 * link that is still down — long enough to ride out a Wi-Fi switch, short
 * enough that a genuinely unreachable host is reported rather than hanging.
 */
const WATCH_START_MAX_RETRIES = 5

/** Unchanged polls before backing off once. At the base interval that is ~30s
 * of quiet before a watched path starts costing less, and the next step backs
 * off to the ceiling.
 */
const WATCH_QUIET_ROUNDS = 15

/**
 * How many distinct targets may be watched at once.
 *
 * A resource bound, not a policy. Every live target costs a poller (or an
 * `inotifywait` channel) and holds a connection open, so expanding a wide tree
 * could otherwise start one per directory with nothing anywhere to stop it.
 * Sixty-four is far above what the file tree and the panel ask for in practice,
 * and low enough that the failure arrives while one is looking at it.
 *
 * Reaching the cap is REPORTED to the caller that asked for one more, never
 * silently absorbed: a watcher that quietly did nothing would leave the tree
 * showing stale entries with no way to tell why. Closing a watch frees its
 * slot, so the bound is a limit on concurrency rather than a budget that gets
 * spent.
 */
const WATCH_MAX_ENTRIES = 64

/**
 * The refusal for a registry that is already at {@link WATCH_MAX_ENTRIES}.
 *
 * Deliberately a distinct code: `FS_TOO_MANY` tells a caller this is a capacity
 * answer about THIS target, not a broken host and not an expired handle.
 */
function tooManyWatches () {
  return new FsError(
    `cannot watch more than ${WATCH_MAX_ENTRIES} remote targets at once: ` +
    'close a workspace or a folder you no longer have open to free a slot',
    'FS_TOO_MANY',
  )
}

/**
 * The registry of live watchers, one per remote target.
 */
export class RemoteWatchRegistry {
  constructor (host) {
    this.#host = host
    /**
     * Live change watchers, keyed `<alias>\0<normalized path>`.
     *
     * @type {Map<string, object>}
     */
    this.watches = new Map()
  }

  /** @type {{engine: object, invalidate: Function, observe: Function, isDirectory: Function}} */
  #host
  /**
   * Subscribe to one target, sharing the underlying watcher with every other
   * subscriber of the same target.
   *
   * Consumers are fanned out once per observed change: the first time a path is
   * watched opens the watcher, later callers join it, and closing one caller
   * must not silence the others. The returned close is reference-counted — the
   * last one stops the watcher.
   *
   * @returns {Promise<Function>} async close for this consumer only.
   */
  async watch (parts, changed, signal) {
    const key = `${parts.alias}\0${normalizeRemotePath(parts.remotePath)}`
    let entry = this.watches.get(key)
    if (entry === undefined && this.watches.size >= WATCH_MAX_ENTRIES) {
      // A NEW target over the cap is refused here, before anything is opened.
      // An existing one still joins its own watcher: sharing a watcher already
      // paid for cannot grow the resource use the cap exists to bound.
      throw tooManyWatches()
    }
    if (entry === undefined) {
      entry = {
        key,
        parts,
        /** @type {Set<object>} */
        consumers: new Set(),
        controller: new AbortController(),
        /** @type {{mode: 'push'|'poll', close?: Function}} */
        live: { mode: 'poll', close: undefined },
        closed: false,
        degraded: false,
        closePromise: undefined,
        start: undefined,
      }
      entry.notify = (error) => this.#notifyShared(entry, error)
      this.watches.set(key, entry)
      // Start before any await: a second caller arriving in the same tick must
      // find this entry instead of opening a second watcher.
      entry.start = this.#openSharedWatch(entry)
      // The waiters below observe the rejection; this handler exists so a
      // failure with zero waiters is not an unhandled rejection, and it is also
      // where a failed registry entry is removed.
      void entry.start.catch(() => {
        entry.closed = true
        if (this.watches.get(key) === entry) this.watches.delete(key)
        entry.controller.abort()
        for (const consumer of entry.consumers) {
          consumer.active = false
          try { consumer.signal?.removeEventListener?.('abort', consumer.onAbort) } catch { /* ignore */ }
        }
        entry.consumers.clear()
      })
    }

    /** @type {{changed: Function, signal?: AbortSignal, active: boolean, onAbort?: Function}} */
    const consumer = { changed, signal, active: true, onAbort: undefined }
    entry.consumers.add(consumer)
    const release = () => {
      if (consumer.active !== true) return false
      consumer.active = false
      entry.consumers.delete(consumer)
      try { signal?.removeEventListener?.('abort', consumer.onAbort) } catch { /* ignore */ }
      return entry.consumers.size === 0
    }
    consumer.onAbort = () => {
      if (release()) void this.#stopSharedWatch(entry)
    }
    signal?.addEventListener?.('abort', consumer.onAbort, { once: true })

    try {
      if (signal?.aborted === true) throw new FsError('watch aborted', 'FS_ABORTED')
      await this.#waitForSharedStart(entry, signal)
    } catch (error) {
      if (release()) void this.#stopSharedWatch(entry)
      throw error
    }

    return async () => {
      if (release()) await this.#stopSharedWatch(entry)
    }
  }
  /**
   * Wait for a shared watcher to finish initialization, but stop waiting only
   * for THIS consumer when its signal fires.
   *
   * The underlying start belongs to the entry, not to a caller: aborting one
   * consumer must not cancel a watcher another consumer is waiting on.
   *
   */
  #waitForSharedStart (entry, signal) {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (callback, value) => {
        if (settled) return
        settled = true
        try { signal?.removeEventListener?.('abort', aborted) } catch { /* ignore */ }
        callback(value)
      }
      const aborted = () => finish(reject, new FsError('watch aborted', 'FS_ABORTED'))
      if (signal?.aborted === true) {
        aborted()
        return
      }
      signal?.addEventListener?.('abort', aborted, { once: true })
      entry.start.then(() => finish(resolve), (error) => finish(reject, error))
    })
  }
  /**
   * Establish the one underlying watcher for an entry.
   *
   * This is the old `watch` body, lifted out so every subscriber shares it:
   * capability probe, push-or-poll preference, the single `live` slot and the
   * push→poll degradation all happen once per target. All callbacks and the
   * abort signal belong to the entry, never to a consumer.
   *
   */
  async #openSharedWatch (entry) {
    const { parts } = entry
    const signal = entry.controller.signal
    // The poller reads the server directly (never its own cache) and drops the
    // cached metadata for the target and its parent before notifying, so a
    // consumer that refetches on change reads fresh data.
    const invalidate = () => this.#host.invalidate(parts)
    // Prefer the host's own change notifications: they report immediately and
    // see rewrites the metadata comparison cannot. A host without
    // `inotifywait`, or one whose watch cannot be established, simply gets the
    // poller instead — the same behavior as before this existed.
    //
    // Only try the push watcher when the host is known to have the tool: the
    // probe is cached per host, so this costs no extra round trip on the common
    // path, and it keeps a host without inotifywait from paying a shell spawn
    // per watched target.
    const capabilities = await this.#host.engine.probeCapabilities(parts.alias)
    if (entry.closed) return
    /**
     * Ask the engine whether a failed observation is a transport accident that
     * something is actively repairing, or a real failure to report.
     *
     * This is the whole of F-01's watcher half: the seam's contract says a
     * callback given an Error means "I am finished, close me", and the HOST
     * honours that literally — `dsh-client-ui-sidebar-files` marks the row and
     * never retries (it even swallows `watch-unsupported` outright). So a
     * watcher that reported a dropped link stopped forever, and the file tree
     * froze with no message. The decision is delegated to `reconnect.js`
     * (`watchFailureVerdict`) so it can be executed in a test rather than
     * inferred from source text.
     */
    const recovery = (error) => watchFailureVerdict({
      connected: this.#host.engine.generationOf?.(parts.alias)?.connected === true,
      loop: this.#host.engine.reconnector?.stateOf?.(parts.alias),
      error,
    })
    /**
     * The ONE live handle for this entry.
     *
     * The previous shape kept two parallel variables (`closePush`, `closePoll`)
     * and returned a close that touched only `closePush` whenever the push
     * watcher had started. The degradation path then armed polling behind the
     * caller's back: after "push dies → polling takes over", the returned close
     * still closed the push branch while the poller kept its timer, its SFTP
     * polls and its connection hold forever. A single mutable slot makes that
     * unrepresentable — whoever installs a handle closes the one it replaces,
     * and the entry's close closes whatever is current.
     */
    const live = entry.live

    /** Close the installed handle, tolerating one that never resolved. */
    const closeLive = async () => {
      const handle = live.close
      live.close = undefined
      if (handle !== undefined) {
        try { await handle() } catch { /* already closed */ }
      }
    }

    /**
     * Install a handle, closing the one it replaces.
     *
     */
    const install = async (mode, close) => {
      if (entry.closed) {
        // Every consumer closed while this watcher was still being established;
        // its handle must not be leaked just because it arrived late.
        try { await close() } catch { /* already closed */ }
        return
      }
      await closeLive()
      if (entry.closed) {
        // Closing the replaced handle can be slow enough for the last consumer
        // to leave; the newcomer must be closed rather than installed into an
        // entry nobody owns.
        try { await close() } catch { /* already closed */ }
        return
      }
      live.mode = mode
      live.close = close
    }

    /**
     * Start the poller, reporting a failure the caller can act on.
     *
     * A bare `running.then(close => …, () => {})` swallowed an initialization
     * failure: the watcher simply never worked and nothing said why. The
     * rejection still reaches the caller through the abort signal (that is the
     * seam's contract), but a non-abort failure is now recorded instead of
     * vanishing.
     *
     */
    const startPolling = async () => {
      try {
        const close = await startRemoteWatch(this.#host, parts, entry.notify, signal, invalidate, recovery)
        await install('poll', close)
      } catch (error) {
        if (signal.aborted !== true) {
          this.#host.engine?.diagnostics?.record(KINDS.degraded, `polling watcher could not start: ${error instanceof Error ? error.message : String(error)}`, { alias: parts.alias })
        }
        throw error
      }
    }

    if (capabilities.inotifywait === true) {
      let closePush
      try {
        closePush = await startPushWatch(this.#host, parts, entry.notify, signal, invalidate, () => {
          // The watcher died after it was announced as live: re-arm polling so a
          // lost notification channel degrades instead of going silent.
          if (entry.closed || entry.degraded) return
          entry.degraded = true
          // Observable, because the degradation changes what the user sees:
          // polling can miss a same-size rewrite within one mtime tick, and
          // "my edits stopped refreshing the tree" is otherwise unattributable.
          this.#host.engine?.diagnostics?.record(KINDS.degraded, 'inotifywait watcher ended; fell back to polling', { alias: parts.alias })
          // Fire and forget: the failure is recorded inside `startPolling`, and
          // the install still sees whatever handle it installs — the `install`
          // guard closes a late arrival if every consumer has already closed.
          void startPolling().catch(() => { /* recorded above */ })
        })
      } catch {
        closePush = undefined
      }
      if (closePush !== undefined) await install('push', closePush)
    }
    if (live.close === undefined && entry.closed !== true) await startPolling()
  }
  /**
   * Fan a change out to every live consumer of an entry, exactly once each.
   *
   * A failure is different: the underlying watcher is finished, so the entry is
   * stopped and unregistered before the error reaches consumers — the seam's
   * contract treats an Error as final and the caller closes in response.
   *
   * @param {unknown} [error] - a final failure, or undefined for a change.
   */
  #notifyShared (entry, error) {
    if (entry.closed) return
    if (error !== undefined) {
      const consumers = [...entry.consumers]
      entry.consumers.clear()
      for (const consumer of consumers) {
        consumer.active = false
        try { consumer.signal?.removeEventListener?.('abort', consumer.onAbort) } catch { /* ignore */ }
      }
      void this.#stopSharedWatch(entry)
      for (const consumer of consumers) {
        try { consumer.changed(error) } catch { /* one throwing consumer must not starve the rest */ }
      }
      return
    }
    for (const consumer of [...entry.consumers]) {
      if (consumer.active !== true) continue
      try { consumer.changed() } catch { /* one throwing consumer must not starve the rest */ }
    }
  }
  /**
   * Stop an entry's underlying watcher and forget the registry row.
   *
   * Idempotent: concurrent closes and the failure path can race, and the
   * channel/timer must be released exactly once. Only the last consumer calls
   * this, so a close never affects another subscriber.
   *
   */
  #stopSharedWatch (entry) {
    if (entry.closePromise !== undefined) return entry.closePromise
    entry.closePromise = (async () => {
      entry.closed = true
      if (this.watches.get(entry.key) === entry) this.watches.delete(entry.key)
      entry.controller.abort()
      const handle = entry.live.close
      entry.live.close = undefined
      if (handle !== undefined) {
        try { await handle() } catch { /* already closed */ }
      }
    })()
    return entry.closePromise
  }
  /**
   * How many underlying watchers are live per target, and who is sharing one.
   *
   * Sharing is only useful if it can be observed: "the tree refreshes twice"
   * and "two pollers hold two connections" are the same fact.
   *
   */
  targets () {
    /** @type {Array<object>} */
    const targets = []
    for (const entry of this.watches.values()) {
      targets.push({
        alias: entry.parts.alias,
        remotePath: entry.parts.remotePath,
        displayPath: entry.parts.displayPath,
        consumers: entry.consumers.size,
        watchers: entry.live.close === undefined ? 0 : 1,
        mode: entry.live.close === undefined ? null : entry.live.mode,
        opening: entry.live.close === undefined && entry.closed !== true,
      })
    }
    return targets
  }

  /**
   * The number of live underlying watchers for one target (0 or 1).
   *
   * @returns {number} 0 when no live watcher is installed, else 1.
   */
  countFor (alias, remotePath) {
    const entry = this.watches.get(`${alias}\0${normalizeRemotePath(remotePath)}`)
    return entry?.live.close === undefined ? 0 : 1
  }
}

/**
 * Watch one remote target through `inotifywait` when the host has it.
 *
 * The polling watcher below is correct but latent: a change is reported up to
 * a whole interval late, and two rewrites of the same length within one second
 * are invisible. When `inotifywait` exists the host can push events instead,
 * which removes both limits — the report is immediate, and nothing is inferred
 * from metadata.
 *
 * `inotifywait` is asked with `-m` (keep watching) and `-r` for a directory so
 * nested changes are seen the way the local recursive watcher sees them. It
 * prints one line per event; every line means "something changed", because the
 * seam's callback carries no detail. Stderr is drained so a full pipe cannot
 * stall the process.
 *
 * Failure of any kind — no `inotifywait`, a refused watch, a dropped channel —
 * resolves to `undefined` so the caller can fall back to polling. A push
 * watcher that dies later reports through `onError` and the caller re-arms
 * polling, so a lost watcher degrades instead of going silent.
 *
 * @param {Function} onError - called with an Error when the watcher dies.
 * @returns {Promise<Function | undefined>} an async close function, or undefined when unavailable.
 */
async function startPushWatch (host, parts, changed, signal, invalidate, onError) {
  const engine = host.engine
  if (typeof engine.openChannel !== 'function') return undefined
  const quoted = shellQuote(parts.remotePath)
  // `-r` only helps directories; on a file target inotifywait rejects it, so
  // stat first and pick the flag set that matches.
  let isDirectory = false
  try {
    isDirectory = (await host.isDirectory(parts)) === true
  } catch {
    return undefined
  }
  // Watching a path that does not exist yet is legitimate for a file target
  // (observe its creation) but impossible for inotifywait; a directory target
  // that is absent right now is left to the poller, which observes creation.
  const command = isDirectory
    ? `inotifywait -m -r -e create,modify,delete,move,attrib --format 'dsh-change' ${quoted} 2>/dev/null`
    : `inotifywait -m -e create,modify,delete,move,attrib --format 'dsh-change' ${quoted} 2>/dev/null`
  // A host without inotifywait, or one that refuses this path, exits during
  // setup. `live` tells that apart from a watcher dying later: setup failures
  // fall back to polling silently, a live watcher's death is reported so the
  // caller can re-arm polling.
  let opened
  try {
    opened = await engine.openChannel(parts.alias, command, { signal })
  } catch {
    return undefined
  }
  let live = false
  let closed = false
  let buffered = ''
  const { channel } = opened
  const report = () => {
    try { invalidate?.() } catch { /* invalidation must not stop the watcher */ }
    try { changed() } catch { /* a throwing consumer must not stop the watcher */ }
  }
  const onData = (chunk) => {
    if (closed) return
    buffered += chunk.toString('utf8')
    // One report per batch of lines: events within the same tick are one change
    // as far as the consumer is concerned, and this keeps a burst from
    // scheduling thousands of refreshes.
    if (!buffered.includes('dsh-change')) return
    buffered = buffered.slice(buffered.lastIndexOf('dsh-change') + 'dsh-change'.length)
    report()
  }
  const onStderr = () => { /* drained only: stderr is silent or diagnostic */ }
  let endedEarly = false
  const onClose = () => {
    if (!live) {
      // Closed during setup: the tool is missing, the path was refused, or the
      // channel died. Let the caller fall back to polling without reporting.
      endedEarly = true
      return
    }
    if (closed) return
    closed = true
    try { onError?.(new Error('inotifywait watch ended')) } catch { /* consumer error must not escape */ }
  }
  if (typeof channel.on === 'function') channel.on('data', onData)
  if (typeof channel.stderr?.on === 'function') channel.stderr.on('data', onStderr)
  if (typeof channel.once === 'function') channel.once('close', onClose)
  else if (typeof channel.on === 'function') channel.on('close', onClose)
  // A host without inotifywait, or one that refuses this path, exits right
  // away; give it a beat to prove it is actually watching before announcing it.
  await new Promise((resolve) => setTimeout(resolve, 150))
  if (endedEarly || closed) return undefined
  live = true
  return async () => {
    closed = true
    try { channel.close() } catch { /* channel already gone */ }
    opened.release()
  }
}

/**
 * Poll one remote target until closed: a directory's direct entries, or a
 * single file — an absent path included, observed for creation. Each poll
 * rides `withSftp`, so between polls the connection is free for reaping.
 *
 * Polls always read the server (the metadata cache is never consulted), and a
 * change that is observed first invalidates the cached metadata for the target
 * and its parent, then notifies. The interval adapts: 2s while changes are
 * recent, backing off to 5s and then 10s over quiet stretches, snapping back
 * to 2s on the first observed change.
 *
 * @param {(error: unknown) => {retry: boolean, reason: string}} [recovery] -
 *   asked after a failed observation; `retry` means wait and observe again
 *   instead of reporting a failure the caller would treat as final.
 */
async function startRemoteWatch (host, parts, changed, signal, invalidate, recovery) {
  const engine = host.engine
  const aborted = () => signal?.aborted === true
  if (aborted()) throw new FsError('watch aborted', 'FS_ABORTED')
  const observe = () => host.observe(parts)

  /**
   * The opening observation, retried while the failure looks like a dropped
   * link.
   *
   * A rejected `watch()` is not retried by anyone: the host marks the row and
   * moves on. So an editor opened during a Wi-Fi blip — or a session restored
   * from disk before the network is back — used to produce a watcher that never
   * existed. Bounded, because this promise is what the caller is waiting on; a
   * link that is still down after the ladder is a failure worth reporting.
   */
  let previous
  for (let attempt = 0; ; attempt += 1) {
    try {
      previous = await observe()
      break
    } catch (error) {
      const verdict = recovery?.(error) ?? { retry: false, reason: 'no recovery policy' }
      if (verdict.retry !== true || attempt >= WATCH_START_MAX_RETRIES || aborted()) throw error
      engine?.diagnostics?.record(
        KINDS.degraded,
        `change watcher could not start (attempt ${attempt + 1}): ${verdict.reason}`,
        { alias: parts.alias },
      )
      // Deliberately NOT unref'd: this timer is the only thing that will resume
      // the caller waiting on this promise. An unref'd timer is free to never
      // run, which would leave `watch()` pending until the process happened to
      // exit — a hang instead of the retry it exists to perform.
      await new Promise((resolve) => { setTimeout(resolve, watchRecoveryDelay(attempt + 1)) })
      if (aborted()) throw new FsError('watch aborted', 'FS_ABORTED')
    }
  }
  if (aborted()) throw new FsError('watch aborted', 'FS_ABORTED')
  let closed = false
  let timer
  // Consecutive failed observations that were retried instead of reported.
  let failures = 0
  // Whether the current outage has already been announced. One line per outage
  // is enough: the diagnostics ring holds 40 entries, and an afternoon-long
  // outage would otherwise flush everything worth reading.
  let outageReported = false
  // Adaptive interval: recent change → the base interval; a long quiet stretch
  // backs off in two steps up to the ceiling, and any change snaps back.
  let interval = WATCH_POLL_INTERVAL_MS
  let quietRounds = 0
  const stop = () => {
    closed = true
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }
  const schedule = () => {
    timer = setTimeout(() => { tick() }, interval)
    if (typeof timer.unref === 'function') timer.unref()
  }
  async function tick () {
    if (closed) return
    if (aborted()) {
      stop()
      return
    }
    let next
    try {
      next = await observe()
    } catch (error) {
      if (closed) return
      const verdict = recovery?.(error) ?? { retry: false, reason: 'no recovery policy' }
      if (verdict.retry !== true) {
        // A real failure on a healthy connection (the path went away, the
        // permissions changed) or a dead link nobody is repairing. Reporting it
        // is the honest answer either way: the caller closes, and the row says
        // so instead of pretending to watch.
        stop()
        changed(error instanceof Error ? error : new Error(String(error)))
        return
      }
      failures += 1
      // Back off, and keep the adaptive interval at its floor so the first
      // observation after the link returns happens promptly.
      interval = watchRecoveryDelay(failures)
      if (!outageReported) {
        outageReported = true
        engine?.diagnostics?.record(
          KINDS.degraded,
          `change watcher paused: ${verdict.reason}; it will rescan when the connection returns`,
          { alias: parts.alias },
        )
      }
      if (!closed) schedule()
      return
    }
    if (closed) return
    if (failures > 0) {
      // Observations resumed. The snapshot taken before the outage cannot prove
      // nothing changed while the poller was blind — a file may have been
      // written and reverted, or a same-size rewrite landed inside one mtime
      // tick — so this is announced as a change whether or not the fresh
      // snapshot compares equal. Dropping it silently is precisely the freeze
      // this retry exists to remove.
      failures = 0
      outageReported = false
      quietRounds = 0
      interval = WATCH_POLL_INTERVAL_MS
      previous = next
      try { invalidate?.() } catch { /* invalidation must not stop polling */ }
      try { changed() } catch { /* a throwing consumer must not stop polling */ }
      schedule()
      return
    }
    if (!sameObservation(previous, next)) {
      previous = next
      quietRounds = 0
      interval = WATCH_POLL_INTERVAL_MS
      try { invalidate?.() } catch { /* invalidation must not stop polling */ }
      try { changed() } catch { /* a throwing consumer must not stop polling */ }
    } else {
      quietRounds += 1
      if (quietRounds === WATCH_QUIET_ROUNDS) interval = WATCH_SLOW_INTERVAL_MS
      else if (quietRounds === WATCH_QUIET_ROUNDS * 2) interval = WATCH_MAX_INTERVAL_MS
    }
    if (!closed) schedule()
  }
  schedule()
  return async () => { stop() }
}

/** Snapshot equality for {@link startRemoteWatch}. */
function sameObservation (left, right) {
  if (left.kind !== right.kind) return false
  if (left.kind === 'file') return left.version === right.version
  if (left.kind === 'directory') {
    if (left.snapshot.size !== right.snapshot.size) return false
    for (const [name, version] of left.snapshot) {
      if (right.snapshot.get(name) !== version) return false
    }
    return true
  }
  return true
}
