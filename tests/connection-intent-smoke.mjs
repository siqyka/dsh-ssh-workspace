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
 * Run: node tests/connection-intent-smoke.mjs
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
}

console.log(`\n=== ${passed} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('failures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
