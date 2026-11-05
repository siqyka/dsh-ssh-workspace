/**
 * Reverse verification for F-02's directory download.
 *
 * Run: node scripts/reverse-verify-download-tree.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SUITE = 'tests/transfer-smoke.mjs'

const MUTATIONS = [
  {
    name: 'a symlink in the remote tree is followed',
    file: 'lib/transfer.js',
    find: "      if (typeof attrs.isSymbolicLink === 'function' && attrs.isSymbolicLink() === true) {\n        links.push(source)\n        continue\n      }",
    replace: '      void links',
  },
  {
    name: 'nested directories are not descended into',
    file: 'lib/transfer.js',
    find: "      if (typeof attrs.isDirectory === 'function' && attrs.isDirectory() === true) {\n        await walk(source, target)\n        continue\n      }",
    replace: '      if (false) {\n        continue\n      }',
  },
  {
    name: 'the conflict policy is applied once for the whole tree',
    file: 'lib/transfer.js',
    find: "      const decision = await decideConflict({\n        policy,\n        exists: existsSync(target),",
    replace: "      const decision = await decideConflict({\n        policy: 'overwrite',\n        exists: existsSync(target),",
  },
  {
    name: 'a skipped file still counts as transferred',
    file: 'lib/transfer.js',
    find: '        skipped += 1\n        continue',
    replace: '        skipped += 1',
  },
  {
    name: 'the local directory is not created before writing',
    file: 'lib/transfer.js',
    find: '    await mkdir(to, { recursive: true })\n    const entries = await listRemote(from)',
    replace: '    const entries = await listRemote(from)',
  },
]

function run () {
  const result = spawnSync(process.execPath, [SUITE], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, DSH_CORE_ROOT: path.join(root, 'tests/.peer-stubs') },
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const match = /=== (\d+) passed, (\d+) failed/u.exec(output)
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
