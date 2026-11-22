/**
 * Source scanners: a file that is not there is an error, never an empty answer.
 *
 * Every scanner in this repository answers a question about the tree — "which
 * modules are under `lib/`", "which client chunks exist", "what does the route
 * family say". They all used to answer `[]` or `''` when they could not read the
 * directory, and that empty answer travels: it becomes a count of zero written
 * into a document, or a universal claim (`every patch has a contract`,
 * `expandPrefix is defined once`) that is satisfied by nothing at all.
 *
 * The distinction this suite pins is not "throwing is nicer". It is that the two
 * failures are different and must not be reported as one:
 *
 *  - "the tree is intact and the answer is empty" — a fact worth asserting;
 *  - "I could not look" — a defect in the check itself, which an empty answer
 *    disguises as the first one.
 *
 * A scanner that returns `[]` for a missing directory is therefore not a
 * convenience; it is a check that cannot fail, wearing the shape of one that can.
 *
 * Run: node tests/source-scanners-smoke.mjs
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const libModules = await import(pathToFileURL(path.join(pluginRoot, 'tests', 'support', 'lib-modules.mjs')).href)
const clientSource = await import(pathToFileURL(path.join(pluginRoot, 'tests', 'support', 'client-source.mjs')).href)
const routeSource = await import(pathToFileURL(path.join(pluginRoot, 'tests', 'support', 'route-source.mjs')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/**
 * Run `body`, returning the error it threw (or undefined when it returned).
 *
 * The point is to distinguish "threw" from "answered", which a try/catch around
 * an assignment cannot express without a sentinel that a valid answer could
 * also be.
 *
 * @param {() => unknown} body - the call to attempt.
 * @returns {Error|undefined} the error, when one was thrown.
 */
function thrownBy (body) {
  try {
    body()
    return undefined
  } catch (error) {
    return error
  }
}

console.log('\n=== source scanners smoke ===')

console.log('\n[1] every scanner refuses to answer for a directory it cannot list')
{
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'scanners-'))
  try {
    const gone = path.join(sandbox, 'not-here')

    const walks = [
      ['modulePaths', () => libModules.modulePaths(gone)],
      ['topLevelModulePaths', () => libModules.topLevelModulePaths(gone)],
      ['clientChunkNames', () => clientSource.clientChunkNames(gone)],
      ['clientKernelBlock', () => clientSource.clientKernelBlock(gone)],
      ['routeSource', () => routeSource.routeSource(gone)]
    ]
    for (const [name, call] of walks) {
      const error = thrownBy(call)
      check(`${name} throws instead of answering empty`, error !== undefined,
        error === undefined ? 'it returned' : undefined)
      // An error that does not name what it could not read sends the reader to
      // the caller's assertion instead of to the missing file.
      check(`${name} names the path it could not read`,
        error !== undefined && error.message.includes('not-here'), String(error?.message))
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

console.log('\n[2] a readable tree still answers, so the throw is not unconditional')
{
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'scanners-'))
  try {
    mkdirSync(path.join(sandbox, 'nested'))
    writeFileSync(path.join(sandbox, 'top.js'), 'export const a = 1\n')
    writeFileSync(path.join(sandbox, 'nested', 'deep.js'), 'export const b = 2\n')

    const walked = libModules.modulePaths(sandbox)
    check('a walk over a real tree returns its modules', walked.includes('nested/deep.js'), JSON.stringify(walked))
    check('the top-level listing is the top level only',
      JSON.stringify(libModules.topLevelModulePaths(sandbox)) === JSON.stringify(['top.js']),
      JSON.stringify(libModules.topLevelModulePaths(sandbox)))
    // An EMPTY directory is a legitimate answer — the distinction being drawn is
    // "nothing is there" versus "I could not look", not "empty is always wrong".
    mkdirSync(path.join(sandbox, 'empty'))
    check('an empty directory answers with an empty list, not an error',
      Array.isArray(libModules.modulePaths(path.join(sandbox, 'empty'))),
      'threw')
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

console.log('\n[3] no reader is left that turns a missing file into an empty string')
{
  // The generator lost its `readOrEmpty` on purpose: it read the document it
  // splices into, and a missing document then travelled as `''` until a second
  // check reported "does not exist" — the same conclusion, reached by way of a
  // value that reads as "the document is empty".
  const generator = readFileSync(path.join(pluginRoot, 'scripts', 'doc-numbers.mjs'), 'utf8')
  // Declared, not merely mentioned: the file's comment explains what was removed
  // and why, and a prose mention is not a reader that can answer ''.
  const declared = /(?:function\s+readOrEmpty|const\s+readOrEmpty\b)/u.exec(generator)
  check('the generator declares no readOrEmpty', declared === null, String(declared?.[0]))
  check('nothing in the generator calls readOrEmpty', !/\breadOrEmpty\s*\(/u.test(generator),
    (/\breadOrEmpty\s*\([^\n]*/u.exec(generator) ?? [])[0])
  check('the generator reads its document with a named error',
    /cannot read \$\{path\.relative\(root, TARGET\)\}/u.test(generator),
    'the document read does not name the file it wanted')

  // `lint` walks three roots; a published tarball has `lib/` only. Skipping an
  // absent root is correct, but it has to be SAID — "all N modules parse" over a
  // tree with no `tests/` is a different claim from the same line over a
  // complete one.
  const lint = readFileSync(path.join(pluginRoot, 'scripts', 'lint.mjs'), 'utf8')
  check('lint reports the roots it skipped', /skipped \$\{absent\.length\} directory root/u.test(lint),
    'lint still skips absent roots silently')
  check('lint refuses a root that exists but cannot be read',
    /cannot list \$\{directory\}/u.test(lint), 'lint has no unreadable-root error')
}

console.log('\n[4] a package.json entry that is missing is a failure, not a skip')
{
  // `client-shape` parses every JavaScript entry `package.json` names. It used to
  // `continue` past an absent one, which made the claim "the shipped files parse"
  // a claim about whichever subset happened to be on disk — and the entry most
  // likely to be absent is the one that moved, whose syntax error nobody sees.
  const suite = readFileSync(path.join(pluginRoot, 'tests', 'client-shape-smoke.mjs'), 'utf8')
  check('client-shape asserts every named entry exists',
    /check\(`\$\{target\} exists`, false/u.test(suite),
    'a missing entry is still skipped silently')
  check('client-shape asserts there is at least one entry',
    /names at least one JavaScript entry/u.test(suite), 'no assertion on the entry list')
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
if (failures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}
