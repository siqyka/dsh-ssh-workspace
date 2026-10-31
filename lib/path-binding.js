/**
 * Observe whether `node:path.isAbsolute` is READ through the module binding.
 *
 * One caller: the UPSTREAM-1 retirement probe (patch-projection.js). "The Host's
 * schema accepts an `ssh://` value" has two very different causes, and only one
 * of them means the workaround is obsolete:
 *
 * - the schema reads the binding at call time, so it sees this plugin's patched
 *   predicate → upstream fixed it, delete the workaround;
 * - the schema captured the predicate as a VALUE when it was constructed, and
 *   what it captured happens to BE this plugin's patched predicate → the defect
 *   is intact, and the workaround is still load-bearing.
 *
 * The second case is the production order in this deployment (the bridge is
 * installed from this plugin's own `apply()`, and the `workingDirectory` unit is
 * built when its service is first touched), so an accept-check alone reports
 * "fixed" on a Host that still needs the patch — and then prints "delete it".
 *
 * Only a CALL proves the read. {@link observePathBindingReads} therefore swaps
 * in a pass-through that delegates to the live predicate — same answer, so the
 * probe's own accept-check is unaffected — and merely records that it ran. A
 * schema holding a captured function never touches the property.
 *
 * Kept dependency-free and separate from fs-shim.js on purpose: importing that
 * module pulls in remote-fs.js and the peer resolution behind it, which a probe
 * must not need.
 *
 * @module @shiqyka/dsh-ssh-workspace/path-binding
 */

/**
 * Process-wide bridge state, so a reload rebinds instead of double-patching.
 *
 * Shared with fs-shim.js, which installs the state under this key.
 */
export const BRIDGE = Symbol.for('dsh-ssh-workspace.fs-shim')

/**
 * Run `run` with `node:path.isAbsolute` instrumented, reporting whether it was
 * read through the module binding during the call.
 *
 * @param {() => void} run - the probe body; must be synchronous.
 * @returns {boolean | undefined} true when the binding was read, false when a
 *   bridge exists and it was not, undefined when no bridge is installed (in
 *   which case nothing was ever patched, so an acceptance cannot be its doing).
 */
export function observePathBindingReads (run) {
  const state = globalThis[BRIDGE]
  const patches = state === undefined ? [] : (Array.isArray(state.pathPatches) ? state.pathPatches : [])
  let observed = false
  const restore = []
  for (const entry of patches) {
    const surface = entry.surface
    if (surface === undefined || surface === null) continue
    const current = surface.isAbsolute
    if (typeof current !== 'function') continue
    restore.push({ surface, current })
    surface.isAbsolute = function isAbsolute (candidate) {
      observed = true
      return current(candidate)
    }
  }
  // No observable patch: still run the probe (its answer is the caller's whole
  // point) and report `undefined` — "nobody patched anything here", which is a
  // different fact from "it accepted without reading the binding".
  if (restore.length === 0) {
    run()
    return undefined
  }
  try {
    if (typeof state.republish === 'function') state.republish()
    run()
  } finally {
    for (const { surface, current } of restore) surface.isAbsolute = current
    if (typeof state.republish === 'function') state.republish()
  }
  return observed
}

/**
 * Whether an accepting parser accepts because it reads the binding.
 *
 * @param {object} schema - a parser that already accepts the remote probe.
 * @param {string} remoteProbe - the value to parse.
 * @returns {boolean} true when the acceptance provably came through the binding.
 */
export function acceptsByReadingBinding (schema, remoteProbe) {
  let accepted = false
  const observed = observePathBindingReads(() => {
    try {
      accepted = schema.parse(remoteProbe) === remoteProbe
    } catch {
      accepted = false
    }
  })
  // No bridge to observe: nothing was patched in this process, so the
  // acceptance cannot be an artifact of our own patch.
  if (observed === undefined) return accepted
  return accepted && observed
}

/**
 * Run `run` with this bridge's `isAbsolute` patches REMOVED.
 *
 * Answers a different question than {@link observePathBindingReads}: not "did
 * it read the binding?" but "would it still accept if we had never patched
 * anything?". A schema with its own scheme rule (an upstream that fixed the bug
 * by spelling `ssh://` out instead of reading the binding) answers yes; one that
 * merely captured our patched predicate answers no.
 *
 * @param {() => void} run - the probe body; must be synchronous.
 * @returns {void}
 */
export function withOriginalPathBindings (run) {
  const state = globalThis[BRIDGE]
  const patches = state === undefined ? [] : (Array.isArray(state.pathPatches) ? state.pathPatches : [])
  const restore = []
  for (const entry of patches) {
    const surface = entry.surface
    if (surface === undefined || surface === null) continue
    if (typeof entry.isAbsolute !== 'function') continue
    restore.push({ surface, patched: surface.isAbsolute })
    surface.isAbsolute = entry.isAbsolute
  }
  try {
    if (typeof state?.republish === 'function') state.republish()
    run()
  } finally {
    for (const { surface, patched } of restore) surface.isAbsolute = patched
    if (typeof state?.republish === 'function') state.republish()
  }
}

/**
 * Whether an accepting parser would still accept with this bridge removed.
 *
 * @param {object} schema - a parser that already accepts the remote probe.
 * @param {string} remoteProbe - the value to parse.
 * @returns {boolean} true when the acceptance does not depend on our patch.
 */
export function acceptsWithoutOurPatch (schema, remoteProbe) {
  let accepted = false
  withOriginalPathBindings(() => {
    try {
      accepted = schema.parse(remoteProbe) === remoteProbe
    } catch {
      accepted = false
    }
  })
  return accepted
}
