/**
 * Run the PTC (programmatic tool calling) worker for an `ssh://` session
 * against a local directory instead of the remote spelling.
 *
 * ## What breaks without this
 *
 * A PTC provider launches a Node process that evaluates the model's program and
 * reports back; `dsh-ptc-runtime-node`'s `resolve(request)` defaults `cwd` to
 * `sandboxPolicy.resolve().workspaceRoot`, which for a remote session is the
 * `ssh://` spelling verbatim. Two things then fail, and BOTH live inside that
 * one string:
 *
 * 1. `start(cwd)` hands the spelling to `ctx.subprocess.spawn`, and the plugin's
 *    subprocess bridge refuses any executable other than git/ripgrep on a
 *    remote cwd — correctly, because the process it is asked for is the HOST's
 *    own worker (`[<this executable>, <bootstrap>]`), which no remote host can
 *    run. The visible error is:
 *
 *        ssh-workspace: cannot run "…DeepSeek Harness.exe" with a remote cwd —
 *        only git and ripgrep (rg) are supported over the remote subprocess
 *        bridge
 *
 * 2. Even if the process did start, every evaluation sends `spec.cwd` over the
 *    control channel and the child calls `process.chdir(cwd)`; Windows
 *    resolves `ssh://dev/…` as a path RELATIVE to the process cwd
 *    (`<cwd>\\ssh:\\dev\\…`), which cannot exist (a `:` is illegal in a
 *    file name), so each program would fail with chdir ENOENT instead.
 *
 * Rewriting the cwd inside `resolve()` fixes both at once: the spawn gets an
 * existing local directory, and `run()`/`dispatch()` carry that same directory
 * to the child. A consumer cannot observe an `ssh://` spec cwd that the worker
 * can never enter.
 *
 * ## What this does NOT change
 *
 * Only `spec.cwd` is replaced. `sandboxPolicy` keeps the remote spelling (the
 * Windows sandbox provider is localized separately, by patch-sandbox.js, and
 * the mode gates compare against that spelling), and every other field —
 * `program`, `bindings`, `stateOwner`, `timeoutMs` — is carried over untouched.
 * A resolve whose cwd is already local is returned BY IDENTITY, so an
 * ordinary session's PTC behavior is exactly what it was.
 *
 * The substitute root is the same empty directory the sandbox half hands the
 * Windows provider (see patch-sandbox.js): stable for the process lifetime,
 * inside `os.tmpdir()`, and granted by the ACL provider, so a confined
 * workspace-write worker still starts inside an allowed directory.
 *
 * ## The honest limitation
 *
 * A PTC program's OWN file access — `process.cwd()`, relative `import()`,
 * `node:fs` on a relative path — now resolves against that local scratch
 * directory, not the remote workspace. Tool calls are unaffected: the host
 * executes them with the session's remote directory. Programs written for a
 * remote workspace should pass paths explicitly to tools instead of relying on
 * the process cwd. The alternative was not "correct but limited"; it was
 * "nothing runs at all".
 *
 * @module @shiqyka/dsh-ssh-workspace/patch-ptc
 */

import { substituteWorkspaceRoot } from './patch-sandbox.js'
import { isRemotePath } from '../core/protocol.js'

/** Instance marker proving this module already patched the service. */
export const INSTALLED = Symbol.for('dsh-ssh-workspace.ptc-installed')

/** Marker carrying the original `resolve` an install replaced. */
const ORIGINAL = Symbol.for('dsh-ssh-workspace.ptc-original')

/**
 * Marker recording whether the original `resolve` was an OWN property.
 *
 * A provider may implement `resolve` on the prototype (the abstract `PtcRuntime`
 * base declares it there). A wrapper installed as an own property is therefore
 * DELETED on uninstall rather than replaced by an own copy of the inherited
 * method: that copy would shadow a later prototype change for the rest of the
 * process.
 */
const ORIGINAL_OWN = Symbol.for('dsh-ssh-workspace.ptc-original-own')

