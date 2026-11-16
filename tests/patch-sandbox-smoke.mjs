/**
 * The local sandbox provider and an `ssh://` workspace root.
 *
 * The bug this suite pins: every command path calls
 * `ctx.sandbox.confine(argv, policy, signal)` BEFORE it reaches any seam this
 * plugin owns, and `policy.workspaceRoot` is `sandboxPolicy.resolve()`'s answer
 * — for a remote session, the `ssh://` spelling. The Windows ACL provider then
 * realpaths that spelling as a host path and fails closed:
 *
 *   sandbox-local: windows-acl workspace and temp directory resolution failed:
 *   Error: ENOENT … realpath 'C:\Users\…\ssh:\qiyk\home\qiyk\test\dsh-ssh-workspace'
 *
 * so no remote command ever started. The properties asserted here are the ones
 * that keep the fix honest:
 *
 *  - a remote root reaches the provider as a real, existing, ABSOLUTE local
 *    directory (the only thing every dialect can resolve);
 *  - that directory is a CHILD of the temp root, never the temp root itself —
 *    the ACL provider refuses a workspace that contains the temp dir;
 *  - the substitute root is stable across calls (the provider caches grants per
 *    root; a random one per call would leak a standing ACE per command);
 *  - a LOCAL policy is passed through by identity — no copy, no rewrite, so a
 *    local command's confinement is exactly what it was;
 *  - remote entries in `additionalWritableRoots` are dropped, local ones kept;
 *  - mode and sessionId survive the rewrite, because the mode is the whole
 *    point of the policy;
 *  - the wrapper passes the provider's return value through unchanged (sync
 *    stays sync, a promise stays a promise) and forwards argv and signal;
 *  - installing twice does not double-wrap, and uninstalling restores the
 *    provider's own `confine`.
 *
 * Run: node tests/patch-sandbox-smoke.mjs
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const {
  INSTALLED,
  installRemoteSandbox,
  uninstallRemoteSandbox,
  localizePolicy,
  substituteWorkspaceRoot,
} = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'patch-sandbox.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const REMOTE_ROOT = 'ssh://qiyk/home/qiyk/test/dsh-ssh-workspace'

/** A provider instance shaped like the mounted `ctx.sandbox` service. */
function fakeProvider () {
  const calls = []
  const service = {
    confine (argv, policy, signal) {
      calls.push({ argv, policy, signal })
      return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
    },
  }
  return { service, calls }
}

console.log('\n[substitute root]')
{
  const root = substituteWorkspaceRoot()
  check('the substitute root exists', existsSync(root), root)
  check('it is a directory', statSync(root).isDirectory(), root)
  check('it is absolute', path.isAbsolute(root), root)
  check('it lives under the platform temp root',
    root.startsWith(tmpdir()) && root !== tmpdir(),
    `root=${root} tmp=${tmpdir()}`)
  // The ACL provider throws SANDBOX_INVALID_TEMP_ROOT when the workspace
  // CONTAINS the temp root (a private temp child would inherit the workspace
  // grant). `relative(root, tmpdir())` must therefore be `..`, i.e. the root is
  // a child of temp and not temp itself.
  const relation = path.relative(root, tmpdir())
  check('the temp root is OUTSIDE the substitute root',
    relation === '..' || relation.startsWith('..' + path.sep) || path.isAbsolute(relation),
    `relative(substitute, tmpdir()) = ${relation}`)
  check('the substitute root is not the workspace path it replaces', root !== REMOTE_ROOT)
  check('asking twice returns the same root (the provider caches grants per root)',
    substituteWorkspaceRoot() === root)
  // Stability across a freshly evaluated copy of the module, not just across
  // two calls to one copy: the provider keys its grant cache on the ROOT PATH,
  // so a name derived from anything per-load (a uuid, a counter, the pid) would
  // leave one standing ACE behind per command. A `?fresh` import re-runs the
  // module body with a new `substituteRoot` initialiser.
  const fresh = await import(
    pathToFileURL(path.join(pluginRoot, 'lib', 'patch-sandbox.js')).href + '?fresh=1'
  )
  check('the substitute root is stable across module evaluation (not random per process or per call)',
    fresh.substituteWorkspaceRoot() === root,
    `${fresh.substituteWorkspaceRoot()} vs ${root}`)
}

