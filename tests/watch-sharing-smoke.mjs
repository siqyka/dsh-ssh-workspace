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

import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
  process.exit(0)
}
process.env.DSH_PEER_ROOT = [coreRoot, process.env.DSH_PEER_ROOT].filter(Boolean).join(path.delimiter)

const { RemoteFileSystem } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'remote-fs.js')).href)

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
      const { HostConfigStore } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'store.js')).href)
      const { HostStore } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'hosts.js')).href)
      const { SshWorkspaceEngine } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'engine.js')).href)

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

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
if (failures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}
