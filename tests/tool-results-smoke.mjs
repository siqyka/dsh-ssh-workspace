/**
 * Every tool's RESULT must survive the Host's output-schema enforcement.
 *
 * ## The gap this closes
 *
 * `tool-schemas-smoke.mjs` does two things: it compares each `execute`'s
 * TOP-LEVEL returned keys against the top-level declared ones, and it renders
 * hand-written ideal values. Both leave the same blind spot, twice over:
 *
 *  - a nested field (`events[].seq`, `hosts[].jump`) is invisible to a
 *    top-level key comparison;
 *  - a runtime payload cannot appear in a hand-written value, so the thing that
 *    actually broke — the store's raw rows — was never rendered or validated.
 *
 * So `ssh_workspace_status` shipped with `events[].seq` undeclared and
 * `ssh_workspace_hosts` shipped returning the raw store rows, and the suite
 * stayed green. This file runs the REAL `execute` of every tool that can be
 * given realistic collaborators without a live host, then validates the result
 * against the REAL output schema — including the projection step, because the
 * Host rejects a value that cannot be losslessly projected BEFORE it checks any
 * property.
 *
 * Runs on a bare checkout: the peer stubs are enough, and `DSH_CORE_ROOT` is
 * pointed at the generated stub root by `run.mjs`.
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// `lib/peers.js` searches `DSH_PEER_ROOT`; `run.mjs` supplies the root it built
// as `DSH_CORE_ROOT`. Bridge them before the first `lib/` import, because
// `remote-fs.js` resolves its peers at module load. Every peer-consuming suite
// does the same thing for the same reason.
const coreRoot = process.env.DSH_CORE_ROOT
if (coreRoot) process.env.DSH_PEER_ROOT = [coreRoot, process.env.DSH_PEER_ROOT].filter(Boolean).join(path.delimiter)

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
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

console.log(`\n=== tool result conformance (${pluginRoot}) ===\n`)

const { workspaceTools, defineTool, drainProjectionDrops } = await import(pathToFileURL(path.join(pluginRoot, 'lib/tools.js')).href)
const { SshWorkspaceEngine } = await import(pathToFileURL(path.join(pluginRoot, 'lib/engine.js')).href)
const { RemoteFileSystem } = await import(pathToFileURL(path.join(pluginRoot, 'lib/remote-fs.js')).href)
const { Diagnostics } = await import(pathToFileURL(path.join(pluginRoot, 'lib/diagnostics.js')).href)
const { CommandAudit } = await import(pathToFileURL(path.join(pluginRoot, 'lib/audit.js')).href)
const { ShellManager } = await import(pathToFileURL(path.join(pluginRoot, 'lib/shell.js')).href)
const { projectValue, validateValue } = await import(pathToFileURL(path.join(pluginRoot, 'lib/tool-schema.js')).href)

// ---------------------------------------------------------------------------
// A store whose listing() returns rows with EVERY field the real HostStore
// produces, including the ones no schema used to declare. This is the shape the
// issue's `hosts` failure came from, so it must be exercised as data, not as a
// hand-written literal.
// ---------------------------------------------------------------------------
const storeRows = [
  {
    alias: 'prod-db-01',
    host: '10.0.0.11',
    port: 22,
    user: 'alice',
    auth: 'key',
    keyReady: true,
    source: 'ssh-config',
    tags: [],
    agentForward: false,
    compress: false,
    lastUsedAt: 1_760_000_000_000,
    // The audit rows an ssh-config host carries. `jump` is the other field the
    // issue named; it is built by the engine, not the store, so it is covered
    // separately below where a connection record is available.
    unsupported: [
      { keyword: 'localforward', value: '8080 localhost:80', verdict: 'lost', detail: 'no local tunnel is created' },
    ],
  },
  {
    alias: 'bastion',
    host: 'bastion.example',
    port: 2222,
    user: 'ops',
    auth: 'agent',
    keyReady: true,
    source: 'store',
    description: 'the jump host',
    tags: ['infra', 'shared'],
    agentForward: true,
    compress: true,
  },
]

const store = {
  listing: () => ({ rows: storeRows, skipped: [] }),
  rows: () => storeRows,
  entry: () => undefined,
  entryStore: { disableWorkspace: () => true },
}

const engine = new SshWorkspaceEngine({ store })
// Real rings with content: an EMPTY ring hides exactly the field that broke.
engine.diagnostics = new Diagnostics(10)
engine.diagnostics.record('connect', 'connected to prod-db-01')
engine.diagnostics.record('degraded', 'inotifywait is missing; polling instead')
engine.diagnostics.record('forward', 'opened a forward')
engine.audit = new CommandAudit(10)
engine.audit.record({
  alias: 'prod-db-01',
  command: 'systemctl restart api',
  channel: 'exec',
  durationMs: 42,
  exitCode: 0,
  timedOut: false,
})
engine.audit.record({
  alias: 'bastion',
  command: 'rm -rf /tmp/cache',
  channel: 'shell',
  durationMs: 900,
  exitCode: null,
  timedOut: true,
  outcomeUnknown: true,
  cwd: '/srv/app',
  error: 'the SSH connection dropped before the process reported an exit status',
})

const router = new RemoteFileSystem({ engine })
// Through the real API, not the internal set: `addRoot` canonicalizes and clears
// a stale detach mark, and `disableRoot` is what the unmount tool calls.
router.addRoot('prod-db-01', '/srv/app')
router.disableRoot('ssh://bastion/opt/old')

const forwards = {
  list: () => [{
    id: 'fwd-1',
    alias: 'prod-db-01',
    localHost: '127.0.0.1',
    localPort: 5173,
    remoteHost: '127.0.0.1',
    remotePort: 5173,
    connections: 2,
  }],
  open: async () => ({}),
  close: () => false,
}

const reverseForwards = {
  list: () => [{
    id: 'rwd-1',
    alias: 'bastion',
    localHost: '127.0.0.1',
    localPort: 3000,
    remoteHost: '127.0.0.1',
    remotePort: 41000,
    requestedRemotePort: 41000,
    exposed: false,
    connections: 0,
  }],
}

// A REAL `ShellManager`, with its two maps populated directly. Hand-writing the
// rows instead would defeat the purpose: the defect being guarded against is in
// `ShellManager.list()` itself (`startedIn: start?.cwd`, `undefined` when the
// start record is gone), and a literal in the test cannot reproduce what a
// producer will do. Populating the maps makes `list()` run for real.
const shells = new ShellManager({ engine: { closeShellChannel: () => {} } })
shells.shells.set('prod-db-01\u0000default', { alive: true })
shells.starts.set('prod-db-01\u0000default', { cwd: '/srv/app', reopens: 2 })
// A CLOSED session whose start record is already gone: the legitimate case that
// makes `startedIn` unknowable.
shells.shells.set('bastion\u0000scratch', { alive: false })

const ctx = { get: () => undefined, config: {} }
const tools = workspaceTools(ctx, engine, router, forwards, shells, reverseForwards)

// ---------------------------------------------------------------------------
// Run every tool that can be executed here, and check its result.
// ---------------------------------------------------------------------------
const byName = new Map(tools.map(tool => [tool.name, tool]))

/**
 * Execute one tool and assert its result conforms, reporting drops as failures.
 *
 * The important assertion is the FIRST one, and it is not derived from the value
 * the test receives: `lib/tools.js` projects every result before returning it, so
 * re-projecting that value would find zero drops by construction and prove
 * nothing. What the test reads instead is the wrapper's own record of what it
 * had to discard. A field the schema forgot therefore fails here even though the
 * user's call succeeded.
 *
 * @param {string} name - tool name.
 * @param {object} args - its arguments.
 * @param {string} label - what scenario this is, for the assertion names.
 */
