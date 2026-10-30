/**
 * End-to-end acceptance test for the remote-workspace plugin.
 *
 * This is the "is the objective actually achieved" test: it mounts a real
 * directory on a real SSH host as a workspace, then drives the ORDINARY
 * filesystem contract against it exactly as the model-facing read/write/edit
 * tools do — through the plugin's patched `ctx.fs`, not through the backend
 * directly — and checks the sandbox fence still holds and local behaviour is
 * untouched.
 *
 * The host is taken from the environment — no aliases are baked in:
 *   DSH_WS_TEST_ALIAS  an alias resolvable from the host store / ~/.ssh/config
 *   DSH_WS_TEST_DIR    remote scratch dir (default /tmp/dsh-ssh-workspace-acceptance)
 *   DSH_CORE_ROOT      a node_modules dir holding @deepseek-ai/cordis, dsh-fs, dsh-tools
 *                      and ssh2
 *
 * SKIPs cleanly when either variable is unset.
 * Run: DSH_CORE_ROOT=/path/to/node_modules DSH_WS_TEST_ALIAS=myhost node tests/acceptance-smoke.mjs
 */

import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { removeScratch, resolveScratchDir } from './scratch.mjs'
import { shellQuote } from '../lib/engine.js'

const alias = process.env.DSH_WS_TEST_ALIAS
const coreRoot = process.env.DSH_CORE_ROOT
if (!alias || !coreRoot) {
  console.log('\n=== acceptance smoke ===\n')
  console.log(`  SKIP  ${!alias ? 'DSH_WS_TEST_ALIAS' : 'DSH_CORE_ROOT'} is not set (needs a real SSH host and the assembled DSH tree)`)
  console.log('\n=== 0 passed, 0 failed, 1 suite skipped ===')
  process.exit(0)
}
process.env.DSH_PEER_ROOT = [coreRoot, process.env.DSH_PEER_ROOT].filter(Boolean).join(path.delimiter)

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Resolved and validated up front: a suite that prepares a directory it cannot
// safely remove would leave litter on the host and hide the reason.
const scratch = resolveScratchDir(process.env, '/tmp/dsh-ssh-workspace-acceptance')
if (!scratch.ok) {
  console.log('\n=== acceptance smoke ===\n')
  console.log(`  SKIP  refusing to run: ${scratch.reason}`)
  console.log('\n=== 0 passed, 0 failed, 1 suite skipped ===')
  process.exit(0)
}
const sandbox = scratch.path

const requireFromCore = createRequire(path.join(coreRoot, 'noop.cjs'))
const { Context, Service } = requireFromCore('@deepseek-ai/cordis')
const { FileSystem } = requireFromCore('@deepseek-ai/dsh-fs')

