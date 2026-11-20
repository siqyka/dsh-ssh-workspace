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

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createHost } from './support/plugin-host.mjs'
import { fakePtyChannel, fakePtyEngine } from './support/fake-channel-engine.mjs'

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
    { argv: ['/bin/bash'], expect: /bash -l/u, absent: /pwsh/u },
    { argv: ['/usr/local/bin/zsh', '-l'], expect: /zsh -l/u },
    { argv: ['C:\\Program Files\\PowerShell\\7\\pwsh.exe'], expect: /exec sh -l/u },
    { argv: ['/bin/sh'], expect: /exec sh -l/u },
  ]
  for (const item of cases) {
    const { engine, opens } = fakePtyEngine()
    const router = new RemoteTerminalRouter({ engine })
    await router.spawnTerminal({ cwd: 'ssh://kappa/srv/app', rows: 24, cols: 80, argv: item.argv })
    const command = opens[0].command
    const ok = item.expect.test(command) && (item.absent === undefined || !item.absent.test(command))
    check(`shell dialect ${JSON.stringify(item.argv[0])} maps to the remote family`,
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
  const source = readFileSync(path.join(pluginRoot, 'lib', 'patch-terminal.js'), 'utf8')
  check('the terminal module does no synchronous file I/O at all',
    !source.includes('appendFileSync') && !source.includes('node:fs'))
  check('the removed trace file, its path and its env switches are gone',
    !source.includes('DSH_SSH_WORKSPACE_TRACE') && !source.includes('ssh-workspace-terminal.log'))
}
console.log(`\n=== ${passed} passed, ${failures} failed ===`)
process.exit(failures === 0 ? 0 : 1)
