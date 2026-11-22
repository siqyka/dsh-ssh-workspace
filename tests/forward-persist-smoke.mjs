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

import { createConnection, createServer } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { fakeForwardEngine } from './support/fake-forward-engine.mjs'

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

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
process.exit(failures === 0 ? 0 : 1)
