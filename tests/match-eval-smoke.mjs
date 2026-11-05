/**
 * `Match` evaluation: what is decided, what is refused, and what is unknown.
 *
 * The three outcomes must stay three. "This block does not apply" is normal,
 * "this block could run a local command" is refused, and "I cannot tell" is
 * reported — collapsing any two of them is how O-10 became a security bug in the
 * first place.
 *
 * Run: node tests/match-eval-smoke.mjs
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const { parseMatchConditions, matchSelects, EVALUABLE_CRITERIA, REFUSED_CRITERIA, DEFERRED_CRITERIA } =
  await import(pathToFileURL(path.join(pluginRoot, 'lib', 'match-eval.js')).href)
const { patternMatches } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'ssh-config.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== match eval smoke ===\n')

// ---------------------------------------------------------------------------
// 1. The criteria are partitioned, and nothing is in two places
// ---------------------------------------------------------------------------
console.log('[1] every criterion has exactly one home')
{
  const all = [...EVALUABLE_CRITERIA, ...REFUSED_CRITERIA, ...DEFERRED_CRITERIA]
  check('no criterion is both evaluable and refused',
    ![...EVALUABLE_CRITERIA].some(item => REFUSED_CRITERIA.has(item)))
  check('no criterion is both refused and deferred',
    ![...REFUSED_CRITERIA].some(item => DEFERRED_CRITERIA.has(item)))
  check('exec is refused, not deferred',
    REFUSED_CRITERIA.has('exec') && !DEFERRED_CRITERIA.has('exec'))
  check('address is deferred, not refused',
    DEFERRED_CRITERIA.has('address') && !REFUSED_CRITERIA.has('address'))
  check('the partition has no duplicates', new Set(all).size === all.length, JSON.stringify(all))
}

// ---------------------------------------------------------------------------
// 2. host / originalhost
// ---------------------------------------------------------------------------
console.log('\n[2] host conditions, globbed like Host')
{
  check('an exact host matches', matchSelects(['host', 'web'], 'web').selects === true)
  check('a different host does not', matchSelects(['host', 'db'], 'web').selects === false)
  check('a glob matches', matchSelects(['host', 'web*'], 'web01').selects === true)
  check('a glob does not match a prefix', matchSelects(['host', 'prod*'], 'web01').selects === false)
  check('a ? matches one character', matchSelects(['host', 'we?'], 'web').selects === true)
  check('originalhost is the same fact here',
    matchSelects(['originalhost', 'web'], 'web').selects === true)
  check('a comma-separated list is split',
    matchSelects(['host', 'a,b'], 'b').selects === true, JSON.stringify(parseMatchConditions(['host', 'a,b'])))
  check('a negation excludes', matchSelects(['host', 'web,!web'], 'web').selects === false)
  // Matching itself is the same implementation the Host blocks use, and the
  // test pins that rather than trusting two copies to agree.
  check('the matcher is the same one Host blocks use',
    patternMatches('web*', 'web01') === true)
}

// ---------------------------------------------------------------------------
// 3. all
// ---------------------------------------------------------------------------
console.log('\n[3] `Match all`')
{
  check('all selects everyone', matchSelects(['all'], 'anything').selects === true)
  const parsed = parseMatchConditions(['all'])
  check('and takes no value', parsed.conditions.length === 1 && parsed.conditions[0].criterion === 'all',
    JSON.stringify(parsed))
}

// ---------------------------------------------------------------------------
// 4. exec is REFUSED, and refusing means selecting nobody
// ---------------------------------------------------------------------------
console.log('\n[4] `Match exec` is refused rather than run')
{
  const verdict = matchSelects(['exec', 'test', '-f', '/tmp/x'], 'web')
  check('the block selects nobody', verdict.selects === false, JSON.stringify(verdict))
  check('and the reason names exec', /exec/u.test(verdict.refused ?? ''),
    JSON.stringify(verdict))
  check('it is reported as REFUSED, not as undecidable', verdict.undecidable === undefined,
    JSON.stringify(verdict))
  // Even alongside a condition that matches: an undecided conjunction cannot be
  // true, and pretending otherwise would apply settings for an unchecked test.
  const mixed = matchSelects(['host', 'web', 'exec', 'true'], 'web')
  check('a matching host does not rescue an exec condition', mixed.selects === false,
    JSON.stringify(mixed))
}

// ---------------------------------------------------------------------------
// 5. Connection-dependent criteria are undecidable, not false
// ---------------------------------------------------------------------------
console.log('\n[5] criteria that need a connection are undecidable')
{
  for (const criterion of ['user', 'localuser', 'address', 'localaddress', 'port', 'final']) {
    const verdict = matchSelects([criterion, 'whatever'], 'web')
    check(`Match ${criterion} selects nobody`, verdict.selects === false, JSON.stringify(verdict))
    check(`...and says it cannot be decided`,
      typeof verdict.undecidable === 'string' && verdict.undecidable.includes(criterion),
      JSON.stringify(verdict))
  }
}

// ---------------------------------------------------------------------------
// 6. Unknown criteria
// ---------------------------------------------------------------------------
console.log('\n[6] an unknown criterion is reported')
{
  const parsed = parseMatchConditions(['frobnicate', 'x'])
  check('parsing records it', parsed.problems.some(problem => /unknown Match criterion/u.test(problem)),
    JSON.stringify(parsed.problems))
  const verdict = matchSelects(['frobnicate', 'x'], 'web')
  check('and it selects nobody', verdict.selects === false, JSON.stringify(verdict))
  check('as undecidable, not refused', verdict.undecidable !== undefined, JSON.stringify(verdict))
}

// ---------------------------------------------------------------------------
// 7. An empty or malformed Match line
// ---------------------------------------------------------------------------
console.log('\n[7] malformed lines select nobody')
{
  check('an empty Match line', matchSelects([], 'web').selects === false, JSON.stringify(matchSelects([], 'web')))
  check('host with no pattern', matchSelects(['host'], 'web').selects === false,
    JSON.stringify(matchSelects(['host'], 'web')))
  check('and it is reported', matchSelects(['host'], 'web').undecidable !== undefined,
    JSON.stringify(matchSelects(['host'], 'web')))
}

// ---------------------------------------------------------------------------
// 8. Several conditions are a conjunction
// ---------------------------------------------------------------------------
console.log('\n[8] several conditions all have to hold')
{
  check('both match', matchSelects(['host', 'web', 'originalhost', 'web'], 'web').selects === true)
  check('one fails', matchSelects(['host', 'web', 'originalhost', 'db'], 'web').selects === false)
  check('all plus host', matchSelects(['all', 'host', 'web'], 'web').selects === true)
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
if (failures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}