const passes = []
const failures = []
function check (name, condition, detail) {
  if (condition) {
    passes.push(name)
    console.log(`  PASS  ${name}`)
  } else {
    failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log(`\n=== acceptance smoke (alias=${alias}, dir=${sandbox}) ===\n`)

/** A stand-in for the deployment's local sandboxed backend. */
class LocalStub extends FileSystem {
  constructor (ctx) {
    super(ctx, 'fs')
    this.reads = []
    Object.defineProperty(this, 'sandboxMode', { value: 'workspace-write', enumerable: true, configurable: true })
  }

  async resolve (p) { return { targetKey: `local:${p}`, displayPath: String(p) } }
  processPath (t) { return String(t?.targetKey ?? '') }
  processPathFromHostPath (p) { return p }
  fileUrl (t) { return `file:///${this.processPath(t)}` }
  contains () { return true }
  async stat () { return { version: 'v1', type: 'file', size: 2 } }
  async lstat () { return { version: 'v1', type: 'file' } }
  async readText () { this.reads.push('readText'); return 'local' }
  async streamText () { return (async function * () { yield 'local' })() }
  async readBytes () { return new Uint8Array([1, 2]) }
  async readByteRange () { return new Uint8Array([1]) }
  async listDir () { return [] }
  async writeText () { return { operation: 'update', version: 'v2', before: 'a', after: 'b' } }
  async editText () { return { version: 'v2', before: 'a', after: 'b' } }
  watch () { return Promise.reject(new Error('unsupported')) }
}

/** Minimal registry honoring the real register() contract. */
class ToolsStub extends Service {
  constructor (ctx) {
    super(ctx, 'tools')
    this.tools = new Map()
  }

  register (definition) {
    if (this.tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
    this.tools.set(definition.name, definition)
    return () => { this.tools.delete(definition.name) }
  }
}

const app = new Context()
await Promise.all([app.plugin(LocalStub), app.plugin(ToolsStub)])
const local = app.get('fs')

const plugin = await import(pathToFileURL(path.join(pluginRoot, 'lib/index.js')).href)
const fiber = app.plugin(plugin, { enabled: true, announceToAgent: false })
await fiber

const fs = app.get('fs')
const registry = app.get('tools')
const remote = (p) => ({ targetKey: `ssh://${alias}${p}`, displayPath: `ssh://${alias}${p}` })

// The plugin must hand us a remote-aware fs while leaving local reads alone.
check('plugins mounted', registry.tools.size === 5, `registered ${registry.tools.size} tools`)

// --- mount a real remote directory ------------------------------------------
// Prepare the remote directory with the plugin's own exec tool, so the mount
// below tests a directory that genuinely exists on the host.
const prep = await registry.tools.get('ssh_workspace_exec').execute(
  { alias, command: `rm -rf -- ${shellQuote(sandbox)} && mkdir -p ${shellQuote(`${sandbox}/notes`)} && echo PREPARED` }, {})
check('remote directory prepared via ssh_workspace_exec', prep.success === true && prep.stdout.includes('PREPARED'), JSON.stringify(prep).slice(0, 200))

// Everything from here on can fail midway, so the remote cleanup lives in a
// `finally` below: a suite that leaves its scratch directory behind on a
// failure is how the host accumulates litter nobody looks at.
let mountedForCleanup = false
try {
const mount = await registry.tools.get('ssh_workspace_mount').execute(
  { alias, remotePath: sandbox, title: 'acceptance', register: false }, {})
check('mount a remote directory as a workspace', mount.ok === true, JSON.stringify(mount))
mountedForCleanup = mount.ok === true
const workspace = mount.workspacePath
check('the workspace path uses the ssh:// scheme', workspace === `ssh://${alias}${sandbox}`, String(workspace))

// --- ordinary migration: relative paths resolve against the workspace cwd ----
const relResolved = await fs.resolve('notes/hello.txt', { cwd: workspace })
check('a relative path resolves against the remote workspace cwd',
  relResolved.displayPath === `ssh://${alias}${sandbox}/notes/hello.txt`, relResolved.displayPath)

// --- write / read / edit through the ordinary contract -----------------------
const fileTarget = { targetKey: relResolved.targetKey, displayPath: relResolved.displayPath }
const created = await fs.writeText(fileTarget, 'alpha\nbeta\ngamma\n', undefined, undefined, undefined)
check('writeText creates a remote file (with parent dirs)', created.operation === 'create', JSON.stringify(created.operation))

const readBack = await fs.readText(fileTarget, undefined)
check('readText returns the remote content verbatim', readBack === 'alpha\nbeta\ngamma\n', JSON.stringify(readBack))

const stat = await fs.stat(fileTarget, undefined)
check('stat reports a remote regular file', stat?.type === 'file', JSON.stringify(stat))

const edited = await fs.editText(fileTarget, { oldString: 'beta', newString: 'BETA' }, stat.version, undefined)
check('editText applies a literal edit remotely', edited.after.includes('BETA'), JSON.stringify(edited.after))

const listing = await fs.listDir({ targetKey: `ssh://${alias}${sandbox}/notes`, displayPath: `ssh://${alias}${sandbox}/notes` }, undefined)
check('listDir lists the remote directory', listing.some(entry => entry.name === 'hello.txt'), JSON.stringify(listing.map(e => e.name)))

// --- the mounted-root fence still applies on the remote side -----------------
// The code is `FS_OUTSIDE_WORKSPACE`, NOT `FS_SANDBOX_DENIED`: the host's tool
// layer rewrites every sandbox denial into a mode-named marker plus an escalation
// hint, which would be wrong here twice over — the mode may already be the
// widest one, and no permission change mounts a directory.
// `/etc` is the exemplar rather than `/tmp`: the host temp area is deliberately
// REACHABLE (the local `writableRoots` lists `/tmp`, and the remote fence mirrors
// it), so a `/tmp` target would prove nothing about the mount fence. The refusal
// is lexical and happens before any SFTP work, so the host is never touched.
let fenceCode
try {
  await fs.writeText(remote('/etc/dsh-ssh-workspace-acceptance-outside.txt'), 'nope', undefined, undefined, undefined)
} catch (error) {
  fenceCode = error.code
}
check('a remote write outside every mounted root is refused', fenceCode === 'FS_OUTSIDE_WORKSPACE', String(fenceCode))

// The sandbox MODE must be honoured on a remote target, both ways round: the
// deployment's sandbox is a local mechanism and a remote target never reaches
// `SandboxedFileSystem.checkedTarget`, so the router applies it itself.
{
  // INSIDE the mounted root (`${sandbox}`), which is the whole point: a target
  // outside it would be refused by the mount fence and prove nothing about mode.
  const inside = remote(`${sandbox}/notes/mode-fence.txt`)
  const detached = { mode: 'read-only' }
  let denied
  try {
    await fs.writeText(inside, 'nope', undefined, undefined, detached)
  } catch (error) {
    denied = error
  }
  check('read-only is refused for a remote write INSIDE a mounted root',
    denied?.code === 'FS_SANDBOX_DENIED', String(denied?.code))
  check('the read-only refusal names the mode',
    typeof denied?.message === 'string' && /read-only/u.test(denied.message), String(denied?.message))

  let editDenied
  try {
    await fs.editText(inside, { oldString: 'a', newString: 'b' }, undefined, undefined, detached)
  } catch (error) {
    editDenied = error
  }
  check('editText honours read-only through its FIFTH argument',
    editDenied?.code === 'FS_SANDBOX_DENIED', String(editDenied?.code))

  // workspace-write allows a mounted root on the other side of the fence: the
  // mounted-root test IS the containment test for a remote target, because the
  // local workspace root is a path on this machine.
  const allowed = await fs.writeText(inside, 'allowed\n', undefined, undefined, { mode: 'workspace-write' })
  check('workspace-write still writes inside a mounted root', allowed?.operation === 'create' || allowed?.operation === 'update', JSON.stringify(allowed))

  // An absent policy falls back to the backend's advertised default rather than
  // reading as "unconfined". The stub advertises `workspace-write`, so this must
  // NOT deny.
  const noPolicy = await fs.writeText(inside, 'again\n', undefined, undefined, undefined)
  check('an absent policy falls back to the backend default', noPolicy?.operation !== undefined, JSON.stringify(noPolicy))
}

// ...but local behaviour is untouched, which is the whole point of the patch.
const localRead = await fs.readText({ targetKey: 'local:x', displayPath: 'E:/local/file.txt' }, undefined)
check('local reads still hit the original backend', localRead === 'local' && local.reads.length > 0, JSON.stringify(localRead))

// --- remote command execution ------------------------------------------------
const exec = await registry.tools.get('ssh_workspace_exec').execute({ alias, command: `cat ${sandbox}/notes/hello.txt` }, {})
check('ssh_workspace_exec reads the file we wrote, on the remote host',
  exec.success === true && exec.stdout.includes('BETA'), JSON.stringify(exec).slice(0, 200))

// --- status and cleanup ------------------------------------------------------
const status = await registry.tools.get('ssh_workspace_status').execute({}, {})
check('status reports the mount and a live connection',
  status.mounted.includes(workspace) && status.connections.some(c => c.alias === alias), JSON.stringify(status))

const unmount = await registry.tools.get('ssh_workspace_unmount').execute({ workspacePath: workspace, mode: 'detach' }, {})
check('unmount detaches the remote workspace', unmount.ok === true && unmount.wasMounted === true, JSON.stringify(unmount))
// The mode is asserted, not assumed: the tool used to be driven with a
// `deregister` boolean, and the suite kept passing that long after the
// parameter was renamed — so this line is what stops that from happening again.
check('unmount echoes the requested mode', unmount.mode === 'detach', String(unmount.mode))
check('detach keeps the workspace record (it is not deregistered)', unmount.deregistered === false, String(unmount.deregistered))
} catch (error) {
  failures.push(`unexpected exception: ${error?.stack ?? error}`)
  console.error('\nUNEXPECTED EXCEPTION\n', error)
} finally {
  // Best effort, but only onto a path this module has proven is a scratch
  // directory, and only with the plugin's own quoting.
  if (mountedForCleanup) {
    try {
      const unmount = await registry.tools.get('ssh_workspace_unmount').execute({ workspacePath: workspace, mode: 'detach' }, {})
      if (unmount?.ok !== true) console.log(`  note  could not detach on cleanup: ${JSON.stringify(unmount)}`)
    } catch { /* the connection may be the thing that failed */ }
  }
  // Cleanup goes through the same public tool the suite already used, not
  // through the engine: the engine is not on `ctx`, and reaching into the
  // plugin's internals just to delete a directory would be the wrong coupling.
  const execTool = registry.tools.get('ssh_workspace_exec')
  const removed = await removeScratch(
    { exec: (target, command) => execTool.execute({ alias: target, command }, {}) },
    alias,
    sandbox,
  ).catch(error => ({ ok: false, reason: String(error) }))
  const note = removed.ok
    ? '\ncleaned up the remote scratch directory'
    : '\nrefused to clean up: ' + removed.reason
  console.log(note)
  await fiber.dispose()
}

console.log(`\n=== ${passes.length} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
