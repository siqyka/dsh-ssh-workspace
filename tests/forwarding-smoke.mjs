/**
 * Port forwarding: bytes, the remote listener, and the saved intent.
 *
 * Three faces of one feature:
 *   - forward — a real local listener and a real loopback server, so the
 *     property under test is bytes actually arriving;
 *   - reverse-forward — the listener is REMOTE server state, and the failures
 *     that matter are about that state outliving what it belongs to;
 *   - forward-persist — `ForwardManager` is memory-only by design; the INTENT
 *     is what survives a restart, so its invariants (pinned local port, drop
 *     an entry with no fixed port) are asserted against the store.
 *
 * Run: node tests/forwarding-smoke.mjs
 */

import { createConnection, createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fakeForwardEngine } from './support/fake-forward-engine.mjs'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'

let totalPassed = 0
let totalFailures = 0

// ---------------------------------------------------------------------------
// forward-smoke.mjs
// ---------------------------------------------------------------------------
await (async () => {
/**
 * Forwarding checks: the tunnel must actually carry bytes, and it must not
 * outlive the connection that carries it.
 *
 * These open a real local listener and a real loopback "remote" server, then
 * speak TCP through the forward, so the properties under test are the ones a
 * user feels:
 *
 * - bytes reach the far side and come back (a real splice, not a stub);
 * - a second `open` for the same target reuses the entry instead of binding a
 *   second listener;
 * - an ephemeral request (`localPort: 0`) reports the port it actually bound;
 * - `close` releases the local port, so a later bind on it succeeds;
 * - a transport drop tears the forward down instead of leaving a dead listener.
 *
 * Run: node tests/forward-smoke.mjs
 */
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { ForwardManager } = await import(pathToFileURL(path.join(pluginRoot, 'lib/forward/forward.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/**
 * An engine double whose "SSH connection" is a fake client, and whose
 * `forwardOut` dials a real loopback TCP server.
 *
 * `forwardOut` is the ssh2 seam the manager uses to reach the far side, so
 * wiring it to a real socket makes the whole splice path real code while
 * needing no SSH host.
 */

/** Start a loopback echo server; resolves to {port, close}. */
async function startEchoServer () {
  const sockets = new Set()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.pipe(socket)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    port: server.address().port,
    disable: () => { /* retained for symmetry */ },
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** Dial a local port, send one payload, and resolve with what came back. */
function roundTrip (port, payload, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let received = Buffer.alloc(0)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`no reply within ${timeoutMs}ms`))
    }, timeoutMs)
    socket.once('connect', () => socket.write(payload))
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk])
      if (received.length >= payload.length) {
        clearTimeout(timer)
        socket.end()
        resolve(received)
      }
    })
    socket.on('error', (error) => { clearTimeout(timer); reject(error) })
  })
}

console.log('\n=== forward smoke ===\n')

