/**
 * The confirmation gate itself: does it actually refuse, and does the tool use it?
 *
 * `command-policy-smoke` executes the RULE decision. That is not the same as
 * executing the gate: a policy that says "confirm this" is harmless if the tool
 * never calls it, and the earlier mutation run showed exactly that — wiring the
 * gate out of both tools left the suite green.
 *
 * So this suite calls `confirmRemoteCommand` directly, over every outcome the
 * approval service can return, and then pins that both command tools go through
 * it — by calling them, not by grepping for the call.
 *
 * Run: node tests/command-confirm-smoke.mjs
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')

process.env.DSH_PEER_ROOT = [process.env.DSH_PEER_ROOT, path.join(pluginRoot, 'tests/.peer-stubs')]
  .filter(Boolean).join(path.delimiter)

const { confirmRemoteCommand, normalizePolicy } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'command-policy.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** An approval service that answers with a fixed outcome. */
function approver (outcome, calls) {
  return {
    async request (request) {
      calls?.push(request)
      if (outcome instanceof Error) throw outcome
      return outcome
    },
  }
}

const RULES = normalizePolicy({ mode: 'rules' })

/** Run the gate with a policy and an approver. */
function gate (command, { policy = RULES, approval, exec } = {}) {
  return confirmRemoteCommand({
    approval,
    policyFor: () => policy,
    command,
    exec,
    action: 'run a remote command',
    target: 'ssh://h',
  })
}

console.log('\n=== command confirm smoke ===\n')

// ---------------------------------------------------------------------------
// 1. A command the policy does not care about proceeds without asking
// ---------------------------------------------------------------------------
console.log('[1] a harmless command is not gated')
{
  const calls = []
  const verdict = await gate('ls -la', { approval: approver('rejected', calls) })
  check('no refusal', verdict === undefined, String(verdict))
  check('and no approver was asked', calls.length === 0, String(calls.length))
}

// ---------------------------------------------------------------------------
// 2. allowed-once proceeds
// ---------------------------------------------------------------------------
console.log('[2] an approval lets it through')
{
  const calls = []
  const verdict = await gate('rm -rf /tmp/x', { approval: approver('allowed-once', calls), exec: { callId: 'c1' } })
  check('no refusal', verdict === undefined, String(verdict))
  check('the approver was asked once', calls.length === 1, String(calls.length))
  check('the request carries the call id', calls[0]?.callId === 'c1', JSON.stringify(calls[0]))
  check('the request carries a reason naming the match',
    /rm -rf/u.test(calls[0]?.reason ?? ''), calls[0]?.reason)
  check('the request names the host', /ssh:\/\/h/u.test(calls[0]?.reason ?? ''), calls[0]?.reason)
}

// ---------------------------------------------------------------------------
// 3. rejected refuses, and says so
// ---------------------------------------------------------------------------
console.log('[3] a rejection stops the command')
{
  const verdict = await gate('sudo ls', { approval: approver('rejected') })
  check('it refuses', typeof verdict === 'string', String(verdict))
  check('the message says it did not run', /did not run/u.test(String(verdict)), String(verdict))
  check('and repeats what matched', /privileged|sudo/u.test(String(verdict)), String(verdict))
}

// ---------------------------------------------------------------------------
// 4. cancelled refuses, with a different sentence
// ---------------------------------------------------------------------------
console.log('[4] a cancellation is its own sentence')
{
  const verdict = await gate('reboot', { approval: approver('cancelled') })
  check('it refuses', typeof verdict === 'string', String(verdict))
  check('the message says CANCELLED', /cancelled/u.test(String(verdict)), String(verdict))
  const rejected = await gate('reboot', { approval: approver('rejected') })
  check('which differs from the rejected sentence', verdict !== rejected,
    `${verdict} vs ${rejected}`)
}

// ---------------------------------------------------------------------------
// 5. unavailable refuses — fail closed
// ---------------------------------------------------------------------------
console.log('[5] an unavailable approver refuses')
{
  const noService = await gate('rm -rf /', { approval: undefined })
  check('no service → refuses', typeof noService === 'string', String(noService))
  check('and says the deployment has none', /no approval service/u.test(String(noService)), String(noService))

  const unavailable = await gate('rm -rf /', { approval: approver('unavailable') })
  check('an "unavailable" answer → refuses', typeof unavailable === 'string', String(unavailable))

  const broken = await gate('rm -rf /', { approval: approver(new Error('boom')) })
  check('a throwing service → refuses', typeof broken === 'string', String(broken))
  check('and the sentence does not claim a turn problem',
    !/open turn/u.test(String(broken)), String(broken))
}

