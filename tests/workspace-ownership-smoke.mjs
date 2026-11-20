/**
 * Session ownership: the compensation that puts `ssh://` sessions back on their
 * workspace after a startup that indexed the session table without this plugin.
 *
 * The failure this suite is built around is asymmetric, which is why it needs
 * its own file: the Host does not lose the SESSION FILES, it loses the membership
 * row. The sessions disappear from the sidebar, nothing throws, and every later
 * write to that workspace makes the loss durable. So the assertions below are
 * about accounting, not about files:
 *
 *  - a claim happens only on EXACT path equality, because the Host's rule is
 *    exact equality — claiming a subdirectory session would invent an
 *    inconsistency instead of repairing one;
 *  - an attach is verified, not assumed: the Host short-circuits when its raw
 *    record already holds the id, leaving the session invisible, and counting
 *    that as success is the exact "silent" behaviour this module exists to end;
 *  - the Host session index is rebuilt ONCE per activation, unconditionally:
 *    a stale index is indistinguishable from a healthy one from here (the
 *    entity's `sessionIds` is already FILTERED, and the raw record is not on
 *    its public surface), and a wrong "healthy" verdict is exactly the
 *    reinstall bug this pass exists to repair;
 *  - failures travel with a reason that carries no alias, and a run without a
 *    readable session list reports ZERO known misses instead of inventing a
 *    number.
 *
 * Run: node tests/workspace-ownership-smoke.mjs
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const load = file => import(pathToFileURL(path.join(pluginRoot, 'lib', file)).href)

const { canonicalSpelling, emptyOwnershipSnapshot, makeIndexRebuilder, makeWorkspaceRepublisher, ownershipSnapshotCopy, reclaimCandidates, reclaimOwnership, makeSessionHeaderReader, failureReason } = await load('ownership.js')
const { diagnose, STATE } = await load('diagnosis.js')
const { KINDS } = await load('diagnostics.js')

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  PASS  ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== workspace ownership smoke ===\n')

const ALIAS = 'host-one'
const WORKSPACE = `ssh://${ALIAS}/home/one/proj`

/** The live session list: the two normal cases plus every near-miss. */
const SESSIONS = [
  { id: 's-new', cwd: `ssh://${ALIAS}/home/one/proj`, createdAt: 300 },
  { id: 's-old', cwd: `ssh://${ALIAS}/home/one/proj`, createdAt: 100 },
  { id: 's-mid', cwd: `ssh://${ALIAS}/home/one/proj/`, createdAt: 200 },
  { id: 's-upslash', cwd: `ssh://${ALIAS}/home/one/proj/../proj`, createdAt: 50 },
  { id: 's-sub', cwd: `ssh://${ALIAS}/home/one/proj/sub`, createdAt: 400 },
  { id: 's-other-host', cwd: 'ssh://host-two/home/one/proj', createdAt: 500 },
  { id: 's-local', cwd: 'F:/GitHub/proj', createdAt: 600 },
  { id: 's-child', cwd: `ssh://${ALIAS}/home/one/proj`, createdAt: 700, origin: 'subagent' },
]

/**
 * A workspace record with just the methods this module touches.
 *
 * `hidden` models the Host's FILTERED `sessionIds` view: an id can sit in the
 * stored record and still be excluded from membership because its path never
 * resolved. That is not a corner case — it is the restart this suite exists for.
 */
function fakeEntity ({ entityPath = WORKSPACE, sessionIds = [], hidden = [], failFor = undefined, failAll = false, hangFor = undefined } = {}) {
  const record = [...sessionIds]
  const invisible = new Set(hidden)
  return {
    path: entityPath,
    record,
    attachCalls: [],
    /** The Host session-index rebuild: the path resolves again, so the
     *  FILTERED view stops hiding the id. */
    reveal () { invisible.clear() },
    async attachSession (sessionId) {
      this.attachCalls.push(sessionId)
      if (sessionId === hangFor) return new Promise(() => {})
      if (failAll || sessionId === failFor) {
        throw Object.assign(
          new Error(`cannot attach session '${sessionId}' to workspace '${entityPath}': its cwd does not resolve`),
          { code: 'ENOENT' },
        )
      }
      // The Host only validates when the RAW record does not already hold the
      // id; the short-circuit never rebuilds the path index, so a session in
      // `invisible` stays invisible even after this call.
      if (!record.includes(sessionId)) record.unshift(sessionId)
    },
    get sessionIds () {
      return record.filter(id => !invisible.has(id))
    },
  }
}

function reindexer (entities, headers = []) {
  const calls = []
  return {
    calls,
    async rebuildIndex () {
      calls.push(entities.length)
      for (const entity of entities) entity.reveal()
      // The Host's rebuild hands its indexed headers back so the pass does not
      // have to ask a second service for the same list.
      return { state: 'reindexed', headers }
    },
  }
}

function captureEvents () {
  const events = []
  return { events, diagnostics: { record: (kind, message) => events.push({ kind, message }) } }
}

// ---------------------------------------------------------------------------
console.log('[canonical identity is lexical, like the seams]')

check(
  'a `..` segment and a trailing slash share one spelling',
  canonicalSpelling(`ssh://${ALIAS}/home/one/proj/../proj/`) === WORKSPACE,
  canonicalSpelling(`ssh://${ALIAS}/home/one/proj/../proj/`),
)
check('a local path is compared verbatim', canonicalSpelling('F:/GitHub/proj') === 'F:/GitHub/proj')
check(
  'a malformed remote spelling is left literal rather than guessed at',
  canonicalSpelling('ssh:///home/one') === 'ssh:///home/one',
  canonicalSpelling('ssh:///home/one'),
)
check('a non-string canonicalizes to the empty sentinel', canonicalSpelling(undefined) === '')

