/**
 * Reverse verification for F-08's status provenance.
 *
 * Run: node scripts/reverse-verify-status-provenance.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const MUTATIONS = [
  {
    name: 'a cached probe is reported as live',
    file: 'lib/status-provenance.js',
    find: '  return provenance(PROVENANCE.cached, cached.at)',
    replace: '  return provenance(PROVENANCE.live, cached.at)',
    suites: ['tests/status-provenance-smoke.mjs'],
  },
  {
    name: 'a failed refresh is reported as merely cached',
    file: 'lib/status-provenance.js',
    find: '    capabilities: options.probeFailed === true && typeof probeAt === \'number\'\n      ? staleProvenance(probeAt)',
    replace: '    capabilities: options.probeFailed === true && typeof probeAt === \'number\'\n      ? probeProvenance({ at: probeAt })',
    suites: ['tests/status-provenance-smoke.mjs'],
  },
  {
    name: 'clock skew renders as a negative age',
    file: 'lib/status-provenance.js',
    find: '  return Math.max(0, current - at)',
    replace: '  return current - at',
    suites: ['tests/status-provenance-smoke.mjs'],
  },
  {
    name: 'an unknown kind is accepted silently',
    file: 'lib/status-provenance.js',
    find: "  if (kind !== PROVENANCE.live && kind !== PROVENANCE.cached && kind !== PROVENANCE.stale) {\n    throw new Error(`unknown provenance kind ${JSON.stringify(kind)}`)\n  }",
    replace: '',
    suites: ['tests/status-provenance-smoke.mjs'],
  },
  {
    name: 'a never-probed host is called stale',
    file: 'lib/status-provenance.js',
    find: '    return provenance(PROVENANCE.live)\n  }\n  return provenance(PROVENANCE.cached, cached.at)',
    replace: '    return provenance(PROVENANCE.stale)\n  }\n  return provenance(PROVENANCE.cached, cached.at)',
    suites: ['tests/status-provenance-smoke.mjs'],
  },
  {
    name: 'the panel stops rendering the freshness line',
    file: 'lib/client.js',
    find: '        provenanceText(t, status.provenance?.capabilities) !== undefined && jsx(\'div\', {',
    replace: '        false && jsx(\'div\', {',
    suites: ['tests/client-shape-smoke.mjs'],
  },
  {
    name: 'the status route stops shipping provenance',
    file: 'lib/routes.js',
    find: '          provenance: statusProvenance({',
    replace: '          provenanceDisabled: statusProvenance({',
    suites: ['tests/routes-smoke.mjs'],
  },
]

function run (suites) {
  let failed = 0
  for (const suite of suites) {
    const result = spawnSync(process.execPath, [suite], { cwd: root, encoding: 'utf8', timeout: 90_000 })
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    // A suite may skip only PART of itself (`routes-smoke` runs its source
    // checks on a bare checkout and then skips the route tests). Counting a
    // partly-skipped suite as "skipped" would hide exactly the assertions that
    // DO run there, which is how one mutation stayed green twice.
    const match = /=== (\d+) passed, (\d+) failed(?:, \d+ suite skipped)? ===/u.exec(output)
    if (match === null) { failed += 1; continue }
    failed += Number(match[2])
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

const restored = run(['tests/status-provenance-smoke.mjs', 'tests/client-shape-smoke.mjs', 'tests/routes-smoke.mjs'])
console.log(`\nrestored: ${restored === 0 ? 'suites green again' : `STILL ${restored} RED`}`)
if (restored !== 0 || !allGood) process.exit(1)