/**
 * The router the patched `resolve` delegates to.
 *
 * `local` is the surrounding provider's own `resolve`, bound to its receiver;
 * keeping it here (rather than in the closure) lets the uninstall restore it
 * and lets a test assert the exact call the provider receives.
 */
class RemotePtcRouter {
  constructor (options) {
    this.local = options.local
    this.logger = options.logger
    /** How many specs needed a rewrite (observability, and the test's mirror). */
    this.localized = 0
  }

  /**
   * Resolve the spec, then make sure its cwd is a directory the worker can
   * actually enter on this machine.
   *
   * @returns {object} the provider's spec, with a localized cwd when needed.
   */
  resolve (request) {
    const spec = this.local(request)
    // A provider that answers with something else (a future shape, a promise)
    // is passed through exactly as it came back; this wrapper only rewrites a
    // spec it recognizes.
    if (spec === null || typeof spec !== 'object') return spec
    const cwd = spec.cwd
    if (!isRemotePath(cwd)) return spec
    const localized = substituteWorkspaceRoot()
    this.localized += 1
    this.logger?.debug?.(
      `ssh-workspace: evaluating a PTC program for remote cwd ${JSON.stringify(cwd)} from the local substitute root ${JSON.stringify(localized)}`
    )
    return { ...spec, cwd: localized }
  }
}

/**
 * Install the localization onto the live `ctx.ptcRuntime` service.
 *
 * @param {object} [options.logger] - a Cordis logger, when available.
 * @returns {RemotePtcRouter | undefined} the router, or undefined when no
 *   `ptcRuntime` service is mounted (a deployment without program execution
 *   has nothing to localize).
 * @throws {Error} when the mounted provider has no `resolve()` to wrap.
 */
export function installRemotePtc (ctx, options) {
  const target = ctx.get('ptcRuntime')
  if (target === undefined || target === null) return undefined
  if (target[INSTALLED] !== undefined) return target[INSTALLED]

  const originalResolve = target.resolve
  if (typeof originalResolve !== 'function') {
    throw new Error('ssh-workspace: the mounted ctx.ptcRuntime service has no resolve() to wrap')
  }
  const router = new RemotePtcRouter({ local: originalResolve.bind(target), logger: options?.logger })
  const wasOwn = Object.hasOwn(target, 'resolve')
  const resolve = function (request) {
    return router.resolve(request)
  }
  Object.defineProperty(target, 'resolve', { value: resolve, writable: true, configurable: true, enumerable: false })
  Object.defineProperty(target, INSTALLED, { value: router, writable: false, configurable: true, enumerable: false })
  Object.defineProperty(target, ORIGINAL, { value: originalResolve, writable: false, configurable: true, enumerable: false })
  Object.defineProperty(target, ORIGINAL_OWN, { value: wasOwn, writable: false, configurable: true, enumerable: false })
  options?.logger?.info?.('ssh-workspace: took over ctx.ptcRuntime.resolve for ssh:// working directories')
  return router
}

/**
 * Undo {@link installRemotePtc}, restoring the original `resolve`.
 *
 */
export function uninstallRemotePtc (target) {
  if (target === undefined || target === null) return
  if (target[INSTALLED] === undefined) return
  const original = target[ORIGINAL]
  const wasOwn = target[ORIGINAL_OWN] === true
  if (original !== undefined && wasOwn) {
    // The provider carried `resolve` as an own property: put that exact
    // function back rather than leaving the instance without one.
    Object.defineProperty(target, 'resolve', { value: original, writable: true, configurable: true, enumerable: false })
  } else if (Object.hasOwn(target, 'resolve')) {
    // Inherited from the prototype (how the abstract PtcRuntime declares it):
    // deleting the wrapper uncovers the real method again.
    delete target.resolve
  }
  delete target[ORIGINAL]
  delete target[ORIGINAL_OWN]
  delete target[INSTALLED]
}
