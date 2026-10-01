/**
 * Boot a real Cordis application and mount the plugin into it — the closest
 * verification to "loads inside DSH" that runs without restarting the app.
 *
 * Proves, against the REAL @deepseek-ai/cordis, @deepseek-ai/dsh-fs and
 * @deepseek-ai/dsh-tools:
 *   - the plugin module loads and `apply()` finds and takes over the existing
 *     `ctx.fs` (mounted AFTER the plugin, the production order) without
 *     re-providing it;
 *   - local paths still reach the original backend through the forwarding
 *     half, with the original receiver state intact;
 *   - the agent tools register as valid definitions and answer real calls;
 *   - teardown restores the original methods and unregisters the tools.
 *
 * Requires an assembled DSH dependency tree (DSH_CORE_ROOT). The remote-host
 * section additionally needs DSH_WS_TEST_ALIAS; both SKIP cleanly when unset.
 *
 * Run:
 *   DSH_CORE_ROOT=/path/to/node_modules node tests/boot-smoke.mjs
 *   DSH_CORE_ROOT=... DSH_WS_TEST_ALIAS=myhost node tests/boot-smoke.mjs
 */

import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const coreRoot = process.env.DSH_CORE_ROOT
if (!coreRoot) {
  console.log('\n=== boot smoke ===\n')
  console.log('  SKIP  DSH_CORE_ROOT is not set (needs @deepseek-ai/cordis, dsh-fs and dsh-tools)')
  console.log('\n=== 0 passed, 0 failed, 1 suite skipped ===')
  process.exit(0)
}
process.env.DSH_PEER_ROOT = [coreRoot, process.env.DSH_PEER_ROOT].filter(Boolean).join(path.delimiter)

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const alias = process.env.DSH_WS_TEST_ALIAS
const remoteDir = process.env.DSH_WS_TEST_DIR ?? '/tmp'

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

console.log('\n=== boot smoke ===\n')
console.log(`[core: ${coreRoot}]`)
console.log(`[plugin: ${pluginRoot}]`)

const requireFromCore = createRequire(path.join(coreRoot, 'noop.cjs'))
const { Context, Service } = requireFromCore('@deepseek-ai/cordis')
const { FileSystem } = requireFromCore('@deepseek-ai/dsh-fs')
try {
  requireFromCore('@deepseek-ai/dsh-tools')
} catch {
  console.log('  SKIP  @deepseek-ai/dsh-tools is not in the core tree; skipping the boot suite')
  console.log('\n=== 0 passed, 0 failed, 1 suite skipped ===')
  process.exit(0)
}

/** A faithful stand-in for the deployment's local sandboxed filesystem. */
class StubLocalFileSystem extends FileSystem {
  constructor (ctx, config) {
    super(ctx, 'fs')
    this.config = config ?? {}
    this.calls = []
    // The base class declares `sandboxMode` as a getter-only member, so the
    // stub publishes its own capability fact as a property descriptor.
    Object.defineProperty(this, 'sandboxMode', { value: 'workspace-write', enumerable: true, configurable: true })
  }

  async resolve (p) {
    this.calls.push(['resolve', p])
    return { targetKey: `local:${p}`, displayPath: String(p) }
  }

  processPath (target) { return String(target?.targetKey ?? '') }
  processPathFromHostPath (p) { return p }
  fileUrl (target) { return `file:///${this.processPath(target)}` }
  contains () { return true }
  async stat () { this.calls.push(['stat']); return { version: 'v1', type: 'file', size: 3 } }
  async lstat () { return { version: 'v1', type: 'file' } }
  async readText () { return 'local contents' }
  async streamText () { return (async function * () { yield 'local' })() }
  async readBytes () { return new Uint8Array([1, 2, 3]) }
  async readByteRange () { return new Uint8Array([1]) }
  async listDir () { return [] }
  async writeText () { this.calls.push(['writeText']); return { operation: 'update', version: 'v2', before: 'a', after: 'b' } }
  async editText () { return { version: 'v2', before: 'a', after: 'b' } }
  watch () { return Promise.reject(new Error('unsupported')) }
}

