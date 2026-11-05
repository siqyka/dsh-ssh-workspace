/**
 * Real-transport reconnect: the trigger, not the branch.
 *
 * `reconnect-smoke` drives the scheduler with an injected clock and a fake
 * `attempt`; `replay-smoke` and `host-key-smoke` set `record.broken` by hand.
 * All three prove what the code does *after* it learns the connection is dead.
 * None of them proves the connection ever gets reported dead — that is
 * `client.on('close')` firing on a socket the process did not close, and a
 * hand-set boolean cannot exercise it.
 *
 * This suite runs the engine against `tests/support/fake-ssh-server.mjs`, a
 * real ssh2 server on a real TCP socket, and asserts the four timing cases a
 * stub cannot produce:
 *
 *  1. a socket destroyed under a live connection starts the background loop
 *     (nobody is operating, so nothing else would);
 *  2. the loop's success path really restores the host, and the restore hook
 *     runs even when a foreground operation healed the host first;
 *  3. a deliberate close does NOT start the loop — "disconnect" must not
 *     become "keep dialing";
 *  4. a host-key change on the server is refused, and the refusal is fatal
 *     rather than retried forever.
 *
 * Run: node tests/fake-transport-smoke.mjs
 */

import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

console.log('\n=== fake transport smoke ===\n')

// ------------------------------------------------------------------ imports
// This suite needs NO host peer package: `engine.js` imports only local modules,
// and its one external dependency is `ssh2`, which is a real dependency of this
// plugin. The gate is therefore "can a real ssh2 be loaded", not "is a DSH tree
// assembled" — a stub `ssh2` (the runner's peer-stub root supplies one that
// throws on construction) cannot serve a suite whose subject is the socket.
const coreRoot = process.env.DSH_CORE_ROOT
let realSsh2 = false
try {
  const ssh2 = createRequire(`${pluginRoot}/package.json`)('ssh2')
  // The stub marks itself and throws on `new Client()`; the real module has
  // `Server` and `utils.generateKeyPairSync`. Checking for the capability is
  // cheaper than constructing a Client just to discard it.
  realSsh2 = typeof ssh2.Server === 'function' && typeof ssh2.utils?.generateKeyPairSync === 'function'
} catch {
  realSsh2 = false
}
if (!realSsh2) {
  console.log('  SKIP  no real ssh2 is resolvable from this checkout (the peer stub cannot serve this suite)')
  console.log('\n=== 0 passed, 0 failed, 1 suite skipped ===')
  process.exit(0)
}
if (coreRoot === undefined) {
  // Not required, but noted: the engine resolves `@deepseek-ai/dsh-fs` at
  // `requirePeer` time only when a tool set is built, which this suite does not
  // do. Keeping the note avoids the reader wondering why no core root was set.
  console.log('[no DSH_CORE_ROOT: not needed here — engine.js imports only local modules]')
}

const { startFakeSshServer, freshHostKey } = await import(pathToFileURL(path.join(supportDir, 'fake-ssh-server.mjs')).href)
const { HostConfigStore } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'store.js')).href)
const { HostStore } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'hosts.js')).href)
const { SshWorkspaceEngine } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'engine.js')).href)

const cleanups = []
const track = (fn) => { cleanups.push(fn) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * An engine wired to one fake host.
 *
 * The backoff is shortened to hundreds of milliseconds so a suite can watch
 * several attempts; the real defaults are minutes and would make this a
 * minutes-long test. `jitter: 0` makes the ladder's timing exact.
 */
async function engineOver (server, { reconnect = true, agentForward = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-fake-transport-'))
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
      ...(agentForward ? { agentForward: true } : {}),
    }],
  }, null, 2), 'utf8')
  const entryStore = new HostConfigStore(storeFile)
  // A config path that does not exist: the store entry must be the only source,
  // so a `Host fake` block in the developer's own ~/.ssh/config cannot leak in.
  const store = new HostStore(path.join(dir, 'no-ssh-config'), entryStore)
  const engine = new SshWorkspaceEngine({
    store,
    reconnect: reconnect === false
      ? false
      : { baseDelayMs: 150, maxDelayMs: 300, jitter: 0, maxAttempts: 0 },
    sweepIntervalMs: 3_600_000,
  })
  track(() => engine.dispose())
  return engine
}

