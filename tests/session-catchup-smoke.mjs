/**
 * The browser half of the ownership repair: one session-list re-pull.
 *
 * ## The failure this suite exists for
 *
 * With the plugin disabled across a DSH restart, the Host indexes the session
 * table without the `ssh://` roots mounted, so every remote session fails its
 * `realpath` and drops out of its workspace's membership. Re-enabling the plugin
 * repairs that: `lib/ownership.js` rebuilds the Host index and re-announces each
 * workspace, and the sidebar groups come back.
 *
 * They come back EMPTY. The groups are a follow stream, so an announcement
 * reaches them; the ROWS inside them come from a single `session.list` pull the
 * page took when it connected, before the repair. Nothing re-pulls that list, so
 * the page keeps showing the pre-repair one until it is reloaded — which is why
 * restarting DSH appeared to fix it.
 *
 * The Host cannot push the difference: it forwards `api-session/added` for LIVE
 * sessions only, and these are cold. So the browser half has to notice the
 * finished pass and ask for one fresh baseline itself.
 *
 * ## What is asserted, and why each part earns its place
 *
 *  - the trigger reads a FINISHED pass only: `stage` is rewritten while the pass
 *    runs, and pulling on a snapshot that merely happens to be there would spend
 *    a request on a verdict that does not exist yet;
 *  - the pull is not fired blindly at every activation: it needs evidence that
 *    the index this page's list was built against actually changed;
 *  - the pull is VERIFIED. `sessions.refresh()` is single-flight, so it can hand
 *    back a pull that was already in the air — one taken before the repair —
 *    and it can fail. Only a re-pull that leaves the groups still unanswered
 *    buys another attempt, and only up to a bound;
 *  - the whole thing is bounded and disposable. It is a convenience over F5, so
 *    an absent service, a down status route, a failing listing, or a pass that
 *    never finishes must end quietly instead of polling for the life of the
 *    page, and `apply`'s disposer must stop it.
 *
 * The section is lifted out of the shipped bundle and driven against fakes for
 * the timer, the status route, the session store and the workspace store. A
 * restatement of the logic here would pass while the bundle was broken.
 *
 * Run: node tests/session-catchup-smoke.mjs
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createHost } from './support/plugin-host.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

let passed = 0
const failures = []
function check (name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== session catch-up smoke ===\n')

/**
 * The catch-up section, dedented and evaluated, with its four free names
 * injected so the suite can drive them.
 *
 * The free names are the point of the extraction: `fetchJson` is the status
 * route, `API.status` is its address, `setTimeout`/`clearTimeout` are the clock,
 * and `Date` is the deadline's source. Everything else in the block refers only
 * to its own constants, which is what makes the behaviour testable at all.
 *
 * @param {object} deps - `{ fetchJson, API, clock }`.
 * @returns {object} the exported helpers and the catch-up factory.
 */
function liftCatchUp (deps) {
  const start = source.indexOf('    // Session list catch-up (one re-pull after a repair)')
  const end = source.indexOf('    // Plugin apply')
  if (start === -1 || end === -1 || end <= start) throw new Error('the catch-up section is not where the map says it is')
  const block = source
    .slice(start, end)
    .split('\n')
    .map(line => (line.startsWith('    ') ? line.slice(4) : line))
    .join('\n')
  const factory = new Function(
    'fetchJson', 'API', 'setTimeout', 'clearTimeout', 'Date',
    `${block}
return { CATCH_UP_FIRST_MS, CATCH_UP_MAX_MS, CATCH_UP_SETTLE_MS, CATCH_UP_ATTEMPTS, CATCH_UP_DEADLINE_MS,
         needsSessionRelist, relistSessions, missingGroupedSessions, createSessionCatchUp }`,
  )
  const clock = deps.clock
  const helpers = factory(deps.fetchJson, deps.API, clock.setTimeout, clock.clearTimeout, clock.Date)
  helpers.block = block
  return helpers
}

