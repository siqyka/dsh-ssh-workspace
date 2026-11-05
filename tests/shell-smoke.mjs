/**
 * Persistent-shell checks against an in-memory channel double.
 *
 * The properties that matter here are the ones a real PTY makes hard to
 * observe deterministically:
 *
 * - a command's output is separated from the marker line, so the model never
 *   reads the exit-marker syntax as output;
 * - the exit status is recovered from the marker, including a non-zero one;
 * - a second call reuses the live session (that is what makes `cd` survive);
 * - a session that dies fails the pending call instead of hanging;
 * - closing releases the connection hold exactly once;
 * - a command that outlives its timeout does NOT leak into the next one: its
 *   output, and its own completion marker carrying its exit status, arrive
 *   after the caller gave up, and must not be attributed to the next send;
 * - a multi-byte character split across two chunks is reassembled, not turned
 *   into replacement glyphs.
 *
 * Run: node tests/shell-smoke.mjs
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { ShellManager } = await import(pathToFileURL(path.join(pluginRoot, 'lib/shell.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/**
 * A channel double that behaves like a PTY running a tiny shell.
 *
 * `write` parses the marker the production code appended, "runs" the command
 * (a lookup table of canned results), then emits the echo, the output and the
 * marker line — the order a real terminal produces.
 *
 * Options:
 *  - `results`     command → `{output, code}`.
 *  - `deferFirst`  hold the FIRST command's completion until a later write,
 *                  modelling a command that outlives its timeout.
 *  - `splitOutput` emit the output in two byte-sized pieces, cut INSIDE a
 *                  multi-byte character.
 */
function fakeChannel (options = {}) {
  const handlers = new Map()
  const emitted = []
  const state = { writes: 0 }
  const results = options.results ?? {}
  /** The delivery of a command held back by `deferFirst`. */
  let deferred
  const flushDeferred = () => {
    const run = deferred
    deferred = undefined
    if (run !== undefined) run()
  }
  const channel = {
    stderr: { on () {} },
    on (event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]) },
    once (event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]) },
    emit (event, value) { for (const handler of handlers.get(event) ?? []) handler(value) },
    write (script) {
      state.writes += 1
      const marker = /__DSH_WS_[A-Za-z0-9_]+__/u.exec(script)?.[0]
      if (marker === undefined) return
      // The abandoned command's output and marker are still in flight. They
      // are released on the NEXT write, which is when a real PTY would emit
      // them: either as the answer to a resynchronisation barrier, or (with
      // no barrier) straight into the next command's collection window.
      if (deferred !== undefined) {
        const run = deferred
        deferred = undefined
        run()
      }
      if (marker.includes('RESYNC')) {
        setTimeout(() => { channel.emit('data', Buffer.from(`\r\n${marker}0${marker}\r\n`)) }, 0)
        return
      }
      const command = script.split('\n')[0]
      if (options.onWrite !== undefined) options.onWrite(command, () => {})
      const outcome = results[command] ?? { output: '', code: 0 }
      const deliver = () => {
        // Echo first (the PTY echoes what was typed), then output, then marker.
        emitted.push(`${command}\r\n`)
        channel.emit('data', Buffer.from(`${command}\r\n`))
        if (options.splitOutput === true) {
          // The echo line arrives COMPLETE first — `stripEcho` drops the
          // first line as the echo, so splitting it would put the output on
          // the dropped line. The payload then arrives in two pieces, cut
          // inside the first character (each CJK character is 3 bytes), and
          // the marker follows only after the second piece: emitting it
          // earlier would settle the send with a truncated buffer, which is
          // an artefact of this double rather than of the code under test.
          const payload = Buffer.from(outcome.output, 'utf8')
          channel.emit('data', payload.subarray(0, 2))
          setTimeout(() => {
            channel.emit('data', payload.subarray(2))
            channel.emit('data', Buffer.from('\r\n'))
            channel.emit('data', Buffer.from(`\r\n${marker}${outcome.code}${marker}\r\n`))
          }, 0)
          return
        }
        if (outcome.output !== '') channel.emit('data', Buffer.from(`${outcome.output}\r\n`))
        channel.emit('data', Buffer.from(`\r\n${marker}${outcome.code}${marker}\r\n`))
      }
      if (options.deferFirst === true && state.writes === 1) {
        deferred = deliver
        return
      }
      setTimeout(deliver, 0)
    },
    close () { channel.emit('close') },
  }
  return { channel, state, emitted }
}