/** Wait until `predicate` holds, or fail after `timeout`. */
async function waitFor (predicate, timeout = 3_000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await predicate()) return true
    await sleep(20)
  }
  return false
}

// ================================================================ [1] trigger
console.log('[1] a socket destroyed under a live connection starts the loop')
{
  const server = await startFakeSshServer({ pluginRoot, password: 'sekret' })
  track(() => server.close())
  const engine = await engineOver(server)
  // `isWanted` is what keeps the loop from dialing a host nobody wants. In a
  // real deployment a mounted root or a held forward answers this; here a check
  // stands in for that consumer, because this suite is about the trigger.
  engine.addWantedCheck(() => true)

  const record = await engine.acquire('fake')
  check('the connection came up over a real socket', record.broken === false && server.connections === 1, `connections=${server.connections}`)

  // Nobody operates on the connection. The socket simply dies, as it would when
  // a lid closes. This is the case the one-shot retry inside an operation can
  // never cover, because there is no operation.
  server.dropAll()
  const lost = await waitFor(() => engine.reconnector?.stateOf('fake') !== undefined)
  check('the death is noticed with no operation in flight', lost, JSON.stringify(engine.reconnector?.stateOf('fake')))
  const state = engine.reconnector?.stateOf('fake')
  check('the loop reports the waiting phase', state?.phase === 'waiting', JSON.stringify(state))
  check('the first attempt is scheduled', (state?.attempts ?? 0) >= 1, JSON.stringify(state))
  check('the reason names the transport', /transport/u.test(state?.reason ?? ''), String(state?.reason))

  const reconnected = await waitFor(() => server.connections >= 2 && engine.pool.get('fake')?.broken === false)
  check('a second connection is opened on its own', reconnected, `connections=${server.connections}`)
  check('the loop clears once the host is back', engine.reconnector?.stateOf('fake') === undefined, JSON.stringify(engine.reconnector?.list?.()))
  const events = engine.diagnostics.list()
  check('the loss is in the diagnostics ring',
    events.some(event => event.kind === 'disconnect' && /retrying in the background/u.test(event.message)),
    JSON.stringify(events.map(event => event.kind)))
  check('the recovery is in the diagnostics ring',
    events.some(event => event.kind === 'reconnect' && /reconnected after/u.test(event.message)),
    JSON.stringify(events.map(event => event.kind)))
}

// ================================================================= [2] restore
console.log('\n[2] the restore hook runs on the success path, even when healed first')
{
  const server = await startFakeSshServer({ pluginRoot, password: 'sekret' })
  track(() => server.close())
  const engine = await engineOver(server)
  engine.addWantedCheck(() => true)

  let restored = 0
  engine.onReconnected = () => { restored += 1 }

  await engine.acquire('fake')
  server.dropAll()
  await waitFor(() => engine.reconnector?.stateOf('fake') !== undefined)

  // The user comes back and clicks something before the timer fires: a
  // foreground acquire heals the host. The background attempt then finds a
  // healthy record and does NOT dial again — but something on this host still
  // needs restoring (saved forwards, in a real deployment), so the hook must
  // run anyway. Wiring it into "this call built the socket" is how a host came
  // back with its tunnels still dead.
  await engine.acquire('fake')
  const healed = engine.pool.get('fake')?.broken === false
  check('a foreground operation heals the host first', healed)
  const settled = await waitFor(() => engine.reconnector?.stateOf('fake') === undefined)
  check('the background loop settles on the reused record', settled, JSON.stringify(engine.reconnector?.list?.()))
  check('the restore hook ran exactly once', restored === 1, String(restored))
}

