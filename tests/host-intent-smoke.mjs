/**
 * host-intent smoke suite: host-key, connection-intent merged.
 *
 * Every assertion from the original suites is kept; each source suite is its own
 * section below. Run: node tests/host-intent-smoke.mjs
 */

import path from 'node:path'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

let totalPassed = 0
let totalFailures = 0

await (async () => {
// ---------------------------------------------------------------------------
// host-key-smoke.mjs
// ---------------------------------------------------------------------------
/**
 * Host-key pinning: a key that could not be saved must not look pinned.
 *
 * The plugin trusts a server's host key on first use and records it, so a later
 * key that differs is refused. The recording can fail — a read-only `DSH_HOME`,
 * a full disk, a locked store — and the old code handled that by logging a
 * warning and connecting anyway. In this deployment `ctx.logger` reaches a ring
 * buffer nothing reads, so the warning was observationally identical to nothing
 * happening: the user believed the key was pinned, while every subsequent
 * connection silently trusted whatever the server presented.
 *
 * The rule asserted here: the connection still succeeds (refusing to connect
 * over a persistence failure would be worse), but the weakened trust state is
 * recorded where the status surfaces can show it.
 *
 */
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { SshWorkspaceEngine } = await import(pathToFileURL(path.join(pluginRoot, 'lib/engine/engine.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/**
 * A raw public-key blob: `string algorithm-name` + `string key-data`.
 *
 * The verifier parses exactly this framing to derive the type and fingerprint,
 * so the fixture must produce a real one rather than a bare Buffer.
 */
function keyBlob (algorithm, body = 'key-material') {
  const name = Buffer.from(algorithm, 'utf8')
  const data = Buffer.from(body, 'utf8')
  return Buffer.concat([
    Buffer.from([0, 0, 0, name.length]), name,
    Buffer.from([0, 0, 0, data.length]), data,
  ])
}

/** An engine whose store can be made to fail on write. */
function engineWith ({ recordFails = false, known = undefined } = {}) {
  const engine = new SshWorkspaceEngine({ reconnect: false })
  const writes = []
  engine.store = {
    knownHostKey: () => known,
    rememberHostKey: (alias, value) => {
      if (recordFails) throw new Error('EACCES: cannot write the host store')
      writes.push({ alias, value })
    },
  }
  return { engine, writes }
}

/**
 * The verifier the engine hands to ssh2, plus the state it records a refusal on.
 *
 * `verifierForTest` is the engine's own seam: `#connect` builds the verifier
 * inside a private method that also opens a socket, so this is the only way to
 * exercise the trust decision without faking ssh2. The state object is the same
 * one the real connect path passes, which is why a refusal's details are
 * observable here.
 */
function verifierOf (engine, alias = 'h') {
  const state = { mismatch: undefined }
  return { verify: engine.verifierForTest(alias, { state }), state }
}

console.log('\n[1] a first-use key is recorded when the store accepts it')
{
  const { engine, writes } = engineWith()
  const { verify } = verifierOf(engine)
  const blob = keyBlob('ssh-ed25519')
  check('the key is accepted', verify(blob) === true, 'refused')
  check('the key was written to the store', writes.length === 1, `${writes.length} writes`)
  check('the stored fingerprint is the OpenSSH SHA256 form',
    /^SHA256:[A-Za-z0-9+/]+$/u.test(writes[0]?.value?.fingerprint ?? ''), String(writes[0]?.value?.fingerprint))
  check('the stored key type was parsed from the blob',
    writes[0]?.value?.keyType === 'ssh-ed25519', String(writes[0]?.value?.keyType))
  check('nothing is reported as unpinned', engine.unpinnedHostKeyRows().length === 0,
    JSON.stringify(engine.unpinnedHostKeyRows()))
}

console.log('\n[2] THE DEFECT: a key that cannot be saved is accepted but marked')
{
  const { engine } = engineWith({ recordFails: true })
  const { verify } = verifierOf(engine)
  const blob = keyBlob('ssh-ed25519')
  check('the connection is NOT refused over a persistence failure', verify(blob) === true, 'refused')
  check('the unpinned state is recorded on the engine',
    engine.unpinnedHostKeyRows().length === 1, JSON.stringify(engine.unpinnedHostKeyRows()))
  check('the recorded row names the host',
    engine.unpinnedHostKeyRows()[0]?.alias === 'h', JSON.stringify(engine.unpinnedHostKeyRows()))
  check('the recorded row carries the fingerprint that was trusted',
    /^SHA256:/u.test(engine.unpinnedHostKeyRows()[0]?.fingerprint ?? ''), JSON.stringify(engine.unpinnedHostKeyRows()))
  // The warning must reach a surface a user actually reads: `ctx.logger` does
  // not, which is why this went unnoticed.
  check('the failure is recorded in the diagnostics log',
    engine.diagnostics.list().some(entry => /host key NOT pinned/u.test(entry.message)),
    JSON.stringify(engine.diagnostics.list()))
  check('the diagnostic explains the consequence',
    engine.diagnostics.list().some(entry => /next connection will trust this key again/u.test(entry.message)),
    JSON.stringify(engine.diagnostics.list()))
}

console.log('\n[3] a key that is already pinned is never reported as unpinned')
{
  const known = { fingerprint: 'SHA256:already-pinned', keyType: 'ssh-ed25519' }
  const { engine } = engineWith({ known })
  const { verify } = verifierOf(engine)
  const blob = keyBlob('ssh-ed25519', 'same-material')
  // The fingerprint will differ from the recorded one, so this refuses — the
  // point is only that no unpinned row appears for a REFUSAL.
  verify(blob)
  check('a mismatch does not create an unpinned row',
    engine.unpinnedHostKeyRows().length === 0, JSON.stringify(engine.unpinnedHostKeyRows()))
}

console.log('\n[4] a later successful pin clears the warning')
{
  const { engine } = engineWith({ recordFails: true })
  const { verify } = verifierOf(engine)
  const blob = keyBlob('ssh-ed25519')
  verify(blob)
  check('the warning exists after the failed write', engine.unpinnedHostKeyRows().length === 1)

  // Now the store works and the key is on record: the warning is obsolete.
  const fingerprint = engine.unpinnedHostKeyRows()[0].fingerprint
  engine.store = {
    knownHostKey: () => ({ fingerprint, keyType: 'ssh-ed25519' }),
    rememberHostKey: () => {},
  }
  const second = verifierOf(engine)
  check('a matching pinned key is accepted', second.verify(blob) === true, 'refused')
  check('the unpinned warning was cleared', engine.unpinnedHostKeyRows().length === 0,
    JSON.stringify(engine.unpinnedHostKeyRows()))
}

console.log('\n[5] a different key is still refused, pinned or not')
{
  const { engine } = engineWith({ recordFails: true })
  const { verify, state } = verifierOf(engine)
  verify(keyBlob('ssh-ed25519', 'first'))
  // Record what the first connect trusted, then present something else.
  const trusted = engine.unpinnedHostKeyRows()[0].fingerprint
  engine.store = { knownHostKey: () => ({ fingerprint: trusted, keyType: 'ssh-ed25519' }), rememberHostKey: () => {} }
  const second = verifierOf(engine)
  check('a changed key is refused', second.verify(keyBlob('ssh-ed25519', 'second')) === false, 'accepted')
  check('the refusal carries both sides', second.state.mismatch !== undefined,
    JSON.stringify(second.state.mismatch))
  check('the refusal names the recorded fingerprint',
    /SHA256:/u.test(second.state.mismatch?.recorded?.fingerprint ?? ''), JSON.stringify(second.state.mismatch))
}

  totalPassed += (typeof passed !== 'undefined' ? passed : (typeof passes !== 'undefined' ? passes : 0))
  totalFailures += (typeof failures !== 'undefined' ? (Array.isArray(failures) ? failures.length : failures) : 0)
})()

await (async () => {
// ---------------------------------------------------------------------------
// connection-intent-smoke.mjs
// ---------------------------------------------------------------------------
/**
 * Connection intent + last-failure visibility (the fork-borrowable features).
 *
 * Three facts are new to the engine and store:
 *  - a host the user switched on has a PERSISTED intent that survives a restart;
 *  - a failed connect is remembered (including a fatal one that arms no retry),
 *    and a successful connect / deliberate forget clears it;
 *  - a host with intent is exempt from the idle sweep and stays "wanted" after
 *    a drop, so the background loop keeps redialing it.
 *
 * This suite exercises the store round-trip against a REAL file and the engine
 * state machine with a stub transport — no live host needed. The boot restore's
 * wiring in lib/index.js is checked on the source (it is a Cordis effect that
 * cannot be imported headlessly).
 *
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')

const { HostConfigStore } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'hosts', 'store.js')).href)
const { SshWorkspaceEngine } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'engine', 'engine.js')).href)

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

console.log('\n=== connection intent smoke ===\n')

// ---------------------------------------------------------------- store section
{
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-ssh-intent-'))
  try {
    const storeFile = path.join(dir, 'dsh-ssh.json')
    writeFileSync(storeFile, JSON.stringify({ version: 1, hosts: [] }), 'utf8')
    const store = new HostConfigStore(storeFile)
    check('a fresh store carries no intent', JSON.stringify(store.autoConnectHosts()) === '[]')

    store.setAutoConnect('alpha', true)
    store.setAutoConnect('beta', true)
    check('two switches persist in stored order',
      JSON.stringify(store.autoConnectHosts()) === '["alpha","beta"]', JSON.stringify(store.autoConnectHosts()))
    check('a fresh read sees the same intent',
      JSON.stringify(new HostConfigStore(storeFile).autoConnectHosts()) === '["alpha","beta"]')

    store.setAutoConnect('alpha', true)
    check('setting an already-on host is a no-op', JSON.stringify(store.autoConnectHosts()) === '["alpha","beta"]')

    store.setAutoConnect('alpha', false)
    check('switching off clears only that alias',
      JSON.stringify(store.autoConnectHosts()) === '["beta"]', JSON.stringify(store.autoConnectHosts()))

    // A damaged section must never make the store unreadable.
    writeFileSync(storeFile, JSON.stringify({ version: 1, autoConnect: 'nope', hosts: [] }), 'utf8')
    check('a damaged intent section degrades to empty',
      JSON.stringify(new HostConfigStore(storeFile).autoConnectHosts()) === '[]')
    writeFileSync(storeFile, JSON.stringify({ version: 1, autoConnect: ['  gamma  ', 'gamma', '', 42], hosts: [] }), 'utf8')
    check('aliases are trimmed, deduplicated and wrong types dropped',
      JSON.stringify(new HostConfigStore(storeFile).autoConnectHosts()) === '["gamma"]',
      JSON.stringify(new HostConfigStore(storeFile).autoConnectHosts()))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- engine failures
{
  // A bare engine has no store file to resolve; drive its failures map directly
  // through the same public surface the routes/status read.
  const engine = new SshWorkspaceEngine({ reconnect: false })
  try {
    check('failures start empty', JSON.stringify(engine.failureRows()) === '[]')
    engine.failures.set('alpha', 'handshake failed')
    engine.failures.set('beta', 'refused')
    check('failureRows exposes alias + error, sorted',
      JSON.stringify(engine.failureRows()) === '[{"alias":"alpha","error":"handshake failed"},{"alias":"beta","error":"refused"}]',
      JSON.stringify(engine.failureRows()))

    engine.forget('alpha')
    check('forget clears the last failure (a deliberate disconnect makes it irrelevant)',
      JSON.stringify(engine.failureRows()) === '[{"alias":"beta","error":"refused"}]',
      JSON.stringify(engine.failureRows()))
  } finally {
    engine.dispose()
  }
}

// ---------------------------------------------------------------- keepAlive sweep
{
  const engine = new SshWorkspaceEngine({ reconnect: false, idleTimeoutMs: 100 })
  try {
    const keep = new Set(['kept'])
    engine.addKeepAliveCheck(alias => keep.has(alias))
    // Two synthetic pool records, both long idle and idle in flight terms.
    const makeRecord = (alias) => ({ alias, inFlight: 0, holds: 0, idleAt: Date.now() - 1000, client: { end () {} } })
    engine.pool.set('kept', makeRecord('kept'))
    engine.pool.set('dropped', makeRecord('dropped'))
    engine.sweep()
    check('a keep-alive host survives the idle sweep', engine.pool.has('kept'))
    check('an ordinary idle host is still reclaimed', !engine.pool.has('dropped'))

    // A throwing predicate must not abort the whole sweep.
    engine.pool.set('kept', makeRecord('kept'))
    engine.pool.set('dropped', makeRecord('dropped'))
    engine.keepAliveChecks = [() => { throw new Error('broken check') }]
    engine.sweep()
    check('a throwing check drops both hosts rather than pinning everything',
      !engine.pool.has('kept') && !engine.pool.has('dropped'))
  } finally {
    engine.dispose()
  }
}

// ---------------------------------------------------------------- wiring on source
{
  const indexSource = readFileSync(path.join(pluginRoot, 'lib', 'index.js'), 'utf8')
  check('index registers the host intent as a wanted-check (redial after a drop)',
    /engine\.addWantedCheck\(hasHostIntent\)/.test(indexSource))
  check('index registers the host intent as a keep-alive check (sweep exemption)',
    /engine\.addKeepAliveCheck\(hasHostIntent\)/.test(indexSource))
  check('boot restore uses acquire, not retryNow (no tunnel auto-reopen)',
    /await engine\.acquire\(alias\)/.test(indexSource) && !/retryNow\(alias\)[\s\S]*autoConnect/.test(indexSource))
  check('boot restore is deferred to a later tick',
    /const restoreAutoConnect[\s\S]*?setTimeout\(\(\) => \{/.test(indexSource))

  const statusSource = readFileSync(path.join(pluginRoot, 'lib', 'routes', 'workspaces.js'), 'utf8')
  check('/status ships autoConnect, connecting and failures',
    /\bautoConnect,/.test(statusSource) && /\bconnecting,/.test(statusSource) && /\bfailures,/.test(statusSource))

  // The box is a MARKER. Its change handler must reach the intent route and
  // never the connection actions: reusing /hosts/reconnect and
  // /hosts/disconnect made ticking the box connect the host and unticking it
  // drop the connection the user was working in.
  const panelSource = readFileSync(path.join(pluginRoot, 'lib', 'client', 'client.panel.js'), 'utf8')
  const boxAt = panelSource.indexOf("key: 'autoConnect'")
  const boxSource = boxAt < 0 ? '' : panelSource.slice(boxAt, boxAt + 1200)
  check('the intent box exists in the panel', boxAt >= 0)
  check('the box writes the intent through onSetIntent',
    /onSetIntent\(host\.alias, next\)/.test(boxSource), boxSource.slice(0, 200))
  check('the box no longer calls the reconnect or disconnect actions',
    !/onReconnect/.test(boxSource) && !/onDisconnect/.test(boxSource), boxSource.slice(0, 200))
  check('the box is gated on its own write, not on the socket',
    /disabled: intentBusy/.test(boxSource) && !/disabled: busy/.test(boxSource), boxSource.slice(0, 200))

  const hostsSource = readFileSync(path.join(pluginRoot, 'lib', 'routes', 'hosts.js'), 'utf8')
  const intentAt = hostsSource.indexOf('path: ROUTES.hostIntent')
  const intentSource = intentAt < 0 ? '' : hostsSource.slice(intentAt, intentAt + 1600)
  check('the intent route only writes the flag',
    intentAt >= 0 && /setAutoConnect\(alias, enabled\)/.test(intentSource) &&
    !/reconnector/.test(intentSource) && !/engine\.acquire/.test(intentSource) && !/engine\.forget/.test(intentSource),
    intentSource.slice(0, 200))
}

  totalPassed += (typeof passed !== 'undefined' ? passed : (typeof passes !== 'undefined' ? passes : 0))
  totalFailures += (typeof failures !== 'undefined' ? (Array.isArray(failures) ? failures.length : failures) : 0)
})()

console.log(`\n=== ${totalPassed} passed, ${totalFailures} failed ===`)
if (totalFailures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}
