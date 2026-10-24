/**
 * Background reconnect: the policy, not the socket.
 *
 * The feature exists for a specific failure the one-shot retry cannot cover: a
 * connection dies while NOBODY is operating on it (lid closed, Wi-Fi switched,
 * VPN dropped). Recovery then depends on the next operation, which for a
 * workspace being looked at but not typed into may never come.
 *
 * What is asserted here is the part that decides whether that is an improvement
 * or a regression — a retry loop is easy to write and easy to make harmful:
 *
 *  - it must NOT run for a host nothing wants (an idle pooled socket), or every
 *    network blip becomes a background dialer;
 *  - it must stop when the last consumer goes away, not keep retrying a
 *    workspace the user closed;
 *  - it must be cancellable, because "disconnect" written as "keep dialing" is
 *    the exact opposite of what the button says;
 *  - a non-retryable failure (bad key, unknown alias) must end the ladder
 *    instead of failing identically every 60s forever;
 *  - it must not grow without bound or mutate state a caller can corrupt.
 *
 * Time, randomness and timers are injected so a suite can drive minutes of
 * backoff instantly and deterministically.
 *
 * Run: node tests/reconnect-smoke.mjs
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { ReconnectScheduler, RECONNECT_DEFAULTS } = await import(
  pathToFileURL(path.join(pluginRoot, 'lib', 'reconnect.js')).href
)
const { Diagnostics, KINDS } = await import(
  pathToFileURL(path.join(pluginRoot, 'lib', 'diagnostics.js')).href
)

let passed = 0
const failures = []
function check (label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  PASS  ${label}`)
  } else {
    failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== reconnect smoke ===\n')

// ---------------------------------------------------------------- fake clock
/**
 * A deterministic clock/timer pair.
 *
 * `advance()` runs every timer due within the window, in order, including ones
 * armed by the callbacks it fires — which is how a real ladder behaves and how a
 * suite can assert "attempt 5 happens at 16s" without sleeping.
 */
function makeClock () {
  let now = 0
  let nextId = 1
  const timers = new Map()
  return {
    now: () => now,
    setTimeout: (fn, delay) => {
      const id = nextId
      nextId += 1
      timers.set(id, { fn, at: now + Math.max(0, delay) })
      return { id, unref () {} }
    },
    clearTimeout: (handle) => { timers.delete(handle.id) },
    advance: async (ms) => {
      const target = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)
        if (due.length === 0) break
        const [id, timer] = due[0]
        timers.delete(id)
        now = timer.at
        timer.fn()
        // Let the attempt promise (and the re-arm it schedules) settle before
        // the next timer is picked up. A fixed number of `Promise.resolve()`
        // turns is not enough: an `async` attempt adds a turn of its own, and
        // getting the count wrong silently stops the ladder after one attempt.
        await new Promise(resolve => setImmediate(resolve))
      }
      now = target
    },
    pending: () => timers.size,
  }
}

/** A scheduler over a fake clock whose attempts are scripted. */
function makeScheduler (options = {}) {
  const clock = makeClock()
  const calls = []
  const diagnostics = new Diagnostics(50)
  let outcome = options.outcome ?? 'ok'
  const scheduler = new ReconnectScheduler({
    attempt: async (alias) => {
      calls.push(alias)
      if (typeof outcome === 'function') return await outcome(alias, calls.length)
      if (outcome === 'fail') throw new Error('EHOSTUNREACH: no route to host')
      return { alias }
    },
    isWanted: options.isWanted ?? (() => true),
    diagnostics,
    tuning: { baseDelayMs: 1000, maxDelayMs: 8000, jitter: 0, ...(options.tuning ?? {}) },
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    ...(options.onRestored === undefined ? {} : { onRestored: options.onRestored }),
  })
  return { scheduler, clock, calls, diagnostics, setOutcome: (value) => { outcome = value } }
}

// ------------------------------------------------------------------- ladder
console.log('[backoff ladder]')

{
  const { scheduler } = makeScheduler()
  const delays = [1, 2, 3, 4, 5, 6].map(attempt => scheduler.delayFor(attempt))
  check('delay doubles from the base', delays[0] === 1000 && delays[1] === 2000 && delays[2] === 4000, JSON.stringify(delays))
  check('delay is capped at maxDelayMs', delays[5] === 8000, JSON.stringify(delays))
  check('every delay is a positive integer', delays.every(d => Number.isInteger(d) && d > 0), JSON.stringify(delays))
  scheduler.dispose()
}

