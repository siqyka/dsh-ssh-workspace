/**
 * Every module under `lib/`, wherever it lives.
 *
 * Three suites scan `lib/` as a whole and ask a question about "the plugin's
 * source": does each promised capability's tool get named somewhere, is a patch
 * module declared in the contract table, is `expandPrefix` defined in exactly
 * one file. All three used a flat `readdirSync(lib)`, which was correct while
 * `lib/` held only top-level files.
 *
 * It stopped being correct the moment `lib/routes/` and `lib/client/` appeared:
 * a flat listing silently drops those modules, and a silent drop in a check
 * that only asserts "at least one match" turns into a check that cannot fail.
 * The figures drift the same way — `scripts/doc-numbers.mjs` reported 79
 * modules when a flat listing said 63.
 *
 * @module tests/support/lib-modules
 */

import { readdirSync } from 'node:fs'
import path from 'node:path'

/**
 * Every `.js` module under a directory, as paths relative to it, depth-first and
 * sorted.
 *
 * Relative paths (not bare names) are returned because two directories can hold
 * a same-named file, and a caller comparing against a contract table wants to
 * see which one matched.
 *
 * @param {string} directory - the directory to walk, usually `<root>/lib`.
 * @returns {string[]} relative module paths, POSIX separators.
 */
export function modulePaths (directory) {
  const found = []
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      for (const nested of modulePaths(full)) found.push(`${entry.name}/${nested}`)
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      found.push(entry.name)
    }
  }
  return found.sort()
}

/**
 * The same list, kept as bare file names for the top level only.
 *
 * Some checks are genuinely about the top level — `lib/patch-*.js` is a naming
 * convention that lives there and nowhere else. This makes that intent explicit
 * rather than an accident of `readdirSync`.
 *
 * @param {string} directory - the directory to list.
 * @returns {string[]} the top-level module file names, sorted.
 */
export function topLevelModulePaths (directory) {
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
    .map(entry => entry.name)
    .sort()
}

export default { modulePaths, topLevelModulePaths }
