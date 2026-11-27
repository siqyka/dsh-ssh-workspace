/**
 * The bounds shared by the command audit, the store, and the panel.
 *
 * Their own module because three layers need the same numbers and importing them
 * from `engine.js` would make the store (which the engine imports) depend on the
 * engine — a cycle. One constant, one meaning: the retention setting and the ring
 * can never disagree about what "200" is, or about where the ends are.
 */

/** Entries kept by default. Enough for a session's work, small enough to export. */
export const AUDIT_CAPACITY = 200

/** Smallest retention a user may choose. */
export const AUDIT_MIN_CAPACITY = 1

/** Largest retention a user may choose; the on-disk cap holds regardless. */
export const AUDIT_MAX_CAPACITY = 2000

/**
 * Validate one `{ retention }` body from the panel.
 *
 * The same reasoning as `preferencesPatchOf`: the route refuses a body the store
 * would otherwise have to guess at, so a stale or hand-written client cannot
 * silently rewrite a number the user did not choose. Unknown keys are refused
 * rather than ignored — a field this version does not know is a version skew
 * worth saying out loud.
 *
 * @param {unknown} body - the parsed JSON body.
 * @returns {{ok: true, retention: number} | {ok: false, error: string}}
 */
export function auditRetentionPatchOf (body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' }
  }
  const unknown = Object.keys(body).filter(key => key !== 'retention')
  if (unknown.length > 0) return { ok: false, error: `unknown field: ${unknown[0]}` }
  const retention = body.retention
  if (!Number.isInteger(retention)) return { ok: false, error: 'retention must be a whole number' }
  if (retention < AUDIT_MIN_CAPACITY || retention > AUDIT_MAX_CAPACITY) {
    return { ok: false, error: `retention must be between ${AUDIT_MIN_CAPACITY} and ${AUDIT_MAX_CAPACITY}` }
  }
  return { ok: true, retention }
}
