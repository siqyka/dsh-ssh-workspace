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

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const { RULE_SETS, DEFAULT_POLICY, normalizePolicy, matchRule, needsConfirmation, approvalUnavailableMessage } =
  await import(pathToFileURL(path.join(pluginRoot, 'lib', 'command-policy.js')).href)

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
  tools = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'tools.js')).href)
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
    return {
      asked,
      config: { confirmCommands: { mode: 'rules', rules: ['destructive'] } },
      get (name) {
        if (name !== 'approval') return undefined
        return {
          async request (request) {
            asked.push(request)
            return allowed ? 'allowed-once' : 'rejected'
          },
        }
      },
    }
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

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
if (failures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}
