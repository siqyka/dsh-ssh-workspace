/**
 * Reverse verification for F-03's reverse forwarding.
 *
 * Six mutations, each of which must turn a suite red.
 *
 * Run: node scripts/reverse-verify-reverse-forward.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SUITE = 'tests/reverse-forward-smoke.mjs'

const MUTATIONS = [
  {
    name: 'the remote listener is never cancelled on close',
    file: 'lib/reverse-forward.js',
    find: '        record.client.unforwardIn?.(remoteHost, entry.boundRemotePort, () => {})',
    replace: '        void 0',
  },
  {
    name: 'a non-loopback bind is reported as safe',
    file: 'lib/reverse-forward.js',
    find: '  return true\n}',
    replace: '  return false\n}',
  },
  {
    name: 'the assigned port is ignored (0 stays 0)',
    file: 'lib/reverse-forward.js',
    find: '    entry.boundRemotePort = bound\n',
    replace: '    entry.boundRemotePort = remotePort\n',
  },
  {
    name: 'the local target is never dialed (connections hang)',
    file: 'lib/reverse-forward.js',
    find: '      upstream.once(\'connect\', () => {\n        socket.pipe(upstream).pipe(socket)\n      })',
    replace: '      upstream.once(\'connect\', () => {})',
  },
  {
    name: 'a dead local target leaves the channel open',
    file: 'lib/reverse-forward.js',
    find: '        try { socket.close() } catch { /* already gone */ }\n        try { upstream.destroy() } catch { /* already gone */ }',
    replace: '        try { upstream.destroy() } catch { /* already gone */ }',
  },
  {
    name: 'the diagnostics never mention exposure',
    file: 'lib/reverse-forward.js',
    find: "${isExposedBind(entry.remoteHost) ? ' (exposed beyond the remote host)' : ''}",
    replace: "''",
  },
]

function run () {
  const result = spawnSync(process.execPath, [SUITE], { cwd: root, encoding: 'utf8', timeout: 120_000 })
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
