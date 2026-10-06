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

import { formatRemotePath, remoteBasename } from './protocol.js'

import { requirePeer } from './peers.js'

const { defineTool } = requirePeer('@deepseek-ai/dsh-tools')

/** Wrap text as the single content block these tools render. */
function text (value) {
  return [{ type: 'text', text: value }]
}

/** Render the host table. */
function renderHosts (hosts) {
  if (hosts.length === 0) return 'no SSH hosts available — add one in the 远程工作区 panel or to ~/.ssh/config'
  const rows = hosts.map(host => [
    host.alias,
    `${host.user}@${host.host}:${host.port}`,
    host.auth,
    host.keyReady ? 'ready' : 'check-key',
    host.source,
    host.description ?? '-',
  ].join(' | '))
  return ['alias | address | auth | key | source | description', '--- | --- | --- | --- | --- | ---', ...rows].join('\n')
}

/** Render one remote exec outcome (mirrors the local shell tools' convention). */
function renderExec (result) {
  const marker = result.timedOut ? '[timed out]' : `[exit code: ${result.exitCode ?? 'null'}]`
  const parts = [marker]
  if (result.stdout !== '') parts.push(`stdout:\n${result.stdout}`)
  if (result.stderr !== '') parts.push(`stderr:\n${result.stderr}`)
  if (result.error !== undefined) parts.push(`error: ${result.error}`)
  parts.push(`duration: ${result.durationMs} ms`)
  return parts.join('\n')
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
 * @returns {Array<object>} registry-ready tool definitions.
 */
export function workspaceTools (ctx, engine, router, forwards) {
  return [
    hostsTool(engine),
    mountTool(ctx, engine, router),
    unmountTool(ctx, engine, router),
    statusTool(engine, router, forwards),
    execTool(engine),
    // ---- Port forward tools（已屏蔽，代码保留：需要时去掉注释即可恢复）
    // forwardTool(forwards),
    // unforwardTool(forwards),
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
        },
      },
      render: (_args, value) => text(renderHosts(value.hosts ?? [])),
    },
    async execute (args) {
      const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
      let rows = engine.store.rows()
      if (query !== '') {
        rows = rows.filter(row => [row.alias, row.host, row.user, row.description ?? '', ...(row.tags ?? [])]
          .join(' ')
          .toLowerCase()
          .includes(query))
      }
      return { hosts: rows }
    },
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
          error: { type: 'string' },
        },
      },
      render: (_args, value) => text(value.ok
        ? [
            `mounted ${value.workspacePath}`,
            `title: ${value.title}`,
            value.registered ? `registered as a DSH workspace${value.workspaceId === undefined ? '' : ` (id ${value.workspaceId})`}` : 'not registered (kept for this process only)',
            value.entryCount === undefined ? '' : `directory contains ${value.entryCount} entries`,
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
        // anything durable is written.
        const target = { targetKey: formatRemotePath(alias, remotePath), displayPath: formatRemotePath(alias, remotePath) }
        const stats = await engine.fs?.stat?.(target, exec?.signal)
        if (stats === undefined) {
          return { ok: false, workspacePath: '', title: '', registered: false, error: `no such directory on ${alias}: ${remotePath}` }
        }
        if (stats.type !== 'directory') {
          return { ok: false, workspacePath: '', title: '', registered: false, error: `not a directory on ${alias}: ${remotePath} (it is a ${stats.type})` }
        }
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
        return {
          ok: true,
          workspacePath,
          title,
          registered,
          ...(workspaceId !== undefined ? { workspaceId } : {}),
          ...(entryCount !== undefined ? { entryCount } : {}),
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
    description: 'Stop serving a mounted remote directory and, when it was registered, remove its DSH workspace record. Live sessions using it keep their own copy of the path. ' +
      'Triggers: close remote folder, unmount remote workspace, disconnect workspace.',
    parameters: {
      workspacePath: { type: 'string', required: true, description: 'The ssh:// path returned by ssh_workspace_mount.' },
      deregister: { type: 'boolean', description: 'Also delete the durable DSH workspace record (default true).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          wasMounted: { type: 'boolean', required: true },
          deregistered: { type: 'boolean', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => text(value.ok
        ? `unmounted (was mounted: ${value.wasMounted}; workspace record removed: ${value.deregistered})`
        : `unmount failed: ${value.error ?? 'unknown error'}`),
    },
    async execute (args, exec) {
      const workspacePath = String(args.workspacePath ?? '').trim()
      try {
        const wasMounted = router.removeRoot(workspacePath)
        let deregistered = false
        if (args.deregister !== false) {
          const registry = registryOf(ctx)
          const entity = registry?.list?.().find(candidate => candidate.path === workspacePath)
          if (entity !== undefined && typeof registry.delete === 'function') {
            await registry.delete(entity.id)
            deregistered = true
          }
        }
        return { ok: true, wasMounted, deregistered }
      } catch (error) {
        return { ok: false, wasMounted: false, deregistered: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}

/** Report mounted remote workspaces, connection state, and port forwards. */
function statusTool (engine, router, forwards) {
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
        },
      },
      render: (_args, value) => {
        const lines = [`fs serves remote paths: ${value.fsPatched ? 'yes' : 'no'}`]
        lines.push(`mounted remote workspaces: ${value.mounted.length === 0 ? 'none' : ''}`)
        for (const root of value.mounted) lines.push(`  ${root}`)
        lines.push(`live SSH connections: ${value.connections.length === 0 ? 'none' : ''}`)
        for (const connection of value.connections) lines.push(`  ${connection.alias}: ${connection.state} (in flight ${connection.inFlight})`)
        lines.push(`port forwards: ${(value.forwards ?? []).length === 0 ? 'none' : ''}`)
        for (const forward of value.forwards ?? []) {
          lines.push(`  ${forward.id}: ${forward.localHost}:${forward.localPort} → ${forward.alias}:${forward.remoteHost}:${forward.remotePort} (${forward.connections} active)`)
        }
        return text(lines.join('\n'))
      },
    },
    async execute () {
      return {
        mounted: router.listRoots(),
        connections: [...engine.pool.entries()].map(([alias, record]) => ({
          alias,
          state: record.broken ? 'broken' : 'connected',
          inFlight: record.inFlight,
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
        fsPatched: true,
      }
    },
  })
}

/** Run a shell command on a remote host. */
function execTool (engine) {
  return defineTool({
    name: 'ssh_workspace_exec',
    description: 'Run a shell command ON A REMOTE SSH HOST without mounting it (host discovery, paths outside the mounted roots, setup tasks). Inside a mounted ssh:// workspace the pwsh/bash tools already run on that host, so prefer them there. ' +
      'Use this tool to inspect a remote directory before mounting, or to build/test outside the workspace roots. ' +
      'Triggers: run on server, remote command, build on server, check remote directory.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Host alias from ssh_workspace_hosts.' },
      command: { type: 'string', required: true, description: 'Shell command to run on the remote host.' },
      cwd: { type: 'string', description: 'Remote working directory (optional).' },
      timeoutMs: { type: 'integer', description: 'Timeout in milliseconds (default 60000).' },
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
          error: { type: 'string' },
        },
      },
      render: (_args, value) => text(renderExec(value)),
    },
    async execute (args, exec) {
      try {
        return await engine.exec(String(args.alias ?? ''), String(args.command ?? ''), {
          cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
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
