/**
 * Reverse verification for the draft-discard guard.
 *
 * Each mutation must turn `tests/file-editor-smoke.mjs` red. This is an audit
 * action, not a CI step: it rewrites the source in place and restores it.
 *
 * Run: node scripts/reverse-verify-editor-unload.mjs
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
    name: 'the guard is removed (a refresh drops the draft silently)',
    file: EDITOR,
    find: "        window.addEventListener('beforeunload', guard)",
    replace: '        void guard',
  },
  {
    name: 'the guard stays bound after the buffer is saved (blocks a safe refresh)',
    file: EDITOR,
    find: '        if (dirty !== true) return undefined',
    replace: '        if (false) return undefined',
  },
  {
    name: 'the guard is never unbound (a closed editor keeps blocking)',
    file: EDITOR,
    find: "        return () => window.removeEventListener('beforeunload', guard)",
    replace: '        return undefined',
  },
  {
    name: 'only the modern suppression is set (older browsers keep the page)',
    file: EDITOR,
    find: '          event.returnValue = \'\'',
    replace: '          void 0',
  },
  {
    name: 'only the legacy suppression is set',
    file: EDITOR,
    find: '          event.preventDefault()\n          event.returnValue',
    replace: '          void 0\n          event.returnValue',
  },
  {
    name: 'a message is written into returnValue (no browser shows it)',
    file: EDITOR,
    find: "          event.returnValue = ''",
    replace: "          event.returnValue = 'unsaved changes'",
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
