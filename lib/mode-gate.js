/**
 * The remote-mutation gate: one answer to "may this session change the remote
 * host?", shared by every surface that can.
 *
 * Why a shared module rather than a check per tool: the plugin owns SIX ways to
 * write to a host, and they do not share a call path.
 *
 * | surface                        | reaches the host through     |
 * | ------------------------------ | ---------------------------- |
 * | `write` / `edit` tools         | `ctx.fs` router   (gated)    |
 * | `ssh_workspace_transfer`       | SFTP staging      (gated)    |
 * | `ssh_workspace_exec`           | `engine.exec`     ← here      |
 * | `ssh_workspace_shell`          | PTY channel       ← here      |
 * | `bash` / `pwsh` with ssh cwd   | `ctx.shell`       ← here      |
 * | `terminal_open` with ssh cwd   | `ctx.subprocess.spawnTerminal` ← here |
 * | the sidebar's browser terminal | same primitive, called directly ← here |
 *
 * The terminal surface needs a word of explanation, because the obvious place
 * to gate it is wrong: `spawnTerminal`'s spec carries no owner, and TWO callers
 * reach it — `ctx.terminals` (for `terminal_open` / `terminal_send`) and
 * `dsh-api-terminal-controller` (the sidebar terminal), which bypasses
 * `ctx.terminals` entirely. A gate on `ctx.terminals.spawn` would therefore
 * miss the second path while a test of the tool path stayed green. The gate
 * lives in `patch-terminal.js` instead — the one point both converge on — and
 * resolves the session from `spec.env.DSH_SESSION_ID`, which both stamp.
 *
 * Gating only the filesystem family was a real defect, not a theoretical one:
 * a `read-only` session ran `rm /home/qiyk/test/test.py` through
 * `ssh_workspace_exec` and got exit 0, because command execution never consults
 * the mode at all.
 *
 * The filesystem half of the gate lives with the router (`remote-fs.js`), but the
 * SCOPE question — "is this target inside the session's own workspace?" — is
 * answered here too, because the transfer tool needs the same answer and the two
 * must not drift. See {@link workspaceWriteScopeRefusal}.
 *
 * Why command execution is refused outright rather than filtered: the local
 * sandbox answers "may this command write?" by confining the PROCESS — a kernel
 * boundary (bwrap / seatbelt / an ACL-restricted token). None of that crosses
 * an SSH connection: the remote command runs as the remote login user, with
 * that user's full permissions. There is no seam to hand a `workspaceRoot` to,
 * and parsing a command line to guess whether it mutates is not a boundary —
 * `sh -c 'rm -rf ~'` reads as pure text.
 *
 * So the choice is: allow arbitrary remote commands and let the mode be a lie,
 * or refuse them under `read-only` and keep the mode honest. This module does
 * the second, and says so in the refusal so the model does not retry blindly.
 *
 * Reads are NOT lost: `read` / `glob` / `grep` / `ops_*` serve them over SFTP
 * and are unaffected. What is lost is arbitrary command execution (a remote
 * `git status`, a build) — which the user unlocks by switching the session to
 * `workspace-write` or `danger-full-access`, an explicit, visible action.
 *
 * @module @shiqyka/dsh-ssh-workspace/mode-gate
 */

/**
 * The mode that forbids mutation. Named once so the three seams cannot drift.
 *
 * @type {string}
 */
export const READ_ONLY = 'read-only'

/**
 * The modes a remote mutation gate recognises. A resolved policy is one of
 * these three; anything else is a fold that predates this vocabulary or a
 * corrupted one.
 *
 * The gate fails CLOSED on an unrecognised mode rather than defaulting to the
 * widest answer, because that is exactly what the LOCAL sandbox does: a mode
 * that is not `danger-full-access` and not `read-only` falls into the
 * containment branch, and `writableRoots(policy)` returns `[]` for anything
 * that is not `workspace-write` (`dsh-sandbox` index.js:166). So a local
 * `future-mode` write is denied outright. A remote write that skipped both the
 * mode fence and the scope fence on an unknown string would be WEAKER than the
 * local answer for the same input — the divergence this constant exists to
 * prevent.
 *
 * @type {ReadonlySet<string>}
 */
const KNOWN_WRITE_MODES = Object.freeze(new Set([READ_ONLY, 'workspace-write', 'danger-full-access']))

