/**
 * Browser-terminal checks for the remote handle's *operation* contract.
 *
 * A browser terminal does not just read output: `dsh-api-terminal-controller`
 * runs every terminal operation — output broadcasts, screen writes, input
 * writes, resizes — through ONE serialized `enqueue()` chain, and it answers
 * the attachment with a `snapshot` only once that chain reaches the attach
 * operation. So a single handle promise that never settles stops the whole
 * terminal: output freezes, keystrokes are never acknowledged, later
 * attachments hang on "connecting", and `close()` never completes.
 *
 * Two ssh2 behaviours make that failure easy to ship, and both are reproduced
 * here because the previous double was more forgiving than the real library:
 *
 * - `Channel.setWindow(rows, cols, height, width)` takes NO callback and
 *   returns `undefined`. Awaiting a callback there never settles. (The
 *   terminal suite's double calls one, which is exactly why it stayed green.)
 * - `Channel._write()` calls `return` WITHOUT invoking the callback when the
 *   channel's outgoing state is not `open`, so a write that races a close is
 *   not merely refused — it disappears.
 *
 * A quiet peer is the third: ssh2 emits 'close' only when the remote end
 * confirms it, and the harness's cleanup waits on `terminate()` and on the
 * output stream ending. A handle that waits for that confirmation instead of
 * settling itself leaks the remote shell and leaves a terminal identity that
 * can neither be attached nor removed.
 *
 * Run: node tests/browser-terminal-smoke.mjs
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { RemoteTerminalRouter } = await import(pathToFileURL(path.join(pluginRoot, 'lib/patch-terminal.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** Settle a promise, or report that it never settled inside the window. */
async function settled (promise, ms = 1000) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('WEDGED'), ms)
    timer.unref?.()
  })
  try {
    const outcome = await Promise.race([
      Promise.resolve(promise).then(() => 'settled', (error) => `threw:${error?.message ?? error}`),
      timeout,
    ])
    return outcome
  } finally {
    clearTimeout(timer)
  }
}

/**
 * A PTY channel double that copies ssh2's real contract, not a friendlier one.
 *
 * @returns {object} the channel, its observable state, and a way to confirm the
 *   close the way a real (answering) server would.
 */
function ssh2Channel () {
  const handlers = new Map()
  const state = {
    writes: [],
    windows: [],
    closed: false,
    destroyed: 0,
    emitsClose: false,
    /** ssh2 keeps this on `channel.outgoing.state`; '_write' keys off it. */
    outgoing: { state: 'open' },
  }
  const channel = {
    stderr: { on () {} },
    outgoing: state.outgoing,
    on (event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
      return channel
    },
    once (event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
      return channel
    },
    emit (event, ...args) {
      for (const handler of [...(handlers.get(event) ?? [])]) handler(...args)
    },
    // ssh2: write(data, encoding, cb) → Writable; the callback is dropped, not
    // errored, when the channel is not open.
    write (data, callback) {
      if (state.outgoing.state !== 'open') return false
      state.writes.push(data)
      callback?.()
      return true
    },
    // ssh2: setWindow(rows, cols, height, width) — no callback parameter at all.
    setWindow (rows, cols, height, width) {
      state.windows.push({ rows, cols, height, width })
    },
    close () {
      if (state.outgoing.state === 'opening' || state.outgoing.state === 'open' || state.outgoing.state === 'eof') {
        state.outgoing.state = 'closing'
      }
      state.closed = true
      if (state.emitsClose) channel.emit('close', null, 'SIGHUP')
    },
    destroy () {
      state.destroyed += 1
      state.outgoing.state = 'closed'
      return channel
    },
    /** A real server answering CHANNEL_CLOSE. */
    confirmClose (code = null, signal = 'SIGHUP') {
      state.outgoing.state = 'closed'
      channel.emit('close', code, signal)
    },
  }
  return { channel, state }
}

/** An engine double handing out one faithful channel. */
function ssh2Engine () {
  const opened = ssh2Channel()
  const engine = {
    assertNotDisabled () {},
    async openChannel () { return { channel: opened.channel, release: () => { opened.state.released = (opened.state.released ?? 0) + 1 } } },
  }
  return { engine, state: opened.state, channel: opened.channel }
}

async function openRemote (cwd = 'ssh://alpha/home/dev/proj') {
  const { engine, state, channel } = ssh2Engine()
  const router = new RemoteTerminalRouter({ engine })
  const handle = await router.spawnTerminal({ cwd, argv: ['bash'], cols: 80, rows: 24, terminalType: 'xterm-256color' })
  return { handle, state, channel }
}

console.log('\n=== browser terminal smoke ===\n')

{
  // Regression: resize awaited a callback that ssh2 never provides, so the
  // promise stayed pending and the controller's serialized queue stopped dead.
  const { handle, state } = await openRemote('ssh://alpha/srv/app')
  const outcome = await settled(handle.resize(100, 30))
  check('resize settles even though ssh2 reports nothing back', outcome === 'settled', outcome)
  check('the window change was actually handed to the channel',
    state.windows.at(-1)?.cols === 100 && state.windows.at(-1)?.rows === 30, JSON.stringify(state.windows))
  check('the window change carries ssh2\'s height/width arguments',
    state.windows.at(-1)?.height === 0 && state.windows.at(-1)?.width === 0, JSON.stringify(state.windows.at(-1)))
  await handle.terminate()
}

