/**
 * Reverse verification for the blank-menu panel boundary.
 *
 * Each mutation re-introduces one half of the bug (or one plausible "simplification"
 * of the fix) and asserts that the suites go RED. A mutation that stays green
 * means the assertion it targets does not actually test the behaviour it claims
 * to test — which is the only failure mode of a structural suite that matters.
 *
 * The code under test is split across two files: the scope readers live in
 * `client.kernel.js`, `openForBlank` stays in `client.js`. Each mutation names
 * its own target, and every touched file is restored from a byte-identical copy
 * and hash-compared at the end, so a crashing run cannot leave one mutated.
 *
 * Run: node scripts/reverse-verify-blank-menu.mjs
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const KERNEL_PATH = path.join(root, 'lib', 'client', 'client.kernel.js')
const BUNDLE_PATH = path.join(root, 'lib', 'client', 'client.js')

const SUITES = ['tree-blank-menu', 'client-shape']

/** SHA-256 of a file, for proving the restore. */
function hashOf (file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** The backup path for one target file. */
function backupOf (file) {
  return `${file}.reverse-backup`
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

const MUTATIONS = [
  {
    label: 'page gate removed: widen the search back to the document',
    file: KERNEL_PATH,
    from: '      const page = target.closest(OS_PAGE_SELECTOR)\n      if (page === null) return null',
    to: '      const page = target.closest(OS_PAGE_SELECTOR) ?? document.body\n      if (page === null) return null',
  },
  {
    label: "button looked up from the pointer's container instead of the page",
    file: KERNEL_PATH,
    from: "      const button = page.querySelector('[data-sshwsp-dir]')",
    to: "      const button = (target.closest('[data-files-navigator], [data-files-state]') ?? page).querySelector('[data-sshwsp-dir]')",
  },
  {
    label: 'containment check dropped: a page may adopt a tree beside it',
    file: KERNEL_PATH,
    from: '      if (tree === null || !page.contains(tree)) return null',
    to: '      if (tree === null) return null',
  },
  {
    label: 'empty alias accepted',
    file: KERNEL_PATH,
    from: "      if (alias === null || alias === '' || dir === null || dir === '') return null",
    to: "      if (alias === null || dir === null || dir === '') return null",
  },
  {
    label: 'openForBlank bypasses the helper and searches the document',
    file: BUNDLE_PATH,
    from: '        const scope = blankMenuScopeOf(target)\n        if (scope === null) return false',
    to: "        const button = document.querySelector('[data-sshwsp-dir]')\n        if (button === null) return false\n        const scope = blankMenuScopeOf(target) ?? { alias: button.getAttribute('data-sshwsp-alias'), dir: button.getAttribute('data-sshwsp-dir'), root: null }",
  },
]

/**
 * Put every target back from its backup, on any exit path.
 *
 * This script is often run with its output piped into `head`/`Select-Object`, so
 * it can be killed by EPIPE mid-mutation; a terminal Ctrl-C does the same. An
 * uncaught exception still emits 'exit', but a signal does not — each is hooked
 * separately. The restore is idempotent.
 */
let restored = false
const targets = [...new Set(MUTATIONS.map(m => m.file))]
const restoreNow = () => {
  if (restored) return
  restored = true
  for (const file of targets) {
    const backup = backupOf(file)
    if (!existsSync(backup)) continue
    try {
      writeFileSync(file, readFileSync(backup))
      unlinkSync(backup)
    } catch (error) {
      console.error(`could not restore ${path.relative(root, file)}: ${error.message}`)
      console.error(`the original is still at ${backup} — copy it back by hand`)
    }
  }
}
process.on('exit', restoreNow)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(signal, () => {
    restoreNow()
    process.exit(130)
  })
}

console.log('\n=== reverse verification: blank-menu panel boundary ===\n')

for (const file of targets) {
  if (!existsSync(file)) {
    console.error(`${path.relative(root, file)} is missing`)
    process.exit(2)
  }
}

// A previous run that died between the write and its restore leaves the file
// carrying a mutation AND the backup on disk. The backup is always the
// pre-mutation original, so putting it back is the only safe first move:
// silently starting a new run on top of a mutated file would make every "RED"
// below meaningless (and ship the mutation if nobody looked).
for (const file of targets) {
  const backup = backupOf(file)
  if (existsSync(backup)) {
    writeFileSync(file, readFileSync(backup))
    unlinkSync(backup)
    console.log(`recovered ${path.relative(root, file)} from a previous run's backup`)
  }
}

const before = new Map()
for (const file of targets) {
  before.set(file, hashOf(file))
  writeFileSync(backupOf(file), readFileSync(file))
}

/** Apply one mutation to ITS file, run both suites, restore, report. */
function mutate (mutation) {
  const { label, from, to, file } = mutation
  const original = readFileSync(file, 'utf8')
  if (!original.includes(from)) {
    return { label, applied: false, reason: `anchor not found in ${path.relative(root, file)}` }
  }
  writeFileSync(file, original.replace(from, to))
  try {
    const suites = SUITES.map(name => ({ name, ...runSuite(name) }))
    return {
      label,
      applied: true,
      red: suites.some(suite => suite.red),
      observations: suites.map(suite => ({ suite: suite.name, failed: suite.failed, names: suite.names })),
    }
  } finally {
    writeFileSync(file, original)
  }
}

const results = []
try {
  for (const mutation of MUTATIONS) {
    const outcome = mutate(mutation)
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

const intact = targets.every(file => hashOf(file) === before.get(file))
console.log(`\nrestored: ${intact ? 'byte-identical' : 'DIFFERENT — investigate'}`)
if (!intact) process.exit(2)

const skipped = results.filter(entry => entry.applied !== true)
if (skipped.length > 0) {
  console.log('a mutation anchor was missing — the check it targets no longer exists')
  process.exit(1)
}

const green = results.filter(entry => entry.red !== true)
console.log(`${results.length - green.length} confirmed red, ${green.length} NOT red\n`)
if (green.length > 0) {
  for (const entry of green) console.log(`  NOT RED: ${entry.label}`)
  process.exit(1)
}