const echo = await startEchoServer()
try {
  // --- bytes actually travel through the tunnel ---------------------------
  {
    const { engine, state, record } = fakeForwardEngine(echo.port)
    const forwards = new ForwardManager({ engine })
    const opened = await forwards.open('alpha', { remotePort: echo.port, localPort: 0 })
    check('open reports the port it bound', Number.isInteger(opened.localPort) && opened.localPort > 0, JSON.stringify(opened.localPort))
    check('open reports the target it mapped', opened.remotePort === echo.port && opened.alias === 'alpha', JSON.stringify(opened))

    const echoed = await roundTrip(opened.localPort, Buffer.from('ping-through-the-tunnel'))
    check('bytes round-trip through the forward', echoed.toString() === 'ping-through-the-tunnel', JSON.stringify(echoed.toString()))
    check('the forward dialled the far side once', state.forwardOutCalls.length === 1, JSON.stringify(state.forwardOutCalls))
    check('the dial targets the requested remote port', state.forwardOutCalls[0]?.dstPort === echo.port, JSON.stringify(state.forwardOutCalls[0]))

    // The forward pins its connection: the idle sweeper must not reap it.
    check('open holds the connection', record.holds === 1, String(record.holds))
    forwards.dispose()
  }

  // --- repeating the same target reuses the entry --------------------------
  {
    const { engine } = fakeForwardEngine(echo.port)
    const forwards = new ForwardManager({ engine })
    const first = await forwards.open('beta', { remotePort: echo.port, localPort: 0 })
    const second = await forwards.open('beta', { remotePort: echo.port, localPort: 0 })
    check('a repeated open is marked reused', second.reused === true, JSON.stringify(second.reused))
    check('a repeated open returns the same forward id', second.id === first.id, `${first.id} vs ${second.id}`)
    check('only one forward is listed', forwards.list().length === 1, String(forwards.list().length))
    forwards.dispose()
  }

  // --- opening a forward connects an idle host -----------------------------
  //
  // Requirement: "opening a port connects if the SSH host is not connected".
  // The manager must reach for the connection itself rather than assuming one
  // exists — asserted through `acquire`, which is the only way a real engine
  // establishes one.
  {
    const { engine, state } = fakeForwardEngine(echo.port)
    const forwards = new ForwardManager({ engine })
    check('no connection was taken before the forward', state.acquireCalls === 0, String(state.acquireCalls))
    const opened = await forwards.open('theta', { remotePort: echo.port, localPort: 0 })
    check('opening a forward acquires a connection', state.acquireCalls === 1, String(state.acquireCalls))
    check('opening a forward on an idle host succeeds', opened.state === 'open', JSON.stringify(opened))
    forwards.dispose()
  }

  // --- closing a forward does not close the host ---------------------------
  //
  // The other direction of the same requirement: a tunnel going away is not a
  // reason to drop the connection, so closing must never reach for it.
  {
    const { engine, state } = fakeForwardEngine(echo.port)
    const forwards = new ForwardManager({ engine })
    const opened = await forwards.open('iota', { remotePort: echo.port, localPort: 0 })
    const afterOpen = state.acquireCalls
    forwards.close(opened.id)
    check('closing a forward does not acquire or drop a connection', state.acquireCalls === afterOpen, String(state.acquireCalls))
    forwards.dispose()
  }

  // --- close releases the local port --------------------------------------
  {
    const { engine, state, record } = fakeForwardEngine(echo.port)
    const forwards = new ForwardManager({ engine })
    const opened = await forwards.open('gamma', { remotePort: echo.port, localPort: 0 })
    check('close reports the id existed', forwards.close(opened.id) === true)
    check('close removes the forward from the list', forwards.list().length === 0, String(forwards.list().length))
    check('close releases the connection hold', record.holds === 0, String(record.holds))
    check('closing an unknown id reports false', forwards.close(opened.id) === false)

    // The port must be bindable again: a leaked listener would answer here.
    let rebound = false
    const probe = createServer(() => {})
    await new Promise((resolve) => {
      probe.once('error', () => { rebound = false; resolve() })
      probe.listen(opened.localPort, '127.0.0.1', () => { rebound = true; resolve() })
    })
    check('close released the local port', rebound === true, `port ${opened.localPort}`)
    await new Promise((resolve) => probe.close(resolve))
    forwards.dispose()
  }

  // --- a transport drop tears the forward down -----------------------------
  {
    const { engine, state, record } = fakeForwardEngine(echo.port)
    const forwards = new ForwardManager({ engine })
    const opened = await forwards.open('delta', { remotePort: echo.port, localPort: 0 })
    check('the forward is open before the drop', forwards.list().length === 1)
    // Simulate ssh2 reporting the connection gone.
    record.client.emit('close')
    check('a dropped connection removes the forward', forwards.list().length === 0, String(forwards.list().length))
    check('a dropped connection releases the hold', record.holds === 0, String(record.holds))
    check('the local port is closed after the drop', await new Promise((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port: opened.localPort })
      socket.once('connect', () => { socket.destroy(); resolve(false) })
      socket.once('error', () => resolve(true))
    }) === true)
    forwards.dispose()
  }

  // --- closeForAlias tears down exactly one host's tunnels -----------------
  //
  // The disconnect route calls this so dropping a host takes its forwards with
  // it. Asserted per-alias rather than globally: another host's tunnels must
  // survive, or disconnecting one machine would silently break another's.
  {
    const { engine, state, record } = fakeForwardEngine(echo.port)
    const forwards = new ForwardManager({ engine })
    // Two DIFFERENT targets: repeating one target is deliberately a reuse, so
    // the same remote port would only ever produce one entry.
    await forwards.open('kappa', { remotePort: echo.port, localPort: 0 })
    await forwards.open('kappa', { remotePort: echo.port + 1, localPort: 0 })
    check('two distinct targets produced two forwards', forwards.list().length === 2, String(forwards.list().length))
    const closed = forwards.closeForAlias('kappa', 'SSH connection closed')
    check('closeForAlias reports how many it closed', closed === 2, String(closed))
    check('closeForAlias removed them from the list', forwards.list().length === 0, String(forwards.list().length))
    check('closeForAlias released every hold', record.holds === 0, String(record.holds))
    check('closeForAlias on an unknown alias closes nothing', forwards.closeForAlias('nobody') === 0)
    forwards.dispose()
  }

  // --- closeForAlias leaves other hosts alone ------------------------------
  {
    // Two aliases, two records: the manager must pick by alias, not by record.
    const { engine: engineA, record: recordA } = fakeForwardEngine(echo.port)
    const { engine: engineB, record: recordB } = fakeForwardEngine(echo.port)
    const records = { alpha: recordA, beta: recordB }
    const engine = { async acquire (alias) { return records[alias] } }
    const forwards = new ForwardManager({ engine })
    await forwards.open('alpha', { remotePort: echo.port, localPort: 0 })
    await forwards.open('beta', { remotePort: echo.port, localPort: 0 })
    const closed = forwards.closeForAlias('alpha')
    check('closeForAlias closes only the named host', closed === 1, String(closed))
    check('the other host keeps its forward', forwards.list().length === 1 && forwards.list()[0].alias === 'beta',
      JSON.stringify(forwards.list()))
    check('the other host keeps its hold', recordB.holds === 1, String(recordB.holds))
    check('the named host released its hold', recordA.holds === 0, String(recordA.holds))
    forwards.dispose()
  }

  // --- port validation ----------------------------------------------------
  {
    const { engine } = fakeForwardEngine(echo.port)
    const forwards = new ForwardManager({ engine })
    let rejected
    try { await forwards.open('epsilon', { remotePort: 70000 }) } catch (error) { rejected = error }
    check('an out-of-range remote port is refused', rejected !== undefined, String(rejected))
    let missingAlias
    try { await forwards.open('', { remotePort: 8080 }) } catch (error) { missingAlias = error }
    check('a missing alias is refused', missingAlias !== undefined, String(missingAlias))
    forwards.dispose()
  }

  // --- disposed manager refuses to open ----------------------------------
  {
    const { engine } = fakeForwardEngine(echo.port)
    const forwards = new ForwardManager({ engine })
    forwards.dispose()
    let refused
    try { await forwards.open('zeta', { remotePort: echo.port, localPort: 0 }) } catch (error) { refused = error }
    check('a disposed manager refuses new forwards', refused !== undefined, String(refused))
  }
} finally {
  await echo.close()
}


  totalPassed += passed
  totalFailures += failures
})()

