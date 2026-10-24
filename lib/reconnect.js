/**
 * Background reconnect for a dropped SSH connection.
 *
 * ## Why this exists
 *
 * A one-shot retry inside an operation (see `engine.withSftp`) is enough when a
 * link hiccups for a second: the operation that noticed the death opens a new
 * connection and replays. It is not enough for the way a laptop is actually
 * used — closing the lid, moving from Wi-Fi to a hotspot, or re-establishing a
 * VPN leaves the Host holding a dead socket with no user action to trigger the
 * next attempt. The user comes back to a tree that says "connection lost" until
 * they click something, even though the network has been back for ten minutes.
 *
 * ## Why it is a separate module
 *
 * The interesting part is the policy — how long to wait, when to stop, what the
 * UI can honestly say — and policy is what must be testable without an SSH
 * server. Nothing here imports ssh2; time and randomness are injectable so a
 * suite can drive minutes of backoff in microseconds.
 *
 * ## The stop rules matter more than the delay ladder
 *
 *  - Retry only while something still WANTS the connection: a mounted root, a
 *    held port forward, or a persistent shell. Nothing wants an idle pooled
 *    socket, and a background loop for one would dial a host nobody is looking
 *    at. `isWanted` is re-checked before every attempt, so closing the last
 *    consumer stops the loop instead of leaving it running.
 *  - Never give up while `maxAttempts` is 0 (the default). A laptop shut for an
 *    hour must find a live connection when it wakes; a bounded ladder would
 *    have exhausted itself long before.
 *  - Log sparsely: the diagnostics ring holds 40 entries, and an outage that
 *    lasts an afternoon would otherwise flush everything worth reading.
 *
 * @module @shiqyka/dsh-ssh-workspace/reconnect
 */

import { KINDS } from './diagnostics.js'

/** Default policy; every entry is overridable through the constructor. */
export const RECONNECT_DEFAULTS = Object.freeze({
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  /** 0 means "keep trying while the alias is wanted". */
  maxAttempts: 0,
  /** Fraction of the delay that may be shaved off at random, to spread retries. */
  jitter: 0.2,
})

