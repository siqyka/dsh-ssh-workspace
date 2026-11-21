/**
 * Make the LOCAL sandbox provider accept a session whose workspace root is an
 * `ssh://` spelling.
 *
 * ## The failure
 *
 * Every command path that reaches a sandbox provider runs
 * `ctx.sandbox.confine(argv, policy, signal)` BEFORE it reaches the seam this
 * plugin owns (`ctx.shell.execute`, `ctx.subprocess.spawn`/`spawnTerminal`, the
 * PTC runtime's `spawn`). `policy.workspaceRoot` is
 * `SandboxPolicyService.resolve()`'s answer, and for a remote session that
 * answer is `session.header.cwd` verbatim — the `ssh://` spelling. The provider
 * then resolves that string as a HOST path:
 *
 * - Windows ACL: `materializeAclGrant` → `isTempRootInsideWorkspace(root, tmpdir())`
 *   → `realpathSync.native('ssh://…')`, which fails with `ENOENT` because the
 *   spelling is drive-relative there, and the failure surfaces as
 *   `SANDBOX_PREPARATION_FAILED` ("workspace and temp directory resolution
 *   failed … The command did not run");
 * - the bwrap / Landlock / Seatbelt dialects would hand the same bogus path to
 *   their profile builder, where it can only ever match nothing.
 *
 * So the command never starts, on any mode except `danger-full-access`, and no
 * seam in this plugin is ever consulted to divert it.
 *
 * ## The fix
 *
 * Take over the live `ctx.sandbox.confine` the same way `patch-fs.js` takes
 * over `ctx.fs`, and when the policy's root is remote, replace it with a REAL
 * local directory before calling the original implementation. The provider then
 * resolves, realpaths and ACL-grants a path that exists, and the caller gets a
 * well-formed confinement back.
 *
 * Why this is fail-closed rather than a widening:
 *
 * - today the same call throws, so nothing runs at all — there is no confined
 *   execution being loosened;
 * - the substitute root is an empty directory this plugin owns under
 *   `os.tmpdir()`, so a local command in a remote session still has a NARROW
 *   write scope, not the user's home;
 * - the confinement this returns is never what actually runs the command: a
 *   remote target is diverted to SSH by `patch-shell.js`, `patch-subprocess.js`
 *   or `patch-terminal.js` (which rebuilds argv and ignores the wrapped one),
 *   and those run as the remote login user with no local kernel boundary to
 *   erect.
 *
 * ## Why NOT patch `sandboxPolicy.resolve`
 *
 * That would look like a tidier fix — the spelling would be local everywhere —
 * and it would silently weaken a tested fence: `mode-gate.js`'s
 * `writeScopeRootOf` / `workspaceWriteScopeRefusal` compare the target against
 * the session's `ssh://` root to keep `workspace-write` inside this session's
 * own workspace. A resolver that hands back a local path makes that comparison
 * meaningless and every mounted root writable. `resolve()` stays untouched;
 * only the argument handed to the provider's `confine` is localized.
 *
 * ## The substitute root is stable, and that is not cosmetic
 *
 * `dsh-sandbox-local` caches its ACL grants per `workspaceRoot` for the
 * provider's lifetime. A fresh random directory per call would leak one
 * standing grant (and one temp capability) per command; a single fixed name
 * reuses the same grant for every remote workspace in the process. One shared
 * root also means the standing workspace SID is shared across remote
 * workspaces — harmless, because that grant only ever authorizes writes inside
 * this plugin's own empty temp directory.
 *
 * @module @shiqyka/dsh-ssh-workspace/patch-sandbox
 */

import { mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isRemotePath } from '../protocol.js'

/** Instance marker proving this module already patched the service. */
export const INSTALLED = Symbol.for('dsh-ssh-workspace.sandbox-installed')

/** Marker carrying the original `confine` an install replaced. */
const ORIGINAL = Symbol.for('dsh-ssh-workspace.sandbox-original')

/**
 * Marker recording whether the original `confine` was an OWN property of the
 * instance or inherited from the provider's prototype.
 *
 * It matters only on the way out: `LocalSandboxProvider` implements `confine`
 * on the prototype, so a wrapper installed as an own property must be DELETED
 * on uninstall (letting the prototype method show through again) rather than
 * replaced by a copy of the inherited function — that copy would shadow any
 * later prototype change and would make the instance's own-property set differ
 * from what it was before installation.
 */
const ORIGINAL_OWN = Symbol.for('dsh-ssh-workspace.sandbox-original-own')

/**
 * Directory name of the substitute root inside `os.tmpdir()`.
 *
 * It must be a CHILD of the temp root, not the temp root itself: the Windows
 * provider refuses a policy whose root contains the temp dir (the private temp
 * child would inherit the workspace capability), and `relative(root, tmpdir)`
 * is `..` for a child — which is exactly the "outside" answer it wants.
 */
const SUBSTITUTE_DIR = 'dsh-ssh-workspace-sandbox'

/** The substitute root, resolved once and reused for the process lifetime. */
let substituteRoot

/**
 * The local directory this process hands the provider in place of an `ssh://`
 * root.
 *
 * @throws {Error} when it cannot be created — the caller must not fall through
 *   to the remote spelling, which is the crash this module exists to prevent.
 */
