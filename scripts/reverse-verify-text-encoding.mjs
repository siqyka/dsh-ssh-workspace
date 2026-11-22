/**
 * Reverse verification for the text-encoding rules.
 *
 * Each mutation must turn one of the two encoding suites red:
 * `tests/text-encoding-smoke.mjs` (the rules themselves) or
 * `tests/text-routes-smoke.mjs` (the routes that apply them). This is an audit
 * action, not a CI step: it rewrites the source in place and restores it.
 *
 * Both suites are run for every mutation and EITHER going red counts, because
 * some rules are only visible at the route (the save path) and some only in the
 * module (which rule produced the answer).
 *
 * Run: node scripts/reverse-verify-text-encoding.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SUITES = ['tests/text-encoding-smoke.mjs', 'tests/text-routes-smoke.mjs']
const ENCODING = path.join('lib', 'routes', 'text-encoding.js')
const TEXT = path.join('lib', 'routes', 'text.js')
const CORE = path.join(root, 'tests/.peer-stubs')

const MUTATIONS = [
  {
    name: 'UTF-32 is not tested before UTF-16 (a UTF-32 file reads as UTF-16)',
    file: ENCODING,
    find: "  if (startsWith(sample, BOM_UTF32LE) || startsWith(sample, BOM_UTF32BE)) return { reason: 'not-utf8' }\n",
    replace: '',
  },
  {
    name: 'the low-byte lane test is dropped (four bytes of binary become "UTF-16")',
    file: ENCODING,
    find: '    if (!laneLooksTextual(usable, encoding)) continue',
    replace: '    if (false) continue',
  },
  {
    name: 'the odd-length rule ignores whether the sample is the whole file',
    file: ENCODING,
    find: '    if (holdsWholeFile && sample.length % 2 !== 0) return { reason: \'binary\' }',
    replace: '    if (sample.length % 2 !== 0) return { reason: \'binary\' }',
  },
  {
    name: 'the CJK gate is dropped (a Latin-1 file opens as mojibake)',
    file: ENCODING,
    find: "  if (decoded !== undefined && CJK.test(decoded)) return { encoding: 'gb18030', bom: false }",
    replace: "  if (decoded !== undefined) return { encoding: 'gb18030', bom: false }",
  },
  {
    // The bug this guard exists for: a WHATWG label reaching a lookup keyed by
    // internal names throws ERR_ENCODING_NOT_SUPPORTED, and a `catch` that
    // swallows it reads as "the bytes are not in this encoding" — so every CJK
    // UTF-8 file came back as GB18030 with no error anywhere. Only the rethrow
    // in `tryDecode` turns that into something visible.
    name: 'a label is passed where an internal name belongs (a thrown label error becomes a wrong answer)',
    file: ENCODING,
    find: "  if (tryDecode(sample, 'utf8') !== undefined) return { encoding: 'utf8', bom: false }",
    replace: "  if (tryDecode(sample, 'utf-8') !== undefined) return { encoding: 'utf8', bom: false }",
  },
  {
    name: 'the UTF-8 attempt is removed (UTF-8 falls through to the GB18030 guess)',
    file: ENCODING,
    find: "  if (tryDecode(sample, 'utf8') !== undefined) return { encoding: 'utf8', bom: false }\n",
    replace: '',
  },
  {
    name: 'BOM-less UTF-16 is never guessed (a UTF-16 config stays "binary")',
    file: ENCODING,
    find: "  if (sample.includes(0)) {",
    replace: "  if (false) {",
  },
  {
    name: 'every encoding claims to be writable (a GB18030 save would convert the file)',
    file: ENCODING,
    find: '  return WRITE_ENCODINGS.has(encoding)',
    replace: '  return encoding !== undefined',
  },
  {
    name: 'the UTF-16LE BOM is not written (a save strips the byte order mark)',
    file: ENCODING,
    find: '    return bom === true ? Buffer.concat([BOM_UTF16LE, body]) : body',
    replace: '    return body',
  },
  {
    name: 'the save always sends a string (a UTF-16 file is rewritten as UTF-8)',
    file: TEXT,
    find: "    if (described.encoding === 'utf8') {",
    replace: '    if (true) {',
  },
]

function run () {
  let failed = 0
  const output = []
  for (const suite of SUITES) {
    const result = spawnSync(process.execPath, [suite], {
      cwd: root,
      env: { ...process.env, DSH_CORE_ROOT: process.env.DSH_CORE_ROOT ?? CORE },
      encoding: 'utf8',
    })
    const text = `${result.stdout ?? ''}${result.stderr ?? ''}`
    output.push(text)
    const match = /=== (\d+) passed, (\d+) failed ===/u.exec(text)
    failed += match === null ? 1 : Number(match[2])
  }
  return { failed, output: output.join('\n') }
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