// ---------------------------------------------------------------------------
console.log('\n[only exact equality is a candidate]')

const plan = reclaimCandidates(WORKSPACE, SESSIONS)
check('the unaccounted sessions of this workspace are planned', plan.length === 4, JSON.stringify(plan))
check('...newest first, because attach prepends', JSON.stringify(plan) === JSON.stringify(['s-new', 's-mid', 's-old', 's-upslash']), JSON.stringify(plan))
check('a subdirectory session is NOT claimed', !plan.includes('s-sub'), JSON.stringify(plan))
check('the same path on another host is NOT claimed', !plan.includes('s-other-host'), JSON.stringify(plan))
check('a local cwd is NOT claimed', !plan.includes('s-local'), JSON.stringify(plan))
check(
  'a subagent child session is NOT claimed: it inherits the cwd and is never a sidebar row',
  !plan.includes('s-child'),
  JSON.stringify(plan),
)
check(
  'ids the workspace already accounts for are filtered out',
  reclaimCandidates(WORKSPACE, SESSIONS, ['s-new']).every(id => id !== 's-new'),
  JSON.stringify(reclaimCandidates(WORKSPACE, SESSIONS, ['s-new'])),
)
check('a non-remote workspace plans nothing', reclaimCandidates('F:/GitHub/other', SESSIONS).length === 0)

// ---------------------------------------------------------------------------
console.log('\n[happiness: the compensation reclaims, and says so]')

{
  const captured = captureEvents()
  const entity = fakeEntity({ sessionIds: ['s-keep', 's-hidden'] })
  const snapshot = await reclaimOwnership({
    registry: { list: () => [entity] },
    readHeaders: async () => ({ headers: SESSIONS, source: 'sessionQuery' }),
    diagnostics: captured.diagnostics,
  })
  check('the snapshot is anchored to a timestamp', typeof snapshot.at === 'number' && snapshot.at > 0)
  check('exactly one remote workspace was scanned', snapshot.scanned === 1, String(snapshot.scanned))
  check('the four candidates were attached', snapshot.reclaimed === 4, String(snapshot.reclaimed))
  check('nothing is pending', snapshot.pending === 0, String(snapshot.pending))
  check('no workspace is skipped', snapshot.skipped.length === 0, JSON.stringify(snapshot.skipped))
  check('the check itself did not degrade', snapshot.degraded === null, String(snapshot.degraded))
  check(
    'attach order is the plan order (newest first)',
    JSON.stringify(entity.attachCalls) === JSON.stringify(['s-new', 's-mid', 's-old', 's-upslash']),
    JSON.stringify(entity.attachCalls),
  )
  check(
    'the workspace accounts for the claimed sessions afterwards',
    ['s-new', 's-mid', 's-old', 's-upslash'].every(id => entity.sessionIds.includes(id)),
    JSON.stringify(entity.sessionIds),
  )
  const ownershipEvents = captured.events.filter(event => event.kind === KINDS.ownership)
  check('a repair is recorded as an ownership event', ownershipEvents.length === 1, JSON.stringify(captured.events))
  check(
    '...carrying the count, not the paths',
    ownershipEvents[0]?.message.includes('reclaimed 4 session(s)') && !ownershipEvents[0]?.message.includes(ALIAS),
    ownershipEvents[0]?.message,
  )
  check('no degraded event on a clean run', captured.events.every(event => event.kind !== KINDS.degraded), JSON.stringify(captured.events))
}

// ---------------------------------------------------------------------------
console.log('\n[detached workspaces are skipped, never blamed]')

{
  const captured = captureEvents()
  const entity = fakeEntity()
  const snapshot = await reclaimOwnership({
    registry: { list: () => [entity] },
    detached: [WORKSPACE],
    readHeaders: async () => ({ headers: SESSIONS }),
    diagnostics: captured.diagnostics,
  })
  check('a detached workspace is listed as skipped', snapshot.skipped.includes(WORKSPACE), JSON.stringify(snapshot.skipped))
  check('...and is not scanned', snapshot.scanned === 0, String(snapshot.scanned))
  check('...and produces no failure', snapshot.failures.length === 0 && snapshot.pending === 0, JSON.stringify(snapshot.failures))
  check('...and is not attached behind the user\'s back', entity.attachCalls.length === 0, JSON.stringify(entity.attachCalls))
}

// ---------------------------------------------------------------------------
console.log('\n[one refusal costs one session, not the batch]')

{
  const captured = captureEvents()
  const entity = fakeEntity({ failFor: 's-mid' })
  const snapshot = await reclaimOwnership({
    registry: { list: () => [entity] },
    readHeaders: async () => ({ headers: SESSIONS }),
    diagnostics: captured.diagnostics,
  })
  check('the three attachable sessions were claimed', snapshot.reclaimed === 3, String(snapshot.reclaimed))
  check('the refused one is pending', snapshot.pending === 1, String(snapshot.pending))
  check('the failure names the workspace and the session', snapshot.failures[0]?.path === WORKSPACE && snapshot.failures[0]?.sessionId === 's-mid', JSON.stringify(snapshot.failures))
  check('the failure carries a reason', typeof snapshot.failures[0]?.reason === 'string' && snapshot.failures[0].reason !== '')
  check(
    'the reason has the alias taken out',
    !snapshot.failures[0].reason.includes(ALIAS),
    snapshot.failures[0].reason,
  )
  check(
    '...replacing the path with a placeholder instead of dropping the cause',
    snapshot.failures[0].reason.includes('<workspace>') && snapshot.failures[0].reason.includes('ENOENT'),
    snapshot.failures[0].reason,
  )
  check('a stranded session is a degraded event', captured.events.some(event => event.kind === KINDS.degraded), JSON.stringify(captured.events))
  check('the rest of the batch still ran', JSON.stringify(entity.attachCalls) === JSON.stringify(['s-new', 's-mid', 's-old', 's-upslash']), JSON.stringify(entity.attachCalls))
}

