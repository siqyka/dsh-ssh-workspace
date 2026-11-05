/**
 * Reverse verification for F-01's shell half (start-directory recovery).
 *
 * Five mutations, each of which must turn `shell-smoke` red.
 * Audit action, not a CI step: it rewrites source in place and restores it.
 *
 * Run: node scripts/reverse-verify-shell-cwd.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SUITE = 'tests/shell-smoke.mjs'

const MUTATIONS = [
  {
    name: 'the remembered start directory is ignored on reopen',
    file: 'lib/shell.js',
    find: 'const cwd = requested ?? remembered?.cwd',
    replace: 'const cwd = requested',
  },
  {
    name: 'a reopen is reported as an ordinary first open',
    file: 'lib/shell.js',
    find: 'reopened: reused !== true && (start?.reopens ?? 0) > 0,',
    replace: 'reopened: false,',
  },
  {
    name: 'an explicit close keeps the start directory',
    file: 'lib/shell.js',
    find: '      this.starts.delete(key)\n',
    replace: '',
  },
  {
    name: 'the remembered start overrides an explicit cwd',
    file: 'lib/shell.js',
    find: 'const cwd = requested ?? remembered?.cwd',
    replace: 'const cwd = remembered?.cwd ?? requested',
  },
  {
    name: 'the list calls the start directory "cwd"',
    file: 'lib/shell.js',
    find: '        startedIn: start?.cwd,',
    replace: '        cwd: start?.cwd,',
  },
]

function run () {
  const result = spawnSync(process.execPath, [SUITE], { cwd: root, encoding: 'utf8' })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const match = /=== (\d+) passed, (\d+) failed ===/u.exec(output)
  return { failed: match === null ? 1 : Number(match[2]), output }
}

let allGood = true
for (const mutation of MUTATIONS) {
  const file = path.join(root, mutation.file)
  const original = readFileSync(file, 'utf8')
  if (!original.includes(mutation.find)) {
    console.log(`  SKIP  ${mutation.name}\n        (pattern not present any more)`)
    allGood = false
    continue
  }
  writeFileSync(file, original.replace(mutation.find, mutation.replace))
  try {
    const { failed } = run()
    if (failed > 0) console.log(`  RED   ${mutation.name} → ${failed} failed`)
    else { allGood = false; console.log(`  GREEN ${mutation.name} → THE SUITE DID NOT NOTICE`) }
  } finally {
    writeFileSync(file, original)
  }
}

const restored = run()
console.log(`\nrestored: ${restored.failed === 0 ? 'suite green again' : 'SUITE STILL RED'}`)
if (restored.failed !== 0 || !allGood) process.exit(1)
