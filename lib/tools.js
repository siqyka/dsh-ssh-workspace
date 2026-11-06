/**
 * Agent tools for the remote-workspace plugin.
 *
 * These do not duplicate the filesystem tools: file contents are served by
 * `ctx.fs` (SFTP) so read/write/edit work on a remote workspace, and the
 * shell tools route `ssh://` workdirs to the host (patch-shell.js). What the
 * model still needs is host discovery, the act of mounting a remote directory
 * as a workspace, a way to run commands on a host that is not (or not yet)
 * the session workspace, and port forwarding for previewing remote services.
 *
 * @module @shiqyka/dsh-ssh-workspace/tools
 */

import { SCHEMA_VERSION } from './diagnostics.js'
import { renderSelfCheck, selfCheck } from './capabilities.js'
import { buildSupportBundle } from './support-bundle.js'
import { diagnose, DIAGNOSIS_VERSION, renderDiagnosis } from './diagnosis.js'
import { readFileSync } from 'node:fs'
import { parseRemotePath, remoteBasename } from './protocol.js'
import { downloadTree, transferFile, uploadTree } from './transfer.js'
import { assertRemoteCommandAllowed, sessionPolicyOf, workspaceWriteScopeRefusal, writeModeRefusal, writeScopeRootOf } from './mode-gate.js'
import { confirmRemoteCommand, normalizePolicy } from './command-policy.js'

import { requirePeer } from './peers.js'

const { defineTool } = requirePeer('@deepseek-ai/dsh-tools')

/** Wrap text as the single content block these tools render. */
function text (value) {
  return [{ type: 'text', text: value }]
}

/**
 * The host aliases that have a cached capability probe.
 *
 * Derived from the probe cache rather than from `pool` or from the mounted
 * roots: those name hosts that are CONNECTED or MOUNTED, and a host can be
 * either without ever having been probed (a mount that failed before the probe
 * ran, a forward-only host). Reading the cache is the only way to ask "which
 * hosts do I actually have facts about?".
 *
 * @param {object} engine - the live engine.
 * @returns {string[]} aliases with a probe result, in insertion order.
 */
function probedAliases (engine) {
  try {
    return [...(engine.capabilities?.keys?.() ?? [])]
  } catch {
    return []
  }
}

/**
 * This package's version, for the diagnostic report built by the status tool.
 *
 * The tool half has no `import.meta.url`-relative package.json read of its own
 * (it runs inside the Host's module graph), so it reads the same file the route
 * half does and caches the answer. 'unknown' is an acceptable answer: a bundle
 * with an unknown version is still useful, a bundle that refuses to build is
 * not.
 *
 * @returns {string} the version.
 */
let pluginVersionCache
function pluginVersionOf () {
  if (pluginVersionCache === undefined) {
    try {
      pluginVersionCache = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? 'unknown'
    } catch {
      pluginVersionCache = 'unknown'
    }
  }
  return pluginVersionCache
}

/** Render the host table. */
function renderHosts (hosts, extra = {}) {
  // "Empty" and "unreadable" must not render the same: one means "add a host",
  // the other means "your configuration is there but I cannot see it".
  const notes = []
  if (extra.storeError !== undefined) notes.push(`note: the host store could not be read: ${extra.storeError}`)
  for (const reason of extra.skipped ?? []) notes.push(`note: ${reason}`)
  if (hosts.length === 0) {
    return ['no SSH hosts available — add one in the 远程工作区 panel or to ~/.ssh/config', ...notes].join('\n')
  }
  const rows = hosts.map(host => [
    host.alias,
    `${host.user}@${host.host}:${host.port}`,
    host.auth,
    host.keyReady ? 'ready' : 'check-key',
    host.source,
    host.description ?? '-',
  ].join(' | '))
  const lines = ['alias | address | auth | key | source | description', '--- | --- | --- | --- | --- | ---', ...rows, ...notes]
  return lines.join('\n')
}

/** Render one remote exec outcome (mirrors the local shell tools' convention). */
function renderExec (result) {
  const marker = result.timedOut
    ? '[timed out]'
    : result.outcome === 'unknown'
      ? '[outcome unknown]'
      : `[exit code: ${result.exitCode ?? 'null'}]`
  const parts = [marker]
  // "Unknown" is the one thing a reader must not confuse with "did not run":
  // the connection died after the command was accepted, so it may have
  // completed. Say so before the captured output, not after it.
  if (result.outcome === 'unknown') {
    parts.push('the connection was lost while this command was running; it may have completed on the host — check before re-running it')
  }
  if (result.stdout !== '') parts.push(`stdout:\n${result.stdout}`)
  if (result.stderr !== '') parts.push(`stderr:\n${result.stderr}`)
  if (result.error !== undefined) parts.push(`error: ${result.error}`)
  parts.push(`duration: ${result.durationMs} ms`)
  return parts.join('\n')
}

/**
 * Render the remote-capability probe as advisory lines.
 *
 * Only a KNOWN-missing tool is worth a line: a capability the probe could not
 * determine stays silent rather than claiming the tool is absent.
 *
 * @param {{rg?: boolean, git?: boolean, inotifywait?: boolean} | undefined} capabilities - probe result.
 * @returns {string[]} zero or more advisory lines.
 */
function capabilityLines (capabilities) {
  if (capabilities === undefined) return []
  const lines = []
  if (capabilities.rg === false) {
    lines.push('note: ripgrep (rg) is not installed on this host — glob / grep will fail with exit 127 until it is installed')
  }
  if (capabilities.git === false) {
    lines.push('note: git is not installed on this host — workspace change tracking (diff / changes panel) is disabled')
  }
  if (capabilities.inotifywait === false) {
    lines.push('note: inotifywait is not installed on this host — file-tree / preview auto-refresh uses polling (a few seconds behind)')
  }
  return lines
}

/**
 * Resolve the deployment's workspace registry, when one is mounted.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 * @returns {object | undefined} the registry service.
 */
function registryOf (ctx) {
  try {
    return ctx.get('workspaceRegistry')
  } catch {
    return undefined
  }
}

/**
 * Register a remote directory as a durable DSH workspace.
 *
 * `WorkspaceRegistry.create()` canonicalizes with Node's `fs.realpath`, which
 * cannot resolve a URI spelling, so registration goes through the registry's
 * `createCanonical` — the same durable two-write path, minus the host realpath
 * assertion that a remote path can never satisfy.
 *
 * @param {object} registry - the workspace registry service.
 * @param {string} workspacePath - the canonical `ssh://` workspace path.
 * @param {string} title - display title.
 * @returns {Promise<{id: string, created: boolean}>} the workspace identity.
 */
async function registerWorkspace (registry, workspacePath, title) {
  const existing = registry.list().find(entity => entity.path === workspacePath)
  if (existing !== undefined) return { id: String(existing.id ?? existing.path), created: false }
  if (typeof registry.createCanonical !== 'function') {
    throw new Error('this deployment\'s workspace registry cannot register a remote path; start a session with cwd set to the ssh:// path instead')
  }
  const entity = await registry.createCanonical(workspacePath, title)
  return { id: String(entity.id ?? workspacePath), created: true }
}

/**
 * Build every agent tool this plugin publishes.
 *
 * @param {object} ctx - host plugin context.
 * @param {import('./engine.js').SshWorkspaceEngine} engine - the live engine.
 * @param {import('./remote-fs.js').RemoteFileSystem} router - the mounted router.
 * @param {import('./forward.js').ForwardManager} forwards - the port-forward manager.
 * @param {import('./shell.js').ShellManager} [shells] - the persistent-shell manager.
 * @returns {Array<object>} registry-ready tool definitions.
 */
/**
 * The confirmation policy for one tool call.
 *
 * Read from the plugin config on every call rather than captured once: the
 * panel writes the setting, and a captured copy would leave the switch inert
 * until the plugin reloaded — which is the same "I turned it on and nothing
 * happened" that this feature exists to avoid.
 *
 * @param {object} ctx - the plugin context (carries `config`).
 * @returns {{mode: string, rules: string[]}} the normalized policy.
 */
function confirmationPolicyOf (ctx) {
  try {
    return normalizePolicy(ctx?.config?.confirmCommands)
  } catch {
    // An unreadable config must not disable the gate. `normalizePolicy` already
    // maps junk to `off`; a THROW here means the config accessor itself is
    // broken, and off is still the honest reading of "no policy configured".
    return normalizePolicy(undefined)
  }
}

