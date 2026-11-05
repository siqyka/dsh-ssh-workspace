/**
 * Reverse verification for F-03's jump-chain parsing.
 *
 * Eight mutations, each of which must turn a suite red. Audit action, not a CI
 * step: it rewrites source in place and restores it.
 *
 * Run: node scripts/reverse-verify-jump-chain.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const MUTATIONS = [
  {
    name: '`none` is treated as a hop instead of "connect directly"',
    file: 'lib/jump-chain.js',
    find: "  if (trimmed.length === 1 && trimmed[0].toLowerCase() === 'none') return { kind: 'direct' }",
    replace: '',
    suites: ['tests/jump-chain-smoke.mjs'],
  },
  {
    name: 'a malformed hop silently becomes "direct"',
    file: 'lib/jump-chain.js',
    find: '      if (!/^\\d+$/u.test(portText)) {\n        throw new Error',
    replace: '      if (false) {\n        throw new Error',
    suites: ['tests/jump-chain-smoke.mjs'],
  },
  {
    name: 'the self-reference check is removed',
    file: 'lib/jump-chain.js',
    find: "    if (hop.host.toLowerCase() === target) {",
    replace: '    if (false) {',
    suites: ['tests/jump-chain-smoke.mjs'],
  },
  {
    name: 'duplicate hops are allowed',
    file: 'lib/jump-chain.js',
    find: '    if (seen.has(key)) {',
    replace: '    if (false) {',
    suites: ['tests/jump-chain-smoke.mjs'],
  },
  {
    name: 'the hop limit is dropped',
    file: 'lib/jump-chain.js',
    find: '  if (trimmed.length > MAX_JUMPS) {',
    replace: '  if (false) {',
    suites: ['tests/jump-chain-smoke.mjs'],
  },
  {
    name: 'IPv6 brackets are left in the address',
    file: 'lib/jump-chain.js',
    find: '    host = bracket[1]',
    replace: '    host = rest',
    suites: ['tests/jump-chain-smoke.mjs'],
  },
  {
    name: 'the resolver ignores the parsed chain (silent direct connection)',
    file: 'lib/hosts.js',
    find: '  const jump = parseJumpChain(entry.proxyJump)',
    replace: "  const jump = { kind: 'direct' }",
    suites: ['tests/host-listing-smoke.mjs'],
  },
  {
    name: 'a wildcard block no longer contributes its jump host',
    file: 'lib/hosts.js',
    find: '    if (!selects(section, alias)) continue\n    for (const { keyword, value } of section.entries) {\n      if (keyword !== \'proxyjump\' && keyword !== \'proxycommand\') continue',
    replace: '    if (!isExact(section, alias)) continue\n    for (const { keyword, value } of section.entries) {\n      if (keyword !== \'proxyjump\' && keyword !== \'proxycommand\') continue',
    suites: ['tests/host-listing-smoke.mjs', 'tests/ssh-config-smoke.mjs'],
  },
]

function run (suites) {
  let failed = 0
  for (const suite of suites) {
    const result = spawnSync(process.execPath, [suite], { cwd: root, encoding: 'utf8' })
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    const match = /=== (\d+) passed, (\d+) failed ===/u.exec(output)
    failed += match === null ? 1 : Number(match[2])
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
  writeFileSync(file, original.replace(mutation.find, mutation.replace))
  try {
    const failed = run(mutation.suites)
    if (failed > 0) console.log(`  RED   ${mutation.name} → ${failed} failed`)
    else { allGood = false; console.log(`  GREEN ${mutation.name} → THE SUITE DID NOT NOTICE`) }
  } finally {
    writeFileSync(file, original)
  }
}

const restored = run(['tests/jump-chain-smoke.mjs', 'tests/host-listing-smoke.mjs', 'tests/ssh-config-smoke.mjs'])
console.log(`\nrestored: ${restored === 0 ? 'suites green again' : `STILL ${restored} RED`}`)
if (restored !== 0 || !allGood) process.exit(1)
