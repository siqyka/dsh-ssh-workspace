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

import { createConnection, createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { fakeForwardEngine } from './support/fake-forward-engine.mjs'

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

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
process.exit(failures === 0 ? 0 : 1)