export function workspaceTools (ctx, engine, router, forwards, shells) {
  // Resolved once per tool-set build: the service is looked up lazily at request
  // time below, but `ctx.get` on a missing service throws in some Host versions,
  // so the lookup is guarded in exactly one place.
  const approvalOf = () => {
    try {
      return ctx?.get?.('approval')
    } catch {
      return undefined
    }
  }
  return [
    hostsTool(engine),
    mountTool(ctx, engine, router),
    unmountTool(ctx, engine, router),
    enableTool(ctx, engine, router),
    statusTool(engine, router, forwards, shells),
    execTool(ctx, engine, approvalOf),
    transferTool(engine, ctx, router),
    // Only offered when the plugin actually owns a shell manager: a tool that
    // cannot keep a session alive must not promise persistence.
    ...(shells === undefined ? [] : [shellTool(ctx, shells, approvalOf)]),
    forwardTool(forwards),
    unforwardTool(forwards),
  ]
}

/** List the SSH hosts this workspace can mount. */
function hostsTool (engine) {
  return defineTool({
    name: 'ssh_workspace_hosts',
    description: 'List SSH hosts available for remote workspaces: entries from the plugin host store plus concrete Host blocks from ~/.ssh/config. ' +
      'Use the alias with ssh_workspace_mount to mount a remote directory as a workspace, or with ssh_workspace_exec to run a remote command. ' +
      'Hosts can be added, edited and deleted in the "远程工作区" panel of the Web GUI. ' +
      'Triggers: remote host, server list, which servers, ssh alias.',
    parameters: {
      query: { type: 'string', description: 'Optional case-insensitive match against alias, host, user, description and tags.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hosts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                alias: { type: 'string', required: true },
                host: { type: 'string', required: true },
                port: { type: 'integer', required: true },
                user: { type: 'string', required: true },
                auth: { type: 'string', required: true, enum: ['key', 'password', 'agent'] },
                keyReady: { type: 'boolean', required: true },
                source: { type: 'string', required: true },
                description: { type: 'string' },
                tags: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
          // Both are returned by `execute` (a skipped host with its REASON, and
          // a store that could not be read at all) and neither was declared
          // under `additionalProperties: false`. The distinction they carry is
          // the one the tool's own comment insists on — "no hosts" versus
          // "cannot see the hosts" — so a host that validated the result would
          // have removed exactly the field that distinction lives in.
          skipped: { type: 'array', items: { type: 'string' } },
          storeError: { type: 'string' },
        },
      },
      render: (_args, value) => text(renderHosts(value.hosts ?? [])),
    },
    async execute (args) {
      const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
      const listing = engine.store.listing?.() ?? { rows: engine.store.rows(), skipped: [] }
      let rows = listing.rows
      if (query !== '') {
        rows = rows.filter(row => [row.alias, row.host, row.user, row.description ?? '', ...(row.tags ?? [])]
          .join(' ')
          .toLowerCase()
          .includes(query))
      }
      // A host that could not be listed is not a host that does not exist; the
      // model must be able to tell "none" from "cannot see".
      return {
        hosts: rows,
        ...(listing.skipped?.length > 0 ? { skipped: listing.skipped.map(entry => entry.reason) } : {}),
        ...(listing.storeError === undefined ? {} : { storeError: listing.storeError }),
      }
    },
  })
}

/**
 * Prove a remote path exists and is a directory, through the RAW connection.
 *
 * Never through `engine.fs`: the filesystem router serves the detached fence,
 * so a probe through it would refuse every re-mount or enable of a detached
 * workspace — the action would be impossible by construction.
 *
 * The error text is rewritten, not forwarded. SFTP's own message for a missing
 * path is "No such file": true, and useless. It does not name the target, and
 * the caller supplied two things that could be wrong (the alias and the path).
 * A mount that fails without saying which path it probed leaves the model
 * guessing, and guessing is how a typo becomes a "the host is broken" report.
 *
 * @param {object} engine - the SSH engine (used for its pooled connection).
 * @param {string} alias - host alias.
 * @param {string} remotePath - absolute path on the host.
 * @returns {Promise<void>} resolves when the path is a directory.
 */
async function assertRemoteDirectory (engine, alias, remotePath) {
  await engine.withSftp(alias, async (sftp) => {
    const stats = await new Promise((resolve, reject) => {
      sftp.stat(remotePath, (error, attrs) => { if (error) reject(error); else resolve(attrs) })
    }).catch((error) => {
      // ssh2 surfaces the SFTP status code; 2 is SSH_FX_NO_SUCH_FILE. The text
      // fallback covers transports that report the wrong code.
      const code = error?.code
      if (code === 2 || /no such file/iu.test(String(error?.message))) {
        throw new Error(`no such directory on ${alias}: ${remotePath}`)
      }
      throw new Error(`cannot stat ${remotePath} on ${alias}: ${error instanceof Error ? error.message : String(error)}`)
    })
    if (typeof stats?.isDirectory !== 'function' || !stats.isDirectory()) {
      throw new Error(`not a directory on ${alias}: ${remotePath}`)
    }
  })
}