// ---------------------------------------------------------------------------
console.log('\n[an attach the record treats as a no-op is NOT a success]')

{
  const entity = fakeEntity({ sessionIds: ['s-new'], hidden: ['s-new'] })
  const snapshot = await reclaimOwnership({
    registry: { list: () => [entity] },
    readHeaders: async () => ({ headers: SESSIONS }),
    diagnostics: undefined,
  })
  check('the invisible session was attempted', entity.attachCalls.includes('s-new'), JSON.stringify(entity.attachCalls))
  check('...and is counted as pending, not reclaimed', snapshot.pending === 1 && snapshot.reclaimed === 3, JSON.stringify({ reclaimed: snapshot.reclaimed, pending: snapshot.pending }))
  check('...with the reason the visible state did not change', snapshot.failures[0]?.reason.includes('does not count this session'), snapshot.failures[0]?.reason)
  check('...while the sessions that really attached are claimed', snapshot.reclaimed === 3, String(snapshot.reclaimed))
}

// ---------------------------------------------------------------------------
console.log('\n[unknown is not zero]')

{
  const captured = captureEvents()
  const entity = fakeEntity()
  const snapshot = await reclaimOwnership({ registry: { list: () => [entity] }, diagnostics: captured.diagnostics })
  check('no reader at all does not throw', snapshot.degraded !== null && typeof snapshot.degraded === 'string', String(snapshot.degraded))
  check('...and does not invent a pending count', snapshot.pending === 0, String(snapshot.pending))
  check('...and attaches nothing', entity.attachCalls.length === 0)
  check('the degradation is recorded', captured.events.some(event => event.kind === KINDS.degraded), JSON.stringify(captured.events))
}
{
  const captured = captureEvents()
  const snapshot = await reclaimOwnership({
    registry: { list: () => [fakeEntity()] },
    readHeaders: async () => ({ headers: [], degraded: 'the session list was unreadable' }),
    diagnostics: captured.diagnostics,
  })
  check('a reader that reports degradation is believed', snapshot.degraded === 'the session list was unreadable', String(snapshot.degraded))
  check('...and still reports zero pending', snapshot.pending === 0)
}
{
  const captured = captureEvents()
  const snapshot = await reclaimOwnership({ registry: { list: () => { throw new Error('not started yet') } }, diagnostics: captured.diagnostics })
  check('an unreadable registry is reported, not thrown', typeof snapshot.degraded === 'string' && snapshot.degraded.includes('not started'), String(snapshot.degraded))
  check('an unreadable registry degrades through the log', captured.events.some(event => event.kind === KINDS.degraded), JSON.stringify(captured.events))
}
{
  const readHeaders = async () => { throw new Error('sessionQuery exploded') }
  const snapshot = await reclaimOwnership({ registry: { list: () => [fakeEntity()] }, readHeaders })
  check('a throwing reader is caught', snapshot.degraded !== null && snapshot.pending === 0, String(snapshot.degraded))
}

// ---------------------------------------------------------------------------
console.log('\n[a failure is not reported as a repair]')

{
  const captured = captureEvents()
  const entity = fakeEntity({ failAll: true })
  const snapshot = await reclaimOwnership({
    registry: { list: () => [entity] },
    readHeaders: async () => ({ headers: SESSIONS }),
    diagnostics: captured.diagnostics,
  })
  check('every candidate ends up pending', snapshot.pending === 4 && snapshot.reclaimed === 0, JSON.stringify({ reclaimed: snapshot.reclaimed, pending: snapshot.pending }))
  check(
    '...and a child session is never attempted, so the count cannot include one that can never attach',
    !entity.attachCalls.includes('s-child'),
    JSON.stringify(entity.attachCalls),
  )
  check(
    '...and no ownership event claims a repair',
    captured.events.every(event => event.kind !== KINDS.ownership),
    JSON.stringify(captured.events),
  )
  check(
    '...only the degradation is logged',
    captured.events.filter(event => event.kind === KINDS.degraded).length === 1,
    JSON.stringify(captured.events),
  )
}

// ---------------------------------------------------------------------------
console.log('\n[a second activation does not double-claim]')

{
  const entity = fakeEntity()
  const first = await reclaimOwnership({ registry: { list: () => [entity] }, readHeaders: async () => ({ headers: SESSIONS }) })
  const second = await reclaimOwnership({ registry: { list: () => [entity] }, readHeaders: async () => ({ headers: SESSIONS }) })
  check('the first run claims', first.reclaimed === 4, String(first.reclaimed))
  check('the second run claims nothing', second.reclaimed === 0, String(second.reclaimed))
  check('...because the ids are now accounted for', entity.attachCalls.length === 4, String(entity.attachCalls.length))
}

// ---------------------------------------------------------------------------
console.log('\n[nothing to do means nothing measured]')

{
  let readerCalls = 0
  const captured = captureEvents()
  const snapshot = await reclaimOwnership({
    registry: { list: () => [{ path: 'F:/GitHub/local', sessionIds: [] }] },
    readHeaders: async () => { readerCalls += 1; return { headers: SESSIONS } },
    diagnostics: captured.diagnostics,
  })
  check('a local workspace is not scanned', snapshot.scanned === 0, String(snapshot.scanned))
  check('...and the session list is not read for nothing', readerCalls === 0, String(readerCalls))
  check('...and a quiet run stays quiet in the log', captured.events.length === 0, JSON.stringify(captured.events))
}

