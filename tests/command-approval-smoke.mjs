/**
 * The command-confirmation policy and the gate that enforces it.
 *
 * `command-policy` executes the RULE decision; `command-confirm` executes the
 * GATE and pins that both command tools go through it. The split matters
 * because a policy that says "confirm this" is harmless if the tool never
 * calls it — and an earlier mutation run showed exactly that. They share one
 * file, but stay two sections: rules above, wiring below.
 *
 * Run: node tests/command-approval-smoke.mjs
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHost } from './support/plugin-host.mjs'

let totalPassed = 0
let totalFailures = 0

// ---------------------------------------------------------------------------
// command-policy-smoke.mjs
// ---------------------------------------------------------------------------
await (async () => {
/**
 * Command-confirmation policy: what matches, what does not, and what happens
 * when nobody can be asked.
 *
 * The matcher is deliberately literal, and this suite is equally deliberately
 * blunt about what that buys: it catches the command a person actually types,
 * not the one an adversary crafts. The assertions say so, so a future reader
 * cannot mistake this module for a sandbox.
 *
 * Run: node tests/command-policy-smoke.mjs
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const { RULE_SETS, DEFAULT_POLICY, normalizePolicy, matchRule, needsConfirmation, approvalUnavailableMessage } =
  await import(pathToFileURL(path.join(pluginRoot, 'lib', 'surface', 'tools.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== command policy smoke ===\n')

// ---------------------------------------------------------------------------
// 1. The default is OFF, and stays off through normalization
// ---------------------------------------------------------------------------
console.log('[1] the feature is opt-in')
{
  check('the default mode is off', DEFAULT_POLICY.mode === 'off', DEFAULT_POLICY.mode)
  check('an absent policy is off', normalizePolicy(undefined).mode === 'off')
  check('a garbage policy is off', normalizePolicy('nonsense').mode === 'off')
  check('an unknown mode is off', normalizePolicy({ mode: 'sometimes' }).mode === 'off')
  check('off means nothing needs confirming',
    needsConfirmation('rm -rf /', normalizePolicy({ mode: 'off' })).confirm === false)
}

// ---------------------------------------------------------------------------
// 2. "all" mode
// ---------------------------------------------------------------------------
console.log('\n[2] mode "all" confirms everything')
{
  const policy = normalizePolicy({ mode: 'all' })
  for (const command of ['ls', 'echo hi', 'npm test', 'rm -rf /tmp/x']) {
    check(`${JSON.stringify(command)} needs confirmation`, needsConfirmation(command, policy).confirm === true)
  }
  check('the reason names the mode',
    /every remote command/u.test(needsConfirmation('ls', policy).reason ?? ''),
    needsConfirmation('ls', policy).reason)
}

// ---------------------------------------------------------------------------
// 3. Rules mode: the cases a person types
// ---------------------------------------------------------------------------
console.log('\n[3] rule mode catches the destructive cases')
{
  const policy = normalizePolicy({ mode: 'rules' })
  const shouldConfirm = [
    'rm -rf /var/www',
    'rm -r build',
    'sudo apt update',
    'dd if=/dev/zero of=/dev/sda',
    'mkfs.ext4 /dev/sdb1',
    'shutdown -h now',
    'reboot',
    'systemctl stop nginx',
    'kill -9 1234',
    'chmod -R 777 /srv',
    'git reset --hard origin/main',
    'echo hi > /etc/motd',
    'su - root',
  ]
  for (const command of shouldConfirm) {
    const verdict = needsConfirmation(command, policy)
    check(`${JSON.stringify(command)} is confirmed`, verdict.confirm === true,
      JSON.stringify(verdict))
  }
  const shouldPass = [
    'ls -la',
    'cat /etc/hostname',
    'npm ci',
    'git status',
    'echo hi > /dev/null',
    'grep -r TODO src',
    'make -j4',
    'python3 build.py',
  ]
  for (const command of shouldPass) {
    const verdict = needsConfirmation(command, policy)
    check(`${JSON.stringify(command)} runs freely`, verdict.confirm === false,
      JSON.stringify(verdict))
  }
}

// ---------------------------------------------------------------------------
// 4. The verdict names WHAT matched, so the prompt can quote it
// ---------------------------------------------------------------------------
console.log('\n[4] the verdict is quotable')
{
  const policy = normalizePolicy({ mode: 'rules' })
  const verdict = needsConfirmation('sudo systemctl restart nginx', policy)
  check('a rule name is reported', typeof verdict.rule === 'string', JSON.stringify(verdict))
  check('and the matched fragment too', typeof verdict.matched === 'string', JSON.stringify(verdict))
  check('the fragment is actually in the command',
    String(verdict.matched).toLowerCase().length > 0 &&
      'sudo systemctl restart nginx'.toLowerCase().includes(String(verdict.matched).toLowerCase()),
    JSON.stringify(verdict.matched))
}

// ---------------------------------------------------------------------------
// 5. Selecting a SUBSET of rules
// ---------------------------------------------------------------------------
console.log('\n[5] a policy can enable only some rules')
{
  const onlySystem = normalizePolicy({ mode: 'rules', rules: ['system'] })
  check('shutdown is confirmed', needsConfirmation('shutdown now', onlySystem).confirm === true)
  check('rm -rf is NOT confirmed under system-only',
    needsConfirmation('rm -rf /tmp/x', onlySystem).confirm === false)
  check('sudo is NOT confirmed under system-only',
    needsConfirmation('sudo ls', onlySystem).confirm === false)

  const onlyDestructive = normalizePolicy({ mode: 'rules', rules: ['destructive'] })
  check('rm -rf is confirmed under destructive-only',
    needsConfirmation('rm -rf /tmp/x', onlyDestructive).confirm === true)
  check('reboot is NOT', needsConfirmation('reboot', onlyDestructive).confirm === false)
}

// ---------------------------------------------------------------------------
// 6. A policy that names no usable rule is OFF, not "on matching nothing"
// ---------------------------------------------------------------------------
console.log('\n[6] an empty rule set is off, not silently inert')
{
  const bogus = normalizePolicy({ mode: 'rules', rules: ['nope', 'also-nope'] })
  check('an all-bogus rule list falls back to off', bogus.mode === 'off', JSON.stringify(bogus))
  // This is the failure that matters: a UI saying "confirmation is on" while
  // nothing can ever match would be worse than the feature being off.
  check('and therefore nothing is confirmed',
    needsConfirmation('rm -rf /', bogus).confirm === false, JSON.stringify(bogus))

  const mixed = normalizePolicy({ mode: 'rules', rules: ['destructive', 'bogus'] })
  check('unknown names are dropped, known ones survive',
    mixed.mode === 'rules' && mixed.rules.join(',') === 'destructive', JSON.stringify(mixed))
}

// ---------------------------------------------------------------------------
// 7. Matching is literal — and that limit is stated, not hidden
// ---------------------------------------------------------------------------
console.log('\n[7] the matcher is literal, on purpose')
{
  const policy = normalizePolicy({ mode: 'rules' })
  // What the literal matcher actually does with the shapes people worry about.
  // Measured rather than assumed: the first version of this case asserted that
  // most of them slip past, and two of three turned out to be caught (the
  // substring sits inside the quoted string, and `xargs rm -rf` contains the
  // literal). Encoding the real behaviour is what makes the documented limit
  // trustworthy.
  check('a quoted `sh -c` is still caught (the literal is inside the quotes)',
    needsConfirmation('sh -c "rm -rf /tmp/x"', policy).confirm === true)
  check('`xargs rm -rf` is caught', needsConfirmation('xargs rm -rf', policy).confirm === true)
  // The one that genuinely escapes: splitting the command name.
  check('a backslash-split command name escapes — this is the documented limit',
    needsConfirmation('r\\m -rf /tmp/x', policy).confirm === false)
  // And the plain form, which is what section 3 pins across many commands.
  check('the plain form is caught', needsConfirmation('rm -rf /tmp/x', policy).confirm === true)
}

// ---------------------------------------------------------------------------
// 8. A rule set that cannot match does not disable the others
// ---------------------------------------------------------------------------
console.log('\n[8] one bad regex does not silence the policy')
{
  const broken = {
    label: 'broken',
    substrings: ['frobnicate'],
    regexes: ['[unclosed'],
  }
  check('the substring still matches', matchRule('please frobnicate', broken) === 'frobnicate')
  check('the bad regex is skipped without throwing', matchRule('anything else', broken) === undefined)
  check('the real rule sets all load', Object.keys(RULE_SETS).length === 3,
    JSON.stringify(Object.keys(RULE_SETS)))
  for (const [name, rule] of Object.entries(RULE_SETS)) {
    for (const source of rule.regexes) {
      let ok = true
      try { new RegExp(source, 'iu') } catch { ok = false }
      check(`RULE_SETS.${name} regex ${JSON.stringify(source)} compiles`, ok)
    }
  }
}

// ---------------------------------------------------------------------------
// 9. When nobody can be asked, the refusal says which situation it is
// ---------------------------------------------------------------------------
console.log('\n[9] an unanswerable confirmation refuses, and explains')
{
  const unavailable = approvalUnavailableMessage('unavailable', { reason: 'destructive pattern "rm -rf"' })
  check('it refuses', /refusing to run/u.test(unavailable), unavailable)
  check('it names the deployment fact', /no approval service/u.test(unavailable), unavailable)
  check('it quotes the reason', /rm -rf/u.test(unavailable), unavailable)
  // The sentence a user must never be left without: this is not containment.
  check('it says this is not a sandbox', /not a sandbox/u.test(unavailable), unavailable)

  const noTurn = approvalUnavailableMessage('no-turn', { reason: 'x' })
  check('the no-turn case is a DIFFERENT sentence', noTurn !== unavailable, noTurn)
  check('and names the turn', /open turn/u.test(noTurn), noTurn)
}

// ---------------------------------------------------------------------------
// 10. Both command tools actually route through the gate
// ---------------------------------------------------------------------------
// Executed, not grepped: the earlier mutation run removed the gate from BOTH
// tools and this suite stayed green, which is the definition of a test that
// proves nothing. The tool modules need their peer packages, so the import is
// attempted and the case is REPORTED as unrun when they are unavailable rather
// than silently skipped.
console.log('\n[10] the tools route through the gate')

const { existsSync } = await import('node:fs')
const stubRoot = path.join(pluginRoot, 'tests', '.peer-stubs')
process.env.DSH_PEER_ROOT = [process.env.DSH_PEER_ROOT, stubRoot].filter(Boolean).join(path.delimiter)

let tools
try {
  tools = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'surface', 'tools.js')).href)
} catch (error) {
  tools = undefined
  console.log(`  NOTE  tools.js could not be imported here (${error instanceof Error ? error.message : String(error)})`)
}

if (tools === undefined) {
  console.log('  NOTE  the wiring case did not run')
} else {
  /**
   * A minimal context whose `get('approval')` records requests.
   *
   * `confirmCommands` is read from `ctx.config` on every call, so toggling it
   * between cases is exactly what the panel does.
   */
  const makeCtx = (allowed) => {
    const asked = []
    const host = createHost({
      config: { confirmCommands: { mode: 'rules', rules: ['destructive'] } },
      services: {
        approval: {
          async request (request) {
            asked.push(request)
            return allowed ? 'allowed-once' : 'rejected'
          },
        },
      },
    })
    return { asked, config: host.ctx.config, get: name => host.ctx.get(name) }
  }

  /** An engine double that records every command it was asked to run. */
  const makeEngine = () => {
    const ran = []
    return {
      ran,
      audit: { record () {} },
      assertNotDisabled () {},
      generationOf () { return { generation: 1, connected: true } },
      async exec (alias, command) {
        ran.push(command)
        return { success: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', truncated: false, durationMs: 1 }
      },
    }
  }

  const callTool = async (tool, args, exec) => {
    const execute = tool.execute ?? tool.handler ?? tool.run
    if (typeof execute !== 'function') throw new Error('tool has no execute')
    return await execute(args, exec ?? { agent: { id: 'a' }, callId: 'c1' })
  }

  const findTool = (list, name) => list.find(tool => tool.name === name)

  // The tools are built from the plugin's registrator, so the wiring under test
  // is the one the Host gets.
  const built = tools.workspaceTools(makeCtx(true), makeEngine(), { roots: new Set() }, { open () {}, close () {}, list: () => [] }, undefined)
  const execTool = findTool(built, 'ssh_workspace_exec')
  check('an exec tool is registered', execTool !== undefined)

  if (execTool !== undefined) {
    // A destructive command with an approver that says YES must run.
    const ctx = makeCtx(true)
    built.length = 0
    const list = tools.workspaceTools(ctx, makeEngine(), { roots: new Set() }, { open () {}, close () {}, list: () => [] }, undefined)
    const tool = findTool(list, 'ssh_workspace_exec')
    const allowed = await callTool(tool, { alias: 'h', command: 'rm -rf /tmp/x' })
    check('an approved destructive command runs', ctx.asked.length === 1 && allowed.success === true,
      `asked=${ctx.asked.length} success=${allowed.success}`)

    // The same command with an approver that says NO must not run.
    const refusing = makeCtx(false)
    const list2 = tools.workspaceTools(refusing, makeEngine(), { roots: new Set() }, { open () {}, close () {}, list: () => [] }, undefined)
    const blocked = await callTool(findTool(list2, 'ssh_workspace_exec'), { alias: 'h', command: 'rm -rf /tmp/x' })
    check('a rejected destructive command does not run', blocked.success === false,
      JSON.stringify(blocked))
    check('and the refusal reached the caller',
      /did not run|not approved/u.test(String(blocked.error)), String(blocked.error))
    check('the approver was asked', refusing.asked.length === 1, String(refusing.asked.length))

    // A harmless command must not even ask.
    const quiet = makeCtx(false)
    const list3 = tools.workspaceTools(quiet, makeEngine(), { roots: new Set() }, { open () {}, close () {}, list: () => [] }, undefined)
    const fine = await callTool(findTool(list3, 'ssh_workspace_exec'), { alias: 'h', command: 'ls' })
    check('a harmless command is not gated', quiet.asked.length === 0 && fine.error === undefined,
      `asked=${quiet.asked.length} error=${fine.error}`)

    // --- the persistent shell is gated by the SAME policy --------------------
    // A shell is arbitrary remote execution with extra steps: it keeps state,
    // so guarding exec and not the shell would guard the harmless half.
    const shellRan = []
    const shellManager = {
      async run (alias, command) {
        shellRan.push(command)
        return { output: '', exitCode: 0, reused: false }
      },
      close () { return 0 },
      list () { return [] },
    }
    const shellCtx = makeCtx(false)
    const shellList = tools.workspaceTools(
      shellCtx,
      makeEngine(),
      { roots: new Set() },
      { open () {}, close () {}, list: () => [] },
      shellManager,
    )
    const shellTool = findTool(shellList, 'ssh_workspace_shell')
    check('a shell tool is registered', shellTool !== undefined)
    if (shellTool !== undefined) {
      const refused = await callTool(shellTool, { alias: 'h', command: 'rm -rf /tmp/x' })
      check('a rejected command does not reach the shell',
        shellRan.length === 0 && refused.ok === false,
        `ran=${JSON.stringify(shellRan)} result=${JSON.stringify(refused)}`)
      check('the shell refusal is reported to the caller',
        /did not run|not approved/u.test(String(refused.error)), String(refused.error))

      const allowedCtx = makeCtx(true)
      const shellRan2 = []
      const allowedShells = {
        async run () { shellRan2.push(1); return { output: '', exitCode: 0, reused: false } },
        close () { return 0 },
        list () { return [] },
      }
      const allowedList = tools.workspaceTools(allowedCtx, makeEngine(), { roots: new Set() }, { open () {}, close () {}, list: () => [] }, allowedShells)
      const ran = await callTool(findTool(allowedList, 'ssh_workspace_shell'), { alias: 'h', command: 'rm -rf /tmp/x' })
      check('an approved command reaches the shell', shellRan2.length === 1 && ran.ok === true,
        `ran=${shellRan2.length} result=${JSON.stringify(ran)}`)
    }
  }
}


  totalPassed += passed
  totalFailures += failures
})()

// ---------------------------------------------------------------------------
// command-confirm-smoke.mjs
// ---------------------------------------------------------------------------
await (async () => {
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
const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')

process.env.DSH_PEER_ROOT = [process.env.DSH_PEER_ROOT, path.join(pluginRoot, 'tests/.peer-stubs')]
  .filter(Boolean).join(path.delimiter)

const { confirmRemoteCommand, normalizePolicy } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'surface', 'tools.js')).href)

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
  const { matchRule } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'surface', 'tools.js')).href)
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


  totalPassed += passed
  totalFailures += failures
})()

console.log(`\n=== ${totalPassed} passed, ${totalFailures} failed ===`)
if (totalFailures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}