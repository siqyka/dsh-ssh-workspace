/**
 * Behavioural checks for the remote-mutation gate on the COMMAND surfaces.
 *
 * The plugin can change a host through six unconnected paths. `write` / `edit`
 * reach it via `ctx.fs`, which carries the per-call policy as an argument, and
 * `ssh_workspace_transfer` resolves the policy itself. Command execution is a
 * different family entirely and was ungated: a `read-only` session ran
 *
 *     ssh_workspace_exec { command: "rm /home/qiyk/test/test.py" }
 *
 * and got `[exit code: 0]`. The file tool would have refused the same deletion.
 *
 * Why the gate must REFUSE rather than filter: the local sandbox answers "may
 * this command write?" by confining the PROCESS to the workspace root with a
 * kernel boundary (bwrap / seatbelt / an ACL-restricted token). Nothing in that
 * machinery crosses an SSH connection — the remote command runs as the remote
 * login user with that user's full permissions. There is no seam to hand a root
 * to, and pattern-matching a command line for mutations is not a boundary:
 * `sh -c 'rm -rf ~'`, `find -delete`, `python -c ...` all read as pure text.
 * So the only honest options are "allow and let the mode be a lie" or "refuse
 * and keep the mode true"; this suite pins the second.
 *
 * Run: node tests/mode-gate-smoke.mjs
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  PASS  ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== mode gate (command surfaces) smoke ===\n')

const coreRoot = process.env.DSH_CORE_ROOT
if (!coreRoot) {
  console.log('  SKIP  DSH_CORE_ROOT is not set (needs @deepseek-ai/dsh-tools)')
  console.log(`\n=== ${passed} passed, ${failures} failed, 1 suite skipped ===`)
  process.exit(failures === 0 ? 0 : 1)
}
process.env.DSH_PEER_ROOT = [coreRoot, process.env.DSH_PEER_ROOT].filter(Boolean).join(path.delimiter)

const gate = await import(pathToFileURL(path.join(pluginRoot, 'lib/mode-gate.js')).href)
const { workspaceTools } = await import(pathToFileURL(path.join(pluginRoot, 'lib/tools.js')).href)
const { SshWorkspaceEngine } = await import(pathToFileURL(path.join(pluginRoot, 'lib/engine.js')).href)
const { installRemoteShell } = await import(pathToFileURL(path.join(pluginRoot, 'lib/patch-shell.js')).href)

const { sessionModeOf, specModeOf, assertRemoteCommandAllowed, remoteReadOnlyMessage } = gate

// ---------------------------------------------------------------------------
// The resolver: three outcomes, none of them guessed
// ---------------------------------------------------------------------------
{
  /** A context whose policy service reports whatever `mode` the test sets. */
  const ctxWith = (mode) => ({
    get: (name) => name === 'sandboxPolicy'
      ? { resolve: () => (mode === undefined ? { workspaceRoot: '/local' } : { mode, workspaceRoot: '/local' }) }
      : undefined,
  })

  check('a composed policy reports its mode', sessionModeOf(ctxWith('workspace-write'), { id: 's1' }) === 'workspace-write')
  check('a read-only session reports read-only', sessionModeOf(ctxWith('read-only'), { id: 's1' }) === 'read-only')

  // No policy service at all is an UNCONFINED deployment, not "view only".
  // Reading it as read-only would silently disarm every command on a machine
  // that never asked for a sandbox.
  check('no policy service resolves to undefined, not read-only',
    sessionModeOf({ get: () => undefined }, { id: 's1' }) === undefined)

  // A policy that THROWS fails closed for a mutation gate: a refused command is
  // retryable and visible, a silent write during "view only" is neither.
  const broken = { get: (name) => name === 'sandboxPolicy' ? { resolve: () => { throw new Error('boom') } } : undefined }
  check('an unresolvable policy fails closed', sessionModeOf(broken, { id: 's1' }) === 'read-only')

  // No session (an agentless call) still resolves: the deployment default is
  // the answer, and it must not be read as a denial.
  check('a call without a session still resolves a mode',
    sessionModeOf(ctxWith('danger-full-access'), undefined) === 'danger-full-access')

  // The spec carries the per-call policy; an absent one means an unsandboxed
  // caller, NOT a denial.
  check('a spec mode is read from sandboxPolicy', specModeOf({ sandboxPolicy: { mode: 'read-only' } }) === 'read-only')
  check('a spec without a policy has no mode', specModeOf({}) === undefined)
  check('an empty spec mode string is not a mode', specModeOf({ sandboxPolicy: { mode: '' } }) === undefined)

  // --- a real Cordis context traps the PROPERTY read ----------------------
  // These three cases exist because the previous implementation read
  // `ctx?.get?.('sandboxPolicy') ?? ctx?.sandboxPolicy`, which looks safe and
  // is not: when `ctx.get` legitimately answers `undefined` (a composition
  // without the policy service), the `??` falls through to the property read,
  // and on a real Cordis context that read is TRAPPED —
  // `cannot get property "sandboxPolicy" without inject`. An absent policy then
  // looked like a broken one, and the acceptance suite failed on a real host
  // with that message instead of reporting an unconfined deployment.
  //
  // A plain object context cannot reproduce this, so the trap is spelled out.
  //
  // Every call here is wrapped. An implementation that walks into the trap
  // THROWS, and an uncaught throw ends the whole suite: the run would stop at
  // the first regression and every assertion after it would go unrun, which
  // reads as "one suite broke" rather than "the gate is open". Catching turns
  // it into an ordinary failure with the message attached.
  const attempt = (fn) => {
    try { return { value: fn() } } catch (error) { return { error } }
  }
  // Both halves matter for the two cases whose expected value is `undefined`:
  // a thrown error also leaves `value` undefined, so asserting `value ===
  // undefined` alone would report a THROW as the correct answer. That is the
  // same shape of false green this suite exists to prevent.
  const resolvedTo = (outcome, expected) => outcome.error === undefined && outcome.value === expected
  const describe = (outcome) => outcome.error === undefined ? String(outcome.value) : `threw: ${outcome.error.message}`
  const trappingCtx = {
    get: () => undefined,
    get sandboxPolicy () { throw new Error('cannot get property "sandboxPolicy" without inject') },
  }
  {
    const outcome = attempt(() => sessionModeOf(trappingCtx, { id: 's1' }))
    check('a trapped property read with no service resolves to undefined, not a throw',
      resolvedTo(outcome, undefined), describe(outcome))
  }

  // The property fallback still serves a plain-object context that has no
  // `get` at all — that shape is what several suites build by hand.
  {
    const outcome = attempt(() => sessionModeOf({ sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) } }, { id: 's1' }))
    check('a plain context with the service as a property still resolves',
      resolvedTo(outcome, 'read-only'), describe(outcome))
  }

  // A `get` that throws is a broken lookup, not a broken policy: the property
  // read is still worth trying, and when that also fails the answer is the
  // same "unconfined" one — a throwing lookup must not manufacture a denial.
  const throwingGet = {
    get: () => { throw new Error('no such service') },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
  }
  {
    const outcome = attempt(() => sessionModeOf(throwingGet, { id: 's1' }))
    check('a throwing ctx.get falls through to the property read',
      resolvedTo(outcome, 'workspace-write'), describe(outcome))
  }
  {
    const outcome = attempt(() => sessionModeOf({ get: () => { throw new Error('no such service') } }, { id: 's1' }))
    check('a throwing ctx.get with no property is unconfined, not read-only',
      resolvedTo(outcome, undefined), describe(outcome))
  }
}