/** A timer queue that only advances when the test says so. */
function makeClock (start = 1_700_000_000_000) {
  let now = start
  let nextId = 1
  const pending = new Map()
  const clock = {
    Date: { now: () => now },
    setTimeout: (run, ms) => {
      const id = nextId++
      pending.set(id, { run, at: now + Math.max(0, Number(ms) || 0) })
      return id
    },
    clearTimeout: (id) => { pending.delete(id) },
    /** Move time forward, firing every timer that comes due, oldest first. */
    advance: (ms) => {
      const target = now + ms
      for (;;) {
        let dueId = null
        let due = null
        for (const [id, timer] of pending) {
          if (timer.at > target) continue
          if (due === null || timer.at < due.at || (timer.at === due.at && id < dueId)) {
            due = timer
            dueId = id
          }
        }
        if (due === null) break
        pending.delete(dueId)
        now = due.at
        due.run()
      }
      now = target
    },
    /** Timers still armed: the proof that the catch-up ended rather than idled. */
    armed: () => pending.size,
    now: () => now,
  }
  return clock
}

/** Let every microtask queued so far settle. */
const flushMicrotasks = () => new Promise(resolve => setImmediate(resolve))

// ---------------------------------------------------------------------------
console.log('\n[what counts as a finished repair]')

{
  const clock = makeClock()
  const { needsSessionRelist } = liftCatchUp({ clock, API: { status: '/s' }, fetchJson: async () => ({}) })

  const base = { at: 1, updatedAt: 1, scanned: 3, reclaimed: 0, pending: 0, indexRebuilt: null, published: 0, publishError: null, skipped: [], degraded: null, failures: [] }

  check('nothing to say yet is not a verdict', needsSessionRelist(null) === false)
  check('undefined is not a verdict', needsSessionRelist(undefined) === false)
  check('a non-object is not a verdict', needsSessionRelist('done') === false)

  for (const stage of ['listing', 'rebuilding', 'claiming']) {
    check(`"${stage}" buys nothing: the pass has not finished`, needsSessionRelist({ ...base, stage, indexRebuilt: 'reindexed' }) === false)
  }

  check('a finished pass that changed nothing buys nothing',
    needsSessionRelist({ ...base, stage: 'done', indexRebuilt: 'skipped' }) === false)
  check('a failed rebuild with nothing to re-attach buys nothing',
    needsSessionRelist({ ...base, stage: 'done', indexRebuilt: 'failed: ENOENT' }) === false)

  check('a rebuilt index is the reason the list must be re-read',
    needsSessionRelist({ ...base, stage: 'done', indexRebuilt: 'reindexed' }) === true)
  check('re-attached rows are a reason too',
    needsSessionRelist({ ...base, stage: 'done', indexRebuilt: 'skipped', reclaimed: 2 }) === true)
  check('a re-announced membership is a reason too',
    needsSessionRelist({ ...base, stage: 'done', indexRebuilt: 'unsupported', published: 12 }) === true)
  check('a numeric string counts, because the wire may spell it that way',
    needsSessionRelist({ ...base, stage: 'done', reclaimed: '3' }) === true)
}

// ---------------------------------------------------------------------------
console.log('\n[the re-pull itself]')

{
  const clock = makeClock()
  const { relistSessions } = liftCatchUp({ clock, API: { status: '/s' }, fetchJson: async () => ({}) })

  let calls = 0
  const asked = relistSessions({ get: () => ({ refresh: () => { calls += 1; return Promise.resolve() } }) })
  check('the store is asked exactly once', calls === 1 && asked === true, `${calls} call(s)`)

  check('a host without the service is reported as "not asked"',
    relistSessions({ get: () => undefined }) === false)
  check('a store without refresh is reported as "not asked"',
    relistSessions({ get: () => ({}) }) === false)
  check('a context that cannot answer is not an exception',
    relistSessions({ get: () => { throw new Error('no such service') } }) === false)
  check('...including a missing context',
    relistSessions(undefined) === false)

  // The rejection has to be drained here: this runs outside any render, so an
  // unhandled rejection would reach the page console for a failed convenience
  // pull that the store already reports through its own `phase`.
  let drained = 0
  const rejected = relistSessions({
    get: () => ({ refresh: () => ({ then: (ok, fail) => { drained += 1; check('...with a rejection handler of its own', typeof fail === 'function'); fail(new Error('listing failed')); return undefined } }) }),
  })
  check('a failing pull is still reported as requested', rejected === true && drained === 1, `drained ${drained}`)

  check('a synchronous refresh that throws cannot escape',
    relistSessions({ get: () => ({ refresh: () => { throw new Error('boom') } }) }) === false)
  check('a refresh returning a non-promise is left alone',
    relistSessions({ get: () => ({ refresh: () => 42 }) }) === true)
}

// ---------------------------------------------------------------------------
console.log('\n[what the pull still cannot answer]')