/**
 * The remote counterpart of `writableRoots`' constant `/tmp` entry.
 *
 * The local sandbox lets a `workspace-write` session write `/tmp` and the
 * platform temp dir even though they are outside the workspace root
 * (`dsh-sandbox` index.js:166-173); a remote build that stages into the host's
 * `/tmp` must not be refused for a reason its local twin does not have. This is
 * a fixed POSIX path, not a per-host probe — matching the local rule verbatim.
 *
 * @param {string} remotePath - a normalized remote absolute path.
 * @returns {boolean} true when the path is the host temp area.
 */
function isRemoteTempPath (remotePath) {
  return remotePath === '/tmp' || remotePath.startsWith('/tmp/')
}

/**
 * The MODE half of a remote write fence, as one answer shared by the router and
 * the upload tool so the two cannot drift.
 *
 * It asks only "does this mode permit writing at all?" — containment is the
 * separate {@link workspaceWriteScopeRefusal} question, and reachability is the
 * mount fence. Two denials, each with its own sentence, because a message that
 * blames the wrong one costs the model a retry loop:
 *
 * - `read-only` is the mode the user chose; the way out is to switch modes.
 * - an unrecognised mode is not: no mode switch can fix a fold the gate cannot
 *   read, so it is refused as the strictest answer the local sandbox would
 *   give. Reporting it as `read-only` would send the user to a switch that is
 *   already the widest mode.
 *
 * @param {string | undefined} mode - the effective sandbox mode, `undefined`
 *   when the composition confines nothing (an absent policy).
 * @param {string} target - the display path, for the message.
 * @param {string} [verb] - the word for the action (default `write`).
 * @returns {string | undefined} the refusal text, or undefined when permitted.
 */
export function writeModeRefusal (mode, target, verb = 'write') {
  // An absent mode is an unconfined deployment, not a denial — the same answer
  // every other seam in this module gives, and a test pins it ("no policy
  // service means unconfined, not read-only").
  if (mode === undefined || mode === null || mode === '') return undefined
  if (mode === 'danger-full-access' || mode === 'workspace-write') return undefined
  if (mode === READ_ONLY) {
    return `cannot ${verb} "${target}": file access denied under ${READ_ONLY} mode`
  }
  return `cannot ${verb} "${target}": the session sandbox mode is "${String(mode)}", which this plugin does not recognise — ` +
    `the mutation was refused rather than run unconfined, because the local sandbox treats any mode outside ` +
    '{read-only, workspace-write, danger-full-access} as the strictest answer. This is not a mode you can switch to fix it; ' +
    'set the session to one of the three recognised modes.'
}

/**
 * Resolve a session's effective sandbox mode.
 *
 * Three outcomes, deliberately distinguished:
 * - the effective mode string, when a policy service is composed;
 * - `undefined`, when the composition has NO sandbox policy — an unconfined
 *   deployment must behave as before rather than silently become read-only;
 * - `'read-only'`, when a policy exists but cannot resolve. Failing closed is
 *   the safe direction for a mutation gate: the cost is a refused command the
 *   user can re-issue after switching modes, against silently writing while the
 *   session says "view only".
 *
 * @param {object} ctx - host plugin context.
 * @param {object} [session] - the calling agent's session, when there is one.
 * @returns {string | undefined} the effective mode, `undefined` when unconfined.
 */
export function sessionModeOf (ctx, session) {
  return sessionPolicyOf(ctx, session)?.mode
}

/**
 * Read the sandbox-policy service off a host context, tolerating both shapes it
 * comes in.
 *
 * `ctx.get(name)` is the shape that always works: Cordis resolves a service by
 * name for any caller, whether or not the caller declared it in `inject`.
 * Property access (`ctx.sandboxPolicy`) is the shape that does NOT: on a real
 * Cordis context it is trapped, and reading an undeclared service throws
 * `cannot get property "sandboxPolicy" without inject`. Plain-object contexts
 * in tests expose the service as a property and have no `get` at all.
 *
 * The property read is therefore a FALLBACK behind `ctx.get`, and it is
 * wrapped: before this split, `ctx?.get?.(...) ?? ctx?.sandboxPolicy` looked
 * safe but was not — `ctx.get` returning `undefined` (the ordinary answer for
 * a composition without the service) walked straight into the trapping
 * property read and threw. That made an absent policy indistinguishable from a
 * broken one, and it is what made the acceptance suite fail on a real host
 * with `cannot get property "sandboxPolicy" without inject` instead of
 * reporting an unconfined deployment.
 *
 * @param {object} ctx - host plugin context.
 * @returns {object | undefined} the policy service, when one is composed.
 */
function resolvePolicyService (ctx) {
  if (ctx === undefined || ctx === null) return undefined
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get('sandboxPolicy') : undefined
    if (viaGet !== undefined && viaGet !== null) return viaGet
  } catch { /* a throwing lookup must fall through to the property read */ }
  try {
    return ctx.sandboxPolicy
  } catch {
    // The trapping property read on a Cordis context without the service
    // injected. Absent, not broken — the caller wants `undefined` here.
    return undefined
  }
}