// ============================================================ [3] deliberate close
console.log('\n[3] a deliberate close does not start the loop')
{
  const server = await startFakeSshServer({ pluginRoot, password: 'sekret' })
  track(() => server.close())
  const engine = await engineOver(server)
  engine.addWantedCheck(() => true)

  await engine.acquire('fake')
  engine.forget('fake')
  await sleep(400)
  check('no retry loop is armed after forget', engine.reconnector?.stateOf('fake') === undefined, JSON.stringify(engine.reconnector?.list?.()))
  check('no second connection was dialed', server.connections === 1, `connections=${server.connections}`)

  // The same rule for the sweeper: an idle connection reaped on purpose must
  // stay gone. A loop here would turn every idle timeout into a redial. The
  // record's `idleAt` is moved back by hand because `acquire` stamps it to now,
  // which is exactly what keeps a freshly used connection out of the sweep.
  const idle = await engine.acquire('fake')
  idle.idleAt = Date.now() - 10_000
  engine.tuning.idleTimeoutMs = 5_000
  engine.sweep()
  await sleep(400)
  check('the idle sweep does not arm a retry either', engine.reconnector?.stateOf('fake') === undefined, JSON.stringify(engine.reconnector?.list?.()))
  check('and the pool is empty after the sweep', engine.pool.get('fake') === undefined, JSON.stringify([...engine.pool.keys()]))
}

// =============================================================== [4] host key
console.log('\n[4] a changed host key is refused and is not retried forever')
{
  const server = await startFakeSshServer({ pluginRoot, password: 'sekret' })
  track(() => server.close())
  const engine = await engineOver(server)
  engine.addWantedCheck(() => true)

  const record = await engine.acquire('fake')
  check('the first connection pins the key', engine.store.knownHostKey('fake')?.fingerprint === server.fingerprint, String(engine.store.knownHostKey('fake')?.fingerprint))

  // The server presents a DIFFERENT key to the next connection. A client that
  // trusted it would be talking to something else; the engine must refuse.
  const impostor = freshHostKey(pluginRoot)
  server.setHostKey(impostor.private, impostor.public)
  server.dropAll()
  await waitFor(() => engine.reconnector?.stateOf('fake') !== undefined)

  const failed = await waitFor(() => engine.reconnector?.stateOf('fake')?.phase === 'gave-up', 5_000)
  const events = engine.diagnostics.list()
  // A fatal stop KEEPS its entry in the `gave-up` phase on purpose: the panel
  // must be able to say "reconnect stopped, here is why" rather than silently
  // going quiet. What must stop is the dialing, not the reporting.
  check('the mismatch ends the ladder', failed, JSON.stringify(engine.reconnector?.list?.()))
  check('the refusal is recorded as fatal, not as a plain failure',
    events.some(event => event.kind === 'degraded' && /background reconnect stopped/u.test(event.message)),
    JSON.stringify(events.slice(-3).map(event => `${event.kind}: ${event.message}`)))
  // The message must name both fingerprints; a reader deciding "is this an
  // attack or a reinstall?" needs both to compare. The pinned value is taken
  // from the store rather than from the server, because the point is that the
  // RECORDED one is shown.
  const recorded = engine.store.knownHostKey('fake')?.fingerprint ?? ''
  const presented = impostor.fingerprint
  const degraded = events.filter(event => event.kind === 'degraded').at(-1)?.message ?? ''
  check('the refusal names the recorded fingerprint', recorded !== '' && degraded.includes(recorded), `${recorded} in ${degraded.slice(0, 200)}`)
  check('and the fingerprint that was presented', degraded.includes(presented), `${presented} in ${degraded.slice(0, 200)}`)
  check('the old connection was dropped', record.broken === true)
  // A fatal stop must not leave a second dial in flight.
  const connectionsAfter = server.connections
  await sleep(300)
  check('nothing is dialing after the fatal stop', server.connections === connectionsAfter, `${connectionsAfter} → ${server.connections}`)
}