/** A positive finite number from the options, falling back otherwise. */
function positive (value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/** A non-negative integer from the options, falling back otherwise. */
function nonNegativeInteger (value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

/** A 0..1 ratio from the options, falling back otherwise. */
function ratio (value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback
}

/**
 * Exponential-backoff driver for one alias at a time, several aliases in total.
 *
 * Every entry is a small state machine the status surfaces can read directly:
 * `waiting` (a timer is armed), `connecting` (an attempt is in flight), and
 * `gave-up` (a bounded ladder ran out, or nothing wanted the host any more).
 * The entry is the only place a client learns "attempt 4, next in 12s", so the
 * panel never has to infer progress from a sequence of events.
 */
export class ReconnectScheduler {
  /**
   * @param {object} options - scheduler options.
   * @param {(alias: string) => Promise<unknown>} options.attempt - performs one connection attempt.
   * @param {(alias: string) => boolean} [options.isWanted] - whether the alias still needs a connection.
   * @param {(alias: string) => void} [options.onRestored] - called after a background attempt succeeds.
   * @param {object} [options.diagnostics] - the engine's event log.
   * @param {object} [options.tuning] - delay policy overrides.
   * @param {() => number} [options.now] - clock (tests).
   * @param {() => number} [options.random] - randomness (tests).
   * @param {Function} [options.setTimeout] - timer (tests).
   * @param {Function} [options.clearTimeout] - timer (tests).
   */
  constructor (options = {}) {
    if (typeof options.attempt !== 'function') {
      throw new Error('ReconnectScheduler requires an attempt(alias) function')
    }
    this.attempt = options.attempt
    this.isWanted = typeof options.isWanted === 'function' ? options.isWanted : () => true
    this.onRestored = typeof options.onRestored === 'function' ? options.onRestored : undefined
    this.diagnostics = options.diagnostics
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.random = typeof options.random === 'function' ? options.random : Math.random
    this.setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout
    this.clearTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout
    const tuning = options.tuning ?? {}
    this.tuning = {
      baseDelayMs: positive(tuning.baseDelayMs, RECONNECT_DEFAULTS.baseDelayMs),
      maxDelayMs: positive(tuning.maxDelayMs, RECONNECT_DEFAULTS.maxDelayMs),
      maxAttempts: nonNegativeInteger(tuning.maxAttempts, RECONNECT_DEFAULTS.maxAttempts),
      jitter: ratio(tuning.jitter, RECONNECT_DEFAULTS.jitter),
    }
    if (this.tuning.maxDelayMs < this.tuning.baseDelayMs) this.tuning.maxDelayMs = this.tuning.baseDelayMs
    /** @type {Map<string, object>} alias → live entry. */
    this.entries = new Map()
    this.disposed = false
  }

  /**
   * The delay before attempt `attempt` (1-based).
   *
   * Jitter is applied DOWNWARD only, so the configured ceiling is a real
   * ceiling: a 60s cap that occasionally waits 72s is not a cap.
   *
   * @param {number} attempt - 1-based attempt number.
   * @returns {number} milliseconds to wait.
   */
  delayFor (attempt) {
    const exponent = Math.max(0, attempt - 1)
    const raw = Math.min(this.tuning.maxDelayMs, this.tuning.baseDelayMs * (2 ** exponent))
    return Math.max(1, Math.round(raw * (1 - this.random() * this.tuning.jitter)))
  }

  /**
   * A pooled connection closed without anyone asking.
   *
   * Idempotent: `close` can fire more than once for one socket, and a second
   * schedule would double the timers without making the reconnect faster.
   *
   * @param {string} alias - host alias.
   * @param {string} [reason] - one short phrase for the event log.
   * @returns {boolean} whether a background loop was started.
   */
  noteLost (alias, reason = 'the SSH connection closed') {
    const target = String(alias)
    if (this.disposed) return false
    if (this.entries.has(target)) return false
    if (!this.#wanted(target)) return false
    const entry = {
      alias: target,
      phase: 'waiting',
      attempts: 0,
      nextAt: 0,
      lastError: '',
      reason: String(reason),
      since: this.now(),
      timer: undefined,
    }
    this.entries.set(target, entry)
    this.diagnostics?.record(KINDS.disconnect, `connection lost; retrying in the background (${reason})`, { alias: target })
    this.#arm(entry)
    return true
  }

  /** Arm the timer for the entry's next attempt. */
  #arm (entry) {
    entry.attempts += 1
    entry.phase = 'waiting'
    const delay = this.delayFor(entry.attempts)
    entry.nextAt = this.now() + delay
    entry.timer = this.setTimer(() => { this.#fire(entry) }, delay)
    if (typeof entry.timer?.unref === 'function') entry.timer.unref()
  }

  /**
   * Run one attempt, then either clear the entry or re-arm it.
   *
   * The entry is looked up by identity before every state change: a manual
   * retry, a deliberate disconnect, or a fresh schedule replaces the map value,
   * and a stale in-flight attempt must not overwrite the newer state.
   */
  #fire (entry) {
    if (this.entries.get(entry.alias) !== entry) return
    entry.timer = undefined
    entry.phase = 'connecting'
    entry.nextAt = 0
    Promise.resolve()
      .then(() => this.attempt(entry.alias))
      .then(() => {
        if (this.entries.get(entry.alias) !== entry) return
        this.entries.delete(entry.alias)
        if (this.disposed) return
        this.diagnostics?.record(KINDS.reconnect, `reconnected after ${entry.attempts} attempt(s)`, { alias: entry.alias })
        try { this.onRestored?.(entry.alias) } catch { /* a restore hook must not break the retry loop */ }
      }, (error) => {
        if (this.entries.get(entry.alias) !== entry) return
        entry.lastError = error instanceof Error ? error.message : String(error)
        // A non-retryable failure (unknown alias, unreadable key, refused host
        // key) fails identically every time. Waiting cannot fix it, and an
        // attempt per minute forever would only bury the entries worth reading.
        const fatal = error?.fatal === true
        const exhausted = this.tuning.maxAttempts > 0 && entry.attempts >= this.tuning.maxAttempts
        const stillWanted = this.#wanted(entry.alias)
        // First attempts are the ones a reader can act on, then every fifth:
        // an all-afternoon outage must not flush the 40-entry ring.
        if (entry.attempts <= 3 || entry.attempts % 5 === 0 || exhausted || fatal || !stillWanted) {
          this.diagnostics?.record(KINDS.reconnect, `reconnect attempt ${entry.attempts} failed: ${entry.lastError}`, { alias: entry.alias })
        }
        if (fatal || exhausted || !stillWanted) {
          entry.phase = 'gave-up'
          this.diagnostics?.record(KINDS.degraded, fatal
            ? `background reconnect stopped: ${entry.lastError}`
            : exhausted
              ? `background reconnect stopped after ${entry.attempts} attempt(s): ${entry.lastError}`
              : 'background reconnect stopped: nothing on this host needs the connection any more', { alias: entry.alias })
          return
        }
        this.#arm(entry)
      })
  }

  /**
   * Attempt now, ignoring the backoff, on explicit user request.
   *
   * A manual retry is allowed even when `isWanted` says no: the user naming the
   * host is the strongest possible statement of intent. A failure re-arms the
   * normal loop rather than leaving the panel showing a stuck spinner.
   *
   * @param {string} alias - host alias.
   * @returns {Promise<{ok: boolean, error?: string}>} the outcome.
   */
  async retryNow (alias) {
    const target = String(alias)
    if (this.disposed) throw new Error('the reconnect scheduler is disposed')
    const previous = this.entries.get(target)
    if (previous !== undefined) {
      if (previous.timer !== undefined) this.clearTimer(previous.timer)
      this.entries.delete(target)
    }
    const entry = {
      alias: target,
      phase: 'connecting',
      attempts: 1,
      nextAt: 0,
      lastError: '',
      reason: 'manual retry',
      since: this.now(),
      timer: undefined,
    }
    try {
      await this.attempt(target)
      if (!this.disposed) {
        try { this.onRestored?.(target) } catch { /* see #fire */ }
      }
      return { ok: true }
    } catch (error) {
      entry.lastError = error instanceof Error ? error.message : String(error)
      entry.phase = this.#wanted(target) ? 'waiting' : 'gave-up'
      this.entries.set(target, entry)
      if (entry.phase === 'waiting') this.#arm(entry)
      return { ok: false, error: entry.lastError }
    }
  }

  /**
   * Somebody connected successfully. Clear a `gave-up` row so a later manual
   * or on-demand connection does not leave the panel reporting a dead host.
   *
   * @param {string} alias - host alias.
   * @returns {void}
   */
  noteConnected (alias) {
    const entry = this.entries.get(String(alias))
    if (entry !== undefined && entry.phase === 'gave-up') this.entries.delete(String(alias))
  }

  /**
   * Stop retrying one alias, because the disconnect was deliberate.
   *
   * @param {string} alias - host alias.
   * @param {string} [reason] - why the retry loop is ending.
   * @returns {boolean} whether an entry was cancelled.
   */
  cancel (alias, reason = 'cancelled') {
    const target = String(alias)
    const entry = this.entries.get(target)
    if (entry === undefined) return false
    if (entry.timer !== undefined) this.clearTimer(entry.timer)
    this.entries.delete(target)
    this.diagnostics?.record(KINDS.disconnect, `background reconnect cancelled (${reason})`, { alias: target })
    return true
  }

  /**
   * The public view of one entry, or undefined when nothing is scheduled.
   *
   * @param {string} alias - host alias.
   * @returns {object|undefined} the entry without its timer handle.
   */
  stateOf (alias) {
    return this.#publicEntry(this.entries.get(String(alias)))
  }

  /** Every live entry, oldest first. @returns {object[]} public entries. */
  list () {
    return [...this.entries.values()].map(entry => this.#publicEntry(entry))
  }

  /** Stop every loop; the scheduler is unusable afterwards. */
  dispose () {
    this.disposed = true
    for (const entry of this.entries.values()) {
      if (entry.timer !== undefined) this.clearTimer(entry.timer)
    }
    this.entries.clear()
  }

  /** `isWanted` may touch the filesystem seam; a throw must not look like "no". */
  #wanted (alias) {
    try {
      return this.isWanted(alias) === true
    } catch {
      return false
    }
  }

  /** Strip the timer handle so a caller cannot clear it by accident. */
  #publicEntry (entry) {
    if (entry === undefined) return undefined
    return {
      alias: entry.alias,
      phase: entry.phase,
      attempts: entry.attempts,
      nextAt: entry.nextAt,
      lastError: entry.lastError,
      reason: entry.reason,
      since: entry.since,
    }
  }
}
