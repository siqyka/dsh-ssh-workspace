/**
 * Re-attach `ssh://` sessions to their remote workspace after the Host built
 * its session index without this plugin's filesystem bridge.
 *
 * ## Why this exists
 *
 * `@deepseek-ai/dsh-workspace` judges session membership by canonical path:
 * `indexHeader()` calls `realpath(cwd)` and, when that throws, records the id
 * in `invalidSessionPaths` — it enters NEITHER `sessionPaths` nor
 * `missingSessionPaths`, so `candidateMatches()` is false and `sessionIds`
 * filters the session out of the workspace's ownership. `mutate()` then writes
 * that filtered list, which makes the loss durable: every later `setTitle`
 * or `attachSession` on that workspace prunes those ids from the stored record.
 *
 * With this plugin absent, `realpath('ssh://host/abs/path')` cannot succeed —
 * `fullyQualifiedWorkspacePath()` rejects the scheme on every platform before
 * `fs` is even consulted. So a startup that indexed BEFORE the plugin mounted
 * its roots silently orphaned the remote sessions, and the fix is to re-run the
 * attach once the roots ARE mounted: `attachSession()` validates through the
 * same `realpath`/`stat`, which now resolves by lexical identity against the
 * mounted root (see `fs-shim.js`), and `rememberSessionPath()` restores the
 * membership this plugin alone can prove.
 *
 * ## Shape of this module
 *
 * Pure logic, explicit dependencies, no `ctx` and no `node:fs`: a registry fake,
 * a session-list fake and a diagnostics fake are enough to exercise every
 * branch, which is what `tests/workspace-ownership-smoke.mjs` does. The caller
 * (`lib/index.js`) owns the once-per-activation guard and hands over the live
 * services.
 *
 * Failures are reported, never thrown: reclaiming is a compensation, not a
 * critical path, and a plugin that fails to activate because a worked-around
 * Host quirk bit it is worse than a workspace that stays hidden and says so.
 *
 * @module @shiqyka/dsh-ssh-workspace/ownership
 */

import { KINDS } from './diagnostics.js'
import { formatRemotePath, isRemotePath, parseRemotePath } from './protocol.js'

/** Longest readable failure reason; everything longer is cut, not dumped. */
const MAX_REASON = 160

/**
 * Canonical spelling of a workspace/session path for exact comparison.
 *
 * `ssh://` spellings are normalized lexically (alias + normalized remote path),
 * which is the same identity the filesystem seam uses. Anything else is
 * returned verbatim: the comparison is only ever between two spellings of the
 * SAME world, and a local cwd can never equal an `ssh://` target anyway.
 *
 * A malformed `ssh://` spelling keeps its raw form on purpose — normalizing it
 * would be a guess, and two guesses can collide.
 *
 */
export function canonicalSpelling (path) {
  if (typeof path !== 'string') return ''
  if (!isRemotePath(path)) return path
  try {
    const parts = parseRemotePath(path)
    if (parts !== undefined) return formatRemotePath(parts.alias, parts.remotePath)
  } catch { /* malformed spelling: fall through to the literal string */ }
  return path
}

/**
 * Whether a header describes a CHILD session rather than a sidebar row.
 *
 * A subagent session inherits the parent's cwd, so it looks like a candidate on
 * every path count — and it is never a row the sidebar can show: the Host
 * persists child sessions under their bare id, nests them under the parent in
 * every grouping surface, and cannot attach them here. Counting one as
 * `pending` produced a warning that can never clear, which reads as a
 * permanent bug rather than as a report.
 *
 * @returns {boolean} true when the header describes a child session.
 */
export function isChildSessionHeader (header) {
  if (header === null || typeof header !== 'object') return false
  return header.origin === 'subagent' || header.subagent !== undefined
}

/**
 * The sessions of one workspace that still have to be re-attached, newest first.
 *
 * Exact equality on the canonical spelling, never a prefix test: a session whose
 * cwd is a SUBDIRECTORY of the workspace belongs to no workspace at all (the
 * Host only accounts a canonical string equality), and claiming it here would
 * re-create the same silent inconsistency from the other side.
 *
 * @param {Iterable<string>} [known] - ids the workspace already accounts for.
 */
