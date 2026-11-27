/**
 * The workspace routes: mount, unmount, enable, status, self-check, report.
 *
 * One subject - a remote directory being served or not - and one question the
 * panel asks constantly: "what is mounted, is the connection up, and is
 * anything wrong?". The status and report routes read the world through the
 * SAME `diagnosisInput`, deliberately: the panel's dot and the pasted report
 * disagreeing about what the plugin can see is the failure that function
 * exists to prevent.
 *
 * @module @shiqyka/dsh-ssh-workspace/routes/workspaces
 */

import { ownershipSnapshotCopy } from '../surface/ownership.js'
import { parseRemotePath } from '../core/protocol.js'
import { preferencesPatchOf } from '../hosts/preferences.js'
import { auditRetentionPatchOf } from '../engine/audit-limits.js'
import { oldestProbe, statusProvenance } from '../surface/status.js'
import { renderSelfCheck, selfCheck } from '../report/capabilities.js'
import { buildSupportBundle, diagnose, DIAGNOSIS_VERSION } from '../report/report.js'
import { schemeRules } from '../fs/passthrough.js'
import { queryParam, readJsonBody, refuseJsonBody, statusForActionError, trimmedParam, writeJson } from './kit.js'
import { ROUTES } from './routes.js'

/**
 * The store-backed viewing preferences, or `undefined` when this composition
 * has no store.
 *
 * One accessor for the read and the write, so `/status` and the POST route can
 * never disagree about which section they mean. A store that throws (an
 * unparsable document) is not the same as an absent one: the store's own
 * `preferences()` already degrades to the defaults, and reaching here means the
 * accessor itself is missing — the panel then reads "no preferences" and keeps
 * its defaults.
 *
 * @param {object} engine - the engine holding the host store.
 * @returns {{fileView: string, showFiles: boolean, hideComposer: boolean}|undefined} the settings.
 */
function preferencesOfStore (engine) {
  const store = engine?.store?.entryStore
  if (typeof store?.preferences !== 'function') return undefined
  return store.preferences()
}

/**
 * Build the workspace route descriptors.
 *
 * @param {object} [deps.reverseForwards] - reverse forwards, when enabled.
 * @param {object} [deps.savedForwards] - saved forward rows, when persistence is on.
 * @param {object} [deps.passthroughSettings] - the local-passthrough settings, when enabled.
 * @param {object} [deps.shells] - persistent remote shells, when enabled.
 * @param {object} [deps.remoteSkills] - the remote-skill provider, when enabled.
 */