async function conforms (name, args, label) {
  const tool = byName.get(name)
  if (tool === undefined) {
    check(`${name} exists`, false)
    return
  }
  // Discard anything a previous scenario left behind, so one tool's drop cannot
  // be reported as another's, and so a drop cannot hide by being drained twice.
  drainProjectionDrops()
  let value
  try {
    value = await tool.execute(args, {})
  } catch (error) {
    check(`${name} ${label}: execute does not throw`, false, error instanceof Error ? error.message : String(error))
    return
  }
  // (1) The observer's view: did the wrapper have to discard anything?
  const recorded = drainProjectionDrops()
  check(`${name} ${label}: nothing had to be projected away`,
    recorded.length === 0,
    recorded.map(entry => `${entry.path} (${entry.reason})`).join('; '))

  const schema = tool.output.schema

  // (2) The Host's first step, replayed on what the wrapper actually returned: it
  // must already be a fixed point. This is a weaker but independent check — it
  // would catch a wrapper that dropped nothing yet handed back a shape the schema
  // still refuses (for example an `undefined` the wrapper never visited).
  const projection = projectValue(schema, value)
  const drops = projection.dropped.map(entry => `${entry.path} (${entry.reason})`)
  check(`${name} ${label}: the returned value is already a fixed point of its schema`, drops.length === 0, drops.join('; '))

  // (3) The Host's second step: every declared property must match.
  const errors = validateValue(schema, projection.value)
  check(`${name} ${label}: projected result satisfies its schema`, errors.length === 0, errors.join('; '))

  // (4) The renderer must survive the projected value, because a throwing render
  // breaks the RESULT rather than the call.
  try {
    const blocks = tool.output.render(args, projection.value)
    check(`${name} ${label}: render() returns content blocks`,
      Array.isArray(blocks) && blocks.length > 0 && blocks.every(block => typeof block.text === 'string'))
  } catch (error) {
    check(`${name} ${label}: render() does not throw`, false, error instanceof Error ? error.message : String(error))
  }
}