// ---------------------------------------------------------------------------
console.log('\n[the reader prefers the live fold and degrades in order]')

{
  const reader = makeSessionHeaderReader({
    sessionQuery: { listSessions: async () => [{ header: { id: 'q1', cwd: WORKSPACE, createdAt: 1 }, live: true, persisted: false }] },
    sessionPersistence: { list: async () => [{ header: { id: 'p1', cwd: WORKSPACE } }] },
  })
  const listing = await reader()
  check('sessionQuery answers first', listing.source === 'sessionQuery', String(listing.source))
  check('the fold\'s header is unwrapped to its id', JSON.stringify(listing.headers.map(h => h.id)) === JSON.stringify(['q1']), JSON.stringify(listing.headers))
}
{
  const reader = makeSessionHeaderReader({
    sessionQuery: { listSessions: async () => { throw new Error('query is down') } },
    sessionPersistence: { list: async () => [{ header: { id: 'p1', cwd: WORKSPACE } }] },
  })
  const listing = await reader()
  check('a failing sessionQuery falls back to persistence', listing.source === 'sessionPersistence', String(listing.source))
  check('...and does not report degradation on the fallback', listing.degraded === undefined, String(listing.degraded))
}
{
  const reader = makeSessionHeaderReader({})
  const listing = await reader()
  check('with neither source it degrades instead of throwing', typeof listing.degraded === 'string' && listing.headers.length === 0, String(listing.degraded))
}
{
  const reader = makeSessionHeaderReader({ sessionQuery: { listSessions: async () => [] } })
  const listing = await reader()
  check('an empty session list is a real answer, not a degradation', Array.isArray(listing.headers) && listing.headers.length === 0 && listing.degraded === undefined)
}

// ---------------------------------------------------------------------------
console.log('\n[the finding reaches the status dot]')

{
  const report = diagnose({ ownership: { pending: 3, reclaimed: 0 } })
  const finding = report.findings.find(entry => entry.id === 'workspace-ownership')
  check('a pending count becomes a finding', finding !== undefined, JSON.stringify(report.findings))
  check('...at warn, because it needs an action', finding?.state === STATE.warn, String(finding?.state))
  check('...stating the number', finding?.detail.includes('3 session(s)'), String(finding?.detail))
  check('...and that they are hidden', finding?.detail.includes('hidden from the sidebar'), String(finding?.detail))
}
{
  const report = diagnose({ pluginVersion: '0.3.4', ownership: { pending: 0, reclaimed: 4 } })
  check('a clean reclaim produces no finding', !report.findings.some(entry => entry.id === 'workspace-ownership'), JSON.stringify(report.findings))
  check('...and the verdict stays ok', report.state === STATE.ok, report.state)
}
{
  const report = diagnose({})
  check('an absent snapshot produces no finding', !report.findings.some(entry => entry.id === 'workspace-ownership'), JSON.stringify(report.findings))
  check('junk in the field does not throw or invent a finding', diagnose({ ownership: 'stranded' }).findings.every(entry => entry.id !== 'workspace-ownership'))
}

// ---------------------------------------------------------------------------
console.log('\n[the reason itself is safe to print]')

check(
  'failureReason redacts the alias and the path but keeps the code',
  !failureReason(Object.assign(new Error(`cannot attach session 'x' to workspace '${WORKSPACE}': its cwd does not resolve`), { code: 'ENOENT' }), WORKSPACE).includes(ALIAS),
  failureReason(Object.assign(new Error(`cannot attach session 'x' to workspace '${WORKSPACE}'`), { code: 'ENOENT' }), WORKSPACE),
)
check(
  '...and cuts an over-long message instead of echoing it',
  failureReason(new Error('x'.repeat(400)), WORKSPACE).length <= 160,
  String(failureReason(new Error('x'.repeat(400)), WORKSPACE).length),
)


// ---------------------------------------------------------------------------
console.log('\n[the Host index is rebuilt before any claim, on every activation]')

{
  // The exact reinstall sequence: the Host indexed `ssh://` cwds before this
  // plugin patched the filesystem, so the record still holds the id while the
  // FILTERED view hides it and `attachSession` short-circuits on the raw id.
  const entity = fakeEntity({ sessionIds: ['s-new'], hidden: ['s-new'] })
  const reindex = reindexer([entity], SESSIONS)
  const snapshot = await reclaimOwnership({
    registry: { list: () => [entity] },
    readHeaders: async () => ({ headers: SESSIONS }),
    rebuildIndex: reindex.rebuildIndex,
  })
  check('the record-held id becomes visible again', snapshot.reclaimed === 4 && snapshot.pending === 0, JSON.stringify({ reclaimed: snapshot.reclaimed, pending: snapshot.pending }))
  check('...and the run reports what the rebuild answered', snapshot.indexRebuilt === 'reindexed', String(snapshot.indexRebuilt))
  check('...after exactly ONE rebuild', reindex.calls.length === 1, String(reindex.calls.length))
  check(
    '...and the re-indexed id is never attached (the Host would short-circuit it)',
    entity.attachCalls.filter(id => id === 's-new').length === 0,
    JSON.stringify(entity.attachCalls),
  )
  check(
    '...while the ids the record never held are attached once each',
    entity.attachCalls.length === 3 && ['s-old', 's-mid', 's-upslash'].every(id => entity.attachCalls.includes(id)),
    JSON.stringify(entity.attachCalls),
  )
}