// ---------------------------------------------------------------------------
// The gate: only read-only refuses; everything else runs unchanged
// ---------------------------------------------------------------------------
{
  for (const mode of ['danger-full-access', 'workspace-write', undefined]) {
    let threw = false
    try {
      assertRemoteCommandAllowed(mode, 'run a remote command', 'ssh://alpha')
    } catch {
      threw = true
    }
    // `workspace-write` is deliberately NOT narrowed further: it grants the
    // workspace root, and for a remote target that root is a path on THIS
    // machine, which says nothing about a directory on the host. The mounted
    // -root fence, not the mode, bounds where a remote write may land.
    check(`${String(mode)} permits a remote command`, !threw)
  }

  let message = ''
  try {
    assertRemoteCommandAllowed('read-only', 'run a remote command', 'ssh://alpha/home/dev/proj')
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  check('read-only refuses a remote command', message !== '')
  check('the refusal names the mode', /read-only/u.test(message), message)
  check('the refusal names the target', /ssh:\/\/alpha\/home\/dev\/proj/u.test(message), message)
  // It must explain WHY confinement is impossible, or the model reads the
  // refusal as a broken plugin and retries the same thing.
  check('the refusal explains that the sandbox cannot cross SSH', /does not cross an SSH connection/u.test(message), message)
  // It must not promise a parameter these tools do not have. bash/pwsh add
  // their own escalation hint; this family has no `sandbox_permissions` field,
  // so advertising one would send the model after a nonexistent argument.
  check('the refusal does not promise an escalation field',
    !/sandbox_permissions/u.test(remoteReadOnlyMessage('run a remote command', 'ssh://alpha')), message)
  // It must name the way out, since the user has to perform it.
  check('the refusal names the modes that would allow it',
    /workspace-write or danger-full-access/u.test(message), message)
  // And it must say reads still work, or "view only" reads as "nothing works".
  check('the refusal says reads still work', /still works through read/u.test(message), message)
}

// ---------------------------------------------------------------------------
// The workspace SCOPE half of workspace-write
// ---------------------------------------------------------------------------
//
// `workspace-write` names ONE root, locally enforced by `writableRoots(policy)`
// whose first entry is `policy.workspaceRoot`. The remote half used to answer a
// weaker question — "inside ANY mounted root?" — and the mounted set is
// deployment-wide, so a session rooted at `ssh://qiyk/home/dev/proj` could write
// a sibling root, or a root on a DIFFERENT host, which no local session may do.
//
// The justification in the docs for the weaker rule was factually wrong: it said
// `workspaceRoot` is always a path on THIS machine. Measured against the real
// service, `resolve()` returns `session.header.cwd` verbatim — for a remote
// session, the `ssh://` spelling, which is directly comparable.
{
  const { workspaceWriteScopeRefusal, writeScopeRootOf } = gate
  const target = (spelling) => ({ alias: 'qiyk', remotePath: spelling, displayPath: `ssh://qiyk${spelling}` })

  // The root is only usable for comparison when it is a REMOTE spelling. An
  // agentless call resolves the deployment's local root, and comparing that
  // against a remote target would refuse every write on every host.
  check('a remote workspace root is usable as a scope',
    writeScopeRootOf({ workspaceRoot: 'ssh://qiyk/home/dev/proj' }) === 'ssh://qiyk/home/dev/proj')
  check('a local workspace root is not a remote scope',
    writeScopeRootOf({ workspaceRoot: 'F:\\GitHub\\proj' }) === undefined)

  check('workspace-write allows the session workspace itself',
    workspaceWriteScopeRefusal('workspace-write', 'ssh://qiyk/home/dev/proj', target('/home/dev/proj')) === undefined)
  check('workspace-write allows a path inside the session workspace',
    workspaceWriteScopeRefusal('workspace-write', 'ssh://qiyk/home/dev/proj', target('/home/dev/proj/src/a.js')) === undefined)

  const sibling = workspaceWriteScopeRefusal('workspace-write', 'ssh://qiyk/home/dev/proj', target('/home/dev/other/a.js'))
  check('workspace-write refuses a sibling directory on the same host', sibling !== undefined)
  check('the scope refusal names the workspace it is confined to',
    /ssh:\/\/qiyk\/home\/dev\/proj/u.test(sibling ?? ''), String(sibling))
  check('the scope refusal names the way out', /danger-full-access/u.test(sibling ?? ''), String(sibling))

  const otherHost = workspaceWriteScopeRefusal('workspace-write', 'ssh://qiyk/home/dev/proj', {
    alias: 'other', remotePath: '/srv/app', displayPath: 'ssh://other/srv/app',
  })
  check('workspace-write refuses a mounted root on a DIFFERENT host', otherHost !== undefined)
  check('the cross-host refusal names both hosts',
    /"qiyk"/u.test(otherHost ?? '') && /"other"/u.test(otherHost ?? ''), String(otherHost))

  // `..` must not spell its way out of the workspace.
  check('a traversal spelling is compared after normalisation',
    workspaceWriteScopeRefusal('workspace-write', 'ssh://qiyk/home/dev/proj', {
      alias: 'qiyk', remotePath: '/home/dev/proj/../other/a.js', displayPath: 'ssh://qiyk/home/dev/proj/../other/a.js',
    }) !== undefined)

  // The mode is what decides whether the scope question is even asked: a
  // full-access session may write wherever it likes (subject to the mount fence).
  check('danger-full-access is not scope-checked',
    workspaceWriteScopeRefusal('danger-full-access', 'ssh://qiyk/home/dev/proj', target('/srv/x')) === undefined)
  check('an unconfined deployment is not scope-checked',
    workspaceWriteScopeRefusal(undefined, 'ssh://qiyk/home/dev/proj', target('/srv/x')) === undefined)
  check('a local root leaves the scope unchecked',
    workspaceWriteScopeRefusal('workspace-write', 'F:\\GitHub\\proj', target('/srv/x')) === undefined)

  // The temp area mirrors `writableRoots`' constant `/tmp`: in scope on the
  // session's OWN host, and still bound by the host comparison above.
  check('workspace-write keeps the host temp area in scope',
    workspaceWriteScopeRefusal('workspace-write', 'ssh://qiyk/home/dev/proj', target('/tmp/build.o')) === undefined)
  check('the temp allowance does not extend to another host',
    workspaceWriteScopeRefusal('workspace-write', 'ssh://qiyk/home/dev/proj', {
      alias: 'other', remotePath: '/tmp/build.o', displayPath: 'ssh://other/tmp/build.o',
    }) !== undefined)
  check('a path that only looks like the temp area is still scope-checked',
    workspaceWriteScopeRefusal('workspace-write', 'ssh://qiyk/home/dev/proj', target('/tmpish/build.o')) !== undefined)
}

// ---------------------------------------------------------------------------
// A mode the gate cannot read must not read as permission
// ---------------------------------------------------------------------------
//
// The local sandbox treats anything that is not `danger-full-access` as a
// confining mode, and `writableRoots` returns `[]` for anything that is not
// `workspace-write` — so a `future-mode` write is denied outright there. Skipping
// both fences remotely would make the remote answer WEAKER than the local one for
// the same input, which is the divergence this block pins.
{
  const { writeModeRefusal } = gate
  check('read-only denies a write', writeModeRefusal('read-only', 'ssh://q/y.txt') !== undefined)
  check('the read-only denial names the mode', /read-only/u.test(writeModeRefusal('read-only', 'ssh://q/y.txt') ?? ''))
  check('workspace-write permits a write', writeModeRefusal('workspace-write', 'ssh://q/y.txt') === undefined)
  check('danger-full-access permits a write', writeModeRefusal('danger-full-access', 'ssh://q/y.txt') === undefined)
  // An absent mode is an unconfined deployment, not a denial.
  check('no mode at all is not a denial', writeModeRefusal(undefined, 'ssh://q/y.txt') === undefined)
  check('an empty mode is not a denial', writeModeRefusal('', 'ssh://q/y.txt') === undefined)

  const unknown = writeModeRefusal('future-mode', 'ssh://q/y.txt')
  check('an unrecognised mode denies the write', unknown !== undefined)
  check('the unknown denial quotes the mode it could not read', /future-mode/u.test(unknown ?? ''), String(unknown))
  // It must NOT be dressed up as the user's own choice: switching to `read-only`
  // is not the fix, naming the accepted vocabulary is.
  check('the unknown denial does not claim read-only',
    !/denied under read-only mode/u.test(unknown ?? ''), String(unknown))
  check('the unknown denial names the accepted modes',
    /workspace-write, danger-full-access/u.test(unknown ?? ''), String(unknown))

  // The same answer on the command surface, where an unknown mode used to run
  // the command with the remote user's full permissions.
  const { assertRemoteCommandAllowed, remoteUnknownModeMessage } = gate
  let threw = ''
  try {
    assertRemoteCommandAllowed('future-mode', 'run a remote command', 'ssh://alpha')
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  check('an unrecognised mode refuses a remote command', threw !== '')
  check('the command refusal names the unrecognised mode', /future-mode/u.test(threw), threw)
  check('the command refusal says the local sandbox confines it', /confines any mode/u.test(threw), threw)
  check('an unrecognised mode is not reported as read-only',
    !/sandbox mode is "read-only"/u.test(threw), threw)
  check('the unknown-mode message is its own function',
    /does not recognise/u.test(remoteUnknownModeMessage('run a remote command', 'ssh://alpha', 'future-mode')))
}

// ---------------------------------------------------------------------------
// "The policy could not be read" must not be reported as "you chose read-only"
// ---------------------------------------------------------------------------
//
// `sessionModeOf` fails closed, which is right for a mutation gate — but the
// refusal message used to claim the user had set `read-only`. That is a lie the
// user cannot act on: switching the mode cannot fix a resolver that throws.
//
// The resolver throws for a real reason: `SandboxPolicyService.resolve` runs the
// session cwd through `path.isAbsolute`, and an `ssh://` spelling only reads as
// absolute because `fs-shim.js` patches `node:path`. If that patch is absent —
// a different host build, a load order change — every remote session throws, and
// every remote command is refused while the UI says `danger-full-access`.
{
  const { sessionPolicyOf, remoteReadOnlyMessage } = gate
  const broken = { get: (name) => name === 'sandboxPolicy' ? { resolve: () => { throw new Error('workspace root must be absolute') } } : undefined }
  const policy = sessionPolicyOf(broken, { id: 's1' })
  check('an unresolvable policy still fails closed', policy?.mode === 'read-only')
  check('an unresolvable policy is marked as such', policy?.unresolved === true)
  check('the resolver error travels with the policy', /must be absolute/u.test(policy?.reason ?? ''), String(policy?.reason))

  const wiring = remoteReadOnlyMessage('run a remote command', 'ssh://alpha', { reason: policy?.reason })
  check('the wiring refusal says the policy could not be resolved', /could not be resolved/u.test(wiring), wiring)
  check('the wiring refusal says switching the mode will not help', /switching the session mode will not help/u.test(wiring), wiring)
  check('the wiring refusal does NOT claim the user chose read-only',
    !/the session sandbox mode is "read-only"/u.test(wiring), wiring)
  check('the wiring refusal quotes the underlying error', /must be absolute/u.test(wiring), wiring)

  // The genuine read-only refusal keeps its original wording.
  const chosen = remoteReadOnlyMessage('run a remote command', 'ssh://alpha')
  check('a real read-only refusal still names the mode', /the session sandbox mode is "read-only"/u.test(chosen), chosen)
}

// ---------------------------------------------------------------------------
// The router enforces the scope, not just the helper
// ---------------------------------------------------------------------------
//
// A helper nobody calls is not a fence. These assertions drive the real `ctx.fs`
// router with a real per-call policy and count what reaches the connection layer,
// so "refused" and "never sent" are proven together.
{
  const { RemoteFileSystem } = await import(pathToFileURL(path.join(pluginRoot, 'lib/remote-fs.js')).href)

  const makeRouter = () => {
    const engine = new SshWorkspaceEngine({})
    const reached = { count: 0 }
    engine.withSftp = async () => { reached.count += 1; throw new Error('reached SFTP') }
    const router = new RemoteFileSystem({ engine })
    // Two roots mounted on the session's host, plus one on another host: the
    // mounted set is deliberately wider than the session workspace.
    router.addRoot('qiyk', '/home/dev/proj')
    router.addRoot('qiyk', '/home/dev/sibling')
    router.addRoot('other', '/srv/app')
    return { router, reached }
  }

  const policy = { mode: 'workspace-write', workspaceRoot: 'ssh://qiyk/home/dev/proj' }
  const call = async (spelling) => {
    const { router, reached } = makeRouter()
    let code
    try {
      await router.writeText({ targetKey: spelling, displayPath: spelling }, 'x', undefined, undefined, policy)
    } catch (error) {
      code = error?.code
    }
    return { code, reached: reached.count }
  }

  const inside = await call('ssh://qiyk/home/dev/proj/src/a.js')
  check('workspace-write reaches SFTP for a target inside the session workspace',
    inside.reached === 1, `withSftp=${inside.reached} code=${String(inside.code)}`)

  const sibling = await call('ssh://qiyk/home/dev/sibling/a.js')
  check('workspace-write refuses a sibling MOUNTED root', sibling.code === 'FS_SANDBOX_DENIED', String(sibling.code))
  check('the refused sibling never reached SFTP', sibling.reached === 0, `withSftp=${sibling.reached}`)

  const crossHost = await call('ssh://other/srv/app/a.js')
  check('workspace-write refuses a mounted root on another host', crossHost.code === 'FS_SANDBOX_DENIED', String(crossHost.code))
  check('the refused cross-host write never reached SFTP', crossHost.reached === 0, `withSftp=${crossHost.reached}`)

  // A session that has not been given a cwd (an agentless call) resolves the
  // deployment's LOCAL root; it must not narrow the mounted fence into a blanket
  // refusal.
  {
    const { router, reached } = makeRouter()
    let code
    try {
      await router.writeText({ targetKey: 'ssh://qiyk/home/dev/sibling/a.js', displayPath: 'ssh://qiyk/home/dev/sibling/a.js' },
        'x', undefined, undefined, { mode: 'workspace-write', workspaceRoot: 'F:\\GitHub\\proj' })
    } catch (error) {
      code = error?.code
    }
    check('a local workspace root does not narrow remote writes',
      reached.count === 1, `withSftp=${reached.count} code=${String(code)}`)
  }

  // danger-full-access is not scope-checked but is still mount-fenced. `/srv`
  // is the exemplar because it is on a SERVED host yet outside every root; the
  // host temp area is deliberately not, since `writableRoots` on the local side
  // lists `/tmp` and the remote fence mirrors that (see the pair below).
  {
    const { router, reached } = makeRouter()
    let code
    try {
      await router.writeText({ targetKey: 'ssh://qiyk/srv/x.txt', displayPath: 'ssh://qiyk/srv/x.txt' },
        'x', undefined, undefined, { mode: 'danger-full-access', workspaceRoot: 'ssh://qiyk/home/dev/proj' })
    } catch (error) {
      code = error?.code
    }
    check('danger-full-access is still stopped by the MOUNT fence, not the scope',
      code === 'FS_OUTSIDE_WORKSPACE', String(code))
    check('the mount-fence refusal raised its own code', reached.count === 0, `withSftp=${reached.count}`)
  }

  // The temp area is reachable under the same mode, and under
  // `workspace-write` it is in scope even though it is not inside the session
  // workspace — the remote counterpart of `writableRoots`' `/tmp` entry.
  {
    const { router, reached } = makeRouter()
    let code
    try {
      await router.writeText({ targetKey: 'ssh://qiyk/tmp/stage.o', displayPath: 'ssh://qiyk/tmp/stage.o' },
        'x', undefined, undefined, policy)
    } catch (error) {
      code = error?.code
    }
    check('workspace-write writes to the host temp area', reached.count === 1 && code === undefined,
      `withSftp=${reached.count} code=${String(code)}`)
  }
  {
    const { router } = makeRouter()
    let code
    try {
      await router.writeText({ targetKey: 'ssh://other/tmp/stage.o', displayPath: 'ssh://other/tmp/stage.o' },
        'x', undefined, undefined, policy)
    } catch (error) {
      code = error?.code
    }
    check('the temp allowance does not reach ANOTHER host', code === 'FS_SANDBOX_DENIED', String(code))
  }
  {
    const { router, reached } = makeRouter()
    let code
    try {
      await router.writeText({ targetKey: 'ssh://qiyk/tmp/stage.o', displayPath: 'ssh://qiyk/tmp/stage.o' },
        'x', undefined, undefined, { mode: 'danger-full-access', workspaceRoot: 'ssh://qiyk/home/dev/proj' })
    } catch (error) {
      code = error?.code
    }
    check('danger-full-access reaches the host temp area too', reached.count === 1 && code === undefined,
      `withSftp=${reached.count} code=${String(code)}`)
  }

  // The router and the transfer tool resolve the mode through different carriers
  // (a fifth argument here, the policy service there), so each needs its own
  // proof that an unreadable mode denies rather than defaults to permission.
  {
    const { router, reached } = makeRouter()
    let code
    try {
      await router.writeText({ targetKey: 'ssh://qiyk/home/dev/proj/x.txt', displayPath: 'ssh://qiyk/home/dev/proj/x.txt' },
        'x', undefined, undefined, { mode: 'future-mode', workspaceRoot: 'ssh://qiyk/home/dev/proj' })
    } catch (error) {
      code = error?.code
    }
    check('the router refuses a write under an unrecognised mode', code === 'FS_SANDBOX_DENIED', String(code))
    check('the refused unknown-mode write never reached SFTP', reached.count === 0, `withSftp=${reached.count}`)
  }
}

// ---------------------------------------------------------------------------
// ssh_workspace_exec: the surface that actually let the `rm` through
// ---------------------------------------------------------------------------
{
  const modeOf = { current: 'read-only' }
  const policyCtx = {
    get (name) {
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: modeOf.current, workspaceRoot: '/local' }) }
      return undefined
    },
  }

  // An engine that records every call reaching the connection layer: the point
  // is not only that the call is refused, but that NOTHING was sent to the host.
  const makeEngine = () => {
    const engine = new SshWorkspaceEngine({})
    const reached = { count: 0 }
    engine.exec = async () => { reached.count += 1; return { success: true, exitCode: 0, stdout: '', stderr: '', timedOut: false, truncated: false, durationMs: 0 } }
    engine.acquire = async () => { reached.count += 1; throw new Error('reached the connection layer') }
    engine.assertNotDisabled = () => {}
    return { engine, reached }
  }

  const toolOf = (ctx, engine) => workspaceTools(ctx, engine, undefined, { list: () => [] }, { list: () => [] })
    .find(tool => tool.name === 'ssh_workspace_exec')

  {
    const { engine, reached } = makeEngine()
    const result = await toolOf(policyCtx, engine).execute(
      { alias: 'qiyk', command: 'rm /home/qiyk/test/test.py' },
      { agent: { session: { id: 's1' } } },
    )
    // The exact regression: this used to return success with exit 0.
    check('a read-only session cannot run a remote command', result.success === false, JSON.stringify(result))
    check('the refused command reports the mode', /read-only/u.test(result.error ?? ''), String(result.error))
    check('the refused command never reached the host', reached.count === 0, `reached=${reached.count}`)
  }

  // A `cwd` inside a DETACHED workspace is a separate fence; the mode gate must
  // not mask it. Both refuse, but the detached message is the actionable one.
  {
    const { engine } = makeEngine()
    modeOf.current = 'workspace-write'
    engine.assertNotDisabled = () => { throw new Error('the remote workspace is detached') }
    const result = await toolOf(policyCtx, engine).execute(
      { alias: 'qiyk', command: 'ls', cwd: '/home/qiyk/test' },
      { agent: { session: { id: 's1' } } },
    )
    check('the detached fence still reports itself', /detached/u.test(result.error ?? ''), String(result.error))
  }

  // A mode the plugin cannot read is refused on the command surface too, and
  // with a DIFFERENT sentence than `read-only`: telling the model "view only"
  // would send it to a mode switch that is not the problem.
  {
    const { engine, reached } = makeEngine()
    modeOf.current = 'future-mode'
    const result = await toolOf(policyCtx, engine).execute(
      { alias: 'qiyk', command: 'rm -rf /home/qiyk/test' },
      { agent: { session: { id: 's1' } } },
    )
    check('an unrecognised mode cannot run a remote command', result.success === false, JSON.stringify(result))
    check('the unknown-mode command refusal names the mode', /future-mode/u.test(result.error ?? ''), String(result.error))
    // The accepted vocabulary is listed, so the word "read-only" appears; what
    // must NOT appear is the claim that the session is *in* that mode.
    check('the unknown-mode command refusal does not claim read-only',
      !/sandbox mode is "read-only"/u.test(result.error ?? ''), String(result.error))
    check('the refused unknown-mode command never reached the host', reached.count === 0, `reached=${reached.count}`)
  }

  // Every non-read-only mode keeps working — the gate must not break the tool.
  for (const mode of ['workspace-write', 'danger-full-access']) {
    const { engine, reached } = makeEngine()
    modeOf.current = mode
    const result = await toolOf(policyCtx, engine).execute(
      { alias: 'qiyk', command: 'uname -a' },
      { agent: { session: { id: 's1' } } },
    )
    check(`${mode} still runs a remote command`, result.success === true, JSON.stringify(result))
    check(`${mode} did reach the host`, reached.count === 1, `reached=${reached.count}`)
  }

  // A deployment with no policy service at all must behave as it always did.
  {
    const { engine, reached } = makeEngine()
    const result = await toolOf({ get: () => undefined }, engine).execute(
      { alias: 'qiyk', command: 'uname -a' }, {},
    )
    check('an unconfined deployment still runs commands', result.success === true, JSON.stringify(result))
    check('an unconfined deployment reached the host', reached.count === 1, `reached=${reached.count}`)
  }

  // The background path shares the same entry point, so it is refused too:
  // a job that would have run the deletion is exactly the case worth pinning.
  {
    const { engine, reached } = makeEngine()
    modeOf.current = 'read-only'
    const result = await toolOf(policyCtx, engine).execute(
      { alias: 'qiyk', command: 'rm -rf /home/qiyk/test', run_in_background: true },
      { agent: { session: { id: 's1' } } },
    )
    check('a read-only session cannot queue a background remote command', result.success === false, JSON.stringify(result))
    check('the refused background command never reached the host', reached.count === 0, `reached=${reached.count}`)
  }
}

