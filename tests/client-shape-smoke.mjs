/**
 * Structural checks on the package manifest and the browser half.
 *
 * The client bundle is loaded by DSH's own front end through the
 * `window.__ModuleLoader__.load(...)` convention (no bundler), and the
 * discovery path depends entirely on package.json metadata — `dsh.client`,
 * `exports["./client"]` and `dsh.bundle.patch`. A wrong field silently keeps
 * the panel out of the boot graph, so this suite pins the shape that
 * discovery relies on. Pure Node, no dependencies: CI-safe.
 *
 * Run: node tests/client-shape-smoke.mjs
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(here, '..')

const passes = []
const failures = []
function check (name, condition, detail) {
  if (condition) {
    passes.push(name)
    console.log(`  PASS  ${name}`)
  } else {
    failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== client shape smoke ===\n')
console.log(`[package root: ${packageRoot}]`)

const pkg = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))

check('package is ESM', pkg.type === 'module', String(pkg.type))
check('main points at lib/index.js', pkg.main === 'lib/index.js', String(pkg.main))

console.log('\n[dsh.client]')
check('dsh.client is declared', typeof pkg.dsh?.client === 'object' && pkg.dsh.client !== null)
check('platform is web', pkg.dsh?.client?.platform === 'web', String(pkg.dsh?.client?.platform))
check('inject lists the client-side peers',
  Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0
    && pkg.dsh.client.inject.every(entry => typeof entry === 'string' && entry.startsWith('@deepseek-ai/')),
  JSON.stringify(pkg.dsh?.client?.inject))

console.log('\n[dsh.bundle.patch]')
check('bundle patch is declared', typeof pkg.dsh?.bundle?.patch === 'string', String(pkg.dsh?.bundle?.patch))
const patchPath = path.join(packageRoot, String(pkg.dsh?.bundle?.patch ?? ''))
check('the patch file exists', existsSync(patchPath), patchPath)
if (existsSync(patchPath)) {
  const patch = readFileSync(patchPath, 'utf8')
  check('the patch inserts the plugin row by package name',
    patch.includes(pkg.name),
    patch.slice(0, 120))
}

console.log('\n[exports]')
const clientExport = pkg.exports?.['./client']
const clientRel = typeof clientExport === 'string' ? clientExport : clientExport?.default
check('exports["./client"] resolves to a string path', typeof clientRel === 'string', JSON.stringify(clientExport))
check('the client bundle exists', typeof clientRel === 'string' && existsSync(path.join(packageRoot, clientRel)), String(clientRel))
if (typeof clientRel === 'string' && existsSync(path.join(packageRoot, clientRel))) {
  const clientPath = path.join(packageRoot, clientRel)
  check('the client bundle is non-empty', statSync(clientPath).size > 0, String(statSync(clientPath).size))
  const client = readFileSync(clientPath, 'utf8')
  check('the first line uses the __ModuleLoader__ convention', client.split('\n', 1)[0].includes('__ModuleLoader__'),
    client.split('\n', 1)[0].slice(0, 100))
  check('the bundle exports apply()', client.includes('exports.apply'), '(marker not found)')
} else {
  check('the client bundle is non-empty', false, 'bundle missing')
  check('the first line uses the __ModuleLoader__ convention', false, 'bundle missing')
  check('the bundle exports apply()', false, 'bundle missing')
}

console.log('\n[host half]')
check('lib/index.js exists', existsSync(path.join(packageRoot, 'lib/index.js')))
check('lib/client.js is excluded from the host entry points',
  pkg.exports?.['.']?.default !== './lib/client.js', JSON.stringify(pkg.exports?.['.']))

console.log('\n[publish whitelist]')
const files = pkg.files ?? []
check('lib/ ships in the tarball', files.includes('lib/'), JSON.stringify(files))
check('cordis.patch.yml ships in the tarball', files.includes('cordis.patch.yml'), JSON.stringify(files))
check('tests are not shipped in the tarball', !files.some(entry => String(entry).startsWith('tests')), JSON.stringify(files))

console.log(`\n=== ${passes.length} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
