/**
 * The route family's source text, wherever the modules currently live.
 *
 * The whole family used to be one 3,765-line `lib/routes.js`. It is now a folder:
 * `lib/routes/routes.js` is the composition point plus the descriptor table, and
 * the handlers are grouped by subject beside it. A suite that asserts "the status
 * route publishes `provenance`" is asking about the family, not about a file —
 * and hard-coding the file is what made the split look like a regression in five
 * suites at once.
 *
 * Reading the concatenation keeps the question intact. It is deliberately NOT a
 * per-file lookup: a suite that needs to know WHICH module holds something
 * should import that module, and the few that genuinely do (the ownership
 * schema, the kit's mappers) read the specific file on purpose.
 *
 * The order is stable — the composition point first, then the other modules
 * sorted by name — so a byte offset into the result is reproducible within a run.
 *
 * @module tests/support/route-source
 */

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

/** The module holding the descriptor table and the composition point. */
const COMPOSITION_POINT = 'routes.js'

/**
 * Every route module's source, joined.
 *
 * @param {string} pluginRoot - the repository root.
 * @returns {string} the concatenated source, with CRLF normalized to LF.
 */
export function routeSource (pluginRoot) {
  const directory = path.join(pluginRoot, 'lib', 'routes')
  const first = COMPOSITION_POINT
  const files = [path.join(directory, first)]
  let entries
  try {
    entries = readdirSync(directory)
  } catch (error) {
    // The composition point above is read eagerly, so a MISSING directory
    // already throws there. This catch used to hide a different case: the
    // directory exists but cannot be listed. Answering "only the composition
    // point" then silently drops the handlers, and every assertion about them
    // turns into an `indexOf === -1`.
    throw new Error(
      `route-source: cannot list ${directory} — the family's handlers would be silently dropped from the joined source (${error.code ?? error.message})`
    )
  }
  for (const name of entries.sort()) {
    if (name.endsWith('.js') && name !== first) files.push(path.join(directory, name))
  }
  // Normalized for the same reason the ownership suite normalizes: a checkout
  // with CRLF would otherwise make an `indexOf` return -1 and read as a missing
  // branch rather than a line-ending difference.
  return files.map(file => readFileSync(file, 'utf8').replace(/\r\n/gu, '\n')).join('\n')
}

/**
 * One named route module's source.
 *
 * Use this when the assertion is about that module specifically — for example
 * "the byte-moving code bounds the running total" — rather than about the
 * family.
 *
 * @param {string} pluginRoot - the repository root.
 * @param {string} name - the module name without the `.js` suffix, or `''` for
 *   the composition point `lib/routes/routes.js`.
 * @returns {string} the module source, with CRLF normalized to LF.
 */
export function routeModuleSource (pluginRoot, name) {
  const file = path.join(pluginRoot, 'lib', 'routes', name === '' ? COMPOSITION_POINT : `${name}.js`)
  return readFileSync(file, 'utf8').replace(/\r\n/gu, '\n')
}