// ---------------------------------------------------------------------------
// reverse-forward-smoke.mjs
// ---------------------------------------------------------------------------
await (async () => {
/**
 * Reverse forwarding (`ssh -R`) over real sockets.
 *
 * The direction is what makes this suite different from `forward-smoke`: there
 * the listener is local, so a stub can prove the wiring. Here the listener is
 * REMOTE server state, and the interesting failures are all about that state
 * outliving what it belongs to:
 *
 *  - the port is bound on the host, and the host must be told to release it;
 *  - a connection arriving THERE must be turned into a connection to a service
 *    HERE, and the bytes must survive the round trip in both directions;
 *  - the local target being DOWN must close the remote caller's channel rather
 *    than leave it hanging;
 *  - a bound port on a non-loopback address is exposed to everyone who can
 *    reach that host, and the description has to say so.
 *
 * Run: node tests/reverse-forward-smoke.mjs
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const supportDir = path.join(here, 'support')

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

console.log('\n=== reverse forward smoke ===\n')

// `isExposedBind` is pure, so it runs even without ssh2. The rest needs a real
// transport, because the subject is server-side listening state.
const { isExposedBind } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'forward', 'forward.js')).href)

console.log('[1] which bind addresses expose the tunnel beyond the host')
{
  for (const loopback of ['127.0.0.1', 'localhost', '::1', '[::1]', '127.0.0.5', '']) {
    check(`${JSON.stringify(loopback)} is loopback-only`, isExposedBind(loopback) === false,
      String(isExposedBind(loopback)))
  }
  for (const exposed of ['0.0.0.0', '::', '192.168.1.10', 'example.com', '10.0.0.1']) {
    check(`${JSON.stringify(exposed)} is exposed`, isExposedBind(exposed) === true,
      String(isExposedBind(exposed)))
  }
}

let realSsh2 = false
try {
  const ssh2 = createRequire(`${pluginRoot}/package.json`)('ssh2')
  realSsh2 = typeof ssh2.Server === 'function'
} catch {
  realSsh2 = false
}
if (!realSsh2) {
  console.log('  SKIP  no real ssh2 is resolvable from this checkout')
  console.log(`\n=== ${passed} passed, ${failures.length} failed, 1 suite skipped ===`)
  totalPassed += passed
  totalFailures += failures.length
  return
}

const { startFakeSshServer } = await import(pathToFileURL(path.join(supportDir, 'fake-ssh-server.mjs')).href)
const { HostConfigStore } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'hosts', 'store.js')).href)
const { HostStore } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'hosts', 'hosts.js')).href)
const { SshWorkspaceEngine } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'engine', 'engine.js')).href)
const { ReverseForwardManager } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'forward', 'forward.js')).href)

const cleanups = []
const track = (fn) => { cleanups.push(fn) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor (predicate, timeout = 2_000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await predicate()) return true
    await sleep(20)
  }
  return false
}

function engineFor (server) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-rfwd-'))
  track(() => rmSync(dir, { recursive: true, force: true }))
  const storeFile = path.join(dir, 'hosts.json')
  writeFileSync(storeFile, JSON.stringify({
    version: 1,
    hosts: [{ alias: 'fake', host: '127.0.0.1', port: server.port, user: 'tester', auth: { kind: 'password', password: 'sekret' } }],
  }, null, 2), 'utf8')
  const store = new HostStore(path.join(dir, 'no-ssh-config'), new HostConfigStore(storeFile))
  const engine = new SshWorkspaceEngine({ store, reconnect: false, sweepIntervalMs: 3_600_000 })
  track(() => engine.dispose())
  return engine
}

/** A local TCP service that answers a fixed greeting and echoes one line. */
async function startLocalService () {
  const sockets = new Set()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => { /* surfaced through close */ })
    socket.write('LOCAL-SERVICE\n')
    socket.on('data', (chunk) => { socket.write(`echo:${chunk.toString('utf8')}`) })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  track(async () => {
    for (const socket of sockets) { try { socket.destroy() } catch { /* gone */ } }
    await new Promise((resolve) => server.close(resolve))
  })
  return { server, port: server.address().port }
}

/**
 * Dial a port and report HOW the connection ended: 'closed' or 'timeout'.
 *
 * The distinction a payload collector cannot make. A dead local target and a
 * hung tunnel both produce zero bytes; only the close reason separates "the
 * plugin did its job" from "nothing ever happened".
 *
 * @param {number} port - port to dial.
 * @param {number} timeout - how long to wait before calling it a timeout.
 * @returns {Promise<'closed' | 'timeout'>} the ending.
 */
function dialOutcome (port, timeout) {
  return new Promise((resolve) => {
    const socket = new (createRequire(`${pluginRoot}/package.json`)('node:net').Socket)()
    let settled = false
    const finish = (outcome) => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch { /* gone */ }
      resolve(outcome)
    }
    socket.setTimeout(timeout, () => finish('timeout'))
    socket.on('error', () => finish('closed'))
    socket.on('close', () => finish('closed'))
    socket.connect(port, '127.0.0.1')
  })
}

/**
 * Dial a port through the tunnel, optionally send one line, and collect the reply.
 *
 * The send happens ONCE (`sent` guard): an earlier version re-sent on every
 * chunk because the greeting stayed in the buffer, and the local echo service
 * answered each one — an endless loop that hung the suite instead of failing
 * it. A test helper that can hang is worse than one that fails, because the
 * runner reports it as "no result" rather than as a wrong result.
 */
function dial (port, payload, timeout = 2_000) {
  return new Promise((resolve) => {
    const socket = new (createRequire(`${pluginRoot}/package.json`)('node:net').Socket)()
    let received = ''
    let sent = false
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch { /* gone */ }
      resolve(received)
    }
    socket.setTimeout(timeout, finish)
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8')
      if (payload === undefined) {
        // No payload means "just see whether anything arrives at all".
        finish()
        return
      }
      if (!sent && received.includes('LOCAL-SERVICE')) {
        sent = true
        socket.write(payload)
        return
      }
      if (received.includes(`echo:${payload}`)) finish()
    })
    socket.on('error', finish)
    socket.on('close', finish)
    socket.connect(port, '127.0.0.1')
  })
}

