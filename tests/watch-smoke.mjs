/**
 * The remote change watcher: lifecycle, sharing, recovery.
 *
 * One subsystem, three properties that fail independently:
 *   - lifecycle — a watcher that degrades from push to polling must still be
 *     closable; every started handle is counted, not trusted;
 *   - sharing — one host+path target has ONE underlying watcher, fanned out
 *     once per consumer;
 *   - recovery — a dropped link must restart the watcher, a real refusal must
 *     not.
 *
 * All three sections skip together without `DSH_CORE_ROOT`: they mount the
 * real remote backend, and a stub cannot stand in for it.
 *
 * Run: node tests/watch-smoke.mjs
 */

import { EventEmitter } from 'node:events'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'

let totalPassed = 0
let totalFailures = 0

// ---------------------------------------------------------------------------
// watch-lifecycle-smoke.mjs
// ---------------------------------------------------------------------------
await (async () => {
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
 */const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// remote-fs.js resolves the DSH peer packages at import time, so the assembled
// tree (or the generated stub root) must be on the peer path first. Skipping is
// not passing: without it this suite could only ever run by hand.
const coreRoot = process.env.DSH_CORE_ROOT
if (!coreRoot) {
  console.log('\n=== watch lifecycle smoke ===\n')
  console.log('  SKIP  DSH_CORE_ROOT is not set (needs @deepseek-ai/dsh-fs)')
  console.log('\n=== 0 passed, 0 failed, 1 suite skipped ===')
  return
}
process.env.DSH_PEER_ROOT = [coreRoot, process.env.DSH_PEER_ROOT].filter(Boolean).join(path.delimiter)

const { RemoteFileSystem } = await import(pathToFileURL(path.join(pluginRoot, 'lib/fs/remote-fs.js')).href)

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


  totalPassed += passed
  totalFailures += failures
})()

// ---------------------------------------------------------------------------
// watch-sharing-smoke.mjs
// ---------------------------------------------------------------------------
await (async () => {
/**
 * Change-watch sharing: one remote target, one underlying watcher.
 *
 * The remote backend used to create an independent watcher per `watch()` call:
 * two subscriptions of the same host+path started two pollers (or two
 * `inotifywait` channels), each with its own reconnect loop and timer, and a
 * change was delivered twice to every consumer. Re-mounting the file tree
 * while the old subscription was still retrying made that worse.
 *
 * This suite pins the registry's observable contract:
 *
 *  1. same target, two consumers → exactly one underlying watcher; a change is
 *     fanned out once per consumer, not once per watcher;
 *  2. closing one consumer leaves the other working; the last close stops the
 *     watcher exactly once;
 *  3. push → poll degradation replaces the handle instead of adding one;
 *  4. against a real SSH socket, killing the transport does not grow the
 *     watcher count, auto-reconnect restores it, and a later change still
 *     reaches both consumers exactly once each.
 *
 * Run: node tests/watch-sharing-smoke.mjs
 */
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const supportDir = path.join(pluginRoot, 'tests', 'support')

// remote-fs.js resolves the DSH peer packages at import time, so the assembled
// tree (or the runner-generated stub root) must be on the peer path first.
// Skipping is not passing: the runner supplies DSH_CORE_ROOT for a bare checkout.
const coreRoot = process.env.DSH_CORE_ROOT
if (!coreRoot) {
  console.log('\n=== watch sharing smoke ===\n')
  console.log('  SKIP  DSH_CORE_ROOT is not set (needs @deepseek-ai/dsh-fs)')
  console.log('\n=== 0 passed, 0 failed, 1 suite skipped ===')
  return
}
process.env.DSH_PEER_ROOT = [coreRoot, process.env.DSH_PEER_ROOT].filter(Boolean).join(path.delimiter)

const { RemoteFileSystem } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'fs', 'remote-fs.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor (predicate, timeout = 4_000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await predicate()) return true
    await sleep(25)
  }
  return false
}

/** Stats shaped like the SFTP attributes the backend reads. */
const DIR_STATS = { size: 0, mtime: 1, ino: 1, mode: 0o040755, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false }
const TARGET = { displayPath: 'ssh://h/root', targetKey: 'ssh://h/root' }