// ---------------------------------------------------------------------------
// ssh_workspace_shell: the persistent PTY is the same act, one seam over
// ---------------------------------------------------------------------------
{
  const modeOf = { current: 'read-only' }
  const policyCtx = {
    get (name) {
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: modeOf.current, workspaceRoot: '/local' }) }
      return undefined
    },
  }
  const shells = {
    run: async () => { throw new Error('reached the shell manager') },
    close: () => 1,
    list: () => [],
  }
  const tool = workspaceTools(policyCtx, new SshWorkspaceEngine({}), undefined, { list: () => [] }, shells)
    .find(entry => entry.name === 'ssh_workspace_shell')
  check('the persistent shell tool is registered when a manager exists', tool !== undefined)

  const refused = await tool.execute({ alias: 'qiyk', command: 'rm -rf /home/qiyk/test' }, { agent: { session: { id: 's1' } } })
  check('a read-only session cannot run a persistent remote command', refused.ok === false, JSON.stringify(refused))
  check('the persistent refusal names the mode', /read-only/u.test(refused.error ?? ''), String(refused.error))

  // Closing a session mutates nothing on the host, so it must stay available:
  // otherwise "view only" would also mean "cannot end the shell you already
  // have open", which is a resource leak with no way out.
  const closed = await tool.execute({ alias: 'qiyk', close: true }, { agent: { session: { id: 's1' } } })
  check('read-only can still CLOSE a remote shell', closed.ok === true, JSON.stringify(closed))

  modeOf.current = 'danger-full-access'
  let reachedShell = false
  const allowedTool = workspaceTools(policyCtx, new SshWorkspaceEngine({}), undefined, { list: () => [] }, {
    run: async () => { reachedShell = true; return { output: '', exitCode: 0, reused: false } },
    close: () => 0,
    list: () => [],
  }).find(entry => entry.name === 'ssh_workspace_shell')
  const allowed = await allowedTool.execute({ alias: 'qiyk', command: 'uname -a' }, { agent: { session: { id: 's1' } } })
  check('danger-full-access still runs a persistent command', allowed.ok === true, JSON.stringify(allowed))
  check('the allowed persistent command reached the manager', reachedShell)
}

