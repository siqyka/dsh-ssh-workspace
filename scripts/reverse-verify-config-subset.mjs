/**
 * Reverse verification for F-04 (Include following + Match evaluation).
 *
 * Nine mutations across the two suites. Audit action, not a CI step.
 *
 * Run: node scripts/reverse-verify-config-subset.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const MUTATIONS = [
  {
    name: 'included files are appended at the END instead of spliced in place',
    file: 'lib/include-chain.js',
    find: '          for (const included of matched) out.push(read(included, depth + 1))',
    replace: '          for (const included of matched) trailing.push(read(included, depth + 1))',
    suites: ['tests/include-chain-smoke.mjs'],
    // Needs the accumulator to exist; if it is absent the mutation is skipped.
    extra: {
      file: 'lib/include-chain.js',
      find: '      const out = []',
      replace: '      const out = []\n      const trailing = []',
    },
    post: {
      find: '      return out.join(\'\\n\')',
      replace: '      return [...out, ...trailing].join(\'\\n\')',
    },
  },
  {
    name: 'cycle detection compares WRITTEN paths, not real paths',
    file: 'lib/include-chain.js',
    find: '      canonical = realpathSync(file)',
    replace: '      canonical = file',
    suites: ['tests/include-chain-smoke.mjs'],
  },
  {
    name: 'the nesting cap is removed',
    file: 'lib/include-chain.js',
    find: '    if (depth > maxDepth) {',
    replace: '    if (false) {',
    suites: ['tests/include-chain-smoke.mjs'],
  },
  {
    name: 'glob order is not deterministic',
    file: 'lib/include-chain.js',
    find: '      for (const entry of entries.sort()) {',
    replace: '      for (const entry of entries.reverse()) {',
    suites: ['tests/include-chain-smoke.mjs'],
  },
  {
    name: 'directories are accepted as config files',
    file: 'lib/include-chain.js',
    find: '      return statSync(candidate).isFile()',
    replace: '      statSync(candidate); return true',
    suites: ['tests/include-chain-smoke.mjs'],
  },
  {
    name: '`Match exec` is evaluated instead of refused',
    file: 'lib/match-eval.js',
    find: '    if (REFUSED_CRITERIA.has(condition.criterion)) {',
    replace: '    if (false) {',
    suites: ['tests/match-eval-smoke.mjs'],
  },
  {
    name: 'an undecidable criterion is treated as TRUE',
    file: 'lib/match-eval.js',
    find: '    if (DEFERRED_CRITERIA.has(condition.criterion)) {',
    replace: '    if (false) {\n      continue\n    }\n    if (false) {',
    suites: ['tests/match-eval-smoke.mjs'],
  },
  {
    name: 'the negation in a host condition is ignored',
    file: 'lib/match-eval.js',
    find: '    if (!matched || negative.some(pattern => globMatches(pattern, alias))) return { selects: false }',
    replace: '    if (!matched) return { selects: false }',
    suites: ['tests/match-eval-smoke.mjs'],
  },
  {
    name: 'selects() ignores Match again',
    file: 'lib/ssh-config.js',
    find: "  if (section.kind === 'match') return matchSelects(section.patterns, alias).selects",
    replace: "  if (section.kind === 'match') return false",
    suites: ['tests/ssh-config-smoke.mjs'],
  },
]

function run (suites) {
  let failed = 0
  for (const suite of suites) {
    const result = spawnSync(process.execPath, [suite], { cwd: root, encoding: 'utf8', timeout: 90_000 })
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    const match = /=== (\d+) passed, (\d+) failed ===/u.exec(output)
    if (match === null) failed += 1
    else failed += Number(match[2])
  }
  return failed
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
  // Apply the mutation, plus any companion edits it needs to be coherent.
  const extraFile = mutation.extra === undefined ? undefined : path.join(root, mutation.extra.file)
  const extraOriginal = extraFile === undefined ? undefined : readFileSync(extraFile, 'utf8')
  let mutated = original.replace(mutation.find, mutation.replace)
  if (mutation.extra !== undefined && extraOriginal.includes(mutation.extra.find)) {
    writeFileSync(extraFile, extraOriginal.replace(mutation.extra.find, mutation.extra.replace))
  }
  if (mutation.post !== undefined) mutated = mutated.replace(mutation.post.find, mutation.post.replace)
  writeFileSync(file, mutated)
  try {
    const failed = run(mutation.suites)
    if (failed > 0) console.log(`  RED   ${mutation.name} → ${failed} failed`)
    else { allGood = false; console.log(`  GREEN ${mutation.name} → THE SUITE DID NOT NOTICE`) }
  } finally {
    writeFileSync(file, original)
    if (extraFile !== undefined) writeFileSync(extraFile, extraOriginal)
  }
}

const restored = run(['tests/include-chain-smoke.mjs', 'tests/match-eval-smoke.mjs', 'tests/ssh-config-smoke.mjs'])
console.log(`\nrestored: ${restored === 0 ? 'suites green again' : `STILL ${restored} RED`}`)
if (restored !== 0 || !allGood) process.exit(1)