/**
 * A fake engine with a controllable push channel, plus counters for every
 * resource a watcher can leak.
 */
function makePushHarness ({ inotifywait = true } = {}) {
  const state = {
    openChannels: 0,
    channelCloses: 0,
    releases: 0,
    polls: 0,
    channel: undefined,
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
        stat: (_path, callback) => callback(undefined, DIR_STATS),
        readdir: (_path, callback) => callback(undefined, []),
      })
    },
    async openChannel () {
      const channel = new EventEmitter()
      channel.stderr = new EventEmitter()
      channel.close = () => {
        state.channelCloses += 1
        channel.emit('close')
      }
      state.openChannels += 1
      state.channel = channel
      return {
        channel,
        record: {},
        release: () => { state.releases += 1 },
      }
    },
  }
  const fs = new RemoteFileSystem({ base: {}, engine })
  return { fs, engine, state }
}

/** Emit one `inotifywait` change batch. */
function emitChange (state) {
  state.channel.emit('data', Buffer.from('dsh-change\n', 'utf8'))
}

// =========================================================== [1] one watcher
console.log('\n[1] two consumers of one target share one push watcher and one event each')
{
  const { fs, state } = makePushHarness()
  const seen = { a: 0, b: 0 }
  const [closeA, closeB] = await Promise.all([
    fs.watch(TARGET, () => { seen.a += 1 }, undefined),
    fs.watch(TARGET, () => { seen.b += 1 }, undefined),
  ])

  check('one underlying watcher, not two', fs.watchTargetCount('h', '/root') === 1,
    JSON.stringify(fs.watchTargets()))
  const target = fs.watchTargets()[0]
  check('both consumers are registered on it', target?.consumers === 2, JSON.stringify(target))
  check('the push channel was opened once', state.openChannels === 1, `openChannels=${state.openChannels}`)
  check('the live mode is push', target?.mode === 'push', JSON.stringify(target))

  emitChange(state)
  await sleep(40)
  check('one event reaches consumer A exactly once', seen.a === 1, `seen=${seen.a}`)
  check('one event reaches consumer B exactly once', seen.b === 1, `seen=${seen.b}`)

  emitChange(state)
  await sleep(40)
  check('a second event reaches A exactly once', seen.a === 2, `seen=${seen.a}`)
  check('a second event reaches B exactly once', seen.b === 2, `seen=${seen.b}`)

  // Closing one consumer must not stop the shared watcher — the refcount is the
  // difference between "release my subscription" and "tear down the watcher".
  const beforeClose = state.channelCloses
  await closeA()
  check('closing one consumer keeps the watcher live', fs.watchTargetCount('h', '/root') === 1,
    JSON.stringify(fs.watchTargets()))
  check('the remaining consumer count is one', fs.watchTargets()[0]?.consumers === 1,
    JSON.stringify(fs.watchTargets()))
  check('closing one consumer does not close the channel', state.channelCloses === beforeClose,
    `closes=${state.channelCloses}`)

  emitChange(state)
  await sleep(40)
  check('the remaining consumer still receives events', seen.b === 3, `seen=${seen.b}`)
  check('the closed consumer receives nothing more', seen.a === 2, `seen=${seen.a}`)

  await closeB()
  check('the last close stops the watcher', fs.watchTargetCount('h', '/root') === 0,
    JSON.stringify(fs.watchTargets()))
  check('the registry row is gone', fs.watchTargets().length === 0, JSON.stringify(fs.watchTargets()))
  check('the channel was closed exactly once', state.channelCloses === beforeClose + 1,
    `closes=${state.channelCloses}`)
  check('the channel lease was released exactly once', state.releases === 1,
    `releases=${state.releases}`)
  check('close did not start a poller', state.polls === 1, `polls=${state.polls}`)
}