export function workspaceRoutes (deps) {
  const { engine, router, forwards, reverseForwards, savedForwards, passthroughSettings, shells, remoteSkills, ctx, guard, diagnosisInput, normalizeUnmountMode, archiveWorkspaceSessions, unarchiveWorkspaceSessions } = deps
  return [
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
          // The generation, and the sentence that explains it. The panel shows
          // the sentence; `generation` travels too so a client can notice a
          // CHANGE between two refreshes rather than only reading the label.
          generation: record.generation ?? 0,
          generationNote: engine.describeGeneration?.(alias) ?? '',
        }))
        // Background retry state, one row per host the loop is working on. The
        // panel needs `attempts` and `nextAt` to say "retrying in 8s" instead of
        // showing a dead host with no explanation; `phase: 'gave-up'` is a
        // different message again ("stopped"), so the two must not be flattened
        // into one boolean.
        const reconnecting = engine.reconnector?.list?.() ?? []
        // The user's persisted "keep this host connected" intent. A top-level
        // array so ssh-config hosts (which have no editable entry) can carry it
        // too. Read through the store accessor, degrading to empty on a bad
        // document so a damaged intent section cannot break /status.
        let autoConnect = []
        try {
          autoConnect = engine.store?.entryStore?.autoConnectHosts?.() ?? []
        } catch { /* an unreadable store means nothing is restorable */ }
        // Hosts being dialed right now: the boot restore's queued/in-flight
        // aliases UNION the engine's in-flight acquires. Without the first half,
        // a switched-on host queued behind a slow handshake shows "not connected"
        // on the first poll while its switch is already on.
        const connecting = [...new Set([
          ...(engine.autoConnectPending ?? []),
          ...(engine.acquiring?.keys?.() ?? []),
        ])]
        // Last connect failure per host — the only channel that can say
        // "connection failed" for a fatal error, which arms no retry row.
        const failures = engine.failureRows?.() ?? []
        // One sentence per host that has ever connected, so the panel can say
        // "generation 3, anything started before the reconnect may still be
        // running" instead of a bare "connected". Derived from the same
        // generations map the records carry, so a host that dropped out of the
        // pool entirely is still describable.
        const generations = [...(engine.generations?.keys?.() ?? [])].map(alias => ({
          alias,
          generation: engine.generationOf(alias).generation,
          note: engine.describeGeneration(alias),
        }))
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
        // Read once: the accessor reads and normalizes a section, so calling it
        // in both the presence test and the value would read the store twice.
        const preferences = preferencesOfStore(engine)
        writeJson(res, 200, {
          mounted,
          // Detached workspaces: still registered, deliberately not served.
          // The panel derives "off" from this list alone, so a workspace can
          // never be shown as on while the fence says otherwise.
          disabled: router.listDisabled(),
          // Hosts switched off by the panel's power switch: not detached (their
          // records and sessions are intact) but unusable until switched back
          // on. The mark pass dims their rows and names the switch as the reason.
          disabledHosts: [...(engine.disabledHosts ?? [])],
          connections,
          reconnecting,
          // Connection intent + "what is dialing now" + last failures. All three
          // describe the same host from different angles and must ship together
          // so the panel can render the switch (intent), the "connecting" badge
          // (in flight), and the red "connection failed" dot (last failure).
          autoConnect,
          connecting,
          failures,
          generations,
          workspaces,
          forwards: forwards.list(),
          // Remote listeners, kept apart for the same reason the tool keeps
          // them apart: direction is the first thing a reader needs.
          reverseForwards: reverseForwards?.list?.() ?? [],
          // The saved half. `forwards` above stays the live view the agent
          // tools already consume; the panel needs the join to label a button
          // by what exists rather than by what was requested.
          ...(savedForwards === undefined
            ? {}
            : { forwardRows: savedForwards.list(), forwardSettings: savedForwards.settings() }),
          // The live passthrough settings, read back from the same controller
          // the save route writes: `scheme` is what is in force right now (the
          // saved name, else the configured default) and `enabled` is whether
          // passthrough is on at all — the panel greys both controls when it is
          // not, instead of offering a setting that changes nothing.
          //
          // `schemeRules` travels beside it so the panel can explain a refusal
          // from the same tables the server enforces instead of keeping a
          // second copy of the syntax and the reserved names. `schemeWarning`
          // is the other direction: a value saved by an older build that is no
          // longer legal is degraded rather than rewritten, and this is the
          // only channel that says so out loud.
          ...(passthroughSettings === undefined
            ? {}
            : {
                passthrough: {
                  ...passthroughSettings.settings(),
                  schemeRules: schemeRules(),
                  schemeWarning: passthroughSettings.warning?.() ?? null,
                },
              }),
          // The browser panel's viewing preferences. Read through the store
          // accessor and normalized there, so a hand-edited bad value reaches
          // the panel as the default rather than as "neither mode". Absent when
          // the composition has no store, which the panel reads as the default.
          ...(preferences === undefined ? {} : { preferences }),
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
          // The other half of that question: did OUR takeovers land? A seam that
          // failed to install is a documented feature silently gone, and the
          // panel needs it beside the workaround verdicts rather than in a log
          // nothing reads.
          seams: engine.seams ?? [],
          // Remote skill discovery. Absent when this composition has no `skills`
          // registry at all, which the panel must not render as "turned off".
          ...(remoteSkills === undefined ? {} : { remoteSkills: remoteSkills.describe() }),
          // The session-ownership compensation, so a re-enable can be read
          // from the same reply the panel already polls. Absent means "not
          // measured yet" and is deliberately not the same as a zero.
          ...(engine.ownership === undefined ? {} : { ownership: ownershipSnapshotCopy(engine.ownership) }),
          // How old each section is, and where it came from. Without this the
          // reply mixes facts of three different ages and renders them alike:
          // the connection list is read now, the capability rows are a cache
          // that may predate a tool being installed, and the event ring is
          // history by definition. "It says connected but the tree is empty" is
          // what an unlabelled mix produces.
          //
          // The probe's label describes the OLDEST cached row, not the newest:
          // a section is only as fresh as its stalest fact.
          provenance: statusProvenance({
            now: Date.now(),
            probe: oldestProbe(engine),
          }).sections,
          // What each probed host can do, one row per tool. Derived from the
          // cache rather than probing: the panel polls this route, and a status
          // request that dialled every host would make "how are things?" itself
          // network activity. A host appears here only after something else
          // probed it (a mount, or the self-check button).
          selfCheck: [...(engine.capabilities?.keys?.() ?? [])].map(alias => {
            const report = selfCheck(engine.capabilities.get(alias), engine.environmentOf(alias))
            return {
              alias,
              missing: report.missing,
              rows: report.rows,
              findings: report.findings,
            }
          }),
          // Recent remote commands. Only the failing ones are worth a panel
          // section, but the whole record travels so the panel can decide — and
          // so a future surface does not need a second route.
          commands: engine.audit?.list?.(50) ?? [],
          // What the audit tab needs to describe itself without a second request:
          // how many rows are kept, and how many have ever been recorded. The
          // rows themselves come from `ROUTES.audit` when the tab opens.
          audit: {
            retention: engine.audit?.capacity ?? 200,
            sequence: engine.audit?.sequence ?? 0,
          },
          // The verdict behind the panel's status dot, derived from the same
          // fields `/support-bundle` prints. Computed HERE rather than in the
          // browser so the dot and the pasted report cannot disagree: one
          // implementation, two renderings. `findings` carries the alias as a
          // separate field (the report masks it, the panel shows it).
          //
          // `notes` travels beside it and does NOT count: the self-check is
          // advisory (a missing optional tool is not a malfunction), and
          // folding it into `findings` turned the dot red on healthy machines.
          diagnosis: (() => {
            const report = diagnose(diagnosisInput())
            return { version: DIAGNOSIS_VERSION, state: report.state, warn: report.warn, unknown: report.unknown, findings: report.findings, notes: report.notes }
          })(),
        })
      },
    },
    // ---- remote self-check for one host
    //
    // Reads and formats; never probes on demand. A GET that silently opened an
    // SSH connection would be a request the browser can issue from a link, and
    // "loading a page dials a server" is the exact behaviour `probe-smoke`
    // exists to prevent. So this serves the CACHED probe (running it once if
    // the host was never probed, which is what the mount path does too) and
    // says plainly when there is nothing to report yet.
    {
      kind: 'exact',
      path: ROUTES.selfCheck,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const alias = (queryParam(url, 'alias') ?? '').trim()
        if (alias === '') {
          writeJson(res, 400, { error: 'alias is required' })
          return
        }
        try {
          const tools = await engine.probeCapabilities(alias)
          const environment = engine.environmentOf(alias)
          const report = selfCheck(tools, environment)
          writeJson(res, 200, {
            alias,
            tools,
            environment: environment ?? {},
            rows: report.rows,
            findings: report.findings,
            missing: report.missing,
            // The same text the status tool prints, so a user who pastes one
            // and a user who reads the other are looking at one wording.
            text: renderSelfCheck(report),
          })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---- diagnostic report
    //
    // Assembles what the other surfaces already know into one redacted paste.
    // Every field is read from an existing source (the host listing, the audit
    // ring, the diagnostics ring, the probe cache) rather than collected here,
    // so the report cannot report something the panel would contradict.
    {
      kind: 'exact',
      path: ROUTES.supportBundle,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const text = buildSupportBundle(diagnosisInput())
        // `text/plain` rather than JSON: the bundle's whole purpose is to be
        // copied and pasted, and a browser opening this URL should show the
        // report, not a quoted string.
        try {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
          res.end(text)
        } catch { /* response already closed */ }
      },
    },
    // ---- mount
    {
      kind: 'exact',
      path: ROUTES.mount,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (refuseJsonBody(res, body)) return
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
        if (refuseJsonBody(res, body)) return
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
        if (refuseJsonBody(res, body)) return
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

          // Enabling answers "serve this path again", not "create a
          // workspace". The sidebar row is something the user creates by
          // mounting, or that a session creates by running work there; the
          // detached row in this panel is only the plugin's own record of "this
          // path was in use". Re-enabling must not resurrect a workspace entry
          // the user has since deleted — that turned one click into a second,
          // unrequested workspace. If the registry no longer knows the path,
          // enabling still lifts the fence and starts serving; the workspace
          // appears when something actually needs it.
          const registry = ctx.get('workspaceRegistry')
          const entity = registry?.list?.().find(candidate => candidate.path === workspacePath)
          const registered = entity !== undefined
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
    // ---- viewing preferences (where a clicked file opens, composer hiding)
    {
      kind: 'exact',
      path: ROUTES.preferences,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const store = engine?.store?.entryStore
        if (typeof store?.setPreferences !== 'function') {
          writeJson(res, 500, { error: 'viewing preferences are unavailable' })
          return
        }
        const body = await readJsonBody(req)
        if (refuseJsonBody(res, body)) return
        // The same rules the store applies on read, so a body and a hand-edited
        // value can never be judged by two different tables. Both keys are
        // OPTIONAL (the panel saves one at a time); anything else is a stale or
        // hand-written client and is refused rather than silently ignored.
        const verdict = preferencesPatchOf(body)
        if (verdict.ok !== true) {
          writeJson(res, 400, { error: verdict.error })
          return
        }
        try {
          const preferences = store.setPreferences(verdict.patch)
          writeJson(res, 200, { ok: true, preferences })
        } catch (error) {
          writeJson(res, statusForActionError(error, 500), { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---- the command audit, read whole
    //
    // GET rather than "the last fifty on /status" for one reason: the audit tab
    // is the surface that asks "what ran here", and a poll that ships a couple of
    // hundred rows every few seconds would make every idle panel pay for it.
    {
      kind: 'exact',
      path: ROUTES.audit,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const rawLimit = queryParam(url, 'limit')
        const parsed = rawLimit === undefined ? undefined : Number.parseInt(rawLimit, 10)
        const limit = Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, engine.audit?.capacity ?? 50) : undefined
        const sessionId = (queryParam(url, 'session') ?? '').trim()
        const audit = engine.audit
        if (audit === undefined || typeof audit.list !== 'function') {
          writeJson(res, 200, { entries: [], retention: 200, sequence: 0 })
          return
        }
        const entries = sessionId === ''
          ? audit.list(limit)
          : audit.listForSession(sessionId, limit)
        writeJson(res, 200, {
          entries,
          retention: audit.capacity,
          sequence: audit.sequence,
          ...(sessionId === '' ? {} : { sessionId }),
        })
      },
    },
    // ---- how many commands to keep
    {
      kind: 'exact',
      path: ROUTES.auditSettings,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const store = engine?.store?.entryStore
        const audit = engine.audit
        if (typeof store?.setAudit !== 'function' || audit === undefined || typeof audit.setCapacity !== 'function') {
          writeJson(res, 500, { error: 'the command audit is unavailable' })
          return
        }
        const body = await readJsonBody(req)
        if (refuseJsonBody(res, body)) return
        const verdict = auditRetentionPatchOf(body)
        if (verdict.ok !== true) {
          writeJson(res, 400, { error: verdict.error })
          return
        }
        try {
          // Store first, ring second: a write that fails must not leave the
          // panel showing a retention the next start would not honour.
          store.setAudit(verdict.retention)
          const retention = audit.setCapacity(verdict.retention)
          writeJson(res, 200, { ok: true, retention, sequence: audit.sequence })
        } catch (error) {
          writeJson(res, statusForActionError(error, 500), { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
  ]
}
