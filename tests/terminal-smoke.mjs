/**
 * Remote execution surfaces: the persistent shell and the terminal seam.
 *
 * `shell` drives the marker-framed persistent session (exit status recovered
 * from the marker, a dead session fails its pending call, a timed-out command
 * cannot leak into the next one). `terminal` drives `spawnTerminal`: a remote
 * cwd opens an SSH PTY and ignores the local dialect's argv, a local cwd is
 * left to the original primitive. Both use an in-memory channel double.
 *
 * Run: node tests/terminal-smoke.mjs
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fakeChannelEngine } from './support/fake-channel-engine.mjs'
import { readFileSync } from 'node:fs'
import { createHost } from './support/plugin-host.mjs'
import { fakePtyChannel, fakePtyEngine } from './support/fake-channel-engine.mjs'

let totalPassed = 0
let totalFailures = 0

// ---------------------------------------------------------------------------
// shell-smoke.mjs
// ---------------------------------------------------------------------------
await (async () => {
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
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { ShellManager } = await import(pathToFileURL(path.join(pluginRoot, 'lib/surface/shell.js')).href)

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

/**
 * The engine over a prepared channel list.
 *
 * The double itself lives in `tests/support/fake-channel-engine.mjs`; this is
 * the one-line adaptation this suite needs (the engine, not the log). The three
 * engines further down are deliberately NOT this: they gate, fail or dispose
 * mid-open, and a shared factory cannot be all three without becoming the thing
 * under test.
 */
function channelEngine (channels) {
  return fakeChannelEngine(channels).engine
}

console.log('\n=== shell smoke ===\n')

// --- one command round trip ------------------------------------------------
{
  const prepared = fakeChannel({ results: { 'echo hi': { output: 'hi', code: 0 } } })
  const engine = channelEngine([prepared])
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
  const shells = new ShellManager({ engine: channelEngine([prepared]) })
  const result = await shells.run('test', 'exit 3')
  check('a non-zero exit status survives the marker', result.exitCode === 3, String(result.exitCode))
}

// --- the second call reuses the live session -------------------------------
{
  const prepared = fakeChannel({ results: { 'cd /srv': { output: '', code: 0 }, pwd: { output: '/srv', code: 0 } } })
  const engine = channelEngine([prepared])
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
  const engine = channelEngine([first, second])
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
  const shells = new ShellManager({ engine: channelEngine([prepared]) })
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
  const shells = new ShellManager({ engine: channelEngine([prepared]) })
  await shells.run('test', 'echo hi')
  const shell = shells.shells.get('test\u0000default')
  shell.close()
  check('closing the session releases the hold', releases === 1, String(releases))
}

// --- a command that never answers times out --------------------------------
{
  const prepared = fakeChannel({ results: {} })
  prepared.channel.write = () => { prepared.state.writes += 1 }
  const shells = new ShellManager({ engine: channelEngine([prepared]) })
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
  const shells = new ShellManager({ engine: channelEngine([prepared]) })
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
  const shells = new ShellManager({ engine: channelEngine([prepared]) })
  const result = await shells.run('test', 'echo 中文')
  check('a CJK character split across chunks is decoded intact',
    result.output === '中文', JSON.stringify(result.output))
  check('no replacement glyph appears', !result.output.includes('\uFFFD'), JSON.stringify(result.output))
}

// --- a reopen reuses the directory the session was STARTED in ---------------
{
  const firstPrepared = fakeChannel({ results: {} })
  const shells = new ShellManager({ engine: channelEngine([firstPrepared]) })
  await shells.open('test', { session: 'work', cwd: '/srv/app' })
  // The connection dies; the channel closes, so the session is finished.
  firstPrepared.channel.emit('close')
  // The SAME manager opens the session again: it must reconnect to the same
  // directory, not to the login directory.
  const secondPrepared = fakeChannel({ results: { pwd: { output: '/srv/app', code: 0 } } })
  shells.engine = channelEngine([secondPrepared])
  const result = await shells.run('test', 'pwd', { session: 'work' })
  check('a reopen lands in the session\'s original directory',
    result.output === '/srv/app', JSON.stringify(result.output))
  check('and the reopen is reported as such', result.reopened === true, JSON.stringify(result))
  check('with the directory it started in', result.cwd === '/srv/app', JSON.stringify(result.cwd))
}

// --- a first open is NOT reported as a reopen -------------------------------
{
  const prepared = fakeChannel({ results: { pwd: { output: '/home/u', code: 0 } } })
  const shells = new ShellManager({ engine: channelEngine([prepared]) })
  const result = await shells.run('test', 'pwd', { session: 'fresh', cwd: '/home/u' })
  check('a first open is not a reopen', result.reopened === false, JSON.stringify(result))
  check('a first open says where it started', result.cwd === '/home/u', JSON.stringify(result.cwd))
}

