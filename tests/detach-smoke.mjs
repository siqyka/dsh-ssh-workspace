/**
 * Behavioural checks for detaching a remote workspace.
 *
 * Two properties are load-bearing and neither is visible from a happy-path
 * call:
 *
 * 1. A detached workspace is refused for EVERY operation — reading a file,
 *    listing a directory, writing, observing, running a command, opening a
 *    terminal, spawning a subprocess, transferring bytes — not just for
 *    writes. Leaving reads open would mean the panel says "off" while the
 *    file panel still serves content.
 *
 * 2. Detaching is durable and reversible: the registration survives so the
 *    sidebar row stays visible, the disabled list survives a restart, and the
 *    sessions are archived rather than deleted.
 *
 * Run: node tests/detach-smoke.mjs
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  PASS  ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== detach smoke ===\n')

const coreRoot = process.env.DSH_CORE_ROOT
if (!coreRoot) {
  console.log('  SKIP  DSH_CORE_ROOT is not set (needs @deepseek-ai/dsh-fs)')
  console.log(`\n=== ${passed} passed, ${failures} failed, 1 suite skipped ===`)
  process.exit(failures === 0 ? 0 : 1)
}
process.env.DSH_PEER_ROOT = [coreRoot, process.env.DSH_PEER_ROOT].filter(Boolean).join(path.delimiter)

const { HostConfigStore, workspacesOf } = await import(pathToFileURL(path.join(pluginRoot, 'lib/store.js')).href)
const { RemoteFileSystem } = await import(pathToFileURL(path.join(pluginRoot, 'lib/remote-fs.js')).href)
const { SshWorkspaceEngine } = await import(pathToFileURL(path.join(pluginRoot, 'lib/engine.js')).href)
const { installRemoteShell } = await import(pathToFileURL(path.join(pluginRoot, 'lib/patch-shell.js')).href)
const { RemoteTerminalRouter } = await import(pathToFileURL(path.join(pluginRoot, 'lib/patch-terminal.js')).href)
const { formatRemotePath, isInsideAnyRemoteWorkspace } = await import(pathToFileURL(path.join(pluginRoot, 'lib/protocol.js')).href)

// ---------------------------------------------------------------------------
// The store section
// ---------------------------------------------------------------------------
{
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-ws-detach-'))
  try {
    const store = new HostConfigStore(path.join(home, 'dsh-ssh.json'))

    check('a fresh store has nothing detached', store.workspaces().disabled.length === 0)

    const written = store.disableWorkspace('ssh://alpha/home/dev/proj')
    check('disabling records the path', written.includes('ssh://alpha/home/dev/proj'), JSON.stringify(written))
    check('isWorkspaceDisabled answers true afterwards', store.isWorkspaceDisabled('ssh://alpha/home/dev/proj'))

    store.disableWorkspace('ssh://alpha/home/dev/proj')
    check('disabling twice does not duplicate the entry',
      store.workspaces().disabled.filter(entry => entry === 'ssh://alpha/home/dev/proj').length === 1,
      JSON.stringify(store.workspaces().disabled))

    // Two workspaces on one host must be independent.
    store.disableWorkspace('ssh://alpha/home/dev/other')
    store.enableWorkspace('ssh://alpha/home/dev/proj')
    check('enabling removes only its own entry', store.isWorkspaceDisabled('ssh://alpha/home/dev/other'))
    check('enabling cleared the entry it named', !store.isWorkspaceDisabled('ssh://alpha/home/dev/proj'))

    check('the file on disk holds the list', readFileSync(path.join(home, 'dsh-ssh.json'), 'utf8').includes('disabled'))

    // A local path is not a remote workspace and must be rejected outright.
    let rejected = false
    try {
      store.disableWorkspace('C:/Users/dev/proj')
    } catch {
      rejected = true
    }
    check('a local path is refused by the section writer', rejected)
    check('the refusal stored nothing', store.workspaces().disabled.every(entry => entry.startsWith('ssh://')))

    // A damaged section degrades to "nothing detached" rather than throwing:
    // losing the list only costs a re-mount, while throwing loses the hosts.
    check('a non-object section degrades to empty', workspacesOf({ workspaces: 'nope' }).disabled.length === 0)
    check('a missing section degrades to empty', workspacesOf({}).disabled.length === 0)
    check('non-string entries are dropped',
      workspacesOf({ workspaces: { disabled: [42, null, 'ssh://a/b', 'ssh://a/b'] } }).disabled.length === 1)
    check('duplicate entries collapse',
      workspacesOf({ workspaces: { disabled: ['ssh://a/b', 'ssh://a/b'] } }).disabled.join(',') === 'ssh://a/b')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// The containment predicate the fence is built on
// ---------------------------------------------------------------------------
{
  const disabled = ['ssh://alpha/home/dev/proj']
  check('the workspace itself is inside', isInsideAnyRemoteWorkspace(disabled, 'alpha', '/home/dev/proj'))
  check('a child is inside', isInsideAnyRemoteWorkspace(disabled, 'alpha', '/home/dev/proj/src/a.js'))
  check('a sibling sharing a prefix is NOT inside', !isInsideAnyRemoteWorkspace(disabled, 'alpha', '/home/dev/project'))
  check('another host is NOT inside', !isInsideAnyRemoteWorkspace(disabled, 'beta', '/home/dev/proj'))
  check('the parent directory is NOT inside', !isInsideAnyRemoteWorkspace(disabled, 'alpha', '/home/dev'))
  check('an empty list matches nothing', !isInsideAnyRemoteWorkspace([], 'alpha', '/home/dev/proj'))
  check('a malformed entry does not deny everything',
    !isInsideAnyRemoteWorkspace(['ssh://', 'nonsense'], 'alpha', '/home/dev/proj'))
}

// ---------------------------------------------------------------------------
// The filesystem fence: every operation, not just writes
// ---------------------------------------------------------------------------
{
  const engine = new SshWorkspaceEngine({})
  // The connection layer is never reached in this block: every call below is
  // refused before any SFTP work, which is part of what the test proves.
  engine.withSftp = async () => { throw new Error('the fence let an operation reach SFTP') }
  const router = new RemoteFileSystem({ engine })
  const workspace = formatRemotePath('alpha', '/home/dev/proj')
  router.addRoot('alpha', '/home/dev/proj')

  const target = { targetKey: workspace, displayPath: workspace }
  const childTarget = { targetKey: `${workspace}/src/a.js`, displayPath: `${workspace}/src/a.js` }

  // Before detaching, the write fence is what answers (no root covers an
  // outside path); after detaching, the detached fence answers first.
  router.disableRoot(workspace)
  check('the disabled list reports the path', router.listDisabled().includes(workspace), JSON.stringify(router.listDisabled()))
  check('the served roots no longer hold it', !router.listRoots().includes(workspace))

  const ops = [
    ['stat', () => router.stat(target)],
    ['lstat', () => router.lstat(workspace, {})],
    ['readText', () => router.readText(target)],
    ['readBytes', () => router.readBytes(target)],
    ['readByteRange', () => router.readByteRange(target, { offset: 0, length: 1 })],
    ['listDir', () => router.listDir(target)],
    ['watch', () => router.watch(target, () => {})],
    ['streamText', () => router.streamText(target)],
    ['writeText', () => router.writeText(target, 'x')],
    ['editText', () => router.editText(target, { oldString: 'a', newString: 'b' })],
  ]
  for (const [name, run] of ops) {
    let refused = false
    let message = ''
    try {
      await run()
    } catch (error) {
      refused = true
      message = error instanceof Error ? error.message : String(error)
    }
    check(`${name} is refused inside a detached workspace`, refused, 'the call succeeded')
    if (refused) check(`${name} names the workspace as detached`, /detached/u.test(message), message)
  }

  check('the refusal reaches a child path too', router.isDetached('alpha', '/home/dev/proj/src/deep/file.js'))
  check('a path outside the workspace is not refused', !router.isDetached('alpha', '/tmp/scratch.txt'))
  check('another host is not refused', !router.isDetached('beta', '/home/dev/proj'))

  // Re-enabling must clear the mark, including via addRoot.
  router.enableRoot(workspace)
  check('enabling lifts the mark', !router.isDetached('alpha', '/home/dev/proj'))
  router.disableRoot(workspace)
  router.addRoot('alpha', '/home/dev/proj')
  check('mounting again also lifts the mark', !router.isDetached('alpha', '/home/dev/proj'))
  check('and the path is served again', router.listRoots().includes(workspace))
}

// ---------------------------------------------------------------------------
// The command seams: shell, terminal, subprocess
// ---------------------------------------------------------------------------
{
  const engine = new SshWorkspaceEngine({})
  let opened = 0
  engine.openChannel = async () => { opened += 1; throw new Error('reached the connection layer') }
  engine.acquire = async () => { opened += 1; throw new Error('reached the connection layer') }
  engine.disabledWorkspaces = new Set([formatRemotePath('alpha', '/home/dev/proj')])

  // Installed through the documented seam, which is how DSH itself reaches it.
  const shellTarget = { execute: async () => { opened += 1; return {} } }
  const shellRouter = installRemoteShell({ get: (name) => (name === 'shell' ? shellTarget : undefined) }, { engine })
  check('installing the shell seam returns a router', shellRouter !== undefined)
  let shellRefused = false
  try {
    await shellTarget.execute({ workdir: 'ssh://alpha/home/dev/proj', command: 'echo hi', timeoutMs: 0, onExpiry: 'none' })
  } catch (error) {
    shellRefused = /detached/u.test(error instanceof Error ? error.message : String(error))
  }
  check('a shell command in a detached workspace is refused', shellRefused)

  const terminal = new RemoteTerminalRouter({ engine })
  let terminalRefused = false
  try {
    await terminal.spawnTerminal({ cwd: 'ssh://alpha/home/dev/proj' })
  } catch (error) {
    terminalRefused = /detached/u.test(error instanceof Error ? error.message : String(error))
  }
  check('a terminal in a detached workspace is refused', terminalRefused)
  check('no connection was opened by any refusal', opened === 0, `opened=${opened}`)

  // The SSH connection itself stays available: a cwd outside every detached
  // workspace is ordinary host operation and must not be blocked.
  check('a cwd outside the detached workspace is allowed', !engine.isDisabledTarget('alpha', '/tmp'))
  check('the same alias outside the workspace is allowed', !engine.isDisabledTarget('alpha', '/home/dev/other'))
  check('another host is allowed', !engine.isDisabledTarget('beta', '/home/dev/proj'))
}

// ---------------------------------------------------------------------------
// Cross-section survival: the disabled list must not evict other sections
// ---------------------------------------------------------------------------
{
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-ws-detach-'))
  try {
    const store = new HostConfigStore(path.join(home, 'dsh-ssh.json'))
    store.putForward({
      id: 'fwd-keep', alias: 'alpha', remotePort: 5173, localPort: 5173, enabled: true,
    })
    store.disableWorkspace('ssh://alpha/home/dev/proj')
    check('writing the disabled list kept the saved forwards',
      store.forwards().items.some(item => item.id === 'fwd-keep'),
      JSON.stringify(store.forwards().items))
    store.setForwardAutoStart(true)
    check('writing a forward setting kept the disabled list',
      store.isWorkspaceDisabled('ssh://alpha/home/dev/proj'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Re-enabling must not be blocked by the fence it is lifting
// ---------------------------------------------------------------------------
//
// Both `ssh_workspace_mount` and `ssh_workspace_enable` verify the remote
// directory exists before writing anything durable. Probing through `engine.fs`
// looks natural and is WRONG: that router is the fence, and it refuses every
// read inside a detached workspace — so enabling a detached workspace, or
// mounting it again, would have been impossible by construction. Both now go
// through the raw connection, which this block pins.
{
  const { workspaceTools } = await import(pathToFileURL(path.join(pluginRoot, 'lib/tools.js')).href)
  const engine = new SshWorkspaceEngine({})
  let rawProbes = 0
  let routerProbes = 0
  engine.withSftp = async (_alias, fn) => {
    rawProbes += 1
    return await fn({ stat: (_path, cb) => cb(undefined, { isDirectory: () => true }) })
  }
  const router = new RemoteFileSystem({ engine })
  // A router that fails the probe loudly if anyone routes through it: this is
  // exactly what a detached workspace does to a read.
  router.stat = async () => {
    routerProbes += 1
    throw new Error('router probe: the remote workspace is detached')
  }
  router.listDir = async () => {
    routerProbes += 1
    throw new Error('router probe: the remote workspace is detached')
  }
  const tools = workspaceTools({ get: () => undefined }, engine, router, { list: () => [] }, { list: () => [] })

  const mount = await tools.find(tool => tool.name === 'ssh_workspace_mount')
    .execute({ alias: 'alpha', remotePath: '/home/dev/proj', register: false }, {})
  check('mounting does not probe through the fenced router', routerProbes === 0, `router probes=${routerProbes}`)
  check('mounting succeeded without the fenced router', mount.ok === true, JSON.stringify(mount))
  check('mounting verified the directory over the raw connection', rawProbes >= 1, `raw probes=${rawProbes}`)

  const beforeEnable = routerProbes
  const enable = await tools.find(tool => tool.name === 'ssh_workspace_enable')
    .execute({ workspacePath: 'ssh://alpha/home/dev/proj' }, {})
  check('enabling does not probe through the fenced router', routerProbes === beforeEnable, `router probes=${routerProbes}`)
  check('enabling a detached workspace succeeds', enable.ok === true, JSON.stringify(enable))
}

// The probe's FAILURE has to name what it probed.
//
// SFTP's own text for a missing path is "No such file": true and useless. The
// caller handed over an alias AND a path, either of which could be the typo, so
// a message that names neither leaves the model guessing — and guessing is how
// a mistyped directory becomes a "the host is broken" report.
//
// This assertion lived only in `boot-smoke`, which needs a real host and
// therefore never ran in CI: the message asserted there had never existed.
// Pinned here, against a fake connection, so it runs everywhere.
{
  const { workspaceTools } = await import(pathToFileURL(path.join(pluginRoot, 'lib/tools.js')).href)
  /** The error ssh2 reports for a path that is not there. */
  const missing = () => Object.assign(new Error('No such file'), { code: 2 })

  for (const [toolName, args, expected] of [
    ['ssh_workspace_mount', { alias: 'alpha', remotePath: '/home/dev/typo', register: false }, '/home/dev/typo'],
    ['ssh_workspace_enable', { workspacePath: 'ssh://beta/home/dev/typo' }, '/home/dev/typo'],
  ]) {
    const engine = new SshWorkspaceEngine({})
    engine.withSftp = async (_alias, fn) => await fn({ stat: (_path, callback) => callback(missing(), undefined) })
    const router = new RemoteFileSystem({ engine })
    const tool = workspaceTools({ get: () => undefined }, engine, router, { list: () => [] }, { list: () => [] })
      .find(candidate => candidate.name === toolName)
    const result = await tool.execute(args, {})
    check(`${toolName} refuses a missing directory`, result.ok === false, JSON.stringify(result))
    check(`${toolName} names the path it probed`, String(result.error).includes(expected), String(result.error))
    check(`${toolName} says the directory is missing, not that the host failed`,
      /no such directory/iu.test(String(result.error)), String(result.error))
  }

  // A path that exists but is a FILE is a different mistake and gets its own
  // sentence: "no such directory" would send the caller to check the spelling
  // of something that is spelled correctly.
  {
    const engine = new SshWorkspaceEngine({})
    engine.withSftp = async (_alias, fn) => await fn({
      stat: (_path, callback) => callback(undefined, { isDirectory: () => false }),
    })
    const router = new RemoteFileSystem({ engine })
    const tool = workspaceTools({ get: () => undefined }, engine, router, { list: () => [] }, { list: () => [] })
      .find(candidate => candidate.name === 'ssh_workspace_mount')
    const result = await tool.execute({ alias: 'alpha', remotePath: '/home/dev/file.txt', register: false }, {})
    check('mounting a file rather than a directory says so', result.ok === false && /not a directory/iu.test(String(result.error)), String(result.error))
    check('...and does not claim the path is missing', !/no such directory/iu.test(String(result.error)), String(result.error))
  }

  // A transport failure is neither: it must not be reported as a missing path,
  // or the user deletes a directory that is still there.
  {
    const engine = new SshWorkspaceEngine({})
    engine.withSftp = async (_alias, fn) => await fn({
      stat: (_path, callback) => callback(Object.assign(new Error('connection lost'), { code: 7 }), undefined),
    })
    const router = new RemoteFileSystem({ engine })
    const tool = workspaceTools({ get: () => undefined }, engine, router, { list: () => [] }, { list: () => [] })
      .find(candidate => candidate.name === 'ssh_workspace_mount')
    const result = await tool.execute({ alias: 'alpha', remotePath: '/home/dev/proj', register: false }, {})
    check('a transport failure is not reported as a missing directory',
      result.ok === false && !/no such directory/iu.test(String(result.error)), String(result.error))
    check('...and says the stat itself failed', /cannot stat/iu.test(String(result.error)), String(result.error))
  }
}

