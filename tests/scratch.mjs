/**
 * Safe cleanup of a remote scratch directory, for the suites that need one.
 *
 * ## Why this is a module and not two lines in each suite
 *
 * Both live suites run `rm -rf` on a path taken from `DSH_WS_TEST_DIR`, and both
 * got it slightly wrong in different ways: `live-smoke` cleaned up in a
 * `finally` but interpolated the path unquoted, while `acceptance-smoke` quoted
 * nothing and cleaned up AFTER its assertions, so a failure midway left the
 * directory behind on the host. The dangerous case is not a leftover directory
 * — it is the empty or unexpected value: `DSH_WS_TEST_DIR=""` turns
 * `rm -rf ${sandbox}` into `rm -rf`, and a path with a space turns it into two
 * arguments.
 *
 * So the deletion is gated on properties that make it provably the scratch
 * directory this plugin created:
 *
 *  - it is absolute,
 *  - it is under `/tmp` (the only place a test may stage, matching the plugin's
 *    own staging root),
 *  - its last segment carries the `dsh-ssh-workspace` prefix,
 *  - it is not `/` or `/tmp` itself.
 *
 * A value failing any of these is REFUSED with a printed reason, not
 * best-effort deleted. That is the difference between "the test cleaned up" and
 * "the test deleted something it did not create".
 *
 * @module @shiqyka/dsh-ssh-workspace/tests/scratch
 */

import { shellQuote } from '../lib/engine.js'

/** The prefix every suite's default scratch directory carries. */
const PREFIX = 'dsh-ssh-workspace'

/**
 * Whether a path is provably a test scratch directory.
 *
 * @param {unknown} value - the candidate path.
 * @returns {{ok: true} | {ok: false, reason: string}} the verdict.
 */
export function checkScratchPath (value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, reason: 'the path is empty (DSH_WS_TEST_DIR is unset or blank)' }
  }
  if (!value.startsWith('/')) {
    return { ok: false, reason: `the path is not absolute: ${JSON.stringify(value)}` }
  }
  if (value.includes('\n') || value.includes('\r')) {
    return { ok: false, reason: 'the path contains a newline' }
  }
  const normalized = value.replace(/\/+$/u, '')
  if (normalized === '' || normalized === '/tmp') {
    return { ok: false, reason: `refusing to delete ${JSON.stringify(value)}: it is not a scratch directory` }
  }
  if (!normalized.startsWith('/tmp/')) {
    return { ok: false, reason: `refusing to delete ${JSON.stringify(value)}: it is not under /tmp` }
  }
  // The prefix is checked on the FIRST segment below /tmp, not the last one:
  // a suite may stage `/tmp/dsh-ssh-workspace-test/sub`, and the segment that
  // proves ownership is the top-level directory the suite created. Checking the
  // last segment would reject every nested path, which is the normal case.
  const first = normalized.slice('/tmp/'.length).split('/')[0]
  if (!first.startsWith(PREFIX)) {
    return { ok: false, reason: `refusing to delete ${JSON.stringify(value)}: its top-level directory does not start with ${JSON.stringify(PREFIX)}` }
  }
  return { ok: true }
}

/**
 * Remove one remote scratch directory, refusing anything unproven.
 *
 * @param {import('../lib/engine.js').SshWorkspaceEngine} engine - live engine.
 * @param {string} alias - host alias.
 * @param {string} path - the scratch path from the environment.
 * @returns {Promise<{ok: boolean, reason?: string}>} the outcome.
 */
export async function removeScratch (engine, alias, path) {
  const verdict = checkScratchPath(path)
  if (!verdict.ok) return { ok: false, reason: verdict.reason }
  try {
    // Quoted, because the whole point is that the value is not trusted to be a
    // single well-formed word.
    await engine.exec(alias, `rm -rf -- ${shellQuote(path)}`)
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Resolve the scratch directory from the environment, refusing a bad value
 * BEFORE the suite creates anything.
 *
 * A suite that starts by preparing a directory it will not be able to remove is
 * worse than one that refuses to start: the leftovers accumulate on the host
 * and nobody reads the reason.
 *
 * @param {NodeJS.ProcessEnv} [env] - environment (tests inject one).
 * @param {string} [fallback] - default when the variable is unset.
 * @returns {{ok: true, path: string} | {ok: false, reason: string}} the resolved path.
 */
export function resolveScratchDir (env = process.env, fallback = '/tmp/dsh-ssh-workspace-test') {
  const raw = env.DSH_WS_TEST_DIR
  const value = typeof raw === 'string' && raw.trim() !== '' ? raw : fallback
  const verdict = checkScratchPath(value)
  if (!verdict.ok) return { ok: false, reason: verdict.reason }
  return { ok: true, path: value }
}