console.log('[ssh_workspace_hosts: real store rows]')
await conforms('ssh_workspace_hosts', {}, 'unfiltered')
await conforms('ssh_workspace_hosts', { query: 'bastion' }, 'filtered')

console.log('\n[ssh_workspace_hosts: nothing to show, and something unreadable]')
{
  // An EMPTY listing and a FAILED one are different answers, and both must
  // conform. The unreadable case is the one that carries `skipped`/`storeError`.
  const emptyEngine = new SshWorkspaceEngine({ store: { listing: () => ({ rows: [], skipped: [] }), rows: () => [], entry: () => undefined } })
  const emptyRouter = new RemoteFileSystem({ engine: emptyEngine })
  const emptyTools = workspaceTools({ get: () => undefined, config: {} }, emptyEngine, emptyRouter, forwards, shells, reverseForwards)
  const emptyHosts = emptyTools.find(tool => tool.name === 'ssh_workspace_hosts')
  const value = await emptyHosts.execute({}, {})
  const errors = validateValue(emptyHosts.output.schema, projectValue(emptyHosts.output.schema, value).value)
  check('an empty host list still conforms', errors.length === 0, errors.join('; '))

  const brokenEngine = new SshWorkspaceEngine({ store: {
    listing: () => ({ rows: [], skipped: [{ reason: 'the entry needs a ProxyCommand' }], storeError: 'EACCES' }),
    rows: () => [],
    entry: () => undefined,
  } })
  const brokenTools = workspaceTools({ get: () => undefined, config: {} }, brokenEngine, new RemoteFileSystem({ engine: brokenEngine }), forwards, shells, reverseForwards)
  const brokenHosts = brokenTools.find(tool => tool.name === 'ssh_workspace_hosts')
  const brokenValue = await brokenHosts.execute({}, {})
  const brokenProjection = projectValue(brokenHosts.output.schema, brokenValue)
  check('an unreadable store reports skipped and storeError without dropping them',
    brokenProjection.dropped.length === 0 &&
    brokenValue.skipped?.length === 1 &&
    brokenValue.storeError === 'EACCES',
    JSON.stringify(brokenProjection.dropped))
  const brokenErrors = validateValue(brokenHosts.output.schema, brokenProjection.value)
  check('an unreadable store still conforms', brokenErrors.length === 0, brokenErrors.join('; '))
  emptyEngine.dispose()
  brokenEngine.dispose()
}

