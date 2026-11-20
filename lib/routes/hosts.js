/**
 * The host routes: the store, the pool and the host key.
 *
 * Everything the panel needs to manage a host without opening a workspace:
 * list, create/update, delete, forget a pinned key, drop a pooled connection,
 * retry the backoff now, and probe reachability. They share one shape — read a
 * JSON body, act on the store or the pool, answer with `statusForActionError`
 * when the action failed — which is why they live together rather than beside
 * the routes that move files.
 *
 * @module @shiqyka/dsh-ssh-workspace/routes/hosts
 */

import { queryParam, readJsonBody, statusForActionError, writeJson } from './kit.js'
import { ROUTES } from '../routes.js'

/**
 * Build the host route descriptors.
 *
 * @param {object} deps - what these routes read.
 * @param {object} deps.engine - the SSH engine (store, pool, reconnector).
 * @param {object} [deps.forwards] - live port forwards, torn down with a connection.
 * @param {object} [deps.savedForwards] - saved forward rows, when persistence is on.
 * @param {Function} deps.guard - the JSON request guard from the route kit.
 * @returns {Array<object>} route descriptors for ctx.webServer.register().
 */
export function hostRoutes ({ engine, forwards, savedForwards, guard }) {
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
        // `listing()` reports what could NOT be shown as well as what could:
        // a skipped entry and an unreadable store used to render as "no hosts",
        // which is the one thing the user cannot act on.
        const listing = engine.store.listing?.() ?? { rows: engine.store.rows(), skipped: [] }
        const rows = listing.rows.map(row => {
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
        writeJson(res, 200, {
          hosts: filtered,
          // Always present so the client does not have to distinguish "absent"
          // from "empty"; the reason travels with each skipped entry.
          skipped: listing.skipped ?? [],
          ...(listing.storeError === undefined ? {} : { storeError: listing.storeError }),
        })
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
          // Tags were stored, filtered on by both the route and the agent tool,
          // and had no way IN — the save route dropped them, so the panel's new
          // editor field would have been a no-op and a hand-edited
          // `dsh-ssh.json` was the only source. Normalized here (trim, drop
          // blanks, de-duplicate) so the store never holds two spellings of one
          // tag and the search box matches what the card shows.
          tags: Array.isArray(body?.tags)
            ? [...new Set(body.tags.filter(tag => typeof tag === 'string').map(tag => tag.trim()).filter(tag => tag !== ''))]
            : [],
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
            writeJson(res, 409, { ok: false, error: `alias ${JSON.stringify(aliasTrimmed)} is already defined in ~/.ssh/config; edit that file instead or pick another alias` })
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
          // A colliding alias is the caller's to fix (409); an invalid form is
          // 400; an unreadable store is 500 — all from the store's own code.
          writeJson(res, statusForActionError(error, 500), { ok: false, error: error instanceof Error ? error.message : String(error) })
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
          writeJson(res, inConfig ? 409 : statusForActionError(error, 500), {
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
          writeJson(res, statusForActionError(error, 500), { ok: false, error: error instanceof Error ? error.message : String(error) })
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
          writeJson(res, 409, { ok: false, error: `the connection has ${record.inFlight} operation(s) in flight — disconnect again once it is idle` })
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
          writeJson(res, statusForActionError(error, 500), { ok: false, error: error instanceof Error ? error.message : String(error) })
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
          writeJson(res, 501, { ok: false, error: 'background reconnect is disabled in this deployment' })
          return
        }
        const started = Date.now()
        try {
          const result = await engine.reconnector.retryNow(alias)
          writeJson(res, 200, { ...result, durationMs: Date.now() - started })
        } catch (error) {
          writeJson(res, statusForActionError(error, 502), { ok: false, error: error instanceof Error ? error.message : String(error) })
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
  ]
}
