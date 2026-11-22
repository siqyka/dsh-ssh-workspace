/**
 * `ctx.ptcRuntime.resolve` and an `ssh://` session.
 *
 * The bug this suite pins: a PTC provider defaults its worker's `cwd` to
 * `sandboxPolicy.resolve().workspaceRoot` — the `ssh://` spelling for a remote
 * session. The host worker is spawned through `ctx.subprocess.spawn`, whose
 * remote bridge refuses anything but git/ripgrep, so `run_code` failed with
 *
 *   ssh-workspace: cannot run "…DeepSeek Harness.exe" with a remote cwd
 *
 * and, had it started, every evaluation would have called
 * `process.chdir('ssh://…')` inside the child and failed the same way
 * (`<cwd>\\ssh:\\…` is not a legal Windows path). Localizing the spec's cwd is
 * the one point BOTH the spawn and the per-evaluation chdir read from.
 *
 * The properties asserted here are the ones that keep that honest:
 *
 *  - a remote spec cwd becomes an existing, absolute, LOCAL directory — the
 *    same substitute root patch-sandbox.js hands the sandbox provider;
 *  - a local spec is returned BY IDENTITY: an ordinary session's PTC behavior
 *    (including its object identity) is untouched;
 *  - the consumer's request reaches the provider's own `resolve` unchanged
 *    and is bound to the service (`this` is still the provider);
 *  - every other spec field survives, including the `sandboxPolicy` object
 *    itself (the mode gates and the sandbox patch compare against the
 *    original, remote-spelled policy);
 *  - a provider answer that is not a spec passes through unrewritten;
 *  - installing twice does not double-wrap, and uninstalling restores the
 *    provider's own `resolve` — whether it lived on the prototype or the
 *    instance.
 *
 * Run: node tests/patch-ptc-smoke.mjs
 */

import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createHost } from './support/plugin-host.mjs'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const {
  INSTALLED,
  installRemotePtc,
  uninstallRemotePtc,
} = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'patch', 'patch-ptc.js')).href)
const { substituteWorkspaceRoot } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'patch', 'patch-sandbox.js')).href)
const { isRemotePath } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'core', 'protocol.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const REMOTE_ROOT = 'ssh://qiyk/home/qiyk/test/dsh-ssh-workspace'
const LOCAL_ROOT = path.join(tmpdir(), 'not-a-real-ptc-session')

/**
 * A provider shaped like the mounted `ctx.ptcRuntime` service, with `resolve`
 * on the PROTOTYPE — how the abstract `PtcRuntime` base declares it.
 *
 * @param {(request: object) => object} [answer] - overrides the spec builder.
 */
function fakeProvider (answer) {
  const calls = []
  class FakeProvider {
    resolve (request) {
      calls.push({ request, self: this })
      if (answer !== undefined) return answer(request)
      return { ...request, cwd: request.cwd ?? REMOTE_ROOT, timeoutMs: 60_000 }
    }
  }
  const service = new FakeProvider()
  return { service, calls }
}

/**
 * One host whose only service is (or is not) `ptcRuntime`.
 *
 * The shared double rather than an object literal: a missing service must read
 * as `undefined` through a host that REFUSES reads after disposal, so a suite
 * cannot accidentally keep patching a torn-down fiber.
 */
function fakeCtx (service) {
  return createHost(service === undefined ? {} : { services: { ptcRuntime: service } }).ctx
}

console.log('\n[resolving a remote cwd]')
{
  const { service, calls } = fakeProvider()
  const router = installRemotePtc(fakeCtx(service))
  check('install returns the router', router !== undefined && router.localized === 0, String(router?.localized))

  const request = { program: 'return 1', bindings: [], cwd: REMOTE_ROOT }
  const spec = service.resolve(request)
  check('the remote cwd is replaced with the sandbox substitute root',
    spec.cwd === substituteWorkspaceRoot(), String(spec.cwd))
  check('the replacement is no longer a remote spelling', !isRemotePath(spec.cwd), String(spec.cwd))
  check('the replacement exists on this machine', existsSync(spec.cwd), String(spec.cwd))
  check('the replacement is a directory', statSync(spec.cwd).isDirectory(), String(spec.cwd))
  check('the replacement is absolute', path.isAbsolute(spec.cwd), String(spec.cwd))
  check('the replacement lives under the platform temp root (and is not the root itself)',
    spec.cwd.startsWith(tmpdir()) && spec.cwd !== tmpdir(), `${spec.cwd} vs ${tmpdir()}`)
  check('the program and bindings survive the rewrite',
    spec.program === 'return 1' && Array.isArray(spec.bindings), JSON.stringify({ program: spec.program, bindings: spec.bindings }))
  check('the timeout survives the rewrite', spec.timeoutMs === 60_000, String(spec.timeoutMs))
  check('the consumer request is what the provider saw, by identity',
    calls.length === 1 && calls[0].request === request, String(calls.length))
  check('the provider method still runs bound to the service',
    calls[0].self === service, String(calls[0].self === service))
  check('the original request object is not mutated', request.cwd === REMOTE_ROOT, String(request.cwd))
  check('the localized spec is a new object (the provider spec is not mutated)',
    spec !== calls[0]?.request, 'same object')
  check('the router records one localization', router.localized === 1, String(router.localized))
}

