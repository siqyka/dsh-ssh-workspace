/**
 * HTTP route family for the remote-workspace plugin browser half.
 *
 * Loopback-only: these endpoints mount and unmount workspaces on the host, so
 * LAN-exposed deployments must not serve them. The fence mirrors dsh-ssh's
 * approach — reject any request whose remote address is not a loopback one —
 * and additionally requires the `Host` header to name this server by one of
 * its loopback spellings, so a DNS-rebinding page (which reaches 127.0.0.1
 * from the browser while sending its own hostname) is refused too. POST
 * endpoints further require a JSON content type: a cross-site HTML form
 * (which can only send text/plain, urlencoded, or multipart, and may craft a
 * text/plain body that parses as JSON) cannot set it, while the plugin's own
 * browser half always does.
 *
 * @module @shiqyka/dsh-ssh-workspace/routes
 */

import { parseRemotePath } from './protocol.js'
import { shellQuote } from './engine.js'
import { probeLocalPort } from './forward.js'
import { fenceUploadTarget, remoteParentOf, sftpUnlink, transferFile, uploadTree } from './transfer.js'
import {
  sftpCloseHandle,
  sftpMkdirp,
  sftpOpenHandle,
  sftpPublishRename,
  sftpReadHandle,
  sftpStatOrNull,
  sftpWriteHandle,
} from './remote-fs.js'

/** Route path constants. */
export const ROUTES = {
  hosts: '/api/dsh-ssh-workspace/hosts',
  hostSave: '/api/dsh-ssh-workspace/hosts/save',
  hostDelete: '/api/dsh-ssh-workspace/hosts/delete',
  hostForgetKey: '/api/dsh-ssh-workspace/hosts/forget-key',
  hostDisconnect: '/api/dsh-ssh-workspace/hosts/disconnect',
  hostReconnect: '/api/dsh-ssh-workspace/hosts/reconnect',
  test: '/api/dsh-ssh-workspace/test',
  ls: '/api/dsh-ssh-workspace/ls',
  status: '/api/dsh-ssh-workspace/status',
  mount: '/api/dsh-ssh-workspace/mount',
  unmount: '/api/dsh-ssh-workspace/unmount',
  enable: '/api/dsh-ssh-workspace/enable',
  forward: '/api/dsh-ssh-workspace/forward',
  unforward: '/api/dsh-ssh-workspace/unforward',
  forwardSave: '/api/dsh-ssh-workspace/forward/save',
  forwardToggle: '/api/dsh-ssh-workspace/forward/toggle',
  forwardDelete: '/api/dsh-ssh-workspace/forward/delete',
  forwardRemember: '/api/dsh-ssh-workspace/forward/remember',
  forwardProbe: '/api/dsh-ssh-workspace/forward/probe',
  forwardSettings: '/api/dsh-ssh-workspace/forward/settings',
  transfer: '/api/dsh-ssh-workspace/transfer',
  download: '/api/dsh-ssh-workspace/download',
  upload: '/api/dsh-ssh-workspace/upload',
}

/**
 * Check whether a request originated on the loopback interface.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {boolean} true when the remote address is loopback.
 */
function isLoopbackRequest (req) {
  const addr = req.socket?.remoteAddress ?? req.connection?.remoteAddress ?? ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === 'localhost'
}

/**
 * Check the request's `Host` header against the loopback names of the port
 * this server actually listens on.
 *
 * A loopback `remoteAddress` alone still lets a public page reach these
 * endpoints: a DNS-rebinding attack re-resolves an attacker-controlled
 * hostname to 127.0.0.1, and the browser then treats the request as
 * same-origin. Requiring the Host the browser sent to be one of the
 * loopback spellings of the listening port closes that path — a rebound
 * page's requests carry its own hostname and are refused here.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {boolean} true when the Host header names this loopback server.
 */
