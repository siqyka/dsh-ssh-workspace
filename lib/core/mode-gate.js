/**
 * The remote-mutation gate: one answer to "may this session change the remote
 * host?", shared by every surface that can. One module because the plugin has
 * SIX write paths that do not share a call path:
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
 * The terminal gate sits in `patch-terminal.js`, not on `ctx.terminals.spawn`:
 * `spawnTerminal`'s spec carries no owner, and two callers reach it —
 * `ctx.terminals` and `dsh-api-terminal-controller` (the sidebar, bypassing
 * `ctx.terminals`). Gating the tool path alone would miss the second while its
 * test stayed green. Both stamp `spec.env.DSH_SESSION_ID`; the gate resolves
 * the session from that.
 *
 * Gating only the filesystem family was a real defect: a `read-only` session
 * ran `rm /home/dev/test/test.py` via `ssh_workspace_exec` and got exit 0.
 *
 * The filesystem half lives in `remote-fs.js`; the SCOPE question ("inside the
 * session's own workspace?") is answered here too so the transfer tool shares
 * it — see {@link workspaceWriteScopeRefusal}.
 *
 * Command execution is refused, not filtered: the local sandbox confines the
 * PROCESS (bwrap / seatbelt / ACL token); none of that crosses SSH, the remote
 * command runs as the remote login user, and parsing a command line is no
 * boundary (`sh -c 'rm -rf ~'` is pure text). So under `read-only` the choice is
 * a truthful refusal or a lying mode — this module picks the former and says why
 * in the refusal so the model does not retry blindly.
 *
 * Reads are unaffected (`read` / `glob` / `grep` / `ops_*` go over SFTP). Lost
 * is arbitrary command execution (remote `git status`, a build), which the user
 * unlocks by switching to `workspace-write` or `danger-full-access`.
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
 * Modes the remote gate recognises; a resolved policy is one of these three.
 * Anything else is an old fold or a corrupt value, and the gate fails CLOSED on
 * it — the LOCAL sandbox does the same: a mode that is neither
 * `danger-full-access` nor `read-only` takes the containment branch, and
 * `writableRoots(policy)` returns `[]` unless it is `workspace-write`
 * (`dsh-sandbox` index.js:166). A remote write on an unknown string that skipped
 * both fences would be WEAKER than the local answer — the divergence this
 * constant prevents.
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
 * Why a write is denied, as a stable reason the API can carry.
 *
 * `writeModeRefusal` returns prose for the model; the UI needs the same
 * distinction as a code so it does not tell the user to "switch off read-only"
 * when the mode is not read-only at all. Keeping the two answers in this module
 * is what stops the routes and the probe from drifting.
 *
 * @param {string | undefined} mode - the effective sandbox mode.
 * @returns {'read-only' | 'unrecognised-mode' | undefined} the reason, or
 *   undefined when the mode permits writing (or is absent).
 */
export function writeModeDenialReason (mode) {
  if (mode === undefined || mode === null || mode === '') return undefined
  if (mode === 'danger-full-access' || mode === 'workspace-write') return undefined
  return mode === READ_ONLY ? 'read-only' : 'unrecognised-mode'
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
 * @param {object} [session] - the calling agent's session, when there is one.
 * @returns {string | undefined} the effective mode, `undefined` when unconfined.
 */
export function sessionModeOf (ctx, session) {
  return sessionPolicyOf(ctx, session)?.mode
}

/**
 * Read the sandbox-policy service off a host context, tolerating both shapes.
 *
 * `ctx.get(name)` always works (Cordis resolves by name for any caller).
 * Property access (`ctx.sandboxPolicy`) does NOT on a real Cordis context — it
 * is trapped and throws `cannot get property "sandboxPolicy" without inject`;
 * test plain-object contexts expose the property and have no `get`. So the
 * property read is a wrapped FALLBACK behind `ctx.get`: the old
 * `ctx?.get?.(...) ?? ctx?.sandboxPolicy` looked safe but `ctx.get` returning
 * `undefined` (an ordinary absent service) fell into the trap and threw, making
 * absent indistinguishable from broken and failing the acceptance suite on a
 * real host.
 *
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
 * Resolve a session's whole policy — mode AND workspace root — with a reason
 * when it could not be resolved.
 *
 * "policy says read-only" vs "policy could not be read" differs in the MESSAGE,
 * not the decision: both refuse, but only the first may claim the user chose
 * `read-only`. Calling a broken service a "view only" setting sends the user to
 * a useless mode switch and hides a real defect.
 *
 * Resolution can fail because `SandboxPolicyService.resolve` runs
 * `session.header.cwd` through `path.isAbsolute`, and `ssh://` is only
 * "absolute" because `fs-shim.js` patches `node:path`; if that patch is missing
 * every remote session throws here — a wiring bug that must read as one.
 *
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
 * deployment-wide, so a session rooted at `ssh://dev/home/dev/proj` could write
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
 * @returns {string} the model-facing refusal.
 */
export function remoteUnknownModeMessage (action, target, mode) {
  const where = typeof target === 'string' && target !== '' ? ` on ${target}` : ''
  return `cannot ${action}${where}: the session sandbox mode is "${String(mode)}", which this plugin does not recognise — ` +
    'the remote command was refused rather than run unconfined, because the local sandbox confines any mode outside ' +
    '{read-only, workspace-write, danger-full-access} rather than treating it as full access. Set the session to one ' +
    'of the three recognised modes. Reading still works through read / glob / grep / ops_*.'
}
