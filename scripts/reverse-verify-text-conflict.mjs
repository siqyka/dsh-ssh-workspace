/**
 * Reverse verification for the "only the token moved" save path.
 *
 * Each mutation must turn `tests/file-editor-smoke.mjs` red. This is an audit
 * action, not a CI step: it rewrites the source in place and restores it.
 *
 * Run: node scripts/reverse-verify-text-conflict.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SUITE = 'tests/file-editor-smoke.mjs'
const EDITOR = path.join('lib', 'client', 'client.editor.js')

const MUTATIONS = [
  {
    name: 'the digest comparison always says "not the same" (the conflict nobody wants)',
    file: EDITOR,
    find: "      return now !== '' && now === then",
    replace: '      return false',
  },
  {
    name: 'an absent token counts as agreement (a failed read resolves a conflict)',
    file: EDITOR,
    find: "      return now !== '' && now === then",
    replace: '      return now === then',
  },
  {
    name: 'the retry is dropped, so a moved token is always a conflict',
    file: EDITOR,
    find: '            if (!movedTokenOnly(current, tokens.revision)) break',
    replace: '            if (true) break',
  },
  {
    name: 'the retry loops forever instead of stopping after one',
    file: EDITOR,
    find: '            if (reply.status !== 409 || attempt > 1) break',
    replace: '            if (reply.status !== 409) break',
  },
  {
    name: 'the retry forgets to adopt the new token (saves against the stale one)',
    file: EDITOR,
    find: '            tokens = expectedTokens({\n              version: String(current.version ?? \'\'),',
    replace: '            void expectedTokens({\n              version: String(current.version ?? \'\'),',
  },
  {
    name: 'the helper is no longer exported (the driven assertions cannot see it)',
    file: EDITOR,
    find: '    exports.movedTokenOnly = movedTokenOnly\n',
    replace: '',
  },
]

function run () {
  const result = spawnSync(process.execPath, [SUITE], {
    cwd: root,
    env: { ...process.env },
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
