/**
 * Conflict policy for transfers: what to do when the destination exists.
 *
 * ## Why an explicit policy instead of "just overwrite"
 *
 * Overwriting is the right default for the case transfers exist for — pushing a
 * rebuilt artifact, pulling a log again — and the wrong one for the case that
 * hurts: a pull into a directory that already holds a hand-edited copy, or an
 * upload onto a file someone changed on the host ten minutes ago. The
 * difference is intent, and only the caller has it, so it has to be a parameter
 * rather than a guess.
 *
 * ## The four answers, and why "skip" is not an error
 *
 *  - `overwrite` — replace. The default.
 *  - `skip` — leave the existing file alone and report it. NOT an error: a tree
 *    upload over a mostly-identical tree would otherwise fail on the first
 *    existing file, which is why people stop using tree upload.
 *  - `rename` — write beside the existing file with a numbered suffix. For the
 *    pull-a-log case where neither copy should be lost.
 *  - `refuse` — fail before writing anything. For a script that must not touch
 *    an existing file.
 *
 * ## Where it is decided
 *
 * Here, as a pure function over "does the destination exist", so the policy can
 * be executed in a test. The transfer code then only has two branches (proceed
 * or stop), and the interesting logic is not tangled with SFTP calls.
 *
 * @module @shiqyka/dsh-ssh-workspace/conflict-policy
 */

/** The accepted policies, in the order the panel offers them. */
export const CONFLICT_POLICIES = Object.freeze(['overwrite', 'skip', 'rename', 'refuse'])

/** The default, matching what every file-transfer tool does when not told. */
export const DEFAULT_CONFLICT_POLICY = 'overwrite'

/**
 * Normalize a caller-supplied policy.
 *
 * An unrecognised value falls back to the default rather than failing the
 * transfer: a typo in an optional knob must not make a working upload break, and
 * the result reports which policy was actually applied so the caller can see it
 * was not theirs. (A policy that silently changed the DESTINATION would be a
 * different matter — that is why `rename` never collapses into `overwrite`.)
 *
 * @param {unknown} value - the candidate.
 * @returns {string} one of {@link CONFLICT_POLICIES}.
 */
export function normalizeConflictPolicy (value) {
  const text = String(value ?? '').trim().toLowerCase()
  return CONFLICT_POLICIES.includes(text) ? text : DEFAULT_CONFLICT_POLICY
}

/**
 * Decide what a transfer should do about an existing destination.
 *
 * @param {object} options - the decision inputs.
 * @param {string} options.policy - normalized policy.
 * @param {boolean} options.exists - whether the destination already exists.
 * @param {string} [options.destination] - for the message.
 * @param {(path: string) => Promise<boolean>} [options.existsAt] - availability
 *   probe used by `rename` to find a free name.
 * @returns {Promise<{action: 'proceed'|'skip'|'refuse', path?: string, note?: string}>} the decision.
 */
export async function decideConflict (options) {
  const policy = normalizeConflictPolicy(options.policy)
  if (options.exists !== true) return { action: 'proceed' }
  if (policy === 'skip') {
    return {
      action: 'skip',
      note: `the destination already exists and the conflict policy is "skip": ${options.destination ?? ''}`.trim(),
    }
  }
  if (policy === 'refuse') {
    return {
      action: 'refuse',
      note: `the destination already exists and the conflict policy is "refuse": ${options.destination ?? ''}`.trim(),
    }
  }
  if (policy === 'rename') {
    const free = await freeName(options.destination ?? '', options.existsAt)
    return {
      action: 'proceed',
      path: free,
      note: `the destination already existed, so this copy was written to ${free}`,
    }
  }
  return { action: 'proceed' }
}

/**
 * The first free `name.N` beside an existing path.
 *
 * `name.1`, `name.2`, … with the number before the extension so the result still
 * opens as the same kind of file. A bounded probe (1000 tries) because an
 * unbounded one against a genuinely broken `existsAt` would hang the transfer.
 *
 * @param {string} destination - the taken path.
 * @param {(path: string) => Promise<boolean>} [existsAt] - availability probe.
 * @returns {Promise<string>} a path nothing occupies.
 */
export async function freeName (destination, existsAt) {
  const target = String(destination ?? '')
  if (typeof existsAt !== 'function') {
    // No probe: fall back to a timestamped name, which is far more likely free
    // than a counter we cannot check.
    const dot = target.lastIndexOf('.')
    const stamp = Date.now().toString(36)
    return dot > target.lastIndexOf('/') && dot > target.lastIndexOf('\\')
      ? `${target.slice(0, dot)}.${stamp}${target.slice(dot)}`
      : `${target}.${stamp}`
  }
  const dot = target.lastIndexOf('.')
  const slash = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'))
  const stem = dot > slash + 1 ? target.slice(0, dot) : target
  const suffix = dot > slash + 1 ? target.slice(dot) : ''
  for (let index = 1; index <= 1000; index += 1) {
    const candidate = `${stem}.${index}${suffix}`
    if ((await existsAt(candidate)) !== true) return candidate
  }
  // A thousand collisions means the probe is lying; make a name that cannot be.
  return `${stem}.${Date.now().toString(36)}${suffix}`
}
