/**
 * Regression: the "local changes" surfaces must keep working on a remote
 * workspace after the Host normalizes the remote target to a PLAIN path.
 *
 * The Host's Forge panel measures the local-changes card with git bound to
 * `inspection.checkout.root`, and that value is produced by
 * `ctx.fs.processPath(ctx.fs.resolve(...))` — which is `/mnt/data/proj`, not
 * `ssh://host/mnt/data/proj` (the scheme is what the fs seam uses, not what a
 * process cwd uses). `dsh-workspace-changes` then hands the same plain
 * `workspace.root` to `git add` / `write-tree` / `diff-tree`. Before this change
 * the subprocess bridge only diverted `isRemotePath(spec.cwd)`, so every one
 * of those commands fell back to a local spawn against a directory that does
 * not exist on this machine, failed, and the card was empty.
 *
 * The rule that admits a plain path is deliberately narrow (see
 * `resolvePlainRemoteRoute` in lib/patch/patch-subprocess.js):
 *
 *   route a POSIX-absolute plain path to a remote host only when it lies under
 *   exactly one mounted remote root, that root's host is still usable, and the
 *   same path does not exist on this machine.
 *
 * This suite pins the decision table, the bridge's observable behaviour, and —
 * when a real host is configured — the exact call shapes the change tracker
 * and the Forge panel produce.
 *
 * Run: node tests/local-changes-remote-smoke.mjs
 * Live: DSH_WS_TEST_ALIAS=910b-05 \
 *       DSH_CORE_ROOT=/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules \
 *       node tests/local-changes-remote-smoke.mjs
 *
 * Without `DSH_WS_TEST_ALIAS` the pure half still runs and the live half
 * prints SKIP lines: a skipped live check must never be counted as a pass.
 */

import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createHost } from './support/plugin-host.mjs'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// The live half imports remote-fs.js, which borrows a Host peer. Point the
// resolver at an assembled tree when the caller named one — the pure half needs
// nothing but ssh2, which this package installs itself.
if (process.env.DSH_CORE_ROOT !== undefined && process.env.DSH_CORE_ROOT !== '') {
  process.env.DSH_PEER_ROOT = [process.env.DSH_CORE_ROOT, process.env.DSH_PEER_ROOT].filter(Boolean).join(path.delimiter)
}

let passed = 0
let failures = 0
const failureList = []
function check (label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  PASS  ${label}`)
  } else {
    failures += 1
    const line = `${label}${detail === undefined ? '' : ` — ${detail}`}`
    failureList.push(line)
    console.log(`  FAIL  ${line}`)
  }
}

let bridge
try {
  bridge = await import(pathToFileURL(path.join(pluginRoot, 'lib/patch/patch-subprocess.js')).href)
} catch (error) {
  console.log('\n=== local-changes-remote smoke ===\n')
  console.log(`  SKIP  the plugin's own dependencies are not resolvable here: ${error instanceof Error ? error.message : String(error)}`)
  console.log('\n=== 0 passed, 0 failed, 1 suite skipped ===')
  process.exit(0)
}
const { PLAIN_ROUTE_REASONS, StreamTail, installRemoteSubprocess, resolvePlainRemoteRoute, unwrapSandboxArgv } = bridge

console.log('\n=== local-changes-remote smoke ===')

// ── a channel double, and a service double whose local half is observable ────

/** A channel double that reports one exit status and optionally some stdout. */
function fakeChannel (exitCode, output) {
  const stream = new EventEmitter()
  stream.stderr = new EventEmitter()
  stream.signal = () => {}
  stream.close = () => {}
  stream.end = () => {
    if (output !== undefined) stream.emit('data', Buffer.from(output, 'utf8'))
    setImmediate(() => stream.emit('close', exitCode, undefined))
  }
  return stream
}

/**
 * Install the bridge on a fresh service double.
 *
 * @param {object} options - harness options.
 * @param {string[]} [options.roots] - mounted roots; omitted means "no mount".
 * @param {{exitCode?: number, output?: string}} [options.run] - what the fake remote reports.
 * @param {object} [options.logger] - logger double.
 * @param {string[]} [options.diagnostics] - receives `record()` events.
 * @param {(alias: string, remotePath: string) => (string | undefined)} [options.hostRefusal] - host probe.
 * @param {object} [options.localResult] - when set, the original spawn returns this.
 * @returns {object} the harness.
 */
function harness (options = {}) {
  const scripts = []
  const localCalls = []
  const warnings = []
  const diagnostics = []
  const record = {
    inFlight: 0,
    idleAt: Date.now(),
    broken: false,
    client: {
      exec: (script, _optionsOrCb, maybeCb) => {
        scripts.push(script)
        const cb = typeof _optionsOrCb === 'function' ? _optionsOrCb : maybeCb
        cb(undefined, fakeChannel(options.run?.exitCode ?? 0, options.run?.output))
      },
    },
  }
  const engine = {
    fs: options.roots === undefined ? undefined : { roots: new Set(options.roots) },
    acquire: async () => record,
    assertNotDisabled: () => {},
    closeRecord: () => {},
    isDisabledTarget: options.isDisabledTarget,
    store: options.store,
    diagnostics: { record: (kind, message, detail) => diagnostics.push({ kind, message, detail }) },
  }
  const service = {
    spawn: (spec) => {
      localCalls.push(spec)
      if (options.localResult !== undefined) return options.localResult
      throw new Error('unexpected local spawn')
    },
  }
  const ctx = createHost({ services: { subprocess: service } }).ctx
  const logger = { info: () => {}, warn: (message) => warnings.push(message), debug: () => {} }
  const router = installRemoteSubprocess(ctx, { engine, logger: options.logger ?? logger })
  return { service, router, scripts, localCalls, warnings, diagnostics, record }
}

/** The Forge panel's GIT_ENV: every key present, every value undefined. */
const FORGE_GIT_ENV = Object.fromEntries([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CEILING_DIRECTORIES',
  'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE', 'GIT_REPLACE_REF_BASE',
  'GIT_ATTR_SOURCE',
].map(key => [key, undefined]))

/**
 * One git spec, in the shape the change tracker / Forge panel build.
 *
 * @param {string} cwd - the spec's cwd.
 * @param {string[]} args - git arguments (without the executable).
 * @param {object} [env] - extra env.
 * @param {string[]} [prefix] - sandbox launcher prefix before `git`.
 * @returns {object} the spec.
 */
