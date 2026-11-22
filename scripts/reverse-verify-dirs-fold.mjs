/**
 * Reverse verification for the folded directory listing.
 *
 * Each mutation must turn `tests/routes-smoke.mjs` red. This is an audit action,
 * not a CI step: it rewrites the source in place and restores it.
 *
 * Run: node scripts/reverse-verify-dirs-fold.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SUITE = 'tests/routes-smoke.mjs'
const ENTRIES = path.join('lib', 'routes', 'entries.js')

const MUTATIONS = [
  {
    name: 'the symlink rule is lost (a link to the parent folds for ever)',
    find: '  found=$(find "$dir" -mindepth 1 -maxdepth 1 -type d 2>/dev/null)',
    replace: '  found=$(find "$dir" -mindepth 1 -maxdepth 1 2>/dev/null)',
  },
  {
    // The cap lives in a constant the command is assembled from, so the
    // mutation has to move the constant rather than the quoted line.
    name: 'the depth cap grows until a long chain stalls the listing',
    find: 'export const LS_FOLD_MAX_DEPTH = 16',
    replace: 'export const LS_FOLD_MAX_DEPTH = 1600',
  },
  {
    name: 'the folded row is dropped (an empty listing for a chain)',
    find: "    '  printf \\'%s/\\\\n\\' \"${prefix%/}\"',",
    replace: "    '  :',",
  },
  {
    name: 'the listing echoes the end of the chain instead of the root',
    find: 'export LS_DIR="$root"',
    replace: 'export LS_DIR="$dir"',
  },
  {
    name: 'a level with two directories folds anyway (a choice disappears)',
    find: "    '  [ \"$(printf \\'%s\\\\n\\' \"$found\" | wc -l)\" -eq 1 ] || break',",
    replace: "    '  [ -n \"$found\" ] || break',",
  },
]

function run () {
  const result = spawnSync(process.execPath, [SUITE], {
    cwd: root,
    env: { ...process.env, DSH_CORE_ROOT: process.env.DSH_CORE_ROOT ?? path.join(root, 'tests/.peer-stubs') },
    encoding: 'utf8',
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const match = /=== (\d+) passed, (\d+) failed ===/u.exec(output)
  return { failed: match === null ? 1 : Number(match[2]), output }
}

let allGood = true
for (const mutation of MUTATIONS) {
  const file = path.join(root, ENTRIES)
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
