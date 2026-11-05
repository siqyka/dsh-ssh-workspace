/**
 * Conflict policy: what a transfer does when the destination already exists.
 *
 * The interesting cases are the non-defaults, and "skip" in particular: it must
 * be a REPORTED outcome rather than an error, because a tree upload over a
 * mostly-identical tree is the normal case and failing on the first existing
 * file is why people stop using tree upload.
 *
 * Run: node tests/conflict-policy-smoke.mjs
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const { CONFLICT_POLICIES, DEFAULT_CONFLICT_POLICY, normalizeConflictPolicy, decideConflict, freeName } =
  await import(pathToFileURL(path.join(pluginRoot, 'lib', 'conflict-policy.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== conflict policy smoke ===\n')

// ---------------------------------------------------------------------------
// 1. Vocabulary and default
// ---------------------------------------------------------------------------
console.log('[1] four policies, one default')
{
  check('four policies', CONFLICT_POLICIES.length === 4, JSON.stringify(CONFLICT_POLICIES))
  check('the default is overwrite', DEFAULT_CONFLICT_POLICY === 'overwrite', DEFAULT_CONFLICT_POLICY)
  check('an absent policy is the default', normalizeConflictPolicy(undefined) === 'overwrite')
  check('a typo falls back to the default', normalizeConflictPolicy('overwrit') === 'overwrite')
  check('case and whitespace do not matter', normalizeConflictPolicy('  SKIP ') === 'skip')
  check('an unknown policy never becomes rename',
    normalizeConflictPolicy('rename-ish') !== 'rename', normalizeConflictPolicy('rename-ish'))
}

// ---------------------------------------------------------------------------
// 2. A free destination is always "proceed"
// ---------------------------------------------------------------------------
console.log('[2] nothing there means no decision')
{
  for (const policy of CONFLICT_POLICIES) {
    const decision = await decideConflict({ policy, exists: false })
    check(`${policy}: proceeds`, decision.action === 'proceed', JSON.stringify(decision))
  }
}

// ---------------------------------------------------------------------------
// 3. overwrite
// ---------------------------------------------------------------------------
console.log('[3] overwrite replaces')
{
  const decision = await decideConflict({ policy: 'overwrite', exists: true, destination: '/a/b' })
  check('it proceeds', decision.action === 'proceed', JSON.stringify(decision))
  check('at the original path', decision.path === undefined, JSON.stringify(decision))
  check('with no note', decision.note === undefined, JSON.stringify(decision))
}

// ---------------------------------------------------------------------------
// 4. skip — an OUTCOME, not an error
// ---------------------------------------------------------------------------
console.log('[4] skip is reported, not thrown')
{
  const decision = await decideConflict({ policy: 'skip', exists: true, destination: '/a/b' })
  check('the action is skip, not refuse', decision.action === 'skip', JSON.stringify(decision))
  check('and the note explains it', /already exists/u.test(decision.note ?? ''), decision.note)
  check('and names the destination', /\/a\/b/u.test(decision.note ?? ''), decision.note)
}

// ---------------------------------------------------------------------------
// 5. refuse
// ---------------------------------------------------------------------------
console.log('[5] refuse stops before writing')
{
  const decision = await decideConflict({ policy: 'refuse', exists: true, destination: '/a/b' })
  check('the action is refuse', decision.action === 'refuse', JSON.stringify(decision))
  check('and the note says which policy', /refuse/u.test(decision.note ?? ''), decision.note)
}

// ---------------------------------------------------------------------------
// 6. rename finds a free name
// ---------------------------------------------------------------------------
console.log('[6] rename writes beside the existing file')
{
  const taken = new Set(['/a/b.txt', '/a/b.1.txt'])
  const existsAt = async (candidate) => taken.has(candidate)
  const decision = await decideConflict({ policy: 'rename', exists: true, destination: '/a/b.txt', existsAt })
  check('it proceeds', decision.action === 'proceed', JSON.stringify(decision))
  check('to a NEW path', decision.path !== '/a/b.txt', decision.path)
  check('which is the first free number', decision.path === '/a/b.2.txt', decision.path)
  check('and the note says where it went', /b\.2\.txt/u.test(decision.note ?? ''), decision.note)

  // Without a probe it still has to produce something distinct.
  const blind = await decideConflict({ policy: 'rename', exists: true, destination: '/a/b.txt' })
  check('with no probe it still picks a different name', blind.path !== '/a/b.txt', blind.path)
}

// ---------------------------------------------------------------------------
// 7. freeName's own contract
// ---------------------------------------------------------------------------
console.log('[7] freeName')
{
  const existsAt = async (candidate) => candidate === '/x/y.1.log'
  check('the number goes BEFORE the extension', (await freeName('/x/y.log', existsAt)) === '/x/y.2.log',
    await freeName('/x/y.log', existsAt))
  // A dotfile's leading dot is not an extension.
  check('a dotfile keeps its name', (await freeName('/x/.env', async () => false)) === '/x/.env.1',
    await freeName('/x/.env', async () => false))
  check('a name with no extension gets one appended',
    (await freeName('/x/README', async () => false)) === '/x/README.1',
    await freeName('/x/README', async () => false))
  // A probe that always says "taken" must terminate, not loop.
  let calls = 0
  const alwaysTaken = async () => { calls += 1; return true }
  const fallback = await freeName('/x/z', alwaysTaken)
  check('an always-taken probe terminates', typeof fallback === 'string' && fallback !== '/x/z', fallback)
  check('after a bounded number of probes', calls <= 1001, String(calls))
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
if (failures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}
