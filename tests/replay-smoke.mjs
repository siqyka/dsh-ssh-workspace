/**
 * Failure-replay policy: what may be retried after a connection loss.
 *
 * A one-shot retry on a dead transport is the difference between "a hiccup
 * heals itself" and "every hiccup is a user-visible error", so it should not be
 * removed. What must not happen is retrying work whose FIRST attempt may have
 * already landed on the server.
 *
 * Both halves are asserted here, because the two failure modes are opposite:
 *
 *  - a WRITE that dies mid-flight must NOT be replayed. A single-level `mkdir`
 *    whose response was lost is committed remotely, so the replay would fail
 *    `EEXIST` on a directory that exists; an upload would copy the file twice.
 *    The error must instead say the outcome is unknown.
 *  - a READ that dies mid-flight must still be replayed once, or every
 *    accidental disconnect turns into a hard failure of the file tree.
 *  - `exec` must not treat "no output" as proof the command did not run:
 *    `rm -f`, `touch`, `mv`, `git commit -q` are silent on success.
 *
 * No SSH server is involved: `acquire` is scripted, so the timing of the
 * transport death is exact rather than a race.
 *
 * Run: node tests/replay-smoke.mjs
 */

import { EventEmitter } from 'node:events'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { SshWorkspaceEngine } = await import(pathToFileURL(path.join(pluginRoot, 'lib/engine.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** One pooled record whose transport is alive. */
function recordOf (alias, client = { exec: () => {}, end: () => {} }, sftp = {}) {
  return { alias, client, sftp, streamSftp: undefined, idleAt: Date.now(), inFlight: 0, holds: 0, broken: false }
}

/**
 * An engine whose `acquire` hands out scripted records in order.
 *
 * A record returned by `brokenAfter()` is healthy when the operation starts and
 * marked broken when that operation touches it — which is what the real
 * `client.on('close')` handler does, only with an exact timing.
 */
function scriptedEngine (builders) {
  const engine = new SshWorkspaceEngine({ reconnect: false })
  const queue = [...builders]
  const state = { attempts: 0 }
  engine.acquire = async (alias) => {
    state.attempts += 1
    const build = queue.shift()
    if (build === undefined) throw new Error(`no scripted connection left for ${alias}`)
    const record = build()
    engine.pool.set(alias, record)
    return record
  }
  return { engine, state }
}

// ---------------------------------------------------------------------------
// 1. A write that dies mid-flight is NOT replayed
// ---------------------------------------------------------------------------
console.log('\n[1] a write is never replayed on a transport death')
{
  let landed = 0
  const { engine, state } = scriptedEngine([
    // First attempt: the callback commits its side effect, then the transport
    // dies before the response is delivered.
    () => {
      const record = recordOf('h')
      record.diesMidway = () => { record.broken = true }
      return record
    },
  ])
  let error
  try {
    await engine.withSftp('h', async () => {
      const record = engine.pool.get('h')
      landed += 1
      record.diesMidway()
      throw Object.assign(new Error('connection lost'), { code: 'ECONNRESET' })
    }, { kind: 'write' })
  } catch (caught) {
    error = caught
  }
  check('the write ran exactly once', landed === 1, `side effects=${landed}`)
  check('a write failure is not silently retried', state.attempts === 1, `connection attempts=${state.attempts}`)
  check('the failure says the remote outcome is unknown', error?.outcome === 'unknown', JSON.stringify(error?.outcome))
  check('the original message survives', /connection lost/u.test(String(error?.message)), String(error?.message))
  check('the loss is recorded as a disconnect, not a reconnect',
    engine.diagnostics.list().some(entry => entry.kind === 'disconnect' && /outcome is unknown/u.test(entry.message)),
    JSON.stringify(engine.diagnostics.list()))
}

// ---------------------------------------------------------------------------
// 2. A read is still replayed once
// ---------------------------------------------------------------------------
console.log('\n[2] a read still replays once, so a hiccup heals')
{
  const { engine, state } = scriptedEngine([
    () => recordOf('h'),
    () => recordOf('h'),
  ])
  let result
  try {
    result = await engine.withSftp('h', async () => {
      const record = engine.pool.get('h')
      if (state.attempts === 1) {
        record.broken = true
        throw new Error('transport reset')
      }
      return 'read-ok'
    })
  } catch { /* asserted below */ }
  check('a read replays and succeeds', result === 'read-ok', String(result))
  check('the read needed a second connection', state.attempts === 2, `attempts=${state.attempts}`)
  check('the retry is recorded as a reconnect, not a disconnect',
    engine.diagnostics.list().some(entry => entry.kind === 'reconnect'), JSON.stringify(engine.diagnostics.list()))
}

// ---------------------------------------------------------------------------
// 3. A logic error on a healthy connection is never retried
// ---------------------------------------------------------------------------
console.log('\n[3] a healthy-connection error surfaces immediately')
{
  const { engine, state } = scriptedEngine([() => recordOf('h')])
  let error
  try {
    await engine.withSftp('h', async () => { throw new Error('ENOENT: no such file') }, { kind: 'write' })
  } catch (caught) { error = caught }
  check('a non-transport error is not retried', state.attempts === 1, `attempts=${state.attempts}`)
  check('a non-transport error is not marked unknown', error?.outcome === undefined, JSON.stringify(error?.outcome))
}

// ---------------------------------------------------------------------------
// 4. exec: a silent command that dies after running is NOT replayed
// ---------------------------------------------------------------------------
console.log('\n[4] exec does not treat "no output" as "did not run"')

/**
 * A channel that behaves like a remote command whose transport dies before the
 * exit status arrives: it may or may not emit output, then closes with
 * `undefined` (no exit code).
 */
function dyingChannel (output) {
  const stream = new EventEmitter()
  stream.stderr = new EventEmitter()
  stream.signal = () => {}
  stream.close = () => {}
  setImmediate(() => {
    if (output !== undefined) stream.emit('data', Buffer.from(output, 'utf8'))
    setImmediate(() => stream.emit('close', undefined))
  })
  return stream
}

/**
 * An engine whose every connection dies during the run, so a replay is
 * observable as a second `acquire`.
 */
function execEngine (output) {
  const engine = new SshWorkspaceEngine({ reconnect: false })
  const state = { attempts: 0 }
  engine.acquire = async () => {
    state.attempts += 1
    const record = recordOf('h', {
      exec: (_command, callback) => callback(undefined, dyingChannel(output)),
      end: () => {},
    })
    // ssh2 marks the record broken before the channel's close settles the run.
    record.broken = true
    return record
  }
  return { engine, state }
}

{
  const silent = execEngine(undefined)
  const outcome = await silent.engine.exec('h', 'rm -f /tmp/x')
  check('a silent command that lost its status is NOT replayed', silent.state.attempts === 1, `attempts=${silent.state.attempts}`)
  check('the silent run reports an unknown outcome', outcome.outcome === 'unknown', JSON.stringify(outcome.outcome))
  check('the silent run does not claim success', outcome.success === false, String(outcome.success))
  check('the silent run carries no exit code', outcome.exitCode === null, String(outcome.exitCode))

  const marked = execEngine(undefined)
  const replayed = await marked.engine.exec('h', 'command -v rg', { replay: 'safe' })
  check('an explicitly replay-safe probe IS retried once', marked.state.attempts === 2, `attempts=${marked.state.attempts}`)
  // Both attempts died, so "unknown" is the honest answer here too: the retry
  // did not prove the command failed, only that the link never stayed up.
  check('a probe whose retry also died still reports unknown',
    replayed.outcome === 'unknown', JSON.stringify(replayed.outcome))

  // A replay that lands on a healthy connection settles normally: the point of
  // the retry is that a hiccup heals, not that it merely gets counted.
  const healing = (() => {
    const engine = new SshWorkspaceEngine({ reconnect: false })
    const state = { attempts: 0 }
    engine.acquire = async () => {
      state.attempts += 1
      const stream = new EventEmitter()
      stream.stderr = new EventEmitter()
      stream.signal = () => {}
      stream.close = () => {}
      const record = recordOf('h', {
        exec: (_command, callback) => {
          if (state.attempts === 1) return callback(undefined, dyingChannel(undefined))
          setImmediate(() => {
            stream.emit('data', Buffer.from('rg\n', 'utf8'))
            stream.emit('close', 0)
          })
          return callback(undefined, stream)
        },
        end: () => {},
      })
      record.broken = state.attempts === 1
      return record
    }
    return { engine, state }
  })()
  const healed = await healing.engine.exec('h', 'command -v rg', { replay: 'safe' })
  check('a replay-safe probe that reconnects succeeds', healed.success === true, JSON.stringify(healed))
  check('the healed probe reports no unknown outcome', healed.outcome === undefined, JSON.stringify(healed.outcome))
  check('the healed probe kept its output', healed.stdout.includes('rg'), JSON.stringify(healed.stdout))

  const noisy = execEngine('partial output')
  const noisyOutcome = await noisy.engine.exec('h', 'make build')
  check('a command that produced output is not replayed', noisy.state.attempts === 1, `attempts=${noisy.state.attempts}`)
  check('the noisy run reports an unknown outcome', noisyOutcome.outcome === 'unknown', JSON.stringify(noisyOutcome.outcome))
  check('the captured output is still returned for diagnosis',
    noisyOutcome.stdout === 'partial output', JSON.stringify(noisyOutcome.stdout))
}

// ---------------------------------------------------------------------------
// 5. A timeout is a settled result, not a connection loss
// ---------------------------------------------------------------------------
console.log('\n[5] a timeout is never reported as an unknown outcome')
{
  const engine = new SshWorkspaceEngine({ reconnect: false })
  let attempts = 0
  engine.acquire = async () => {
    attempts += 1
    const stream = new EventEmitter()
    stream.stderr = new EventEmitter()
    stream.signal = () => {}
    stream.close = () => {}
    const record = recordOf('h', {
      exec: (_command, callback) => callback(undefined, stream),
      end: () => {},
    })
    return record
  }
  const outcome = await engine.exec('h', 'sleep 999', { timeoutMs: 30 })
  check('a timeout is reported as timedOut', outcome.timedOut === true, JSON.stringify(outcome))
  check('a timeout is not marked unknown', outcome.outcome === undefined, JSON.stringify(outcome.outcome))
  check('a timeout is not retried', attempts === 1, `attempts=${attempts}`)
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
if (failures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}