/** An engine double handing out one prepared channel per `open`. */
function fakeEngine (channels) {
  const opened = []
  return {
    opened,
    /** No workspace is detached in this suite. */
    assertNotDisabled () {},
    async openChannel (_alias, command, options) {
      const prepared = channels[opened.length] ?? channels.at(-1)
      opened.push({ command, options })
      return { channel: prepared.channel, release: prepared.release ?? (() => {}) }
    },
  }
}

console.log('\n=== shell smoke ===\n')

// --- one command round trip ------------------------------------------------
{
  const prepared = fakeChannel({ results: { 'echo hi': { output: 'hi', code: 0 } } })
  const engine = fakeEngine([prepared])
  const shells = new ShellManager({ engine })
  const result = await shells.run('test', 'echo hi')
  check('a command returns its output without the echoed command line',
    result.output === 'hi', JSON.stringify(result.output))
  check('a command returns its exit status', result.exitCode === 0, String(result.exitCode))
  check('the first call opens a new session', result.reused === false)
  check('the shell is started as POSIX sh',
    engine.opened[0].command.startsWith('sh') || engine.opened[0].command.includes('sh -l'),
    engine.opened[0].command)
  check('the channel is opened with a PTY', engine.opened[0].options.pty !== undefined)
}

// --- a non-zero status is reported, not swallowed ---------------------------
{
  const prepared = fakeChannel({ results: { 'exit 3': { output: '', code: 3 } } })
  const shells = new ShellManager({ engine: fakeEngine([prepared]) })
  const result = await shells.run('test', 'exit 3')
  check('a non-zero exit status survives the marker', result.exitCode === 3, String(result.exitCode))
}

// --- the second call reuses the live session -------------------------------
{
  const prepared = fakeChannel({ results: { 'cd /srv': { output: '', code: 0 }, pwd: { output: '/srv', code: 0 } } })
  const engine = fakeEngine([prepared])
  const shells = new ShellManager({ engine })
  await shells.run('test', 'cd /srv')
  const second = await shells.run('test', 'pwd')
  check('a second call reuses the session', second.reused === true)
  check('only one channel was opened for two calls', engine.opened.length === 1, String(engine.opened.length))
  check('state from the first call is visible in the second', second.output === '/srv', JSON.stringify(second.output))
}

// --- independent sessions do not share state -------------------------------
{
  const first = fakeChannel({ results: { pwd: { output: '/one', code: 0 } } })
  const second = fakeChannel({ results: { pwd: { output: '/two', code: 0 } } })
  const engine = fakeEngine([first, second])
  const shells = new ShellManager({ engine })
  const a = await shells.run('test', 'pwd', { session: 'a' })
  const b = await shells.run('test', 'pwd', { session: 'b' })
  check('two named sessions get separate channels', engine.opened.length === 2, String(engine.opened.length))
  check('two named sessions keep separate state', a.output === '/one' && b.output === '/two',
    JSON.stringify([a.output, b.output]))
}

// --- a session that dies fails the pending call -----------------------------
{
  const prepared = fakeChannel({ results: { forever: { output: '', code: 0 } } })
  prepared.channel.write = () => {
    prepared.state.writes += 1
    // Never answer: then drop the channel.
    setTimeout(() => prepared.channel.emit('close'), 10)
  }
  const shells = new ShellManager({ engine: fakeEngine([prepared]) })
  let message
  try { await shells.run('test', 'forever') } catch (error) { message = error.message }
  check('a dropped channel rejects the pending call',
    typeof message === 'string' && /closed|dropped/u.test(message), String(message))
}

// --- close releases the hold exactly once ----------------------------------
{
  let releases = 0
  const prepared = fakeChannel({ results: { 'echo hi': { output: 'hi', code: 0 } } })
  prepared.release = () => { releases += 1 }
  const shells = new ShellManager({ engine: fakeEngine([prepared]) })
  await shells.run('test', 'echo hi')
  const shell = shells.shells.get('test\u0000default')
  shell.close()
  check('closing the session releases the hold', releases === 1, String(releases))
}

// --- a command that never answers times out --------------------------------
{
  const prepared = fakeChannel({ results: {} })
  prepared.channel.write = () => { prepared.state.writes += 1 }
  const shells = new ShellManager({ engine: fakeEngine([prepared]) })
  let message
  try { await shells.run('test', 'forever', { timeoutMs: 30 }) } catch (error) { message = error.message }
  check('a command that never answers times out',
    typeof message === 'string' && message.includes('did not answer'), message)
}