{
  // A run with nothing missing still rebuilds ONCE. The old gate — "only when
  // the symptom is there" — cannot tell this healthy run from a live re-enable
  // whose raw record is full but whose filtered view is empty: BOTH read zero
  // hidden ids from the entity, and the raw record is not reachable from here.
  // Measured cost on the real deployment: 337 ms for a 60-session store, once
  // per activation — cheaper than one wrong "nothing to do".
  const entity = fakeEntity({ sessionIds: ['s-new', 's-old', 's-mid', 's-upslash'] })
  const reindex = reindexer([entity], SESSIONS)
  const snapshot = await reclaimOwnership({
    registry: { list: () => [entity] },
    readHeaders: async () => ({ headers: SESSIONS }),
    rebuildIndex: reindex.rebuildIndex,
  })
  check('a run with nothing missing rebuilds exactly once', reindex.calls.length === 1, String(reindex.calls.length))
  check('...attaches nothing', entity.attachCalls.length === 0, JSON.stringify(entity.attachCalls))
  check('...claims nothing', snapshot.reclaimed === 0 && snapshot.pending === 0, JSON.stringify({ reclaimed: snapshot.reclaimed, pending: snapshot.pending }))
  check('...and reports the rebuild it paid for', snapshot.indexRebuilt === 'reindexed', String(snapshot.indexRebuilt))
}

{
  // The other half of the loss: the Host PRUNED the ids while the plugin was
  // detached, so the record does not hold them at all. Re-indexing cannot bring
  // them back; only an attach can.
  const entity = fakeEntity({ sessionIds: [] })
  const reindex = reindexer([entity], SESSIONS)
  const snapshot = await reclaimOwnership({
    registry: { list: () => [entity] },
    readHeaders: async () => ({ headers: SESSIONS }),
    rebuildIndex: reindex.rebuildIndex,
  })
  check('a pruned record is rebuilt before the claims', reindex.calls.length === 1, String(reindex.calls.length))
  check('...and every expected id is attached', entity.attachCalls.sort().join(',') === 's-mid,s-new,s-old,s-upslash', JSON.stringify(entity.attachCalls))
  check('...and counted', snapshot.reclaimed === 4 && snapshot.pending === 0, JSON.stringify({ reclaimed: snapshot.reclaimed, pending: snapshot.pending }))
}

{
  // A Host without the (non-contract) rebuild method must degrade to advice,
  // not to a silent half-repair: the sessions the record still holds stay hidden.
  const captured = captureEvents()
  const entity = fakeEntity({ sessionIds: ['s-new'], hidden: ['s-new'] })
  const snapshot = await reclaimOwnership({
    registry: { list: () => [entity] },
    readHeaders: async () => ({ headers: SESSIONS }),
    rebuildIndex: async () => ({ state: 'unsupported', headers: [] }),
    diagnostics: captured.diagnostics,
  })
  check('an unsupported rebuild leaves the record-held session pending', snapshot.pending === 1 && snapshot.reclaimed === 3, JSON.stringify({ reclaimed: snapshot.reclaimed, pending: snapshot.pending }))
  check('...and names the reason', snapshot.indexRebuilt === 'unsupported', String(snapshot.indexRebuilt))
  check('...and still degrades through the log', captured.events.some(event => event.kind === KINDS.degraded), JSON.stringify(captured.events))
}

{
  const captured = captureEvents()
  const entity = fakeEntity({ sessionIds: ['s-new'], hidden: ['s-new'] })
  const snapshot = await reclaimOwnership({
    registry: { list: () => [entity] },
    readHeaders: async () => ({ headers: SESSIONS }),
    rebuildIndex: async () => { throw Object.assign(new Error('the storage is closed'), { code: 'EBADF' }) },
    diagnostics: captured.diagnostics,
  })
  check('a throwing rebuild is caught, not propagated', snapshot.indexRebuilt.startsWith('failed:'), String(snapshot.indexRebuilt))
  check('...with the cause and its code kept', snapshot.indexRebuilt.includes('EBADF') && snapshot.indexRebuilt.includes('closed'), String(snapshot.indexRebuilt))
  check(
    '...and logged as its own degradation',
    captured.events.some(event => event.kind === KINDS.degraded && event.message.includes('could not be rebuilt')),
    JSON.stringify(captured.events),
  )
  check('...while the session stays pending', snapshot.pending === 1, String(snapshot.pending))
}

{
  // A refusal is reported once, never retried into a second accounting.
  const entity = fakeEntity({ failFor: 's-old' })
  const reindex = reindexer([entity], SESSIONS)
  const snapshot = await reclaimOwnership({
    registry: { list: () => [entity] },
    readHeaders: async () => ({ headers: SESSIONS }),
    rebuildIndex: reindex.rebuildIndex,
  })
  check('a refused claim is attempted exactly once', entity.attachCalls.filter(id => id === 's-old').length === 1, JSON.stringify(entity.attachCalls))
  check('...and is exactly one pending entry', snapshot.pending === 1 && snapshot.failures.length === 1, JSON.stringify(snapshot.failures))
  check('...while the rest are counted', snapshot.reclaimed === 3, String(snapshot.reclaimed))
}

{
  // A claim that never answers must not hold the pass hostage: the whole point of
  // the deadline is that the status surface reports a timeout instead of showing
  // an empty field forever.
  const entity = fakeEntity({ sessionIds: [], hangFor: 's-new' })
  const started = Date.now()
  const snapshot = await reclaimOwnership({
    registry: { list: () => [entity] },
    readHeaders: async () => ({ headers: SESSIONS }),
    rebuildIndex: reindexer([entity], SESSIONS).rebuildIndex,
    claimBudgetMs: 60,
  })
  check('a hung claim is abandoned at the budget', Date.now() - started < 900, `${Date.now() - started}ms`)
  check('...and reported as a timeout', snapshot.pending === 1 && snapshot.failures[0].reason.includes('did not answer within'), JSON.stringify(snapshot.failures))
  check('...with the rest still claimed', snapshot.reclaimed === 3, String(snapshot.reclaimed))
  check('...while the pass still finishes', snapshot.stage === 'done', String(snapshot.stage))
}

