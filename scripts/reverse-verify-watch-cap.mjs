/**
 * Reverse verification for the watcher concurrency cap.
 *
 * Each mutation must turn `tests/watch-smoke.mjs` red. This is an audit
 * action, not a CI step: it rewrites the source in place and restores it.
 *
 * Run: node scripts/reverse-verify-watch-cap.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SUITE = 'tests/watch-smoke.mjs'
const WATCH = path.join('lib', 'fs', 'remote-watch.js')
const CORE = path.join(root, 'tests/.peer-stubs')

const MUTATIONS = [
  {
    name: 'the cap is removed (sixty-four becomes unbounded)',
    file: WATCH,
    find: '    if (entry === undefined && this.watches.size >= WATCH_MAX_ENTRIES) {',
    replace: '    if (false) {',
  },
  {
    name: 'the cap is off by one (65 targets get through)',
    file: WATCH,
    find: 'this.watches.size >= WATCH_MAX_ENTRIES',
    replace: 'this.watches.size > WATCH_MAX_ENTRIES',
  },
  {
    name: 'over the cap is silently swallowed instead of refused',
    file: WATCH,
    find: '      throw tooManyWatches()',
    replace: '      return async () => {}',
  },
  {
    name: 'the refusal answers the wrong code (looks like a broken host)',
    file: WATCH,
    find: "    'FS_TOO_MANY',",
    replace: "    'FS_IO_ERROR',",
  },
  {
    name: 'sharing is capped too (a second consumer of one target is refused)',
    file: WATCH,
    find: '    if (entry === undefined && this.watches.size >= WATCH_MAX_ENTRIES) {',
    replace: '    if (this.watches.size >= WATCH_MAX_ENTRIES) {',
  },
  {
    name: 'a close no longer frees its slot (the cap becomes a budget)',
    file: WATCH,
    find: '      if (this.watches.get(entry.key) === entry) this.watches.delete(entry.key)',
    replace: '      if (false) this.watches.delete(entry.key)',
  },
]

function run () {
  const result = spawnSync(process.execPath, [SUITE], {
    cwd: root,
    env: { ...process.env, DSH_CORE_ROOT: process.env.DSH_CORE_ROOT ?? CORE },
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
