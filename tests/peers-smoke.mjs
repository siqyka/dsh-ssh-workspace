/**
 * Dependency declarations, and the resolution those declarations feed.
 *
 * Declaring the Host packages as `peerDependencies` is NOT enough, and this is
 * the trap this suite exists for: npm 7+ auto-installs a declared peer it cannot
 * find. Without `peerDependenciesMeta`, installing this package pulls in a
 * private copy of the whole Host, and the plugin then loads a second Cordis and
 * a second `dsh-fs` instead of the running Host's: two service registries, split
 * instances — the exact failure the peers exist to prevent.
 *
 * `peerDependenciesMeta.<name>.optional` suppresses that: the install then
 * contains this plugin, the ssh2 runtime tree, and no `@deepseek-ai` at all. The
 * declaration is pinned here so a future edit cannot quietly restore the
 * auto-install.
 *
 * The peers are also read by the Host, not just by the package manager: `app-boot`
 * uses `peerDependencies["@deepseek-ai/dsh"]` as the version gate when a manifest
 * has no top-level `engines.dsh`, and `readPeerNames`/`routeLinked` uses this
 * manifest's peer list to decide whether a linked plugin's Host imports route to
 * the running Host. Deleting the peers to "clean up" would remove both.
 *
 * The suite also pins the counterpart decision: `ssh2` is this plugin's OWN
 * dependency, declared in `dependencies` and left to the package manager that
 * installs this package. Nothing here checks whether the user has it — under
 * npm, pnpm and yarn the install supplies it, and when it is genuinely missing
 * the resolution error says so. There is deliberately no runtime installer.
 *
 * Run: node tests/peers-smoke.mjs
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  PASS  ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== peers smoke ===\n')

const { requirePeer } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'core', 'peers.js')).href)

// ------------------------------------------------- the peer declaration itself
console.log('[host packages are peers, and optional so npm does not install them]')

const manifest = JSON.parse(readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'))
const peers = Object.keys(manifest.peerDependencies ?? {})
const optional = manifest.peerDependenciesMeta ?? {}

check(
  'the manifest declares the Host packages as peers',
  peers.length > 0 && peers.includes('@deepseek-ai/dsh-fs') && peers.includes('@deepseek-ai/dsh-tools'),
  JSON.stringify(peers)
)
check(
  'no Host package is declared as a plain dependency',
  peers.every(peer => (manifest.dependencies ?? {})[peer] === undefined),
  JSON.stringify(manifest.dependencies)
)
// The one that actually stops npm from unpacking the Host tree.
check(
  'every Host peer is marked optional, so npm does not auto-install it',
  peers.every(peer => optional[peer]?.optional === true),
  JSON.stringify(optional)
)
// A meta entry for a package that is not a peer is dead weight and usually the
// sign of a rename that was only half applied.
check(
  'the meta table names nothing that is not a peer',
  Object.keys(optional).every(name => peers.includes(name)),
  JSON.stringify(Object.keys(optional))
)
// `ssh2` is the plugin's own dependency and must stay one: the package manager
// that installs this package supplies it. Moving it to peers would leave nothing
// responsible for it, and moving it out of `dependencies` would hand the job to
// a runtime installer this plugin deliberately does not have.
check(
  'ssh2 stays a real dependency, not a peer',
  (manifest.dependencies ?? {}).ssh2 !== undefined && !peers.includes('ssh2'),
  JSON.stringify({ dependencies: manifest.dependencies, peers })
)

// ------------------------------------------------------- real resolution
console.log('\n[real resolution]')

// Production shape: the dependency is installed in this package's own tree.
// The constructor is not called here, so what matters is that the module object
// arrives with the seam engine.js imports.
const ssh2 = requirePeer('ssh2')
check('requirePeer("ssh2") resolves in a normal checkout', typeof ssh2.Client === 'function')
check('requirePeer memoizes a successful load', requirePeer('ssh2') === ssh2)

const missing = (() => {
  try {
    requirePeer('@deepseek-ai/definitely-not-installed')
    return null
  } catch (error) {
    return error
  }
})()
check('a missing Host peer throws', missing instanceof Error)
check(
  'the missing-peer message names the specifier and lists where it looked',
  missing !== null &&
    /definitely-not-installed/.test(missing.message) &&
    /node_modules/.test(missing.message),
  missing === null ? 'did not throw' : missing.message
)
// The failure has two very different owners, and the message is the only place
// a user learns which one to chase: a Host peer comes from the running DSH
// installation, while `ssh2` comes from whatever installed THIS plugin. Calling
// `ssh2` a peer points the reader at `peerDependencies`, where nothing is wrong
// and nothing can be fixed.
check(
  'the missing-peer message calls the package a peer, and points at the Host',
  missing !== null &&
    /DSH peer package/.test(missing.message) &&
    /running DSH host/i.test(missing.message),
  missing === null ? 'did not throw' : missing.message
)
// A message that reads as broken English is a message people skim past; the
// article has to agree with the noun it introduces.
check(
  'the missing-peer message reads as a sentence',
  missing !== null &&
    /cannot resolve the DSH peer package "/.test(missing.message) &&
    !/\bthe the\b/i.test(missing.message),
  missing === null ? 'did not throw' : missing.message
)

const missingDependency = (() => {
  try {
    requirePeer('@deepseek-ai/definitely-not-installed', { kind: 'dependency' })
    return null
  } catch (error) {
    return error
  }
})()
check('a missing own dependency throws', missingDependency instanceof Error)
check(
  'the missing-dependency message does NOT call the package a peer',
  missingDependency !== null && !/peer package/i.test(missingDependency.message),
  missingDependency === null ? 'did not throw' : missingDependency.message
)
check(
  'the missing-dependency message names the install command that fixes it',
  missingDependency !== null && /npm (ci|install)/.test(missingDependency.message),
  missingDependency === null ? 'did not throw' : missingDependency.message
)
// The role must reach the real caller, not just the helper: engine.js loads
// `ssh2` through this module, so a missing ssh2 has to read as a dependency.
const engineSource = readFileSync(path.join(pluginRoot, 'lib', 'engine', 'engine.js'), 'utf8')
check(
  'engine.js loads ssh2 as a dependency, so a missing tree is not blamed on the Host',
  /requirePeer\(\s*['"]ssh2['"]\s*,\s*\{\s*kind:\s*['"]dependency['"]/.test(engineSource),
  engineSource.match(/requirePeer\([^)]*\)/)?.[0] ?? 'no requirePeer call found'
)

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
process.exit(failures === 0 ? 0 : 1)