{
  // Thirty slow failures must not spend five minutes pretending to progress: the
  // group budget turns the remainder into one reported reason.
  const entity = fakeEntity({ sessionIds: [], hangFor: 's-new' })
  const started = Date.now()
  const snapshot = await reclaimOwnership({
    registry: { list: () => [entity] },
    readHeaders: async () => ({ headers: SESSIONS }),
    rebuildIndex: reindexer([entity], SESSIONS).rebuildIndex,
    claimBudgetMs: 200,
    claimsBudgetMs: 50,
  })
  check('the group budget stops the pass early', Date.now() - started < 1200, `${Date.now() - started}ms`)
  check(
    '...and the sessions it could not reach are reported, not counted',
    snapshot.failures.some(failure => failure.reason.includes('claim budget')) && snapshot.reclaimed === 0,
    JSON.stringify({ reclaimed: snapshot.reclaimed, reasons: snapshot.failures.map(failure => failure.reason) }),
  )
}

{
  // A session list that never answers is not a licence to skip the repair: the
  // rebuild answers the same question from the store, and a degradation that
  // cleared itself is not reported as one.
  const entity = fakeEntity({ sessionIds: [] })
  const reindex = reindexer([entity], SESSIONS)
  const snapshot = await reclaimOwnership({
    registry: { list: () => [entity] },
    readHeaders: () => new Promise(() => {}),
    rebuildIndex: reindex.rebuildIndex,
    claimBudgetMs: 60,
  })
  check('an unreadable session list still triggers the rebuild', reindex.calls.length === 1, String(reindex.calls.length))
  check('...which supplies the headers for the claims', entity.attachCalls.length === 4, JSON.stringify(entity.attachCalls))
  check('...and the cleared degradation is not reported', snapshot.degraded === null, String(snapshot.degraded))
  check('...and the sessions are counted', snapshot.reclaimed === 4, String(snapshot.reclaimed))
}

{
  // Nothing can answer and the rebuild cannot either: unknown is not zero.
  const snapshot = await reclaimOwnership({
    registry: { list: () => [fakeEntity({ sessionIds: ['s-new'], hidden: ['s-new'] })] },
    readHeaders: () => new Promise(() => {}),
    rebuildIndex: async () => ({ state: 'unsupported', headers: [] }),
    claimBudgetMs: 60,
  })
  check('unknown membership reports the degradation, not a count', snapshot.pending === 0 && typeof snapshot.degraded === 'string' && snapshot.degraded !== '', JSON.stringify({ pending: snapshot.pending, degraded: snapshot.degraded }))
  check('...and never claims two at once', snapshot.reclaimed === 0, String(snapshot.reclaimed))
}

{
  // The builder itself, driven directly: the index is replaced, never guessed at.
  const headers = [{ id: 's1', cwd: WORKSPACE }, { id: 's2', cwd: 'F:/local' }]
  const bag = {
    listed: 0,
    received: null,
    liveIndexed: 0,
    async listStoredHeaders () { this.listed += 1; return headers },
    async replaceHeaderIndex (rows) { this.received = rows },
    async indexLiveSessions () { this.liveIndexed += 1 },
  }
  const rebuilt = await makeIndexRebuilder(bag)()
  check('a rebuildable registry answers reindexed', rebuilt.state === 'reindexed', String(rebuilt.state))
  check('...after LISTING the stored headers', bag.listed === 1, String(bag.listed))
  check('...passing them straight through', JSON.stringify(bag.received) === JSON.stringify(headers), JSON.stringify(bag.received))
  check('...and re-indexing the live sessions the replacement dropped', bag.liveIndexed === 1, String(bag.liveIndexed))
  check('...while handing the headers back for the claims', JSON.stringify(rebuilt.headers) === JSON.stringify(headers), JSON.stringify(rebuilt.headers))
  check('no rebuild method means unsupported, not a guess', (await makeIndexRebuilder({ listStoredHeaders: async () => headers })()).state === 'unsupported')
  check(
    'an empty listing never wipes the index',
    (await makeIndexRebuilder({ listStoredHeaders: async () => [], replaceHeaderIndex: () => {} })()).state === 'empty',
  )
  check(
    'a registry that is not there is unsupported too',
    (await makeIndexRebuilder(undefined)()).state === 'unsupported',
  )
  check(
    'a failing listing is reported, not thrown',
    (await makeIndexRebuilder({ listStoredHeaders: async () => { throw Object.assign(new Error('gone'), { code: 'EBADF' }) }, replaceHeaderIndex: () => {} })()).state.startsWith('failed:'),
  )
}

// ---------------------------------------------------------------------------
console.log('\n[the repaired membership is announced, not left for a reload]')