// --- a timed-out command must not leak into the next one -------------------
//
// The defect: `run` timed out, cleared `pending`, and the remote command kept
// running. The next `run` began collecting immediately, so the abandoned
// command's tail — including its own completion marker, carrying ITS exit code —
// settled the new send. The caller then read the previous command's output as
// its own result.
//
// The barrier makes this provable: the abandoned command's marker arrives
// BEFORE the resync barrier's, so it must be discarded rather than used.
{
  const prepared = fakeChannel({
    results: {
      'sleep 5': { output: 'STALE-OUTPUT', code: 9 },
      pwd: { output: '/fresh', code: 0 },
    },
    deferFirst: true,
  })
  const shells = new ShellManager({ engine: fakeEngine([prepared]) })
  let timedOut
  try {
    await shells.run('test', 'sleep 5', { timeoutMs: 30 })
  } catch (error) {
    timedOut = error
  }
  check('a command that outlives its timeout fails the call', timedOut !== undefined, String(timedOut))
  check('the timeout message names the budget',
    /did not answer within 30ms/u.test(String(timedOut?.message ?? '')), String(timedOut?.message))

  const next = await shells.run('test', 'pwd', { timeoutMs: 500 })
  check('the next command does not inherit the stale output', next.output === '/fresh', JSON.stringify(next.output))
  check('the next command does not inherit the stale exit status', next.exitCode === 0, String(next.exitCode))
  check('the stale output appears nowhere in the result',
    !next.output.includes('STALE-OUTPUT'), JSON.stringify(next.output))
  check('the abandoned session was resynchronised before reuse',
    prepared.state.writes >= 3, `writes=${prepared.state.writes}`)
}

// --- concurrent opens for one session open exactly one PTY -----------------
//
// The defect: `open` checked the map, found nothing, and each caller opened its
// own channel. The second overwrote the first in the map, so the first session
// kept running with no reference able to close it — a leaked PTY plus a leaked
// connection hold for the life of the process. A burst of tool calls on a cold
// session is exactly that shape.
{
  const prepared = fakeChannel({ results: {} })
  let openOnce
  const gate = new Promise((resolve) => { openOnce = resolve })
  const engine = {
    opened: [],
    assertNotDisabled () {},
    async openChannel (_alias, command, options) {
      this.opened.push({ command, options })
      await gate
      return { channel: prepared.channel, release: prepared.release ?? (() => {}) }
    },
  }
  const shells = new ShellManager({ engine })
  const first = shells.open('test', { session: 's' })
  const second = shells.open('test', { session: 's' })
  const third = shells.run('test', 'pwd', { session: 's' })
  openOnce()
  const [a, b, c] = await Promise.all([first, second, third])
  check('concurrent opens for one session open exactly one channel',
    engine.opened.length === 1, `opened=${engine.opened.length}`)
  check('concurrent opens return the same session object', a === b, 'distinct sessions')
  check('only one session is registered', shells.shells.size === 1, String(shells.shells.size))
  check('the in-flight slot is cleared after the open', shells.opening.size === 0, String(shells.opening.size))
  check('the run through the shared open still executed', c.exitCode === 0, String(c.exitCode))
}

// --- a failed open is not cached -------------------------------------------
//
// Caching the rejection would make every later caller await the same error
// instead of retrying: one transient refusal would poison the session forever.
{
  let attempts = 0
  const prepared = fakeChannel({ results: {} })
  const engine = {
    opened: [],
    assertNotDisabled () {},
    async openChannel (_alias, command, options) {
      attempts += 1
      this.opened.push({ command, options })
      if (attempts === 1) throw new Error('the host refused the channel')
      return { channel: prepared.channel, release: prepared.release ?? (() => {}) }
    },
  }
  const shells = new ShellManager({ engine })
  let message
  try { await shells.open('test') } catch (error) { message = error.message }
  check('a failed open rejects with the engine error',
    String(message) === 'the host refused the channel', String(message))
  check('a failed open leaves no session registered', shells.shells.size === 0, String(shells.shells.size))
  const retried = await shells.open('test')
  check('the next open retries instead of reusing the rejection', attempts === 2, `attempts=${attempts}`)
  check('the retry produced a live session', retried.alive === true)
}