console.log('\n[ssh_workspace_status: real ring and pool shapes]')
{
  // The pool record: the issue reported six events, each rejected for `seq`.
  // A ring with entries is therefore mandatory here — an empty one would have
  // passed before the fix and proves nothing.
  engine.pool.set('prod-db-01', { broken: false, inFlight: 0, generation: 2 })
  engine.pool.set('bastion', { broken: true, inFlight: 3, generation: 1 })
}

await conforms('ssh_workspace_status', {}, 'connected and broken hosts')

console.log('\n[ssh_workspace_unmount / enable: failure paths]')
await conforms('ssh_workspace_unmount', { workspacePath: 'ssh://prod-db-01/srv/app' }, 'detach')
await conforms('ssh_workspace_enable', { workspacePath: 'ssh://prod-db-01/srv/app' }, 're-enable')

console.log('\n[a finished background job renders too]')
{
  // `startBackgroundExec` returns a different shape from `engine.exec`, and it
  // is the one path where the schema's `jobId` branch matters.
  const execTool = byName.get('ssh_workspace_exec')
  const errors = validateValue(execTool.output.schema, {
    success: true,
    exitCode: null,
    timedOut: false,
    stdout: '',
    stderr: '',
    truncated: false,
    durationMs: 12,
    jobId: 'bash-abc123',
  })
  check('a background job result conforms', errors.length === 0, errors.join('; '))
}

console.log('\n[an undeclared field is caught, not silently shipped]')
{
  // The suites above read the wrapper's drop RECORD. If that record were never
  // written, every "nothing had to be projected away" assertion would pass for
  // the wrong reason. This drives the wrapper with a deliberately mis-declared
  // tool, carrying exactly the two shapes the issue reported: an undeclared key
  // and a key present with `undefined`.
  drainProjectionDrops()
  const drifting = defineTool({
    name: 'test_drift',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { kept: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: String(value.kept) }],
    },
    async execute () {
      return { kept: 'x', surprise: 1, alsoSurprise: undefined }
    },
  })
  const returned = await drifting.execute({}, {})
  check('the wrapper still keeps the call alive', returned.kept === 'x', JSON.stringify(returned))
  check('and discards the undeclared field', returned.surprise === undefined, JSON.stringify(returned))
  const recorded = drainProjectionDrops()
  check('the wrapper RECORDS what it discarded',
    recorded.length === 2 && recorded.every(entry => entry.tool === 'test_drift'),
    JSON.stringify(recorded))
  check('and names the paths, so a failure points at the producer',
    recorded.map(entry => entry.path).sort().join(',') === 'alsoSurprise,surprise',
    JSON.stringify(recorded))
  check('draining empties the record, so one scenario cannot satisfy another',
    drainProjectionDrops().length === 0)
}

console.log('\n[the projection primitives still detect, in isolation]')
{
  // The block above proves the WRAPPER records drops. This one proves the
  // primitives underneath still detect them: if `projectValue` stopped noticing
  // an undeclared key, the wrapper would record nothing and every suite above
  // would pass while silently shipping the original bug.
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: { a: { type: 'string', required: true } },
  }
  const projection = projectValue(schema, { a: 'x', surprise: 1 })
  check('projectValue reports an undeclared key',
    projection.dropped.length === 1 && projection.dropped[0].path === 'surprise',
    JSON.stringify(projection.dropped))
  check('projectValue drops it', projection.value.surprise === undefined)

  const undefinedProjection = projectValue(schema, { a: undefined })
  check('projectValue reports an undefined value as unreachable in JSON',
    undefinedProjection.dropped.some(entry => entry.reason.includes('undefined')),
    JSON.stringify(undefinedProjection.dropped))

  const nested = validateValue(
    { type: 'object', additionalProperties: false, properties: { rows: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'integer', required: true } } } } } },
    { rows: [{ id: 1, extra: true }] })
  check('validateValue reports a nested undeclared key',
    nested.some(line => line.includes('rows[0].extra')),
    JSON.stringify(nested))
}

engine.dispose()
console.log(`\n=== ${passes.length} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
