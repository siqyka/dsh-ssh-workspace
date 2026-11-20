/**
 * Validation shared by the two forwarding directions.
 *
 * A local forward binds a port on THIS machine and dials the remote target; a
 * reverse forward makes the REMOTE host listen and dials back here. The two
 * modules are otherwise independent, but they accept the same four fields
 * (`localPort`, `remotePort`, `localHost`, `remoteHost`) with the same rules,
 * and they had grown byte-identical copies of the two validators below. One
 * copy means "port 0 is legal here but not there" can only happen once.
 *
 * @module @shiqyka/dsh-ssh-workspace/forward-common
 */

/**
 * Validate a port number.
 *
 * Port 0 is legal only when the caller says so, because the two directions
 * disagree about what it means: a local forward on port 0 asks the OS to pick,
 * while a reverse forward on port 0 asks the SSH server to pick. Both are
 * useful; neither is a typo to be silently corrected, so the flag is explicit
 * rather than defaulted.
 *
 * @param {unknown} value - the candidate.
 * @param {string} label - field name for the error.
 * @param {object} [options] - validation options.
 * @param {boolean} [options.allowZero] - whether 0 (peer-assigned) is legal.
 * @returns {number} the port.
 * @throws {Error} when out of range or not an integer.
 */
export function requirePort (value, label, options = {}) {
  const min = options.allowZero === true ? 0 : 1
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > 65535) {
    throw new Error(`${label} must be an integer between ${min} and 65535`)
  }
  return value
}

/**
 * A host literal, falling back when blank.
 *
 * Blank and whitespace-only both mean "not given": a form that submits an empty
 * input sends `''`, not `undefined`, and treating that as a host would make the
 * forward bind to something the user never typed.
 *
 * @param {unknown} value - the candidate.
 * @param {string} fallback - used when the candidate is blank.
 * @returns {string} the trimmed host, or the fallback.
 */
export function normalizedHost (value, fallback) {
  if (typeof value !== 'string' || value.trim() === '') return fallback
  return value.trim()
}
