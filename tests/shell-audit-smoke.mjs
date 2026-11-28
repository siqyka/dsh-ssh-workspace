/**
 * The audit row for a command the HOST shell ran on a remote host.
 *
 * `patch-shell` bypasses `engine.exec()` — it opens the ssh2 channel itself —
 * and `engine.exec()` is where every other remote command gets its audit row.
 * So the most common path in a remote workspace ("run this in bash") was the
 * one path with no trace in the panel. These checks pin the record that closes
 * that gap:
 *
 *  1. **One row per run**, with the caller's command rather than the wrapper
 *     (`export`s and the `cd` prefix are how it ran, not what was asked).
 *  2. **The remote workdir travels as `cwd`**, so a reader sees where it ran
 *     without parsing a shell-quoted line.
 *  3. **The session id travels when the spec carries one** — that is what lets
 *     the panel file the row under a workspace; a spec without one records a
 *     row with no owner rather than inventing one.
 *  4. **Nothing ran, nothing logged**: a mode refusal, a dead connection and an
 *     abort before dispatch leave the ring untouched.
 *
 * Run: node tests/shell-audit-smoke.mjs
 */

import { EventEmitter } from 'node:events'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { CommandAudit } = await import(pathToFileURL(path.join(pluginRoot, 'lib/engine/engine.js')).href)
const { installRemoteShell, uninstallRemoteShell } = await import(pathToFileURL(path.join(pluginRoot, 'lib/patch/patch-shell.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== shell audit smoke ===\n')

const REMOTE = 'ssh://dev/home/dev/project'

/** A stream that looks enough like an ssh2 channel for the router. */
function fakeChannel () {
  const channel = new EventEmitter()
  channel.stderr = new EventEmitter()
  channel.end = () => {}
  channel.signal = () => {}
  channel.close = () => {}
  return channel
}

/**
 * An engine whose next `acquire()` hands back one canned channel.
 *
 * @param {object} [options] - behaviour switches.
 * @param {Error} [options.execError] - fail the exec callback instead of opening.
 */
function fakeEngine (options = {}) {
  const audit = new CommandAudit()
  const engine = {
    audit,
    assertNotDisabled () {},
    closeRecord () {},
    async acquire () {
      return {
        inFlight: 0,
        idleAt: Date.now(),
        client: {
          exec (_script, _options, callback) {
            if (options.execError !== undefined) {
              callback(options.execError)
              return
            }
            callback(undefined, engine.channel)
          },
        },
      }
    },
  }
  return engine
}


/** A mounted shell whose ssh:// workdirs are diverted to the patched engine. */
function mountedShell (engine) {
  const local = {
    async execute (spec) {
      throw new Error(`the local executor was reached with ${String(spec?.workdir)}`)
    },
  }
  const ctx = { get: (name) => (name === 'shell' ? local : undefined) }
  installRemoteShell(ctx, { engine })
  return local
}
/** Let the microtask queue and the fake channel run to completion. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

// ---------------------------------------------------------------------------
console.log('[a run that opens a channel leaves exactly one row]')

{
  const engine = fakeEngine()
  engine.channel = fakeChannel()
  const shell = mountedShell(engine)
  const proc = await shell.execute({
    workdir: REMOTE,
    command: 'git status --short',
    env: { DSH_SESSION_ID: 'session-abc' },
  })
  engine.channel.emit('data', Buffer.from('ok\n'))
  engine.channel.emit('close', 0, undefined)
  await proc.done
  await tick()

  const rows = engine.audit.entries
  check('one row lands', rows.length === 1, `got ${rows.length}`)
  const row = rows[0] ?? {}
  check('the caller command is recorded verbatim', row.command === 'git status --short', JSON.stringify(row.command))
  // The ring redacts the home segment on write, exactly like a command line:\n  check('the remote workdir travels as cwd', row.cwd === '/home/<user>/project', JSON.stringify(row.cwd))
  check('the channel says the host shell ran it', row.channel === 'shell', String(row.channel))
  check('the exit code is the real one', row.exitCode === 0, String(row.exitCode))
  check('the session travels', row.sessionId === 'session-abc', String(row.sessionId))
  check('the row carries a duration', Number.isFinite(row.durationMs) && row.durationMs >= 0, String(row.durationMs))
  check('the wrapper is not recorded', row.command.includes('cd ') === false && row.command.includes('export') === false, row.command)
}

// ---------------------------------------------------------------------------
console.log('\n[a failure that reached the host is still a row]')

{
  const engine = fakeEngine()
  engine.channel = fakeChannel()
  const shell = mountedShell(engine)
  const proc = await shell.execute({ workdir: REMOTE, command: 'false', env: {} })
  engine.channel.emit('close', 7, undefined)
  await proc.done
  await tick()

  const row = engine.audit.entries[0] ?? {}
  check('the non-zero status is recorded', row.exitCode === 7, String(row.exitCode))
  check('no error text is invented for a status', row.error === undefined, String(row.error))
  check('a spec without a session records no owner', row.sessionId === undefined, String(row.sessionId))
  check('channel is still shell', row.channel === 'shell', String(row.channel))
}

// ---------------------------------------------------------------------------
console.log('\n[a transport death before the status is an unknown, not a success]')

{
  const engine = fakeEngine()
  engine.channel = fakeChannel()
  const shell = mountedShell(engine)
  const proc = await shell.execute({ workdir: REMOTE, command: 'sleep 5', env: {} })
  engine.channel.emit('close', undefined, undefined)
  await proc.done
  await tick()

  const row = engine.audit.entries[0] ?? {}
  check('the run is recorded', engine.audit.entries.length === 1, String(engine.audit.entries.length))
  check('the exit code is null, not 0', row.exitCode === null, String(row.exitCode))
  check('the failure text is recorded', typeof row.error === 'string' && row.error.includes('dropped'), String(row.error))
}

// ---------------------------------------------------------------------------
console.log('\n[nothing ran, nothing recorded]')

{
  const engine = fakeEngine({ execError: new Error('channel open failed') })
  const shell = mountedShell(engine)
  const proc = await shell.execute({ workdir: REMOTE, command: 'ls', env: {} })
  await proc.done
  await tick()
  check('an exec that never opened a channel records nothing', engine.audit.entries.length === 0, String(engine.audit.entries.length))
}

{
  const engine = fakeEngine()
  engine.channel = fakeChannel()
  const shell = mountedShell(engine)
  const controller = new AbortController()
  controller.abort()
  const proc = await shell.execute({ workdir: REMOTE, command: 'ls', env: {}, signal: controller.signal })
  await proc.done
  await tick()
  check('an abort before dispatch records nothing', engine.audit.entries.length === 0, String(engine.audit.entries.length))
}

// ---------------------------------------------------------------------------
console.log(`\n=== shell audit smoke: ${passed} passed, ${failures} failed ===\n`)
if (failures > 0) process.exitCode = 1