// ==================================================== [2] degradation shared
console.log('\n[2] push → poll degradation replaces the handle instead of adding one')
{
  const { fs, state } = makePushHarness()
  const [closeA, closeB] = await Promise.all([
    fs.watch(TARGET, () => {}, undefined),
    fs.watch(TARGET, () => {}, undefined),
  ])
  check('both consumers share the push watcher', fs.watchTargetCount('h', '/root') === 1)

  // The channel dies after it was announced live: the backend must re-arm
  // polling for the SAME entry.
  state.channel.emit('close')
  const wentPoll = await waitFor(() => fs.watchTargets()[0]?.mode === 'poll')
  check('the shared watcher degraded to poll', wentPoll, JSON.stringify(fs.watchTargets()))
  check('degradation still leaves exactly one watcher', fs.watchTargetCount('h', '/root') === 1,
    JSON.stringify(fs.watchTargets()))
  check('both consumers survived the degradation', fs.watchTargets()[0]?.consumers === 2,
    JSON.stringify(fs.watchTargets()))

  await closeA()
  check('closing one consumer after degradation leaves one watcher',
    fs.watchTargetCount('h', '/root') === 1, JSON.stringify(fs.watchTargets()))
  await closeB()
  check('closing the last consumer after degradation stops it',
    fs.watchTargetCount('h', '/root') === 0, JSON.stringify(fs.watchTargets()))
}

