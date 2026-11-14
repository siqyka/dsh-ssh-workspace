/**
 * Reverse verification for the blank-menu panel boundary.
 *
 * Each mutation re-introduces one half of the bug (or one plausible "simplification"
 * of the fix) and asserts that the suites go RED. A mutation that stays green
 * means the assertion it targets does not actually test the behaviour it claims
 * to test — which is the only failure mode of a structural suite that matters.
 *
 * The file is restored from a byte-identical copy after every mutation and the
 * copy's hash is compared at the end, so a crashing run cannot leave the shipped
 * bundle mutated.
 *
 * Run: node scripts/reverse-verify-blank-menu.mjs
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const clientPath = path.join(root, 'lib', 'client.js')
const backupPath = path.join(root, 'lib', 'client.js.reverse-backup')

const SUITES = ['tree-blank-menu', 'client-shape']

/** SHA-256 of a file, for proving the restore. */
function hashOf (file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** Run one suite; return `{ passed, failed, red }`. */
function runSuite (name) {
  const result = spawnSync(process.execPath, [path.join(root, 'tests', `${name}-smoke.mjs`)], {
    cwd: root,
    encoding: 'utf8',
  })
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const match = /=== (\d+) passed, (\d+) failed ===/u.exec(text)
  const failures = (text.match(/^\s+FAIL\s/gmu) ?? []).length
  return {
    red: result.status !== 0,
    passed: match === null ? -1 : Number(match[1]),
    failed: match === null ? failures : Number(match[2]),
    names: [...text.matchAll(/^\s+FAIL\s+(.+)$/gmu)].map(entry => entry[1].trim()),
  }
}

/** Apply one mutation, run both suites, restore, report. */
function mutate (label, from, to) {
  const original = readFileSync(clientPath, 'utf8')
  if (!original.includes(from)) {
    return { label, applied: false, reason: 'anchor not found in lib/client.js' }
  }
  writeFileSync(clientPath, original.replace(from, to))
  try {
    const suites = SUITES.map(name => ({ name, ...runSuite(name) }))
    const observations = suites.map(suite => ({
      suite: suite.name,
      failed: suite.failed,
      names: suite.names,
    }))
    return { label, applied: true, red: suites.some(suite => suite.red), observations }
  } finally {
    writeFileSync(clientPath, original)
  }
}

console.log('\n=== reverse verification: blank-menu panel boundary ===\n')

if (!existsSync(clientPath)) {
  console.error('lib/client.js is missing')
  process.exit(2)
}

// A previous run that died between `writeFileSync(clientPath, mutated)` and its
// restore leaves the bundle carrying a mutation AND the backup on disk. The
// backup is always the pre-mutation original, so putting it back is the only
// safe first move: silently starting a new run on top of a mutated bundle would
// make every "RED" below meaningless (and ship the mutation if nobody looked).
if (existsSync(backupPath)) {
  writeFileSync(clientPath, readFileSync(backupPath))
  console.log('recovered lib/client.js from a previous run\'s backup')
}

copyFileSync(clientPath, backupPath)
const before = hashOf(clientPath)

/**
 * Restore on any exit path, including the ones `try/finally` cannot see.
 *
 * This script is often run with its output piped into `head`/`Select-Object`,
 * so it can be killed by EPIPE mid-mutation; a terminal Ctrl-C does the same.
 * An uncaught exception still emits 'exit', but a signal does not — each is
 * therefore hooked separately. The restore is idempotent and cheap.
 */
let restored = false
const restoreNow = () => {
  if (restored || !existsSync(backupPath)) return
  restored = true
  try {
    writeFileSync(clientPath, readFileSync(backupPath))
    unlinkSync(backupPath)
  } catch (error) {
    console.error(`could not restore lib/client.js: ${error.message}`)
    console.error(`the original is still at ${backupPath} — copy it back by hand`)
  }
}
process.on('exit', restoreNow)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(signal, () => {
    restoreNow()
    process.exit(130)
  })
}

const MUTATIONS = [
  {
    label: 'page gate removed: widen the search back to the document',
    from: '      const page = target.closest(OS_PAGE_SELECTOR)\n      if (page === null) return null',
    to: '      const page = target.closest(OS_PAGE_SELECTOR) ?? document.body\n      if (page === null) return null',
  },
  {
    label: 'button looked up from the pointer\'s container instead of the page',
    from: "      const button = page.querySelector('[data-sshwsp-dir]')",
    to: "      const button = (target.closest('[data-files-navigator], [data-files-state]') ?? page).querySelector('[data-sshwsp-dir]')",
  },
  {
    label: 'containment check dropped: a page may adopt a tree beside it',
    from: '      if (tree === null || !page.contains(tree)) return null',
    to: '      if (tree === null) return null',
  },
  {
    label: 'empty alias accepted',
    from: "      if (alias === null || alias === '' || dir === null || dir === '') return null",
    to: "      if (alias === null || dir === null || dir === '') return null",
  },
  {
    label: 'openForBlank bypasses the helper and searches the document',
    from: '        const scope = blankMenuScopeOf(target)\n        if (scope === null) return false',
    to: "        const button = document.querySelector('[data-sshwsp-dir]')\n        if (button === null) return false\n        const scope = blankMenuScopeOf(target) ?? { alias: button.getAttribute('data-sshwsp-alias'), dir: button.getAttribute('data-sshwsp-dir'), root: null }",
  },
]

const results = []
try {
  for (const mutation of MUTATIONS) {
    const outcome = mutate(mutation.label, mutation.from, mutation.to)
    results.push(outcome)
    if (!outcome.applied) {
      console.log(`  SKIP  ${mutation.label}`)
      console.log(`        ${outcome.reason}`)
      continue
    }
    console.log(`  ${outcome.red ? 'RED  ' : 'GREEN'} ${mutation.label}`)
    for (const observation of outcome.observations) {
      console.log(`        ${observation.suite}: ${observation.failed} failed`)
      for (const name of observation.names.slice(0, 6)) console.log(`          - ${name}`)
    }
  }
} finally {
  restoreNow()
}

const after = hashOf(clientPath)
console.log(`\nrestored: ${before === after ? 'byte-identical' : 'DIFFERENT — investigate'}`)
if (before !== after) process.exit(2)

if (results.some(entry => entry.applied !== true)) {
  console.log('a mutation anchor was missing — the check it targets no longer exists')
  process.exit(1)
}

const green = results.filter(entry => entry.applied && entry.red !== true)
const skipped = results.filter(entry => entry.applied !== true)
console.log(`${results.length - green.length - skipped.length} confirmed red, ${green.length} NOT red, ${skipped.length} skipped\n`)
if (green.length > 0) {
  for (const entry of green) console.log(`  NOT RED: ${entry.label}`)
  process.exit(1)
}
if (skipped.length > 0) process.exit(1)