/** Mount a remote directory as a workspace. */
function mountTool (ctx, engine, router) {
  return defineTool({
    name: 'ssh_workspace_mount',
    description: 'Mount a directory on a remote SSH host as a DSH workspace. The returned ssh:// path can be used as a session workspace, after which read/write/edit operate on the remote files over SFTP and pwsh/bash commands in that workspace run on the remote host. ' +
      'Verify the directory exists first (ssh_workspace_exec with ls). Triggers: open remote folder, work on the server, remote workspace, mount remote directory.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Host alias from ssh_workspace_hosts.' },
      remotePath: { type: 'string', required: true, description: 'Absolute directory path ON THE REMOTE HOST, e.g. /home/user/project.' },
      title: { type: 'string', description: 'Display title for the workspace (defaults to the directory name).' },
      register: { type: 'boolean', description: 'Also register it as a durable DSH workspace so it appears in the workspace list (default true).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          workspacePath: { type: 'string', required: true },
          title: { type: 'string', required: true },
          registered: { type: 'boolean', required: true },
          workspaceId: { type: 'string' },
          entryCount: { type: 'integer' },
          capabilities: {
            type: 'object',
            additionalProperties: false,
            properties: {
              rg: { type: 'boolean' },
              git: { type: 'boolean' },
              inotifywait: { type: 'boolean' },
            },
          },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => text(value.ok
        ? [
            `mounted ${value.workspacePath}`,
            `title: ${value.title}`,
            value.registered ? `registered as a DSH workspace${value.workspaceId === undefined ? '' : ` (id ${value.workspaceId})`}` : 'not registered (kept for this process only)',
            value.entryCount === undefined ? '' : `directory contains ${value.entryCount} entries`,
            ...capabilityLines(value.capabilities),
            '',
            'Use this path as the session workspace. In this workspace, file tools act on the REMOTE host, and shell commands (pwsh/bash) run on the REMOTE host too, in POSIX shell semantics.',
          ].filter(line => line !== '').join('\n')
        : `mount failed: ${value.error ?? 'unknown error'}`),
    },
    async execute (args, exec) {
      const alias = String(args.alias ?? '').trim()
      const remotePath = String(args.remotePath ?? '').trim()
      if (alias === '') return { ok: false, workspacePath: '', title: '', registered: false, error: 'alias is required' }
      if (!remotePath.startsWith('/')) {
        return { ok: false, workspacePath: '', title: '', registered: false, error: 'remotePath must be an absolute path on the remote host (e.g. /home/user/project)' }
      }
      try {
        // Verify the target really is a directory on the remote host before
        // anything durable is written. Probed through the RAW connection rather
        // than `engine.fs`: re-mounting a DETACHED workspace is the ordinary way
        // to revive one, and the router refuses every read inside a detached
        // workspace — so a probe through it would make that impossible.
        await assertRemoteDirectory(engine, alias, remotePath)
        const workspacePath = router.addRoot(alias, remotePath)
        const title = typeof args.title === 'string' && args.title.trim() !== '' ? args.title.trim() : remoteBasename(remotePath)
        let entryCount
        try {
          const listing = await engine.fs.listDir({ targetKey: workspacePath, displayPath: workspacePath }, exec?.signal)
          entryCount = listing.length
        } catch {
          entryCount = undefined
        }
        let registered = false
        let workspaceId
        let registrationError
        if (args.register !== false) {
          const registry = registryOf(ctx)
          if (registry !== undefined) {
            try {
              const outcome = await registerWorkspace(registry, workspacePath, title)
              registered = true
              workspaceId = outcome.id
            } catch (error) {
              registrationError = error instanceof Error ? error.message : String(error)
            }
          } else {
            registrationError = 'no workspace registry is mounted'
          }
        }
        // Advisory only: a host that cannot be probed must not fail the mount.
        let capabilities
        try {
          const probed = await engine.probeCapabilities(alias, { signal: exec?.signal })
          if (probed.rg !== undefined || probed.git !== undefined || probed.inotifywait !== undefined) capabilities = probed
        } catch { /* probe is best-effort */ }
        return {
          ok: true,
          workspacePath,
          title,
          registered,
          ...(workspaceId !== undefined ? { workspaceId } : {}),
          ...(entryCount !== undefined ? { entryCount } : {}),
          ...(capabilities !== undefined ? { capabilities } : {}),
          ...(registrationError !== undefined && !registered ? { error: `mounted in-process, but not registered: ${registrationError}` } : {}),
        }
      } catch (error) {
        return { ok: false, workspacePath: '', title: '', registered: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}

/** Stop serving a mounted remote directory. */
function unmountTool (ctx, engine, router) {
  return defineTool({
    name: 'ssh_workspace_unmount',
    description: 'Stop serving a mounted remote directory. By default ("detach") the DSH workspace record and its sessions are both KEPT — the sidebar row stays (greyed) with its sessions under it, and ssh_workspace_enable restores service. Pass mode "deregister" to also drop the workspace record; that removes the sidebar row, and then its sessions are archived (hidden from the session lists but neither deleted nor moved). Live sessions using it keep their own copy of the path. ' +
      'Triggers: close remote folder, unmount remote workspace, disconnect workspace, detach workspace.',
    parameters: {
      workspacePath: { type: 'string', required: true, description: 'The ssh:// path returned by ssh_workspace_mount.' },
      mode: { type: 'string', enum: ['detach', 'deregister'], description: 'detach (default) keeps the workspace record and its sessions so the workspace can be re-enabled; deregister also removes the record, and archives its sessions. Neither deletes session files.' },
      archiveSessions: { type: 'boolean', description: 'Archive the workspace sessions. Defaults to the mode: false for detach (which keeps the record, so its sessions must stay visible), true for deregister. Archiving is reversible.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          mode: { type: 'string', required: true },
          wasMounted: { type: 'boolean', required: true },
          deregistered: { type: 'boolean', required: true },
          archived: { type: 'array', required: true, items: { type: 'string' } },
          archiveFailed: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string', required: true },
                error: { type: 'string', required: true },
              },
            },
          },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return text(`unmount failed: ${value.error ?? 'unknown error'}`)
        const lines = [
          `detached${value.wasMounted ? '' : ' (it was not mounted)'}: workspace record ${value.deregistered ? 'removed' : 'kept'}`,
          `archived sessions: ${value.archived.length}`,
        ]
        for (const failure of value.archiveFailed ?? []) lines.push(`  could not archive ${failure.sessionId}: ${failure.error}`)
        if (!value.deregistered) lines.push('re-enable it with ssh_workspace_enable to mount it again and unarchive its sessions')
        return text(lines.join('\n'))
      },
    },
    async execute (args, exec) {
      const workspacePath = String(args.workspacePath ?? '').trim()
      const mode = args.mode === 'deregister' ? 'deregister' : 'detach'
      // Archiving follows the record deletion, not a separate constant: keeping
      // the workspace record means the sidebar group and its sessions stay, so
      // archiving them would empty the group the user chose to keep.
      const archiveSessions = typeof args.archiveSessions === 'boolean' ? args.archiveSessions : mode !== 'detach'
      try {
        const wasMounted = router.disableRoot(workspacePath)
        engine.store.entryStore.disableWorkspace(workspacePath)
        const registry = registryOf(ctx)
        const entity = registry?.list?.().find(candidate => candidate.path === workspacePath)
        const archived = archiveSessions && entity !== undefined && typeof registry?.archiveSession === 'function'
          ? await archiveSessionIds(registry, entity.sessionIds ?? [])
          : { ok: [], failed: [] }
        let deregistered = false
        if (mode === 'deregister' && entity !== undefined && typeof registry?.delete === 'function') {
          await registry.delete(entity.id)
          deregistered = true
        }
        if (mode === 'deregister') {
          // A deleted record must leave nothing behind: the persisted detached
          // mark and the runtime fence come down too, or the panel would keep a
          // re-enable button for a workspace that no longer exists anywhere.
          router.enableRoot(workspacePath)
          engine.store.entryStore.enableWorkspace(workspacePath)
        }
        return {
          ok: true,
          mode,
          wasMounted,
          deregistered,
          archived: archived.ok,
          ...(archived.failed.length === 0 ? {} : { archiveFailed: archived.failed }),
        }
      } catch (error) {
        return { ok: false, mode, wasMounted: false, deregistered: false, archived: [], error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}

/**
 * Archive one batch of sessions, collecting per-session failures.
 *
 * A session with running work is refused by the registry (that is its
 * documented behaviour without `stopActivity`), and one refusal must not cost
 * the rest of the batch.
 *
 * @param {object} registry - the workspace registry.
 * @param {string[]} sessionIds - the sessions to archive.
 * @returns {Promise<{ok: string[], failed: Array<{sessionId: string, error: string}>}>} the outcome.
 */
async function archiveSessionIds (registry, sessionIds) {
  const ok = []
  const failed = []
  for (const sessionId of sessionIds) {
    try {
      await registry.archiveSession(sessionId)
      ok.push(sessionId)
    } catch (error) {
      failed.push({ sessionId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { ok, failed }
}

/** Mount a detached remote workspace again and restore its archived sessions. */
function enableTool (ctx, engine, router) {
  return defineTool({
    name: 'ssh_workspace_enable',
    description: 'Mount a previously detached remote workspace again and unarchive the sessions that ssh_workspace_unmount archived. The remote directory must still exist. ' +
      'Triggers: re-enable remote workspace, mount again, enable workspace, restore detach.',
    parameters: {
      workspacePath: { type: 'string', required: true, description: 'The ssh:// path that was detached.' },
      unarchiveSessions: { type: 'boolean', description: 'Unarchive the workspace sessions (default true).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          workspacePath: { type: 'string', required: true },
          registered: { type: 'boolean', required: true },
          unarchived: { type: 'array', required: true, items: { type: 'string' } },
          unarchiveFailed: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string', required: true },
                error: { type: 'string', required: true },
              },
            },
          },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return text(`enable failed: ${value.error ?? 'unknown error'}`)
        const lines = [`mounted again: ${value.workspacePath}`, `unarchived sessions: ${value.unarchived.length}`]
        for (const failure of value.unarchiveFailed ?? []) lines.push(`  could not unarchive ${failure.sessionId}: ${failure.error}`)
        return text(lines.join('\n'))
      },
    },
    async execute (args, exec) {
      const workspacePath = String(args.workspacePath ?? '').trim()
      const unarchiveSessions = args.unarchiveSessions !== false
      try {
        const parts = parseRemotePath(workspacePath)
        if (parts === undefined) throw new Error(`not a remote workspace path: ${JSON.stringify(workspacePath)}`)
        // Verified through the RAW connection, never through `engine.fs`: the
        // filesystem router is the very thing serving the detached fence, so a
        // probe through it would refuse every enable of a detached workspace —
        // the action would be impossible by construction.
        await assertRemoteDirectory(engine, parts.alias, parts.remotePath)
        const mounted = router.addRoot(parts.alias, parts.remotePath)
        engine.store.entryStore.enableWorkspace(workspacePath)
        const registry = registryOf(ctx)
        let entity = registry?.list?.().find(candidate => candidate.path === workspacePath)
        let registered = entity !== undefined
        if (entity === undefined && typeof registry?.createCanonical === 'function') {
          entity = await registry.createCanonical(workspacePath, parts.remotePath.split('/').pop())
          registered = true
        }
        const unarchived = unarchiveSessions && entity !== undefined && typeof registry?.unarchiveSession === 'function'
          ? await unarchiveSessionIds(registry, entity.sessionIds ?? [])
          : { ok: [], failed: [] }
        return {
          ok: true,
          workspacePath: mounted,
          registered,
          unarchived: unarchived.ok,
          ...(unarchived.failed.length === 0 ? {} : { unarchiveFailed: unarchived.failed }),
        }
      } catch (error) {
        return { ok: false, workspacePath: '', registered: false, unarchived: [], error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}

/**
 * Unarchive one batch of sessions, collecting per-session failures.
 *
 * @param {object} registry - the workspace registry.
 * @param {string[]} sessionIds - the sessions to unarchive.
 * @returns {Promise<{ok: string[], failed: Array<{sessionId: string, error: string}>}>} the outcome.
 */
async function unarchiveSessionIds (registry, sessionIds) {
  const ok = []
  const failed = []
  for (const sessionId of sessionIds) {
    try {
      await registry.unarchiveSession(sessionId)
      ok.push(sessionId)
    } catch (error) {
      failed.push({ sessionId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { ok, failed }
}

/**
 * The bundle input the status tool can assemble from its own collaborators.
 *
 * Deliberately the same field names the route hands `buildSupportBundle`, so
 * the two surfaces cannot diverge in what a report contains — only in what
 * they can reach (`hostVersion` is unknowable here, because the tool context
 * does not expose the Host's version service; saying so plainly is better
 * than an empty field a reader would read as "not installed").
 *
 * Defended like the route's version: a status call must not throw because a
 * deployment assembled without one optional collaborator.
 *
 * @param {object} engine - the engine.
 * @param {object} router - the mount router.
 * @param {object} forwards - the live forward manager.
 * @returns {object} the bundle input.
 */
function statusBundleInput (engine, router, forwards) {
  let listing
  try {
    listing = engine.store?.listing?.() ?? { rows: engine.store?.rows?.() ?? [], skipped: [] }
  } catch {
    listing = { rows: [], skipped: [] }
  }
  return {
    generatedAt: Date.now(),
    pluginVersion: pluginVersionOf(),
    hostVersion: 'unknown (the status tool cannot read the Host version service; the panel can)',
    nodeVersion: process.version,
    platform: `${process.platform}-${process.arch}`,
    upstreamWorkarounds: engine.upstreamWorkarounds ?? [],
    events: engine.diagnostics?.list(20) ?? [],
    hosts: listing.rows ?? [],
    hostsSkipped: listing.skipped ?? [],
    ...(listing.storeError === undefined ? {} : { storeError: listing.storeError }),
    mounted: router.listRoots(),
    disabled: router.listDisabled(),
    connections: [...(engine.pool?.entries?.() ?? [])].map(([alias, record]) => ({
      alias,
      state: record.broken ? 'broken' : 'connected',
      inFlight: record.inFlight,
      generation: record.generation ?? 0,
    })),
    reconnecting: engine.reconnector?.list?.() ?? [],
    forwards: forwards.list(),
    capabilities: probedAliases(engine).map(alias => ({
      alias,
      tools: engine.capabilities.get(alias),
      environment: engine.environmentOf?.(alias) ?? {},
    })),
    commands: engine.audit?.list?.(50) ?? [],
    unpinnedHostKeys: (engine.unpinnedHostKeyRows?.() ?? []).map(entry => ({
      alias: entry.alias,
      keyType: entry.keyType,
      fingerprint: entry.fingerprint,
    })),
  }
}

/** Report mounted remote workspaces, connection state, and port forwards. */
function statusTool (engine, router, forwards, shells) {
  return defineTool({
    name: 'ssh_workspace_status',
    description: 'Report the mounted remote workspaces, which SSH connections are live, open port forwards, and whether the filesystem seam is currently serving remote paths. ' +
      'Triggers: remote workspace status, is the ssh connection up, mounted folders, port forwarding status.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mounted: { type: 'array', required: true, items: { type: 'string' } },
          disabled: { type: 'array', required: true, items: { type: 'string' } },
          connections: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                alias: { type: 'string', required: true },
                state: { type: 'string', required: true },
                inFlight: { type: 'integer', required: true },
                generation: { type: 'integer', description: 'How many times this alias has connected in this session. A value above 1 means the transport died underneath at least one earlier operation.' },
                generationNote: { type: 'string', description: 'One sentence about continuity: what a generation above 1 means for work started earlier.' },
              },
            },
          },
          // Hosts the background loop is working on: a dropped connection that
          // nobody is currently operating on still recovers, and this is how a
          // reader learns it is in progress rather than dead. Present only when
          // there is something to report, so the common reply stays short.
          reconnecting: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                alias: { type: 'string', required: true },
                phase: { type: 'string', required: true },
                attempts: { type: 'integer', required: true },
                nextAt: { type: 'integer', required: true },
                lastError: { type: 'string', required: true },
                reason: { type: 'string', required: true },
              },
            },
          },
          forwards: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                alias: { type: 'string', required: true },
                localHost: { type: 'string', required: true },
                localPort: { type: 'integer', required: true },
                remoteHost: { type: 'string', required: true },
                remotePort: { type: 'integer', required: true },
                connections: { type: 'integer', required: true },
              },
            },
          },
          fsPatched: { type: 'boolean', required: true },
          shells: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                alias: { type: 'string', required: true },
                session: { type: 'string', required: true },
                alive: { type: 'boolean', required: true },
              },
            },
          },
          // Recent connection / watcher events, newest last. Present so a
          // failure can be explained without a log file: the Host exposes no
          // console exporter, so this is the only reachable history.
          events: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                at: { type: 'integer', required: true },
                kind: { type: 'string', required: true },
                message: { type: 'string', required: true },
                alias: { type: 'string' },
              },
            },
          },
          // Upstream workarounds this process judged, one entry each. A separate
          // field rather than an event because the question it answers — "can
          // any of our patches be deleted now?" — must be answerable at a glance
          // on any startup, not only by whoever saw the event scroll by.
          upstreamWorkarounds: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                probe: { type: 'string', required: true },
                detail: { type: 'string', required: true },
              },
            },
          },
          // The exported event shape's version, and a redacted text form a
          // user can paste into a bug report. Both are additive: a reader that
          // ignores them keeps working, which is why they did not bump the
          // schema version.
          // The verdict behind the panel's status dot: `ok` / `warn` / `unknown`
          // plus one row per finding. Same module the report and `/status` use,
          // so an agent, the panel and a pasted report cannot tell three stories.
          diagnosis: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              version: { type: 'integer', required: true },
              state: { type: 'string', required: true, enum: ['ok', 'warn', 'unknown'] },
              warn: { type: 'integer', required: true },
              unknown: { type: 'integer', required: true },
              findings: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    state: { type: 'string', required: true, enum: ['warn', 'unknown'] },
                    alias: { type: 'string' },
                    detail: { type: 'string', required: true },
                  },
                },
              },
              // The self-check, as advisory rows. Same shape, deliberately NOT
              // counted into `state` / `warn` / `unknown`: a host missing an
              // optional tool still works, and a dot that goes red for that is
              // a dot nobody reads.
              notes: {
                type: 'array',
                required: true,
                description: 'Advisory self-check rows (missing optional tools, environment warnings). Never counted into state, warn or unknown.',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    state: { type: 'string', required: true, enum: ['warn', 'unknown'] },
                    alias: { type: 'string' },
                    detail: { type: 'string', required: true },
                  },
                },
              },
              text: { type: 'string', required: true, description: 'The same verdict as one pasteable sentence block.' },
            },
          },
          diagnosticsSchemaVersion: { type: 'integer' },
          diagnosticsText: { type: 'string', description: 'Recent events as redacted plain text, safe to share: paths, usernames, key names and passwords are masked.' },
          // Present only when a host's key could not be pinned, so an empty
          // array is not required: absence means "nothing to report".
          unpinnedHostKeys: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                alias: { type: 'string', required: true },
                keyType: { type: 'string', required: true },
                fingerprint: { type: 'string', required: true },
              },
            },
          },
          // What each probed host can actually do, and what its absence costs.
          // Separate from `capabilities` on the mount tool because that answer
          // is about ONE host at mount time, while this is the standing report.
          selfCheck: {
            type: 'array',
            description: 'Per-host capability self-check: which optional remote tools are present, and what their absence costs.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                alias: { type: 'string', required: true },
                missing: { type: 'array', required: true, items: { type: 'string' } },
                // The structured rows travel too, because a model reading
                // `missing` alone cannot say WHY a tool matters — and "why"
                // is the whole point of the self-check.
                rows: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      tool: { type: 'string', required: true },
                      feature: { type: 'string', required: true },
                      state: { type: 'string', required: true, enum: ['present', 'absent', 'unknown'] },
                      detail: { type: 'string' },
                      install: { type: 'string' },
                    },
                  },
                },
                text: { type: 'string', required: true, description: 'The rendered report, identical to the panel\'s wording.' },
              },
            },
          },
          // The bounded record of what this session actually ran on a host.
          // Not the same as `events`: events say what went wrong, commands say
          // what happened. Present only when something was run.
          commands: {
            type: 'array',
            description: 'Recent remote commands (redacted), oldest first. A refused entry means nothing ran.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                seq: { type: 'integer', required: true },
                at: { type: 'integer', required: true },
                alias: { type: 'string', required: true },
                command: { type: 'string', required: true },
                channel: { type: 'string', required: true },
                durationMs: { type: 'integer', required: true },
                exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
                timedOut: { type: 'boolean', required: true },
                outcomeUnknown: { type: 'boolean' },
                refused: { type: 'boolean' },
                cwd: { type: 'string' },
                error: { type: 'string' },
              },
            },
          },
          auditText: { type: 'string', description: 'The command audit as redacted plain text, safe to share.' },
          // The one artifact a user pastes into a bug report: versions, patch
          // verdicts, host configuration, self-check, commands, events — all
          // already redacted. Nothing is uploaded anywhere.
          supportBundle: { type: 'string', description: 'A complete redacted diagnostic report (versions, patches, hosts, self-check, recent commands and events). Safe to paste; it is never uploaded.' },
        },
      },
      render: (_args, value) => {
        const lines = [`fs serves remote paths: ${value.fsPatched ? 'yes' : 'no'}`]
        // The verdict leads, because it is the answer to the question the
        // caller actually asked. A tool that prints state and leaves the
        // reader to judge it is the shape this module exists to replace — the
        // report and the panel both answer "is anything wrong?", so the tool
        // does too, in the same words.
        if (value.diagnosis !== undefined) {
          for (const line of String(value.diagnosis.text ?? '').split('\n')) lines.push(line)
          lines.push('')
        }
        // Lead with the warning: a key that is trusted but not pinned means the
        // next connection will trust whatever the server presents again.
        for (const entry of value.unpinnedHostKeys ?? []) {
          lines.push(`WARNING: the host key for ${entry.alias} could not be saved (${entry.keyType} ${entry.fingerprint}) — it was accepted this time but is NOT pinned; the next connection will trust this key again on first use`)
        }
        lines.push(`mounted remote workspaces: ${value.mounted.length === 0 ? 'none' : ''}`)
        for (const root of value.mounted) lines.push(`  ${root}`)
        if ((value.disabled ?? []).length > 0) {
          lines.push('detached remote workspaces (not served; sessions kept and greyed):')
          for (const path of value.disabled) lines.push(`  ${path}`)
        }
        lines.push(`live SSH connections: ${value.connections.length === 0 ? 'none' : ''}`)
        for (const connection of value.connections) {
          lines.push(`  ${connection.alias}: ${connection.state} (in flight ${connection.inFlight})`)
          // Only a reconnect is worth a sentence. "generation 1" is the
          // ordinary case and saying it every call is noise; generation 2+
          // means work started earlier may still be running over there, and
          // that is exactly the fact a reader needs and cannot infer.
          if ((connection.generation ?? 1) > 1 && typeof connection.generationNote === 'string' && connection.generationNote !== '') {
            lines.push(`    ${connection.generationNote}`)
          }
        }
        // Only the hosts that are NOT connected need explaining; a healthy row
        // would make this section noise on every call.
        for (const retry of value.reconnecting ?? []) {
          if (retry.phase === 'gave-up') {
            lines.push(`reconnect STOPPED for ${retry.alias} after ${retry.attempts} attempt(s): ${retry.lastError}`)
          } else if (retry.phase === 'waiting') {
            const inSeconds = Math.max(0, Math.round((retry.nextAt - Date.now()) / 1000))
            lines.push(`reconnecting to ${retry.alias}: attempt ${retry.attempts} in ${inSeconds}s${retry.lastError === '' ? '' : ` (last error: ${retry.lastError})`}`)
          } else {
            lines.push(`reconnecting to ${retry.alias}: attempt ${retry.attempts} in progress`)
          }
        }
        lines.push(`port forwards: ${(value.forwards ?? []).length === 0 ? 'none' : ''}`)
        for (const forward of value.forwards ?? []) {
          lines.push(`  ${forward.id}: ${forward.localHost}:${forward.localPort} → ${forward.alias}:${forward.remoteHost}:${forward.remotePort} (${forward.connections} active)`)
        }
        if ((value.shells ?? []).length > 0) {
          lines.push('persistent remote shells:')
          for (const shell of value.shells) lines.push(`  ${shell.alias} [${shell.session}]: ${shell.alive ? 'live' : 'closed'}`)
        }
        // What each probed host can do. The rows come pre-rendered so the tool
        // and the panel cannot drift into two wordings for one fact; only the
        // hosts with something to say are printed, because "everything present"
        // on every status call is noise.
        for (const check of value.selfCheck ?? []) {
          if ((check.missing ?? []).length === 0 && !/UNKNOWN|WARN/u.test(check.text)) continue
          lines.push(`self-check for ${check.alias}:`)
          for (const line of check.text.split('\n')) lines.push(`  ${line}`)
        }
        // The command record. Only the failures and refusals get a line: a
        // successful `ls` is not news, while "this was refused" and "this
        // exited 1" are what a reader needs when reconstructing what happened.
        const noteworthy = (value.commands ?? []).filter(command => command.refused === true || command.outcomeUnknown === true || command.timedOut || (command.exitCode ?? 0) !== 0)
        if (noteworthy.length > 0) {
          lines.push('recent remote commands that failed or were refused:')
          for (const command of noteworthy.slice(-10)) {
            const status = command.refused === true
              ? 'REFUSED (nothing ran)'
              : command.outcomeUnknown === true
                ? 'outcome unknown (the connection died)'
                : command.timedOut
                  ? 'timed out'
                  : `exit ${command.exitCode}`
            lines.push(`  ${command.alias}: ${status} — ${command.command}`)
          }
        }
        // Only the states that need a human are spelled out; the normal ones
        // (`broken` = still load-bearing, `pending` = not registered yet) would
        // otherwise be noise on every single call.
        for (const workaround of value.upstreamWorkarounds ?? []) {
          if (workaround.probe === 'fixed') {
            lines.push(`upstream workaround OBSOLETE: ${workaround.id} — the Host no longer needs it, delete it (${workaround.detail})`)
          } else if (workaround.probe === 'unprobeable' || workaround.probe === 'disabled') {
            lines.push(`upstream workaround ${workaround.probe.toUpperCase()}: ${workaround.id} — ${workaround.detail}`)
          }
        }
        return text(lines.join('\n'))
      },
    },
    async execute () {
      return {
        mounted: router.listRoots(),
        disabled: router.listDisabled(),
        connections: [...engine.pool.entries()].map(([alias, record]) => ({
          alias,
          state: record.broken ? 'broken' : 'connected',
          inFlight: record.inFlight,
          // The generation is what turns "connected" into an answer about
          // continuity: generation 3 is a different session from the one the
          // caller started in, and a remote process from generation 2 may
          // still be running.
          generation: record.generation ?? 0,
          generationNote: engine.describeGeneration?.(alias) ?? '',
        })),
        ...(engine.reconnector === undefined ? {} : {
          reconnecting: engine.reconnector.list().map(entry => ({
            alias: entry.alias,
            phase: entry.phase,
            attempts: entry.attempts,
            nextAt: entry.nextAt,
            lastError: entry.lastError,
            reason: entry.reason,
          })),
        }),
        ...(shells === undefined ? {} : { shells: shells.list() }),
        events: engine.diagnostics?.list(10) ?? [],
        // The version and a portable, redacted text form: a report a user can
        // paste into an issue without leaking paths, usernames or secrets.
        diagnosticsSchemaVersion: SCHEMA_VERSION,
        diagnosticsText: engine.diagnostics?.exportText?.({ limit: 20 }) ?? '',
        upstreamWorkarounds: (engine.upstreamWorkarounds ?? []).map(entry => ({
          id: entry.id,
          probe: entry.probe,
          detail: entry.detail,
        })),
        // A host whose key was accepted but not written to the store is no
        // longer protected by trust-on-first-use, and that fact belongs where a
        // reader looks for state rather than in a log nothing reads.
        unpinnedHostKeys: (engine.unpinnedHostKeyRows?.() ?? []).map(entry => ({
          alias: entry.alias,
          keyType: entry.keyType,
          fingerprint: entry.fingerprint,
        })),
        forwards: forwards.list().map(forward => ({
          id: forward.id,
          alias: forward.alias,
          localHost: forward.localHost,
          localPort: forward.localPort,
          remoteHost: forward.remoteHost,
          remotePort: forward.remotePort,
          connections: forward.connections,
        })),
        // One self-check row per host that has been probed. Derived from the
        // cache rather than probing here: the status tool is a READ, and a
        // status call that dials every host would make "how are things?"
        // itself expensive and observable as network traffic.
        selfCheck: probedAliases(engine).map(alias => {
          const report = selfCheck(engine.capabilities.get(alias), engine.environmentOf(alias))
          return { alias, missing: report.missing, rows: report.rows, text: renderSelfCheck(report) }
        }),
        ...(engine.audit === undefined ? {} : {
          commands: engine.audit.list(20),
          auditText: engine.audit.exportText(20),
        }),
        ...(engine.audit === undefined ? {} : {
          supportBundle: buildSupportBundle(statusBundleInput(engine, router, forwards)),
        }),
        // The verdict, from the SAME input the bundle above was built from —
        // one gather, two renderings. `text` travels too so an agent reads the
        // sentence rather than reassembling it from the fields.
        diagnosis: (() => {
          const report = diagnose(statusBundleInput(engine, router, forwards))
          return {
            version: DIAGNOSIS_VERSION,
            state: report.state,
            warn: report.warn,
            unknown: report.unknown,
            findings: report.findings,
            notes: report.notes,
            text: renderDiagnosis(report),
          }
        })(),
        fsPatched: true,
      }
    },
  })
}

