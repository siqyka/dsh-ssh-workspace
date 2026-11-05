/**
 * Status provenance: every field says how old it is and where it came from.
 *
 * The rule under test is narrow and absolute: a payload must never present a
 * cached fact as a live one, because "it says connected but the tree is empty"
 * is the contradiction that makes a user stop trusting the panel.
 *
 * Run: node tests/status-provenance-smoke.mjs
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const { PROVENANCE, provenance, ageOf, probeProvenance, staleProvenance, statusProvenance } =
  await import(pathToFileURL(path.join(pluginRoot, 'lib', 'status-provenance.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== status provenance smoke ===\n')

// ---------------------------------------------------------------------------
// 1. The vocabulary is closed
// ---------------------------------------------------------------------------
console.log('[1] three kinds, and nothing else')
{
  check('exactly three kinds exist', Object.keys(PROVENANCE).length === 3,
    JSON.stringify(Object.keys(PROVENANCE)))
  check('live', provenance(PROVENANCE.live).kind === 'live')
  check('cached', provenance(PROVENANCE.cached).kind === 'cached')
  check('stale', provenance(PROVENANCE.stale).kind === 'stale')
  // A typo must throw rather than become a fourth kind nobody renders.
  let threw = false
  try { provenance('fresh-ish') } catch { threw = true }
  check('an unknown kind throws', threw)
}

// ---------------------------------------------------------------------------
// 2. Ages, including clock skew
// ---------------------------------------------------------------------------
console.log('[2] age')
{
  const label = provenance(PROVENANCE.cached, 1000)
  check('a past timestamp has a positive age', ageOf(label, 3000) === 2000, String(ageOf(label, 3000)))
  check('the same instant is zero', ageOf(label, 1000) === 0, String(ageOf(label, 1000)))
  // A cache written by a clock that is ahead must not render as "in the future".
  check('a future timestamp clamps to zero', ageOf(label, 500) === 0, String(ageOf(label, 500)))
  check('a missing timestamp is zero, not NaN', ageOf({ kind: 'cached' }, 1000) === 0,
    String(ageOf({ kind: 'cached' }, 1000)))
  check('an undefined label is zero, not a throw', ageOf(undefined, 1000) === 0)
}

// ---------------------------------------------------------------------------
// 3. A probe that was never run
// ---------------------------------------------------------------------------
console.log('[3] an unprobed host')
{
  const label = probeProvenance(undefined)
  // There is no value to be stale about: calling it stale would imply one was
  // once obtained, which would send the user looking for a failure that never
  // happened.
  check('never probed is not "stale"', label.kind !== 'stale', JSON.stringify(label))
  check('and carries a timestamp anyway', typeof label.at === 'number', JSON.stringify(label))
}

// ---------------------------------------------------------------------------
// 4. A cached probe is CACHED, never live
// ---------------------------------------------------------------------------
console.log('[4] a cached probe says it is cached')
{
  const label = probeProvenance({ at: 5000 })
  check('the kind is cached', label.kind === 'cached', JSON.stringify(label))
  check('and the time is when it was STORED', label.at === 5000, JSON.stringify(label))
}

// ---------------------------------------------------------------------------
// 5. A failed refresh is stale, and distinct from cached
// ---------------------------------------------------------------------------
console.log('[5] a failed refresh is its own kind')
{
  const stale = staleProvenance(4000)
  const cached = probeProvenance({ at: 4000 })
  check('stale is its own kind', stale.kind === 'stale', JSON.stringify(stale))
  check('and is distinguishable from cached', stale.kind !== cached.kind,
    `${stale.kind} vs ${cached.kind}`)
}

// ---------------------------------------------------------------------------
// 6. A whole payload labels every section
// ---------------------------------------------------------------------------
console.log('[6] every section of a status payload is labelled')
{
  const { sections } = statusProvenance({ now: 10_000, probe: { at: 9000 } })
  const required = ['connections', 'forwards', 'shells', 'capabilities', 'events']
  check('every section is present', required.every(name => sections[name] !== undefined),
    JSON.stringify(Object.keys(sections)))
  check('and every one has a kind and a time',
    Object.values(sections).every(label => typeof label.kind === 'string' && typeof label.at === 'number'),
    JSON.stringify(sections))
  // The specific lie this module exists to prevent.
  check('the capability section is NOT live when it came from the cache',
    sections.capabilities.kind === 'cached', JSON.stringify(sections.capabilities))
  check('the connections section IS live', sections.connections.kind === 'live',
    JSON.stringify(sections.connections))
}

// ---------------------------------------------------------------------------
// 7. A failed probe refresh becomes stale
// ---------------------------------------------------------------------------
console.log('[7] a probe that could not be refreshed')
{
  const { sections } = statusProvenance({ now: 10_000, probe: { at: 9000 }, probeFailed: true })
  check('the capability section is stale',
    sections.capabilities.kind === 'stale', JSON.stringify(sections.capabilities))
  check('and keeps the time of the last good read',
    sections.capabilities.at === 9000, JSON.stringify(sections.capabilities))

  const noCache = statusProvenance({ now: 10_000, probeFailed: true })
  check('a failure with no cached value is not "stale"',
    noCache.sections.capabilities.kind !== 'stale', JSON.stringify(noCache.sections.capabilities))
}

// ---------------------------------------------------------------------------
// 8. An unlabelled section would be a bug, not "probably fine"
// ---------------------------------------------------------------------------
console.log('[8] no section may be unlabelled')
{
  const { sections } = statusProvenance({ now: 1 })
  const unlabelled = Object.entries(sections).filter(([, label]) => label === undefined || label.kind === undefined)
  check('there are none', unlabelled.length === 0, JSON.stringify(unlabelled.map(([name]) => name)))
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
if (failures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}
