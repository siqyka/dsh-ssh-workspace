/**
 * Reverse verification for F-01's watcher recovery.
 *
 * Six mutations, each of which must turn the suite red. This is an audit
 * action, not a CI step: it rewrites source files in place and restores them.
 *
 * Run: node scripts/reverse-verify-watch-recovery.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SUITE = 'tests/watch-recovery-smoke.mjs'
const CORE = path.join(root, 'tests/.peer-stubs')

const MUTATIONS = [
  {
    name: 'the healthy-connection guard is removed (everything is retried)',
    file: 'lib/watch-recovery.js',
    find: "  if (state?.connected === true) {\n    return { retry: false, reason: 'the connection is healthy, so this is not a transport accident' }\n  }",
    replace: '',
  },
  {
    name: 'the "nothing is repairing it" guard is removed',
    file: 'lib/watch-recovery.js',
    find: "  if (!recovering) {\n    return { retry: false, reason: 'nothing is trying to bring the connection back' }\n  }",
    replace: '',
  },
  {
    name: 'a gave-up loop counts as repairing',
    file: 'lib/watch-recovery.js',
    find: "loop.phase !== 'gave-up'",
    replace: 'true',
  },
  {
    name: 'the backoff is a fixed delay (no growth)',
    file: 'lib/watch-recovery.js',
    find: 'return Math.min(base * 2 ** exponent, ceiling)',
    replace: 'return base',
  },
  {
    name: 'the poller reports instead of retrying',
    file: 'lib/remote-fs.js',
    find: '      if (verdict.retry !== true) {\n        // A real failure on a healthy connection',
    replace: '      if (true) {\n        // A real failure on a healthy connection',
  },
  {
    name: 'the recovery rescan is dropped (silent freeze)',
    file: 'lib/remote-fs.js',
    find: '    if (failures > 0) {\n      // Observations resumed.',
    replace: '    if (false) {\n      // Observations resumed.',
  },
]

function run () {
  const result = spawnSync(process.execPath, [SUITE], {
    cwd: root,
    env: { ...process.env, DSH_CORE_ROOT: CORE },
    encoding: 'utf8',
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const match = /=== (\d+) passed, (\d+) failed ===/u.exec(output)
  return { failed: match === null ? 1 : Number(match[2]), output }
}

let allGood = true
for (const mutation of MUTATIONS) {
  const file = path.join(root, mutation.file)
  const original = readFileSync(file, 'utf8')
  if (!original.includes(mutation.find)) {
    console.log(`  SKIP  ${mutation.name}\n        (pattern not present — the mutation no longer applies)`)
    allGood = false
    continue
  }
  writeFileSync(file, original.replace(mutation.find, mutation.replace))
  try {
    const { failed } = run()
    if (failed > 0) {
      console.log(`  RED   ${mutation.name} → ${failed} failed`)
    } else {
      allGood = false
      console.log(`  GREEN ${mutation.name} → THE SUITE DID NOT NOTICE`)
    }
  } finally {
    writeFileSync(file, original)
  }
}

const restored = run()
console.log(`\nrestored: ${restored.failed === 0 ? 'suite green again' : 'SUITE STILL RED'}`)
if (restored.failed !== 0 || !allGood) process.exit(1)
