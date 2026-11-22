/**
 * The terminal a remote session gets: discovery, then the handle's contract.
 *
 * `remote-shells` asks which shells actually exist on the host and refuses to
 * report a sweep it could not complete; `browser-terminal` drives the returned
 * handle through the operations the browser serializes (output, write, resize,
 * close) and pins the ssh2 behaviours that make a half-implemented handle hang
 * the whole attachment.
 *
 * Run: node tests/remote-shells-smoke.mjs
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

let totalPassed = 0
let totalFailures = 0

// ---------------------------------------------------------------------------
// remote-shells-smoke.mjs
// ---------------------------------------------------------------------------
await (async () => {
/**
 * Remote shell discovery checks.
 *
 * The property under test is the one that makes the sidebar's "new terminal"
 * menu tell the truth: every row must be a shell that EXISTS on the host, and the
 * terminal that opens must run that shell — otherwise the label says `zsh` while
 * the process is `sh`.
 *
 * Two halves are exercised together because they share one cache:
 *
 * - `terminalController.shells()` is answered from the host for `ssh://`
 *   sessions, and from the untouched local method everywhere else;
 * - `spawnTerminal` prefers the discovered path when argv[0] names one.
 *
 * The honesty rule gets its own group: a sweep that did not complete must throw
 * and must NOT be cached, because a picker that silently substitutes this
 * machine's shells is the bug being fixed.
 *
 * Run: node tests/remote-shells-smoke.mjs
 */
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const {
  RemoteShellsRouter,
  installShellDiscovery,
  normalizeCandidates,
  parseShellSweep,
  shellArgsFor,
  shellsRouterFor,
  uninstallShellDiscovery,
} = await import(pathToFileURL(path.join(pluginRoot, 'lib/surface/shell.js')).href)
const { RemoteTerminalRouter } = await import(pathToFileURL(path.join(pluginRoot, 'lib/patch/patch-terminal.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** The answer a healthy Debian-ish host gives: bash login shell, three shells. */
const GOOD_SWEEP = [
  'dsh-shell:bash:/usr/bin/bash',
  'dsh-shell:zsh:/usr/bin/zsh',
  'dsh-shell:sh:/usr/bin/sh',
  'dsh-shell:login:/usr/bin/bash',
  'dsh-shells-done',
  '',
].join('\n')

/**
 * An engine double, recording every sweep.
 *
 * `respond` decides what each call resolves to, so one double covers the happy
 * path, transport failures and a host that answers without finishing.
 */
function fakeEngine (options = {}) {
  const state = { execs: [], generation: 1, detached: false }
  const engine = {
    generationOf (alias) { return { generation: state.generation } },
    assertNotDisabled (alias, remotePath) {
      if (state.detached) {
        throw new Error(`ssh-workspace: cannot access ssh://${alias}${remotePath}: the remote workspace is detached (re-enable it in the panel or with ssh_workspace_enable)`)
      }
    },
    exec (alias, script, opts) {
      state.execs.push({ alias, script, opts })
      if (options.hang === true) return new Promise(() => {})
      if (options.throw !== undefined) return Promise.reject(options.throw)
      if (typeof options.respond === 'function') return Promise.resolve(options.respond(alias, script, state.execs.length))
      return Promise.resolve({ success: true, exitCode: 0, stdout: GOOD_SWEEP })
    },
  }
  return { engine, state }
}

/** A controller double whose original `shells` answers from "this machine". */
function fakeController (shells) {
  const local = shells ?? [
    { path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', name: 'pwsh', args: ['-NoLogo'] },
    { path: 'C:\\Program Files\\Git\\bin\\bash.exe', name: 'bash', args: ['-i'] },
  ]
  const calls = []
  const controller = {
    config: { shellCandidates: ['zsh', 'bash', 'fish', 'sh', 'dash', 'ksh', 'pwsh'] },
    shells (agent, signal) { calls.push({ agent, signal }); return Promise.resolve(local) },
  }
  return { controller, calls, local }
}

/** A context double: `terminalController` and the cwd projection. */
function fakeCtx (controller, cwd) {
  const services = {
    terminalController: controller,
    workingDirectory: { get () { return cwd } },
  }
  return {
    logger: { info () {}, warn () {}, debug () {} },
    get (name) { return services[name] },
  }
}

const agentWith = (cwd) => ({ session: { header: { cwd } }, ctx: {} })

console.log('\n=== remote shells smoke ===\n')

// 1. One round trip, and the script asks about every candidate.
{
  const { engine, state } = fakeEngine()
  const { controller } = fakeController()
  const ctx = fakeCtx(controller, 'ssh://alpha/home/u/x')
  const router = installShellDiscovery(ctx, { engine, logger: ctx.logger })
  const list = await controller.shells(agentWith('ssh://alpha/home/u/x'))
  check('a remote session sweeps the host exactly once', state.execs.length === 1, `execs=${state.execs.length}`)
  check('the sweep runs on the session\'s own host', state.execs[0]?.alias === 'alpha', state.execs[0]?.alias)
  const script = state.execs[0]?.script ?? ''
  check('the sweep asks about every candidate',
    ['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh', 'pwsh'].every(name => script.includes(`command -v '${name}'`)), script)
  check('the sweep carries the login-shell line and its completion marker',
    script.includes('dsh-shell:login:') && script.includes('dsh-shells-done'), script)
  check('the sweep cannot abort on a missing utility', script.startsWith('set +e'), script.slice(0, 20))
  check('the answer is the host\'s list, not this machine\'s',
    list.map(item => item.name).join(',') === 'bash,zsh,sh', list.map(item => item.name).join(','))
  check('the install returns the router', router instanceof RemoteShellsRouter)
  uninstallShellDiscovery(controller)
}

// 2. Ordering and de-duplication.
{
  const parsed = parseShellSweep([
    'dsh-shell:bash:/bin/bash',
    'dsh-shell:zsh:/usr/bin/zsh',
    'dsh-shell:bash:/usr/bin/bash',
    'dsh-shell:login:/usr/local/bin/zsh',
    'dsh-shells-done',
  ].join('\n'))
  check('the login shell comes first', parsed[0]?.path === '/usr/local/bin/zsh', JSON.stringify(parsed.map(p => p.path)))
  check('a shell appears once per kind, keeping the earliest',
    parsed.filter(p => p.name === 'zsh').length === 1 && parsed.filter(p => p.name === 'bash').length === 1,
    JSON.stringify(parsed.map(p => p.path)))
  check('candidate order is preserved after the login shell',
    parsed.slice(1).map(p => p.name).join(',') === 'bash', parsed.slice(1).map(p => p.name).join(','))
  const relative = parseShellSweep([
    'dsh-shell:login:fish',
    'dsh-shell:bash:/bin/bash',
    'dsh-shells-done',
  ].join('\n'))
  check('a login shell that is not an absolute path is not used',
    relative[0]?.path === '/bin/bash', JSON.stringify(relative.map(p => p.path)))
}

// 3. Start-up arguments, and a candidate list that cannot be pasted into a shell.
{
  check('bash starts as a login shell', shellArgsFor('/bin/bash').join(',') === '-l', shellArgsFor('/bin/bash').join(','))
  check('zsh starts as a login shell', shellArgsFor('/usr/bin/zsh').join(',') === '-l', shellArgsFor('/usr/bin/zsh').join(','))
  check('sh starts as a login shell', shellArgsFor('/bin/sh').join(',') === '-l', shellArgsFor('/bin/sh').join(','))
  check('pwsh starts without its logo', shellArgsFor('/usr/bin/pwsh').join(',') === '-NoLogo', shellArgsFor('/usr/bin/pwsh').join(','))
  check('a .exe suffix still resolves to the pwsh family', shellArgsFor('C:\\pwsh.exe').join(',') === '-NoLogo', shellArgsFor('C:\\pwsh.exe').join(','))
  check('a Windows executable name is refused as a candidate',
    !normalizeCandidates(['payload.exe', 'bash']).includes('payload.exe'), JSON.stringify(normalizeCandidates(['payload.exe', 'bash'])))
  check('a candidate with shell metacharacters is refused',
    !normalizeCandidates(['bash; rm -rf /']).some(name => name.includes(';')), JSON.stringify(normalizeCandidates(['bash; rm -rf /'])))
  check('sh is always asked about, so the fallback has a row',
    normalizeCandidates(['zsh']).includes('sh'), JSON.stringify(normalizeCandidates(['zsh'])))
  // The menu label is the bare name: a session belongs to one host, so
  // `bash@alpha` would only make every row longer without telling anyone
  // anything the tab title does not already say.
  const profiled = parseShellSweep(['dsh-shell:bash:/usr/bin/bash', 'dsh-shells-done'].join('\n'))
  check('the displayed name is the bare basename', profiled[0]?.name === 'bash', profiled[0]?.name)
}

// 4. A local session never reaches the network.
{
  const { engine, state } = fakeEngine()
  const { controller, local } = fakeController()
  const ctx = fakeCtx(controller, '/home/u/proj')
  installShellDiscovery(ctx, { engine, logger: ctx.logger })
  const list = await controller.shells(agentWith('/home/u/proj'))
  check('a local session keeps the local list', list === local, JSON.stringify(list))
  check('a local session triggers no remote sweep', state.execs.length === 0, `execs=${state.execs.length}`)
  uninstallShellDiscovery(controller)
}

// 5. One probe per connection generation.
{
  const { engine, state } = fakeEngine()
  const { controller } = fakeController()
  const ctx = fakeCtx(controller, 'ssh://beta/srv/app')
  installShellDiscovery(ctx, { engine, logger: ctx.logger })
  await controller.shells(agentWith('ssh://beta/srv/app'))
  await controller.shells(agentWith('ssh://beta/srv/app'))
  check('two menus within one generation cost one sweep', state.execs.length === 1, `execs=${state.execs.length}`)
  state.generation = 2
  await controller.shells(agentWith('ssh://beta/srv/app'))
  check('a new connection re-sweeps the host', state.execs.length === 2, `execs=${state.execs.length}`)
  const router = controller[Object.getOwnPropertySymbols(controller).find(sym => sym.description?.endsWith('shell-discovery-installed'))]
  check('the previous generation is retired, not accumulated',
    router !== undefined && router.answers.size === 1
      && [...router.answers.keys()].every(key => key.endsWith('\u00002')),
    router === undefined ? 'no router' : JSON.stringify([...router.answers.keys()]))
  uninstallShellDiscovery(controller)
}

// 6. Concurrent callers share one in-flight sweep.
{
  const { engine, state } = fakeEngine()
  const router = new RemoteShellsRouter({ engine })
  // Two callers before the first sweep resolves: they must share one round trip
  // (the promise objects differ — `discover` is async — but the probe must not).
  const first = router.discover('alpha')
  const second = router.discover('alpha')
  check('concurrent callers share one round trip', state.execs.length === 1, `execs=${state.execs.length}`)
  const [a, b] = await Promise.all([first, second])
  check('both callers receive the same answer',
    a.length > 0 && a === b, `${a.length} / ${b.length}`)
  check('the shared sweep stays one round trip after settling', state.execs.length === 1, `execs=${state.execs.length}`)
}

// 7. A failed sweep is an error, never a shorter list, and is not remembered.
{
  const { engine, state } = fakeEngine({
    respond: (alias, script, count) => (count === 1
      // Truncated: the marker never arrived, so the answer is unknown.
      ? { success: true, exitCode: 0, stdout: 'dsh-shell:bash:/bin/bash\ndsh-shell:login:/bin/bash\n' }
      : { success: true, exitCode: 0, stdout: GOOD_SWEEP }),
  })
  const { controller } = fakeController()
  const ctx = fakeCtx(controller, 'ssh://gamma/home/u')
  installShellDiscovery(ctx, { engine, logger: ctx.logger })
  let error
  await controller.shells(agentWith('ssh://gamma/home/u')).then(
    (list) => { error = { resolved: list } },
    (failure) => { error = failure },
  )
  check('a sweep without its completion marker rejects', error instanceof Error, JSON.stringify(error))
  check('the rejection says the answer is unknown', /unknown/u.test(String(error?.message)), String(error?.message))
  const list = await controller.shells(agentWith('ssh://gamma/home/u'))
  check('the retry re-sweeps instead of inheriting the failure', state.execs.length === 2, `execs=${state.execs.length}`)
  check('the retry answers from the host', list.length === 3, JSON.stringify(list.map(item => item.name)))
  uninstallShellDiscovery(controller)
}

{
  const { engine } = fakeEngine({ respond: () => ({ success: false, exitCode: 255, stderr: 'connect ECONNREFUSED' }) })
  const router = new RemoteShellsRouter({ engine })
  let message = ''
  await router.discover('delta').catch((error) => { message = String(error?.message) })
  check('a sweep that exited non-zero rejects with the host\'s reason',
    message.includes('255'), message)
  let second = ''
  await router.discover('delta').catch((error) => { second = String(error?.message) })
  check('a transport failure is reported again on retry, not cached as a list',
    second.includes('255') && router.answers.size === 0, `${second} / answers=${router.answers.size}`)
}

{
  const { engine } = fakeEngine({ throw: new Error('no connection to epsilon') })
  const router = new RemoteShellsRouter({ engine })
  let message = ''
  await router.discover('epsilon').catch((error) => { message = String(error?.message) })
  check('a transport that throws is surfaced unchanged', message === 'no connection to epsilon', message)
  check('nothing is cached after a thrown sweep', router.probes.size === 0 && router.answers.size === 0,
    `probes=${router.probes.size} answers=${router.answers.size}`)
}

// 8. A detached workspace is refused before any round trip.
{
  const { engine, state } = fakeEngine()
  const { controller } = fakeController()
  const ctx = fakeCtx(controller, 'ssh://detached/opt/app')
  installShellDiscovery(ctx, { engine, logger: ctx.logger })
  state.detached = true
  let message = ''
  await controller.shells(agentWith('ssh://detached/opt/app')).catch((error) => { message = String(error?.message) })
  check('a detached workspace refuses the menu', message.includes('detached'), message)
  check('a detached workspace costs no round trip', state.execs.length === 0, `execs=${state.execs.length}`)
  uninstallShellDiscovery(controller)
}

// 9. Uninstall restores the original method.
{
  const { engine } = fakeEngine()
  const { controller, local } = fakeController()
  const ctx = fakeCtx(controller, 'ssh://alpha/srv')
  const before = controller.shells
  installShellDiscovery(ctx, { engine, logger: ctx.logger })
  check('install replaces shells()', controller.shells !== before)
  check('installing twice reuses the router', installShellDiscovery(ctx, { engine }) !== undefined
    && Object.getOwnPropertySymbols(controller).length === 2, String(Object.getOwnPropertySymbols(controller).length))
  uninstallShellDiscovery(controller)
  check('uninstall restores the original method', controller.shells === before)
  const list = await controller.shells(agentWith('ssh://alpha/srv'))
  check('the restored method answers locally', list === local)
}

{
  // A service without shells() is a shape mismatch, not an absent reason.
  const ctx = fakeCtx({ config: {} }, 'ssh://alpha/x')
  let error
  try {
    installShellDiscovery(ctx, { engine: fakeEngine().engine })
  } catch (failure) {
    error = failure
  }
  check('a controller without shells() throws instead of reporting itself absent',
    error instanceof Error && /no shells\(\)/u.test(String(error?.message)), String(error?.message))
}

// 10. spawnTerminal prefers the discovered path, and falls back otherwise.
{
  const { engine } = fakeEngine()
  const { controller } = fakeController()
  const ctx = fakeCtx(controller, 'ssh://alpha/home/u/proj')
  const router = installShellDiscovery(ctx, { engine, logger: ctx.logger })
  await controller.shells(agentWith('ssh://alpha/home/u/proj'))
  const opens = []
  const terminalEngine = {
    assertNotDisabled () {},
    async openChannel (alias, command, options) {
      opens.push({ alias, command, options })
      return { channel: { on () {}, once () {}, write (data, cb) { cb?.() }, end () {}, close () {}, setWindow () {}, stderr: { on () {} } }, release () {} }
    },
  }
  const terminal = new RemoteTerminalRouter({ engine: terminalEngine, router })
  await terminal.spawnTerminal({ cwd: 'ssh://alpha/home/u/proj', argv: ['/usr/bin/zsh'], rows: 24, cols: 80 })
  check('a discovered shell is started by its discovered path',
    opens[0]?.command?.includes("exec '/usr/bin/zsh' -l"), opens[0]?.command)
  check('a discovered shell does not fall back to sh', !opens[0]?.command?.includes('sh -l'), opens[0]?.command)
  await terminal.spawnTerminal({ cwd: 'ssh://alpha/home/u/proj', argv: ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\pwsh.exe', '-NoLogo'], rows: 24, cols: 80 })
  check('an undiscovered shell keeps the sh fallback', opens[1]?.command?.includes('exec sh -l'), opens[1]?.command)
  const bare = new RemoteTerminalRouter({ engine: terminalEngine, router: new RemoteShellsRouter({ engine: terminalEngine }) })
  await bare.spawnTerminal({ cwd: 'ssh://alpha/home/u/proj', argv: ['/usr/bin/zsh'], rows: 24, cols: 80 })
  check('nothing discovered means today\'s behaviour, unchanged',
    opens[2]?.command?.includes('command -v zsh') && opens[2]?.command?.includes('else exec sh -l'),
    opens[2]?.command)
  const noRouter = new RemoteTerminalRouter({ engine: terminalEngine })
  await noRouter.spawnTerminal({ cwd: 'ssh://alpha/home/u/proj', argv: ['/bin/bash'], rows: 24, cols: 80 })
  check('a terminal opened before any menu keeps its previous behaviour',
    opens[3]?.command?.includes('command -v bash'), opens[3]?.command)
  // The shipped composition never passes a router around: both install sites ask
  // for the engine's own, so the menu's answer and the terminal's lookup are the
  // same cache. A second router per site would silently double every probe.
  check('both install sites share one router per engine',
    shellsRouterFor(engine) === shellsRouterFor(engine)
      && shellsRouterFor(engine) !== shellsRouterFor(fakeEngine().engine),
    'the WeakMap is not keyed by engine')
  uninstallShellDiscovery(controller)
}


  totalPassed += passed
  totalFailures += failures
})()

// ---------------------------------------------------------------------------
// browser-terminal-smoke.mjs
// ---------------------------------------------------------------------------
await (async () => {
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
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { RemoteTerminalRouter } = await import(pathToFileURL(path.join(pluginRoot, 'lib/patch/patch-terminal.js')).href)

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


  totalPassed += passed
  totalFailures += failures
})()

console.log(`\n=== ${totalPassed} passed, ${totalFailures} failed ===`)
if (totalFailures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}