function gitSpec (cwd, args, env = {}, prefix = []) {
  return {
    argv: [...prefix, 'git', '--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
    cwd,
    env: {
      ...FORGE_GIT_ENV,
      GIT_CONFIG_COUNT: '0',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      LC_ALL: 'C',
      ...env,
    },
    graceMs: 2000,
    signal: AbortSignal.timeout(30_000),
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 1 << 20 },
      stderr: { maxBytes: 1 << 20 },
    },
  }
}

// ── the decision rule, in isolation ──────────────────────────────────────────

console.log('\n[decision rule]')

const ROOT = 'ssh://testhost/mnt/data/proj'

{
  const decision = resolvePlainRemoteRoute('/mnt/data/proj/sub/file.txt', {
    roots: [ROOT],
    existsLocally: () => false,
  })
  check('a descendant of the one mounted root routes to that host',
    decision.kind === 'remote' && decision.alias === 'testhost' && decision.remotePath === '/mnt/data/proj/sub/file.txt',
    JSON.stringify(decision))
  check('the verdict keeps the root that admitted it',
    decision.root === ROOT, String(decision.root))
}

{
  const decision = resolvePlainRemoteRoute('/mnt/data/proj', { roots: [ROOT], existsLocally: () => false })
  check('the mounted root itself routes (the Forge checkout root is exactly this)',
    decision.kind === 'remote' && decision.remotePath === '/mnt/data/proj', JSON.stringify(decision))
}

{
  const decision = resolvePlainRemoteRoute('/mnt/data/proj', { roots: [ROOT], existsLocally: () => true })
  check('a path that exists on this machine is never routed',
    decision.kind === 'local' && decision.reason === PLAIN_ROUTE_REASONS.EXISTS_LOCALLY, JSON.stringify(decision))
}

{
  const decision = resolvePlainRemoteRoute('/mnt/data/proj', {
    roots: [ROOT],
    existsLocally: () => { throw new Error('unreadable') },
  })
  check('an existence probe that cannot answer counts as "exists" (fail closed)',
    decision.kind === 'local' && decision.reason === PLAIN_ROUTE_REASONS.EXISTS_LOCALLY, JSON.stringify(decision))
}

{
  const decision = resolvePlainRemoteRoute('/mnt/data/proj/x', {
    roots: [ROOT, 'ssh://otherhost/mnt/data/proj'],
    existsLocally: () => false,
  })
  check('one path under two roots is ambiguous and stays local',
    decision.kind === 'local' && decision.reason === PLAIN_ROUTE_REASONS.AMBIGUOUS_ROOT, JSON.stringify(decision))
  check('the ambiguity reports both candidate roots',
    Array.isArray(decision.candidates) && decision.candidates.length === 2,
    JSON.stringify(decision.candidates))
}

{
  const decision = resolvePlainRemoteRoute('/mnt/data/proj/nested/x', {
    roots: ['ssh://testhost/mnt/data/proj', 'ssh://testhost/mnt/data/proj/nested'],
    existsLocally: () => false,
  })
  check('nested roots on one host are still two roots and stay ambiguous',
    decision.kind === 'local' && decision.reason === PLAIN_ROUTE_REASONS.AMBIGUOUS_ROOT, JSON.stringify(decision))
}

{
  const decision = resolvePlainRemoteRoute('/mnt/data/proj/x', {
    roots: ['ssh://testhost/mnt/data/proj', 'ssh://testhost/mnt/data/proj/'],
    existsLocally: () => false,
  })
  check('the same root spelled twice is one root, not an ambiguity',
    decision.kind === 'remote' && decision.alias === 'testhost', JSON.stringify(decision))
}

{
  const decision = resolvePlainRemoteRoute('/mnt/data/proj2/x', { roots: [ROOT], existsLocally: () => false })
  check('a sibling directory is not contained (prefix collision)',
    decision.kind === 'local' && decision.reason === PLAIN_ROUTE_REASONS.NO_MOUNTED_ROOT, JSON.stringify(decision))
}

{
  const decision = resolvePlainRemoteRoute('/anything', { roots: [], existsLocally: () => false })
  check('no mounted root means the local behavior',
    decision.kind === 'local' && decision.reason === PLAIN_ROUTE_REASONS.NO_MOUNTED_ROOT, JSON.stringify(decision))
}

for (const [label, cwd] of [
  ['a relative path', 'mnt/data/proj'],
  ['a Windows drive path', 'C:\\Users\\me\\proj'],
  ['a UNC path', '\\\\server\\share\\proj'],
  ['a bare ssh:// spelling (handled before this rule)', 'ssh://testhost/mnt/data/proj'],
]) {
  const decision = resolvePlainRemoteRoute(cwd, { roots: [ROOT], existsLocally: () => false })
  check(`${label} is never routed by the plain-path rule`,
    decision.kind === 'local' && decision.reason === PLAIN_ROUTE_REASONS.NOT_POSIX_ABSOLUTE, JSON.stringify(decision))
}

{
  const decision = resolvePlainRemoteRoute('/mnt/data/proj/x', {
    roots: [ROOT],
    existsLocally: () => false,
    hostRefusal: () => 'the host is not resolvable: unknown SSH host "testhost"',
  })
  check('an unusable host keeps the local behavior',
    decision.kind === 'local' && decision.reason === PLAIN_ROUTE_REASONS.HOST_UNAVAILABLE, JSON.stringify(decision))
  check('the host refusal carries its reason',
    /not resolvable/u.test(decision.detail ?? ''), String(decision.detail))
}

{
  const decision = resolvePlainRemoteRoute('/mnt/data/proj/x', {
    roots: [ROOT],
    existsLocally: () => false,
    hostRefusal: () => { throw new Error('state unavailable') },
  })
  check('a host probe that throws is a refusal, not a route',
    decision.kind === 'local' && decision.reason === PLAIN_ROUTE_REASONS.HOST_UNAVAILABLE, JSON.stringify(decision))
}

// ── the bridge's observable behavior ────────────────────────────────────────

console.log('\n[plain-path bridge]')