{
  // The bug this covers was invisible by construction: the rebuild repaired the
  // INDEX while the client's workspace feed kept the empty list it received at
  // connect, so "the sessions are back" and "the sidebar shows nothing" were
  // both true at once. The feed re-reads the registry only on `domain/changed`.
  const events = []
  const entity = fakeEntity({ sessionIds: ['s-new', 's-old'], hidden: ['s-old'] })
  entity.id = 'w-1'
  entity.title = 'proj'
  entity.createdAt = '2026-01-01T00:00:00.000Z'
  entity.updatedAt = '2026-01-01T00:00:01.000Z'
  // NOT revealed: the raw record still holds an id the stale index refuses, which
  // is exactly the input that must not reach the wire.
  const announce = makeWorkspaceRepublisher({ emit: (name, payload) => events.push({ name, payload }) }, { list: () => [entity] })
  const announced = announce()
  check('the announcement runs once per workspace', announced.state === 'published' && announced.published === 1, JSON.stringify(announced))
  const event = events[0]
  check('...through the event the feed listens for', event?.name === 'domain/changed', String(event?.name))
  check(
    '...shaped like the Host emission',
    event?.payload?.domain === 'workspace' && event?.payload?.table === 'workspaces' && event?.payload?.operation === 'put',
    JSON.stringify(event?.payload),
  )
  check('...keyed by the workspace id as a string', event?.payload?.key === 'w-1', String(event?.payload?.key))
  check(
    '...carrying the FILTERED membership, never the raw record',
    JSON.stringify(event?.payload?.value?.sessionIds) === JSON.stringify(['s-new']),
    JSON.stringify(event?.payload?.value?.sessionIds),
  )
  check(
    '...and the fields the feed parses',
    typeof event?.payload?.value?.path === 'string' && typeof event?.payload?.value?.title === 'string' &&
    typeof event?.payload?.value?.createdAt === 'string' && typeof event?.payload?.value?.updatedAt === 'string',
    JSON.stringify(event?.payload?.value),
  )
  check('a context without emit is unsupported, not a throw', makeWorkspaceRepublisher({}, { list: () => [] })().state === 'unsupported')
  check('a registry without list is unsupported too', makeWorkspaceRepublisher({ emit () {} }, {})().state === 'unsupported')
  check(
    'a throttled event bus is reported with its cause',
    makeWorkspaceRepublisher({ emit () { throw Object.assign(new Error('bus closed'), { code: 'EBADF' }) } }, { list: () => [entity] })().state.includes('bus closed'),
  )
  check(
    'a registry that refuses to list is reported, not thrown',
    makeWorkspaceRepublisher({ emit () {} }, { list () { throw new Error('not started yet') } })().state.includes('not started'),
  )
}

{
  // Wiring: the pass announces ONLY after a rebuild that actually repaired the
  // index — an unsupported rebuild has nothing to announce, and a claim writes
  // its own table record, which the feed already observes.
  const entity = fakeEntity()
  const rebuilt = reindexer([entity])
  const announced = []
  const snapshot = await reclaimOwnership({
    registry: { list: () => [entity] },
    rebuildIndex: rebuilt.rebuildIndex,
    readHeaders: async () => ({ headers: SESSIONS }),
    republish: () => { announced.push(1); return { state: 'published', published: 3 } },
  })
  check('the announcement runs once after a successful rebuild', announced.length === 1, String(announced.length))
  check('...and its count lands in the snapshot', snapshot.published === 3, String(snapshot.published))
  check('...with no publish error reported', snapshot.publishError === null, String(snapshot.publishError))

  let called = 0
  const quiet = await reclaimOwnership({
    registry: { list: () => [fakeEntity({ sessionIds: ['s-new'], hidden: ['s-new'] })] },
    rebuildIndex: async () => ({ state: 'unsupported', headers: [] }),
    readHeaders: async () => ({ headers: SESSIONS }),
    republish: () => { called += 1; return { state: 'published', published: 0 } },
  })
  check('an unsupported rebuild announces nothing', called === 0, String(called))
  check('...and records no publish count', quiet.published === 0 && quiet.publishError === null, JSON.stringify({ published: quiet.published, publishError: quiet.publishError }))

  const broken = await reclaimOwnership({
    registry: { list: () => [fakeEntity()] },
    rebuildIndex: async () => ({ state: 'reindexed', headers: [] }),
    readHeaders: async () => ({ headers: [] }),
    republish: () => { throw new Error('bus closed') },
  })
  check(
    'a throwing announcement is reported, not fatal',
    broken.stage === 'done' && typeof broken.publishError === 'string' && broken.publishError.includes('bus closed'),
    JSON.stringify({ stage: broken.stage, publishError: broken.publishError }),
  )
}

// ---------------------------------------------------------------------------
console.log('\n[the wiring keeps the two phases in order]')

{
  const index = readFileSync(path.join(pluginRoot, 'lib', 'index.js'), 'utf8')
  const block = index.slice(index.indexOf("ctx.inject(['fs', 'workspaceRegistry']"), index.indexOf("ctx.inject(['fs', 'webServer']"))
  check('the registry injection owns the compensation', block.includes('reclaimOwnership('))
  check(
    'the compensation is AFTER the roots are mounted',
    block.indexOf('reclaimOwnership(') > block.indexOf('addRoot('),
    `addRoot at ${block.indexOf('addRoot(')} < reclaim at ${block.indexOf('reclaimOwnership(')}`,
  )
  check('it runs once per activation', /ownershipClaimStarted/u.test(block))
  check('the claim hands the registry to the lazy rebuild', block.includes('rebuildIndex: makeIndexRebuilder(registry)'), block.includes('makeIndexRebuilder(registry)') ? 'wired' : 'missing')
  check(
    '...and announces the repaired membership to connected clients',
    block.includes('republish: makeWorkspaceRepublisher(scoped, registry)'),
    block.includes('makeWorkspaceRepublisher(scoped') ? 'wired' : 'missing',
  )
  check('a failure cannot reject unhandled', /\.catch\(\(\) => \{\}\)/u.test(block))

  const tools = readFileSync(path.join(pluginRoot, 'lib', 'tools.js'), 'utf8')
  const schemaSource = readFileSync(path.join(pluginRoot, 'lib', 'status-schema.js'), 'utf8')
  check('the status tool declares the ownership object', schemaSource.includes('ownership: {') && !tools.includes('workspace-ownership'))
  check('...and emits it only when measured', tools.split('engine.ownership === undefined ? {} : {').length - 1 >= 2)
  check('the bundle input carries the snapshot', tools.includes('ownershipSnapshotCopy(engine.ownership)'))

  const routes = readFileSync(path.join(pluginRoot, 'lib', 'routes.js'), 'utf8')
  const diagnosisInput = routes.slice(routes.indexOf('const diagnosisInput = () => {'))
  check(
    'the panel\'s diagnosis reads the same snapshot',
    diagnosisInput.slice(0, 2000).includes('ownershipSnapshotCopy(engine.ownership)'),
  )
  const statusRoute = routes.slice(routes.indexOf('path: ROUTES.status'), routes.indexOf('selfCheck: ['))
  check(
    'the panel\'s /status route carries it too (it used to be tool-only)',
    statusRoute.includes('ownershipSnapshotCopy(engine.ownership)'),
  )
  check(
    '...so the route and the diagnosis cannot read different fields',
    routes.split('ownershipSnapshotCopy(engine.ownership)').length - 1 >= 2,
    String(routes.split('ownershipSnapshotCopy(engine.ownership)').length - 1),
  )
}