try {
  // ============================================ [2] the tunnel carries bytes
  console.log('\n[2] a remote connection reaches the local service')
  {
    const server = await startFakeSshServer({ pluginRoot, password: 'sekret', allowReverseForwarding: true })
    track(() => server.close())
    const engine = engineFor(server)
    const local = await startLocalService()
    const manager = new ReverseForwardManager({ engine })
    track(() => manager.dispose())

    const forward = await manager.open('fake', { localPort: local.port, remotePort: 0 })
    // Same guarantee as a local forward: the tunnel exists for this listener,
    // so the idle sweeper must not reap the only connection carrying it.
    const pinned = engine.pool.get('fake')
    check('a reverse forward pins its connection', pinned?.holds === 1, String(pinned?.holds))
    check('the request reached the host', server.reverseRequests.length === 1,
      JSON.stringify(server.reverseRequests))
    check('the host bound a port', typeof forward.remotePort === 'number' && forward.remotePort > 0,
      String(forward.remotePort))
    check('the bound port is the one the server reports',
      server.reversePorts.includes(forward.remotePort), JSON.stringify(server.reversePorts))
    check('the description says reverse', forward.direction === 'reverse', JSON.stringify(forward))
    check('loopback bind is not reported as exposed', forward.exposed === false, JSON.stringify(forward))

    // Connect to the REMOTE listener: a process on the host would do exactly this.
    const received = await dial(forward.remotePort, 'ping')
    check('a remote connection reached the local service',
      received.includes('LOCAL-SERVICE'), JSON.stringify(received))
    check('and its reply came back through the tunnel',
      received.includes('echo:ping'), JSON.stringify(received))
    check('the host counted the connection', server.reverseConnections === 1,
      String(server.reverseConnections))
    check('the manager counts it too', manager.list()[0]?.connections === 1,
      JSON.stringify(manager.list()))
  }

  // ================================ [3] closing releases the REMOTE listener
  console.log('\n[3] closing the forward releases the port on the host')
  {
    const server = await startFakeSshServer({ pluginRoot, password: 'sekret', allowReverseForwarding: true })
    track(() => server.close())
    const engine = engineFor(server)
    const local = await startLocalService()
    const manager = new ReverseForwardManager({ engine })
    track(() => manager.dispose())

    const forward = await manager.open('fake', { localPort: local.port, remotePort: 0 })
    const bound = forward.remotePort
    const record = engine.pool.get('fake')
    check('the host is listening', server.reversePorts.includes(bound), JSON.stringify(server.reversePorts))

    const closed = manager.close(forward.id)
    check('close() reports it closed one', closed === true, String(closed))
    check('close releases the connection hold', record?.holds === 0, String(record?.holds))
    // Server-side state, so this is a real round trip: the bind is gone only
    // when the cancel request landed.
    const released = await waitFor(() => !server.reversePorts.includes(bound))
    check('the host stopped listening', released, JSON.stringify(server.reversePorts))
    check('and the manager no longer lists it', manager.list().length === 0,
      JSON.stringify(manager.list()))
  }

  // ================== [3.5] a dead connection stops claiming the tunnel
  console.log('\n[3.5] a dropped connection removes the reverse entry')
  {
    const server = await startFakeSshServer({ pluginRoot, password: 'sekret', allowReverseForwarding: true })
    track(() => server.close())
    const engine = engineFor(server)
    const local = await startLocalService()
    const manager = new ReverseForwardManager({ engine })
    track(() => manager.dispose())

    const forward = await manager.open('fake', { localPort: local.port, remotePort: 0 })
    const record = engine.pool.get('fake')
    check('the tunnel is open before the drop', manager.list().length === 1, JSON.stringify(manager.list()))

    // Tearing the pooled connection down is what an idle sweep or a network
    // drop does; the remote bind dies with the session, so the entry must not
    // keep reporting `open`.
    engine.closeRecord('fake', record)
    const gone = await waitFor(() => manager.list().length === 0)
    check('a dropped connection removes the reverse entry', gone, JSON.stringify(manager.list()))
    check('a dropped connection releases the hold', record?.holds === 0, String(record?.holds))
    // The remote bind goes with the SSH session; the fake server does not model
    // session teardown, so that half is asserted against a real host instead.
  }

  // ============================ [4] a dead local target closes the channel
  console.log('\n[4] a dead local target closes the remote channel instead of hanging')
  {
    const server = await startFakeSshServer({ pluginRoot, password: 'sekret', allowReverseForwarding: true })
    track(() => server.close())
    const engine = engineFor(server)
    // A port nothing listens on: bind then immediately close, keeping the number.
    const probe = createServer()
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const deadPort = probe.address().port
    await new Promise((resolve) => probe.close(resolve))

    const manager = new ReverseForwardManager({ engine })
    track(() => manager.dispose())
    const forward = await manager.open('fake', { localPort: deadPort, remotePort: 0 })

    // HOW it ended is the whole point, and an empty payload cannot tell the
    // two apart: a channel closed by the plugin and a socket abandoned by the
    // test both read as "nothing arrived". So the case measures WHEN the close
    // happened, against a prompt that is deliberately longer than the plugin's
    // own reaction. A hang would burn the full timeout; a closed channel ends
    // almost immediately.
    const started = Date.now()
    const outcome = await dialOutcome(forward.remotePort, 3_000)
    const elapsed = Date.now() - started
    check('the remote caller got a CLOSED channel',
      outcome === 'closed', `${outcome} after ${elapsed}ms`)
    check('and it closed promptly, not at the timeout',
      elapsed < 1_500, `${elapsed}ms`)
    check('the host saw the attempt', server.reverseConnections === 1,
      String(server.reverseConnections))
  }

  // ============================ [5] a server that refuses the bind says so
  console.log('\n[5] a host that refuses to listen fails loudly')
  {
    const server = await startFakeSshServer({ pluginRoot, password: 'sekret' })
    track(() => server.close())
    const engine = engineFor(server)
    const local = await startLocalService()
    const manager = new ReverseForwardManager({ engine })
    track(() => manager.dispose())

    let error
    try {
      await manager.open('fake', { localPort: local.port, remotePort: 0 })
    } catch (failure) {
      error = failure
    }
    check('the refusal is an error', error !== undefined, error === undefined ? 'succeeded anyway' : '')
    check('and it names the address it tried',
      /refused to listen/u.test(String(error?.message ?? '')), String(error?.message))
    check('nothing is left registered', manager.list().length === 0, JSON.stringify(manager.list()))
  }

  // ============================ [6] a non-loopback bind is reported as exposed
  console.log('\n[6] binding beyond loopback is reported as exposed')
  {
    const server = await startFakeSshServer({ pluginRoot, password: 'sekret', allowReverseForwarding: true })
    track(() => server.close())
    const engine = engineFor(server)
    const local = await startLocalService()
    const manager = new ReverseForwardManager({ engine })
    track(() => manager.dispose())

    // The fake server binds the loopback interface regardless (it is a test
    // double), so what is asserted here is the DESCRIPTION — which is the half
    // the user reads before deciding whether to keep the tunnel open.
    const forward = await manager.open('fake', { localPort: local.port, remotePort: 0, remoteHost: '0.0.0.0' })
    check('the description marks it exposed', forward.exposed === true, JSON.stringify(forward))
    check('and the diagnostics say so too',
      engine.diagnostics.list(20).some(entry => /exposed beyond the remote host/u.test(entry.message)),
      JSON.stringify(engine.diagnostics.list(20).map(entry => entry.message)))
  }
} finally {
  for (const cleanup of cleanups.reverse()) {
    try { await cleanup() } catch { /* best effort */ }
  }
}


  totalPassed += passed
  totalFailures += failures.length
})()