{
  // Jitter must shave time off, never add it: a "60s cap" that sometimes waits
  // 72s is not a cap, and a user watching a countdown would see it grow.
  const clock = makeClock()
  const scheduler = new ReconnectScheduler({
    attempt: async () => ({}),
    tuning: { baseDelayMs: 60_000, maxDelayMs: 60_000, jitter: 1 },
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    random: () => 0.99,
  })
  check('jitter never exceeds the ceiling', scheduler.delayFor(1) <= 60_000, String(scheduler.delayFor(1)))
  check('full jitter can reach near zero', scheduler.delayFor(1) < 60_000, String(scheduler.delayFor(1)))
  scheduler.dispose()
}

// ------------------------------------------------------- starts / stops
console.log('\n[starts only while wanted]')

{
  const { scheduler, clock, calls } = makeScheduler({ isWanted: () => false })
  const started = scheduler.noteLost('box', 'transport lost')
  check('nothing wanted means no retry loop', started === false, String(started))
  check('no timer was armed', clock.pending() === 0, String(clock.pending()))
  check('no attempt was made', calls.length === 0, JSON.stringify(calls))
  scheduler.dispose()
}

{
  const { scheduler, clock, calls } = makeScheduler()
  check('a wanted host arms a retry', scheduler.noteLost('box', 'transport lost') === true)
  check('an entry is exposed immediately', scheduler.stateOf('box')?.phase === 'waiting', JSON.stringify(scheduler.stateOf('box')))
  check('a second noteLost does not stack a timer', scheduler.noteLost('box', 'again') === false && clock.pending() === 1)
  await clock.advance(1000)
  check('the first attempt fires after the base delay', calls.length === 1 && calls[0] === 'box', JSON.stringify(calls))
  scheduler.dispose()
}

{
  // The important stop rule: the last mounted root is unmounted while the loop
  // is waiting. Retrying then would dial a host the user just closed.
  let wanted = true
  const { scheduler, clock, calls, diagnostics } = makeScheduler({ outcome: 'fail', isWanted: () => wanted })
  scheduler.noteLost('box', 'transport lost')
  await clock.advance(1000)
  check('a failed attempt keeps the loop alive', scheduler.stateOf('box')?.phase === 'waiting', JSON.stringify(scheduler.stateOf('box')))
  wanted = false
  await clock.advance(2000)
  const state = scheduler.stateOf('box')
  check('losing the last consumer stops the loop', state?.phase === 'gave-up', JSON.stringify(state))
  check('and says so in the diagnostics ring', diagnostics.list().some(e => e.kind === KINDS.degraded && e.message.includes('needs the connection')), JSON.stringify(diagnostics.list().slice(-2)))
  const before = calls.length
  await clock.advance(60_000)
  check('no further attempts after it stopped', calls.length === before, `${before} → ${calls.length}`)
  scheduler.dispose()
}

// ------------------------------------------------------------------- retries
console.log('\n[attempt counting and recovery]')

{
  const { scheduler, clock, calls, diagnostics } = makeScheduler({ outcome: 'fail' })
  scheduler.noteLost('box', 'transport lost')
  await clock.advance(1000 + 2000 + 4000 + 8000 + 8000)
  check('the ladder grows: 5 attempts inside 23s', calls.length === 5, JSON.stringify(calls))
  check('the cap holds: the 6th attempt is armed, not fired', scheduler.stateOf('box')?.phase === 'waiting')
  check('attempt numbers are reported', scheduler.stateOf('box')?.attempts === 6, JSON.stringify(scheduler.stateOf('box')))
  check('the last error is surfaced', scheduler.stateOf('box')?.lastError.includes('EHOSTUNREACH'), String(scheduler.stateOf('box')?.lastError))
  check('the failure is recorded in the ring', diagnostics.list().some(e => e.kind === KINDS.reconnect), 'no reconnect event')
  scheduler.dispose()
}

{
  const { scheduler, clock, diagnostics } = makeScheduler()
  let restored = 0
  scheduler.onRestored = () => { restored += 1 }
  scheduler.noteLost('box', 'transport lost')
  await clock.advance(1000)
  check('a successful attempt clears the entry', scheduler.stateOf('box') === undefined, JSON.stringify(scheduler.stateOf('box')))
  check('recovery is recorded', diagnostics.list().some(e => e.kind === KINDS.reconnect && e.message.includes('reconnected')), 'no reconnected event')
  check('the restore hook fires once', restored === 1, String(restored))
  check('nothing is left armed', clock.pending() === 0, String(clock.pending()))
  scheduler.dispose()
}