console.log('\n[local sessions are untouched]')
{
  const { service } = fakeProvider()
  const router = installRemotePtc(fakeCtx(service))
  const request = { program: 'return 2', bindings: [], cwd: LOCAL_ROOT }
  const spec = service.resolve(request)
  check('a local cwd is returned by identity (no copy, no rewrite)', spec.cwd === LOCAL_ROOT, String(spec.cwd))
  check('a local spec is not counted as localized', router.localized === 0, String(router.localized))
}

console.log('\n[sandboxPolicy keeps the remote spelling]')
{
  const { service } = fakeProvider()
  installRemotePtc(fakeCtx(service))
  const policy = { mode: 'workspace-write', workspaceRoot: REMOTE_ROOT, sessionId: 's-1' }
  const spec = service.resolve({ program: 'return 3', bindings: [], cwd: REMOTE_ROOT, sandboxPolicy: policy })
  check('the policy object survives by identity (mode gates compare against it)',
    spec.sandboxPolicy === policy, 'policy was replaced')
  check('the policy workspace root is still the remote spelling',
    spec.sandboxPolicy.workspaceRoot === REMOTE_ROOT, String(spec.sandboxPolicy.workspaceRoot))
  check('the spec cwd is the local substitute, not the policy root',
    spec.cwd === substituteWorkspaceRoot() && spec.cwd !== policy.workspaceRoot, String(spec.cwd))
}

console.log('\n[provider answers the wrapper does not understand]')
{
  const { service } = fakeProvider(() => undefined)
  installRemotePtc(fakeCtx(service))
  check('a non-object answer is passed through unchanged',
    service.resolve({ program: 'x', bindings: [] }) === undefined, 'answer was rewritten')

  const throwing = {
    resolve () { throw new Error('ptc-runtime-node: cwd must be absolute') },
  }
  installRemotePtc(fakeCtx(throwing))
  let thrown
  try { throwing.resolve({ program: 'x', bindings: [] }) } catch (error) { thrown = error }
  check('a throwing resolve still throws (this wrapper adds no fallback)',
    thrown instanceof Error && thrown.message === 'ptc-runtime-node: cwd must be absolute', String(thrown?.message))
}

console.log('\n[install twice, uninstall, reinstall]')
{
  const { service, calls } = fakeProvider()
  const ctx = fakeCtx(service)
  const first = installRemotePtc(ctx)
  const second = installRemotePtc(ctx)
  check('a second install returns the same router', first === second && first !== undefined)
  service.resolve({ program: 'x', bindings: [], cwd: REMOTE_ROOT })
  check('a second install does not double-wrap: the provider runs once per call',
    calls.length === 1, String(calls.length))
  check('the wrapper is an own property of the service', Object.hasOwn(service, 'resolve'))
  check('the install marker is on the service', service[INSTALLED] === first)

  uninstallRemotePtc(service)
  check('uninstall removes the install marker', service[INSTALLED] === undefined)
  check('uninstall drops the own wrapper so the prototype method shows through again',
    !Object.hasOwn(service, 'resolve'), 'resolve is still an own property')
  const after = service.resolve({ program: 'x', bindings: [], cwd: REMOTE_ROOT })
  check('after uninstall the remote spelling is no longer localized',
    after.cwd === REMOTE_ROOT, String(after.cwd))

  const third = installRemotePtc(ctx)
  check('reinstall after uninstall wraps the restored prototype method',
    third !== undefined && third.localized === 0, String(third?.localized))
  check('reinstall localizes again', service.resolve({ program: 'x', bindings: [], cwd: REMOTE_ROOT }).cwd === substituteWorkspaceRoot())
  uninstallRemotePtc(service)
}

console.log('\n[an own resolve property is restored exactly]')
{
  const ownResolve = function (request) { return { ...request, cwd: REMOTE_ROOT, timeoutMs: 1 } }
  const service = { resolve: ownResolve }
  installRemotePtc(fakeCtx(service))
  check('an own resolve is wrapped', service.resolve !== ownResolve)
  uninstallRemotePtc(service)
  check('uninstall puts the exact own function back', service.resolve === ownResolve)
  check('the service keeps resolve as an own property',
    Object.hasOwn(service, 'resolve') && typeof service.resolve === 'function')
}

console.log('\n[guards]')
{
  const missing = installRemotePtc(fakeCtx(undefined))
  check('no ptcRuntime service means no router', missing === undefined, String(missing))
  const noResolve = { resolve: undefined }
  let thrown
  try { installRemotePtc(fakeCtx(noResolve)) } catch (error) { thrown = error }
  check('a service without resolve() is a loud install failure',
    thrown instanceof Error && thrown.message.includes('no resolve() to wrap'), String(thrown?.message))
  uninstallRemotePtc(undefined)
  uninstallRemotePtc({})
  check('uninstalling an unpatched service is a no-op',
    true, 'no throw')
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
if (failures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}