/** Run a shell command on a remote host. */
function execTool (ctx, engine, approvalOf) {
  return defineTool({
    name: 'ssh_workspace_exec',
    description: 'Run a shell command ON A REMOTE SSH HOST without mounting it (host discovery, paths outside the mounted roots, setup tasks). Inside a mounted ssh:// workspace the pwsh/bash tools already run on that host, so prefer them there. ' +
      'Use this tool to inspect a remote directory before mounting, or to build/test outside the workspace roots. ' +
      'For a long build or server start, pass run_in_background: the call returns a job id immediately and its output is collected like any other background job. ' +
      'A command is NOT replayed after a connection loss: it may have run, so the result reports outcome "unknown" rather than being executed twice. ' +
      'Triggers: run on server, remote command, build on server, check remote directory.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Host alias from ssh_workspace_hosts.' },
      command: { type: 'string', required: true, description: 'Shell command to run on the remote host.' },
      cwd: { type: 'string', description: 'Remote working directory (optional).' },
      timeoutMs: { type: 'integer', description: 'Timeout in milliseconds (default 60000). Ignored when run_in_background is set.' },
      run_in_background: { type: 'boolean', description: 'Start the command as a background job and return its id instead of waiting for it.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean', required: true },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
          timedOut: { type: 'boolean', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
          durationMs: { type: 'integer', required: true },
          outcome: { type: 'string', enum: ['unknown'], description: 'Present when the connection died while the command was running: the remote side may have executed it, so check before re-running.' },
          jobId: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => text(value.jobId !== undefined
        ? `started background job ${value.jobId} on the remote host\ncollect it with job_output ${value.jobId} (job_kill to stop it)`
        : renderExec(value)),
    },
    async execute (args, exec) {
      const alias = String(args.alias ?? '')
      const command = String(args.command ?? '')
      const cwd = typeof args.cwd === 'string' && args.cwd !== '' ? args.cwd : undefined
      // A remote command runs as the remote login user with that user's full
      // permissions, so the session's mode is the only thing that can speak for
      // "view only" — nothing downstream can confine the process. Without this,
      // `read-only` + `rm file` succeeded and reported exit 0.
      try {
        assertRemoteCommandAllowed(sessionSandboxPolicy(ctx, exec), 'run a remote command', `ssh://${alias}`)
      } catch (error) {
        // A refusal is the single most interesting audit entry there is: it is
        // the one case where "did anything run on the host?" has a definite
        // answer (no), and a reader of the log otherwise sees a gap.
        engine.audit?.record({
          at: Date.now(),
          alias,
          command,
          channel: 'exec',
          durationMs: 0,
          refused: true,
          ...(cwd === undefined ? {} : { cwd }),
          error: error instanceof Error ? error.message : String(error),
        })
        return {
          success: false,
          exitCode: null,
          timedOut: false,
          stdout: '',
          stderr: '',
          truncated: false,
          durationMs: 0,
          error: error instanceof Error ? error.message : String(error),
        }
      }
      // The confirmation gate sits AFTER the mode gate and BEFORE anything
      // touches the host. Two gates, two different questions: the mode asks
      // "is this session allowed to run commands at all", the policy asks
      // "should this particular command be confirmed first". A user in
      // `danger-full-access` still gets the confirmation.
      const refusal = await confirmRemoteCommand({
        approval: approvalOf?.(),
        policyFor: () => confirmationPolicyOf(ctx),
        command,
        exec,
        action: 'run a remote command',
        target: `ssh://${alias}`,
      })
      if (refusal !== undefined) {
        // A refusal is the single most interesting audit entry there is: it is
        // the one case where "did anything run on the host?" has a definite
        // answer (no).
        engine.audit?.record({
          at: Date.now(),
          alias,
          command,
          channel: 'exec',
          durationMs: 0,
          refused: true,
          ...(cwd === undefined ? {} : { cwd }),
          error: refusal,
        })
        return {
          success: false,
          exitCode: null,
          timedOut: false,
          stdout: '',
          stderr: '',
          truncated: false,
          durationMs: 0,
          error: refusal,
        }
      }
      // Running inside a detached workspace is running the workspace. A cwd
      // outside one (the login directory, a scratch path) is host operation
      // and stays available — that is what "keep the SSH connection" means.
      try {
        if (cwd !== undefined) engine.assertNotDisabled(alias, cwd)
      } catch (error) {
        return {
          success: false,
          exitCode: null,
          timedOut: false,
          stdout: '',
          stderr: '',
          truncated: false,
          durationMs: 0,
          error: error instanceof Error ? error.message : String(error),
        }
      }
      if (args.run_in_background === true) {
        return await startBackgroundExec(ctx, engine, alias, command, { cwd }, exec)
      }
      try {
        return await engine.exec(alias, command, {
          cwd,
          timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
          signal: exec?.signal,
        })
      } catch (error) {
        return {
          success: false,
          exitCode: null,
          timedOut: false,
          stdout: '',
          stderr: '',
          truncated: false,
          durationMs: 0,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  })
}

/**
 * Run a remote command as a background job, when the deployment has jobs.
 *
 * The job seam is optional: a composition without `ctx.jobs` (or without a
 * controller serving this owner) cannot collect a job id, so the command runs
 * inline instead of returning an id nobody can read. The job's output ring is
 * fed from the command's own stdout/stderr as it runs, and its cancel hook
 * aborts the in-flight run.
 *
 * @param {import('./engine.js').SshWorkspaceEngine} engine - live engine.
 * @param {string} alias - host alias.
 * @param {string} command - shell command.
 * @param {{cwd?: string}} options - run options.
 * @param {object} [exec] - the tool execution context.
 * @returns {Promise<object>} the tool result — a job id, or the inline outcome.
 */
async function startBackgroundExec (ctx, engine, alias, command, options, exec) {
  const jobs = ctx?.get?.('jobs') ?? ctx?.jobs
  // A job is owned by the calling agent; without one there is nobody whose
  // session could collect the id, so the run degrades to inline.
  const owner = exec?.agent
  if (jobs === undefined || jobs === null || typeof jobs.start !== 'function' || owner === undefined) {
    // No job seam: degrade to a synchronous run rather than promising an id.
    try {
      const outcome = await engine.exec(alias, command, { ...options, signal: exec?.signal })
      return { ...outcome, error: outcome.error ?? 'background jobs are unavailable in this deployment; the command ran inline' }
    } catch (error) {
      return {
        success: false,
        exitCode: null,
        timedOut: false,
        stdout: '',
        stderr: '',
        truncated: false,
        durationMs: 0,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
  const controller = new AbortController()
  const onOuterAbort = () => { controller.abort() }
  if (exec?.signal !== undefined && exec.signal !== null && typeof exec.signal.addEventListener === 'function') {
    if (exec.signal.aborted === true) controller.abort()
    else exec.signal.addEventListener('abort', onOuterAbort, { once: true })
  }
  let jobId
  try {
    const handle = jobs.start({
      owner,
      kind: 'ssh-exec',
      label: `${alias}: ${command.length > 60 ? `${command.slice(0, 60)}…` : command}`,
      run: (job) => {
        void (async () => {
          try {
            const outcome = await engine.exec(alias, command, { ...options, signal: controller.signal })
            if (outcome.stdout !== '') job.append(outcome.stdout)
            if (outcome.stderr !== '') job.append(outcome.stderr)
            job.updateProgress(`exit ${outcome.exitCode === null ? 'unknown' : outcome.exitCode}`)
          } catch (error) {
            job.append(`${error instanceof Error ? error.message : String(error)}\n`)
          }
        })()
        return {
          cancel: () => { controller.abort() },
        }
      },
    })
    jobId = handle.id
  } catch (error) {
    // Starting can refuse (no controller for this owner, job limit reached).
    // That is not the command's failure, so report it plainly.
    return {
      success: false,
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      truncated: false,
      durationMs: 0,
      error: `could not start a background job: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  return {
    success: true,
    exitCode: null,
    timedOut: false,
    stdout: '',
    stderr: '',
    truncated: false,
    durationMs: 0,
    jobId,
  }
}

/**
 * The session's resolved sandbox policy, for a tool that mutates without going
 * through `ctx.fs`.
 *
 * Thin adapter over {@link sessionPolicyOf}: a tool receives the execution
 * context, not the session, so the unwrapping lives here once instead of at
 * every call site.
 *
 * The WHOLE policy is returned rather than just the mode, because two things
 * downstream need more than the mode: the workspace root bounds a
 * `workspace-write` upload, and the `unresolved` mark keeps a broken resolver
 * from being reported as a mode the user chose.
 *
 * @param {object} ctx - host plugin context.
 * @param {object | undefined} exec - the tool execution context.
 * @returns {{mode: string, workspaceRoot?: string, unresolved?: true, reason?: string} | undefined}
 *   the policy, `undefined` when the composition confines nothing.
 */
function sessionSandboxPolicy (ctx, exec) {
  return sessionPolicyOf(ctx, exec?.agent?.session)
}

/** Move a file's bytes between this machine and a remote host. */
function transferTool (engine, ctx, router) {
  return defineTool({
    name: 'ssh_workspace_transfer',
    description: 'Copy a file between THIS MACHINE and a remote SSH host over SFTP, without routing its bytes through the conversation. ' +
      'direction=upload sends a local file up; direction=download pulls a remote file down. Both stream in chunks, so large files are fine, and an upload is published atomically (the destination keeps its old content until the copy completes). ' +
      'An UPLOAD lands only inside a mounted ssh:// workspace (or that host\'s /tmp) and answers to the session sandbox mode, exactly like the write tool — mounting is not a permission, so a path on no mounted root is refused before any byte is sent. A download only reads the remote side. ' +
      'Use this to push a build artifact or pull a log — not for editing files, which the read / write / edit tools already do inside a mounted ssh:// workspace. ' +
      'Triggers: upload to server, download from server, copy file to remote, pull a file locally, scp.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Host alias from ssh_workspace_hosts.' },
      direction: { type: 'string', enum: ['upload', 'download'], required: true, description: 'upload = this machine → remote host; download = remote host → this machine.' },
      localPath: { type: 'string', required: true, description: 'Absolute path on THIS machine (source for upload, destination for download).' },
      remotePath: { type: 'string', required: true, description: 'Absolute path on the REMOTE host (destination for upload, source for download).' },
      recursive: { type: 'boolean', description: 'Move a whole directory tree, in either direction. Symlinks inside a downloaded tree are skipped and listed, never followed.' },
      exclude: {
        // A STRING, not an array: the Host's argument validator accepts only
        // primitive parameter types (asserted by `tool-schemas-smoke`), so a
        // JSON array never reaches `execute`. Commas and newlines both separate
        // rules, because a caller writing several naturally reaches for either.
        type: 'string',
        description: 'Tree transfers only: paths to skip, applied in BOTH directions. Separate rules with commas or newlines. A bare name matches any path segment (`node_modules`); `*` is a wildcard that does not cross `/` and `**` crosses it; a rule containing `/` is anchored at the tree root (`build/output`); a trailing `/` restricts it to directories (`tmp/`); a leading `!` re-includes, and the LAST matching rule decides. Not .gitignore: no per-directory files, no ancestor rules.',
      },
      onConflict: {
        type: 'string',
        enum: ['overwrite', 'skip', 'rename', 'refuse'],
        description: 'What to do when the destination already exists: overwrite (default), skip (leave it and report), rename (write beside it as name.1), or refuse (fail before writing).',
      },
      resume: {
        type: 'boolean',
        description: 'Upload only: continue a previous partial upload where it stopped instead of re-sending the whole file. The partial is kept when a resumable attempt fails, and discarded automatically when the source has changed since it was written.',
      },
      verify: {
        type: 'boolean',
        description: 'Hash both sides with SHA-256 and compare before reporting success. Costs one extra full read; needs sha256sum, shasum or openssl on the host, and says so when none is there.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          bytes: { type: 'integer' },
          files: { type: 'integer' },
          skipped: { type: 'boolean' },
          // The recursive branch has ALWAYS returned these three, and none of
          // them was declared. `additionalProperties: false` means a host that
          // validates the result rejects the whole call — so a tree transfer's
          // answer was either silently stripped or refused, depending on the
          // deployment, and the caller never saw which files were skipped.
          skippedFiles: { type: 'integer' },
          skippedLinks: { type: 'array', items: { type: 'string' } },
          excludedPaths: { type: 'integer' },
          path: { type: 'string' },
          verified: { type: 'boolean' },
          verification: { type: 'string' },
          note: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => text(value.ok === true
        ? `transferred ${value.bytes ?? 0} bytes${value.files === undefined ? '' : ` across ${value.files} file(s)`}`
        : `transfer failed: ${value.error ?? 'unknown error'}`),
    },
    async execute (args, exec) {
      const alias = String(args.alias ?? '')
      const direction = args.direction === 'download' ? 'download' : 'upload'
      const localPath = String(args.localPath ?? '')
      const remotePath = String(args.remotePath ?? '')
      try {
        engine.assertNotDisabled(alias, remotePath)
        // An upload is a WRITE to the remote host, so it answers to the session's
        // sandbox mode even though it does not travel through `ctx.fs` (which is
        // where the mode is enforced for read/write/edit). A download only reads
        // the remote side and writes to THIS machine, so it is not gated here.
        if (direction === 'upload') {
          const policy = sessionSandboxPolicy(ctx, exec)
          // A policy that cannot be RESOLVED is a wiring problem, not a mode the
          // user chose; saying so is the only version of this message the user
          // can act on, because switching to `read-only` would not fix it either.
          if (policy?.unresolved === true) {
            return {
              ok: false,
              error: `cannot upload to "${remotePath}": the session's sandbox policy could not be resolved (${policy.reason}), so this write was refused rather than run unchecked. ` +
                'This is a wiring problem, not a mode you chose — switching the session mode will not help.',
            }
          }
          // The MODE question is answered by the same helper the router uses, so
          // an upload cannot be permitted under a mode that denies a `write` —
          // including a mode string this plugin does not recognise. Unlike the
          // router, this result is returned as text rather than thrown, so the
          // host never appends its escalation hint and the way out is spelled
          // out here instead.
          const modeRefusal = writeModeRefusal(policy?.mode, remotePath, 'upload')
          if (modeRefusal !== undefined) {
            const way = policy?.mode === 'read-only'
              ? 'Switch the session to workspace-write or danger-full-access.'
              : 'Set the session to one of the three recognised modes.'
            return { ok: false, error: `${modeRefusal} — ${way} Every remote write route (write / edit / upload / command execution) answers to the same mode.` }
          }
          // The same workspace SCOPE rule the router applies to write/edit, so an
          // upload cannot land where a write would be refused: `workspace-write`
          // means "inside THIS session's workspace" (or the host temp area), not
          // "anywhere on a mounted host". Without this the two write paths would
          // disagree.
          const scoped = workspaceWriteScopeRefusal(policy?.mode, writeScopeRootOf(policy), {
            alias,
            remotePath,
            displayPath: `ssh://${alias}${remotePath.startsWith('/') ? '' : '/'}${remotePath}`,
          })
          if (scoped !== undefined) return { ok: false, error: scoped }
        }
        if (args.recursive === true) {
          // The exclusion list is passed to BOTH directions: it is one set of
          // rules, and a caller that excluded `node_modules` on the way up
          // means the same thing on the way down. The parameter is a string
          // because the Host validates only primitive types, so both separators
          // a caller might reach for are honored, and blank pieces are dropped
          // rather than treated as "exclude nothing named ''".
          const exclude = typeof args.exclude === 'string'
            ? args.exclude.split(/[\n,]+/u).map(rule => rule.trim()).filter(rule => rule !== '')
            : undefined
          if (direction === 'upload') {
            const result = await uploadTree(engine, {
              alias,
              localPath,
              remotePath,
              roots: router?.roots,
              signal: exec?.signal,
              onConflict: args.onConflict,
              exclude,
            })
            return {
              ok: true,
              bytes: result.bytes,
              files: result.files,
              ...(result.skipped === 0 ? {} : { skippedFiles: result.skipped }),
              ...(result.excluded === 0 ? {} : { excludedPaths: result.excluded }),
            }
          }
          const result = await downloadTree(engine, {
            alias,
            localPath,
            remotePath,
            signal: exec?.signal,
            onConflict: args.onConflict,
            exclude,
          })
          return {
            ok: true,
            bytes: result.bytes,
            files: result.files,
            ...(result.skipped === 0 ? {} : { skippedFiles: result.skipped }),
            ...(result.excluded === 0 ? {} : { excludedPaths: result.excluded }),
            // Links are reported rather than followed, and saying so is the
            // whole difference between "your tree came down" and "your tree
            // came down except the parts I silently decided to ignore".
            ...(result.links.length === 0 ? {} : { skippedLinks: result.links }),
          }
        }
        const result = await transferFile(engine, {
          alias,
          direction,
          localPath,
          remotePath,
          roots: router?.roots,
          signal: exec?.signal,
          onConflict: args.onConflict,
          verify: args.verify === true,
          resume: args.resume === true,
        })
        return {
          ok: true,
          bytes: result.bytes,
          ...(result.skipped === true ? { skipped: true } : {}),
          ...(result.path === undefined ? {} : { path: result.path }),
          ...(result.verified === undefined ? {} : { verified: result.verified }),
          ...(result.verification === undefined ? {} : { verification: result.verification }),
          ...(result.note === undefined ? {} : { note: result.note }),
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}

/**
 * Run commands in a persistent remote shell that keeps its state.
 *
 * `ssh_workspace_exec` starts a fresh process per call, so a `cd` or an exported
 * variable is forgotten immediately. This tool keeps one POSIX shell alive per
 * (host, session), so successive calls behave like typing into one terminal.
 *
 * It speaks POSIX shell on purpose: the deployment's own persistent bash/pwsh
 * tools build their command line for THIS machine's dialect, which a remote
 * host cannot run.
 */
function shellTool (ctx, shells, approvalOf) {
  return defineTool({
    name: 'ssh_workspace_shell',
    description: 'Run a command in a PERSISTENT shell on a remote SSH host: `cd`, exported variables and background jobs survive between calls, like one terminal you keep using. ' +
      'The remote shell is POSIX `sh`, so use POSIX syntax even if the calling machine is Windows (the deployment\'s own pwsh/bash tools speak the local dialect and cannot drive a remote host). ' +
      'Use ssh_workspace_exec for a one-off command; use this when the next command depends on the previous one\'s directory or variables. ' +
      'Pass close: true to end the session, or session: "name" to keep independent shells side by side. ' +
      'Triggers: persistent remote shell, cd then run, keep state on server, interactive remote command, second command in same directory.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Host alias from ssh_workspace_hosts.' },
      command: { type: 'string', description: 'POSIX shell command. Omit when closing a session.' },
      session: { type: 'string', description: 'Session name, so several independent shells can coexist (default "default").' },
      close: { type: 'boolean', description: 'Close the session and release it instead of running a command.' },
      timeoutMs: { type: 'integer', description: 'How long to wait for the command to finish (default 60000).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          output: { type: 'string' },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          session: { type: 'string' },
          reused: { type: 'boolean' },
          reopened: { type: 'boolean' },
          startedIn: { type: 'string' },
          closed: { type: 'integer' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.ok !== true) return text(`remote shell failed: ${value.error ?? 'unknown error'}`)
        if (value.closed !== undefined) return text(`closed ${value.closed} remote shell session(s)`)
        // `reopened` is the case that must not read as "continued": the previous
        // shell died with its connection, so anything the caller exported or
        // changed in it is gone — only the START directory is put back. Saying
        // "started" (what the code used to say) loses the fact that a session
        // they were relying on ended; saying "continued" would be a lie.
        const verb = value.reused === true
          ? 'continued'
          : value.reopened === true ? 'reopened (previous shell had ended; exported variables and background jobs are gone)' : 'started'
        const lines = [
          `${verb} session "${value.session ?? 'default'}"`,
          `exit ${value.exitCode === null || value.exitCode === undefined ? 'unknown' : value.exitCode}`,
        ]
        if (value.reopened === true && value.startedIn !== undefined) {
          lines.push(`the session starts in ${value.startedIn} again, which is where it was opened — not necessarily where the previous shell had cd'd to`)
        }
        if ((value.output ?? '') !== '') lines.push('', value.output)
        return text(lines.join('\n'))
      },
    },
    async execute (args, exec) {
      const alias = String(args.alias ?? '')
      const session = typeof args.session === 'string' && args.session.trim() !== '' ? args.session.trim() : 'default'
      if (args.close === true) {
        try {
          return { ok: true, closed: shells.close(alias, session), session }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      }
      const command = typeof args.command === 'string' ? args.command : ''
      if (command.trim() === '') return { ok: false, session, error: 'command is required unless close is set' }
      // Closing a session mutates nothing, so it stays available in every mode.
      // Running one is arbitrary remote execution — the same act as
      // ssh_workspace_exec, and refused through the same shared gate so the two
      // cannot drift apart.
      try {
        assertRemoteCommandAllowed(sessionSandboxPolicy(ctx, exec), 'run a command in a remote shell', `ssh://${alias}`)
      } catch (error) {
        return { ok: false, session, error: error instanceof Error ? error.message : String(error) }
      }
      // Same gate as `ssh_workspace_exec`, on the same text: a persistent shell
      // is arbitrary remote execution — the reason it can keep state is that it
      // is a live terminal — so a policy that guards one and not the other
      // guards nothing.
      {
        const refusal = await confirmRemoteCommand({
          approval: approvalOf?.(),
          policyFor: () => confirmationPolicyOf(ctx),
          command,
          exec,
          action: 'run a command in a remote shell',
          target: `ssh://${alias}`,
        })
        if (refusal !== undefined) return { ok: false, session, error: refusal }
      }
      try {
        const result = await shells.run(alias, command, {
          session,
          timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
          signal: exec?.signal,
        })
        return {
          ok: true,
          output: result.output,
          exitCode: result.exitCode,
          session,
          reused: result.reused,
          ...(result.reopened === true ? { reopened: true } : {}),
          ...(result.cwd === undefined ? {} : { startedIn: result.cwd }),
        }
      } catch (error) {
        return { ok: false, session, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}

/** The URL a forwarded port is reachable at, from the local side. */
function forwardUrl (forward) {
  const host = forward.localHost === '0.0.0.0' || forward.localHost === '::' ? 'localhost' : forward.localHost
  return `http://${host}:${forward.localPort}`
}

/** Map a remote port to a local one (SSH port forwarding). */
function forwardTool (forwards) {
  return defineTool({
    name: 'ssh_workspace_forward',
    description: 'Map a port on a remote SSH host to this machine (SSH port forwarding, like `ssh -L`): a remote dev server or service becomes reachable locally at the returned http://localhost:<port> URL. ' +
      'Use it after starting a dev server on the remote host so the user can open it in a browser. Opening the same remote target again returns the existing forward. ' +
      'The forward lives with the SSH connection: if the connection drops it closes, and calling this tool again re-opens it. Close it with ssh_workspace_unforward when done. ' +
      'Triggers: preview remote dev server, forward port, port mapping, access remote service locally, expose localhost.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Host alias from ssh_workspace_hosts.' },
      remotePort: { type: 'integer', required: true, description: 'Port to reach ON THE REMOTE HOST, e.g. 5173 for a Vite dev server or 3000 for a Node app.' },
      localPort: { type: 'integer', description: 'Local port to listen on. Default: the same number as remotePort; if it is busy an available port is picked instead. Pass 0 to let the OS choose.' },
      remoteHost: { type: 'string', description: 'Host the SSH server dials on its side (default 127.0.0.1 — the remote service itself).' },
      localHost: { type: 'string', description: 'Local interface to listen on (default 127.0.0.1 — this machine only; use 0.0.0.0 to expose to the LAN).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          id: { type: 'string', required: true },
          alias: { type: 'string', required: true },
          localHost: { type: 'string', required: true },
          localPort: { type: 'integer', required: true },
          remoteHost: { type: 'string', required: true },
          remotePort: { type: 'integer', required: true },
          url: { type: 'string', required: true },
          reused: { type: 'boolean', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => text(value.ok
        ? [
            `${value.reused ? 'already forwarding' : 'forwarding'} ${value.localHost}:${value.localPort} → ${value.alias}:${value.remoteHost}:${value.remotePort}`,
            `open: ${value.url}`,
            `close it with ssh_workspace_unforward id=${value.id}`,
          ].join('\n')
        : `forward failed: ${value.error ?? 'unknown error'}`),
    },
    async execute (args) {
      const alias = String(args.alias ?? '').trim()
      try {
        const forward = await forwards.open(alias, {
          remotePort: args.remotePort,
          ...(args.localPort !== undefined ? { localPort: args.localPort } : {}),
          ...(typeof args.remoteHost === 'string' ? { remoteHost: args.remoteHost } : {}),
          ...(typeof args.localHost === 'string' ? { localHost: args.localHost } : {}),
        })
        return {
          ok: true,
          id: forward.id,
          alias: forward.alias,
          localHost: forward.localHost,
          localPort: forward.localPort,
          remoteHost: forward.remoteHost,
          remotePort: forward.remotePort,
          url: forwardUrl(forward),
          reused: forward.reused === true,
        }
      } catch (error) {
        return {
          ok: false,
          id: '',
          alias,
          localHost: '',
          localPort: 0,
          remoteHost: '',
          remotePort: 0,
          url: '',
          reused: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  })
}

/** Close a port forward opened by ssh_workspace_forward. */
function unforwardTool (forwards) {
  return defineTool({
    name: 'ssh_workspace_unforward',
    description: 'Close a port forward opened by ssh_workspace_forward and release its local port. The id comes from ssh_workspace_forward or ssh_workspace_status. ' +
      'Triggers: stop port forward, close port mapping, release local port.',
    parameters: {
      id: { type: 'string', required: true, description: 'Forward id, e.g. fwd-1.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          closed: { type: 'boolean', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => text(value.ok
        ? `forward ${value.closed ? 'closed' : 'not found (already closed?)'}`
        : `unforward failed: ${value.error ?? 'unknown error'}`),
    },
    async execute (args) {
      try {
        const closed = forwards.close(String(args.id ?? ''))
        return { ok: true, closed }
      } catch (error) {
        return { ok: false, closed: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}