// ------------------------------------------------------------------- limits
console.log('\n[bounded ladders and fatal errors]')

{
  const { scheduler, clock, calls } = makeScheduler({ outcome: 'fail', tuning: { maxAttempts: 3 } })
  scheduler.noteLost('box', 'transport lost')
  await clock.advance(1000 + 2000 + 4000 + 60_000)
  check('a bounded ladder stops after maxAttempts', calls.length === 3, JSON.stringify(calls))
  check('the entry reports gave-up', scheduler.stateOf('box')?.phase === 'gave-up', JSON.stringify(scheduler.stateOf('box')))
  scheduler.dispose()
}

{
  // An unknown alias or an unreadable key fails identically forever; waiting
  // cannot fix it, and a per-minute attempt would bury the useful events.
  const fatal = Object.assign(new Error('private key not found at "C:/nope"'), { fatal: true })
  const { scheduler, clock, calls } = makeScheduler({ outcome: () => { throw fatal } })
  scheduler.noteLost('box', 'transport lost')
  await clock.advance(1000 + 2000 + 4000 + 60_000)
  check('a fatal failure stops after the first attempt', calls.length === 1, JSON.stringify(calls))
  check('the entry reports gave-up', scheduler.stateOf('box')?.phase === 'gave-up', JSON.stringify(scheduler.stateOf('box')))
  check('the reason is the descriptor error', scheduler.stateOf('box')?.lastError.includes('private key'), String(scheduler.stateOf('box')?.lastError))
  scheduler.dispose()
}

// ------------------------------------------------------------------ manual
console.log('\n[manual retry and cancellation]')

{
  const { scheduler, clock, calls } = makeScheduler({ outcome: 'fail', tuning: { baseDelayMs: 60_000, maxDelayMs: 60_000 } })
  scheduler.noteLost('box', 'transport lost')
  check('a wait is armed', scheduler.stateOf('box')?.phase === 'waiting' && scheduler.stateOf('box')?.attempts === 1)
  // A user fixes the network and clicks retry: it must not wait out the 60s.
  const before = calls.length
  const result = await scheduler.retryNow('box')
  check('manual retry attempts immediately', calls.length === before + 1, `${before} → ${calls.length}`)
  check('manual retry reports its failure', result.ok === false && result.error.includes('EHOSTUNREACH'), JSON.stringify(result))
  check('a failed manual retry re-arms the loop', scheduler.stateOf('box')?.phase === 'waiting', JSON.stringify(scheduler.stateOf('box')))
  scheduler.dispose()
}

{
  const { scheduler, clock } = makeScheduler({ tuning: { baseDelayMs: 60_000, maxDelayMs: 60_000 } })
  scheduler.noteLost('box', 'transport lost')
  check('cancel reports that it stopped something', scheduler.cancel('box', 'the user disconnected') === true)
  check('cancel clears the entry', scheduler.stateOf('box') === undefined)
  check('cancel clears the timer', clock.pending() === 0, String(clock.pending()))
  check('cancelling twice is not an error', scheduler.cancel('box') === false)
  scheduler.dispose()
}

{
  // "Disconnect" must stay disconnected: a pending loop that keeps dialing is
  // the exact opposite of what the button promises.
  const { scheduler, clock, calls } = makeScheduler({ tuning: { baseDelayMs: 1000, maxDelayMs: 1000 } })
  scheduler.noteLost('box', 'transport lost')
  scheduler.cancel('box', 'the user disconnected')
  await clock.advance(60_000)
  check('a cancelled loop never dials again', calls.length === 0, JSON.stringify(calls))
  scheduler.dispose()
}

{
  // A manual retry is intent expressed by the user, so it is allowed even when
  // nothing else wants the host — otherwise the button would refuse to work on
  // exactly the host the user is looking at.
  const { scheduler, calls } = makeScheduler({ isWanted: () => false })
  const result = await scheduler.retryNow('box')
  check('manual retry works when nothing wanted the host', result.ok === true && calls.length === 1, JSON.stringify(result))
  check('a successful manual retry leaves no entry', scheduler.stateOf('box') === undefined)
  scheduler.dispose()
}

// ------------------------------------------------------------------- safety
console.log('\n[safety of the surface itself]')

