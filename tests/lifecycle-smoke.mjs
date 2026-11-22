/**
 * Service-ordering lifecycle checks against a REAL Cordis app.
 *
 * A DSH profile applies its patch layer after its bundles and assembles
 * services in an order this plugin does not control, so the takeover must work
 * for every order in which {tools, fs, webServer} can appear — including the
 * production order where `ctx.fs` does not exist when `apply()` runs. This
 * suite mounts the plugin under each order and checks the takeover, the tool
 * registrations, and the HTTP route count.
 *
 * Requires an assembled DSH dependency tree; SKIPs when DSH_CORE_ROOT is unset.
 * Run: DSH_CORE_ROOT=/path/to/node_modules node tests/lifecycle-smoke.mjs
 */

import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { skipWithoutRealPeers } from './support/peer-mode.mjs'

const coreRoot = process.env.DSH_CORE_ROOT
if (!coreRoot) {
  console.log('\n=== lifecycle smoke ===\n')
  console.log('  SKIP  DSH_CORE_ROOT is not set (needs @deepseek-ai/cordis and @deepseek-ai/dsh-fs)')
  console.log('\n=== 0 passed, 0 failed, 1 suite skipped ===')
  process.exit(0)
}
// This suite drives the host's own framework (Cordis service ordering), so a
// generated stub root cannot stand in for it: skip rather than crash. The
// package list is explicit — this suite mounts lib/index.js, which registers the
// agent tools, so a missing `dsh-tools` would crash here rather than skip.
skipWithoutRealPeers('lifecycle smoke', 'a real assembled DSH tree (@deepseek-ai/cordis, dsh-fs and dsh-tools)', {
  requires: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-fs', '@deepseek-ai/dsh-tools'],
})
// Let the plugin's own requirePeer find the same tree (see lib/core/peers.js).
process.env.DSH_PEER_ROOT = [coreRoot, process.env.DSH_PEER_ROOT].filter(Boolean).join(path.delimiter)

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const requireFromCore = createRequire(path.join(coreRoot, 'noop.cjs'))
const { Context, Service } = requireFromCore('@deepseek-ai/cordis')
const { FileSystem } = requireFromCore('@deepseek-ai/dsh-fs')

const INSTALLED = Symbol.for('dsh-ssh-workspace.installed')
const EXPECTED_TOOLS = [
  'ssh_workspace_hosts',
  'ssh_workspace_mount',
  'ssh_workspace_unmount',
  'ssh_workspace_enable',
  'ssh_workspace_status',
  'ssh_workspace_exec',
  'ssh_workspace_transfer',
  'ssh_workspace_shell',
  'ssh_workspace_forward',
  'ssh_workspace_unforward',
  'ssh_workspace_reverse_forward',
]
// Route paths the browser half must expose. Kept in step with ROUTES in
// lib/routes/routes.js: hosts, host save/delete/forget-key/disconnect/reconnect,
// test, ls, git-history, status, self-check, passthrough settings,
// support-bundle, mount, unmount, enable, forward, unforward, the six
// saved-forward routes (save/toggle/delete/remember/probe/settings), transfer,
// download, download-tree, upload, upload-chunk, rename, delete, mkdir and
// mutation-policy.
//
// The number is pinned rather than derived on purpose: deriving it from ROUTES
// would make "a route was added but never registered" pass, which is the thing
// this assertion exists to notice. The set comparison added below the count
// covers the other half — a path that IS in ROUTES but never reached the
// web server — without giving up the acknowledgement this pin forces: adding a
// route still turns the count assertion red until someone edits this number.
const EXPECTED_ROUTES = 33

// The one route that carries a bound on HOW MUCH of a repository it may read,
// and the only one whose entire input is a Session id. Named here so that
// dropping it from the table, renaming its path or registering it twice is a
// failure with a readable label rather than an off-by-one in a count.
const GIT_HISTORY_PATH = '/api/dsh-ssh-workspace/git-history'
const ROUTES_MODULE = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'routes', 'routes.js')).href)