// ---------------------------------------------------------------------------
// forward-persist-smoke.mjs
// ---------------------------------------------------------------------------
await (async () => {
/**
 * Saved port-forward checks: the durable half of the tunnel surface.
 *
 * `ForwardManager` is memory-only by design — a tunnel outliving its SSH
 * connection would be a dead pipe. The *intent* is what must survive a restart,
 * so these tests pin the invariants that make a saved mapping trustworthy:
 *
 * - a saved mapping pins its local port and refuses to drift onto another one
 *   (the stored URL names that port);
 * - the store's `forwards` section round-trips, survives a foreign rewrite, and
 *   does not disturb `hosts` / `secrets` / `knownHosts`;
 * - a stored entry with no fixed local port is dropped rather than restored as
 *   something the user never asked for;
 * - auto-start does nothing unless the preference is on, opens only entries
 *   whose intent is "on", and reports failures instead of throwing;
 * - the panel's row labels runtime truth (live / not live) separately from the
 *   stored intent (enabled), which is what keeps a button from lying.
 *
 * Run: node tests/forward-persist-smoke.mjs
 */
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { ForwardManager, probeLocalPort, joinForwards } = await import(pathToFileURL(path.join(pluginRoot, 'lib/forward/forward.js')).href)
const { HostConfigStore, forwardsOf } = await import(pathToFileURL(path.join(pluginRoot, 'lib/hosts/store.js')).href)
const { SavedForwardManager } = await import(pathToFileURL(path.join(pluginRoot, 'lib/forward/forward.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== forward persist smoke ===\n')

/** An engine double whose `forwardOut` dials a real loopback server. */

/** A temporary store file plus its directory, cleaned up by the caller. */
function makeStore () {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-forward-persist-'))
  const file = path.join(dir, 'dsh-ssh.json')
  return { dir, file, store: new HostConfigStore(file), dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

/** A fresh controller over one store and one engine double. */
function makeController (store, record) {
  const forwards = new ForwardManager({ engine: record.engine })
  const saved = new SavedForwardManager({ forwards, store })
  forwards.onClosed = (entry, reason) => { saved.noteClosed(entry, reason) }
  return { forwards, saved }
}

const echo = await startEcho()

/** A loopback echo server, so a splice really carries bytes. */
async function startEcho () {
  const sockets = new Set()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.pipe(socket)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    port: server.address().port,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

try {
  // --- the store's forwards section round-trips ---------------------------
  {
    const { store, file, dispose } = makeStore()
    try {
      check('an empty store has no saved forwards', store.forwards().items.length === 0)
      check('autoStart defaults to off', store.forwards().settings.autoStart === false)

      store.putForward({ id: 'fwd-aaaa', alias: 'alpha', remotePort: 5173, localPort: 5173, enabled: true })
      const saved = store.forwards().items
      check('a saved forward is written', saved.length === 1 && saved[0].id === 'fwd-aaaa', JSON.stringify(saved))
      check('a saved forward keeps its ports', saved[0].remotePort === 5173 && saved[0].localPort === 5173, JSON.stringify(saved[0]))
      check('an unspecified host defaults to loopback',
        saved[0].remoteHost === '127.0.0.1' && saved[0].localHost === '127.0.0.1', JSON.stringify(saved[0]))

      // Re-saving the same id updates in place instead of appending a twin.
      store.putForward({ id: 'fwd-aaaa', alias: 'alpha', remotePort: 5174, localPort: 5174, enabled: false })
      const updated = store.forwards().items
      check('re-saving the same id replaces the entry', updated.length === 1, JSON.stringify(updated))
      check('re-saving updates the ports', updated[0].remotePort === 5174 && updated[0].localPort === 5174, JSON.stringify(updated[0]))
      check('re-saving updates the intent', updated[0].enabled === false, JSON.stringify(updated[0]))

      check('setForwardEnabled flips the intent', store.setForwardEnabled('fwd-aaaa', true) === true
        && store.forwards().items[0].enabled === true)
      check('setForwardEnabled reports a missing id', store.setForwardEnabled('fwd-nope', true) === false)

      store.setForwardAutoStart(true)
      check('autoStart is stored', store.forwards().settings.autoStart === true)

      // Sections this plugin does not own, and the host list it shares, must
      // both survive a forwards write.
      const doc = JSON.parse(readFileSync(file, 'utf8'))
      doc.foreignSection = { keep: true }
      doc.hosts = [{ alias: 'gamma', host: 'gamma.example', port: 22, user: 'u', auth: { kind: 'agent' } }]
      doc.secrets = { gamma: { password: 'ciphertext' } }
      writeFileSync(file, JSON.stringify(doc, null, 2))
      store.putForward({ id: 'fwd-bbbb', alias: 'beta', remotePort: 8080, localPort: 8080, enabled: true })
      const after = JSON.parse(readFileSync(file, 'utf8'))
      check('a foreign section survives a forwards write', after.foreignSection?.keep === true)
      check('the host list survives a forwards write',
        Array.isArray(after.hosts) && after.hosts[0]?.alias === 'gamma', JSON.stringify(after.hosts))
      check('the secrets section survives a forwards write',
        after.secrets?.gamma?.password === 'ciphertext', JSON.stringify(after.secrets))
      check('two saved forwards coexist', store.forwards().items.length === 2, JSON.stringify(store.forwards().items.map(i => i.id)))

      check('deleteForward removes one', store.deleteForward('fwd-bbbb') === true && store.forwards().items.length === 1)
      check('deleteForward reports a missing id', store.deleteForward('fwd-bbbb') === false)
      check('deleting a forward leaves autoStart alone', store.forwards().settings.autoStart === true)
    } finally { dispose() }
  }

  // --- malformed sections degrade instead of throwing ---------------------
  {
    check('a non-object forwards section reads as empty',
      forwardsOf({ forwards: 'nope' }).items.length === 0
      && forwardsOf({ forwards: 'nope' }).settings.autoStart === false)
    check('a forward with no local port is dropped, not restored',
      forwardsOf({ forwards: { items: [{ id: 'x', alias: 'a', remotePort: 80 }] } }).items.length === 0,
      JSON.stringify(forwardsOf({ forwards: { items: [{ id: 'x', alias: 'a', remotePort: 80 }] } }).items))
    check('a forward with a port 0 is dropped',
      forwardsOf({ forwards: { items: [{ id: 'x', alias: 'a', remotePort: 80, localPort: 0 }] } }).items.length === 0)
    check('a forward with no id is dropped',
      forwardsOf({ forwards: { items: [{ alias: 'a', remotePort: 80, localPort: 80 }] } }).items.length === 0)
    check('a usable entry among damaged ones is kept',
      forwardsOf({ forwards: { items: [{ alias: 'a', remotePort: 80, localPort: 80 }, { id: 'y', alias: 'b', remotePort: 9, localPort: 9 }] } }).items.length === 1)
  }

  // --- port probe ---------------------------------------------------------
  {
    const busy = await new Promise((resolve) => {
      const server = createServer(() => {})
      server.listen(0, '127.0.0.1', () => resolve(server))
    })
    const busyPort = busy.address().port
    const taken = await probeLocalPort('127.0.0.1', busyPort)
    check('the probe reports a busy port as unavailable', taken.ok === false, JSON.stringify(taken))
    check('the probe names EADDRINUSE', taken.code === 'EADDRINUSE', JSON.stringify(taken.code))
    await new Promise((resolve) => busy.close(resolve))

    // The port just freed must read as available.
    const free = await probeLocalPort('127.0.0.1', busyPort)
    check('the probe reports a free port as available', free.ok === true, JSON.stringify(free))
  }

  // --- create / open / close / remove ------------------------------------
  {
    const { store, dispose } = makeStore()
    try {
      const { record, engine } = fakeForwardEngine(echo.port)
      const { forwards, saved } = makeController(store, { engine })
      const freePort = await pickFreePort()

      const row = await saved.create({ alias: 'alpha', remotePort: echo.port, localPort: freePort })
      check('create returns the joined row', row.persisted === true && row.live === true, JSON.stringify(row))
      check('create binds the requested local port', row.localPort === freePort, `${row.localPort} vs ${freePort}`)
      check('create marks the intent on', row.enabled === true)
      check('create records the runtime connection count', row.connections === 0, String(row.connections))
      check('create persists the mapping', store.forwards().items.length === 1)
      check('create holds the connection', record.holds === 1, String(record.holds))

      const echoed = await roundTrip(freePort, Buffer.from('through-the-saved-tunnel'))
      check('bytes travel through a saved tunnel', echoed.toString() === 'through-the-saved-tunnel', JSON.stringify(echoed.toString()))

      // A second mapping on an occupied port must be refused, and must say so.
      let refused
      try { await saved.create({ alias: 'alpha', remotePort: 9999, localPort: freePort }) } catch (error) { refused = error }
      check('a busy local port is refused', refused !== undefined, String(refused))
      check('the refusal names the port', String(refused?.message ?? '').includes(String(freePort)), String(refused?.message))
      check('a refused mapping is not stored', store.forwards().items.length === 1, JSON.stringify(store.forwards().items.map(i => i.id)))

      // Closing keeps the mapping but turns the intent off.
      const closed = saved.closeById(row.id)
      check('closeById keeps the mapping', store.forwards().items.length === 1)
      check('closeById turns the intent off', closed.enabled === false && closed.live === false, JSON.stringify(closed))
      check('closeById releases the hold', record.holds === 0, String(record.holds))
      check('closeById frees the local port', (await probeLocalPort('127.0.0.1', freePort)).ok === true)

      // Re-enabling binds it again under the same id.
      const reopened = await saved.openById(row.id)
      check('openById rebinds the same local port', reopened.localPort === freePort && reopened.live === true, JSON.stringify(reopened))
      check('openById restores the intent', store.forwards().items[0].enabled === true)
      check('openById keeps one saved row', store.forwards().items.length === 1)

      check('remove closes and forgets', saved.remove(row.id) === true
        && store.forwards().items.length === 0
        && forwards.list().length === 0)
      check('remove releases the hold', record.holds === 0, String(record.holds))
      forwards.dispose()
    } finally { dispose() }
  }

  // --- a saved mapping never silently drifts onto another port -----------
  {
    const { store, dispose } = makeStore()
    try {
      const { engine } = fakeForwardEngine(echo.port)
      const { forwards, saved } = makeController(store, { engine })
      const busy = await new Promise((resolve) => {
        const server = createServer(() => {})
        server.listen(0, '127.0.0.1', () => resolve(server))
      })
      const busyPort = busy.address().port
      let refused
      try {
        await saved.create({ alias: 'alpha', remotePort: echo.port, localPort: busyPort })
      } catch (error) { refused = error }
      await new Promise((resolve) => busy.close(resolve))
      check('a saved mapping on a busy port does not fall back to an ephemeral one', refused !== undefined, String(refused))
      check('a refused mapping is never written to the store', store.forwards().items.length === 0,
        JSON.stringify(store.forwards().items.map(item => item.id)))
      check('the refusal names the port it could not bind',
        String(refused?.message ?? '').includes(String(busyPort)), String(refused?.message))
      forwards.dispose()
    } finally { dispose() }
  }

  // --- a saved mapping is never satisfied by an unrelated live tunnel ----
  //
  // A transient forward to the same target used to be returned by `open()`
  // before the stable id was applied: the saved row was then marked enabled
  // while its own id named no listener, and the stored local port had nothing
  // bound to it. Two tunnels to one target on different local ports are legal,
  // so the fix is to reuse only the id that was asked for.
  {
    const { store, dispose } = makeStore()
    try {
      const { engine } = fakeForwardEngine(echo.port)
      const { forwards, saved } = makeController(store, { engine })
      const transientPort = await pickFreePort()
      const savedPort = await pickFreePort(transientPort)
      const transient = await forwards.open('alpha', { remotePort: echo.port, localPort: transientPort })
      check('the transient tunnel listens on its own port', transient.localPort === transientPort, JSON.stringify(transient))

      const row = await saved.create({ alias: 'alpha', remotePort: echo.port, localPort: savedPort })
      check('the saved row is live', row.live === true, JSON.stringify(row))
      check('the saved row keeps its stored local port', row.localPort === savedPort, JSON.stringify(row))
      const live = forwards.list()
      check('the saved mapping added a second listener instead of reusing the transient one', live.length === 2,
        JSON.stringify(live.map(entry => ({ id: entry.id, localPort: entry.localPort }))))
      const byId = live.find(entry => entry.id === row.id)
      check('a listener exists under the saved id', byId !== undefined, JSON.stringify(live.map(entry => entry.id)))
      check('the transient listener still exists under its own id', live.some(entry => entry.id === transient.id))

      const echoed = await roundTrip(savedPort, Buffer.from('saved-port-is-really-bound'))
      check('bytes travel through the saved id\'s own listener',
        echoed.toString() === 'saved-port-is-really-bound', JSON.stringify(echoed.toString()))
      forwards.dispose()
    } finally { dispose() }
  }

  // --- a bind that fails after the save is recorded, not swallowed -------
  //
  // The probe is advisory: the port can be taken between the check and the
  // bind. That path must still leave the row visible WITH an explanation,
  // because the user cannot retry what the panel silently forgot.
  {
    const { store, dispose } = makeStore()
    try {
      const { engine } = fakeForwardEngine(echo.port)
      const { forwards, saved } = makeController(store, { engine })
      const port = await pickFreePort()
      store.putForward({ id: 'fwd-late', alias: 'alpha', remotePort: echo.port, localPort: port, enabled: true })

      // Occupy the port after it was stored but before it is opened.
      const squatter = await new Promise((resolve) => {
        const server = createServer(() => {})
        server.once('error', () => resolve(undefined))
        server.listen(port, '127.0.0.1', () => resolve(server))
      })
      let refused
      try { await saved.openById('fwd-late') } catch (error) { refused = error }
      if (squatter !== undefined) await new Promise((resolve) => squatter.close(resolve))

      check('a late bind failure is surfaced to the caller', refused !== undefined, String(refused))
      const row = saved.list()[0]
      check('the row survives a failed open', row.persisted === true, JSON.stringify(row))
      check('the row is stored but not live', row.live === false, JSON.stringify(row))
      check('the row reports the failure', typeof row?.error === 'string' && row.error !== '', JSON.stringify(row?.error))
      check('the failed row keeps the intent on', row.enabled === true, JSON.stringify(row.enabled))
      forwards.dispose()
    } finally { dispose() }
  }

  // --- auto-start ---------------------------------------------------------
  {
    const { store, dispose } = makeStore()
    try {
      const { engine } = fakeForwardEngine(echo.port)
      const { forwards, saved } = makeController(store, { engine })
      const portA = await pickFreePort()
      const portB = await pickFreePort(portA)

      // Intent on, preference off: nothing may open.
      store.putForward({ id: 'fwd-on', alias: 'alpha', remotePort: echo.port, localPort: portA, enabled: true })
      let outcome = await saved.autoStart()
      check('auto-start does nothing while the preference is off', outcome.opened === 0 && forwards.list().length === 0, JSON.stringify(outcome))

      store.setForwardAutoStart(true)
      // Intent off for the second entry: it must stay closed.
      store.putForward({ id: 'fwd-off', alias: 'alpha', remotePort: echo.port, localPort: portB, enabled: false })
      outcome = await saved.autoStart()
      check('auto-start opens only entries whose intent is on', outcome.opened === 1, JSON.stringify(outcome))
      check('auto-start leaves intent-off entries closed',
        forwards.list().some(entry => entry.id === 'fwd-on') && !forwards.list().some(entry => entry.id === 'fwd-off'),
        JSON.stringify(forwards.list().map(entry => entry.id)))
      const live = forwards.list().find(entry => entry.id === 'fwd-on')
      check('auto-start binds the saved local port', live?.localPort === portA, String(live?.localPort))

      // Running it again must not stack listeners.
      const again = await saved.autoStart()
      check('auto-start is idempotent', forwards.list().filter(entry => entry.id === 'fwd-on').length === 1,
        JSON.stringify(forwards.list().map(entry => entry.id)))
      check('a second auto-start reports the reuse rather than a new bind', again.opened === 1, JSON.stringify(again))
      forwards.dispose()
    } finally { dispose() }
  }

  // --- auto-start reports a failure instead of throwing -------------------
  {
    const { store, dispose } = makeStore()
    try {
      const { engine } = fakeForwardEngine(echo.port)
      const { forwards, saved } = makeController(store, { engine })
      const busy = await new Promise((resolve) => {
        const server = createServer(() => {})
        server.listen(0, '127.0.0.1', () => resolve(server))
      })
      const busyPort = busy.address().port
      store.setForwardAutoStart(true)
      store.putForward({ id: 'fwd-busy', alias: 'alpha', remotePort: echo.port, localPort: busyPort, enabled: true })
      let threw
      let outcome
      try { outcome = await saved.autoStart() } catch (error) { threw = error }
      await new Promise((resolve) => busy.close(resolve))
      check('auto-start does not throw when a mapping cannot bind', threw === undefined, String(threw))
      check('auto-start reports the failure', outcome?.failed.length === 1 && outcome.failed[0].id === 'fwd-busy', JSON.stringify(outcome))
      check('a failed auto-start leaves no listener', forwards.list().length === 0, JSON.stringify(forwards.list()))
      check('the failure is retained for the panel', typeof saved.list()[0]?.error === 'string', JSON.stringify(saved.list()[0]))
      forwards.dispose()
    } finally { dispose() }
  }

  // --- connection loss is recorded, intent is kept ------------------------
  {
    const { store, dispose } = makeStore()
    try {
      const { record, engine } = fakeForwardEngine(echo.port)
      const { forwards, saved } = makeController(store, { engine })
      const port = await pickFreePort()
      store.putForward({ id: 'fwd-drop', alias: 'alpha', remotePort: echo.port, localPort: port, enabled: true })
      await saved.openById('fwd-drop')
      check('the forward is live before the drop', saved.list()[0].live === true)

      record.client.emit('close')
      const afterDrop = saved.list()[0]
      check('a dropped connection marks the row not live', afterDrop.live === false, JSON.stringify(afterDrop))
      check('a dropped connection keeps the stored intent', afterDrop.enabled === true, JSON.stringify(afterDrop))
      check('a dropped connection explains itself', String(afterDrop.error).includes('connection'), JSON.stringify(afterDrop.error))
      check('the intent survives in the store', store.forwards().items[0].enabled === true)

      // Reopening clears the recorded failure.
      await saved.openById('fwd-drop')
      check('reopening clears the recorded failure', saved.list()[0].error === undefined, JSON.stringify(saved.list()[0]))
      forwards.dispose()
    } finally { dispose() }
  }

  // --- a deliberate disconnect looks like a manual close ------------------
  //
  // The user's wording: "点击 ssh 断开时，如果端口是开启状态，断开的现象和提示要和
  // 手动断开端口的一致". The two paths reach the same tunnel from different intents,
  // so this pins that they LEAVE it in the same state rather than merely closing
  // the listener. The failure line is the visible half: an unplanned drop says
  // "connection lost", and a deliberate disconnect that reused that path would
  // report a fault the user caused on purpose.
  {
    const { store, dispose } = makeStore()
    try {
      const { record, engine } = fakeForwardEngine(echo.port)
      const { forwards, saved } = makeController(store, { engine })
      const port = await pickFreePort()
      store.putForward({ id: 'fwd-cut', alias: 'alpha', remotePort: echo.port, localPort: port, enabled: true })
      await saved.openById('fwd-cut')
      check('a tunnel is live before the deliberate disconnect', saved.list()[0].live === true)

      const closed = saved.closeAlias('alpha')
      const row = saved.list()[0]
      check('a deliberate disconnect reports the tunnels it closed', closed === 1, String(closed))
      check('a deliberate disconnect stops the listener', row.live === false, JSON.stringify(row))
      check('a deliberate disconnect turns the stored intent off', row.enabled === false, JSON.stringify(row))
      check('a deliberate disconnect leaves no failure to explain', row.error === undefined, JSON.stringify(row.error))
      check('...and the store agrees the intent is off', store.forwards().items[0].enabled === false,
        JSON.stringify(store.forwards().items[0]))
      check('a deliberate disconnect releases the hold', record.holds === 0, String(record.holds))

      // The manual close must land on exactly the same row state, or "same as
      // closing the port by hand" would be an assertion about wording only.
      await saved.openById('fwd-cut')
      const manual = saved.closeById('fwd-cut')
      const deliberate = row
      check('the two paths agree on every field the panel reads',
        JSON.stringify({ live: manual.live, enabled: manual.enabled, error: manual.error })
          === JSON.stringify({ live: deliberate.live, enabled: deliberate.enabled, error: deliberate.error }),
        `manual=${JSON.stringify(manual)} deliberate=${JSON.stringify(deliberate)}`)

      // A transient tunnel has no stored row; it must still be closed, and it
      // must not be counted twice or resurrected as a saved one.
      const transient = await forwards.open('alpha', { remotePort: echo.port, localPort: 0 })
      const withTransient = saved.closeAlias('alpha')
      check('a deliberate disconnect also closes transient tunnels', withTransient === 1, String(withTransient))
      check('...leaving no listener behind', forwards.list().length === 0, JSON.stringify(forwards.list()))
      check('...and not turning the transient tunnel into a saved row',
        store.forwards().items.length === 1, JSON.stringify(store.forwards().items.map(item => item.id)))
      check('closing a host with no tunnels is a no-op', saved.closeAlias('nobody') === 0)

      // An unrelated host's tunnel must survive — this closes by alias, not all.
      await saved.openById('fwd-cut')
      const elsewhere = await forwards.open('beta', { remotePort: echo.port, localPort: 0 })
      check('another host\'s tunnel is untouched', elsewhere.alias === 'beta' && saved.closeAlias('alpha') === 1)
      check('...and it is still live', forwards.list().some(entry => entry.alias === 'beta'))
      forwards.dispose()
    } finally { dispose() }
  }

  // --- remembering a transient forward -----------------------------------
  {
    const { store, dispose } = makeStore()
    try {
      const { engine } = fakeForwardEngine(echo.port)
      const { forwards, saved } = makeController(store, { engine })
      const opened = await forwards.open('alpha', { remotePort: echo.port, localPort: 0 })
      check('a transient forward has an ephemeral local port', opened.localPort > 0)
      check('a transient forward is not persisted', saved.list().length === 1 && saved.list()[0].persisted === false,
        JSON.stringify(saved.list()))

      const remembered = saved.remember(opened.id)
      // `remember` reopens asynchronously; give the microtask queue a turn.
      await new Promise(resolve => setTimeout(resolve, 20))
      check('remember stores the mapping', store.forwards().items.length === 1, JSON.stringify(store.forwards().items))
      check('remember keeps the port that was actually bound',
        store.forwards().items[0].localPort === opened.localPort,
        `${store.forwards().items[0].localPort} vs ${opened.localPort}`)
      check('remember drops the transient id', !saved.list().some(row => row.id === opened.id),
        JSON.stringify(saved.list().map(row => row.id)))
      check('remember leaves exactly one row', saved.list().length === 1, JSON.stringify(saved.list().map(row => row.id)))
      check('remember returns the saved row', remembered.persisted === true, JSON.stringify(remembered))
      forwards.dispose()
    } finally { dispose() }
  }

  // --- the join labels intent and fact separately -------------------------
  {
    const joined = joinForwards(
      {
        settings: { autoStart: false },
        items: [
          { id: 'a', alias: 'h', remoteHost: '127.0.0.1', remotePort: 1, localHost: '127.0.0.1', localPort: 1001, enabled: true },
          { id: 'b', alias: 'h', remoteHost: '127.0.0.1', remotePort: 2, localHost: '127.0.0.1', localPort: 1002, enabled: false },
        ],
      },
      [{ id: 'a', alias: 'h', remoteHost: '127.0.0.1', remotePort: 1, localHost: '127.0.0.1', localPort: 1001, connections: 3 }],
    )
    check('the join keeps every saved row', joined.length === 2, JSON.stringify(joined.map(row => row.id)))
    check('a saved live row reports live', joined[0].live === true && joined[0].persisted === true)
    check('a saved live row keeps its connection count', joined[0].connections === 3, String(joined[0].connections))
    check('a saved closed row reports not live', joined[1].live === false && joined[1].persisted === true)
    check('a saved closed row defaults the connection count to zero', joined[1].connections === 0, String(joined[1].connections))

    const withTransient = joinForwards({ settings: { autoStart: false }, items: [] },
      [{ id: 'fwd-1', alias: 'h', remoteHost: '127.0.0.1', remotePort: 3, localHost: '127.0.0.1', localPort: 1003, connections: 0 }])
    check('a live forward with no saved row is shown as transient',
      withTransient.length === 1 && withTransient[0].persisted === false && withTransient[0].live === true,
      JSON.stringify(withTransient))
  }

  // --- validation ---------------------------------------------------------
  {
    const { store, dispose } = makeStore()
    try {
      const { engine } = fakeForwardEngine(echo.port)
      const { forwards, saved } = makeController(store, { engine })
      for (const [label, input] of [
        ['a zero local port', { alias: 'a', remotePort: 80, localPort: 0 }],
        ['an out-of-range local port', { alias: 'a', remotePort: 80, localPort: 70000 }],
        ['a missing remote port', { alias: 'a', localPort: 80 }],
        ['a missing alias', { remotePort: 80, localPort: 80 }],
      ]) {
        let refused
        try { await saved.create(input) } catch (error) { refused = error }
        check(`${label} is refused`, refused !== undefined, String(refused))
      }
      check('no invalid mapping was stored', store.forwards().items.length === 0, JSON.stringify(store.forwards().items))
      let missing
      try { await saved.openById('fwd-nope') } catch (error) { missing = error }
      check('opening an unknown saved id is refused', missing !== undefined, String(missing))
      forwards.dispose()
    } finally { dispose() }
  }
} finally {
  await echo.close()
}

/** Find a loopback port that is free right now. */
async function pickFreePort (avoid) {
  for (let i = 0; i < 20; i += 1) {
    const port = await new Promise((resolve, reject) => {
      const server = createServer(() => {})
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const bound = server.address().port
        server.close(() => resolve(bound))
      })
    })
    if (avoid === undefined || port !== avoid) return port
  }
  throw new Error('could not find a free loopback port')
}

/** Dial a local port, send one payload, resolve with what came back. */
function roundTrip (port, payload, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let received = Buffer.alloc(0)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`no reply within ${timeoutMs}ms`))
    }, timeoutMs)
    socket.once('connect', () => socket.write(payload))
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk])
      if (received.length >= payload.length) {
        clearTimeout(timer)
        socket.end()
        resolve(received)
      }
    })
    socket.on('error', (error) => { clearTimeout(timer); reject(error) })
  })
}


  totalPassed += passed
  totalFailures += failures
})()

console.log(`\n=== ${totalPassed} passed, ${totalFailures} failed ===`)
if (totalFailures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}