console.log('\n[policy localization]')
{
  const local = { mode: 'workspace-write', workspaceRoot: 'F:\\GitHub\\dsh-ssh-workspace', sessionId: 's-1' }
  const localCopy = localizePolicy(local)
  check('a purely local policy is returned by identity (no copy at all)', localCopy === local)

  const remote = { mode: 'workspace-write', workspaceRoot: REMOTE_ROOT, sessionId: 's-2' }
  const rewritten = localizePolicy(remote)
  check('a remote root is replaced with the local substitute',
    rewritten.workspaceRoot === substituteWorkspaceRoot(), String(rewritten.workspaceRoot))
  check('the rewritten root no longer reads as a remote spelling',
    !String(rewritten.workspaceRoot).startsWith('ssh://'))
  check('the mode survives the rewrite', rewritten.mode === 'workspace-write', String(rewritten.mode))
  check('the session identity survives the rewrite', rewritten.sessionId === 's-2', String(rewritten.sessionId))
  check('the input policy is not mutated',
    remote.workspaceRoot === REMOTE_ROOT && remote.mode === 'workspace-write')
  check('a remote policy is NOT returned by identity (there was work to do)', rewritten !== remote)

  const withExtras = localizePolicy({
    mode: 'workspace-write',
    workspaceRoot: 'F:\\repo',
    additionalWritableRoots: ['F:\\repo\\.git', 'ssh://qiyk/home/qiyk/.git'],
  })
  check('a remote extra root is dropped',
    !withExtras.additionalWritableRoots.includes('ssh://qiyk/home/qiyk/.git'),
    JSON.stringify(withExtras.additionalWritableRoots))
  check('a local extra root is kept',
    withExtras.additionalWritableRoots.includes('F:\\repo\\.git'),
    JSON.stringify(withExtras.additionalWritableRoots))

  const allRemote = localizePolicy({
    mode: 'workspace-write',
    workspaceRoot: 'F:\\repo',
    additionalWritableRoots: ['ssh://qiyk/a'],
  })
  check('dropping every extra root still leaves a well-formed array',
    Array.isArray(allRemote.additionalWritableRoots) && allRemote.additionalWritableRoots.length === 0,
    JSON.stringify(allRemote.additionalWritableRoots))

  check('a policy with no extra roots stays unchanged in shape',
    !Object.hasOwn(localizePolicy({ mode: 'read-only', workspaceRoot: 'F:\\repo' }), 'additionalWritableRoots'))
  check('a null policy is passed through', localizePolicy(null) === null)
}

console.log('\n[install / uninstall]')
{
  const { service, calls } = fakeProvider()
  const ctx = { get (name) { return name === 'sandbox' ? service : undefined } }
  const router = installRemoteSandbox(ctx, {})
  check('installing returns a router', router !== undefined)

  const argv = ['C:\\Windows\\System32\\cmd.exe', '/c', 'dir']
  const signal = new AbortController().signal
  const confined = await service.confine(argv, { mode: 'workspace-write', workspaceRoot: REMOTE_ROOT, sessionId: 's' }, signal)
  check('the provider was called exactly once', calls.length === 1, String(calls.length))
  check('the provider received the substitute root, not the ssh:// spelling',
    calls[0].policy.workspaceRoot === substituteWorkspaceRoot(), String(calls[0].policy.workspaceRoot))
  check('the argv is forwarded untouched', calls[0].argv === argv)
  check('the signal is forwarded untouched', calls[0].signal === signal)
  check('the provider\'s return value is passed through', confined.enforcement === 'full')
  check('the router counts the localization it did', router.localized === 1, String(router.localized))

  const before = calls.length
  await service.confine(argv, { mode: 'workspace-write', workspaceRoot: 'F:\\repo' })
  check('a local call still reaches the provider', calls.length === before + 1)
  check('a local call is not counted as localized', router.localized === 1, String(router.localized))

  check('installing twice does not double-wrap', installRemoteSandbox(ctx, {}) === router)
  check('the service carries the marker', service[INSTALLED] === router)

  uninstallRemoteSandbox(service)
  check('uninstall removes the marker', service[INSTALLED] === undefined)
  check('uninstall restores the provider\'s own confine', typeof service.confine === 'function')
  const after = calls.length
  await service.confine(argv, { mode: 'workspace-write', workspaceRoot: REMOTE_ROOT })
  check('after uninstall the ssh:// root reaches the provider unfixed',
    calls.length === after + 1 && calls[after].policy.workspaceRoot === REMOTE_ROOT,
    String(calls[after]?.policy.workspaceRoot))
}

console.log('\n[a provider without confine, and a composition without one]')
{
  const bare = {}
  let threw
  try {
    installRemoteSandbox({ get: () => bare }, {})
  } catch (error) {
    threw = error
  }
  check('a service lacking confine() is a wiring error, not silence',
    threw instanceof Error && /no confine\(\)/u.test(threw.message), String(threw?.message))
  check('installing on a composition with no sandbox service is a no-op',
    installRemoteSandbox({ get: () => undefined }, {}) === undefined)
}

console.log('\n[a synchronous provider stays synchronous]')
{
  const seen = []
  const service = {
    confine (argv, policy) {
      seen.push(policy.workspaceRoot)
      return { argv, enforcement: 'partial' }
    },
  }
  installRemoteSandbox({ get: () => service }, {})
  const result = service.confine(['x'], { mode: 'workspace-write', workspaceRoot: REMOTE_ROOT })
  check('the synchronous result is not wrapped in a promise',
    result !== null && typeof result === 'object' && typeof result.then !== 'function',
    typeof result)
  check('the synchronous call was still localized',
    seen[0] === substituteWorkspaceRoot(), String(seen[0]))
}

