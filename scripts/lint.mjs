/**
 * Syntax-check every module this package ships or runs.
 *
 * `node --check` only parses; it never executes, imports or resolves anything.
 * That makes it the one check that is safe to run against a module whose peers
 * are not installed — which is exactly the situation in a bare checkout and in
 * CI, where the `@deepseek-ai/*` tree is deliberately absent.
 *
 * Scope is deliberate:
 *  - `lib/` and `scripts/` are shipped or run by users;
 *  - `tests/` is not shipped, but a syntax error there turns a suite into a
 *    crash in CI, and the crash is easy to mistake for a real failure.
 *
 * The CI workflow used to inline a `for f in lib/*.js` loop. It now calls this
 * script so the file list lives in one place instead of three (ci.yml,
 * release.yml and docs/development.md all describe the same command).
 *
 * Run: node scripts/lint.mjs
 */

import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Directories whose `.js` / `.mjs` files must parse. */
const DIRECTORIES = ['lib', 'scripts', 'tests']

/**
 * Every module file under the given directories, in a stable order.
 *
 * Recursive on purpose: `lib/routes/` holds route modules and `tests/support/`
 * holds the shared doubles, and a top-level-only walk silently skipped eleven
 * of the latter. A syntax error in a file this never looked at turns into a
 * crash at runtime, or into a suite that fails for a reason that looks like
 * anything but a typo.
 *
 * @returns {string[]} paths relative to the repository root.
 */
function moduleFiles () {
  const files = []
  /** @param {string} directory - relative to the root. */
  const walk = (directory) => {
    let entries
    try {
      entries = readdirSync(path.join(root, directory), { withFileTypes: true })
    } catch {
      // A missing directory is not a failure: a published tarball ships `lib/`
      // only, and `npm run lint` there should still pass rather than explode.
      return
    }
    for (const entry of entries) {
      const relative = `${directory}/${entry.name}`
      // `node_modules` can appear under `tests/` when a fixture installs a
      // package; its files are not ours to check.
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(relative)
        continue
      }
      if (!entry.isFile()) continue
      if (!/\.(?:js|mjs)$/u.test(entry.name)) continue
      files.push(relative)
    }
  }
  for (const directory of DIRECTORIES) walk(directory)
  return files.sort()
}

const files = moduleFiles()
if (files.length === 0) {
  console.error('lint: no module files found — the directory list is probably wrong')
  process.exit(1)
}

const broken = []
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' })
  } catch (error) {
    // `--check` writes the syntax error (with its line and column) to stderr.
    const detail = String(error.stderr ?? error.message).trim()
    broken.push({ file, detail })
  }
}

if (broken.length > 0) {
  for (const { file, detail } of broken) {
    console.log(`FAIL ${file}`)
    for (const line of detail.split(/\r?\n/u)) console.log(`  ${line}`)
  }
  console.log(`\n${broken.length} of ${files.length} module(s) failed to parse`)
  process.exit(1)
}

console.log(`all ${files.length} modules parse (${DIRECTORIES.join(', ')})`)