{
  // The controller's queue: the browser sends a resize from xterm's fit right
  // after the snapshot, then the user's keystrokes. Every one of these must
  // settle, and the write must reach the channel — this is the "typing does
  // nothing" half of the report.
  const { handle, state } = await openRemote('ssh://beta/srv/app')
  let queue = Promise.resolve()
  const enqueue = (operation) => {
    const pending = queue.then(operation)
    queue = pending.catch(() => {})
    return pending
  }
  const resize = await settled(enqueue(() => handle.resize(120, 40)))
  const write = await settled(enqueue(() => handle.write('echo still-alive\n')))
  const snapshot = await settled(enqueue(() => 'snapshot'))
  check('a resize queued like the browser\'s fit settles', resize === 'settled', resize)
  check('the keystroke queued behind that resize settles', write === 'settled', write)
  check('the channel received the keystroke', state.writes.includes('echo still-alive\n'), JSON.stringify(state.writes))
  check('an operation queued after both still runs (the queue is not wedged)', snapshot === 'settled', snapshot)
  await handle.terminate()
}

{
  // ssh2 drops the write callback when the channel is no longer open. Awaiting
  // it would hang; refusing reports an unprovable accept instead.
  const { handle, state, channel } = await openRemote('ssh://gamma/srv/app')
  state.outgoing.state = 'eof'
  const outcome = await settled(handle.write('x'))
  check('a write on a no-longer-open channel settles instead of hanging', outcome.startsWith('threw:'), outcome)
  check('and it does not reach the channel', state.writes.length === 0, JSON.stringify(state.writes))
  channel.destroy()
  await handle.terminate()
}

{
  // A peer that never confirms CHANNEL_CLOSE must not keep the harness's
  // cleanup pending: terminate() settles `done` and ends `output` itself.
  const { handle, state } = await openRemote('ssh://delta/srv/app')
  const chunks = []
  handle.output.on('data', (chunk) => chunks.push(String(chunk)))
  let ended = false
  handle.output.on('end', () => { ended = true })
  let outcome
  handle.done.then((value) => { outcome = value }, (error) => { outcome = error })
  handle.channel.emit('data', Buffer.from('remote banner'))

  const termination = await settled(handle.terminate())
  await new Promise((resolve) => setTimeout(resolve, 10))
  check('terminate settles while the peer stays quiet', termination === 'settled', termination)
  check('output ends without the peer\'s close event', ended === true, `ended=${ended}`)
  check('done resolves without the peer\'s close event', outcome !== undefined, String(outcome))
  check('the settle reports "no exit status reported" rather than inventing one',
    outcome?.exitCode === null && outcome?.signal === null, JSON.stringify(outcome))
  check('the channel was asked to close', state.closed === true)
  check('the connection hold is released', state.released === 1, `released=${state.released}`)
  check('the banner that did arrive is kept', chunks.join('') === 'remote banner', JSON.stringify(chunks.join('')))
}

{
  // A quiet channel's ssh2 record has to be dropped locally, or the pooled
  // connection keeps a channel the peer never finishes.
  const { handle, state } = await openRemote('ssh://epsilon/srv/app')
  await handle.terminate()
  await new Promise((resolve) => setTimeout(resolve, 400))
  check('a peer that never confirms has its channel dropped locally', state.destroyed === 1, `destroyed=${state.destroyed}`)
  // A confirming peer must NOT be force-destroyed.
  const second = await openRemote('ssh://epsilon/srv/app2')
  second.state.emitsClose = true
  await second.handle.terminate()
  await new Promise((resolve) => setTimeout(resolve, 400))
  check('a peer that confirms the close is not force-destroyed', second.state.destroyed === 0, `destroyed=${second.state.destroyed}`)
}

{
  // After terminate the handle must keep refusing work, without wedging.
  const { handle, state } = await openRemote('ssh://zeta/srv/app')
  await handle.terminate()
  const writesAfter = state.writes.length
  const write = await settled(handle.write('echo late\n'))
  const resize = await settled(handle.resize(100, 30))
  check('a write after terminate is refused, not queued', write.startsWith('threw:'), write)
  check('a resize after terminate is a no-op that settles', resize === 'settled', resize)
  check('neither reached the channel', state.writes.length === writesAfter, JSON.stringify(state.writes))
}

{
  // The real close still wins when it arrives first: its exit status must be
  // reported and the later terminate must not re-settle or re-release.
  const { handle, state, channel } = await openRemote('ssh://eta/srv/app')
  let outcome
  handle.done.then((value) => { outcome = value })
  channel.confirmClose(3, null)
  await new Promise((resolve) => setTimeout(resolve, 0))
  check('a confirmed close reports its exit status', outcome?.exitCode === 3, JSON.stringify(outcome))
  await handle.terminate()
  check('terminate after a real close does not settle twice', outcome?.exitCode === 3, JSON.stringify(outcome))
  check('and releases the hold exactly once', state.released === 1, `released=${state.released}`)
}

{
  // A transport error settles `done` as a rejection and still releases.
  const { handle, state, channel } = await openRemote('ssh://theta/srv/app')
  let rejected
  handle.done.catch((error) => { rejected = error })
  channel.emit('error', new Error('transport died'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  check('a channel error rejects done', String(rejected?.message) === 'transport died', String(rejected?.message))
  check('a failed terminal releases the hold exactly once', state.released === 1, `released=${state.released}`)
  await handle.terminate()
  check('terminate after a failure releases nothing more', state.released === 1, `released=${state.released}`)
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
process.exit(failures === 0 ? 0 : 1)