let failures = 0
let passes = 0
function check (label, ok, detail) {
  if (ok) {
    passes += 1
    console.log(`  PASS  ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function toolsPlugin () {
  return class StubTools extends Service {
    constructor (ctx) { super(ctx, 'tools'); this.registered = new Map() }
    register (definition) {
      if (this.registered.has(definition.name)) throw new Error(`tool "${definition.name}" already registered`)
      this.registered.set(definition.name, definition)
      return () => { this.registered.delete(definition.name) }
    }
  }
}

function webServerPlugin () {
  return class StubWebServer extends Service {
    constructor (ctx) { super(ctx, 'webServer'); this.routes = [] }
    register (route) { this.routes.push(route); return () => { this.routes = this.routes.filter(r => r !== route) } }
  }
}

function fsPlugin () {
  return class StubFs extends FileSystem {
    constructor (ctx, config) { super(ctx, 'fs'); this.config = config ?? {} }
    async resolve (p) { return { targetKey: `local:${p}`, displayPath: String(p) } }
    processPath (t) { return String(t?.targetKey ?? '') }
    processPathFromHostPath (p) { return p }
    fileUrl (t) { return `file:///${this.processPath(t)}` }
    contains () { return true }
    async stat () { return { version: 'v1', type: 'file', size: 3 } }
    async lstat () { return { version: 'v1', type: 'file' } }
    async readText () { return 'local contents' }
    async streamText () { return (async function * () { yield 'local' })() }
    async readBytes () { return new Uint8Array([1]) }
    async readByteRange () { return new Uint8Array([1]) }
    async listDir () { return [] }
    async writeText () { return { operation: 'update', version: 'v2', before: 'a', after: 'b' } }
    async editText () { return { version: 'v2', before: 'a', after: 'b' } }
    watch () { return Promise.reject(new Error('unsupported')) }
  }
}

const rawOf = (ctx, name) => ctx.get(name)?.[Symbol.for('cordis.original')] ?? ctx.get(name)

async function loadPlugin () {
  return import(pathToFileURL(path.join(pluginRoot, 'lib/index.js')).href)
}

console.log('\n=== lifecycle smoke ===\n')
console.log(`[core: ${coreRoot}]`)
console.log(`[plugin: ${pluginRoot}]`)

// --- scenario 1: no web server at all (headless) -----------------------------
console.log('\n[1] headless: tools only, no web server')
{
  const app = new Context()
  await app.plugin(toolsPlugin(), {})
  const plugin = await loadPlugin()
  await app.plugin(plugin, { enabled: true, announceToAgent: false })
  await app.plugin(fsPlugin(), {})
  await sleep(50)

  check('plugin activated', app.get('tools') !== undefined)
  check('ctx.fs was patched', rawOf(app, 'fs')?.[INSTALLED] !== undefined)
  const names = [...app.get('tools').registered.keys()]
  check('all expected agent tools registered', EXPECTED_TOOLS.every(n => names.includes(n)), JSON.stringify(names))
}

// --- scenario 2: web server already up before the filesystem -----------------
console.log('\n[2] web server and tools already up, filesystem arrives last')
{
  const app = new Context()
  await app.plugin(toolsPlugin(), {})
  await app.plugin(webServerPlugin(), {})
  const plugin = await loadPlugin()
  await app.plugin(plugin, { enabled: true, announceToAgent: false })
  await app.plugin(fsPlugin(), {})
  await sleep(50)

  const routes = app.get('webServer').routes
  check('ctx.fs was patched', rawOf(app, 'fs')?.[INSTALLED] !== undefined)
  check('all expected agent tools registered', [...app.get('tools').registered.keys()].length === EXPECTED_TOOLS.length)
  check(`exactly ${EXPECTED_ROUTES} HTTP routes registered`, routes.length === EXPECTED_ROUTES, String(routes.length))
  check('routes carry a path and a handler', routes.every(r => typeof r.path === 'string' && typeof r.handler === 'function'))
  check('no route path was double-registered',
    new Set(routes.map(r => r.path)).size === routes.length,
    JSON.stringify(routes.map(r => r.path)))
  // The count above notices "a route was added", this notices "the table and
  // the registrations drifted apart". Two different bugs: a route declared in
  // ROUTES but skipped by the registration step keeps the count correct only
  // when something else was double-registered, and a path registered twice
  // never shows up in the count at all once the pin is stale. Comparing the
  // two SETS catches both, and the explicit git-history assertion below keeps
  // the one route this review is about from disappearing into that set.
  const declared = Object.values(ROUTES_MODULE.ROUTES)
  check('every declared route reached the web server',
    declared.length === routes.length && declared.every(p => routes.some(r => r.path === p)),
    `declared=${declared.length} registered=${routes.length}`)
  check('the route table declares exactly the pinned number',
    Object.keys(ROUTES_MODULE.ROUTES).length === EXPECTED_ROUTES,
    String(Object.keys(ROUTES_MODULE.ROUTES).length))
  check('git-history is registered as its own exact endpoint on the declared path',
    routes.filter(r => r.path === GIT_HISTORY_PATH).length === 1 &&
      routes.find(r => r.path === GIT_HISTORY_PATH).kind === 'exact' &&
      ROUTES_MODULE.ROUTES.gitHistory === GIT_HISTORY_PATH,
    `${GIT_HISTORY_PATH} (kind must be exact; the GET-only method check lives in the handler's guard)`)
}

// --- scenario 3: web server arrives AFTER the filesystem ---------------------
console.log('\n[3] filesystem first, web server arrives last')
{
  const app = new Context()
  await app.plugin(toolsPlugin(), {})
  const plugin = await loadPlugin()
  await app.plugin(plugin, { enabled: true, announceToAgent: false })
  await app.plugin(fsPlugin(), {})
  await sleep(20)
  check('before the web server: fs patched, no routes yet', rawOf(app, 'fs')?.[INSTALLED] !== undefined)

  await app.plugin(webServerPlugin(), {})
  await sleep(50)
  const routes = app.get('webServer').routes
  check(`late web server still gets all ${EXPECTED_ROUTES} routes`, routes.length === EXPECTED_ROUTES, String(routes.length))
  check('tools still registered after the late web server', [...app.get('tools').registered.keys()].length === EXPECTED_TOOLS.length)
}

// --- scenario 4: every dependency present before the plugin ------------------
console.log('\n[4] all services already up before the plugin mounts')
{
  const app = new Context()
  await app.plugin(toolsPlugin(), {})
  await app.plugin(webServerPlugin(), {})
  await app.plugin(fsPlugin(), {})
  const plugin = await loadPlugin()
  await app.plugin(plugin, { enabled: true, announceToAgent: false })
  await sleep(50)

  check('ctx.fs was patched', rawOf(app, 'fs')?.[INSTALLED] !== undefined)
  check('all expected agent tools registered', [...app.get('tools').registered.keys()].length === EXPECTED_TOOLS.length)
  check(`all ${EXPECTED_ROUTES} routes registered`, app.get('webServer').routes.length === EXPECTED_ROUTES, String(app.get('webServer').routes.length))
}

// --- scenario 5: announceToAgent with and without a systemPrompt service -----
console.log('\n[5] announceToAgent must not require a systemPrompt service')
{
  const app = new Context()
  await app.plugin(toolsPlugin(), {})
  await app.plugin(fsPlugin(), {})
  const plugin = await loadPlugin()
  let mountError
  try {
    await app.plugin(plugin, { enabled: true, announceToAgent: true })
  } catch (e) { mountError = e }
  await sleep(50)
  check('plugin activates with announceToAgent=true and no systemPrompt service', mountError === undefined, mountError?.message)
  check('agent tools still registered', [...app.get('tools').registered.keys()].length === EXPECTED_TOOLS.length)
}

console.log(`\n=== ${passes} passed, ${failures} failed ===`)
process.exit(failures === 0 ? 0 : 1)