{
  const { scheduler } = makeScheduler()
  scheduler.noteLost('box', 'transport lost')
  const state = scheduler.stateOf('box')
  check('the exposed entry carries no timer handle', state.timer === undefined, JSON.stringify(Object.keys(state)))
  state.attempts = 999
  check('mutating the exposed entry does not reach the scheduler', scheduler.stateOf('box').attempts === 1, JSON.stringify(scheduler.stateOf('box')))
  scheduler.dispose()
}

{
  const { scheduler, clock } = makeScheduler()
  check('isWanted may throw without looking like "wanted"', (() => {
    const throwing = new ReconnectScheduler({
      attempt: async () => ({}),
      isWanted: () => { throw new Error('fs seam is gone') },
      tuning: { baseDelayMs: 10, maxDelayMs: 10 },
      now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    })
    const started = throwing.noteLost('box', 'x')
    throwing.dispose()
    return started === false
  })())
  scheduler.dispose()
}

{
  const { scheduler, clock, calls } = makeScheduler({ tuning: { baseDelayMs: 10_000, maxDelayMs: 10_000 } })
  scheduler.noteLost('box', 'transport lost')
  scheduler.dispose()
  await clock.advance(60_000)
  check('dispose stops every loop', calls.length === 0, JSON.stringify(calls))
  check('a disposed scheduler refuses to start a new loop', scheduler.noteLost('box', 'x') === false)
  check('the entries map is empty after dispose', scheduler.list().length === 0)
}

{
  let refused = false
  try {
    // eslint-disable-next-line no-new
    new ReconnectScheduler({})
  } catch {
    refused = true
  }
  check('constructing without attempt() is refused', refused)
}

// -------------------------------------------------------------- integration
console.log('\n[engine wiring]')

{
  const { readFileSync } = await import('node:fs')
  const engineSource = readFileSync(path.join(pluginRoot, 'lib', 'engine.js'), 'utf8')
  check('the engine arms the loop from the socket close event', /client\.on\('close',[\s\S]{0,600}noteLost/u.test(engineSource))
  check('only a record still in the pool may arm it (deliberate closes are excluded)', /this\.pool\.get\(alias\) !== record\) return/u.test(engineSource))
  check('forget() cancels the background loop', /reconnector\?\.cancel\(alias/u.test(engineSource))
  check('a foreground acquire failure hands the alias to the loop', /reconnector\.noteLost\(alias/u.test(engineSource))
  check('the background attempt passes background: true', /acquire\(alias, \{ background: true \}\)/u.test(engineSource))
  check('descriptor errors are classified as fatal', /fatal\.fatal = true|error\.fatal === true/u.test(engineSource))
  // Behavioural requirement, not a comment: the error the verifier raises must
  // carry `fatal`, or the background loop retries a connection the user has not
  // authorised. The regex spans the constructor because the flag is set after it.
  check('a refused host key is marked fatal', /function hostKeyMismatchError[\s\S]{0,1200}?error\.fatal = true/u.test(engineSource))
  check('the loop consults the mounted roots', /this\.fs\?\.listRoots\?\.\(\)/u.test(engineSource) && /parseRemotePath\(root\)\?\.alias === alias/u.test(engineSource))
  check('reconnect policy is configurable, and can be switched off', /options\.reconnect === false/u.test(engineSource))
  check('a saved tunnel keeps the host wanted after its listener dies', /addWantedCheck\(alias => savedForwards\.hasEnabled\(alias\)\)/u.test(readFileSync(path.join(pluginRoot, 'lib', 'index.js'), 'utf8')))
  check('the reconnect hook only fires from the background loop', /async #backgroundConnect[\s\S]{0,600}this\.onReconnected\?\./u.test(engineSource))
}

{
  const { readFileSync } = await import('node:fs')
  const routesSource = readFileSync(path.join(pluginRoot, 'lib', 'routes.js'), 'utf8')
  check('status ships the reconnecting rows', /reconnecting,/u.test(routesSource))
  check('a manual reconnect route exists', /hostReconnect/u.test(routesSource))
  const indexSource = readFileSync(path.join(pluginRoot, 'lib', 'index.js'), 'utf8')
  check('a reconnect restores the saved tunnels', /onReconnected[\s\S]{0,400}reopenEnabled/u.test(indexSource))
  const persistSource = readFileSync(path.join(pluginRoot, 'lib', 'forward-persist.js'), 'utf8')
  check('reopenEnabled only opens rows whose intent is still on', /entry\.alias === target && entry\.enabled/u.test(persistSource))
}

console.log(`\n=== ${passed} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