// ================================================================ [5] channel opts
console.log('\n[5] every command channel opens with a real options bag')
{
  // The regression this exists for: `runRemoteCommand` used to pass `undefined`
  // as ssh2's second argument when the host did not ask for agent forwarding —
  // which is the DEFAULT for every host. ssh2 only substitutes `{}` when that
  // argument is a function, so `undefined` reached `opts.allowHalfOpen` and
  // threw synchronously. Because the throw happened inside the promise
  // executor, every command rejected, the capability probe swallowed it and
  // reported all-unknown, and the audit never recorded a row. Nothing but a
  // real client over a real socket distinguishes "the channel opened" from
  // "a fake that ignores its arguments accepted anything".
  const server = await startFakeSshServer({
    pluginRoot,
    password: 'sekret',
    onExec: ({ stream }) => {
      stream.write('probe-ok\n')
      stream.exit(0)
      stream.end()
    },
  })
  track(() => server.close())

  const plain = await engineOver(server)
  plain.addWantedCheck(() => true)
  const outcome = await plain.exec('fake', 'echo probe-ok')
  check('a non-forwarding host runs a command at all', outcome.success === true, JSON.stringify(outcome))
  check('and its output comes back', outcome.stdout.includes('probe-ok'), JSON.stringify(outcome.stdout))
  check('the run is recorded in the audit', plain.audit?.list?.().length === 1, JSON.stringify(plain.audit?.list?.()))

  // A server that REJECTS the forwarding request must not stop the command.
  // `AllowAgentForwarding no` is standard hardening, and ssh2 turns that
  // rejection into a channel-open error — so without the retry, checking the
  // box would mean "this host can no longer run anything".
  const refused = await engineOver(server, { agentForward: true })
  refused.addWantedCheck(() => true)
  // A forwarding host needs an agent ON the connection for ssh2 to even send
  // the request, and this machine has none: the reachability gate keeps it
  // inert, which is exactly the behaviour that must NOT be mistaken for the
  // retry. Prove the gate first, then force the retry path directly below.
  const inert = await refused.exec('fake', 'echo probe-ok')
  check('with no reachable agent, forwarding stays inert', inert.success === true && inert.forwardingRefused === undefined, JSON.stringify(inert))
  check('...and no agent request was ever sent', server.agentRequests === 0, String(server.agentRequests))

  // The retry itself, driven directly: a fake client whose FIRST call rejects
  // the forwarding request and whose SECOND succeeds. This is the one timing a
  // real server cannot produce on demand (it needs an agent on the connection
  // AND `AllowAgentForwarding no`), and the reachability gate above keeps the
  // real path inert on this machine, so the branch is pinned here instead.
  const engine = new SshWorkspaceEngine({ reconnect: false, sweepIntervalMs: 3_600_000 })
  track(() => engine.dispose())
  const calls = []
  const fakeClient = {
    exec (command, options, callback) {
      calls.push(options)
      if (calls.length === 1) {
        callback(new Error('Unable to request agent forwarding'))
        return
      }
      const stream = new EventEmitter()
      stream.stderr = new EventEmitter()
      stream.signal = () => {}
      stream.close = () => {}
      callback(undefined, stream)
      setTimeout(() => {
        stream.emit('data', Buffer.from('retried\n'))
        stream.emit('close', 0)
      }, 0)
    },
  }
  engine.acquire = async () => ({ alias: 'fake', client: fakeClient, idleAt: Date.now(), inFlight: 0, holds: 0, broken: false, agentForward: true })
  engine.closeRecord = () => {}
  const retried = await engine.exec('fake', 'echo retried')
  check('a refused forwarding request is retried once', calls.length === 2, String(calls.length))
  check('the retry drops the flag', calls[1]?.agentForward === undefined, JSON.stringify(calls[1]))
  check('the command still runs', retried.success === true && retried.stdout.includes('retried'), JSON.stringify(retried))
  check('the refusal is reported, not hidden', retried.forwardingRefused === true, JSON.stringify(retried))
}

