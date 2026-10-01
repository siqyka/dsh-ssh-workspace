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
const sandbox = process.env.DSH_WS_TEST_DIR ?? '/tmp/dsh-ssh-workspace-acceptance'

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
  { alias, command: `rm -rf ${sandbox} && mkdir -p ${sandbox}/notes && echo PREPARED` }, {})
check('remote directory prepared via ssh_workspace_exec', prep.success === true && prep.stdout.includes('PREPARED'), JSON.stringify(prep).slice(0, 200))

const mount = await registry.tools.get('ssh_workspace_mount').execute(
  { alias, remotePath: sandbox, title: 'acceptance', register: false }, {})
check('mount a remote directory as a workspace', mount.ok === true, JSON.stringify(mount))
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

// --- the sandbox fence still applies on the remote side ----------------------
let fenceCode
try {
  await fs.writeText(remote('/tmp/dsh-ssh-workspace-acceptance-outside.txt'), 'nope', undefined, undefined, undefined)
} catch (error) {
  fenceCode = error.code
}
check('a remote write outside every mounted root is refused', fenceCode === 'FS_SANDBOX_DENIED', String(fenceCode))

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

const unmount = await registry.tools.get('ssh_workspace_unmount').execute({ workspacePath: workspace, deregister: false }, {})
check('unmount removes the remote workspace', unmount.ok === true && unmount.wasMounted === true, JSON.stringify(unmount))

await registry.tools.get('ssh_workspace_exec').execute({ alias, command: `rm -rf ${sandbox}` }, {})

await fiber.dispose()

console.log(`\n=== ${passes.length} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
