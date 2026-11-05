/**
 * Reverse verification for F-03's jump TRANSPORT (real sockets).
 *
 * The parsing mutations are covered by `reverse-verify-jump-chain.mjs`. This
 * one asserts what only a real chain can prove: the connection actually went
 * THROUGH the hop, and the chain is torn down afterwards.
 *
 * Run: node scripts/reverse-verify-jump-transport.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SUITE = 'tests/jump-transport-smoke.mjs'

const MUTATIONS = [
  {
    name: 'the chain is built but never dialed through (silent direct)',
    file: 'lib/engine.js',
    find: '    if (chain.sock !== undefined) config.sock = chain.sock\n',
    replace: '',
  },
  {
    name: 'a hop port defaults to 22 instead of the entry\'s port',
    file: 'lib/engine.js',
    find: '        ...(hop.port === undefined ? {} : { port: hop.port }),',
    replace: '        port: hop.port ?? 22,',
  },
  {
    name: 'each hop trusts anything instead of pinning its own key',
    file: 'lib/engine.js',
    find: '        hopConfig.hostVerifier = this.#makeHostKeyVerifier({ ...hop }, hopKeyState)',
    replace: '        hopConfig.hostVerifier = () => true',
  },
  {
    name: 'the chain is never torn down with its record',
    file: 'lib/engine.js',
    find: '    try { record.jumpChain?.close?.() } catch { /* already gone */ }\n',
    replace: '',
  },
  {
    name: 'a half-built chain leaks its open sessions',
    file: 'lib/engine.js',
    find: "      for (const hop of [...opened].reverse()) {\n        try { hop.client.destroy() } catch { /* already gone */ }\n      }\n      throw error",
    replace: '      throw error',
  },
]

function run () {
  const result = spawnSync(process.execPath, [SUITE], { cwd: root, encoding: 'utf8', timeout: 150_000 })
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
