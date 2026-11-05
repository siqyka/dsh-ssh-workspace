/**
 * Watch recovery: a watcher must survive a dropped link and must NOT survive a
 * real failure.
 *
 * ## The defect this suite pins down
 *
 * The remote change watcher polls. A failed poll used to be reported to the
 * consumer as a final error, because that is what the seam's contract means by
 * "the callback got an Error": I am finished, close me. That is correct for a
 * permission denial on a healthy connection and wrong for a dropped SSH link —
 * the poll failed BECAUSE the transport is gone, the watcher stopped, and
 * nothing ever restarted it.
 *
 * The host cannot paper over it: `dsh-client-ui-sidebar-files` reacts to a
 * watch failure by marking the row and never retrying, and it swallows
 * `watch-unsupported` silently. The user-visible symptom is a file tree that
 * quietly stops refreshing an hour after a Wi-Fi blip.
 *
 * ## What is executed, not grepped
 *
 * `watchFailureVerdict` and `watchRecoveryDelay` are pure and are called here
 * directly, over the whole truth table. A suite that grepped for
 * `if (connected)` would pass with the branches inverted.
 *
 * The middle third drives the REAL `RemoteFileSystem.watch()` against a fake
 * engine whose SFTP reads can be made to fail on demand, so the wiring between
 * the policy and the poller is exercised, not just the policy.
 *
 * Run: node tests/watch-recovery-smoke.mjs
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// remote-fs.js resolves the DSH peer packages at import time, so the assembled
// tree (or the generated stub root) must be on the peer path first.
const coreRoot = process.env.DSH_CORE_ROOT
if (!coreRoot) {
  console.log('\n=== watch recovery smoke ===\n')
  console.log('  SKIP  DSH_CORE_ROOT is not set (needs @deepseek-ai/dsh-fs)')
  console.log('\n=== 0 passed, 0 failed, 1 suite skipped ===')
  process.exit(0)
}
process.env.DSH_PEER_ROOT = [coreRoot, process.env.DSH_PEER_ROOT].filter(Boolean).join(path.delimiter)

const { RemoteFileSystem } = await import(pathToFileURL(path.join(pluginRoot, 'lib/remote-fs.js')).href)
const { watchFailureVerdict, watchRecoveryDelay } = await import(pathToFileURL(path.join(pluginRoot, 'lib/watch-recovery.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// 1. The policy, executed over the whole truth table
// ---------------------------------------------------------------------------
console.log('\n[1] retry only when the link is down AND something is repairing it')
{
  const waiting = { phase: 'waiting', attempts: 3 }
  const connecting = { phase: 'connecting', attempts: 3 }
  const gaveUp = { phase: 'gave-up', attempts: 9, lastError: 'authentication failed' }

  const healthy = watchFailureVerdict({ connected: true, loop: waiting })
  check('healthy connection + loop running → do not retry', healthy.retry === false, JSON.stringify(healthy))
  check('and the reason names the connection, not the path',
    /connection is healthy/u.test(healthy.reason), healthy.reason)

  const downNoLoop = watchFailureVerdict({ connected: false, loop: undefined })
  check('link down, no loop → do not retry', downNoLoop.retry === false, JSON.stringify(downNoLoop))
  check('and the reason says nothing is repairing it',
    /nothing is trying/u.test(downNoLoop.reason), downNoLoop.reason)

  const downGaveUp = watchFailureVerdict({ connected: false, loop: gaveUp })
  check('link down, loop gave up → do not retry', downGaveUp.retry === false, JSON.stringify(downGaveUp))

  const downWaiting = watchFailureVerdict({ connected: false, loop: waiting })
  check('link down, loop waiting → retry', downWaiting.retry === true, JSON.stringify(downWaiting))

  const downConnecting = watchFailureVerdict({ connected: false, loop: connecting })
  check('link down, attempt in flight → retry', downConnecting.retry === true, JSON.stringify(downConnecting))

  // A missing engine method must not read as "healthy".
  const blank = watchFailureVerdict({})
  check('no state at all → do not retry', blank.retry === false, JSON.stringify(blank))
}

// ---------------------------------------------------------------------------
// 2. The backoff ladder
// ---------------------------------------------------------------------------
console.log('\n[2] the retry delay grows and is capped')
{
  const ladder = [1, 2, 3, 4].map(n => watchRecoveryDelay(n))
  check('first delay is the base', ladder[0] === 1000, String(ladder[0]))
  check('second delay doubles', ladder[1] === 2000, String(ladder[1]))
  check('third delay doubles again', ladder[2] === 4000, String(ladder[2]))
  const far = watchRecoveryDelay(40)
  check('a long outage is capped', far === 30_000, String(far))
  check('never grows past the cap', watchRecoveryDelay(1000) === 30_000, String(watchRecoveryDelay(1000)))
  check('a ceiling below the base cannot invert them',
    watchRecoveryDelay(3, { baseDelayMs: 5000, maxDelayMs: 1000 }) === 5000,
    String(watchRecoveryDelay(3, { baseDelayMs: 5000, maxDelayMs: 1000 })))
}

/** Stats shaped like the SFTP attributes the backend reads. */
const DIR_STATS = { size: 0, mtime: 1, ino: 1, mode: 0o040755, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false }

/**
 * A fake engine whose transport can be broken and healed.
 *
 * `state.down` models the SSH link: while true, every SFTP operation rejects
 * exactly as a dead transport does. `state.loop` is what the reconnect
 * scheduler would report, so the suite controls both halves of the verdict.
 */