/**
 * The `ownership` block of the status tool's declared output schema, read out
 * of the source: the declared property names and the ones marked required.
 * Parsed rather than imported because the schema is a literal inside the tool
 * definition, and a test that restated the list would not catch the drift this
 * section exists for.
 */
function readOwnershipSchema (source) {
  // Normalised before matching: the literal below spans lines, and a checkout
  // with CRLF line endings made `indexOf` return -1 — a red suite that said
  // nothing about the code. `.gitattributes` pins the checkout to LF, but this
  // comparison must not depend on that promise holding on someone else's
  // machine.
  const marker = "ownership: {\n"
  const at = source.indexOf(marker)
  if (at === -1) return null
  let depth = 0
  let index = at
  while (index < source.length) {
    const ch = source[index]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) break
    }
    index += 1
  }
  const block = source.slice(at, index + 1)
  // The field list lives under `properties`, and that key's own indentation
  // decides where its children sit. This used to be a hard-coded 14 because the
  // schema lived inside `statusTool`; moving the schema into
  // `lib/status-schema.js` changed the nesting without changing the meaning,
  // and a number baked into the assertion would have called that a regression.
  const propertiesLine = /^(\s*)properties: \{$/mu.exec(block)
  if (propertiesLine === null) return null
  const childIndent = propertiesLine[1].length + 2
  const all = []
  const required = []
  let current = null
  for (const line of block.split('\n')) {
    const indent = line.length - line.trimStart().length
    const opened = indent === childIndent ? /^(\w+): \{/u.exec(line.trim()) : null
    if (opened !== null) {
      current = opened[1]
      all.push(current)
      continue
    }
    if (current !== null && /required: true/u.test(line)) required.push(current)
  }
  return { all, required }
}

console.log('\n[the returned copy cannot drift from the declared schema]')

{
  // The failure this guards is not hypothetical: `stage` and `updatedAt` were
  // added to the snapshot AND to the Host schema, while the status result
  // returned the snapshot through a hand-written FIELD BY FIELD copy. The copy
  // shipped without the two new fields, so the Host rejected the WHOLE status
  // result (`missing required property value.ownership.updatedAt`, then
  // `...stage`) and every status surface, panel included, read it as null.
  const tools = readFileSync(path.join(pluginRoot, 'lib', 'tools.js'), 'utf8').replace(/\r\n/gu, '\n')
  const routes = readFileSync(path.join(pluginRoot, 'lib', 'routes.js'), 'utf8').replace(/\r\n/gu, '\n')
  const schemaSource = readFileSync(path.join(pluginRoot, 'lib', 'status-schema.js'), 'utf8').replace(/\r\n/gu, '\n')

  const toolSites = tools.split('ownershipSnapshotCopy(engine.ownership)').length - 1
  check('every status surface returns a structural copy', toolSites === 2 && routes.includes('ownershipSnapshotCopy(engine.ownership)'), `${toolSites} tool site(s)`)
  check(
    'no surface re-lists the snapshot fields by hand',
    !/engine\.ownership\.updatedAt/u.test(tools) && !/engine\.ownership\.scanned/u.test(tools) && !/engine\.ownership\.at \?\?/u.test(tools),
  )

  const schema = readOwnershipSchema(schemaSource)
  check('the ownership schema block parses', schema !== null && schema.all.length >= 8, schema === null ? 'not found' : `${schema.all.length} properties`)
  const snapshotKeys = Object.keys(emptyOwnershipSnapshot(() => 0))
  const absent = schema.required.filter(name => !snapshotKeys.includes(name))
  check('every REQUIRED field exists on the snapshot', absent.length === 0, `missing: ${absent.join(', ') || '-'}`)
  const undeclared = snapshotKeys.filter(name => !schema.all.includes(name))
  check('the snapshot carries no undeclared field', undeclared.length === 0, `extra: ${undeclared.join(', ') || '-'}`)
  check(
    'the two fields this bug dropped are declared and present',
    schema.all.includes('stage') && schema.all.includes('updatedAt') && snapshotKeys.includes('stage') && snapshotKeys.includes('updatedAt'),
  )

  // Structural copies make "add a field to the snapshot" a one-line change
  // again: nothing enumerates the members.
  const sample = { ...emptyOwnershipSnapshot(() => 0), futureField: { nested: 1 } }
  const copy = ownershipSnapshotCopy(sample)
  check('a field the code never listed survives the copy', copy.futureField.nested === 1)
  check('the copy is detached from the live snapshot', copy.failures !== sample.failures && copy.skipped !== sample.skipped)
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
process.exit(failures === 0 ? 0 : 1)
