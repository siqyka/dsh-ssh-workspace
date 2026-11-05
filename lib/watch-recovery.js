/**
 * When a change watcher should retry instead of reporting a failure.
 *
 * ## The defect this exists for
 *
 * The remote watcher polled, and a failed poll was reported to the consumer as
 * a fatal error — which the seam's contract defines as "I am finished, close
 * me". That is right for a permission denial on a healthy connection, and
 * catastrophically wrong for a dropped SSH link: the poll fails *because the
 * transport is gone*, the watcher stops, and nothing ever starts it again.
 *
 * The visible symptom is a file tree that silently freezes. Worse, it is the
 * shape the host cannot diagnose: `dsh-client-ui-sidebar-files` reacts to a
 * watch failure by marking the row and never retrying, and it swallows the
 * `watch-unsupported` code outright — so the tree simply stops refreshing with
 * no message at all. "My edits stopped showing up" is the report, and by then
 * the cause (a Wi-Fi blip an hour ago) is long out of the diagnostics ring.
 *
 * ## The rule
 *
 * Retry only when BOTH are true:
 *
 *  - the connection is not currently up, so the failure is plausibly the
 *    transport's; and
 *  - something is actively trying to bring it back (a reconnect loop that has
 *    not given up).
 *
 * Everything else is a real failure and must reach the consumer:
 *
 *  - a healthy connection that fails to stat/read is a logic error — the path
 *    was deleted, permissions changed — and retrying would hide it forever;
 *  - a dead connection with no loop running (nothing mounted wants it, the loop
 *    was cancelled, or it gave up) will never heal on its own, and pretending
 *    to watch would be the silent freeze this module exists to remove.
 *
 * @module @shiqyka/dsh-ssh-workspace/watch-recovery
 */

/** Default retry policy for a watcher whose poll hit a dead transport. */
export const WATCH_RECOVERY_DEFAULTS = Object.freeze({
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
})

/** A positive finite number from the options, falling back otherwise. */
function positive (value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Decide whether one failed observation is worth retrying.
 *
 * Kept pure and separate from the watcher so the decision can be executed in a
 * test rather than inferred from source text: the interesting cases are the two
 * "no" branches, and a suite that greps for `if (connected)` proves nothing
 * about which way the branch actually got taken.
 *
 * @param {object} state - what the engine says right now.
 * @param {boolean} state.connected - the alias has a live, unbroken record.
 * @param {object|undefined} state.loop - the reconnect scheduler's entry, if any.
 * @returns {{retry: boolean, reason: string}} the verdict and why.
 */
export function watchFailureVerdict (state) {
  const loop = state?.loop
  // `gave-up` is a terminal phase: the loop is still in the map so the panel can
  // say why it stopped, but nothing is being attempted any more.
  const recovering = loop !== undefined && loop !== null && loop.phase !== 'gave-up'
  if (state?.connected === true) {
    return { retry: false, reason: 'the connection is healthy, so this is not a transport accident' }
  }
  if (!recovering) {
    return { retry: false, reason: 'nothing is trying to bring the connection back' }
  }
  return { retry: true, reason: 'the connection is down and the background reconnect loop is working on it' }
}

/**
 * The delay before retrying observation `failure` (1-based).
 *
 * Exponential with a ceiling, and deliberately WITHOUT jitter: watches of many
 * paths on one host are all woken by the same reconnect, and spreading them
 * would smear one recovery into a burst of listings anyway — they share the
 * connection, so their polls queue regardless.
 *
 * @param {number} failure - 1-based count of consecutive failures.
 * @param {object} [tuning] - policy overrides.
 * @param {number} [tuning.baseDelayMs] - first delay.
 * @param {number} [tuning.maxDelayMs] - ceiling.
 * @returns {number} milliseconds to wait.
 */
export function watchRecoveryDelay (failure, tuning = {}) {
  const base = positive(tuning.baseDelayMs, WATCH_RECOVERY_DEFAULTS.baseDelayMs)
  const cap = positive(tuning.maxDelayMs, WATCH_RECOVERY_DEFAULTS.maxDelayMs)
  const ceiling = Math.max(base, cap)
  const exponent = Math.min(Math.max(Math.trunc(failure) - 1, 0), 20)
  return Math.min(base * 2 ** exponent, ceiling)
}