function makeHarness () {
  const state = {
    down: false,
    loop: undefined,
    connected: true,
    /** Every observation attempt, in order. */
    observations: 0,
    entries: [],
  }
  const engine = {
    diagnostics: {
      entries: state.entries,
      record (kind, message, detail) { state.entries.push({ kind, message, alias: detail?.alias }) },
    },
    generationOf () { return { connected: state.connected } },
    reconnector: { stateOf () { return state.loop } },
    async probeCapabilities () { return { inotifywait: false, rg: true, git: true } },
    async withSftp (_alias, operation) {
      state.observations += 1
      if (state.down) throw new Error('transport lost')
      return await operation({
        stat: (_p, cb) => cb(undefined, { ...DIR_STATS, mtime: state.mtime ?? 1 }),
        readdir: (_p, cb) => cb(undefined, []),
      })
    },
  }
  const fs = new RemoteFileSystem({ base: {}, engine, roots: new Set(['ssh://h/root']) })
  return { fs, engine, state }
}

const TARGET = { displayPath: 'ssh://h/root', targetKey: 'ssh://h/root' }

// ---------------------------------------------------------------------------
// 3. THE DEFECT: a dropped link must not end the watcher
// ---------------------------------------------------------------------------
console.log('\n[3] a poll that fails while the link is down does not end the watcher')
{
  const { fs, state } = makeHarness()
  const reported = []
  const close = await fs.watch(TARGET, (error) => { reported.push(error) }, undefined)
  const before = state.observations

  // The link drops. The reconnect loop is working on it.
  state.down = true
  state.connected = false
  state.loop = { phase: 'waiting', attempts: 1 }
  await sleep(2400)
  check('the watcher survived the first failed poll', reported.length === 0,
    `reported ${reported.length}: ${reported.map(e => e?.message).join('; ')}`)
  check('it paused rather than stopping',
    state.entries.some(entry => /change watcher paused/u.test(entry.message)),
    JSON.stringify(state.entries.map(e => e.message)))
  const duringOutage = state.observations
  check('and it is still trying', duringOutage > before, `observations ${before} → ${duringOutage}`)

  // The link comes back.
  state.down = false
  state.connected = true
  state.loop = undefined
  await sleep(2600)
  check('the rescan after recovery is announced as a change', reported.length >= 1,
    `reported ${reported.length}`)
  check('and the reported value is a change, not an error',
    reported.every(entry => entry === undefined), JSON.stringify(reported.map(e => e?.message)))
  await close()
}

// ---------------------------------------------------------------------------
// 4. A real failure must still be reported
// ---------------------------------------------------------------------------
console.log('\n[4] a failure on a healthy link is still reported as final')
{
  const { fs, state } = makeHarness()
  const reported = []
  const close = await fs.watch(TARGET, (error) => { reported.push(error) }, undefined)
  // Healthy connection, no reconnect loop: a permission denial looks like this.
  state.down = true
  state.connected = true
  state.loop = undefined
  await sleep(2400)
  check('the failure reached the consumer', reported.length === 1,
    `reported ${reported.length}`)
  check('as an Error, so the caller closes the watch', reported[0] instanceof Error,
    String(reported[0]))
  const after = state.observations
  await sleep(2400)
  check('and polling stopped', state.observations === after,
    `observations grew from ${after} to ${state.observations}`)
  await close()
}

// ---------------------------------------------------------------------------
// 5. A loop that gave up is not a repair in progress
// ---------------------------------------------------------------------------
console.log('\n[5] a link down with a loop that gave up is reported, not retried')
{
  const { fs, state } = makeHarness()
  const reported = []
  const close = await fs.watch(TARGET, (error) => { reported.push(error) }, undefined)
  state.down = true
  state.connected = false
  state.loop = { phase: 'gave-up', attempts: 5, lastError: 'host key changed' }
  await sleep(2400)
  check('the failure reached the consumer', reported.length === 1, `reported ${reported.length}`)
  const after = state.observations
  await sleep(2400)
  check('and polling stopped', state.observations === after,
    `observations grew from ${after} to ${state.observations}`)
  await close()
}

// ---------------------------------------------------------------------------
// 6. The opening observation retries instead of rejecting outright
// ---------------------------------------------------------------------------
console.log('\n[6] a watch opened during an outage waits for the link instead of failing')
{
  const { fs, state } = makeHarness()
  state.down = true
  state.connected = false
  state.loop = { phase: 'waiting', attempts: 1 }
  // Heal the link shortly after the watch is requested.
  const heal = setTimeout(() => {
    state.down = false
    state.connected = true
    state.loop = undefined
  }, 300)
  let close
  let error
  try {
    close = await fs.watch(TARGET, () => {}, undefined)
  } catch (failure) {
    error = failure
  }
  clearTimeout(heal)
  check('the watch resolved once the link returned', close !== undefined,
    error === undefined ? 'resolved' : error?.message)
  check('an attempt was made while the link was down',
    state.entries.some(entry => /could not start/u.test(entry.message)),
    JSON.stringify(state.entries.map(e => e.message)))
  await close?.()
}

// ---------------------------------------------------------------------------
// 7. Abort during the wait must not be mistaken for a failure
// ---------------------------------------------------------------------------
console.log('\n[7] cancelling during the opening wait aborts cleanly')
{
  const { fs, state } = makeHarness()
  state.down = true
  state.connected = false
  state.loop = { phase: 'waiting', attempts: 1 }
  const controller = new AbortController()
  const pending = fs.watch(TARGET, () => {}, controller.signal)
  setTimeout(() => controller.abort(), 200)
  let error
  try {
    await pending
  } catch (failure) {
    error = failure
  }
  check('it rejected', error !== undefined)
  check('with the abort code, not a transport message',
    error?.code === 'FS_ABORTED', `${error?.code} / ${error?.message}`)
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
if (failures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}
