/**
 * Reverse verification for F-04's recent-host ordering.
 *
 * Run: node scripts/reverse-verify-recent-hosts.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SUITE = 'tests/recent-hosts-smoke.mjs'

const MUTATIONS = [
  {
    name: 'the recent section is read through load() (always empty)',
    file: 'lib/store.js',
    find: '      return recentOf(this.#readDocument())',
    replace: '      return recentOf(this.load())',
  },
  {
    name: 'the listing stops sorting',
    file: 'lib/hosts.js',
    find: '    rows.sort((left, right) => (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0))',
    replace: '    void rows',
  },
  {
    name: 'the cap is dropped (unbounded growth)',
    file: 'lib/store.js',
    find: '        for (const [name, value] of entries.slice(0, MAX_RECENT)) next[name] = value',
    replace: '        for (const [name, value] of entries) next[name] = value',
  },
  {
    name: 'the oldest, not the newest, survive the cap',
    file: 'lib/store.js',
    find: '        const entries = Object.entries(section).sort((left, right) => right[1] - left[1])',
    replace: '        const entries = Object.entries(section).sort((left, right) => left[1] - right[1])',
  },
  {
    name: 'the timestamp is not attached to the row',
    file: 'lib/hosts.js',
    find: '      if (typeof at === \'number\' && Number.isFinite(at)) row.lastUsedAt = at',
    replace: '      void at',
  },
  {
    name: 'a use overwrites the whole section instead of merging',
    file: 'lib/store.js',
    find: '        const section = recentOf(existing)\n        section[target] = when',
    replace: '        const section = {}\n        section[target] = when',
  },
]

function run () {
  const result = spawnSync(process.execPath, [SUITE], { cwd: root, encoding: 'utf8', timeout: 60_000 })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const match = /=== (\d+) passed, (\d+) failed ===/u.exec(output)
  return { failed: match === null ? 1 : Number(match[2]) }
}

let allGood = true
for (const mutation of MUTATIONS) {
  const file = path.join(root, mutation.file)
  const original = readFileSync(file, 'utf8')
  if (!original.includes(mutation.find)) {
    console.log(`  SKIP  ${mutation.name}\n        (pattern no longer present)`)
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