{
  const h = harness({ roots: [ROOT], run: { output: '/mnt/data/proj\n/mnt/data/proj/.git\n.git/objects\n' } })
  const handle = h.service.spawn(gitSpec('/mnt/data/proj', ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-path', 'objects']))
  const outcome = await handle.done
  const script = h.scripts[0] ?? ''
  check('a plain cwd under the one mounted root runs on the host',
    h.localCalls.length === 0 && h.scripts.length === 1, `local=${h.localCalls.length} remote=${h.scripts.length}`)
  check('the remote script changes into the plain (remote-world) path',
    script.includes("cd '/mnt/data/proj'"), script)
  check('the plain-path call settles with the remote exit code', outcome.exitCode === 0, JSON.stringify(outcome))
  check('remote stdout keeps its remote absolute paths unchanged',
    handle.collected.stdout.readFrom(0).text === '/mnt/data/proj\n/mnt/data/proj/.git\n.git/objects\n',
    JSON.stringify(handle.collected.stdout.readFrom(0).text))
}

{
  // The follow-up command in the Host's chain: the stdout of rev-parse is fed
  // back as the cwd / env of the next call, still without a scheme.
  const h = harness({ roots: [ROOT], run: { output: ' M tracked.txt\n?? untracked.txt\n' } })
  const spec = gitSpec('/mnt/data/proj', ['status', '--porcelain'], {
    GIT_ALTERNATE_OBJECT_DIRECTORIES: '/mnt/data/proj/.git/objects',
  })
  const handle = h.service.spawn(spec)
  await handle.done
  const script = h.scripts[0] ?? ''
  check('a follow-up git call on the plain root also runs remotely',
    h.localCalls.length === 0 && h.scripts.length === 1, `local=${h.localCalls.length}`)
  check('a plain remote env path is handed to the remote command as-is',
    script.includes("export GIT_ALTERNATE_OBJECT_DIRECTORIES='/mnt/data/proj/.git/objects'"), script)
}

{
  const h = harness({ roots: [ROOT] })
  const handle = h.service.spawn(gitSpec('/mnt/data/proj', ['add', '--all', '--ignore-errors']))
  await handle.done
  const script = h.scripts[0] ?? ''
  check('a destructive-shaped git command follows the same (single) gate',
    h.localCalls.length === 0 && script.includes("exec 'git'") && script.includes("'add' '--all' '--ignore-errors'"), script)
}

{
  const h = harness({ roots: [ROOT] })
  const prefix = ['landlock-run', '--ro-bind', '/usr', '/usr', '--']
  const handle = h.service.spawn(gitSpec('/mnt/data/proj', ['rev-parse', '--show-toplevel'], {}, prefix))
  await handle.done
  check('the sandbox wrapper is stripped before the git/ripgrep whitelist (wrapper stripping intact)',
    h.scripts.length === 1 && h.scripts[0].includes("exec 'git' '--no-optional-locks'"), h.scripts[0] ?? '')
  check('the script contains no literal "undefined" env export (no literal undefined export)',
    !(h.scripts[0] ?? '').includes("'undefined'"), h.scripts[0] ?? '')
}

// ── the sandbox wrapper: POSIX rungs AND the Windows runner ──────────────────
//
// DSH confines an execution by prefixing the command with a runner, so the
// bridge sees `[runner…, '--', git…]` and the git/ripgrep whitelist would match
// the RUNNER. Stripping only the POSIX rungs left the Windows shape intact, and
// on Windows confinement is the only path a git call takes — so the "route git
// to the remote host" branch never fired there at all. The shapes below are the
// ones `dsh-sandbox-local` really builds (`confine()` appends the payload after
// the profile flags; `windowsAclRunnerArgv()` supplies those flags).
console.log('\n[sandbox wrapper]')
{
  const WIN_NODE = 'C:\\Program Files\\nodejs\\node.exe'
  const WIN_RUNNER = 'C:\\Users\\u\\AppData\\Roaming\\dsh\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js'
  const winFlags = [
    '--workspace', 'C:\\ws', '--temp', 'C:\\Users\\u\\AppData\\Local\\Temp\\dsh-ab12',
    '--mode', 'workspace-write', '--write-sid', 'S-1-5-21-1', '--temp-write-sid', 'S-1-5-21-2',
  ]
  const winPrefix = [WIN_NODE, WIN_RUNNER, ...winFlags]
  // A development build reaches the runner through the source entry, with the
  // tsx loader in front of it — same namespace marker, different file name.
  const winDevPrefix = [
    WIN_NODE, '--import', 'data:text/javascript,import%20%7B%20register%20%7D',
    'C:\\src\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\src\\runner.ts',
    '--workspace', 'C:\\ws', '--mode', 'read-only',
  ]

  check('the Windows [node, runner.js, …flags] wrapper is stripped',
    JSON.stringify(unwrapSandboxArgv([...winPrefix, '--', 'git', 'status'])) === JSON.stringify(['git', 'status']),
    JSON.stringify(unwrapSandboxArgv([...winPrefix, '--', 'git', 'status'])))
  check('the development runner entry tsx loads is stripped too',
    JSON.stringify(unwrapSandboxArgv([...winDevPrefix, '--', 'git', 'status'])) === JSON.stringify(['git', 'status']),
    JSON.stringify(unwrapSandboxArgv([...winDevPrefix, '--', 'git', 'status'])))
  for (const launcher of ['landlock-run', 'bwrap', 'sandbox-exec']) {
    const wrapped = [launcher, '--ro-bind', '/usr', '/usr', '--', 'git', 'status']
    check(`the POSIX ${launcher} wrapper is still stripped`,
      JSON.stringify(unwrapSandboxArgv(wrapped)) === JSON.stringify(['git', 'status']),
      JSON.stringify(unwrapSandboxArgv(wrapped)))
  }
  // Negative cases: these are NOT wrappers and stripping them would hand a
  // caller's own argv to the whitelist under the wrong interpretation.
  for (const [label, argv] of [
    ['node running an ordinary script with its own --', ['node', 'script.js', '--', 'git', 'status']],
    ['git with its own -- separator', ['git', '--', 'status']],
    ['an unrelated prefix program', ['C:\\tools\\wrap.exe', '--', 'git', 'status']],
    ['a sandbox-named program that is not a runner', ['C:\\tools\\dsh-sandbox-helper.exe', '--', 'git', 'status']],
    ['a wrapper shape with no separator', [WIN_NODE, WIN_RUNNER, '--workspace', 'C:\\ws']],
  ]) {
    const out = unwrapSandboxArgv(argv)
    check(`not stripped: ${label}`, JSON.stringify(out) === JSON.stringify(argv), JSON.stringify(out))
  }
  // The packaged Desktop fronts the windows-acl runner with ITS OWN binary,
  // so the front token is the app exe, not `node`. Only identity with this
  // process's executable may recognise it: the same argv from a process that
  // is not that exe must stay unrecognised.
  const DESKTOP = 'E:\\software\\DSH\\DeepSeek Harness.exe'
  {
    const realExecPath = process.execPath
    process.execPath = DESKTOP
    try {
      const desktopPrefix = [DESKTOP, WIN_RUNNER, ...winFlags]
      const out = unwrapSandboxArgv([...desktopPrefix, '--', 'git', 'status'])
      check('the packaged Desktop app-binary front is stripped by identity',
        JSON.stringify(out) === JSON.stringify(['git', 'status']), JSON.stringify(out))
      for (const electron of ['electron', 'C:\\Program Files\\electron\\electron.exe']) {
        const prefix = [electron, WIN_RUNNER, ...winFlags]
        const electronOut = unwrapSandboxArgv([...prefix, '--', 'git', 'status'])
        check(`an unpackaged build's ${electron.endsWith('.exe') ? 'electron.exe' : 'electron'} front is stripped`,
          JSON.stringify(electronOut) === JSON.stringify(['git', 'status']), JSON.stringify(electronOut))
      }
    } finally {
      process.execPath = realExecPath
    }
  }
  {
    const desktopPrefix = [DESKTOP, WIN_RUNNER, ...winFlags]
    const argv = [...desktopPrefix, '--', 'git', 'status']
    const out = unwrapSandboxArgv(argv)
    check('not stripped: the same app-exe argv when this process is NOT that executable',
      JSON.stringify(out) === JSON.stringify(argv), JSON.stringify(out))
    const ptc = [process.execPath, 'C:\\ptc\\worker-bootstrap.js', '--program', 'x']
    const ptcOut = unwrapSandboxArgv(ptc)
    check('not stripped: the PTC worker front carries no sandbox namespace',
      JSON.stringify(ptcOut) === JSON.stringify(ptc), JSON.stringify(ptcOut))
  }
}

{
  // End to end through the bridge: the wrapper is what makes a confined git
  // call reach the remote branch, and its absence must still refuse loudly.
  const h = harness({ roots: [ROOT], run: { output: ' M tracked.txt\n' } })
  // `confine()` appends the payload AFTER the profile flags, behind `--`.
  const WIN_PREFIX = [
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Users\\u\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js',
    '--workspace', 'C:\\ws', '--mode', 'read-only', '--',
  ]
  const wrapped = h.service.spawn(gitSpec('ssh://testhost/mnt/data/proj', ['status', '--porcelain'], {}, WIN_PREFIX))
  await wrapped.done
  check('a Windows-confined git call on an ssh:// cwd reaches the remote branch',
    h.scripts.length === 1 && h.scripts[0].includes("exec 'git'") && h.localCalls.length === 0,
    `scripts=${h.scripts.length} local=${h.localCalls.length}`)

  const h2 = harness({ roots: [ROOT], run: { output: ' M tracked.txt\n' } })
  const wrappedPlain = h2.service.spawn(gitSpec(ROOT, ['status', '--porcelain'], {}, WIN_PREFIX))
  await wrappedPlain.done
  check('a Windows-confined git call on a plain mounted root reaches the remote branch',
    h2.scripts.length === 1 && h2.scripts[0].includes("exec 'git'") && h2.localCalls.length === 0,
    `scripts=${h2.scripts.length} local=${h2.localCalls.length}`)

  let refusal
  try {
    const spec = gitSpec('ssh://testhost/mnt/data/proj', ['status'])
    spec.argv = ['C:\\Program Files\\nodejs\\node.exe', 'C:\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js', '--mode', 'read-only', '--', 'bash', '-lc', 'git status']
    h2.service.spawn(spec)
  } catch (error) {
    refusal = error
  }
  check('a wrapper around a NON-whitelisted command still refuses instead of being let through',
    refusal instanceof Error && /only git and ripgrep/u.test(refusal.message), String(refusal?.message))

  let negative
  try {
    const spec = gitSpec('ssh://testhost/mnt/data/proj', ['status'])
    spec.argv = ['node', 'script.js', '--', 'git', 'status']
    h2.service.spawn(spec)
  } catch (error) {
    negative = error
  }
  check('an ordinary node script keeps its argv and is refused for argv[0], not mistaken for a wrapper',
    negative instanceof Error && /cannot run "node"/u.test(negative.message), String(negative?.message))

  // The Forge panel's real shape: the official change-request plugin confines
  // git, and the packaged Desktop fronts that confinement with its own exe.
  const h3 = harness({ roots: [ROOT], run: { output: ' M tracked.txt\n' } })
  const desktopExecPath = 'E:\\software\\DSH\\DeepSeek Harness.exe'
  const realExecPath = process.execPath
  process.execPath = desktopExecPath
  try {
    const desktopFronted = [
      desktopExecPath,
      'C:\\Users\\u\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js',
      '--workspace', 'C:\\ws', '--mode', 'read-only', '--',
    ]
    let desktopRefusal
    let desktopHandle
    try {
      desktopHandle = h3.service.spawn(gitSpec('ssh://testhost/mnt/data/proj', ['status', '--porcelain'], {}, desktopFronted))
    } catch (error) {
      desktopRefusal = error
    }
    await desktopHandle?.done
    check('a Desktop-exe-confined git call on an ssh:// cwd reaches the remote branch',
      desktopRefusal === undefined && h3.scripts.length === 1 && h3.scripts[0].includes("exec 'git'") && h3.localCalls.length === 0,
      `scripts=${h3.scripts.length} local=${h3.localCalls.length} refused=${String(desktopRefusal?.message)}`)
  } finally {
    process.execPath = realExecPath
  }
}


// ── path-position translation: which options name a PATH ────────────────────
//
// `--namespace` was in GIT_PATH_OPTIONS and is not a path option: it names a
// REF namespace (`refs/heads`, `refs/tags`, …). Translating its operand turned a
// ref prefix into a remote path spelling, so the flag now leaves argv alone.
console.log('\n[path options]')
{
  const h = harness({ roots: [ROOT], run: { output: '' } })
  const handle = h.service.spawn(gitSpec('/mnt/data/proj', [
    'rev-parse', '--namespace', 'ssh://testhost/mnt/data/proj/refs',
    '--git-dir=ssh://testhost/mnt/data/proj/.git',
  ]))
  await handle.done
  const script = h.scripts[0] ?? ''
  check('a --namespace operand is NOT treated as a filesystem path',
    script.includes("'--namespace' 'ssh://testhost/mnt/data/proj/refs'"), script)
  check('a real path option in the SAME argv still translates',
    script.includes("'--git-dir=/mnt/data/proj/.git'"), script)
}

{
  const h = harness({ roots: [ROOT], run: { output: '' } })
  const handle = h.service.spawn(gitSpec('/mnt/data/proj', [
    '--namespace=ssh://testhost/mnt/data/proj/refs', 'status',
  ]))
  await handle.done
  const script = h.scripts[0] ?? ''
  check('the --namespace=<ref> form is left literal too',
    script.includes("'--namespace=ssh://testhost/mnt/data/proj/refs'"), script)
}

{
  const h = harness({ roots: [ROOT] })
  const handle = h.service.spawn(gitSpec('/mnt/data/proj', [
    '-C', 'ssh://testhost/mnt/data/proj',
    '--git-dir=ssh://testhost/mnt/data/proj/.git',
    'grep', 'ssh://testhost/mnt/data/proj/README.md',
    '--', 'ssh://testhost/mnt/data/proj/file.txt',
    'ssh://otherhost/mnt/data/proj/file.txt',
  ]))
  await handle.done
  const script = h.scripts[0] ?? ''
  check('a path-position ssh:// argv inside the routed root is translated',
    script.includes("'-C' '/mnt/data/proj'") &&
      script.includes("'--git-dir=/mnt/data/proj/.git'") &&
      script.includes("'--' '/mnt/data/proj/file.txt'"), script)
  check('an ssh:// argv that is DATA (a git grep pattern) stays literal',
    script.includes("'ssh://testhost/mnt/data/proj/README.md'"), script)
  check('an ssh:// argv on ANOTHER host stays literal (never guessed)',
    script.includes("'ssh://otherhost/mnt/data/proj/file.txt'"), script)
}

{
  // rg mixes patterns and paths in one argv; rewriting either would be a guess.
  const h = harness({ roots: [ROOT] })
  const handle = h.service.spawn({
    argv: ['rg', '--json', 'ssh://testhost/mnt/data/proj/pattern', '--', 'ssh://testhost/mnt/data/proj'],
    cwd: '/mnt/data/proj',
    env: {},
    graceMs: 2000,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
  })
  await handle.done
  const script = h.scripts[0] ?? ''
  check('rg argv is never rewritten (patterns and paths are indistinguishable)',
    script.includes("'ssh://testhost/mnt/data/proj/pattern'") && script.includes("'ssh://testhost/mnt/data/proj'"), script)
}

{
  const sameSpec = gitSpec('/root/Codes/local-project', ['rev-parse', '--show-toplevel'])
  const marker = { local: true }
  const h = harness({ roots: [ROOT], localResult: marker })
  const result = h.service.spawn(sameSpec)
  check('a path under no mounted root uses the original local spawn', result === marker)
  check('the original spawn receives the very same spec object (nothing rewritten)',
    h.localCalls.length === 1 && h.localCalls[0] === sameSpec)
}

{
  const localDir = path.join(tmpdir(), `dsh-ws-local-same-${process.pid}`)
  mkdirSync(localDir, { recursive: true })
  try {
    const h = harness({ roots: [`ssh://testhost${localDir}`], localResult: 'local' })
    const result = h.service.spawn(gitSpec(localDir, ['status']))
    check('a locally-existing twin of a remote path is NOT hijacked', result === 'local')
  } finally {
    rmSync(localDir, { recursive: true, force: true })
  }
}

{
  const h = harness({
    roots: ['ssh://a/mnt/data/proj', 'ssh://b/mnt/data/proj'],
    localResult: 'local',
  })
  const result = h.service.spawn(gitSpec('/mnt/data/proj', ['gc']))
  check('an ambiguous plain cwd keeps the local behavior even for git gc', result === 'local')
  check('the ambiguity is reported at warn level', h.warnings.some(message => /ambiguous|more than one mounted root/u.test(message)),
    h.warnings.join(' | '))
  check('the ambiguity lands on the status diagnostics ring too',
    h.diagnostics.some(entry => entry.kind === 'degraded' && /more than one mounted root/u.test(entry.message)),
    JSON.stringify(h.diagnostics))
  check('the decision is recorded for inspection',
    [...h.router.plainRoutes.values()].some(decision => decision.reason === PLAIN_ROUTE_REASONS.AMBIGUOUS_ROOT))
}

{
  const h = harness({
    roots: [ROOT],
    localResult: 'local',
    isDisabledTarget: () => true,
  })
  const result = h.service.spawn(gitSpec('/mnt/data/proj', ['status']))
  check('a detached workspace is not reachable through a plain path either', result === 'local')
  const decision = [...h.router.plainRoutes.values()][0]
  check('the detached refusal names the workspace state',
    decision.reason === PLAIN_ROUTE_REASONS.HOST_UNAVAILABLE && /detached/u.test(decision.detail ?? ''),
    JSON.stringify(decision))
}

{
  // A plain path is INFERRED, so a command the bridge cannot answer must not be
  // taken over (that would replace the Host's local spawn, and therefore its
  // ordinary ENOENT, with a synchronous throw). It falls back to the local
  // spawn while the inference stays recorded for the status diagnostics.
  const h = harness({ roots: [ROOT], localResult: 'local' })
  const result = h.service.spawn({
    ...gitSpec('/mnt/data/proj', ['status']),
    argv: ['python3', '-c', 'print(1)'],
  })
  check('a non-whitelisted command on a plain-path route falls back to the local spawn',
    result === 'local' && h.scripts.length === 0, `result=${String(result)} remote=${h.scripts.length}`)
  check('the git/ripgrep whitelist is still what admits a plain-path route',
    [...h.router.plainRoutes.values()].some(decision => decision.kind === 'remote'),
    JSON.stringify([...h.router.plainRoutes.values()]))
}

{
  const h = harness({ roots: [ROOT] })
  const handle = h.service.spawn(gitSpec('/mnt/data/proj', ['status']))
  await handle.done
  check('the ssh:// route is untouched by the plain-path routing',
    h.localCalls.length === 0 && h.scripts[0].includes("cd '/mnt/data/proj'"), h.scripts[0] ?? '')
}

// ── a plain path is an inference, so the command decides whether it is used ──
//
// The plain-path route exists because a Host subsystem can hand git a
// scheme-less absolute path under a mounted root. Applying that inference to
// EVERY spec on such a cwd changed `bash -lc …` from "local spawn (ENOENT if the
// path is not here)" into a synchronous throw from inside the Host's own
// `spawn()` call — a behavioral regression with no remote upside, since the
// bridge only implements git and ripgrep. `ssh://` cwds keep refusing loudly:
// a local process cannot chdir into one.
console.log('\n[plain path and the whitelist]')
{
  // The plain world spelling of ROOT: this is the shape a Host subsystem hands
  // the bridge after it strips the scheme (see `[plain-path bridge]` above).
  const PLAIN = '/mnt/data/proj'
  const spec = {
    argv: ['bash', '-lc', 'echo hi'],
    cwd: PLAIN,
    graceMs: 2000,
    signal: AbortSignal.timeout(5000),
    env: {},
    stdio: { stdin: 'ignore' },
  }
  const localHandle = { collected: {}, done: Promise.resolve({ exitCode: 0 }), terminate() {}, waitForExit: async () => {} }
  const h = harness({ roots: [ROOT], localResult: localHandle })
  let thrown
  let returned
  try {
    returned = h.service.spawn(spec)
  } catch (error) {
    thrown = error
  }
  check('a non-whitelisted command on a plain mounted root keeps the local spawn',
    thrown === undefined && returned === localHandle && h.localCalls.length === 1 && h.scripts.length === 0,
    `thrown=${String(thrown?.message)} local=${h.localCalls.length} remote=${h.scripts.length}`)

  const git = harness({ roots: [ROOT], run: { output: ' M tracked.txt\n' } })
  const gitSpecOnPlain = {
    argv: ['git', 'status', '--porcelain'],
    cwd: PLAIN,
    graceMs: 2000,
    signal: AbortSignal.timeout(5000),
    env: { GIT_TERMINAL_PROMPT: '0' },
    stdio: { stdin: 'ignore' },
  }
  const handle = git.service.spawn(gitSpecOnPlain)
  await handle.done
  check('the SAME plain mounted root still routes a whitelisted command remotely',
    git.scripts.length === 1 && git.localCalls.length === 0,
    `local=${git.localCalls.length} remote=${git.scripts.length}`)
}

{
  const h = harness({ roots: [ROOT], run: { output: ' M tracked.txt\n' } })
  const handle = h.service.spawn(gitSpec(ROOT, ['status', '--porcelain']))
  await handle.done
  check('git on an ssh:// cwd still routes remotely',
    h.scripts.length === 1 && h.localCalls.length === 0,
    `local=${h.localCalls.length} remote=${h.scripts.length}`)
}

{
  const h = harness({ roots: [ROOT] })
  let thrown
  try {
    h.service.spawn({
      argv: ['bash', '-lc', 'echo hi'],
      cwd: 'ssh://testhost/mnt/data/proj',
      graceMs: 2000,
      signal: AbortSignal.timeout(5000),
      env: {},
      stdio: { stdin: 'ignore' },
    })
  } catch (error) {
    thrown = error
  }
  check('an ssh:// cwd still refuses a non-whitelisted command instead of running it locally',
    thrown instanceof Error && /only git and ripgrep/u.test(thrown.message), String(thrown?.message))
}

// ── the one thing this bridge cannot give the Changes panel: the text ────────
//
// `dsh-workspace-changes` stores before/after text with its own `captureFile()`,
// which opens `ctx.fs.processPath(target)` through node:fs. For a remote target
// that path is the REMOTE one (that is what git needs), so the open can only
// fail, both sides capture as `{kind:'absent'}`, `sameCapture()` calls them
// equal, and the record is dropped. The plugin cannot substitute a read — the
// capture never goes through `ctx.fs` — so it makes the drop observable instead
// of silent: one diagnostics entry per activation.
console.log('\n[content capture]')
{
  let RemoteFileSystem
  try {
    ;({ RemoteFileSystem } = await import(pathToFileURL(path.join(pluginRoot, 'lib/remote-fs.js')).href))
  } catch (error) {
    console.log(`  SKIP  remote-fs.js is not resolvable here: ${error instanceof Error ? error.message : String(error)}`)
    RemoteFileSystem = undefined
  }
  if (RemoteFileSystem !== undefined) {
    const engineEntries = []
    const engine = {
      diagnostics: {
        record: (kind, message, detail) => engineEntries.push({ kind, message, detail }),
      },
      // Never reached on purpose: the note is recorded before the write touches
      // the network, and this double refuses so the assertion also proves the
      // note does not depend on a successful publish.
      withSftp: async () => { throw new Error('this double has no SFTP') },
    }
    const router = new RemoteFileSystem({ engine })
    router.addRoot('testhost', '/mnt/data/proj')
    const target = {
      targetKey: 'ssh://testhost/mnt/data/proj/notes.txt',
      displayPath: 'ssh://testhost/mnt/data/proj/notes.txt',
    }
    const policy = { mode: 'danger-full-access', workspaceRoot: 'ssh://testhost/mnt/data/proj' }
    let writeOutcome
    try {
      await router.writeText(target, 'x', undefined, undefined, policy)
      writeOutcome = 'resolved'
    } catch (error) {
      writeOutcome = error instanceof Error ? error.message : String(error)
    }
    const first = engineEntries[0]
    check('a remote write records the host-local capture limit',
      engineEntries.length === 1 && first?.kind === 'degraded',
      JSON.stringify(engineEntries))
    check('the entry names the real mechanism, not a generic warning',
      typeof first?.message === 'string' &&
        first.message.includes('before/after') &&
        first.message.includes('node:fs') &&
        first.message.includes('ctx.fs.processPath'),
      String(first?.message))
    check('the entry says what still works (git lists the files)',
      typeof first?.message === 'string' && first.message.includes('still lists the changed files'),
      String(first?.message))
    check('the entry carries the alias it belongs to', first?.detail?.alias === 'testhost', JSON.stringify(first?.detail))
    check('the limit is reported once, not on every edit',
      await (async () => {
        try { await router.editText(target, { oldString: 'a', newString: 'b' }, undefined, undefined, policy) } catch { /* expected */ }
        return engineEntries.length === 1
      })(),
      JSON.stringify(engineEntries))
    check('a local write through the same router records nothing',
      await (async () => {
        const localEntries = []
        const local = new RemoteFileSystem({
          engine: { diagnostics: { record: (...args) => localEntries.push(args) } },
          base: { writeText: async () => 'written locally' },
        })
        const result = await local.writeText({ targetKey: 'F:/repo/a.txt', displayPath: 'F:/repo/a.txt' }, 'x')
        return result === 'written locally' && localEntries.length === 0
      })(),
      'a local path must not inherit the remote warning')
  }
}

// ── live: the exact shapes the Host hands the bridge ────────────────────────

const alias = process.env.DSH_WS_TEST_ALIAS
if (!alias) {
  console.log('\n[live host]')
  console.log('  SKIP  DSH_WS_TEST_ALIAS is not set (the live call-shape checks need a real SSH host)')
} else {
  await runLive(alias)
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
if (failures > 0) {
  console.log('\nfailures:')
  for (const failure of failureList) console.log(`  - ${failure}`)
}
process.exit(failures === 0 ? 0 : 1)

// ────────────────────────────────────────────────────────────────────────────

/**
 * The live half: drive the real bridge against the configured host and run the
 * exact git call shapes the plain-path routing rule admits.
 *
 * Everything created is under the suite's own remote scratch directory and is
 * removed in a `finally`; the real repository is only ever READ.
 *
 * @param {string} hostAlias - the host alias from DSH_WS_TEST_ALIAS.
 * @returns {Promise<void>} resolves when every live assertion has run.
 */
async function runLive (hostAlias) {
  console.log(`\n[live host: ${hostAlias}]`)
  const { checkScratchPath, removeScratch, resolveScratchDir } = await import('./scratch.mjs')
  const scratch = resolveScratchDir(process.env, '/tmp/dsh-ssh-workspace-test')
  if (!scratch.ok) {
    console.log(`  SKIP  refusing to run live checks: ${scratch.reason}`)
    return
  }

  let HostStore
  let SshWorkspaceEngine
  let RemoteFileSystem
  let shellQuote
  try {
    ;({ HostStore } = await import('../lib/hosts.js'))
    ;({ SshWorkspaceEngine, shellQuote } = await import('../lib/engine.js'))
    ;({ RemoteFileSystem } = await import('../lib/remote-fs.js'))
  } catch (error) {
    console.log(`  SKIP  the plugin's live peers are not resolvable here: ${error instanceof Error ? error.message : String(error)}`)
    console.log('        set DSH_CORE_ROOT to an assembled node_modules tree')
    return
  }

  const store = new HostStore()
  let engine
  try {
    store.resolve(hostAlias)
    engine = new SshWorkspaceEngine({ store })
  } catch (error) {
    console.log(`  SKIP  alias ${JSON.stringify(hostAlias)} is not resolvable from the host store: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  const router = new RemoteFileSystem({ engine })
  engine.attachFileSystem(router)

  const ownDir = `${scratch.path}/local-changes-${process.pid}`
  const mounted = []
  let localDir = undefined
  const localCalls = []

  /** The local half of the service double: really run the command here. */
  function localExec (spec) {
    localCalls.push(spec)
    const env = {}
    for (const [key, value] of Object.entries(spec.env ?? {})) if (value !== undefined) env[key] = String(value)
    const result = spawnSync(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env, encoding: 'utf8' })
    const maxBytes = spec.stdio?.stdout?.maxBytes ?? (1 << 20)
    const stdout = new StreamTail(maxBytes)
    const stderr = new StreamTail(maxBytes)
    if (typeof result.stdout === 'string' && result.stdout !== '') stdout.push(result.stdout)
    if (typeof result.stderr === 'string' && result.stderr !== '') stderr.push(result.stderr)
    return {
      collected: { stdout, stderr },
      done: Promise.resolve({ exitCode: result.status, signal: result.signal }),
      terminate: () => {},
      waitForExit: async () => {},
    }
  }

  const service = { spawn: localExec }
  const ctx = createHost({ services: { subprocess: service } }).ctx
  installRemoteSubprocess(ctx, {
    engine,
    logger: { info: () => {}, warn: message => console.log(`  WARN  ${message}`), debug: () => {} },
  })

  /** Run one git spec through the patched service. */
  async function runGit (cwd, args, env = {}, prefix = []) {
    const handle = service.spawn(gitSpec(cwd, args, env, prefix))
    const outcome = await handle.done
    return {
      exitCode: outcome.exitCode,
      stdout: handle.collected.stdout.readFrom(0).text,
      stderr: handle.collected.stderr.readFrom(0).text,
    }
  }

  try {
    mounted.push(router.addRoot(hostAlias, ownDir))
    const prepared = await engine.exec(hostAlias, [
      `rm -rf -- ${shellQuote(ownDir)}`,
      `mkdir -p ${shellQuote(ownDir)}`,
      `cd ${shellQuote(ownDir)}`,
      'git init -q',
      "printf 'one\\n' > tracked.txt",
      'git add tracked.txt',
      'git -c user.email=test@test -c user.name=test commit -qm init',
      "printf 'two\\n' >> tracked.txt",
      "printf 'new\\n' > untracked.txt",
      'echo READY',
    ].join(' && '))
    check('prepared a remote git scratch repository', prepared.exitCode === 0 && prepared.stdout.includes('READY'),
      `${prepared.exitCode} ${prepared.stderr.trim()}`)
    check('the remote scratch path does not exist on this machine (the rule needs that)',
      !existsSync(ownDir), ownDir)

    // 1) The exact locateGitWorkspace() call shape, with a PLAIN cwd.
    console.log('  [locate shape]')
    const locate = await runGit(ownDir, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-path', 'objects'])
    const lines = locate.stdout.split('\n').filter(line => line !== '')
    check('plain-cwd rev-parse ran on the remote host (no local spawn)', localCalls.length === 0,
      `local=${localCalls.length}`)
    check('plain-cwd rev-parse returned the REMOTE absolute root', lines[0] === ownDir, JSON.stringify(lines))
    check('plain-cwd rev-parse returned the remote git dir', lines[1] === `${ownDir}/.git`, JSON.stringify(lines))
    check('plain-cwd rev-parse printed the relative objects path unchanged', lines[2] === '.git/objects', JSON.stringify(lines))

    const status = await runGit(ownDir, ['status', '--porcelain'])
    check('the follow-up git status also ran remotely (still no local spawn)', localCalls.length === 0,
      `local=${localCalls.length}`)
    check('the follow-up status reports the remote work tree state',
      status.stdout.includes(' M tracked.txt') && status.stdout.includes('?? untracked.txt'), JSON.stringify(status.stdout))

    const dryRun = await runGit(ownDir, ['add', '-n', '--', 'untracked.txt'])
    check('git add -n (dry run) runs remotely and reports the file', dryRun.exitCode === 0 && dryRun.stdout.includes('untracked.txt'),
      JSON.stringify(dryRun))
    const afterDryRun = await runGit(ownDir, ['status', '--porcelain'])
    check('the dry run did not touch the remote index', afterDryRun.stdout.includes('?? untracked.txt'),
      JSON.stringify(afterDryRun.stdout))

    // 2) The ssh:// spelling keeps its old route.
    const sshShape = await runGit(`ssh://${hostAlias}${ownDir}`, ['rev-parse', '--show-toplevel'])
    check('the ssh:// cwd still routes (plain-path routing changed nothing there)',
      sshShape.exitCode === 0 && sshShape.stdout.trim() === ownDir, JSON.stringify(sshShape))

    // 3) A locally-existing twin is not hijacked.
    localDir = ownDir
    mkdirSync(localDir, { recursive: true })
    const localBefore = localCalls.length
    await runGit(ownDir, ['status', '--porcelain'])
    check('a plain path that now exists locally is NOT hijacked', localCalls.length === localBefore + 1,
      `local=${localCalls.length} before=${localBefore}`)
    rmSync(localDir, { recursive: true, force: true })
    localDir = undefined

    // 4) Two mounts of one path make the plain route ambiguous.
    const ambiguousRoot = router.addRoot('local-changes-ambiguous', ownDir)
    const ambiguousBefore = localCalls.length
    await runGit(ownDir, ['status', '--porcelain'])
    check('a plain path mounted twice stays local instead of guessing',
      localCalls.length === ambiguousBefore + 1, `local=${localCalls.length}`)
    router.removeRoot(ambiguousRoot)

    // 5) The Forge panel shape: processPath() strips the scheme, and the
    //    sandbox wrapper is what the Host actually hands ctx.subprocess.
    const target = await router.resolve(`ssh://${hostAlias}${ownDir}`, {})
    const processPath = router.processPath(target)
    check('the fs seam strips the scheme exactly as the Forge panel assumes',
      processPath === ownDir && !processPath.startsWith('ssh://'), processPath)
    const forge = await runGit(processPath, ['rev-parse', '--show-toplevel'],
      {}, ['landlock-run', '--ro-bind', '/usr', '/usr', '--'])
    check('the Forge spec (plain root + sandbox wrapper) reaches the remote git',
      forge.exitCode === 0 && forge.stdout.trim() === ownDir, JSON.stringify(forge))

    // 6) The real mounted repository: READ-ONLY commands in the locate shape.
    const realRepo = process.env.DSH_WS_LOCAL_CHANGES_REMOTE_REPO ?? '/mnt/data/Codes/vllm-ascend'
    if (realRepo !== ownDir) {
      const probe = await engine.exec(hostAlias, `test -d ${shellQuote(`${realRepo}/.git`)} && echo YES || echo NO`)
      if (probe.stdout.trim() === 'YES') {
        mounted.push(router.addRoot(hostAlias, realRepo))
        const before = localCalls.length
        const realLocate = await runGit(realRepo, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-path', 'objects'])
        const realLines = realLocate.stdout.split('\n').filter(line => line !== '')
        check(`the real checkout ${realRepo} locates through a plain cwd`,
          realLocate.exitCode === 0 && realLines[0] === realRepo && localCalls.length === before,
          JSON.stringify(realLines))
        const realStatus = await runGit(realRepo, ['status', '--porcelain'])
        check('the real checkout answers git status through the same route',
          realStatus.exitCode === 0 && localCalls.length === before, JSON.stringify(realStatus.stderr))
      } else {
        console.log(`  SKIP  ${realRepo} is not a git checkout on ${hostAlias}; the locate shape was covered by the scratch repo`)
      }
    }

    // 7) A local path (this checkout) is untouched.
    const beforeLocalRepo = localCalls.length
    const localRepo = await runGit(pluginRoot, ['rev-parse', '--show-toplevel'])
    check('a local repository path still runs locally', localCalls.length === beforeLocalRepo + 1,
      `local=${localCalls.length} before=${beforeLocalRepo}`)
    // Same path, two spellings: git prints `F:/GitHub/...` on Windows while
    // path.resolve() keeps backslashes. The assertion below is about WHICH
    // repository git answered for, not about separator style; a wrong repo still
    // fails because the comparison normalises separators and (on Windows only)
    // letter case, exactly as the filesystem does.
    const samePath = (a, b) => {
      const norm = (value) => {
        const slashed = String(value).trim().replace(/\\/gu, '/')
        return process.platform === 'win32' ? slashed.toLowerCase() : slashed
      }
      return norm(a) === norm(b)
    }
    check('the local git answer is this checkout', samePath(localRepo.stdout, pluginRoot), JSON.stringify(localRepo.stdout))
  } catch (error) {
    failures += 1
    failureList.push(`live: unexpected exception: ${error?.stack ?? error}`)
    console.log(`  FAIL  live: unexpected exception — ${error?.message ?? error}`)
  } finally {
    if (localDir !== undefined) rmSync(localDir, { recursive: true, force: true })
    for (const root of mounted) {
      try { router.removeRoot(root) } catch { /* not mounted anymore */ }
    }
    const verdict = checkScratchPath(ownDir)
    if (verdict.ok) {
      const removed = await removeScratch(engine, hostAlias, ownDir)
      console.log(removed.ok ? '  cleaned up the remote scratch directory' : `  refused to clean up: ${removed.reason}`)
    }
    engine.dispose()
  }
}