export function substituteWorkspaceRoot () {
  if (substituteRoot !== undefined) return substituteRoot
  const candidate = join(tmpdir(), SUBSTITUTE_DIR)
  try {
    mkdirSync(candidate, { recursive: true })
    // Canonical, because every provider canonicalizes its own copy: returning
    // the as-joined spelling would make two spellings of one directory look
    // like two roots and defeat the provider's grant cache.
    substituteRoot = realpathSync.native(candidate)
  } catch (error) {
    throw new Error(
      'ssh-workspace: could not prepare a local substitute sandbox root for a remote workspace ' +
      `(${candidate}): ${error instanceof Error ? error.message : String(error)}`
    )
  }
  return substituteRoot
}

/**
 * Rewrite a sandbox policy so every host path in it is a host path.
 *
 * Only the two fields that carry directories are touched: `workspaceRoot` (the
 * one the providers resolve) and `additionalWritableRoots` (extra grants, from
 * `--add-dir`, which cannot name a remote directory either). Everything else —
 * `mode`, `sessionId`, and any field a future release adds — is carried over
 * untouched, so this cannot silently change what a mode means.
 *
 * Returns the SAME object when there is nothing remote in it: an unnecessary
 * copy would still work, but identity is what lets the caller (and the test)
 * see that a local command's policy was not touched at all.
 *
 */
export function localizePolicy (policy) {
  if (policy === null || typeof policy !== 'object') return policy
  const rootRemote = isRemotePath(policy.workspaceRoot)
  const declared = policy.additionalWritableRoots
  const filtered = Array.isArray(declared) ? declared.filter(entry => !isRemotePath(entry)) : undefined
  const droppedExtras = filtered !== undefined && filtered.length !== declared.length
  if (!rootRemote && !droppedExtras) return policy
  return {
    ...policy,
    ...(rootRemote ? { workspaceRoot: substituteWorkspaceRoot() } : {}),
    ...(filtered === undefined ? {} : { additionalWritableRoots: filtered }),
  }
}

/**
 * The router the patched `confine` delegates to.
 *
 * `local` is the surrounding provider's own `confine`, bound to its receiver;
 * keeping it here (rather than in the closure) lets the uninstall restore it
 * and lets a test assert the exact call the provider receives.
 */
class RemoteSandboxRouter {
  constructor (options) {
    this.local = options.local
    this.logger = options.logger
    /** How many calls needed a rewrite (observability, and the test's mirror). */
    this.localized = 0
  }

  /**
   * Localize the policy, then run the provider's own confinement.
   *
   * Whether the original returns a promise or a value is passed through
   * unchanged: `confine` may be implemented either way, and wrapping the result
   * in a promise would change the caller's control flow for a synchronous
   * implementation.
   *
   * @param {string[]} argv - the exact argv the caller is about to spawn.
   */
  confine (argv, policy, signal) {
    const localized = localizePolicy(policy)
    if (localized !== policy) {
      this.localized += 1
      this.logger?.debug?.(
        `ssh-workspace: confining a local command against the substitute root for remote workspace ${String(policy?.workspaceRoot)}`
      )
    }
    return this.local(argv, localized, signal)
  }
}

/**
 * Install the localization onto the live `ctx.sandbox` service.
 *
 * @param {object} [options.logger] - a Cordis logger, when available.
 * @returns {RemoteSandboxRouter | undefined} the router, or undefined when no
 *   `sandbox` service is mounted (an unsandboxed composition: there is nothing
 *   to confine with, and nothing to fix).
 * @throws {Error} when the mounted provider has no `confine()` to wrap.
 */
export function installRemoteSandbox (ctx, options) {
  const target = ctx.get('sandbox')
  if (target === undefined || target === null) return undefined
  if (target[INSTALLED] !== undefined) return target[INSTALLED]

  const originalConfine = target.confine
  if (typeof originalConfine !== 'function') {
    throw new Error('ssh-workspace: the mounted ctx.sandbox service has no confine() to wrap')
  }
  const router = new RemoteSandboxRouter({ local: originalConfine.bind(target), logger: options?.logger })
  const wasOwn = Object.hasOwn(target, 'confine')
  const confine = function (argv, policy, signal) {
    return router.confine(argv, policy, signal)
  }
  Object.defineProperty(target, 'confine', { value: confine, writable: true, configurable: true, enumerable: false })
  Object.defineProperty(target, INSTALLED, { value: router, writable: false, configurable: true, enumerable: false })
  Object.defineProperty(target, ORIGINAL, { value: originalConfine, writable: false, configurable: true, enumerable: false })
  Object.defineProperty(target, ORIGINAL_OWN, { value: wasOwn, writable: false, configurable: true, enumerable: false })
  options?.logger?.info?.('ssh-workspace: took over ctx.sandbox.confine for ssh:// workspace roots')
  return router
}

/**
 * Undo {@link installRemoteSandbox}, restoring the original `confine`.
 *
 */
export function uninstallRemoteSandbox (target) {
  if (target === undefined || target === null) return
  if (target[INSTALLED] === undefined) return
  const original = target[ORIGINAL]
  const wasOwn = target[ORIGINAL_OWN] === true
  if (original !== undefined && wasOwn) {
    // The provider carried `confine` as an own property: put that exact
    // function back rather than leaving the instance without one.
    Object.defineProperty(target, 'confine', { value: original, writable: true, configurable: true, enumerable: false })
  } else if (Object.hasOwn(target, 'confine')) {
    // Inherited from the prototype (how `LocalSandboxProvider` does it):
    // deleting the wrapper uncovers the real method again, and an own-property
    // copy would shadow a later prototype change.
    delete target.confine
  }
  delete target[ORIGINAL]
  delete target[ORIGINAL_OWN]
  delete target[INSTALLED]
}