// ============================================================ [3] real socket
console.log('\n[3] a real socket drop does not grow or double the watcher')
{
  const cleanups = []
  const track = (fn) => { cleanups.push(fn) }
  const cleanup = () => {
    while (cleanups.length > 0) {
      try { cleanups.pop()() } catch { /* already gone */ }
    }
  }

  try {
    const { startFakeSshServer } = await import(pathToFileURL(path.join(supportDir, 'fake-ssh-server.mjs')).href)
    let realSsh2 = false
    try {
      const ssh2 = createRequire(`${pluginRoot}/package.json`)('ssh2')
      realSsh2 = typeof ssh2.Server === 'function' && typeof ssh2.utils?.generateKeyPairSync === 'function'
    } catch { realSsh2 = false }
    if (!realSsh2) {
      console.log('  SKIP  no real ssh2 is resolvable from this checkout')
    } else {
      // A file whose stat the watch poller compares. Mutating size/mtime is a
      // change; no second watcher is involved.
      const version = { size: 10, mtime: 1000 }
      const server = await startFakeSshServer({
        pluginRoot,
        password: 'sekret',
        onExec: ({ stream }) => {
          // All tools absent: the watcher must use the polling path, which is
          // the path a broken socket interrupts.
          stream.write('dsh-probe-done\n')
          stream.exit(0)
          stream.end()
        },
        onSftp: (sftp) => {
          sftp.on('OPEN', (reqid) => sftp.status(reqid, 0))
          sftp.on('CLOSE', (reqid) => sftp.status(reqid, 0))
          sftp.on('REALPATH', (reqid, p) => sftp.name(reqid, [{ filename: p, longname: p, attrs: {} }]))
          sftp.on('STAT', (reqid, p) => {
            if (p !== '/watch.txt') {
              sftp.status(reqid, 2)
              return
            }
            sftp.attrs(reqid, {
              mode: 0o100644,
              uid: 0,
              gid: 0,
              size: version.size,
              atime: 0,
              mtime: version.mtime,
            })
          })
          // The poller may list a directory when it cannot tell otherwise; keep
          // the fallback harmless.
          sftp.on('OPENDIR', (reqid) => sftp.status(reqid, 0))
          sftp.on('READDIR', (reqid) => sftp.status(reqid, 1))
        },
      })
      track(() => server.close())
      const { HostConfigStore } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'hosts', 'store.js')).href)
      const { HostStore } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'hosts', 'hosts.js')).href)
      const { SshWorkspaceEngine } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'engine', 'engine.js')).href)

      const dir = mkdtempSync(path.join(tmpdir(), 'dsh-watch-sharing-'))
      track(() => rmSync(dir, { recursive: true, force: true }))
      const storeFile = path.join(dir, 'hosts.json')
      writeFileSync(storeFile, JSON.stringify({
        version: 1,
        hosts: [{
          alias: 'fake',
          host: '127.0.0.1',
          port: server.port,
          user: 'tester',
          auth: { kind: 'password', password: 'sekret' },
        }],
      }, null, 2), 'utf8')
      const entryStore = new HostConfigStore(storeFile)
      const store = new HostStore(path.join(dir, 'no-ssh-config'), entryStore)
      const engine = new SshWorkspaceEngine({
        store,
        reconnect: { baseDelayMs: 150, maxDelayMs: 300, jitter: 0, maxAttempts: 0 },
        sweepIntervalMs: 3_600_000,
      })
      track(() => engine.dispose())
      const fs = new RemoteFileSystem({ base: {}, engine })
      engine.addWantedCheck(() => true)
      await engine.acquire('fake')

      const seen = { a: 0, b: 0 }
      const [closeA, closeB] = await Promise.all([
        fs.watch({ displayPath: 'ssh://fake/watch.txt', targetKey: 'ssh://fake/watch.txt' }, () => { seen.a += 1 }, undefined),
        fs.watch({ displayPath: 'ssh://fake/watch.txt', targetKey: 'ssh://fake/watch.txt' }, () => { seen.b += 1 }, undefined),
      ])
      check('real socket: one underlying watcher for two consumers',
        fs.watchTargetCount('fake', '/watch.txt') === 1, JSON.stringify(fs.watchTargets()))
      check('real socket: the watcher is polling', fs.watchTargets()[0]?.mode === 'poll',
        JSON.stringify(fs.watchTargets()))

      // Hard-drop the socket under the live connection. The watcher must keep
      // existing once, not be recreated on every failed retry.
      server.dropAll()
      const dropped = await waitFor(() => engine.reconnector?.stateOf('fake') !== undefined)
      check('the transport death is noticed', dropped, JSON.stringify(engine.reconnector?.stateOf('fake')))
      let samples = 0
      let grew = false
      const sampleStarted = Date.now()
      while (Date.now() - sampleStarted < 900) {
        samples += 1
        if (fs.watchTargetCount('fake', '/watch.txt') !== 1) grew = true
        await sleep(30)
      }
      check('the watcher count stays 1 throughout the outage', !grew && samples > 0,
        `samples=${samples} targets=${JSON.stringify(fs.watchTargets())}`)

      const reconnected = await waitFor(() => server.connections >= 2 && engine.pool.get('fake')?.broken === false, 6_000)
      check('the engine reconnects on its own', reconnected, `connections=${server.connections}`)
      check('the watcher count is still 1 after reconnect',
        fs.watchTargetCount('fake', '/watch.txt') === 1, JSON.stringify(fs.watchTargets()))
      check('both consumers are still registered after reconnect',
        fs.watchTargets()[0]?.consumers === 2, JSON.stringify(fs.watchTargets()))

      // Let any recovery rescan settle, then reset the counters: from here on a
      // single observed metadata change must produce one callback per consumer.
      await sleep(2_600)
      seen.a = 0
      seen.b = 0
      version.size += 1
      version.mtime += 1
      const changed = await waitFor(() => seen.a > 0 && seen.b > 0, 4_000)
      check('a post-reconnect change reaches the watcher', changed, `seen=${JSON.stringify(seen)}`)
      // Small settle window: a duplicated watcher would deliver the same event
      // again; a fan-out bug would have incremented one consumer twice.
      await sleep(120)
      check('the change reached consumer A exactly once', seen.a === 1, `seen=${seen.a}`)
      check('the change reached consumer B exactly once', seen.b === 1, `seen=${seen.b}`)

      await closeA()
      check('closing one real consumer leaves one watcher',
        fs.watchTargetCount('fake', '/watch.txt') === 1, JSON.stringify(fs.watchTargets()))
      await closeB()
      check('closing the last real consumer stops the watcher',
        fs.watchTargetCount('fake', '/watch.txt') === 0, JSON.stringify(fs.watchTargets()))
    }
  } finally {
    cleanup()
  }
}

