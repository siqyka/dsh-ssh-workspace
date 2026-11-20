/**
 * The route family's source text, wherever the modules currently live.
 *
 * `lib/routes.js` used to hold the whole family: the fence, the helpers and all
 * 33 descriptors in one 3,765-line file. It is now the composition point plus
 * the helpers that belong to one route, with the descriptors grouped by subject
 * under `lib/routes/`. A suite that asserts "the status route publishes
 * `provenance`" is asking about the family, not about a file — and hard-coding
 * the file is what made the split look like a regression in five suites at once.
 *
 * Reading the concatenation keeps the question intact. It is deliberately NOT a
 * per-file lookup: a suite that needs to know WHICH module holds something
 * should import that module, and the few that genuinely do (the ownership
 * schema, the kit's mappers) read the specific file on purpose.
 *
 * The order is stable — the composition point first, then the submodules sorted
 * by name — so a byte offset into the result is reproducible within a run.
 *
 * @module tests/support/route-source
 */

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

/**
 * Every route module's source, joined.
 *
 * @param {string} pluginRoot - the repository root.
 * @returns {string} the concatenated source, with CRLF normalized to LF.
 */
export function routeSource (pluginRoot) {
  const files = [path.join(pluginRoot, 'lib', 'routes.js')]
  let entries = []
  try {
    entries = readdirSync(path.join(pluginRoot, 'lib', 'routes'))
  } catch {
    // No route directory yet: the family is still in one file.
  }
  for (const name of entries.sort()) {
    if (name.endsWith('.js')) files.push(path.join(pluginRoot, 'lib', 'routes', name))
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
 *   the composition point `lib/routes.js`.
 * @returns {string} the module source, with CRLF normalized to LF.
 */
export function routeModuleSource (pluginRoot, name) {
  const file = name === ''
    ? path.join(pluginRoot, 'lib', 'routes.js')
    : path.join(pluginRoot, 'lib', 'routes', `${name}.js`)
  return readFileSync(file, 'utf8').replace(/\r\n/gu, '\n')
}
