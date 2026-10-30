/**
 * Change-watch lifecycle: a watcher that degrades must still be closable.
 *
 * The remote backend watches through `inotifywait` when the host has it and
 * falls back to polling when the push channel dies. The defect this suite
 * pins down was a resource leak with a long fuse: the push watcher's close
 * function only closed the push branch, so once "push died → polling took
 * over" had happened, closing the watch left the poller running — its timer,
 * its SFTP polls and its connection hold all survived for the life of the
 * process. An editor left open across repeated Wi-Fi drops accumulated one
 * leaked poller per drop.
 *
 * The suite counts live handles instead of trusting the close: every started
 * watcher registers itself, and the assertion is that the count returns to
 * zero after close, including when the close happens DURING the degradation.
 *
 * Run: node tests/watch-lifecycle-smoke.mjs
 */

import { EventEmitter } from 'node:events'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// remote-fs.js resolves the DSH peer packages at import time, so the assembled
// tree (or the generated stub root) must be on the peer path first. Skipping is
// not passing: without it this suite could only ever run by hand.
const coreRoot = process.env.DSH_CORE_ROOT
if (!coreRoot) {
  console.log('\n=== watch lifecycle smoke ===\n')
  console.log('  SKIP  DSH_CORE_ROOT is not set (needs @deepseek-ai/dsh-fs)')
  console.log('\n=== 0 passed, 0 failed, 1 suite skipped ===')
  process.exit(0)
}
process.env.DSH_PEER_ROOT = [coreRoot, process.env.DSH_PEER_ROOT].filter(Boolean).join(path.delimiter)