{
  const clock = makeClock()
  const { missingGroupedSessions } = liftCatchUp({ clock, API: { status: '/s' }, fetchJson: async () => ({}) })

  /** A context whose two stores answer with the given snapshots. */
  const ctxWith = (sessions, workspaces) => createHost({
    services: { sessions, workspaces },
  }).ctx
  const remote = (sessionIds) => ({ items: [{ workspaceId: 'w1', path: 'ssh://host/srv/proj', sessionIds }] })

  check('a claimed id with no summary is a miss',
    missingGroupedSessions(ctxWith(
      { phase: 'ready', byId: { a: {} }, list: { getSnapshot: () => ({ phase: 'ready', byId: { a: {} } }) } },
      { list: { getSnapshot: () => remote(['a', 'b', 'c']) } },
    )) === 2)
  check('a fully answered group is a zero',
    missingGroupedSessions(ctxWith(
      { list: { getSnapshot: () => ({ phase: 'ready', byId: { a: {}, b: {} } }) } },
      { list: { getSnapshot: () => remote(['a', 'b']) } },
    )) === 0)
  check('a list that has not pulled yet proves nothing',
    missingGroupedSessions(ctxWith(
      { list: { getSnapshot: () => ({ phase: 'pending', byId: {} }) } },
      { list: { getSnapshot: () => remote(['a']) } },
    )) === 0)
  check('a LOCAL workspace is none of this repair\'s business',
    missingGroupedSessions(ctxWith(
      { list: { getSnapshot: () => ({ phase: 'ready', byId: {} }) } },
      { list: { getSnapshot: () => ({ items: [{ workspaceId: 'w2', path: 'F:/GitHub/proj', sessionIds: ['x'] }] }) } },
    )) === 0)
  check('an unreadable workspace store is a zero, not a poll forever',
    missingGroupedSessions(ctxWith(
      { list: { getSnapshot: () => ({ phase: 'ready', byId: {} }) } },
      { list: { getSnapshot: () => ({ items: null }) } },
    )) === 0)
  check('...including one that throws',
    missingGroupedSessions(ctxWith(
      { list: { getSnapshot: () => ({ phase: 'ready', byId: {} }) } },
      { get: () => undefined },
    )) === 0)
  check('a blank or non-string id is not counted',
    missingGroupedSessions(ctxWith(
      { list: { getSnapshot: () => ({ phase: 'ready', byId: {} }) } },
      { list: { getSnapshot: () => ({ items: [{ workspaceId: 'w1', path: 'ssh://h/srv', sessionIds: ['', null, 7] }] }) } },
    )) === 0)
  check('an inherited Object property is not a session',
    missingGroupedSessions(ctxWith(
      { list: { getSnapshot: () => ({ phase: 'ready', byId: {} }) } },
      { list: { getSnapshot: () => ({ items: [{ workspaceId: 'w1', path: 'ssh://h/srv', sessionIds: ['toString'] }] }) } },
    )) === 1)
}

// ---------------------------------------------------------------------------
console.log('\n[the watch: one pull, then leave]')

/** Build a catch-up wired to a scripted status route and a counting session store. */
function makeWatch ({ statuses, missing = () => 0, sessions = {} } = {}) {
  const clock = makeClock()
  const requests = []
  const pulls = []
  const queue = [...statuses]
  const helpers = liftCatchUp({
    clock,
    API: { status: '/api/dsh-ssh-workspace/status' },
    fetchJson: async (url) => {
      requests.push(url)
      const next = queue.length > 1 ? queue.shift() : queue[0]
      if (typeof next === 'function') return next()
      if (next instanceof Error) throw next
      return next
    },
  })
  const ctx = createHost({
    services: {
      sessions: {
        list: { getSnapshot: () => ({ phase: 'ready', byId: {} }) },
        refresh: () => {
          pulls.push({ at: clock.now() })
          return Promise.resolve()
        },
      },
      workspaces: {
        list: {
          getSnapshot: () => ({
            items: [{ workspaceId: 'w1', path: 'ssh://h/srv/proj', sessionIds: Array.from({ length: missing() }, (_, index) => `s${index}`) }],
          }),
        },
      },
    },
  }).ctx
  const watch = helpers.createSessionCatchUp(ctx)
  return { ...helpers, watch, clock, requests, pulls }
}

const DONE = { ownership: { stage: 'done', indexRebuilt: 'reindexed', reclaimed: 0, published: 12 } }
const RUNNING = (stage) => ({ ownership: { stage, indexRebuilt: null, reclaimed: 0, published: 0 } })