// ======================================================= [4] the entry cap
console.log('\n[4] the registry has a concurrency cap and it is a refusal, not a drop')
{
  const { fs, state } = makePushHarness()
  const target = (index) => ({ displayPath: `ssh://h/d${index}`, targetKey: `ssh://h/d${index}` })

  // Fill to the cap. The number is read from the module rather than retyped
  // here: a suite that hard-codes 64 would keep passing after the bound moved,
  // and the point of this section is the BOUND, not the number.
  const source = await import('node:fs').then(({ readFileSync }) =>
    readFileSync(path.join(pluginRoot, 'lib', 'fs', 'remote-watch.js'), 'utf8'))
  const limit = Number(/const WATCH_MAX_ENTRIES = (\d+)/u.exec(source)?.[1])
  check('the cap is declared as a constant', Number.isInteger(limit) && limit > 0, String(limit))

  const closes = []
  for (let index = 0; index < limit; index += 1) {
    closes.push(await fs.watch(target(index), () => {}, undefined))
  }
  check('every target up to the cap is watched', fs.watchTargets().length === limit,
    `watched=${fs.watchTargets().length}, cap=${limit}`)

  // The refusal has to be an ERROR the caller can see. A silent no-op here would
  // leave a tree showing stale entries with nothing anywhere saying why.
  let refusal
  try {
    await fs.watch(target(limit), () => {}, undefined)
  } catch (error) {
    refusal = error
  }
  check('one past the cap is refused', refusal !== undefined, String(refusal))
  check('...with a code that names the cause', refusal?.code === 'FS_TOO_MANY', String(refusal?.code))
  check('...and a message that says how to free a slot',
    /close/i.test(refusal?.message ?? '') && String(refusal?.message).includes(String(limit)),
    String(refusal?.message))
  check('the refusal did not grow the registry', fs.watchTargets().length === limit,
    `watched=${fs.watchTargets().length}`)
  check('the refusal opened no extra channel', state.openChannels === limit, `channels=${state.openChannels}`)

  // Sharing cannot be refused: joining a watcher already open costs nothing the
  // cap is trying to bound.
  const shared = await fs.watch(target(0), () => {}, undefined)
  check('an ALREADY watched target still accepts a second consumer',
    fs.watchTargets().find(row => row.remotePath === '/d0')?.consumers === 2,
    JSON.stringify(fs.watchTargets().find(row => row.remotePath === '/d0')))
  await shared()

  // The bound is on concurrency, not a budget: one close frees exactly one slot.
  await closes[0]()
  check('closing one watch frees a slot', fs.watchTargets().length === limit - 1,
    `watched=${fs.watchTargets().length}`)
  const readmitted = await fs.watch(target(limit), () => {}, undefined)
  check('...so the refused target is accepted afterwards', typeof readmitted === 'function')
  check('...and the registry is back at the cap', fs.watchTargets().length === limit,
    `watched=${fs.watchTargets().length}`)

  await readmitted()
  await Promise.all(closes.slice(1).map(close => close()))
  check('everything closes back to empty', fs.watchTargets().length === 0,
    `watched=${fs.watchTargets().length}`)
}


  totalPassed += passed
  totalFailures += failures
})()

// ---------------------------------------------------------------------------
// watch-recovery-smoke.mjs
// ---------------------------------------------------------------------------
await (async () => {
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
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// remote-fs.js resolves the DSH peer packages at import time, so the assembled
// tree (or the generated stub root) must be on the peer path first.
const coreRoot = process.env.DSH_CORE_ROOT
if (!coreRoot) {
  console.log('\n=== watch recovery smoke ===\n')
  console.log('  SKIP  DSH_CORE_ROOT is not set (needs @deepseek-ai/dsh-fs)')
  console.log('\n=== 0 passed, 0 failed, 1 suite skipped ===')
  return
}
process.env.DSH_PEER_ROOT = [coreRoot, process.env.DSH_PEER_ROOT].filter(Boolean).join(path.delimiter)

const { RemoteFileSystem } = await import(pathToFileURL(path.join(pluginRoot, 'lib/fs/remote-fs.js')).href)
const { watchFailureVerdict, watchRecoveryDelay } = await import(pathToFileURL(path.join(pluginRoot, 'lib/engine/reconnect.js')).href)

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


  totalPassed += passed
  totalFailures += failures
})()

console.log(`\n=== ${totalPassed} passed, ${totalFailures} failed ===`)
if (totalFailures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}