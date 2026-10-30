/**
 * Upstream takeover contract: every patch declares what it attaches to.
 *
 * The failure this guards against is silent by nature. An upgrade renames
 * `ctx.shell.execute`, the patch still installs, nothing throws, and every
 * remote command quietly runs on the local machine instead. The patch's own
 * self-retiring probe cannot catch it: that probe answers "has upstream fixed
 * the defect I work around?", not "is the shape I attach to still there?".
 *
 * So each patch declares its Host-side dependencies in
 * `lib/upstream-contract.js`, and this suite asserts the declaration against
 * the module source in BOTH directions:
 *
 *  - a symbol the patch uses but never declared is an undeclared dependency;
 *  - a symbol the patch declares but no longer uses is a stale declaration.
 *
 * Neither direction is provable in general (a patch could reach a symbol
 * dynamically), which is why the suite asserts what is checkable: the install
 * entry point exists and is exported, the declared symbols appear in the
 * module, and the contract table covers every `patch-*.js` on disk.
 *
 * Run: node tests/upstream-contract-smoke.mjs
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { CONTRACTS, contractFor, missingFiles } = await import(
  pathToFileURL(path.join(pluginRoot, 'lib', 'upstream-contract.js')).href
)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const libFiles = readdirSync(path.join(pluginRoot, 'lib')).filter(name => name.endsWith('.js'))
const patchFiles = libFiles.filter(name => name.startsWith('patch-'))

/** The source of one lib module. */
function sourceOf (file) {
  return readFileSync(path.join(pluginRoot, 'lib', file), 'utf8')
}

console.log('\n[1] every patch on disk is declared, and vice versa')
{
  check('the contract table is not empty', CONTRACTS.length > 0, String(CONTRACTS.length))
  const declaredFiles = CONTRACTS.map(contract => contract.file)
  const undeclared = patchFiles.filter(file => !declaredFiles.includes(file))
  check('every patch-*.js has a contract', undeclared.length === 0, undeclared.join(', ') || 'none missing')
  const stale = missingFiles(libFiles)
  check('no contract names a file that does not exist', stale.length === 0, stale.join(', ') || 'none stale')
  check('every patch file is a patch module the table knows',
    declaredFiles.every(file => patchFiles.includes(file)),
    declaredFiles.filter(file => !patchFiles.includes(file)).join(', ') || 'all declared')
}

console.log('\n[2] each declared install entry point really exists')
for (const contract of CONTRACTS) {
  const source = sourceOf(contract.file)
  const exported = new RegExp(`export (?:async )?function ${contract.installs}\\b`, 'u').test(source)
  check(`${contract.id}: ${contract.installs} is exported`, exported, contract.file)
  check(`${contract.id}: the module documents its purpose`,
    source.length > 500 && /^\/\*\*/u.test(source), `${source.length} bytes`)
}

console.log('\n[3] declared symbols are actually used by the module')
for (const contract of CONTRACTS) {
  const source = sourceOf(contract.file)
  const absent = contract.symbols.filter(symbol => !source.includes(symbol))
  check(`${contract.id}: every declared symbol appears in the module`,
    absent.length === 0, absent.join(', ') || 'all present')
}

console.log('\n[4] a workaround declares how it retires; a capability does not pretend to')
for (const contract of CONTRACTS) {
  const isWorkaround = contract.id.startsWith('UPSTREAM-')
  if (isWorkaround) {
    check(`${contract.id}: declares the verdict that means "delete me"`,
      typeof contract.retire === 'string' && contract.retire !== '', String(contract.retire))
  } else {
    check(`${contract.id}: does not claim a retirement story`,
      contract.retire === undefined, String(contract.retire))
  }
  check(`${contract.id}: states what breaks if the contract is violated`,
    typeof contract.summary === 'string' && contract.summary.length > 30, String(contract.summary))
}

console.log('\n[5] the projection workaround is wired to a real probe')
{
  const source = sourceOf('patch-projection.js')
  check('the workaround declares a stable id',
    /export const WORKAROUND_ID = 'UPSTREAM-/u.test(source), 'no WORKAROUND_ID')
  check('the workaround can report "already fixed"',
    source.includes("'fixed'"), 'no fixed verdict')
  check('the workaround can report "cannot judge"',
    source.includes('unprobeable'), 'no unprobeable verdict')
  // The six-state verdict is what makes an upgrade legible; a boolean would
  // collapse "fixed" and "cannot tell" into the same answer.
  const verdicts = ['already', 'broken', 'disabled', 'fixed', 'pending', 'unprobeable']
  const absent = verdicts.filter(verdict => !source.includes(`'${verdict}'`))
  check('all six probe verdicts are present', absent.length === 0, absent.join(', ') || 'all present')
}

console.log('\n[6] installation order is declared, not incidental')
{
  const index = sourceOf('index.js')
  const positions = CONTRACTS
    .map(contract => ({ id: contract.id, at: index.indexOf(contract.installs) }))
  check('every patch install call appears in lib/index.js',
    positions.every(entry => entry.at >= 0),
    positions.filter(entry => entry.at < 0).map(entry => entry.id).join(', ') || 'all present')
  const ordered = positions.filter(entry => entry.at >= 0).sort((left, right) => left.at - right.at)
  check('the fs patch is installed before the shell patch (shell workdir resolves through fs)',
    ordered.findIndex(entry => entry.id === 'PATCH-fs') < ordered.findIndex(entry => entry.id === 'PATCH-shell'),
    ordered.map(entry => entry.id).join(' → '))
  // The real order, asserted as a relation rather than a guess: the fs half
  // must exist before anything resolves a workdir through it, and the terminal
  // patch is the last seam to be taken over.
  check('the fs patch is installed before the subprocess patch',
    ordered.findIndex(entry => entry.id === 'PATCH-fs') < ordered.findIndex(entry => entry.id === 'PATCH-subprocess'),
    ordered.map(entry => entry.id).join(' → '))
  // The terminal patch is the last of the SEAM patches. The projection
  // workaround is installed earlier and is not a seam, so "last overall" would
  // assert something the code does not do.
  const seams = ordered.filter(entry => entry.id.startsWith('PATCH-'))
  check('the terminal patch is the last seam installed',
    seams.at(-1)?.id === 'PATCH-terminal', seams.map(entry => entry.id).join(' → '))
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
if (failures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}
