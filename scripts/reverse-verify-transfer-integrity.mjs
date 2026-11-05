/**
 * Reverse verification for F-02's verification and conflict policy.
 *
 * Run: node scripts/reverse-verify-transfer-integrity.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const MUTATIONS = [
  {
    name: 'two missing digests are treated as a match',
    file: 'lib/verify.js',
    find: "  if (typeof expected !== 'string' || expected === '') {",
    replace: "  if (false) {",
    suites: ['tests/verify-smoke.mjs'],
  },
  {
    name: 'a truncated hex token is accepted as a digest',
    file: 'lib/verify.js',
    find: '  return /^[0-9a-f]{64}$/iu.test(first) ? first.toLowerCase() : undefined',
    replace: '  return /^[0-9a-f]+$/iu.test(first) ? first.toLowerCase() : undefined',
    suites: ['tests/verify-smoke.mjs'],
  },
  {
    name: 'the hasher preference order is inverted',
    file: 'lib/verify.js',
    find: "  return REMOTE_HASHERS.find(entry => reported.has(entry.name))",
    replace: "  return [...REMOTE_HASHERS].reverse().find(entry => reported.has(entry.name))",
    suites: ['tests/verify-smoke.mjs'],
  },
  {
    name: 'the remote path is not shell-quoted',
    file: 'lib/verify.js',
    find: "  const outcome = await engine.exec(alias, `${hasher.command} ${shellQuote(remotePath)}`, {",
    replace: "  const outcome = await engine.exec(alias, `${hasher.command} ${remotePath}`, {",
    suites: ['tests/verify-smoke.mjs'],
  },
  {
    name: 'an unknown conflict policy silently becomes rename',
    file: 'lib/conflict-policy.js',
    find: "  return CONFLICT_POLICIES.includes(text) ? text : DEFAULT_CONFLICT_POLICY",
    replace: "  return CONFLICT_POLICIES.includes(text) ? text : 'rename'",
    suites: ['tests/conflict-policy-smoke.mjs'],
  },
  {
    name: 'skip is reported as a refusal',
    file: 'lib/conflict-policy.js',
    find: "      action: 'skip',\n      note: `the destination already exists and the conflict policy is \"skip\"",
    replace: "      action: 'refuse',\n      note: `the destination already exists and the conflict policy is \"skip\"",
    suites: ['tests/conflict-policy-smoke.mjs'],
  },
  {
    name: 'rename overwrites instead of picking a free name',
    file: 'lib/conflict-policy.js',
    find: '    const free = await freeName(options.destination ?? \'\', options.existsAt)',
    replace: '    const free = options.destination ?? \'\'',
    suites: ['tests/conflict-policy-smoke.mjs'],
  },
  {
    name: 'the number goes after the extension',
    file: 'lib/conflict-policy.js',
    find: "    const candidate = `${stem}.${index}${suffix}`",
    replace: "    const candidate = `${target}.${index}`",
    suites: ['tests/conflict-policy-smoke.mjs'],
  },
  {
    name: 'the transfer ignores the conflict decision',
    file: 'lib/transfer.js',
    find: "  if (decision.action === 'skip') {\n    return { bytes: 0, skipped: true, note: decision.note }\n  }\n  const target = decision.path ?? destination",
    replace: "  const target = destination",
    suites: ['tests/transfer-smoke.mjs'],
  },
  {
    name: 'verify() reports success when no hasher exists',
    file: 'lib/transfer.js',
    find: "    return { verified: false, verification: 'no sha256 tool",
    replace: "    return { verified: true, verification: 'no sha256 tool",
    suites: ['tests/transfer-smoke.mjs'],
  },
]

function run (suites) {
  let failed = 0
  let ran = 0
  for (const suite of suites) {
    const result = spawnSync(process.execPath, [suite], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, DSH_CORE_ROOT: path.join(root, 'tests/.peer-stubs') },
    })
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    const match = /=== (\d+) passed, (\d+) failed(?:, \d+ suite skipped)? ===/u.exec(output)
    if (match === null) { failed += 1; continue }
    if (/1 suite skipped/u.test(output) && Number(match[1]) === 0) continue
    ran += 1
    failed += Number(match[2])
  }
  return { failed, ran }
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
    const { failed } = run(mutation.suites)
    if (failed > 0) console.log(`  RED   ${mutation.name} → ${failed} failed`)
    else { allGood = false; console.log(`  GREEN ${mutation.name} → THE SUITE DID NOT NOTICE`) }
  } finally {
    writeFileSync(file, original)
  }
}

const restored = run(['tests/verify-smoke.mjs', 'tests/conflict-policy-smoke.mjs', 'tests/transfer-smoke.mjs'])
console.log(`\nrestored: ${restored.failed === 0 ? 'suites green again' : `STILL ${restored.failed} RED`}`)
if (restored.failed !== 0 || !allGood) process.exit(1)
