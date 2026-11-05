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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
const { isExposedBind } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'reverse-forward.js')).href)

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
  process.exit(failures.length > 0 ? 1 : 0)
}

const { startFakeSshServer } = await import(pathToFileURL(path.join(supportDir, 'fake-ssh-server.mjs')).href)
const { HostConfigStore } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'store.js')).href)
const { HostStore } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'hosts.js')).href)
const { SshWorkspaceEngine } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'engine.js')).href)
const { ReverseForwardManager } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'reverse-forward.js')).href)

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
    check('the host is listening', server.reversePorts.includes(bound), JSON.stringify(server.reversePorts))

    const closed = manager.close(forward.id)
    check('close() reports it closed one', closed === true, String(closed))
    // Server-side state, so this is a real round trip: the bind is gone only
    // when the cancel request landed.
    const released = await waitFor(() => !server.reversePorts.includes(bound))
    check('the host stopped listening', released, JSON.stringify(server.reversePorts))
    check('and the manager no longer lists it', manager.list().length === 0,
      JSON.stringify(manager.list()))
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

console.log(`\n=== ${passed} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