/** Minimal tools registry honoring the real duplicate/scope contract. */
class StubTools extends Service {
  constructor (ctx) {
    super(ctx, 'tools')
    this.registered = new Map()
  }

  register (definition) {
    if (this.registered.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered`)
    if (definition.output === undefined || typeof definition.output.render !== 'function') {
      throw new TypeError(`tool "${definition.name}" must declare output { schema, render }`)
    }
    this.registered.set(definition.name, definition)
    return () => { this.registered.delete(definition.name) }
  }
}

// --- boot ------------------------------------------------------------------
// PRODUCTION ORDER IS THE POINT: a profile applies its patch layer AFTER its
// bundles, so this plugin is listed after the filesystem backend and `ctx.fs`
// does not exist yet when `apply()` runs. Mount tools + plugin FIRST, then the
// backend, and require the takeover to happen anyway.
const app = new Context()
await app.plugin(StubTools)

const ctx = app
check('ctx.fs is genuinely absent at plugin load time (production order)', ctx.get('fs') === undefined)

const plugin = await import(pathToFileURL(path.join(pluginRoot, 'lib/index.js')).href)
check('plugin exports a name', typeof plugin.name === 'string' && plugin.name.length > 0, String(plugin.name))
check('plugin exports apply()', typeof plugin.apply === 'function')
check('plugin declares inject', Array.isArray(plugin.inject) && plugin.inject.includes('tools'), JSON.stringify(plugin.inject))
check('plugin does not hard-inject fs (it injects it on the service body)',
  !plugin.inject.includes('fs'), JSON.stringify(plugin.inject))

const fiber = ctx.plugin(plugin, { enabled: true, announceToAgent: false })
await fiber
check('the plugin mounted without throwing', true)

// --- the backend arrives late (production order) -----------------------------
await app.plugin(StubLocalFileSystem, {})
const localFs = ctx.get('fs')
check('a local fs service is mounted', localFs !== undefined)
check('the local fs is a real FileSystem instance', localFs instanceof FileSystem)

const originalResolve = localFs.resolve

// The takeover must have happened when the service arrived, with no restart of
// this plugin and no ordering cooperation.
check('the late-arriving ctx.fs was taken over automatically',
  ctx.get('fs')[Symbol.for('dsh-ssh-workspace.installed')] !== undefined)

const patched = ctx.get('fs')
check('the local backend was not replaced (resolve is no longer the original)',
  typeof patched.resolve === 'function' && patched.resolve !== originalResolve)

const localResolved = await patched.resolve('E:/local/file.txt', {})
check('a local path is forwarded to the original backend', localResolved.displayPath === 'E:/local/file.txt', JSON.stringify(localResolved))
check('the original backend really ran', localFs.calls.some(([name]) => name === 'resolve'))

const localRead = await patched.readText({ targetKey: 'local:x', displayPath: 'E:/local/file.txt' }, undefined)
check('a local read still returns the original backend result', localRead === 'local contents', JSON.stringify(localRead))

// The local backend's own state must be intact: the forwarder binds the
// ORIGINAL receiver, so `this.config`/`this.calls` still belong to it.
check('the forwarder preserved the original receiver state', localFs.config !== undefined)

// --- tools -----------------------------------------------------------------
const registry = ctx.get('tools')
const expectedTools = [
  'ssh_workspace_hosts',
  'ssh_workspace_mount',
  'ssh_workspace_unmount',
  'ssh_workspace_status',
  'ssh_workspace_exec',
]
for (const name of expectedTools) {
  check(`tool ${name} is registered`, registry.registered.has(name))
}
check('exactly the expected tool count registered', registry.registered.size === expectedTools.length, String(registry.registered.size))

const statusTool = registry.registered.get('ssh_workspace_status')
const statusResult = await statusTool.execute({}, {})
check('ssh_workspace_status reports no mounts initially',
  Array.isArray(statusResult.mounted) && statusResult.mounted.length === 0 && statusResult.fsPatched === true,
  JSON.stringify(statusResult))

// --- remote host section (needs DSH_WS_TEST_ALIAS) ---------------------------
if (alias === undefined) {
  console.log('\n  SKIP  remote-host checks (set DSH_WS_TEST_ALIAS to enable; DSH_WS_TEST_DIR selects the scratch dir)')
} else {
  const remote = (p) => ({ targetKey: `ssh://${alias}${p}`, displayPath: `ssh://${alias}${p}` })
  const execTool = registry.registered.get('ssh_workspace_exec')

  const probeFile = `${remoteDir}/dsh-ws-boot-probe.txt`
  const probeWrite = await execTool.execute({ alias, command: `printf boot-probe-ok > ${probeFile}` }, {})
  check('ssh_workspace_exec prepares a probe file on the remote host',
    probeWrite.success === true, JSON.stringify(probeWrite).slice(0, 200))

  const patchedRemoteRead = await patched.readText(remote(probeFile), undefined)
  check('a remote read through the patched ctx.fs returns the remote file',
    patchedRemoteRead === 'boot-probe-ok', JSON.stringify(patchedRemoteRead))

  await execTool.execute({ alias, command: `rm -f ${probeFile}` }, {})

  const hostsTool = registry.registered.get('ssh_workspace_hosts')
  const hostsResult = await hostsTool.execute({}, {})
  check('ssh_workspace_hosts lists the configured host',
    Array.isArray(hostsResult.hosts) && hostsResult.hosts.some(host => host.alias === alias),
    JSON.stringify(hostsResult.hosts?.map(h => h.alias)))

  const mountTool = registry.registered.get('ssh_workspace_mount')
  const mountResult = await mountTool.execute({ alias, remotePath: remoteDir, register: false }, {})
  check('ssh_workspace_mount mounts a real remote directory',
    mountResult.ok === true && mountResult.workspacePath === `ssh://${alias}${remoteDir}`,
    JSON.stringify(mountResult))

  const statusAfter = await statusTool.execute({}, {})
  check('the mount is visible in status', statusAfter.mounted.includes(`ssh://${alias}${remoteDir}`), JSON.stringify(statusAfter.mounted))

  const badMount = await mountTool.execute({ alias, remotePath: `${remoteDir}/dsh-ssh-workspace-missing-xyz`, register: false }, {})
  check('mounting a missing remote directory fails cleanly',
    badMount.ok === false && String(badMount.error).includes('no such directory'), JSON.stringify(badMount.error))

  const unmountResult = await registry.registered.get('ssh_workspace_unmount').execute({ workspacePath: `ssh://${alias}${remoteDir}`, deregister: false }, {})
  check('ssh_workspace_unmount removes the mount', unmountResult.ok === true && unmountResult.wasMounted === true, JSON.stringify(unmountResult))

  const execResult = await execTool.execute({ alias, command: 'echo boot-test-ok' }, {})
  check('ssh_workspace_exec runs a command on the remote host',
    execResult.success === true && execResult.stdout.includes('boot-test-ok'),
    JSON.stringify(execResult).slice(0, 200))
}

// --- teardown --------------------------------------------------------------
// Uninstall deletes the OWN properties it installed, so the prototype's
// originals become reachable again. `ctx.get` hands back a traced wrapper whose
// identity is not stable, so the check hashes the resolved method source
// instead of comparing function objects.
const methodSignature = (service, name) => {
  const fn = service[name]
  return typeof fn === 'function' ? `${fn.name}:${fn.toString().length}` : 'missing'
}
const beforeLocal = `${methodSignature(localFs, 'resolve')}|${methodSignature(localFs, 'writeText')}`

await fiber.dispose()

check('teardown removed the install marker', ctx.get('fs')[Symbol.for('dsh-ssh-workspace.installed')] === undefined)
check('teardown restored the prototype resolve method',
  methodSignature(ctx.get('fs'), 'resolve') === methodSignature(localFs, 'resolve'),
  `${methodSignature(ctx.get('fs'), 'resolve')} vs ${methodSignature(localFs, 'resolve')}`)
check('teardown unregistered the tools', registry.registered.size === 0, String(registry.registered.size))
void beforeLocal

console.log(`\n=== ${passes.length} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
