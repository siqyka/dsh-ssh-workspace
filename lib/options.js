/**
 * Coercion of numbers that arrive from user configuration.
 *
 * Every tuning value in this plugin comes from a JSON config file the user
 * edits by hand, so every one of them can be absent, a string, `null`, `NaN`
 * (which JSON cannot express but a JavaScript caller can), or negative. The
 * rule everywhere is the same: a value that is not usable falls back to the
 * documented default rather than being clamped into range, because clamping
 * turns a typo into a silently different policy.
 *
 * @module @shiqyka/dsh-ssh-workspace/options
 */

/**
 * A positive finite number, or the fallback.
 *
 * Delays and timeouts use this. Zero is rejected on purpose: a zero base delay
 * means "retry immediately", which for a reconnect loop is a busy-wait against
 * a server that just refused us.
 *
 * Two callers had byte-identical copies of this — the reconnect scheduler and
 * the watcher's retry policy — which is one copy too many for a rule that
 * decides how hard the plugin hammers a failing host.
 *
 * @param {unknown} value - the configured value.
 * @param {number} fallback - used when the value is not a positive finite number.
 * @returns {number} the effective value.
 */
export function positive (value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}