// --- an explicit close forgets the start directory --------------------------
{
  const prepared = fakeChannel({ results: { pwd: { output: '/a', code: 0 } } })
  const shells = new ShellManager({ engine: channelEngine([prepared]) })
  await shells.open('test', { session: 'gone', cwd: '/a' })
  shells.close('test', 'gone')
  check('closing a session forgets where it started', shells.starts.size === 0,
    String(shells.starts.size))
}

// --- an explicit cwd on a reopen overrides the remembered one --------------
{
  const firstPrepared = fakeChannel({ results: { pwd: { output: '/old', code: 0 } } })
  const shells = new ShellManager({ engine: channelEngine([firstPrepared]) })
  await shells.open('test', { session: 'move', cwd: '/old' })
  firstPrepared.channel.emit('close')
  const secondPrepared = fakeChannel({ results: { pwd: { output: '/new', code: 0 } } })
  shells.engine = channelEngine([secondPrepared])
  const result = await shells.run('test', 'pwd', { session: 'move', cwd: '/new' })
  check('an explicit cwd wins over the remembered start',
    result.cwd === '/new', JSON.stringify(result.cwd))
  check('and the output comes from the new directory',
    result.output === '/new', JSON.stringify(result.output))
}

// --- the session list names the start directory WITHOUT calling it cwd -----
{
  const prepared = fakeChannel({ results: {} })
  const shells = new ShellManager({ engine: channelEngine([prepared]) })
  await shells.open('test', { session: 'listed', cwd: '/var/log' })
  const [row] = shells.list()
  check('the list reports where the session started', row.startedIn === '/var/log',
    JSON.stringify(row))
  check('and does not claim to know its current directory', !('cwd' in row), JSON.stringify(row))
}


  totalPassed += passed
  totalFailures += failures
})()