// ---------------------------------------------------------------------------
// The ctx.shell seam: bash / pwsh with an ssh:// workdir
// ---------------------------------------------------------------------------
//
// This is how the harness's OWN command tools reach a host. They resolve the
// per-call policy and stamp it on the spec, but the only thing that would have
// ACTED on it is the local executor's kernel wrap — which is exactly what the
// remote half replaces. So the check has to live in this half.
{
  const { engine, reached } = (() => {
    const e = new SshWorkspaceEngine({})
    const r = { count: 0 }
    e.acquire = async () => { r.count += 1; throw new Error('reached the connection layer') }
    e.openChannel = async () => { r.count += 1; throw new Error('reached the connection layer') }
    e.disabledWorkspaces = new Set()
    return { engine: e, reached: r }
  })()

  const target = { execute: async () => ({ status: 'completed', exitCode: 0 }) }
  const router = installRemoteShell({ get: (name) => (name === 'shell' ? target : undefined) }, { engine })
  check('installing the shell seam returns a router', router !== undefined)

  const spec = (mode) => ({
    workdir: 'ssh://alpha/home/dev/proj',
    command: 'rm -rf /home/dev/proj',
    timeoutMs: 0,
    onExpiry: 'none',
    ...(mode === undefined ? {} : { sandboxPolicy: { mode, workspaceRoot: '/local' } }),
  })

  let refusal = ''
  try {
    await target.execute(spec('read-only'))
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error)
  }
  check('a read-only bash/pwsh spec is refused', refusal !== '')
  check('the shell refusal names the mode', /read-only/u.test(refusal), refusal)
  check('the refused shell spec never opened a connection', reached.count === 0, `reached=${reached.count}`)

  for (const mode of ['workspace-write', 'danger-full-access', undefined]) {
    let threw = ''
    try {
      await target.execute(spec(mode))
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error)
    }
    // These reach the connection layer (which the double makes throw), so a
    // mode refusal would show up as a different message. Assert on THAT text.
    check(`${String(mode)} is not refused by the mode gate`, !/read-only/u.test(threw), threw)
  }

  // The seam must forward a LOCAL workdir to the original executor unchanged,
  // policy and all — the gate lives in the remote half only.
  let localSeen
  const localTarget = { execute: async (s) => { localSeen = s; return { status: 'completed' } } }
  installRemoteShell({ get: () => localTarget }, { engine: new SshWorkspaceEngine({}) })
  await localTarget.execute({ workdir: 'C:/local', command: 'echo hi', sandboxPolicy: { mode: 'read-only' } })
  check('a local workdir is forwarded, not gated', localSeen?.workdir === 'C:/local', JSON.stringify(localSeen))
}

