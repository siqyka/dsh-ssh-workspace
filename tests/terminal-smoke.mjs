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

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const {
  RemoteTerminalRouter,
  installRemoteTerminal,
  uninstallRemoteTerminal,
} = await import(pathToFileURL(path.join(pluginRoot, 'lib/patch-terminal.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/**
 * A channel double standing in for an ssh2 PTY channel.
 *
 * `close` is triggered explicitly (or by `terminate`) so the exit settlement is
 * deterministic instead of depending on a timer.
 */
function fakeChannel () {
  const handlers = new Map()
  const state = { writes: [], window: undefined, closed: false, released: 0 }
  const channel = {
    stderr: { on () {} },
    on (event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]) },
    once (event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]) },
    emit (event, ...args) { for (const handler of handlers.get(event) ?? []) handler(...args) },
    write (data, callback) { state.writes.push(data); callback?.() },
    end () {},
    setWindow (rows, cols, height, width, callback) {
      state.window = { rows, cols }
      callback?.()
    },
    close () {
      if (state.closed) return
      state.closed = true
      channel.emit('close', 0, null)
    },
  }
  return { channel, state }
}

/** An engine double that hands out the next fake channel and records the open. */
function fakeEngine () {
  const opens = []
  const engine = {
    /** No workspace is detached in this suite. */
    assertNotDisabled () {},
    async openChannel (alias, command, options) {
      const { channel, state } = fakeChannel()
      // Snapshot the abort state the router handed to the open: a signal that
      // fires later must not be visible here, and a pre-aborted one must be.
      opens.push({ alias, command, options, state, abortedAtOpen: options?.signal?.aborted === true })
      return { channel, release: () => { state.released += 1 } }
    },
  }
  return { engine, opens }
}

console.log('\n=== terminal smoke ===\n')

{
  const { engine, opens } = fakeEngine()
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
  const { engine, opens } = fakeEngine()
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
  const { engine, opens } = fakeEngine()
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
  const { engine } = fakeEngine()
  const router = new RemoteTerminalRouter({ engine })
  const handle = await router.spawnTerminal({ cwd: 'ssh://delta/tmp', rows: 24, cols: 80 })
  const foreground = await handle.inspectForeground()
  check('foreground inspection reports unknown instead of guessing', foreground === undefined, String(foreground))
}

{
  const { engine, opens } = fakeEngine()
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
  const { engine, opens } = fakeEngine()
  const router = new RemoteTerminalRouter({ engine })
  const handle = await router.spawnTerminal({ cwd: 'ssh://eta/tmp', rows: 24, cols: 80 })
  await handle.terminate()
  await handle.terminate()
  check('terminate closes the channel', opens[0].state.closed === true)
  check('repeated terminate releases the hold once', opens[0].state.released === 1, `released=${opens[0].state.released}`)
}

{
  // The host's `spec.signal` bounds the allocation, not the terminal: the local
  // backend passes it to node-pty's spawn and the process outlives the call.
  // The browser terminal's create() call carries a per-request signal that
  // aborts when that RPC settles, so the SSH channel must not follow it.
  const { engine, opens } = fakeEngine()
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
  const { engine, opens } = fakeEngine()
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
  const ctx = { get (name) { return name === 'subprocess' ? service : undefined } }
  const { engine } = fakeEngine()
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

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
process.exit(failures === 0 ? 0 : 1)