{
  const { watch, clock, requests, pulls, CATCH_UP_FIRST_MS } = makeWatch({ statuses: [DONE] })
  check('nothing is fetched before start', requests.length === 0 && pulls.length === 0)
  watch.start()
  check('...still nothing in the same tick', requests.length === 0)
  clock.advance(CATCH_UP_FIRST_MS)
  await flushMicrotasks()
  check('the first look happens after the page has settled', requests.length === 1, `${requests.length} request(s)`)
  check('...and it reads the status route, not something else', requests[0] === '/api/dsh-ssh-workspace/status', String(requests[0]))
  check('...a finished repair buys exactly one pull', pulls.length === 1, `${pulls.length} pull(s)`)
  watch.stop()
}

{
  // The pass is still running: the watch has to wait for a verdict instead of
  // pulling on a snapshot that cannot have one yet.
  const { watch, clock, requests, pulls, CATCH_UP_FIRST_MS, CATCH_UP_MAX_MS } = makeWatch({
    statuses: [RUNNING('listing'), RUNNING('rebuilding'), DONE],
  })
  watch.start()
  clock.advance(CATCH_UP_FIRST_MS)
  await flushMicrotasks()
  check('a running pass does not pull', pulls.length === 0, `${pulls.length} pull(s)`)
  // Backoff: the second look is later than the first interval.
  clock.advance(CATCH_UP_FIRST_MS)
  await flushMicrotasks()
  check('...it keeps looking', requests.length === 1, `${requests.length} request(s)`)
  // Each look is followed by an await, so the next timer is only armed once the
  // microtask queue has drained. Walk the clock in steps until the queue reports
  // the finished pass, with a bound so a stuck watch fails here instead of hanging.
  let looks = requests.length
  for (let step = 0; step < 12 && pulls.length === 0; step += 1) {
    clock.advance(CATCH_UP_MAX_MS)
    await flushMicrotasks()
    looks += 1
  }
  check('...until the pass finishes', requests.length >= 2, `${requests.length} request(s) after ${looks} look(s)`)
  check('...and then pulls', pulls.length === 1, `${pulls.length} pull(s)`)
  watch.stop()
}

{
  // The pull is verified: as long as the groups are still unanswered it tries
  // again, and it stops at the bound instead of running forever.
  const { watch, clock, pulls, CATCH_UP_FIRST_MS, CATCH_UP_SETTLE_MS, CATCH_UP_ATTEMPTS } = makeWatch({
    statuses: [DONE],
    missing: () => 3,
  })
  watch.start()
  clock.advance(CATCH_UP_FIRST_MS)
  await flushMicrotasks()
  check('the first pull happens on the verdict', pulls.length === 1, `${pulls.length} pull(s)`)
  for (let index = 1; index < CATCH_UP_ATTEMPTS; index += 1) {
    clock.advance(CATCH_UP_SETTLE_MS + 1)
    await flushMicrotasks()
  }
  check(`retries stop at the bound (${CATCH_UP_ATTEMPTS} pulls)`, pulls.length === CATCH_UP_ATTEMPTS, `${pulls.length} pull(s)`)
  clock.advance(CATCH_UP_SETTLE_MS + 1)
  await flushMicrotasks()
  check('...and the bound is a bound, not a pause', pulls.length === CATCH_UP_ATTEMPTS, `${pulls.length} pull(s)`)
  check('a finished watch leaves no timer armed', clock.armed() === 0, `${clock.armed()} armed`)
  watch.stop()
}

{
  // A pull that answers the question ends the watch without a second request.
  let remaining = 2
  const { watch, clock, pulls, CATCH_UP_FIRST_MS, CATCH_UP_SETTLE_MS } = makeWatch({
    statuses: [DONE],
    missing: () => remaining,
  })
  watch.start()
  clock.advance(CATCH_UP_FIRST_MS)
  await flushMicrotasks()
  remaining = 0
  clock.advance(CATCH_UP_SETTLE_MS + 1)
  await flushMicrotasks()
  check('a pull that fills the groups ends the watch', pulls.length === 1, `${pulls.length} pull(s)`)
  check('...with nothing left running', clock.armed() === 0, `${clock.armed()} armed`)
  watch.stop()
}