// ---------------------------------------------------------------------------
// The terminal seam: a remote PTY is unconfined command execution too
// ---------------------------------------------------------------------------
//
// This path was ungated for a structural reason worth pinning: a terminal is
// opened through `ctx.subprocess.spawnTerminal`, whose spec carries no owner,
// so the gate cannot live there. It is also NOT reachable through a single
// `ctx.terminals.spawn` hook — the sidebar's browser terminal
// (`dsh-api-terminal-controller`) calls `spawnTerminal` DIRECTLY, with no
// `ctx.terminals` involved. Putting the gate on `ctx.terminals` would have left
// that path open while the test for the tool path went green.
//
// So the gate sits in the router, the one point both paths converge on, and
// resolves the session from `spec.env.DSH_SESSION_ID` (both callers stamp it).
{
  const { RemoteTerminalRouter } = await import(pathToFileURL(path.join(pluginRoot, 'lib/patch-terminal.js')).href)

  const modeOf = { current: 'read-only' }
  const session = { id: 's1', header: { cwd: 'ssh://alpha/home/dev/proj' } }
  const ctx = {
    get (name) {
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: modeOf.current, workspaceRoot: '/local' }) }
      if (name === 'agents') return { get: (id) => (id === 's1' ? { session } : undefined) }
      return undefined
    },
  }

  // An engine whose connection layer counts calls: "refused" is only meaningful
  // together with "nothing reached the host".
  const makeTermEngine = () => {
    const e = new SshWorkspaceEngine({})
    const reached = { count: 0 }
    e.assertNotDisabled = () => {}
    e.openChannel = async () => {
      reached.count += 1
      return { channel: new (class { on () {} once () {} write (_d, cb) { cb?.() } close () {} })(), release: () => {} }
    }
    return { engine: e, reached }
  }

  const specFor = (mode) => ({ cwd: 'ssh://alpha/home/dev/proj', rows: 24, cols: 80, env: { DSH_SESSION_ID: 's1' }, ...(mode === undefined ? {} : { sandboxPolicy: { mode } }) })

  {
    const { engine, reached } = makeTermEngine()
    const router = new RemoteTerminalRouter({ engine, ctx })
    let refusal = ''
    try {
      await router.spawnTerminal(specFor('read-only'))
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error)
    }
    check('a read-only session cannot open a remote terminal', refusal !== '', 'the PTY was opened')
    check('the terminal refusal names the action', /open a remote terminal/u.test(refusal), refusal)
    check('the terminal refusal names the target', /ssh:\/\/alpha\/home\/dev\/proj/u.test(refusal), refusal)
    // The whole point: no socket. A refusal after connecting still runs `sh -l`.
    check('the refused terminal never opened a channel', reached.count === 0, `reached=${reached.count}`)
  }

  // Every other mode must keep working — the gate must not break terminals.
  for (const mode of ['workspace-write', 'danger-full-access']) {
    const { engine, reached } = makeTermEngine()
    modeOf.current = mode
    const router = new RemoteTerminalRouter({ engine, ctx })
    let threw = ''
    try {
      await router.spawnTerminal(specFor(mode))
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error)
    }
    check(`${mode} still opens a remote terminal`, threw === '', threw)
    check(`${mode} reached the host for the terminal`, reached.count === 1, `reached=${reached.count}`)
  }

  // A session with no id in the spec falls back to the deployment default,
  // which is the policy service's own answer — NOT a guessed refusal.
  {
    const { engine, reached } = makeTermEngine()
    modeOf.current = 'danger-full-access'
    const router = new RemoteTerminalRouter({ engine, ctx })
    await router.spawnTerminal({ cwd: 'ssh://alpha/home/dev/proj', rows: 24, cols: 80 })
    check('a terminal spec without a session still resolves a mode', reached.count === 1, `reached=${reached.count}`)
  }

  // The second half of the gate: a PTY opened legitimately, then narrowed.
  // Refusing only the open would leave this shell typing happily into the host.
  {
    const { engine } = makeTermEngine()
    modeOf.current = 'workspace-write'
    const router = new RemoteTerminalRouter({ engine, ctx })
    const handle = await router.spawnTerminal(specFor('workspace-write'))

    // Still permitted while the mode allows it.
    let writeThrew = ''
    try {
      await handle.write('ls\n')
    } catch (error) {
      writeThrew = error instanceof Error ? error.message : String(error)
    }
    check('workspace-write can type into its own remote terminal', writeThrew === '', writeThrew)

    modeOf.current = 'read-only'
    let afterSwitch = ''
    try {
      await handle.write('rm -rf /home/dev/proj\n')
    } catch (error) {
      afterSwitch = error instanceof Error ? error.message : String(error)
    }
    check('a terminal opened before the switch stops accepting commands', afterSwitch !== '', 'the write was accepted')
    check('the write refusal names the mode', /read-only/u.test(afterSwitch), afterSwitch)

    // Control bytes must survive: SIGINT and the close path have to work, or
    // "view only" also means "cannot stop what you already started".
    modeOf.current = 'read-only'
    let controlThrew = ''
    try {
      await handle.write('\u0003')
    } catch (error) {
      controlThrew = error instanceof Error ? error.message : String(error)
    }
    check('read-only can still send SIGINT to a remote terminal', controlThrew === '', controlThrew)
  }
}

// ---------------------------------------------------------------------------
// The model-facing announcement must not contradict the code
// ---------------------------------------------------------------------------
//
// A refusal the model was told not to expect is retried. The old announcement
// said remote commands ignore the sandbox policy — true when written, false
// once the gate exists, and exactly the kind of stale sentence that turns a
// policy denial into a bug report.
{
  const source = await import('node:fs').then(fs => fs.promises.readFile(path.join(pluginRoot, 'lib/index.js'), 'utf8'))
  check('the announcement says read-only blocks remote commands',
    /仅可查看.*远端写入与命令执行都被拒绝|远端写入与命令执行都被拒绝/u.test(source),
    'lib/index.js announcement no longer states the command gate')
  check('the announcement no longer claims the policy is ignored',
    !/本机沙箱策略（sandbox_permissions）不适用于远端命令。'/.test(source) ||
      /因此\*\*会话处于/u.test(source),
    'the announcement still reads as "policy not applied"')
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
process.exit(failures === 0 ? 0 : 1)