function isLoopbackHostHeader (req) {
  const port = req.socket?.localPort
  const host = req.headers?.host
  if (typeof host !== 'string' || host === '' || !Number.isInteger(port)) return false
  const allowed = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`])
  return allowed.has(host.toLowerCase())
}

/**
 * Check the request's `Content-Type` names JSON.
 *
 * Cross-site HTML forms can only send `text/plain`, `urlencoded`, or
 * `multipart` bodies — and a crafted `text/plain` body can still parse as
 * JSON. Requiring the JSON media type on POST endpoints closes that CSRF
 * path without a token; `fetch` with a non-simple content type triggers a
 * CORS preflight this server never approves.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {boolean} true when the declared type (parameters aside) is application/json.
 */
function isJsonContentType (req) {
  const header = req.headers?.['content-type']
  if (typeof header !== 'string') return false
  return header.split(';', 1)[0].trim().toLowerCase() === 'application/json'
}

/**
 * The HTTP status a failed `/download` should carry.
 *
 * The browser saves whatever body a 2xx response has, so "the file could not
 * be read" has to reach it as a non-2xx status — that is the only signal the
 * download flow honours. Codes come from the `FsError` the read path raises;
 * anything unrecognised is a genuine server-side failure, not a missing file.
 *
 * @param {unknown} error - the failure raised while opening or streaming.
 * @returns {number} the status to answer with.
 */
function statusForDownloadError (error) {
  switch (error?.code) {
    case 'FS_NOT_FOUND': return 404
    case 'FS_PERMISSION_DENIED': return 403
    case 'FS_SANDBOX_DENIED': return 403
    // The mount fence: the target exists in principle, but this deployment is
    // not serving that directory, so the request is forbidden rather than absent.
    case 'FS_OUTSIDE_WORKSPACE': return 403
    case 'FS_NOT_REGULAR_FILE': return 400
    case 'FS_NOT_DIRECTORY': return 400
    default: return 500
  }
}

/** Write a JSON response. */
function writeJson (res, status, body) {
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  } catch { /* response already closed */ }
}

/** Read a JSON request body, returning null on failure. */
async function readJsonBody (req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 4 * 1024 * 1024) { req.destroy(); resolve(null) }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

/** Extract a decoded query parameter. */
function queryParam (url, name) {
  const value = url.searchParams.get(name)
  return value === null ? undefined : value
}

/** Resolve an SFTP path (`.` = the login directory) to an absolute one. */
function sftpRealpath (sftp, target) {
  return new Promise((resolve, reject) => {
    sftp.realpath(target, (err, resolved) => {
      if (err) reject(err)
      else if (typeof resolved !== 'string' || !resolved.startsWith('/')) reject(new Error(`realpath did not return an absolute path: ${String(resolved)}`))
      else resolve(resolved)
    })
  })
}

/** The unmount modes this endpoint accepts. */
const UNMOUNT_MODES = new Set(['detach', 'deregister', 'forget'])

/**
 * Resolve the unmount mode from a request body.
 *
 * Two spellings are honoured so the documented mode name and the older
 * `deregister` boolean cannot disagree silently: an explicit `mode` wins, and
 * otherwise `deregister: true` means "deregister" while its default means
 * "detach". Detach is the safe default — it is the only mode that keeps the
 * workspace record and the archived sessions recoverable in one click.
 *
 * `forget` is accepted as an alias of `deregister` rather than a third mode:
 * both delete the record, and the difference the old `forget` had (clearing the
 * detached mark) is now what `deregister` does too, because a record that is
 * gone everywhere must not leave a re-enable button behind.
 *
 * @param {object | null} body - the parsed request body.
 * @returns {'detach' | 'deregister'} the mode.
 */
function normalizeUnmountMode (body) {
  const requested = typeof body?.mode === 'string' ? body.mode.trim() : ''
  if (requested === 'detach') return 'detach'
  if (UNMOUNT_MODES.has(requested)) return 'deregister'
  return body?.deregister === true ? 'deregister' : 'detach'
}

/**
 * Archive every session accounted by one workspace.
 *
 * Archiving is registry-native: the session disappears from every grouping
 * surface, its file is untouched, and `unarchiveSession` restores it to its
 * recorded position. No other plugin is involved and nothing on disk is
 * unlinked.
 *
 * Failures are collected per session rather than aborting the batch: a session
 * with running work is refused by the registry (that is the documented
 * behaviour without `stopActivity`), and the user should still get the other
 * sessions archived plus a precise account of what was left.
 *
 * @param {object | undefined} registry - the workspace registry, when mounted.
 * @param {object | undefined} entity - the workspace entity.
 * @returns {Promise<{ok: string[], failed: Array<{sessionId: string, error: string}>}>} the outcome.
 */
async function archiveWorkspaceSessions (registry, entity) {
  const ok = []
  const failed = []
  if (entity === undefined || typeof registry?.archiveSession !== 'function') return { ok, failed }
  // `sessionIds` is already filtered by the registry to the sessions it still
  // considers members, so this cannot archive a detached orphan.
  for (const sessionId of entity.sessionIds ?? []) {
    try {
      await registry.archiveSession(sessionId)
      ok.push(sessionId)
    } catch (error) {
      failed.push({ sessionId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { ok, failed }
}

/**
 * Unarchive every session accounted by one workspace.
 *
 * @param {object | undefined} registry - the workspace registry, when mounted.
 * @param {object | undefined} entity - the workspace entity.
 * @returns {Promise<{ok: string[], failed: Array<{sessionId: string, error: string}>}>} the outcome.
 */
async function unarchiveWorkspaceSessions (registry, entity) {
  const ok = []
  const failed = []
  if (entity === undefined || typeof registry?.unarchiveSession !== 'function') return { ok, failed }
  for (const sessionId of entity.sessionIds ?? []) {
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
 * Route family dependencies.
 * @typedef {object} RouteDeps
 * @property {import('./engine.js').SshWorkspaceEngine} engine
 * @property {import('./remote-fs.js').RemoteFileSystem} router
 * @property {import('./forward.js').ForwardManager} forwards
 * @property {import('./forward-persist.js').SavedForwardManager} [savedForwards]
 * @property {import('@deepseek-ai/cordis').Context} ctx
 */

/**
 * Build every /api/dsh-ssh-workspace route.
 *
 * @param {RouteDeps} deps - engine, router, forwards, cordis context.
 * @returns {Array<object>} route descriptors for ctx.webServer.register().
 */
export function makeRoutes (deps) {
  const { engine, router, forwards, savedForwards, shells, ctx } = deps

  const guard = (req, res, method) => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return false
    }
    if (!isLoopbackHostHeader(req)) {
      writeJson(res, 403, { error: `forbidden: unexpected Host header ${JSON.stringify(req.headers?.host ?? '')}` })
      return false
    }
    if (req.method !== method) {
      writeJson(res, 405, { error: `method not allowed: ${req.method}` })
      return false
    }
    if (method === 'POST' && !isJsonContentType(req)) {
      writeJson(res, 415, { error: 'unsupported media type: POST endpoints require content-type: application/json' })
      return false
    }
    return true
  }

  return [
    // ---- hosts
    {
      kind: 'exact',
      path: ROUTES.hosts,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const query = queryParam(url, 'query') ?? ''
        // Store rows carry the non-secret auth details the editor needs to
        // prefill; secrets (password, passphrase) never leave the store file.
        const rows = engine.store.rows().map(row => {
          if (row.source !== 'store') return row
          const entry = engine.store.entry(row.alias) ?? {}
          const auth = entry.auth ?? {}
          return {
            ...row,
            keyPath: typeof auth.keyPath === 'string' ? auth.keyPath : undefined,
            agentPath: typeof auth.agentPath === 'string' ? auth.agentPath : undefined,
            agentForward: entry.agentForward === true,
            compress: entry.compress === true,
          }
        })
        const filtered = query === ''
          ? rows
          : rows.filter(row => [row.alias, row.host, row.user, row.description ?? '', ...(row.tags ?? [])]
              .join(' ')
              .toLowerCase()
              .includes(query.toLowerCase()))
        writeJson(res, 200, { hosts: filtered })
      },
    },
    // ---- save host (create or update)
    {
      kind: 'exact',
      path: ROUTES.hostSave,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const originalAlias = typeof body?.originalAlias === 'string' && body.originalAlias.trim() !== ''
          ? body.originalAlias.trim()
          : undefined
        const payload = {
          alias: typeof body?.alias === 'string' ? body.alias : '',
          host: typeof body?.host === 'string' ? body.host : '',
          port: typeof body?.port === 'number' ? body.port : 22,
          user: typeof body?.user === 'string' ? body.user : '',
          auth: {
            kind: typeof body?.auth?.kind === 'string' ? body.auth.kind : 'agent',
            keyPath: typeof body?.auth?.keyPath === 'string' ? body.auth.keyPath : '',
            passphrase: typeof body?.auth?.passphrase === 'string' ? body.auth.passphrase : '',
            password: typeof body?.auth?.password === 'string' ? body.auth.password : '',
            agentPath: typeof body?.auth?.agentPath === 'string' ? body.auth.agentPath : '',
          },
          description: typeof body?.description === 'string' ? body.description : '',
          // Transport options: the editor always posts booleans, so a missing
          // field means "off" rather than "keep the previous value".
          agentForward: body?.agentForward === true,
          compress: body?.compress === true,
        }
        const store = engine.store.entryStore
        try {
          // A store entry shadows the same alias in ~/.ssh/config, so creating
          // one where only a config block exists would silently change how that
          // alias resolves for every other ssh client too.
          const aliasTrimmed = payload.alias.trim()
          const storeEntry = aliasTrimmed === '' ? undefined : store.find(aliasTrimmed)
          if (aliasTrimmed !== '' && storeEntry === undefined && engine.store.sshConfigAliases().includes(aliasTrimmed)) {
            writeJson(res, 200, { ok: false, error: `alias ${JSON.stringify(aliasTrimmed)} is already defined in ~/.ssh/config; edit that file instead or pick another alias` })
            return
          }
          const entry = originalAlias === undefined
            ? store.create(payload)
            : store.update(originalAlias, payload)
          // A changed record must not keep serving the old connection.
          if (originalAlias !== undefined) engine.forget(originalAlias)
          engine.forget(entry.alias)
          writeJson(res, 200, { ok: true, alias: entry.alias, created: originalAlias === undefined })
        } catch (error) {
          writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---- delete host
    {
      kind: 'exact',
      path: ROUTES.hostDelete,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const alias = typeof body?.alias === 'string' ? body.alias.trim() : ''
        if (alias === '') {
          writeJson(res, 400, { error: 'alias is required' })
          return
        }
        try {
          engine.store.entryStore.delete(alias)
          engine.forget(alias)
          writeJson(res, 200, { ok: true, alias })
        } catch (error) {
          const inConfig = engine.store.sshConfigAliases().includes(alias)
          writeJson(res, 200, {
            ok: false,
            error: inConfig
              ? `${alias} is defined in ~/.ssh/config, which this plugin never edits — remove the Host block there instead`
              : error instanceof Error ? error.message : String(error),
          })
        }
      },
    },
    // ---- forget recorded host key (TOFU re-trust)
    {
      kind: 'exact',
      path: ROUTES.hostForgetKey,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const alias = typeof body?.alias === 'string' ? body.alias.trim() : ''
        if (alias === '') {
          writeJson(res, 400, { error: 'alias is required' })
          return
        }
        try {
          const removed = engine.store.forgetHostKey(alias)
          // Drop the pooled connection so the next connect re-pins the key.
          engine.forget(alias)
          writeJson(res, 200, { ok: true, removed })
        } catch (error) {
          writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---- disconnect (close the pooled connection for one host)
    {
      kind: 'exact',
      path: ROUTES.hostDisconnect,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const alias = typeof body?.alias === 'string' ? body.alias.trim() : ''
        if (alias === '') {
          writeJson(res, 400, { error: 'alias is required' })
          return
        }
        const record = engine.pool.get(alias)
        if (record === undefined) {
          writeJson(res, 200, { ok: true, disconnected: false })
          return
        }
        // Dropping a busy connection would fail whatever rides on it; let the
        // caller retry once the operations settle.
        if (record.inFlight > 0) {
          writeJson(res, 200, { ok: false, error: `the connection has ${record.inFlight} operation(s) in flight — disconnect again once it is idle` })
          return
        }
        try {
          // Requirement: dropping the SSH connection takes its port forwards
          // with it. The connection's own `close` event also tears them down,
          // but that event is not guaranteed — an ssh2 client destroyed without
          // emitting, or replaced by a reconnect, would leave listeners bound to
          // a record nobody owns. Closing by alias first makes it deterministic.
          //
          // This is a DELIBERATE disconnect, so the tunnels must end up exactly
          // where the panel's own "close" button leaves them: intent off and no
          // recorded failure. `closeForAlias` is the unplanned-drop path — it
          // keeps the intent on and records "SSH connection closed", which the
          // panel shows as a red "connection lost" line. A user who clicked
          // disconnect did not lose anything, and telling them otherwise makes
          // a working action look like a fault.
          const closedForwards = savedForwards === undefined
            ? (forwards?.closeForAlias?.(alias, 'SSH connection closed') ?? 0)
            : savedForwards.closeAlias(alias)
          engine.forget(alias)
          writeJson(res, 200, { ok: true, disconnected: true, closedForwards })
        } catch (error) {
          writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---- reconnect now (skip the backoff)
    //
    // The background loop can be minutes from its next attempt; a user who just
    // fixed their network should not have to wait for it, nor close and reopen
    // the workspace to poke the engine. This is the manual version of the same
    // attempt, so it reports the real error instead of a cheerful "retrying".
    //
    // Deliberately allowed even when nothing is "wanted": the user naming the
    // host is the strongest statement of intent there is (see reconnect.js).
    {
      kind: 'exact',
      path: ROUTES.hostReconnect,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const alias = typeof body?.alias === 'string' ? body.alias.trim() : ''
        if (alias === '') {
          writeJson(res, 400, { error: 'alias is required' })
          return
        }
        if (engine.reconnector === undefined) {
          writeJson(res, 200, { ok: false, error: 'background reconnect is disabled in this deployment' })
          return
        }
        const started = Date.now()
        try {
          const result = await engine.reconnector.retryNow(alias)
          writeJson(res, 200, { ...result, durationMs: Date.now() - started })
        } catch (error) {
          writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---- test connection
    //
    // A probe, not a way to connect: it proves the host answers and then
    // releases the connection IT opened. Leaving that connection pooled made
    // "test" quietly double as "connect", so a user who only wanted to know
    // whether the host answers ended up with a live session they never asked
    // for.
    //
    // Two cases where the connection is deliberately kept:
    //   - it was ALREADY pooled before this probe (the user's own connection is
    //     not this request's to drop);
    //   - anything rides on it — an open port forward pins it with `holds`, and
    //     tearing it down there would break a tunnel the user did not ask to
    //     close.
    {
      kind: 'exact',
      path: ROUTES.test,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const alias = typeof body?.alias === 'string' ? body.alias.trim() : ''
        if (alias === '') {
          writeJson(res, 400, { error: 'alias is required' })
          return
        }
        const started = Date.now()
        try {
          const existed = engine.pool?.has?.(alias) === true
          const record = await engine.acquire(alias)
          const durationMs = Date.now() - started
          const held = (record?.holds ?? 0) > 0
          let released = false
          if (!existed && !held && (record?.inFlight ?? 0) === 0) {
            engine.forget(alias)
            released = true
          }
          writeJson(res, 200, {
            ok: true,
            durationMs,
            released,
            ...(held
              ? { heldBy: 'an open port forward still holds this connection' }
              : existed ? { heldBy: 'the connection was already open' } : {}),
          })
        } catch (error) {
          writeJson(res, 200, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - started,
          })
        }
      },
    },
    // ---- remote directory listing
    {
      kind: 'exact',
      path: ROUTES.ls,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const alias = queryParam(url, 'alias')
        let path = queryParam(url, 'path') ?? ''
        if (alias === undefined || alias === '') {
          writeJson(res, 400, { error: 'alias query parameter is required' })
          return
        }
        if (path !== '' && !path.startsWith('/')) {
          writeJson(res, 400, { error: `path must be absolute: ${JSON.stringify(path)}` })
          return
        }
        try {
          const entries = await engine.withSftp(alias, async (sftp) => {
            // No path → the SSH login directory. Echoed back so the client can
            // display (and mount) a real absolute path.
            if (path === '') path = await sftpRealpath(sftp, '.')
            const raw = await new Promise((resolve, reject) => {
              sftp.readdir(path, (err, list) => { if (err) reject(err); else resolve(list) })
            })
            return raw.map(entry => ({
              name: entry.filename,
              type: entry.attrs.isDirectory() ? 'directory'
                : entry.attrs.isSymbolicLink() ? 'symlink'
                : 'file',
              size: entry.attrs.size,
              mtime: entry.attrs.mtime,
            }))
          })
          // The client warns on unwritable targets. Fail open: only a clean
          // exit status may report unwritable, a broken probe never may.
          let writable = true
          try {
            const probe = await engine.exec(alias, `test -w ${shellQuote(path)}`, { timeoutMs: 10_000 })
            if (probe.exitCode !== null) writable = probe.exitCode === 0
          } catch { /* fail open */ }
          writeJson(res, 200, { path, entries, writable })
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---- mount status
    {
      kind: 'exact',
      path: ROUTES.status,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const mounted = router.listRoots()
        const connections = [...engine.pool.entries()].map(([alias, record]) => ({
          alias,
          state: record.broken ? 'broken' : 'connected',
          inFlight: record.inFlight,
          idleAt: record.idleAt,
        }))
        // Background retry state, one row per host the loop is working on. The
        // panel needs `attempts` and `nextAt` to say "retrying in 8s" instead of
        // showing a dead host with no explanation; `phase: 'gave-up'` is a
        // different message again ("stopped"), so the two must not be flattened
        // into one boolean.
        const reconnecting = engine.reconnector?.list?.() ?? []
        // Registered remote Workspaces, so the browser half can mark them
        // wherever DSH draws them with its own folder glyph.
        let workspaces = []
        try {
          const registry = ctx.get('workspaceRegistry')
          workspaces = (registry?.list?.() ?? [])
            .filter(entity => typeof entity?.path === 'string' && entity.path.startsWith('ssh://'))
            .map(entity => ({
              id: String(entity.id ?? entity.path),
              path: entity.path,
              title: typeof entity.title === 'string' ? entity.title : '',
              // The browser half greys a detached workspace's own sessions, and
              // a session row carries only its id — so the membership has to
              // travel with the reply. Without it the row for the workspace goes
              // grey while the sessions inside it stay fully live.
              sessionIds: Array.isArray(entity.sessionIds) ? entity.sessionIds.map(String) : [],
            }))
        } catch { /* registry unavailable — the reply stands without the list */ }
        writeJson(res, 200, {
          mounted,
          // Detached workspaces: still registered, deliberately not served.
          // The panel derives "off" from this list alone, so a workspace can
          // never be shown as on while the fence says otherwise.
          disabled: router.listDisabled(),
          connections,
          reconnecting,
          workspaces,
          forwards: forwards.list(),
          // The saved half. `forwards` above stays the live view the agent
          // tools already consume; the panel needs the join to label a button
          // by what exists rather than by what was requested.
          ...(savedForwards === undefined
            ? {}
            : { forwardRows: savedForwards.list(), forwardSettings: savedForwards.settings() }),
          ...(shells === undefined ? {} : { shells: shells.list() }),
          // Recent connection and watcher events for the panel's status view.
          // The Host has no console exporter, so this is the only history a
          // user can actually reach (see lib/diagnostics.js).
          events: engine.diagnostics?.list(20) ?? [],
          // Current verdict per upstream workaround. Kept beside `events` for
          // the same reason: this is the channel that reaches a human, and
          // "one of our patches is obsolete, delete it" (probe: 'fixed') plus
          // "I could not judge the Host" (probe: 'unprobeable') both have to be
          // visible without reading a source file.
          upstreamWorkarounds: engine.upstreamWorkarounds ?? [],
        })
      },
    },
    // ---- mount
    {
      kind: 'exact',
      path: ROUTES.mount,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const alias = typeof body?.alias === 'string' ? body.alias.trim() : ''
        const remotePath = typeof body?.remotePath === 'string' ? body.remotePath.trim() : ''
        const title = typeof body?.title === 'string' ? body.title.trim() : ''
        const register = body?.register !== false
        if (alias === '' || remotePath === '' || !remotePath.startsWith('/')) {
          writeJson(res, 400, { error: 'alias and an absolute remotePath are required' })
          return
        }
        try {
          // Verify the target exists and is a directory.
          await engine.withSftp(alias, async (sftp) => {
            const stats = await new Promise((resolve, reject) => {
              sftp.stat(remotePath, (err, s) => { if (err) reject(err); else resolve(s) })
            })
            if (!stats.isDirectory()) throw new Error(`not a directory: ${remotePath}`)
          })
          const workspacePath = router.addRoot(alias, remotePath)
          // Advisory capability probe; never let it fail the mount.
          let capabilities
          try {
            const probed = await engine.probeCapabilities(alias)
            if (probed.rg !== undefined || probed.git !== undefined || probed.inotifywait !== undefined) capabilities = probed
          } catch { /* best-effort */ }
          let registered = false
          let workspaceId
          if (register) {
            try {
              const registry = ctx.get('workspaceRegistry')
              const existing = registry.list().find(entity => entity.path === workspacePath)
              if (existing !== undefined) {
                workspaceId = String(existing.id ?? existing.path)
                registered = true
              } else if (typeof registry.createCanonical === 'function') {
                const entity = await registry.createCanonical(workspacePath, title || remotePath.split('/').pop())
                workspaceId = String(entity.id ?? workspacePath)
                registered = true
              }
            } catch (regError) {
              // Mounted in-process but not registered — still usable.
              return writeJson(res, 200, {
                ok: true,
                workspacePath,
                registered: false,
                error: `mounted but not registered: ${regError instanceof Error ? regError.message : String(regError)}`,
              })
            }
          }
          writeJson(res, 200, {
            ok: true,
            workspacePath,
            registered,
            ...(workspaceId !== undefined ? { workspaceId } : {}),
            ...(capabilities !== undefined ? { capabilities } : {}),
          })
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---- unmount (detach / deregister)
    //
    // Two distinct requests share this endpoint because they both answer "stop
    // using this workspace" and differ only in how much is torn down:
    //
    //   detach      disable + archive sessions. The DSH workspace record
    //               survives, so the sidebar row stays visible (greyed) and the
    //               panel can re-enable it. Sessions disappear from every
    //               grouping surface but their files are untouched, and
    //               unarchiving restores each one to its recorded position.
    //               This is the DEFAULT: it is the only mode that is reversible.
    //   deregister  detach, then also delete the workspace record, so the row
    //               goes from the sidebar AND from this panel. Sessions are
    //               still archived, never deleted — DSH has no session-delete
    //               API and this plugin deliberately does not reach around the
    //               service layer to unlink session logs.
    //
    // The older `forget` spelling is accepted as an alias of `deregister`: the
    // two did the same thing to the record, and keeping a third near-duplicate
    // mode is how the panel ended up able to offer a re-enable button for a row
    // that no longer existed.
    {
      kind: 'exact',
      path: ROUTES.unmount,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const workspacePath = typeof body?.workspacePath === 'string' ? body.workspacePath.trim() : ''
        if (workspacePath === '') {
          writeJson(res, 400, { error: 'workspacePath is required' })
          return
        }
        const mode = normalizeUnmountMode(body)
        // Detaching alone must NOT archive: the workspace record survives, so
        // the sidebar group survives, and the sessions belonging to it must
        // keep showing up under it. Archiving them would empty the very group
        // the user asked to keep — the row would stay but read as an empty
        // workspace, which is a worse outcome than the one they declined.
        //
        // Archiving therefore follows the "also remove the workspace record"
        // opt-in, because that is the only action that takes the group away.
        // An explicit `archiveSessions` still wins, so a caller that wants the
        // split behaviour can ask for it.
        const archiveSessions = typeof body?.archiveSessions === 'boolean'
          ? body.archiveSessions
          : mode !== 'detach'
        try {
          const wasMounted = router.disableRoot(workspacePath)
          engine.store.entryStore.disableWorkspace(workspacePath)

          const registry = ctx.get('workspaceRegistry')
          const entity = registry?.list?.().find(candidate => candidate.path === workspacePath)

          // Archiving is the recoverable alternative to deleting: the session
          // files stay on disk and the accounting slot is kept, so unarchiving
          // puts each session back where it was.
          const archived = archiveSessions ? await archiveWorkspaceSessions(registry, entity) : { ok: [], failed: [] }

          let deregistered = false
          if (mode !== 'detach') {
            if (entity !== undefined && typeof registry?.delete === 'function') {
              await registry.delete(entity.id)
              deregistered = true
            }
            // Requirement: "also delete the workspace record" means the row goes
            // from the SIDEBAR **and** from this panel. Deleting the record
            // already removes the sidebar row; the panel's list is driven by the
            // detached mark, so that mark must come down too — otherwise the
            // panel keeps offering a re-enable button for a workspace that no
            // longer exists anywhere, and the runtime fence would refuse every
            // operation on a path the user can no longer re-enable.
            //
            // The mark therefore comes down in both places it is kept: the
            // persisted list and the in-memory fence.
            router.enableRoot(workspacePath)
            engine.store.entryStore.enableWorkspace(workspacePath)
          }
          writeJson(res, 200, {
            ok: true,
            mode,
            wasMounted,
            deregistered,
            archived: archived.ok,
            // A session that could not be archived is reported, never silently
            // skipped: it stays visible in the UI and the user should know.
            ...(archived.failed.length === 0 ? {} : { archiveFailed: archived.failed }),
          })
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---- enable (re-mount a detached workspace)
    {
      kind: 'exact',
      path: ROUTES.enable,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const workspacePath = typeof body?.workspacePath === 'string' ? body.workspacePath.trim() : ''
        if (workspacePath === '') {
          writeJson(res, 400, { error: 'workspacePath is required' })
          return
        }
        const parts = parseRemotePath(workspacePath)
        if (parts === undefined) {
          writeJson(res, 400, { error: `not a remote workspace path: ${JSON.stringify(workspacePath)}` })
          return
        }
        const unarchiveSessions = body?.unarchiveSessions !== false
        try {
          // The directory must still exist on the host, or enabling would
          // produce a workspace that looks served but answers ENOENT.
          await engine.withSftp(parts.alias, async (sftp) => {
            const stats = await new Promise((resolve, reject) => {
              sftp.stat(parts.remotePath, (err, s) => { if (err) reject(err); else resolve(s) })
            })
            if (!stats.isDirectory()) throw new Error(`not a directory on ${parts.alias}: ${parts.remotePath}`)
          })
          const mounted = router.addRoot(parts.alias, parts.remotePath)
          engine.store.entryStore.enableWorkspace(workspacePath)

          const registry = ctx.get('workspaceRegistry')
          let entity = registry?.list?.().find(candidate => candidate.path === workspacePath)
          let registered = entity !== undefined
          if (entity === undefined && typeof registry?.createCanonical === 'function') {
            entity = await registry.createCanonical(workspacePath, parts.remotePath.split('/').pop())
            registered = true
          }
          const unarchived = unarchiveSessions && entity !== undefined
            ? await unarchiveWorkspaceSessions(registry, entity)
            : { ok: [], failed: [] }

          writeJson(res, 200, {
            ok: true,
            workspacePath: mounted,
            registered,
            unarchived: unarchived.ok,
            ...(unarchived.failed.length === 0 ? {} : { unarchiveFailed: unarchived.failed }),
          })
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---- open port forward
    {
      kind: 'exact',
      path: ROUTES.forward,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const alias = typeof body?.alias === 'string' ? body.alias.trim() : ''
        const asPort = (value, label) => {
          const numeric = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : undefined)
          if (numeric === undefined) return undefined
          if (!Number.isInteger(numeric) || numeric < 0 || numeric > 65535) throw new Error(`${label} must be an integer between 0 and 65535`)
          return numeric
        }
        try {
          const remotePort = asPort(body?.remotePort, 'remotePort')
          if (remotePort === undefined || remotePort < 1) throw new Error('remotePort is required (1-65535)')
          const localPort = asPort(body?.localPort, 'localPort')
          const forward = await forwards.open(alias, {
            remotePort,
            ...(localPort !== undefined ? { localPort } : {}),
            ...(typeof body?.remoteHost === 'string' && body.remoteHost.trim() !== '' ? { remoteHost: body.remoteHost.trim() } : {}),
            ...(typeof body?.localHost === 'string' && body.localHost.trim() !== '' ? { localHost: body.localHost.trim() } : {}),
          })
          writeJson(res, 200, { ok: true, forward })
        } catch (error) {
          writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---- close port forward
    {
      kind: 'exact',
      path: ROUTES.unforward,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const id = typeof body?.id === 'string' ? body.id.trim() : ''
        if (id === '') {
          writeJson(res, 400, { error: 'id is required' })
          return
        }
        try {
          writeJson(res, 200, { ok: true, closed: forwards.close(id) })
        } catch (error) {
          writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---- saved forwards: create / toggle / delete / remember
    //
    // These sit beside the two transient routes above rather than replacing
    // them: the agent tools still open throwaway tunnels, and a user who wants
    // one of those kept can "remember" it afterwards.
    {
      kind: 'exact',
      path: ROUTES.forwardSave,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        if (savedForwards === undefined) { writeJson(res, 500, { error: 'saved forwards are unavailable' }); return }
        const body = await readJsonBody(req)
        const alias = typeof body?.alias === 'string' ? body.alias.trim() : ''
        const asPort = (value, label) => {
          const numeric = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : undefined)
          return numeric === undefined ? undefined : requireStoredPort(numeric, label)
        }
        try {
          const remotePort = asPort(body?.remotePort, 'remotePort')
          const rawLocal = asPort(body?.localPort, 'localPort')
          if (remotePort === undefined) throw new Error('remotePort is required (1-65535)')
          // A saved mapping pins its local port; "same as remote" is resolved
          // here, in the request, so the stored row records a real number.
          const localPort = rawLocal ?? remotePort
          const row = await savedForwards.create({
            alias,
            remotePort,
            localPort,
            ...(typeof body?.remoteHost === 'string' && body.remoteHost.trim() !== '' ? { remoteHost: body.remoteHost.trim() } : {}),
            ...(typeof body?.localHost === 'string' && body.localHost.trim() !== '' ? { localHost: body.localHost.trim() } : {}),
            open: body?.open !== false,
          })
          writeJson(res, 200, {
            ok: true,
            forward: row,
            ...(row.error === undefined ? {} : { error: row.error }),
          })
        } catch (error) {
          writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.forwardToggle,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        if (savedForwards === undefined) { writeJson(res, 500, { error: 'saved forwards are unavailable' }); return }
        const body = await readJsonBody(req)
        const id = typeof body?.id === 'string' ? body.id.trim() : ''
        if (id === '') { writeJson(res, 400, { error: 'id is required' }); return }
        const enabled = body?.enabled === true
        try {
          // The toggle follows the requested state, and the row it returns
          // reports the runtime truth: an `enabled: true` request that could
          // not bind comes back with `live: false` and an `error`.
          const row = enabled ? await savedForwards.openById(id) : savedForwards.closeById(id)
          writeJson(res, 200, { ok: row.error === undefined, forward: row, ...(row.error === undefined ? {} : { error: row.error }) })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          writeJson(res, 200, { ok: false, error: message, forward: savedForwards.rowById(id) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.forwardDelete,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        if (savedForwards === undefined) { writeJson(res, 500, { error: 'saved forwards are unavailable' }); return }
        const body = await readJsonBody(req)
        const id = typeof body?.id === 'string' ? body.id.trim() : ''
        if (id === '') { writeJson(res, 400, { error: 'id is required' }); return }
        try {
          writeJson(res, 200, { ok: true, deleted: savedForwards.remove(id) })
        } catch (error) {
          writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.forwardRemember,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        if (savedForwards === undefined) { writeJson(res, 500, { error: 'saved forwards are unavailable' }); return }
        const body = await readJsonBody(req)
        const id = typeof body?.id === 'string' ? body.id.trim() : ''
        if (id === '') { writeJson(res, 400, { error: 'id is required' }); return }
        try {
          writeJson(res, 200, { ok: true, forward: savedForwards.remember(id) })
        } catch (error) {
          writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---- check a local port before the user commits to it
    {
      kind: 'exact',
      path: ROUTES.forwardProbe,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const host = (url.searchParams.get('localHost') ?? '127.0.0.1').trim() || '127.0.0.1'
        const rawPort = (url.searchParams.get('localPort') ?? '').trim()
        const port = rawPort === '' ? Number.NaN : Number(rawPort)
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          writeJson(res, 400, { error: 'localPort must be an integer between 1 and 65535' })
          return
        }
        try {
          const verdict = await probeLocalPort(host, port)
          writeJson(res, 200, {
            ok: true,
            available: verdict.ok,
            ...(verdict.ok ? {} : { code: verdict.code, error: describeProbeFailure(host, port, verdict.code) }),
          })
        } catch (error) {
          writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---- saved forward preferences
    {
      kind: 'exact',
      path: ROUTES.forwardSettings,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        if (savedForwards === undefined) { writeJson(res, 500, { error: 'saved forwards are unavailable' }); return }
        const body = await readJsonBody(req)
        try {
          // Only `autoStart` is settable today; anything else in the body is
          // ignored so a stale browser cannot rewrite unrelated settings.
          const settings = savedForwards.setAutoStart(body?.autoStart === true)
          writeJson(res, 200, { ok: true, settings })
        } catch (error) {
          writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---- move a file between this machine and a host
    {
      kind: 'exact',
      path: ROUTES.transfer,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const alias = typeof body?.alias === 'string' ? body.alias.trim() : ''
        const direction = body?.direction === 'download' ? 'download' : body?.direction === 'upload' ? 'upload' : ''
        const localPath = typeof body?.localPath === 'string' ? body.localPath.trim() : ''
        const remotePath = typeof body?.remotePath === 'string' ? body.remotePath.trim() : ''
        if (alias === '') { writeJson(res, 400, { error: 'alias is required' }); return }
        if (direction === '') { writeJson(res, 400, { error: 'direction must be upload or download' }); return }
        if (localPath === '') { writeJson(res, 400, { error: 'localPath is required' }); return }
        if (remotePath === '') { writeJson(res, 400, { error: 'remotePath is required' }); return }
        try {
          router.assertEnabled(alias, remotePath)
          const result = direction === 'upload' && body?.recursive === true
            ? await uploadTree(engine, { alias, localPath, remotePath, roots: router.roots })
            : await transferFile(engine, { alias, direction, localPath, remotePath, roots: router.roots })
          writeJson(res, 200, { ok: true, bytes: result.bytes, ...(result.files !== undefined ? { files: result.files } : {}) })
        } catch (error) {
          writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---- stream one remote file to the browser
    //
    // Separate from `transfer` on purpose: that route moves a file to a path on
    // THIS machine (a tool-shaped, JSON answer), while the browser needs the
    // bytes themselves. Streaming them out keeps a download from being decoded
    // into a JSON string, which would inflate it and cap it at the body limit.
    {
      kind: 'exact',
      path: ROUTES.download,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req) || !isLoopbackHostHeader(req)) {
          writeJson(res, 403, { error: 'forbidden' })
          return
        }
        if (req.method !== 'GET') {
          writeJson(res, 405, { error: 'method not allowed' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const alias = (url.searchParams.get('alias') ?? '').trim()
        const remotePath = (url.searchParams.get('path') ?? '').trim()
        if (alias === '' || remotePath === '') {
          writeJson(res, 400, { error: 'alias and path are required' })
          return
        }
        try {
          const { size, chunks } = await openRemoteRead(engine, alias, remotePath, router)
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': String(size),
            'content-disposition': `attachment; filename="${basenameOf(remotePath)}"`,
          })
          for await (const chunk of chunks) res.write(chunk)
          res.end()
        } catch (error) {
          if (!res.headersSent) {
            // A failure must not look like a download. Answering 200 here used
            // to make the browser save the JSON error body under the remote
            // file's name: the client keys on `response.ok`, and a 200 blob of
            // `{"error":"..."}` is indistinguishable from file content once the
            // headers are gone. The status is the only channel the browser's
            // download flow respects, so it carries the failure.
            writeJson(res, statusForDownloadError(error), { error: error instanceof Error ? error.message : String(error) })
            return
          }
          res.end()
        }
      },
    },
    // ---- receive one file from the browser and write it to the host
    //
    // The browser posts the raw bytes as the request body (application/
    // octet-stream) rather than multipart: one file per request keeps the
    // streaming simple and avoids a multipart parser in the bundler-loaded
    // client. `path` names the remote directory, `name` the file inside it.
    {
      kind: 'exact',
      path: ROUTES.upload,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req) || !isLoopbackHostHeader(req)) {
          writeJson(res, 403, { error: 'forbidden' })
          return
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: 'method not allowed' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const alias = (url.searchParams.get('alias') ?? '').trim()
        const dir = (url.searchParams.get('path') ?? '').trim()
        const name = (url.searchParams.get('name') ?? '').trim()
        if (alias === '' || dir === '' || name === '') {
          writeJson(res, 400, { error: 'alias, path and name are required' })
          return
        }
        // A name is one path segment: a slash would let a request escape the
        // directory the user is looking at.
        if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
          writeJson(res, 400, { error: 'name must be a single path segment' })
          return
        }
        const remotePath = dir === '/' ? `/${name}` : `${dir.replace(/\/+$/u, '')}/${name}`
        try {
          const written = await writeRemoteFromRequest(engine, alias, remotePath, req, router)
          writeJson(res, 200, { ok: true, bytes: written, remotePath })
        } catch (error) {
          writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
  ]
}

/**
 * Stream a request body into one remote file.
 *
 * The bytes go straight from the HTTP request into SFTP without buffering the
 * whole body: an upload can be far larger than what a JSON body limit allows,
 * and holding it in memory would defeat the point of streaming.
 *
 * Publication matches the filesystem half: write a sibling staging name, then
 * rename. A reader therefore never observes a half-written destination.
 *
 * @param {object} engine - live engine.
 * @param {string} alias - host alias.
 * @param {string} remotePath - absolute destination path.
 * @param {import('node:http').IncomingMessage} req - the request carrying the bytes.
 * @param {object} [router] - the filesystem router: the detached fence and the
 *   served-root set an upload is fenced against.
 * @returns {Promise<number>} how many bytes were written.
 */
async function writeRemoteFromRequest (engine, alias, remotePath, req, router) {
  router?.assertEnabled?.(alias, remotePath)
  return await engine.withSftp(alias, async (sftp) => {
    // The same reachability fence `write` and the transfer tool apply, run
    // before a single byte is staged. The browser panel reaches this route
    // directly, so without it a path outside every mounted workspace — or one
    // whose parent is a symlink escaping them — would land here while the model's
    // own `write` was refused. Policy (mode / session scope) is deliberately not
    // decided here: this is a user action on a directory the panel is showing,
    // and the mounted-root fence is the answer it owes.
    await fenceUploadTarget(sftp, alias, remotePath, router?.roots)
    await sftpMkdirp(sftp, remoteParentOf(remotePath), remotePath)
    const staging = `${remotePath.replace(/\/+$/u, '')}.dsh-up-${process.pid}-${Date.now().toString(36)}`
    let handle
    let written = 0
    try {
      handle = await sftpOpenHandle(sftp, staging, 'w', remotePath)
      for await (const chunk of req) {
        await sftpWriteHandle(sftp, handle, chunk, remotePath)
        written += chunk.length
      }
      await sftpCloseHandle(sftp, handle)
      handle = undefined
      await sftpPublishRename(sftp, staging, remotePath, remotePath)
      return written
    } catch (error) {
      if (handle !== undefined) { try { await sftpCloseHandle(sftp, handle) } catch { /* already gone */ } }
      try { await sftpUnlink(sftp, staging) } catch { /* staging never created */ }
      throw error
    }
  })
}

/**
 * An error that carries an `FsError` code without importing the peer class.
 *
 * `statusForDownloadError` branches on `code`, and the fence already raises a
 * real `FsError` with `FS_PERMISSION_DENIED` (detached) or `FS_OUTSIDE_WORKSPACE`
 * (unmounted) — so the two failures that this file raises itself must use the
 * same vocabulary, or a missing file would answer 500 and read as a server fault.
 *
 * @param {string} message - what went wrong, for the user.
 * @param {string} code - the `FsError` code.
 * @returns {Error} the error to throw.
 */
function codedError (message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * Open one remote file for chunked reading.
 *
 * @param {object} engine - live engine.
 * @param {string} alias - host alias.
 * @param {string} remotePath - absolute remote path.
 * @param {object} [router] - the filesystem router, used for the detached fence.
 * @returns {Promise<{size: number, chunks: AsyncGenerator<Buffer>}>} the size and a chunk stream.
 */
async function openRemoteRead (engine, alias, remotePath, router) {
  router?.assertEnabled?.(alias, remotePath)
  return await engine.withSftp(alias, async (sftp) => {
    const info = await sftpStatOrNull(sftp, remotePath)
    if (info === null) throw codedError(`remote file does not exist: ${remotePath}`, 'FS_NOT_FOUND')
    if (typeof info.isDirectory === 'function' && info.isDirectory()) {
      throw codedError(`not a file: ${remotePath}`, 'FS_NOT_REGULAR_FILE')
    }
    const size = typeof info.size === 'number' ? info.size : 0
    const handle = await sftpOpenHandle(sftp, remotePath, 'r', remotePath)
    let position = 0
    let closed = false
    const closeOnce = async () => {
      if (closed) return
      closed = true
      try { await sftpCloseHandle(sftp, handle) } catch { /* already gone */ }
    }
    async function * generate () {
      try {
        for (;;) {
          const chunk = await sftpReadHandle(sftp, handle, position, 256 * 1024, remotePath)
          if (chunk.length === 0) break
          position += chunk.length
          yield chunk
        }
      } finally {
        await closeOnce()
      }
    }
    return { size, chunks: generate() }
  })
}

/** The final path segment, for the downloaded filename. */
function basenameOf (remotePath) {
  const trimmed = String(remotePath).replace(/\/+$/u, '')
  const index = trimmed.lastIndexOf('/')
  return (index < 0 ? trimmed : trimmed.slice(index + 1)).replaceAll('"', '_') || 'download'
}

/**
 * Validate a port a saved mapping may name.
 *
 * Distinct from the transient route's parser: a saved mapping is a promise
 * about a specific local URL, so 0 ("any free port") is not storable.
 *
 * @param {number} value - the candidate.
 * @param {string} label - field name for the error.
 * @returns {number} the port.
 * @throws {Error} when out of range.
 */
function requireStoredPort (value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${label} must be an integer between 1 and 65535`)
  }
  return value
}

/**
 * Turn a failed port probe into the sentence the panel shows.
 *
 * The two codes a user can actually act on are named; everything else keeps the
 * raw code so a bug report is still diagnosable.
 *
 * @param {string} host - the local interface probed.
 * @param {number} port - the local port probed.
 * @param {string | undefined} code - the bind error code.
 * @returns {string} the explanation.
 */
function describeProbeFailure (host, port, code) {
  if (code === 'EADDRINUSE') return `local port ${port} on ${host} is already in use`
  if (code === 'EACCES') return `local port ${port} on ${host} is not bindable (permission denied or reserved by the system)`
  if (code === 'EADDRNOTAVAIL') return `local address ${host} does not exist on this machine`
  return `local port ${port} on ${host} cannot be bound${code === undefined ? '' : ` (${code})`}`
}