// ======================================================= [6] config edit invalidates
console.log('\n[6] editing the SSH config drops a live connection')
{
  // `resolve()` re-reads the file on every call, so a host ADDED or EDITED
  // through the panel is picked up immediately. The gap this closes is the user
  // editing `~/.ssh/config` in an editor: nothing tells the engine, so the
  // pooled socket keeps using the descriptor it was opened with. The user
  // changes the port, the panel still shows the old session, and the only cure
  // was toggling the workspace or restarting.
  //
  // A real socket is required here: the assertion is "a NEW connection is
  // dialed", and a fake transport cannot produce a second connection count.
  const server = await startFakeSshServer({ pluginRoot, password: 'sekret' })
  track(() => server.close())

  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-config-stamp-'))
  track(() => rmSync(dir, { recursive: true, force: true }))
  const storeFile = path.join(dir, 'hosts.json')
  // A host served ONLY by the editable store: the SSH config is not consulted
  // for it, so the stamp is the one thing that can invalidate the connection.
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
  const configPath = path.join(dir, 'ssh_config')
  writeFileSync(configPath, 'Host unrelated\n  HostName example.test\n', 'utf8')
  const store = new HostStore(configPath, new HostConfigStore(storeFile))
  const engine = new SshWorkspaceEngine({ store, reconnect: false, sweepIntervalMs: 3_600_000 })
  track(() => engine.dispose())
  engine.addWantedCheck(() => true)

  const first = await engine.acquire('fake')
  check('the connection is live and stamped', first.broken === false && server.connections === 1,
    `connections=${server.connections} stamp=${first.configStamp}`)
  check('the stamp matches the file it was built from', first.configStamp === store.configStamp(),
    `${first.configStamp} vs ${store.configStamp()}`)

  // Acquiring again WITHOUT touching anything must reuse the socket: a stamp
  // comparison that reconnected every time would be worse than the bug.
  const reused = await engine.acquire('fake')
  check('an unchanged config reuses the connection', reused === first && server.connections === 1,
    `connections=${server.connections}`)

  // Now the user edits the config. The content is irrelevant to this host —
  // what matters is that the engine cannot know that, and a stale socket is
  // the dangerous default.
  writeFileSync(configPath, 'Host unrelated\n  HostName example.test\n  Port 2222\n', 'utf8')
  const second = await engine.acquire('fake')
  check('a config edit drops the stale connection and dials again',
    second !== first && second.broken === false && server.connections === 2,
    `connections=${server.connections}`)
  check('the new connection carries the new stamp', second.configStamp === store.configStamp(),
    `${second.configStamp} vs ${store.configStamp()}`)
  const events = engine.diagnostics.list()
  check('the invalidation is explained in the diagnostics ring',
    events.some(event => event.kind === 'disconnect' && /SSH config changed on disk/u.test(event.message)),
    JSON.stringify(events.map(event => `${event.kind}: ${event.message}`).slice(-3)))
  // Not `forget()`: that cancels the reconnect loop, which is right for an
  // operator decision and wrong for a file edit — a mounted root may still
  // want this host.
  check('the edit does not cancel the reconnect loop permanently',
    engine.reconnector?.stateOf?.('fake') === undefined,
    JSON.stringify(engine.reconnector?.list?.()))
}

// ==================================================================== cleanup
for (const cleanup of cleanups.reverse()) {
  try { await cleanup() } catch { /* a teardown failure must not mask a result */ }
}

console.log(`\n=== ${passed} passed, ${failures.length} failed ===\n`)
if (failures.length > 0) {
  console.log('failures:')
  for (const failure of failures) console.log(`  ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