// ---------------------------------------------------------------------------
// 6. "not in a turn" is its OWN sentence
// ---------------------------------------------------------------------------
console.log('[6] a call outside a turn explains that')
{
  const verdict = await gate('rm -rf /', { approval: approver(new Error('no open turn for this agent')) })
  check('it refuses', typeof verdict === 'string', String(verdict))
  check('and names the turn', /open turn/u.test(String(verdict)), String(verdict))
  const other = await gate('rm -rf /', { approval: approver(new Error('socket broke')) })
  check('which differs from a broken service', verdict !== other, `${verdict} vs ${other}`)
}

// ---------------------------------------------------------------------------
// 7. Every refusal states that this is not a sandbox
// ---------------------------------------------------------------------------
console.log('[7] every refusal says it is a gate, not containment')
{
  for (const [name, approval] of [
    ['rejected', approver('rejected')],
    ['no service', undefined],
    ['unavailable', approver('unavailable')],
  ]) {
    const verdict = String(await gate('rm -rf /', { approval }))
    // The one sentence a user must never be left without: approving does not
    // confine anything, and a prompt that reads like a sandbox is worse than no
    // prompt at all.
    check(`${name}: the refusal does not imply containment`,
      !/blocked|sandboxed|contained|confined/u.test(verdict) || /not a sandbox/u.test(verdict),
      verdict)
  }
}

// ---------------------------------------------------------------------------
// 8. One malformed regex must not silence the rest of the rule
// ---------------------------------------------------------------------------
console.log('\n[8] a malformed regex is skipped, not fatal')
{
  // `matchRule` compiles each pattern inside a try. The failure mode this pins
  // is the opposite: catching the error and returning "no match" for the WHOLE
  // rule, which would silently disable every other pattern in it.
  const { matchRule } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'command-policy.js')).href)
  const broken = {
    label: 'broken',
    substrings: ['frobnicate'],
    // The first pattern is unusable; the substring must still be found.
    regexes: ['(unclosed'],
  }
  check('the substring still matches after a bad regex', matchRule('please frobnicate', broken) === 'frobnicate',
    String(matchRule('please frobnicate', broken)))
  // The decisive shape: a rule with a BAD regex FIRST and a GOOD one after it.
  // A catch that returns "no match" for the whole rule stops here and reports
  // nothing; a catch that skips the pattern carries on and finds the good one.
  const ordered = {
    label: 'ordered',
    substrings: [],
    // `(unclosed` throws ("unterminated group"); `[unclosed` does NOT — a
    // `[` with no `]` is a literal in JS, which is why the first fixture
    // silently tested nothing. The second pattern is a real word boundary.
    regexes: ['(unclosed', '\\brm\\b'],
  }
  check('a bad regex does not stop the patterns after it',
    matchRule('rm x', ordered) === 'rm', String(matchRule('rm x', ordered)))
  // And a rule whose ONLY pattern is broken matches nothing without throwing.
  const onlyBroken = { label: 'only', substrings: [], regexes: ['(unclosed'] }
  check('a wholly broken rule matches nothing', matchRule('anything', onlyBroken) === undefined,
    String(matchRule('anything', onlyBroken)))
}

// ---------------------------------------------------------------------------
// 9. A policy that is ON but has no usable rule refuses rather than running
// ---------------------------------------------------------------------------
console.log('\n[9] "on but unable to ask" fails closed')
{
  // The dangerous shape is not "no policy" — it is a policy that BELIEVES it is
  // gating while nothing can be asked. Every branch below must refuse.
  const cases = [
    ['no approval service', undefined],
    ['a throwing service', approver(new Error('kaput'))],
    ['an explicit unavailable', approver('unavailable')],
  ]
  for (const [name, approval] of cases) {
    const verdict = await gate('rm -rf /tmp/x', { approval })
    check(`${name} refuses`, typeof verdict === 'string', String(verdict))
  }
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
if (failures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}