// ---------------------------------------------------------------------------
// terminal-smoke.mjs
// ---------------------------------------------------------------------------
await (async () => {
/**
 * Remote-terminal checks for the `spawnTerminal` seam.
 *
 * The property under test is the one that makes the harness's own persistent
 * shell work on an `ssh://` workspace: a spec whose cwd is remote must be
 * answered over an SSH PTY channel rather than by node-pty on this machine, and
 * the handle it returns must satisfy the contract `dsh-terminal-bash` drives.
 *
 * A fake engine supplies the channel, so the observable behaviour is:
 *
 * - a remote cwd opens a PTY and ignores the local dialect's argv;
 * - a local cwd is left entirely to the original primitive;
 * - output reaches the `output` stream and the exit settles `done`;
 * - `write` reaches the channel, `resize` sends a window change;
 * - `inspectForeground` reports "unknown" rather than guessing, which selects
 *   the harness's output-silence fallback;
 * - `signalForeground('SIGINT')` writes ETX, and an inexpressible signal is
 *   refused instead of silently ignored;
 * - `terminate` closes the channel and releases the hold exactly once.
 *
 * Run: node tests/terminal-smoke.mjs
 */
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const {
  RemoteTerminalRouter,
  installRemoteTerminal,
  uninstallRemoteTerminal,
} = await import(pathToFileURL(path.join(pluginRoot, 'lib/patch/patch-terminal.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** The PTY channel double, from the shared channel-engine module. */
const fakeChannel = fakePtyChannel

console.log('\n=== terminal smoke ===\n')

{
  const { engine, opens } = fakePtyEngine()
  const router = new RemoteTerminalRouter({ engine })
  const handle = await router.spawnTerminal({
    cwd: 'ssh://alpha/home/dev/proj',
    argv: ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\pwsh.exe', '-NoLogo'],
    rows: 30,
    cols: 100,
    terminalType: 'xterm-256color',
  })
  check('a remote cwd opens exactly one channel', opens.length === 1, `opens=${opens.length}`)
  check('the channel targets the ssh:// alias', opens[0]?.alias === 'alpha', opens[0]?.alias)
  check('the remote command cds into the workspace path', opens[0]?.command.includes('/home/dev/proj'), opens[0]?.command)
  check('the remote shell is POSIX sh, not the local dialect argv',
    opens[0]?.command.includes('sh -l') && !opens[0]?.command.includes('pwsh'), opens[0]?.command)
  check('a PTY is requested with the spec geometry',
    opens[0]?.options?.pty?.cols === 100 && opens[0]?.options?.pty?.rows === 30,
    JSON.stringify(opens[0]?.options?.pty))
  check('the handle exposes the terminal contract',
    typeof handle.write === 'function' && typeof handle.resize === 'function'
    && typeof handle.terminate === 'function' && typeof handle.inspectForeground === 'function'
    && handle.output !== undefined && handle.done !== undefined)
  check('the handle has no local pid (remote PTY)', handle.pid === -1, `pid=${handle.pid}`)
}

{
  const { engine, opens } = fakePtyEngine()
  const router = new RemoteTerminalRouter({ engine })
  const handle = await router.spawnTerminal({ cwd: 'ssh://beta/srv/app', argv: ['bash'], rows: 24, cols: 80 })
  const chunks = []
  handle.output.on('data', (chunk) => chunks.push(chunk.toString('utf8')))
  opens[0].state
  // Data written to the channel must surface on the output stream.
  const internals = opens[0]
  handle.channel.emit('data', Buffer.from('hello'))
  check('terminal output reaches the output stream', chunks.join('') === 'hello', JSON.stringify(chunks.join('')))

  let settled
  handle.done.then((outcome) => { settled = outcome })
  handle.channel.emit('close', 3, null)
  await new Promise((resolve) => setTimeout(resolve, 0))
  check('channel close settles done with the exit status', settled?.exitCode === 3, JSON.stringify(settled))
  check('closing releases the connection hold once', internals.state.released === 1, `released=${internals.state.released}`)
  check('the handle reports not running after exit', handle.running === false)
}

{
  const { engine, opens } = fakePtyEngine()
  const router = new RemoteTerminalRouter({ engine })
  const handle = await router.spawnTerminal({ cwd: 'ssh://gamma/tmp', rows: 24, cols: 80 })
  await handle.write('echo hi\n')
  check('write reaches the channel verbatim', opens[0].state.writes.includes('echo hi\n'),
    JSON.stringify(opens[0].state.writes))
  await handle.resize(120, 40)
  check('resize sends the window size', opens[0].state.window?.cols === 120 && opens[0].state.window?.rows === 40,
    JSON.stringify(opens[0].state.window))
}

{
  const { engine } = fakePtyEngine()
  const router = new RemoteTerminalRouter({ engine })
  const handle = await router.spawnTerminal({ cwd: 'ssh://delta/tmp', rows: 24, cols: 80 })
  const foreground = await handle.inspectForeground()
  check('foreground inspection reports unknown instead of guessing', foreground === undefined, String(foreground))
}

{
  const { engine, opens } = fakePtyEngine()
  const router = new RemoteTerminalRouter({ engine })
  const handle = await router.spawnTerminal({ cwd: 'ssh://epsilon/tmp', rows: 24, cols: 80 })
  await handle.signalForeground('SIGINT')
  check('SIGINT writes the terminal interrupt byte', opens[0].state.writes.includes('\u0003'),
    JSON.stringify(opens[0].state.writes))

  const second = await router.spawnTerminal({ cwd: 'ssh://zeta/tmp', rows: 24, cols: 80 })
  let refused
  try {
    await second.signalForeground('SIGUSR1')
  } catch (error) {
    refused = error
  }
  check('an inexpressible signal is refused, not ignored', refused !== undefined, String(refused))
}

{
  const { engine, opens } = fakePtyEngine()
  const router = new RemoteTerminalRouter({ engine })
  const handle = await router.spawnTerminal({ cwd: 'ssh://eta/tmp', rows: 24, cols: 80 })
  await handle.terminate()
  await handle.terminate()
  check('terminate closes the channel', opens[0].state.closed === true)
  check('repeated terminate releases the hold once', opens[0].state.released === 1, `released=${opens[0].state.released}`)
}

{
  // The user picks a shell by name in the sidebar. The remote host cannot run
  // the local argv, but it can usually run the same shell family — and when it
  // cannot, `sh -l` must still be there.
  const cases = [
    { label: 'bare bash', argv: ['/bin/bash'], expect: /bash -l/u, absent: /pwsh/u },
    { label: 'bare zsh with flags', argv: ['/usr/local/bin/zsh', '-l'], expect: /zsh -l/u },
    { label: 'bare pwsh', argv: ['C:\\Program Files\\PowerShell\\7\\pwsh.exe'], expect: /exec sh -l/u },
    { label: 'bare sh', argv: ['/bin/sh'], expect: /exec sh -l/u },
    // `dsh-terminal-bash` sandbox-confines the argv, so a `workspace-write`
    // session hands spawnTerminal `[landlock-run, ...grants, '--', shell, ...]`.
    // Reading argv[0] without unwrapping made every such session fall back to
    // `sh` while the picker said bash.
    //
    // The grant spelling is the runner's own, not bwrap's: `landlockProfileArgs`
    // (`dsh-sandbox-local/lib/index.js:45-58`) goes through `grantArgs`
    // (`node-addon-system/lib/index.js:68-73`), which emits `--ro <path>` and
    // `--rw <path>` pairs, read-only first. A case written against bwrap's
    // `--ro-bind a b` would still pass — `unwrapSandboxArgv` only looks for the
    // separator — while proving nothing about the shape that really arrives.
    {
      argv: [
        '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/landlock-run',
        '--ro', '/',
        '--rw', '/dev/null', '--rw', '/tmp', '--rw', '/srv/app',
        '--', '/bin/bash', '-i',
      ],
      label: 'landlock-run wrapper (real --ro/--rw grants)',
      expect: /bash -l/u,
    },
    // bwrap as the Linux fallback chain's first choice: `bwrapProfileArgs`
    // (`dsh-sandbox-local/lib/index.js:22-43`) really does use `--ro-bind ROOT
    // ROOT`, so this pair of cases pins BOTH dialects the chain can produce.
    {
      label: 'bwrap wrapper',
      argv: ['bwrap', '--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--tmpfs', '/tmp', '--bind', '/srv/app', '/srv/app', '--', '/usr/bin/zsh', '-i'], expect: /zsh -l/u },
    // The Windows runner is the same wrapper in a different spelling:
    // `windowsAclRunnerInvocation()` puts the interpreter first and the runner
    // entry second (`dsh-sandbox-local/lib/index.js:539-553`), so `argv[0]` is
    // `node` / the packaged app binary, not a launcher name. This branch had no
    // assertion at all before.
    {
      argv: [
        process.execPath,
        'C:\\Program Files\\DeepSeek Harness\\resources\\app.asar\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js',
        '--workspace', 'C:\\ws', '--temp', 'C:\\Users\\u\\AppData\\Local\\Temp', '--mode', 'workspace-write',
        '--', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', '-NoLogo',
      ],
      // pwsh has no POSIX `-l` spelling on the host, so the whitelist refuses it
      // and the terminal keeps today's `sh -l` — the same answer as the bare
      // pwsh case above, but now reached THROUGH the unwrapper instead of by
      // failing to recognise the wrapper at all.
      label: 'windows-ACL wrapper around pwsh',
      expect: /exec sh -l/u,
    },
    // And the Windows wrapper around a POSIX-family shell: unwrapping is what
    // lets this one reach the family at all.
    {
      argv: [
        process.execPath,
        'C:\\app\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js',
        '--workspace', 'C:\\ws', '--mode', 'workspace-write',
        '--', 'C:\\Program Files\\Git\\bin\\bash.exe', '-i',
      ],
      label: 'windows-ACL wrapper around bash',
      expect: /bash -l/u,
    },
    // A plain interpreter prefix that is NOT a sandbox wrapper must survive:
    // `node script.js -- bash` is the caller's own argv, and eating it would
    // turn a local command into a remote `bash -l`.
    { label: 'plain interpreter prefix is not a wrapper', argv: [process.execPath, 'script.js', '--', '/bin/bash'], expect: /exec sh -l/u },
  ]
  for (const item of cases) {
    const { engine, opens } = fakePtyEngine()
    const router = new RemoteTerminalRouter({ engine })
    await router.spawnTerminal({ cwd: 'ssh://kappa/srv/app', rows: 24, cols: 80, argv: item.argv })
    const command = opens[0].command
    const ok = item.expect.test(command) && (item.absent === undefined || !item.absent.test(command))
    check(`shell dialect: ${item.label}`,
      ok, command)
  }
  const { engine, opens } = fakePtyEngine()
  const router = new RemoteTerminalRouter({ engine })
  await router.spawnTerminal({ cwd: 'ssh://kappa/srv/app', rows: 24, cols: 80, argv: ['/bin/bash'] })
  check('a bash request falls back to sh when the remote lacks bash',
    opens[0].command.includes('else exec sh -l'), opens[0].command)
  check('the fallback still cds into the workspace first',
    opens[0].command.includes("cd '/srv/app' &&"), opens[0].command)
}

{
  // The browser terminal's retention monitor calls inspectActivity() on the
  // handle. A missing method made the harness's observation fall through its
  // catch block (and the allocation-cleanup path binds it unguarded), so the
  // remote handle must answer the same shape as the local one.
  const { engine, opens } = fakePtyEngine()
  const router = new RemoteTerminalRouter({ engine })
  const handle = await router.spawnTerminal({ cwd: 'ssh://ion/srv/app', rows: 24, cols: 80, argv: ['bash'] })
  const active = await handle.inspectActivity()
  check('a freshly opened terminal reports a non-idle activity state',
    (active.state === 'busy' || active.state === 'unknown') && Number.isSafeInteger(active.revision),
    JSON.stringify(active))
  const before = active.revision
  handle.channel.emit('data', Buffer.from('more output'))
  const afterOutput = await handle.inspectActivity()
  check('output advances the activity revision', afterOutput.revision > before, `${before} -> ${afterOutput.revision}`)
  await handle.write('x')
  const afterInput = await handle.inspectActivity()
  check('input advances the activity revision too', afterInput.revision > afterOutput.revision,
    `${afterOutput.revision} -> ${afterInput.revision}`)
  await handle.terminate()
  const exited = await handle.inspectActivity()
  check('an exited terminal reports idle', exited.state === 'idle', JSON.stringify(exited))
}

{
  // The host's `spec.signal` bounds the allocation, not the terminal: the local
  // backend passes it to node-pty's spawn and the process outlives the call.
  // The browser terminal's create() call carries a per-request signal that
  // aborts when that RPC settles, so the SSH channel must not follow it.
  const { engine, opens } = fakePtyEngine()
  const router = new RemoteTerminalRouter({ engine })
  const controller = new AbortController()
  const handle = await router.spawnTerminal({
    cwd: 'ssh://gamma/srv/app', rows: 24, cols: 80, argv: ['bash'], signal: controller.signal,
  })
  controller.abort(new Error('the create() RPC settled'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  check('aborting spec.signal after open leaves the PTY open',
    opens[0].state.closed === false && opens[0].abortedAtOpen === false,
    `closed=${opens[0].state.closed} abortedAtOpen=${opens[0].abortedAtOpen}`)
  await handle.terminate()
  check('the terminal still terminates on request', opens[0].state.closed === true)
}

{
  // A signal that is already aborted must stop the open before a live PTY exists.
  const { engine, opens } = fakePtyEngine()
  const router = new RemoteTerminalRouter({ engine })
  const controller = new AbortController()
  controller.abort()
  await router.spawnTerminal({
    cwd: 'ssh://delta/srv/app', rows: 24, cols: 80, argv: ['bash'], signal: controller.signal,
  })
  check('an already-aborted spec.signal aborts the open', opens[0].abortedAtOpen === true)
}

{
  // A local cwd must be answered by the original primitive, untouched.
  const calls = []
  const service = {
    spawnTerminal (spec) { calls.push(spec); return { local: true } },
  }
  const ctx = createHost({ services: { subprocess: service } }).ctx
  const { engine } = fakePtyEngine()
  const router = installRemoteTerminal(ctx, { engine })
  check('installing returns a router', router !== undefined)

  const remote = await service.spawnTerminal({ cwd: 'ssh://theta/tmp', rows: 24, cols: 80, argv: ['bash'] })
  check('a remote cwd diverts to the SSH PTY', calls.length === 0 && remote.pid === -1, `calls=${calls.length}`)

  const local = await service.spawnTerminal({ cwd: 'C:\\work\\here', argv: ['pwsh'] })
  check('a local cwd reaches the original primitive', calls.length === 1 && local.local === true, `calls=${calls.length}`)

  check('installing twice does not double-wrap', installRemoteTerminal(ctx, { engine }) === router)
  uninstallRemoteTerminal(service)
  check('uninstall restores the original primitive',
    typeof service.spawnTerminal === 'function' && (await service.spawnTerminal({ cwd: 'C:\\x', argv: ['pwsh'] })).local === true)
}


// ── the debug trace that used to write on every open/close is gone ──────────
//
// This was a temporary probe: it appended a line to a file on EVERY spawn and
// close, synchronously, and its default path (`/tmp/...`) resolves to a drive-
// relative `F:\tmp\...` on Windows, which is why it left a file there and why it
// was invisible on hosts without `/tmp`. The information it carried is already
// available: a successful open logs at info level and a failure rejects.
console.log('\n[no trace I/O on the terminal path]')
{
  const source = readFileSync(path.join(pluginRoot, 'lib', 'patch', 'patch-terminal.js'), 'utf8')
  check('the terminal module does no synchronous file I/O at all',
    !source.includes('appendFileSync') && !source.includes('node:fs'))
  check('the removed trace file, its path and its env switches are gone',
    !source.includes('DSH_SSH_WORKSPACE_TRACE') && !source.includes('ssh-workspace-terminal.log'))
}

  totalPassed += passed
  totalFailures += failures
})()

console.log(`\n=== ${totalPassed} passed, ${totalFailures} failed ===`)
if (totalFailures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}