// --- a session that arrives after dispose is closed ------------------------
//
// Unloading the plugin must not leave a PTY behind. An open still in flight
// cannot be awaited (its channel does not exist yet), so the session closes
// itself on arrival — otherwise the hold would outlive the plugin entirely.
{
  const prepared = fakeChannel({ results: {} })
  let releases = 0
  prepared.release = () => { releases += 1 }
  let openOnce
  const gate = new Promise((resolve) => { openOnce = resolve })
  const engine = {
    opened: [],
    assertNotDisabled () {},
    async openChannel (_alias, command, options) {
      this.opened.push({ command, options })
      await gate
      return { channel: prepared.channel, release: prepared.release }
    },
  }
  const shells = new ShellManager({ engine })
  const pending = shells.open('test')
  shells.dispose()
  openOnce()
  let message
  try { await pending } catch (error) { message = error.message }
  check('an open in flight when the manager is disposed rejects',
    typeof message === 'string' && message.includes('disposed'), String(message))
  check('the arriving channel is closed, not registered',
    shells.shells.size === 0, String(shells.shells.size))
  check('the arriving channel released its hold', releases === 1, String(releases))
  let afterDispose
  try { await shells.open('test') } catch (error) { afterDispose = error.message }
  check('a disposed manager opens nothing new',
    typeof afterDispose === 'string' && afterDispose.includes('disposed'), String(afterDispose))
}

// --- a multi-byte character split across chunks survives --------------------
{
  const prepared = fakeChannel({ results: { 'echo 中文': { output: '中文', code: 0 } }, splitOutput: true })
  const shells = new ShellManager({ engine: fakeEngine([prepared]) })
  const result = await shells.run('test', 'echo 中文')
  check('a CJK character split across chunks is decoded intact',
    result.output === '中文', JSON.stringify(result.output))
  check('no replacement glyph appears', !result.output.includes('\uFFFD'), JSON.stringify(result.output))
}

// --- a reopen reuses the directory the session was STARTED in ---------------
{
  const firstPrepared = fakeChannel({ results: {} })
  const shells = new ShellManager({ engine: fakeEngine([firstPrepared]) })
  await shells.open('test', { session: 'work', cwd: '/srv/app' })
  // The connection dies; the channel closes, so the session is finished.
  firstPrepared.channel.emit('close')
  // The SAME manager opens the session again: it must reconnect to the same
  // directory, not to the login directory.
  const secondPrepared = fakeChannel({ results: { pwd: { output: '/srv/app', code: 0 } } })
  shells.engine = fakeEngine([secondPrepared])
  const result = await shells.run('test', 'pwd', { session: 'work' })
  check('a reopen lands in the session\'s original directory',
    result.output === '/srv/app', JSON.stringify(result.output))
  check('and the reopen is reported as such', result.reopened === true, JSON.stringify(result))
  check('with the directory it started in', result.cwd === '/srv/app', JSON.stringify(result.cwd))
}

// --- a first open is NOT reported as a reopen -------------------------------
{
  const prepared = fakeChannel({ results: { pwd: { output: '/home/u', code: 0 } } })
  const shells = new ShellManager({ engine: fakeEngine([prepared]) })
  const result = await shells.run('test', 'pwd', { session: 'fresh', cwd: '/home/u' })
  check('a first open is not a reopen', result.reopened === false, JSON.stringify(result))
  check('a first open says where it started', result.cwd === '/home/u', JSON.stringify(result.cwd))
}

// --- an explicit close forgets the start directory --------------------------
{
  const prepared = fakeChannel({ results: { pwd: { output: '/a', code: 0 } } })
  const shells = new ShellManager({ engine: fakeEngine([prepared]) })
  await shells.open('test', { session: 'gone', cwd: '/a' })
  shells.close('test', 'gone')
  check('closing a session forgets where it started', shells.starts.size === 0,
    String(shells.starts.size))
}

// --- an explicit cwd on a reopen overrides the remembered one --------------
{
  const firstPrepared = fakeChannel({ results: { pwd: { output: '/old', code: 0 } } })
  const shells = new ShellManager({ engine: fakeEngine([firstPrepared]) })
  await shells.open('test', { session: 'move', cwd: '/old' })
  firstPrepared.channel.emit('close')
  const secondPrepared = fakeChannel({ results: { pwd: { output: '/new', code: 0 } } })
  shells.engine = fakeEngine([secondPrepared])
  const result = await shells.run('test', 'pwd', { session: 'move', cwd: '/new' })
  check('an explicit cwd wins over the remembered start',
    result.cwd === '/new', JSON.stringify(result.cwd))
  check('and the output comes from the new directory',
    result.output === '/new', JSON.stringify(result.output))
}

// --- the session list names the start directory WITHOUT calling it cwd -----
{
  const prepared = fakeChannel({ results: {} })
  const shells = new ShellManager({ engine: fakeEngine([prepared]) })
  await shells.open('test', { session: 'listed', cwd: '/var/log' })
  const [row] = shells.list()
  check('the list reports where the session started', row.startedIn === '/var/log',
    JSON.stringify(row))
  check('and does not claim to know its current directory', !('cwd' in row), JSON.stringify(row))
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
process.exit(failures === 0 ? 0 : 1)