{
  // A status route that is down must not abort the watch: the pass may simply
  // not have started. It must also not run past the deadline.
  const { watch, clock, requests, pulls, CATCH_UP_FIRST_MS, CATCH_UP_MAX_MS, CATCH_UP_DEADLINE_MS } = makeWatch({
    statuses: [new Error('502')],
  })
  watch.start()
  clock.advance(CATCH_UP_FIRST_MS)
  await flushMicrotasks()
  check('a failing status route is not an exception', pulls.length === 0)
  clock.advance(CATCH_UP_MAX_MS * 4)
  await flushMicrotasks()
  check('...it keeps looking', requests.length >= 2, `${requests.length} request(s)`)
  clock.advance(CATCH_UP_DEADLINE_MS)
  await flushMicrotasks()
  check('...and gives up at the deadline', clock.armed() === 0, `${clock.armed()} armed`)
  const atDeadline = requests.length
  clock.advance(60_000)
  await flushMicrotasks()
  check('...for good', requests.length === atDeadline, `${requests.length} request(s)`)
  watch.stop()
}

{
  // The disposer is what keeps a disabled plugin from fetching, so it has to
  // cancel the timer that is armed at that moment.
  const { watch, clock, requests, CATCH_UP_FIRST_MS } = makeWatch({
    statuses: [RUNNING('listing'), DONE],
  })
  watch.start()
  clock.advance(CATCH_UP_FIRST_MS)
  await flushMicrotasks()
  const seen = requests.length
  watch.stop()
  check('stop() disarms the pending look', clock.armed() === 0, `${clock.armed()} armed`)
  clock.advance(10 * CATCH_UP_FIRST_MS)
  await flushMicrotasks()
  check('...and nothing fires afterwards', requests.length === seen, `${requests.length} request(s)`)
}

{
  // Re-entering apply must not stack a second watch, and a stopped instance
  // must not silently restart. Both are about the same latch.
  const { watch, clock, requests, CATCH_UP_FIRST_MS } = makeWatch({ statuses: [DONE] })
  watch.start()
  watch.start()
  clock.advance(CATCH_UP_FIRST_MS)
  await flushMicrotasks()
  check('a second start() is a no-op', requests.length === 1, `${requests.length} request(s)`)
  watch.stop()
  watch.start()
  clock.advance(10 * CATCH_UP_FIRST_MS)
  await flushMicrotasks()
  check('...and a stopped watch cannot be restarted', requests.length === 1, `${requests.length} request(s)`)
}

// ---------------------------------------------------------------------------
console.log('\n[the wiring]')

{
  // Lifted out of the bundle so a "helper that nobody calls" cannot read as
  // implemented: the factory has to be constructed in apply and stopped by the
  // disposer apply returns.
  const applied = /const sessionCatchUp = createSessionCatchUp\(ctx\)\n\s+sessionCatchUp\.start\(\)/u.test(source)
  check('apply constructs and starts one catch-up', applied)
  const disposed = /sessionCatchUp\.stop\(\)/u.test(source)
  check('...and the disposer stops it', disposed)
  const order = source.indexOf('const sessionCatchUp = createSessionCatchUp(ctx)')
  const returned = source.indexOf('sessionCatchUp.stop()')
  check('...in the teardown, after the construction', order !== -1 && returned > order, `${order} -> ${returned}`)

  // One route, one service. The catch-up may read /status (it is the only place
  // the pass reports itself) but it must reach the sessions through the Host's
  // own store: a hand-rolled `session.list` request would carry no single-flight
  // guard, no error state, and no relationship to the store the sidebar reads.
  const lifted = liftCatchUp({ clock: makeClock(), API: { status: '/s' }, fetchJson: async () => ({}) })
  const calls = [...lifted.block.matchAll(/fetchJson\(/gu)].length
  check('the catch-up makes exactly one kind of request', calls === 1, `${calls} call(s)`)
  check('...and it is the status route', /fetchJson\(API\.status\)/u.test(lifted.block))
  // Comments in the section explain WHY the Host store is used and name
  // `session.list` while doing it, so the "no hand-rolled request" question has
  // to be asked of the code, not of the prose around it.
  const code = lifted.block.split('\n').map(line => line.replace(/\/\/.*$/u, '')).join('\n')
  check('the re-pull goes through the Host session store',
    /sessions\?\.refresh/u.test(code) && !/session\.list/u.test(code), code.match(/session\.list/u)?.[0] ?? 'none')
}

if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
console.log(`\n=== ${passed} passed, ${failures.length} failed ===`)
process.exit(failures.length === 0 ? 0 : 1)
