/**
 * Reverse verification for find-in-file.
 *
 * Each mutation must turn `tests/file-editor-smoke.mjs` red. This is an audit
 * action, not a CI step: it rewrites the source in place and restores it.
 *
 * Run: node scripts/reverse-verify-editor-find.mjs
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
    name: 'case sensitivity is ignored, so "match case" does nothing',
    find: '      const caseSensitive = options?.caseSensitive === true',
    replace: '      const caseSensitive = false',
  },
  {
    name: 'matches advance by one byte, so a repeated needle overlaps itself',
    find: '        at = haystack.indexOf(want, at + want.length)',
    replace: '        at = haystack.indexOf(want, at + 1)',
  },
  {
    name: 'the cap is off by one (a thousand and one matches are held)',
    find: '        if (matches.length >= FIND_MATCH_CAP) return { matches, capped: true }',
    replace: '        if (matches.length > FIND_MATCH_CAP) return { matches, capped: true }',
  },
  {
    name: 'the query is compiled as a pattern, so "." matches any character',
    find: '      let at = haystack.indexOf(want)',
    replace: "      let at = caseSensitive ? haystack.search(new RegExp(needle)) : haystack.search(new RegExp(needle, 'i'))",
  },
  {
    name: 'stepping does not wrap, so Enter stops working at the last match',
    find: '      return ((from + step) % total + total) % total',
    replace: '      return from + step',
  },
  {
    name: 'Escape closes the panel before the bar, losing the whole session',
    find: '          if (find.open === true) closeFind()\n          else close()',
    replace: '          close()',
  },
  {
    name: 'Ctrl+F is not taken from the browser, so its own find opens instead',
    find: '          event.preventDefault()\n          openFind()',
    replace: '          openFind()',
  },
  {
    name: 'closing the bar leaves the match selected (the next key replaces it)',
    find: '        if (area !== null) area.setSelectionRange(area.selectionEnd, area.selectionEnd)',
    replace: '        if (area !== null) area.setSelectionRange(area.selectionStart, area.selectionEnd)',
  },
  {
    name: 'the line height drifts from the stylesheet, so find scrolls wrongly',
    find: '    const EDITOR_LINE_HEIGHT = 18',
    replace: '    const EDITOR_LINE_HEIGHT = 20',
  },
  {
    name: 'lineIndexOf counts one line too many',
    find: '      for (let at = 0; at < stop; at += 1) {',
    replace: '      for (let at = 0; at <= stop; at += 1) {',
  },
  {
    name: 'a negative scroll is allowed, so revealing line 0 jumps to the top',
    find: '      return Math.max(0, index * EDITOR_LINE_HEIGHT - Math.floor(height / 3))',
    replace: '      return index * EDITOR_LINE_HEIGHT - Math.floor(height / 3)',
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
  const file = path.join(root, EDITOR)
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