export function reclaimCandidates (path, headers, known = []) {
  const target = canonicalSpelling(path)
  if (target === '') return []
  const taken = new Set([...known].map(String))
  const rows = []
  for (const header of Array.isArray(headers) ? headers : []) {
    if (header === null || typeof header !== 'object') continue
    const id = typeof header.id === 'string' ? header.id : ''
    if (id === '' || taken.has(id)) continue
    if (isChildSessionHeader(header)) continue
    if (canonicalSpelling(header.cwd) !== target) continue
    const createdAt = Number(header.createdAt)
    rows.push({ id, createdAt: Number.isFinite(createdAt) ? createdAt : 0 })
  }
  // Newest first: the sidebar shows the workspace's sessions in attach order,
  // and a re-claimed group should read like the list the user remembers.
  rows.sort((left, right) => right.createdAt - left.createdAt)
  return rows.map(row => row.id)
}

/**
 * One short, human-readable failure reason with the path taken out.
 *
 * The reason travels into the status surfaces, and an `ssh://` spelling carries
 * the host ALIAS — which the diagnostics rules keep out of free text (the alias
 * belongs in its own structured field, see `lib/report.js`). Every throwing
 * Host API here puts the path in its message, so the redaction is per-call, not
 * cosmetic.
 *
 * @param {unknown} error - the thrown value.
 * @returns {string} the reason, at most {@link MAX_REASON} characters.
 */