const { RemoteFileSystem } = await import(pathToFileURL(path.join(pluginRoot, 'lib/remote-fs.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** Stats shaped like the SFTP attributes the backend reads. */
const DIR_STATS = { size: 0, mtime: 1, ino: 1, mode: 0o040755, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false }

/**
 * A fake engine whose `openChannel` hands back a controllable push channel and
 * whose `withSftp` runs a read-only stat.
 *
 * `liveHandles` is the leak detector: every watcher that starts increments it
 * and its close decrements it, so "the close forgot one branch" shows up as a
 * non-zero count rather than as a subtle timer.
 */
function makeHarness ({ inotifywait = true } = {}) {
  const state = {
    liveHandles: 0,
    started: [],
    polls: 0,
    /** Fires the push watcher's own death, as the real channel close would. */
    killPush: undefined,
  }

  const engine = {
    diagnostics: {
      entries: [],
      record (kind, message, detail) { this.entries.push({ kind, message, alias: detail?.alias }) },
    },
    async probeCapabilities () { return { inotifywait, rg: true, git: true } },
    async withSftp (_alias, operation) {
      state.polls += 1
      return await operation({
        stat: (_p, cb) => cb(undefined, DIR_STATS),
        readdir: (_p, cb) => cb(undefined, []),
      })
    },
    async openChannel () {
      const channel = new EventEmitter()
      channel.stderr = new EventEmitter()
      channel.close = () => { channel.emit('close') }
      const opened = {
        channel,
        record: {},
        release: () => {},
      }
      // The push watcher announces itself live after a short beat; expose the
      // trigger that kills it later, like a dropped SSH channel.
      state.killPush = () => { channel.emit('close') }
      return opened
    },
  }

  const fs = new RemoteFileSystem({ base: {}, engine, roots: new Set(['ssh://h/root']) })
  return { fs, engine, state }
}

/**
 * Track a watcher's handles.
 *
 * The backend does not expose its handles, so the count is kept here by
 * wrapping the two functions it uses: a push watcher is "live" from
 * `openChannel` until its channel closes, and a poller from start until the
 * close function it returns runs. `activePolls` is the number that matters.
 */
function trackPolls (fs, engine) {
  const tracker = { activePolls: 0, totalPolls: 0 }
  const originalWatch = fs.watch.bind(fs)
  // Count through the engine instead: every poll cycle rides `withSftp`, but a
  // stopped poller stops calling it, so "no calls in 300ms" is the observable
  // form of "the poller is gone".
  const originalWithSftp = engine.withSftp.bind(engine)
  engine.withSftp = async (...args) => {
    tracker.lastPollAt = Date.now()
    tracker.totalPolls += 1
    return await originalWithSftp(...args)
  }
  tracker.restore = () => { engine.withSftp = originalWithSftp; fs.watch = originalWatch }
  return tracker
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// 1. A poll-only watcher closes cleanly
// ---------------------------------------------------------------------------
console.log('\n[1] a polling watcher stops polling after close')
{
  const { fs, engine } = makeHarness({ inotifywait: false })
  const tracker = trackPolls(fs, engine)
  const changes = []
  const close = await fs.watch({ displayPath: 'ssh://h/root', targetKey: 'ssh://h/root' }, () => { changes.push(Date.now()) }, undefined)
  const before = tracker.totalPolls
  await sleep(60)
  await close()
  const atClose = tracker.totalPolls
  await sleep(300)
  check('the poller ran while open', before >= 1 || atClose >= 1, `polls=${atClose}`)
  check('the poller stops after close', tracker.totalPolls === atClose, `polls grew from ${atClose} to ${tracker.totalPolls}`)
  tracker.restore()
}

// ---------------------------------------------------------------------------
// 2. THE DEFECT: push dies, polling takes over, then the caller closes
// ---------------------------------------------------------------------------
console.log('\n[2] a degraded (push → poll) watcher still stops polling after close')
{
  const { fs, engine, state } = makeHarness({ inotifywait: true })
  const tracker = trackPolls(fs, engine)
  const close = await fs.watch({ displayPath: 'ssh://h/root', targetKey: 'ssh://h/root' }, () => {}, undefined)
  check('the push watcher was preferred', state.killPush !== undefined)

  // Kill the push channel: the backend must re-arm polling.
  state.killPush()
  await sleep(250)
  check('the degradation was reported',
    engine.diagnostics.entries.some(entry => /inotifywait watcher ended/u.test(entry.message)),
    JSON.stringify(engine.diagnostics.entries))
  const pollsAfterDegrade = tracker.totalPolls

  await close()
  // One full poll interval (the adaptive floor is 2s) has to elapse: a poller
  // that is still alive proves itself by polling again, and a 300ms window
  // would pass even with the leak.
  await sleep(2600)
  check('the poller that took over was closed too',
    tracker.totalPolls === pollsAfterDegrade,
    `polls grew from ${pollsAfterDegrade} to ${tracker.totalPolls} after close`)
  tracker.restore()
}

// ---------------------------------------------------------------------------
// 3. Close racing the degradation must not leak a late-arriving poller
// ---------------------------------------------------------------------------
console.log('\n[3] closing during degradation does not leak the replacement poller')
{
  const { fs, engine, state } = makeHarness({ inotifywait: true })
  const tracker = trackPolls(fs, engine)
  const close = await fs.watch({ displayPath: 'ssh://h/root', targetKey: 'ssh://h/root' }, () => {}, undefined)
  // Degrade and close in the same tick: the poller is installed after the close
  // has already run its own close, which is exactly the race that leaks.
  state.killPush()
  await close()
  await sleep(400)
  const settled = tracker.totalPolls
  await sleep(2600)
  check('no polling continues after a close that raced the degradation',
    tracker.totalPolls === settled,
    `polls grew from ${settled} to ${tracker.totalPolls}`)
  tracker.restore()
}

// ---------------------------------------------------------------------------
// 4. Repeated degrade/close cycles leave nothing behind
// ---------------------------------------------------------------------------
console.log('\n[4] 20 degrade → close cycles leave no watcher running')
{
  const { fs, engine, state } = makeHarness({ inotifywait: true })
  const tracker = trackPolls(fs, engine)
  for (let cycle = 0; cycle < 20; cycle += 1) {
    const close = await fs.watch({ displayPath: 'ssh://h/root', targetKey: 'ssh://h/root' }, () => {}, undefined)
    state.killPush()
    await sleep(20)
    await close()
  }
  await sleep(400)
  const settled = tracker.totalPolls
  await sleep(2600)
  check('20 cycles leave no poller behind', tracker.totalPolls === settled,
    `polls grew from ${settled} to ${tracker.totalPolls}`)
  check('every cycle reported its degradation',
    engine.diagnostics.entries.filter(entry => /inotifywait watcher ended/u.test(entry.message)).length >= 20,
    `${engine.diagnostics.entries.length} entries`)
  tracker.restore()
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
if (failures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}