// ---------------------------------------------------------------------------
// The sandbox mode fence: a remote write must honour read-only
// ---------------------------------------------------------------------------
//
// The deployment's sandbox is enforced inside `SandboxedFileSystem`, a LOCAL
// implementation whose `checkedTarget` realpaths the target on this machine. A
// remote target never reaches it — the router answers — so if the router ignores
// the per-call policy, a `read-only` session silently rewrites files on the
// remote host. No error, no marker: the model cannot tell it happened.
//
// Every assertion below proves the refusal happens BEFORE any SFTP work, which
// is what makes it a policy answer rather than a failed connection: `withSftp`
// records that it was reached.
{
  const engine = new SshWorkspaceEngine({})
  let reachedSftp = 0
  engine.withSftp = async () => {
    reachedSftp += 1
    throw new Error('the mode fence let a write reach SFTP')
  }
  // The nearby backend advertises the deployment default, exactly as
  // `SandboxedFileSystem.sandboxMode` does.
  const base = { sandboxMode: 'workspace-write', writeText: async () => ({ operation: 'local' }), editText: async () => ({}) }
  const router = new RemoteFileSystem({ engine, base })
  const workspace = formatRemotePath('alpha', '/home/dev/proj')
  router.addRoot('alpha', '/home/dev/proj')
  const target = { targetKey: `${workspace}/src/a.js`, displayPath: `${workspace}/src/a.js` }

  const codeOf = async (run) => {
    try {
      await run()
      return undefined
    } catch (error) {
      return error?.code
    }
  }

  // read-only denies a target INSIDE a mounted root: this is the case the mount
  // fence alone can never catch, so it is the one that proves the mode is read.
  const readOnlyWrite = await codeOf(() => router.writeText(target, 'x', undefined, undefined, { mode: 'read-only' }))
  check('read-only refuses a write inside a mounted root', readOnlyWrite === 'FS_SANDBOX_DENIED', String(readOnlyWrite))
  const readOnlyEdit = await codeOf(() => router.editText(target, { oldString: 'a', newString: 'b' }, undefined, undefined, { mode: 'read-only' }))
  check('read-only refuses an edit inside a mounted root', readOnlyEdit === 'FS_SANDBOX_DENIED', String(readOnlyEdit))
  check('neither refusal reached SFTP', reachedSftp === 0, `withSftp called ${reachedSftp} time(s)`)

  // The message names the mode, because the host's tool layer turns the code
  // into a marker and the user reads the message.
  let message = ''
  try {
    await router.writeText(target, 'x', undefined, undefined, { mode: 'read-only' })
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  check('the read-only refusal names the mode', /read-only/u.test(message), message)

  // An ABSENT policy falls back to the backend's advertised default — not to
  // "unconfined". The default here is workspace-write, so this must pass the
  // mode check and be stopped by the MOUNT fence instead.
  const noPolicy = await codeOf(() => router.writeText(target, 'x', undefined, undefined, undefined))
  check('an absent policy uses the backend default, not "allow"',
    noPolicy === undefined || noPolicy === 'FS_IO_ERROR', String(noPolicy))
  check('the absent-policy write was allowed past the mode fence', reachedSftp === 1, `withSftp called ${reachedSftp} time(s)`)

  // A backend that advertises read-only as its default denies even without a
  // per-call policy: that is the deployment-level posture, and ignoring it would
  // mean a `read-only` deployment can write to every mounted remote host.
  const readOnlyBase = { sandboxMode: 'read-only', writeText: async () => ({}), editText: async () => ({}) }
  const readOnlyRouter = new RemoteFileSystem({ engine, base: readOnlyBase })
  readOnlyRouter.addRoot('alpha', '/home/dev/proj')
  const inherited = await codeOf(() => readOnlyRouter.writeText(target, 'x', undefined, undefined, undefined))
  check('the backend default of read-only is inherited', inherited === 'FS_SANDBOX_DENIED', String(inherited))

  // danger-full-access writes are still fenced by the MOUNT rule: permission and
  // reachability are independent, and a full-access session cannot write into a
  // directory this deployment does not serve. `/srv` is used rather than `/tmp`
  // because the temp area IS reachable on a host this deployment serves — the
  // local `writableRoots` lists it, and the remote fence mirrors that.
  const outside = { targetKey: 'ssh://alpha/srv/scratch.txt', displayPath: 'ssh://alpha/srv/scratch.txt' }
  const fullAccess = await codeOf(() => router.writeText(outside, 'x', undefined, undefined, { mode: 'danger-full-access' }))
  check('danger-full-access is still refused outside every mounted root',
    fullAccess === 'FS_OUTSIDE_WORKSPACE', String(fullAccess))

  // The temp area, by contrast, is reachable. `danger-full-access` is the only
  // mode that proves it: under `read-only` the mode fence denies BEFORE the mount
  // fence is consulted, so a `read-only` refusal would say nothing about which
  // fence answered. Here nothing but reachability can stop the write, so getting
  // past the fence to SFTP is the proof.
  const staged = { targetKey: 'ssh://alpha/tmp/build/out.o', displayPath: 'ssh://alpha/tmp/build/out.o' }
  const tempFullAccess = await codeOf(() => router.writeText(staged, 'x', undefined, undefined, { mode: 'danger-full-access' }))
  check('the host temp area is reachable for a write the mode allows',
    tempFullAccess === undefined || tempFullAccess === 'FS_IO_ERROR', String(tempFullAccess))
}

// ---------------------------------------------------------------------------
// The fence codes must stay distinguishable
// ---------------------------------------------------------------------------
//
// The host's tool layer rewrites EVERY `FS_SANDBOX_DENIED` into
// "[sandbox: file access denied under <mode> mode]" plus an escalation hint.
// Mount and detach failures must not wear that code: the mode may already be the
// widest one, and no permission change mounts a directory or re-enables a
// workspace. Distinct codes are what let the accurate message reach the model.
{
  const engine = new SshWorkspaceEngine({})
  engine.withSftp = async () => { throw new Error('reached SFTP') }
  const router = new RemoteFileSystem({ engine })
  const workspace = formatRemotePath('alpha', '/home/dev/proj')

  let mountCode
  try {
    await router.writeText({ targetKey: 'ssh://alpha/tmp/x.txt', displayPath: 'ssh://alpha/tmp/x.txt' }, 'x')
  } catch (error) {
    mountCode = error?.code
  }
  check('the mount fence raises its own code', mountCode === 'FS_OUTSIDE_WORKSPACE', String(mountCode))

  router.addRoot('alpha', '/home/dev/proj')
  router.disableRoot(workspace)
  let detachCode
  try {
    await router.readText({ targetKey: `${workspace}/a.js`, displayPath: `${workspace}/a.js` })
  } catch (error) {
    detachCode = error?.code
  }
  check('the detach fence raises a permission code, not a sandbox one',
    detachCode === 'FS_PERMISSION_DENIED', String(detachCode))
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
process.exit(failures === 0 ? 0 : 1)