export function failureReason (error, path = '') {
  let text = error instanceof Error
    ? (typeof error.code === 'string' && error.code !== '' ? `${error.code}: ${error.message}` : error.message)
    : String(error)
  text = text.replace(/\s+/gu, ' ').trim()
  const parts = typeof path === 'string' ? wordsToRedact(path) : []
  for (const word of parts) {
    if (word === '') continue
    text = text.split(word).join('<workspace>')
  }
  text = text.replace(/ssh:\/\/\S+/gu, '<workspace>')
  if (text === '') text = 'the Host refused without a message'
  return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON - 1)}…` : text
}

/**
 * Every spelling of one workspace path that must not survive into a reason.
 *
 */
function wordsToRedact (path) {
  const words = [path]
  try {
    const parts = parseRemotePath(path)
    if (parts !== undefined) {
      words.push(parts.remotePath)
      // The alias alone is only redacted when it is long enough to be a name
      // rather than a substring of ordinary words.
      if (parts.alias.length >= 3) words.push(parts.alias)
    }
  } catch { /* not a remote spelling: the literal path is the only one */ }
  return words.filter(word => typeof word === 'string' && word !== '').sort((left, right) => right.length - left.length)
}

/**
 * The readable session list, in the documented degradation order.
 *
 * `sessionQuery` is preferred because it folds the LIVE sessions over the
 * persisted ones (a session may have changed directory since its header was
 * written); `sessionPersistence` is the fallback, and having neither is a
 * degraded run rather than a crash.
 *
 */
export function makeSessionHeaderReader (services = {}) {
  const query = services?.sessionQuery
  const persistence = services?.sessionPersistence
  return async function readSessionHeaders () {
    if (query !== undefined && query !== null && typeof query.listSessions === 'function') {
      try {
        const records = await query.listSessions()
        if (Array.isArray(records)) {
          return { headers: headersOf(records), source: 'sessionQuery' }
        }
      } catch { /* fall through to the persistence list */ }
    }
    if (persistence !== undefined && persistence !== null && typeof persistence.list === 'function') {
      try {
        const rows = await persistence.list()
        if (Array.isArray(rows)) {
          return { headers: headersOf(rows), source: 'sessionPersistence' }
        }
      } catch { /* reported as degraded below */ }
    }
    return {
      headers: [],
      degraded: 'no readable session list: neither sessionQuery.listSessions() nor sessionPersistence.list() answered',
    }
  }
}

/**
 * Pull the header out of either listing shape and drop unusable ones.
 *
 * Both services wrap a header (`{header, live, persisted}` and
 * `{header, formatStatus, …}`); a bare header is accepted too so a test or a
 * future service needs no adapter.
 *
 */
function headersOf (rows) {
  const headers = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const header = row.header !== null && typeof row.header === 'object' ? row.header : row
    if (typeof header.id !== 'string' || header.id === '') continue
    if (typeof header.cwd !== 'string' || header.cwd === '') continue
    headers.push(header)
  }
  return headers
}

/**
 * Whether the workspace now accounts for one session.
 *
 * `sessionIds` is the Host's FILTERED view, so it is the only honest check
 * available after an attach. Two paths can leave a session invisible: the
 * record may already hold the id (so `attachSession` short-circuits and never
 * calls `rememberSessionPath`), and the whole header table may or may not have
 * been re-indexed meanwhile — a later `readSessionHeader` miss re-runs
 * `indexHeaders`, which would resolve these paths against the mounted root on
 * its own. Rather than reason about which of the two happened, the result is
 * READ BACK and reported: counting a call that changed nothing as a success is
 * the silent failure this module exists to end.
 *
 * @returns {boolean} true only when the workspace lists it now.
 */
function accountsFor (entity, sessionId) {
  try {
    const ids = entity?.sessionIds
    return Array.isArray(ids) && ids.includes(sessionId)
  } catch {
    return false
  }
}

/**
 * Attach one session, then READ BACK whether the workspace now counts it.
 *
 * @returns {Promise<void>} resolves only when the membership is visible.
 */
async function claimSession (entity, sessionId) {
  if (typeof entity?.attachSession !== 'function') {
    throw new TypeError('this workspace record cannot attach sessions')
  }
  await entity.attachSession(sessionId)
  if (!accountsFor(entity, sessionId)) {
    throw new Error('the workspace still does not count this session, so it stays hidden')
  }
}

/**
 * Run one piece of work with a wall-clock budget.
 *
 * The recovery talks to live services that can stall: an SSH handshake against
 * an unresponsive host, a persistence listing that is waiting for its store. A
 * compensation with no deadline leaves the status surface empty forever, which
 * is indistinguishable from "it never ran" — so every await below is bounded and
 * a timeout is reported as a failure reason instead of being swallowed.
 *
 * @template T
 */
export async function withDeadline (work, budgetMs, label) {
  let timer
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} did not answer within ${budgetMs}ms`)
      error.code = 'ETIMEDOUT'
      reject(error)
    }, budgetMs)
  })
  try {
    return await Promise.race([Promise.resolve().then(work), deadline])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Build the Host session-index rebuild this recovery runs BEFORE any claim.
 *
 * The order is the whole point. A startup that indexed the session table while
 * this plugin was disabled records every `ssh://` cwd as unresolvable, and the
 * Host never re-runs that index on its own (`readSessionHeader` answers from the
 * cached table). Worse, `attachSession` SHORT-CIRCUITS when its raw record
 * already holds the id — `mutate()` just re-writes the same membership — so
 * re-attaching after "disable, restart, enable" repairs nothing while the index
 * still calls the cwd invalid. Only a re-index can make `candidateMatches()`
 * true again, and a claim made before it is a no-op dressed as a success.
 *
 * `replaceHeaderIndex` / `listStoredHeaders` / `indexLiveSessions` are not a
 * public Host API, so an absent or renamed method degrades to `unsupported`
 * (the caller then reports "restart once") rather than throwing.
 *
 * @returns {() => Promise<{state: string, headers: Array<object>}>} the rebuild, `state` being `reindexed`, `unsupported`, `empty` or `failed: …`.
 */
export function makeIndexRebuilder (registry) {
  return async function rebuildSessionIndex () {
    if (registry === undefined || registry === null) return { state: 'unsupported', headers: [] }
    const list = registry.listStoredHeaders
    const replace = registry.replaceHeaderIndex
    if (typeof list !== 'function' || typeof replace !== 'function') return { state: 'unsupported', headers: [] }
    let headers
    try {
      headers = await list.call(registry)
    } catch (error) {
      return { state: `failed: ${failureReason(error)}`, headers: [] }
    }
    if (!Array.isArray(headers)) return { state: 'unsupported', headers: [] }
    // An empty listing is not a licence to wipe the index: the same call against
    // a store that has not opened yet looks identical, and clearing the table
    // would hide every session in the deployment.
    if (headers.length === 0) return { state: 'empty', headers: [] }
    try {
      await replace.call(registry, headers)
    } catch (error) {
      return { state: `failed: ${failureReason(error)}`, headers: [] }
    }
    // The rebuild swaps the whole table, so a session started since its last
    // store write would lose its entry. The Host indexes live sessions at
    // creation time; re-run that for them. Also not a public API, hence the guard.
    try {
      await registry.indexLiveSessions?.()
    } catch { /* the stored headers already cover every persisted session */ }
    return { state: 'reindexed', headers }
  }
}

/**
 * Announce the repaired membership to connected clients.
 *
 * The workspace feed is event-driven: a client receives one baseline when it
 * subscribes and nothing afterwards unless a TABLE RECORD changes. A rebuild
 * repairs the session INDEX, not the records, so a client that subscribed while
 * the index was stale keeps the empty `sessionIds` it was handed — the repair
 * is complete on the Host and invisible in the sidebar until the page reloads.
 * Announcing each workspace's current FILTERED view through the same event the
 * feed listens for is what makes the repair live instead of silent.
 *
 * The payload is the Host's own emission shape (`domain`, `table`, `key`,
 * `operation`, `value`), and `value` is the filtered view a baseline would
 * carry — never the raw record, which can hold ids the index still refuses.
 * `emit` is not a public API either, so an absent one degrades to
 * `unsupported` rather than throwing into the compensation.
 *
 */
export function makeWorkspaceRepublisher (context, registry) {
  return function announceWorkspaceMembership () {
    if (context === null || typeof context !== 'object' || typeof context.emit !== 'function') return { state: 'unsupported', published: 0 }
    if (registry === null || typeof registry !== 'object' || typeof registry.list !== 'function') return { state: 'unsupported', published: 0 }
    let entities
    try {
      entities = registry.list()
    } catch (error) {
      return { state: `failed: ${failureReason(error)}`, published: 0 }
    }
    if (!Array.isArray(entities)) return { state: 'unsupported', published: 0 }
    let published = 0
    for (const entity of entities) {
      const value = workspaceViewOf(entity)
      if (value === null) return { state: 'failed: a workspace could not be projected', published }
      try {
        context.emit('domain/changed', {
          domain: 'workspace',
          table: 'workspaces',
          key: String(entity.id),
          operation: 'put',
          value,
        })
        published += 1
      } catch (error) {
        return { state: `failed: ${failureReason(error)}`, published }
      }
    }
    return { state: 'published', published }
  }
}

/**
 * The detached projection one announcement carries.
 *
 * Reads only the entity's public getters, so it cannot leak a raw record: the
 * filtered `sessionIds` is exactly what a feed baseline publishes.
 *
 * @returns {object|null} the projection, or null when it cannot be read.
 */
function workspaceViewOf (entity) {
  try {
    return {
      path: String(entity.path),
      title: String(entity.title),
      sessionIds: Array.isArray(entity.sessionIds) ? entity.sessionIds.map(String) : [],
      createdAt: String(entity.createdAt),
      updatedAt: String(entity.updatedAt),
    }
  } catch {
    return null
  }
}

/**
 * Record one event, tolerating a missing or throwing log.
 *
 * @param {string} kind - one of {@link KINDS}.
 */
function record (diagnostics, kind, message) {
  try {
    diagnostics?.record?.(kind, message)
  } catch { /* observability must never break the compensation */ }
}

/** Default wall-clock budget for the one index rebuild (it dials every host once). */
const DEFAULT_REBUILD_BUDGET_MS = 45_000

/** Default wall-clock budget for one `attachSession` claim. */
const DEFAULT_CLAIM_BUDGET_MS = 10_000

/**
 * Default wall-clock budget for ALL claims of one pass.
 *
 * One per-claim deadline is not enough on its own: a host that is down fails
 * every claim, and thirty of them would spend five minutes pretending to make
 * progress during startup. The group budget turns "many slow failures" into one
 * reported reason.
 */
const DEFAULT_CLAIMS_BUDGET_MS = 60_000

/**
 * Snapshot of one recovery pass, both as report and as live progress.
 *
 * `stage` is updated in place while the pass runs, so the status surfaces never
 * have to show `null` for "a compensation is in flight but nothing to say yet":
 * a stuck dial reads as `rebuilding`, a stuck claim as `claiming`.
 *
 */

export function emptyOwnershipSnapshot (now = Date.now) {
  return {
    at: now(),
    stage: 'listing',
    updatedAt: now(),
    scanned: 0,
    reclaimed: 0,
    pending: 0,
    indexRebuilt: null,
    published: 0,
    publishError: null,
    skipped: [],
    degraded: null,
    failures: [],
  }
}

/**
 * A detached copy of an ownership snapshot, for the surfaces that return it.
 *
 * Structural on purpose. This copy used to be written field by field (so a
 * later activation could not rewrite a value the result already described),
 * and that list drifted from the Host schema once: `stage` and `updatedAt`
 * were added to the snapshot and to the schema but not to the copy, so the
 * whole status result failed validation with "missing required property
 * value.ownership.updatedAt" and every status surface read the field as null.
 * A structural copy cannot drift from the object it copies.
 *
 */
export function ownershipSnapshotCopy (ownership) {
  return structuredClone(ownership)
}

/**
 * Re-claim the sessions of every live remote workspace, once.
 *
 * Preconditions are the caller's, and the order matters:
 *  1. the remote roots are already registered with the filesystem seam —
 *     `realpath`/`stat` only resolve against a mounted root;
 *  2. this runs AFTER that loop, in the same activation.
 *
 * The pass has two moves, and the FIRST one is the load-bearing one:
 *  - rebuild the Host session index, so `ssh://` cwds resolve and membership is
 *    provable again (without this, every claim is a no-op — see
 *    `makeIndexRebuilder`);
 *  - then attach the remote sessions the record does not hold at all, which is
 *    the "the Host pruned them while the plugin was off" case.
 *
 * Everything is bounded (`withDeadline`) and READ BACK (`accountsFor`): a
 * `reclaimed` count is never incremented for a call that changed nothing.
 *
 * Nothing here creates, moves or deletes a workspace, and no `detachSession`
 * is ever called: the stored record is the only input, `attachSession` the
 * only write.
 *
 * @param {() => Promise<{headers: Array<object>, degraded?: string}>} [options.readHeaders] - session list fallback, used when the rebuild is unavailable.
 * @param {object} [options.snapshot] - a caller-owned snapshot to mutate as the pass progresses.
 * @returns {Promise<object>} the snapshot (`stage: 'done'` when the pass completed).
 */
export async function reclaimOwnership (options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now
  const diagnostics = options.diagnostics
  const rebuildBudgetMs = Number.isFinite(options.rebuildBudgetMs) && options.rebuildBudgetMs > 0 ? options.rebuildBudgetMs : DEFAULT_REBUILD_BUDGET_MS
  const claimBudgetMs = Number.isFinite(options.claimBudgetMs) && options.claimBudgetMs > 0 ? options.claimBudgetMs : DEFAULT_CLAIM_BUDGET_MS
  const claimsBudgetMs = Number.isFinite(options.claimsBudgetMs) && options.claimsBudgetMs > 0 ? options.claimsBudgetMs : DEFAULT_CLAIMS_BUDGET_MS
  const snapshot = options.snapshot !== null && typeof options.snapshot === 'object' ? options.snapshot : emptyOwnershipSnapshot(now)
  const regained = new Set()
  const stage = (value) => {
    snapshot.stage = value
    snapshot.updatedAt = now()
  }

  let entities
  try {
    entities = options.registry?.list?.()
  } catch (error) {
    snapshot.degraded = `the workspace registry could not be listed: ${failureReason(error)}`
    record(diagnostics, KINDS.degraded, `workspace ownership: ${snapshot.degraded}`)
    stage('done')
    return snapshot
  }
  if (!Array.isArray(entities)) entities = []

  // A detached workspace is not a failure to reclaim: its root is deliberately
  // unserved, so `realpath` would fail for a reason the user chose. Counting it
  // as `pending` would make "turn a workspace off" look like a bug forever.
  const detached = new Set((Array.isArray(options.detached) ? options.detached : []).map(String))
  const targets = []
  for (const entity of entities) {
    const path = String(entity?.path ?? '')
    if (path === '' || !isRemotePath(path)) continue
    if (detached.has(path)) {
      snapshot.skipped.push(path)
      continue
    }
    targets.push({ entity, path, before: visibleIds(entity) })
    snapshot.scanned += 1
  }
  if (targets.length === 0) {
    stage('done')
    return snapshot
  }

  // Re-index the Host session table FIRST, and unconditionally.
  //
  // Why unconditional: the entity's `sessionIds` getter returns the FILTERED
  // view, so while the index is stale a workspace can hold thirty ids in its
  // record and show zero sessions — and the record itself is not on the
  // entity's public surface. From here "healthy, nothing to do" and "the exact
  // breakage this pass repairs" therefore look identical, which is how a live
  // re-enable came up empty with no symptom left to measure. Measured cost:
  // 337 ms for a 60-session store with three ssh:// roots on this deployment,
  // once per activation.
  //
  // The rebuild also proves membership by itself: an id the record held all
  // along only lacked a resolvable PATH, and `attachSession` short-circuits on
  // exactly that, so those are counted here and never re-attached.
  stage('rebuilding')
  let rebuiltState = 'skipped'
  let rebuilt
  if (typeof options.rebuildIndex === 'function') {
    try {
      rebuilt = await withDeadline(() => options.rebuildIndex(), rebuildBudgetMs, 'the Host session-index rebuild')
    } catch (error) {
      rebuilt = { state: `failed: ${failureReason(error)}`, headers: [] }
    }
    rebuiltState = typeof rebuilt?.state === 'string' && rebuilt.state !== '' ? rebuilt.state : 'unsupported'
    if (rebuiltState.startsWith('failed:')) {
      record(diagnostics, KINDS.degraded,
        `workspace ownership: the Host session index could not be rebuilt — ${rebuiltState.slice('failed:'.length).trim()}`)
    }
  }
  snapshot.indexRebuilt = rebuiltState

  // The registry answers with the repaired membership from here on, but a client
  // that subscribed while the index was stale still holds the empty list it was
  // handed at connect: the feed re-reads the registry only on `domain/changed`,
  // and a rebuild touches the INDEX, not the records. Announce the repaired
  // membership once, through that same event — otherwise the repair is correct
  // and invisible (see `makeWorkspaceRepublisher`).
  if (rebuiltState === 'reindexed' && typeof options.republish === 'function') {
    try {
      const announced = await options.republish()
      snapshot.published = Number.isInteger(announced?.published) && announced.published > 0 ? announced.published : 0
      if (typeof announced?.state === 'string' && announced.state.startsWith('failed:')) {
        snapshot.publishError = announced.state.slice('failed:'.length).trim()
        record(diagnostics, KINDS.degraded,
          `workspace ownership: the repaired membership could not be announced to connected clients — ${snapshot.publishError}`)
      }
    } catch (error) {
      snapshot.publishError = failureReason(error)
      record(diagnostics, KINDS.degraded,
        `workspace ownership: the repaired membership could not be announced to connected clients — ${snapshot.publishError}`)
    }
  }

  // What the rebuild alone brought back, and the post-rebuild membership each
  // target counts. Both are read BEFORE any attach: an id that reappeared here
  // needs no `attachSession` (it would short-circuit), so counting it anywhere
  // else would either double-count or silently drop the repair.
  const visibleAfter = new Map()
  for (const target of targets) {
    const visible = visibleIds(target.entity)
    visibleAfter.set(target.path, visible)
    for (const sessionId of visible) {
      if (target.before.has(sessionId)) continue
      snapshot.reclaimed += 1
      regained.add(target.path)
    }
  }

  // The list the attach phase filters by. The rebuild's own listing is
  // preferred (it is the same store read the re-index just did); `sessionQuery`
  // is the fallback, and the only way to see a session whose header was
  // rewritten since its last store write. A reader that stalls is not
  // permission to skip the repair — it only means the unknown outlives it.
  let headers = rebuiltState === 'reindexed' && Array.isArray(rebuilt?.headers) && rebuilt.headers.length > 0
    ? rebuilt.headers
    : undefined
  let unreadReason = ''
  if (headers === undefined && typeof options.readHeaders === 'function') {
    stage('listing')
    let listing
    try {
      listing = await withDeadline(() => options.readHeaders(), claimBudgetMs, 'the session list')
    } catch (error) {
      listing = { headers: [], degraded: failureReason(error) }
    }
    if (listing !== undefined && Array.isArray(listing.headers) && typeof listing.degraded !== 'string') {
      headers = listing.headers
    } else {
      unreadReason = typeof listing?.degraded === 'string' && listing.degraded !== ''
        ? listing.degraded
        : 'the session list could not be read: no reader answered'
    }
  } else if (headers === undefined) {
    unreadReason = 'the session list could not be read: no reader answered'
  }

  if (headers === undefined) {
    // Nothing could list sessions, and the rebuild did not either: unknown is
    // not zero, so `pending` stays 0 and the degradation is the signal. Any
    // membership the rebuild itself restored has already been counted above.
    snapshot.degraded = unreadReason !== '' ? unreadReason : 'the session list could not be read: no reader answered'
    record(diagnostics, KINDS.degraded, `workspace ownership: ${snapshot.degraded}`)
    stage('done')
    return snapshot
  }

  // A session whose cwd IS this workspace while the workspace does not count it.
  const expected = new Map()
  for (const target of targets) {
    expected.set(target.path, reclaimCandidates(target.path, headers, visibleAfter.get(target.path)))
  }

  // Attach what the record does not hold at all. Every call is bounded and read
  // back: a `reclaimed` count is never incremented for a call that changed
  // nothing.
  stage('claiming')
  const claimsUntil = now() + claimsBudgetMs
  for (const target of targets) {
    const visible = visibleIds(target.entity)
    for (const sessionId of expected.get(target.path) ?? []) {
      if (visible.has(sessionId)) continue
      if (now() > claimsUntil) {
        snapshot.failures.push({ path: target.path, sessionId, reason: `the claim budget (${claimsBudgetMs}ms) was exhausted` })
        continue
      }
      try {
        await withDeadline(() => claimSession(target.entity, sessionId), claimBudgetMs, `attaching session '${sessionId}'`)
        snapshot.reclaimed += 1
        regained.add(target.path)
        visible.add(sessionId)
      } catch (error) {
        snapshot.failures.push({ path: target.path, sessionId, reason: failureReason(error, target.path) })
      }
    }
  }

  snapshot.pending = snapshot.failures.length

  if (snapshot.reclaimed > 0) {
    record(diagnostics, KINDS.ownership,
      `reclaimed ${snapshot.reclaimed} session(s) for ${regained.size} remote workspace(s)`)
  }

  if (snapshot.pending > 0) {
    record(diagnostics, KINDS.degraded,
      `${snapshot.pending} session(s) could not be re-attached to their remote workspace and stay hidden from the sidebar`)
  }
  stage('done')
  return snapshot
}

/**
 * The membership the Host currently reports for one workspace.
 *
 * `sessionIds` is the FILTERED view, which is the only honest reading available:
 * the raw record can hold an id that the index refuses to account for, and that
 * difference is exactly what this recovery measures.
 *
 * @returns {Set<string>} the ids the workspace counts right now.
 */
function visibleIds (entity) {
  try {
    const ids = entity?.sessionIds
    if (Array.isArray(ids)) return new Set(ids.map(String))
  } catch { /* unreadable membership reads as "nothing visible yet" */ }
  return new Set()
}
