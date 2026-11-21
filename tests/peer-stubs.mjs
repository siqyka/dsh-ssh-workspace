/**
 * Minimal stand-ins for the DSH peer packages this plugin borrows.
 *
 * The plugin is a Cordis plugin, so `@deepseek-ai/dsh-fs`, `@deepseek-ai/dsh-tools`
 * and `ssh2` are supplied by the running host. A bare source checkout has none of
 * them, which used to mean every suite that imports the route family or `remote-fs.js`
 * SKIPPED — and a skipped suite cannot fail, so route-level regressions shipped
 * green once already.
 *
 * These stubs are deliberately tiny and shape-only: they provide the small
 * surface the plugin actually calls (`FsError`, `FsTargetKey`, `FsVersion`,
 * `defineTool`, `ssh2.Client`) so the *plugin's* logic runs for real. Nothing
 * here emulates an SSH server or a filesystem backend; tests that need those
 * still skip on `DSH_WS_TEST_ALIAS`.
 *
 * Used by suites through `DSH_CORE_ROOT`; see `tests/stubs/README.md`.
 */

import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)

/** Write a CommonJS module at `file` exporting `source`. */
function writeCjs (file, source) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${source}\n`, 'utf8')
}

/** A package.json that marks a directory as a CommonJS package. */
function writePackage (dir, name) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0-stub', main: 'index.cjs' }, null, 2), 'utf8')
}

/**
 * Build a stub peer root and return it.
 *
 * The returned path is a `node_modules` directory, not its parent: both
 * `peers.js` and the suites resolve with `createRequire(join(root, 'noop.cjs'))`,
 * and `require` only ever searches a `node_modules` directory, so the packages
 * must live directly under the returned path.
 *
 * Idempotent: re-running overwrites the stubs, so a stale stub cannot survive a
 * change to this file.
 *
 * @param {string} base - directory to populate; `node_modules` is created inside it.
 * @returns {string} the node_modules path, suitable for DSH_CORE_ROOT.
 */
export function installPeerStubs (base) {
  const root = path.join(base, 'node_modules')
  mkdirSync(root, { recursive: true })

  // --- @deepseek-ai/dsh-fs ------------------------------------------------
  //
  // `FsError` must carry a `code` and support `instanceof`, because remote-fs.js
  // re-raises existing FsErrors untouched and wraps everything else. The target
  // key and version helpers are branded strings in the real package; a tagged
  // string is enough to keep the plugin's comparisons and round-trips honest.
  const fsDir = path.join(root, '@deepseek-ai', 'dsh-fs')
  writePackage(fsDir, '@deepseek-ai/dsh-fs')
  writeCjs(path.join(fsDir, 'index.cjs'), `
class FsError extends Error {
  constructor (message, code, options) {
    super(message, options)
    this.name = 'FsError'
    this.code = typeof code === 'string' && code !== '' ? code : 'FS_IO_ERROR'
  }
}
function FsTargetKey (value) { return String(value) }
function FsVersion (value) { return String(value) }
class FileSystem {
  constructor (ctx, name) { this.ctx = ctx; this.name = name }
}
module.exports = { FsError, FsTargetKey, FsVersion, FileSystem, __dshStub: true }
`)

  // --- @deepseek-ai/dsh-tools --------------------------------------------
  //
  // `defineTool` is a schema carrier in the real package: it validates the
  // definition's shape and freezes it. Returning the definition unchanged keeps
  // the plugin's own registration path exercised without re-implementing the
  // host's validation.
  //
  // `__dshStub` is not decoration. The detector (tests/support/peer-mode.mjs)
  // reads it to decide whether a suite may claim the host's behaviour, and a
  // stub that forgot to mark itself would be reported as REAL — the one failure
  // mode that makes a stub *worse* than nothing.
  const toolsDir = path.join(root, '@deepseek-ai', 'dsh-tools')
  writePackage(toolsDir, '@deepseek-ai/dsh-tools')
  writeCjs(path.join(toolsDir, 'index.cjs'), `
function defineTool (definition) {
  if (definition === null || typeof definition !== 'object') throw new Error('defineTool: a definition object is required')
  if (typeof definition.name !== 'string' || definition.name === '') throw new Error('defineTool: name is required')
  if (typeof definition.execute !== 'function') throw new Error('defineTool: execute must be a function')
  return definition
}
module.exports = { defineTool, __dshStub: true }
`)

  // --- @deepseek-ai/cordis ------------------------------------------------
  //
  // Present so the root is uniformly stubbed: every host peer the plugin
  // declares resolves here, and each one says so. Leaving it out made the
  // detector report "cordis=absent, dsh-tools=real" for the same generated root,
  // which reads like a half-installed tree rather than a deliberate stand-in.
  //
  // Both exports throw on use, like the ssh2 stub: the suites that need real
  // Cordis are testing service ordering and cannot be satisfied by a stand-in,
  // so the honest failure is a loud one at the call site.
  const cordisDir = path.join(root, '@deepseek-ai', 'cordis')
  writePackage(cordisDir, '@deepseek-ai/cordis')
  writeCjs(path.join(cordisDir, 'index.cjs'), `
const refusal = (what) => { throw new Error('cordis stub: ' + what + ' needs the real @deepseek-ai/cordis; point DSH_CORE_ROOT at an assembled DSH tree') }
class Context { constructor () { refusal('new Context()') } }
class Service { constructor () { refusal('new Service()') } }
module.exports = {
  Context,
  Service,
  Fiber: class Fiber {},
  __dshStub: true
}
`)

  // --- ssh2 ---------------------------------------------------------------
  //
  // Only `Client` is imported at module load. Its constructor is never called by
  // the suites that use this root (they drive a connection double instead), so a
  // class that throws on construction is the honest stub: it proves the plugin
  // resolves the real seam without pretending to speak SSH.
  const ssh2Dir = path.join(root, 'ssh2')
  writePackage(ssh2Dir, 'ssh2')
  writeCjs(path.join(ssh2Dir, 'index.cjs'), `
class Client {
  constructor () { throw new Error('ssh2 stub: this root cannot open real SSH connections; configure DSH_WS_TEST_ALIAS for live suites') }
}
module.exports = { Client }
`)

  return root
}

/** True when this module is executed directly rather than imported. */
const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1'))

if (invokedDirectly) {
  const root = process.argv[2] ?? path.join(process.cwd(), 'tests', '.peer-stubs')
  installPeerStubs(root)
  console.log(root)
}

export { require }