/**
 * Resolve a session's whole policy — mode AND workspace root — with the reason
 * attached when it could not be resolved.
 *
 * The distinction between "the policy says read-only" and "the policy could not
 * be read" matters for the MESSAGE, not the decision: both refuse, but only the
 * first may claim the user chose `read-only`. Reporting a broken policy service
 * as a deliberate "view only" setting sends the user to a mode switch that
 * cannot help, and hides a real defect behind a plausible sentence.
 *
 * Why the resolution can fail at all: `SandboxPolicyService.resolve` runs
 * `session.header.cwd` through `path.isAbsolute`, and an `ssh://` spelling is
 * only "absolute" because `fs-shim.js` patches `node:path`. If that patch is
 * missing — a different host build, an install that skipped it — every remote
 * session throws here. That is a bug in the wiring, and it must be readable as
 * one.
 *
 * @param {object} ctx - host plugin context.
 * @param {object} [session] - the calling agent's session, when there is one.
 * @returns {{mode: string, workspaceRoot?: string, unresolved?: true, reason?: string} | undefined}
 *   `undefined` when the composition has no sandbox policy at all.
 */
export function sessionPolicyOf (ctx, session) {
  const policy = resolvePolicyService(ctx)
  if (policy === undefined || policy === null || typeof policy.resolve !== 'function') return undefined
  try {
    const resolved = policy.resolve(session === undefined || session === null ? {} : { session })
    const mode = typeof resolved?.mode === 'string' ? resolved.mode : READ_ONLY
    const root = typeof resolved?.workspaceRoot === 'string' && resolved.workspaceRoot !== '' ? resolved.workspaceRoot : undefined
    return root === undefined ? { mode } : { mode, workspaceRoot: root }
  } catch (error) {
    return {
      mode: READ_ONLY,
      unresolved: true,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * The mode carried by a resolved execution spec.
 *
 * The shell seam forwards the caller's per-call policy (`sandboxPolicy`), which
 * is the ONLY carrier of a session override — a session switched to
 * `read-only` logs a `sandbox/mode` event that reaches the executor no other
 * way. An absent policy means an unsandboxed caller, not a denial.
 *
 * @param {object} [spec] - a resolved execution spec.
 * @returns {string | undefined} the effective mode, `undefined` when unsandboxed.
 */
export function specModeOf (spec) {
  const mode = spec?.sandboxPolicy?.mode
  return typeof mode === 'string' && mode !== '' ? mode : undefined
}

/**
 * The refusal text for a refused remote command.
 *
 * Written to be actionable in one read: it names the mode (so the model knows
 * this is a policy denial and not a broken path), names the target, states why
 * it cannot be confined, and lists what still works. It deliberately does NOT
 * promise `sandbox_permissions`: the bash/pwsh tools add that hint themselves
 * when escalation is advertised, and the plugin's own tools have no such field —
 * inventing one here would send the model after a parameter that does not exist.
 *
 * Two different causes produce this refusal and they must not share a sentence:
 * a session the user actually set to `read-only` (switch the mode and retry
 * works), and a policy that could not be RESOLVED (switching the mode cannot
 * help, because the resolver is what is broken). The second is reported as the
 * wiring problem it is — `sessionModeOf`'s fail-closed default must not be
 * dressed up as the user's deliberate choice.
 *
 * @param {string} action - what was refused, e.g. `run a command`.
 * @param {string} [target] - the host or workspace the action named.
 * @param {{reason?: string}} [trouble] - present when the policy failed to resolve.
 * @returns {string} the model-facing refusal.
 */
export function remoteReadOnlyMessage (action, target, trouble) {
  const where = typeof target === 'string' && target !== '' ? ` on ${target}` : ''
  if (typeof trouble?.reason === 'string' && trouble.reason !== '') {
    return `cannot ${action}${where}: the session's sandbox policy could not be resolved (${trouble.reason}), ` +
      'so this remote command was refused rather than run unconfined. This is a wiring problem, not a mode you chose — ' +
      'switching the session mode will not help. The resolver needs the workspace path to read as absolute, which for an ' +
      'ssh:// workspace depends on the plugin\'s node:path patch having been installed at load time. ' +
      'Reading still works through read / glob / grep / ops_* (they use SFTP and need no command).'
  }
  return `cannot ${action}${where}: the session sandbox mode is "${READ_ONLY}" and a remote command cannot be confined — ` +
    'the local file sandbox (bwrap / seatbelt / an ACL-restricted token) does not cross an SSH connection, so the remote ' +
    'command would run as the remote login user with that user\'s full permissions. ' +
    'Reading still works through read / glob / grep / ops_* (they use SFTP and need no command). ' +
    'To run commands here, switch this session to workspace-write or danger-full-access.'
}

/**
 * The refusal for a write that stays on a mounted host but leaves the SESSION's
 * own workspace.
 *
 * `workspace-write` is a containment promise, not a "somewhere on the right host"
 * promise: the local backend enforces it with `writableRoots(policy)`, whose first
 * entry is `policy.workspaceRoot`. The remote half used to answer a weaker
 * question — "is this inside ANY mounted root?" — and the root set is
 * deployment-wide, so a session rooted at `ssh://qiyk/home/dev/proj` could write
 * a sibling root, and even a root on a DIFFERENT host, without any local
 * counterpart.
 *
 * The previous justification for that was wrong, not merely unfortunate: it
 * claimed `workspaceRoot` is always a path on THIS machine. Measured against the
 * real service, `resolve()` returns `session.header.cwd` verbatim, and for a
 * remote session that is the `ssh://` spelling — usable for comparison, which is
 * exactly what happens here.
 *
 * An agentless call has no session cwd, so its root is the deployment's local
 * one. That spelling cannot be compared to a remote target, and it must not be:
 * it would refuse every write. {@link writeScopeRootOf} returns undefined there
 * and the caller falls back to the mounted-root fence alone.
 *
 * @param {string} mode - the effective sandbox mode.
 * @param {string | undefined} scopeRoot - the session's `ssh://` workspace root.
 * @param {{alias: string, remotePath: string, displayPath: string}} parts - the target.
 * @returns {string | undefined} the refusal text, or undefined when in scope.
 */
export function workspaceWriteScopeRefusal (mode, scopeRoot, parts) {
  if (mode !== 'workspace-write') return undefined
  if (scopeRoot === undefined || scopeRoot === null || scopeRoot === '') return undefined
  const root = remotePartsOfSpelling(scopeRoot)
  // A local root (no session cwd) says nothing about a directory on the host.
  if (root === undefined) return undefined
  // Normalise the target too, not just the root: the router hands over an
  // already-normalised path, but this helper is also reachable from the transfer
  // tool with a caller-supplied spelling, and `/ws/../elsewhere/x` must not read
  // as inside `/ws` because of how it was typed.
  const target = normalizeRemoteSpelling(parts.remotePath)
  if (root.alias !== parts.alias) {
    return `cannot write "${parts.displayPath}": file access denied under workspace-write mode — ` +
      `this session's workspace is on host "${root.alias}", not on "${parts.alias}". ` +
      'Switch this session to danger-full-access to write on another host.'
  }
  // The host temp area is writable under `workspace-write` even though it is
  // outside the session workspace, mirroring `writableRoots`' constant `/tmp`
  // entry on the local side. Without it a remote build that stages into `/tmp`
  // is refused for a reason its local twin never hits. It is scoped to the
  // SAME host the session lives on (the alias check above already bounds that):
  // staging belongs on the machine being worked on, not on every reachable host.
  // The mount fence and the realpath fence still bound where the bytes land.
  if (isRemoteTempPath(target)) return undefined
  if (!isUnderRemoteRoot(root.remotePath, target)) {
    return `cannot write "${parts.displayPath}": file access denied under workspace-write mode — ` +
      `the session workspace is "${scopeRoot}", and workspace-write only permits writing inside it. ` +
      'Switch this session to danger-full-access for paths elsewhere on the host — but only a path that is also ' +
      'inside a MOUNTED workspace becomes writable then; if this one is not mounted, switching will not help ' +
      '(mount it with ssh_workspace_mount).'
  }
  return undefined
}

/**
 * The session workspace root, when it is a remote spelling that can be compared
 * against a remote target.
 *
 * @param {{mode?: string, workspaceRoot?: string} | undefined} policy - a resolved policy.
 * @returns {string | undefined} the `ssh://` root, or undefined for a local one.
 */
export function writeScopeRootOf (policy) {
  const root = policy?.workspaceRoot
  if (typeof root !== 'string' || root === '') return undefined
  return remotePartsOfSpelling(root) === undefined ? undefined : root
}

/**
 * Split an `ssh://alias/path` spelling.
 *
 * Kept local rather than imported from `protocol.js` so this module stays free of
 * peer dependencies: it is loaded by the shell and terminal seams, which must
 * work even when the filesystem half is not composed.
 *
 * @param {string} value - a candidate spelling.
 * @returns {{alias: string, remotePath: string} | undefined} the parts, or undefined.
 */
function remotePartsOfSpelling (value) {
  if (typeof value !== 'string' || !value.startsWith('ssh://')) return undefined
  const match = /^ssh:\/\/([^/]+)(\/.*)?$/u.exec(value)
  if (match === null) return undefined
  return { alias: match[1], remotePath: normalizeRemoteSpelling(match[2]) }
}

/**
 * Collapse a remote path lexically: `//` collapses, `.` drops, `..` pops without
 * escaping the root.
 *
 * @param {string} [raw] - the path portion of a spelling.
 * @returns {string} the normalized absolute path.
 */
function normalizeRemoteSpelling (raw) {
  const segments = []
  for (const segment of String(raw ?? '/').split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return `/${segments.join('/')}`
}

/**
 * Whether `child` is `parent` or lies beneath it.
 *
 * @param {string} parent - the containing remote path.
 * @param {string} child - the candidate descendant.
 * @returns {boolean} true when contained.
 */
function isUnderRemoteRoot (parent, child) {
  if (child === parent) return true
  return child.startsWith(parent === '/' ? '/' : `${parent}/`)
}

/**
 * Refuse a remote command unless the mode permits arbitrary host execution.
 *
 * `danger-full-access`, `workspace-write`, and an absent mode (a composition
 * with no sandbox at all) all allow. For `workspace-write` this is a real
 * limitation and is documented as one: a command cannot be narrowed to the
 * session workspace remotely, because containing a PROCESS needs the kernel
 * boundary that does not cross SSH. File writes are narrowed instead (see
 * {@link workspaceWriteScopeRefusal}); a command that writes outside the
 * workspace remains possible, and no text check would change that.
 *
 * What the mode still buys for commands is the one answer it can give honestly:
 * `read-only` refuses them.
 *
 * @param {string | object | undefined} mode - the effective sandbox mode, or a
 *   resolved policy object (so the "could not resolve" cause travels with it).
 * @param {string} action - what is being refused, for the message.
 * @param {string} [target] - the host or workspace named by the call.
 * @returns {void}
 * @throws {Error} when the mode forbids executing a remote command.
 */
export function assertRemoteCommandAllowed (mode, action, target) {
  // Accepting the resolved policy as well as the bare string keeps the five
  // call sites from having to destructure it — and, more importantly, lets the
  // resolution FAILURE reach the message instead of being flattened into an
  // indistinguishable "read-only".
  const resolved = typeof mode === 'object' && mode !== null ? mode : undefined
  const effective = resolved !== undefined ? resolved.mode : mode
  const trouble = resolved?.unresolved === true ? { reason: resolved.reason } : undefined
  // An absent mode is an unconfined deployment (no policy service at all): the
  // same answer the resolver gives, and commands run unchanged. Anything the
  // gate cannot read fails CLOSED to a refusal, matching the file-write fence
  // (see KNOWN_WRITE_MODES) — a command is the most mutation-capable surface,
  // so silently allowing one under an unknown mode would be strictly weaker
  // than the local kernel, which confines every non-`danger-full-access` mode.
  if (effective === undefined || effective === null || effective === '') return
  if (effective !== READ_ONLY && KNOWN_WRITE_MODES.has(effective)) return
  throw new Error(effective === READ_ONLY
    ? remoteReadOnlyMessage(action, target, trouble)
    : remoteUnknownModeMessage(action, target, effective))
}

/**
 * The refusal for a command under a mode the gate does not recognise.
 *
 * Distinct from {@link remoteReadOnlyMessage} because the way out differs: a
 * `read-only` denial is the user's own choice and a mode switch fixes it, while
 * an unrecognised string is a fold the user did not choose and no switch to
 * that value helps. Naming the accepted vocabulary keeps the model from
 * retrying the same mode.
 *
 * @param {string} action - what was refused.
 * @param {string | undefined} target - the host or workspace named by the call.
 * @param {string} mode - the unrecognised mode string.
 * @returns {string} the model-facing refusal.
 */
export function remoteUnknownModeMessage (action, target, mode) {
  const where = typeof target === 'string' && target !== '' ? ` on ${target}` : ''
  return `cannot ${action}${where}: the session sandbox mode is "${String(mode)}", which this plugin does not recognise — ` +
    'the remote command was refused rather than run unconfined, because the local sandbox confines any mode outside ' +
    '{read-only, workspace-write, danger-full-access} rather than treating it as full access. Set the session to one ' +
    'of the three recognised modes. Reading still works through read / glob / grep / ops_*.'
}