console.log('\n[the real provider shape: confine lives on the prototype]')
{
  // `LocalSandboxProvider` declares `confine` on the CLASS, not on the
  // instance. Installing an own-property wrapper is fine, but uninstalling by
  // writing a copy back would leave the instance shadowing the prototype
  // forever — and would break a later prototype-level fix.
  class Provider {
    confine (argv, policy) { return { argv, enforcement: 'full', root: policy.workspaceRoot } }
  }
  const service = new Provider()
  check('the fixture really has no own confine', !Object.hasOwn(service, 'confine'))
  installRemoteSandbox({ get: () => service }, {})
  check('the wrapper is an own property after install', Object.hasOwn(service, 'confine'))
  const confined = service.confine(['x'], { mode: 'workspace-write', workspaceRoot: REMOTE_ROOT })
  check('the prototype implementation was reached with the localized root',
    confined.root === substituteWorkspaceRoot(), String(confined.root))
  uninstallRemoteSandbox(service)
  check('uninstall leaves NO own confine behind (the prototype method shows through)',
    !Object.hasOwn(service, 'confine'))
  check('the prototype method is what answers again',
    service.confine(['x'], { mode: 'workspace-write', workspaceRoot: REMOTE_ROOT }).root === REMOTE_ROOT)
  // A prototype-level change made AFTER the install must be visible once the
  // wrapper is gone; a copied own property would hide it.
  Provider.prototype.confine = function () { return { argv: [], enforcement: 'full', root: 'upgraded' } }
  check('a prototype change after uninstall is not shadowed by a leftover copy',
    service.confine(['x'], {}).root === 'upgraded')
}

console.log('\n[an own confine is restored by value]')
{
  const own = (argv, policy) => ({ argv, enforcement: 'full', root: policy.workspaceRoot })
  const service = { confine: own }
  installRemoteSandbox({ get: () => service }, {})
  check('an own method is wrapped', service.confine !== own)
  uninstallRemoteSandbox(service)
  check('an own method is restored as the exact same function', service.confine === own)
}

console.log('\n[the real provider boundary, when the assembled tree is here]')
{
  // The properties above are derived from reading
  // `dsh-sandbox-windows-acl`'s `containsDirectory`: `relative(realpath(root),
  // realpath(candidate))`. Deriving them is not the same as *the provider
  // accepting them*, so when the real package is resolvable, call its own
  // assertion — the exact function whose throw the bug report quotes.
  const coreRoot = process.env.DSH_CORE_ROOT
  let boundary
  if (typeof coreRoot === 'string' && coreRoot !== '') {
    try {
      const mod = await import(
        pathToFileURL(path.join(coreRoot, '@deepseek-ai', 'dsh-sandbox-windows-acl', 'lib', 'index.js')).href
      )
      boundary = mod.assertTempRootOutsideWorkspace
    } catch {
      boundary = undefined
    }
  }
  if (typeof boundary !== 'function') {
    console.log('  SKIP  DSH_CORE_ROOT is not set (the real ACL boundary check is not importable)')
  } else {
    check('the real provider ACCEPTS the substitute root against the real temp dir', (() => {
      try {
        boundary(substituteWorkspaceRoot(), tmpdir())
        return true
      } catch (error) {
        return `${error.message}`
      }
    })())
    // The two controls that prove the substitute is not accidentally right:
    // the spelling from the bug report must throw, and so must tmpdir() itself
    // (which is why the substitute is a child of it rather than the temp root).
    check('the real provider still REJECTS the ssh:// spelling (that is the bug this fixes)', (() => {
      try {
        boundary(REMOTE_ROOT, tmpdir())
        return false
      } catch (error) {
        return /ENOENT|no such file/u.test(String(error.message))
      }
    })())
    check('the real provider REJECTS the temp root as its own workspace (why the substitute is a child)', (() => {
      try {
        boundary(tmpdir(), tmpdir())
        return false
      } catch (error) {
        return /must be outside the workspace/u.test(String(error.message))
      }
    })())
  }
}

console.log('\n[the module does not touch what it must not]')
{
  const source = readFileSync(path.join(pluginRoot, 'lib', 'patch-sandbox.js'), 'utf8')
  // The module DOCUMENTS why `sandboxPolicy.resolve` is not touched, so a bare
  // string match would be satisfied by the explanation itself. What must be
  // absent is a DEPENDENCY on that service.
  check('the module never reaches for the sandboxPolicy service (patching it would weaken the workspace-write fence)',
    !/get\(\s*['"]sandboxPolicy['"]\s*\)/u.test(source) && !/ctx\.sandboxPolicy\b/u.test(source),
    'a sandboxPolicy patch would break mode-gate')
  check('the module does not change the mode', !/mode\s*:\s*['"](?:workspace-write|danger-full-access)['"]/u.test(source),
    'localizePolicy must carry the caller\'s mode through')

  const index = readFileSync(path.join(pluginRoot, 'lib', 'index.js'), 'utf8')
  check('lib/index.js installs the sandbox patch', index.includes('installRemoteSandbox('))
  check('lib/index.js uninstalls it on teardown', index.includes('uninstallRemoteSandbox('))
  check('the sandbox patch is installed before the shell patch (shell workdirs resolve through it)',
    index.indexOf('installRemoteSandbox(') < index.indexOf('installRemoteShell('))
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
process.exit(failures === 0 ? 0 : 1)
