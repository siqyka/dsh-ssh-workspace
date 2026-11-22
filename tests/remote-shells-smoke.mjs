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

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
process.exit(failures === 0 ? 0 : 1)
