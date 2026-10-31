/**
 * Transport-option and background-job checks.
 *
 * Two seams whose behaviour is easy to break silently:
 *
 * 1. **Per-host transport flags** (#6). `agentForward` and `compress` are
 *    opt-in: a host that does not ask for them must produce exactly the ssh2
 *    config it produced before they existed, because enabling either by default
 *    changes how the connection behaves for everybody. The resolution path also
 *    spans three layers — the JSON store, `ssh config`, and the engine's
 *    `connectConfig` — so a flag that survives one and is dropped by another is
 *    the likely bug.
 *
 *    `agentForward` has a second, harder contract: ssh2 reads a CONNECT-level
 *    `agentForward` as a connection-wide permission and hard-throws at connect
 *    time when the connection carries no agent — which key/password auth does
 *    not — so the engine must never set it there. The wish travels on the
 *    pooled record and is expressed per exec/shell channel
 *    (`channelExecOptions`), leaving SFTP untouched; the checks below feed the
 *    built configs to a REAL ssh2 client to prove the connect-time throw is
 *    gone, and that toggling the checkbox never rewrites auth.
 *
 * 2. **Background exec** (#8). `ssh_workspace_exec` with `run_in_background`
 *    must register a job and return its id immediately, and must degrade to
 *    inline execution (not to a dangling id) when the deployment has no `jobs`
 *    seam.
 *
 * Run: node tests/transport-smoke.mjs
 */

import { createRequire } from 'node:module'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// remote-fs.js (pulled in for the tool set) resolves the DSH peer packages, so
// the suite needs the assembled tree even though it never opens a connection.
const coreRoot = process.env.DSH_CORE_ROOT
if (!coreRoot) {
  console.log('\n=== transport smoke ===\n')
  console.log('  SKIP  DSH_CORE_ROOT is not set (needs @deepseek-ai/dsh-fs)')
  console.log('\n=== 0 passed, 0 failed, 1 suite skipped ===')
  process.exit(0)
}
process.env.DSH_PEER_ROOT = [coreRoot, process.env.DSH_PEER_ROOT].filter(Boolean).join(path.delimiter)

const { HostConfigStore } = await import(pathToFileURL(path.join(pluginRoot, 'lib/store.js')).href)
const { SshWorkspaceEngine, channelExecOptions, agentIsReachable, isAgentForwardingRefusal } = await import(pathToFileURL(path.join(pluginRoot, 'lib/engine.js')).href)
const { RemoteFileSystem } = await import(pathToFileURL(path.join(pluginRoot, 'lib/remote-fs.js')).href)
const { workspaceTools } = await import(pathToFileURL(path.join(pluginRoot, 'lib/tools.js')).href)

// The plugin's own ssh2 tree: the connect-time validation under test is REAL
// ssh2 behaviour, so a stand-in would prove nothing.
const { Client } = createRequire(path.join(pluginRoot, 'package.json'))('ssh2')

/** A real private key, so key-auth configs survive ssh2's synchronous parse. */
const TEST_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey

/** The same key on disk: connectConfig refuses key paths that do not exist. */
const TEST_KEY_PATH = path.join(tmpdir(), 'dsh-transport-test-key.pem')
writeFileSync(TEST_KEY_PATH, TEST_KEY, { mode: 0o600 })

/**
 * Hand a built config to real ssh2 and report a SYNCHRONOUS failure, if any.
 * The historical bug was exactly such a throw ("You must set a valid agent
 * path…") fired from `connect()` before any handshake; async handshake noise
 * (the fake host never answers) is swallowed — only sync validation counts.
 */
function connectRejection (config) {
  const client = new Client()
  client.on('error', () => {})
  client.on('close', () => {})
  try {
    client.connect(config)
  } catch (error) {
    try { client.end() } catch { /* never opened */ }
    return error.message
  }
  queueMicrotask(() => { try { client.end() } catch { /* handshake still trying */ } })
  return undefined
}

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== transport smoke ===\n')

const entry = (alias, extra = {}) => ({
  alias,
  host: `${alias}.example`,
  port: 22,
  user: 'u',
  auth: { kind: 'agent' },
  ...extra,
})

/** An engine whose connections are never opened; only config building is exercised. */
function quietEngine () {
  return new SshWorkspaceEngine({})
}

// --- #6: opt-in means OFF by default --------------------------------------
{
  const engine = quietEngine()
  const config = engine.connectConfig({ alias: 'plain', host: 'h', port: 22, user: 'u', auth: { kind: 'password', password: 'p' } })
  check('agentForward is absent unless the host opts in', config.agentForward === undefined, String(config.agentForward))
  check('compress is absent unless the host opts in', config.compress === undefined, String(config.compress))
  engine.dispose()
}

{
  // The reported failure: with the box checked and key/password auth, ssh2
  // threw "You must set a valid agent path to allow agent forwarding" straight
  // out of connect() — every connection died, SFTP browsing included. With no
  // local agent (this container has none) the connection must still build.
  const previousSock = process.env.SSH_AUTH_SOCK
  delete process.env.SSH_AUTH_SOCK
  try {
    const engine = quietEngine()
    const config = engine.connectConfig({
      alias: 'checked', host: 'h', port: 22, user: 'u',
      auth: { kind: 'password', password: 'p' },
      agentForward: true,
      compress: true,
    })
    check('a checked host never carries the connect-level agentForward flag',
      config.agentForward === undefined, String(config.agentForward))
    check('compress still reaches the ssh2 config when requested', config.compress === true, String(config.compress))
    check('the rest of the config is unaffected', config.host === 'h' && config.port === 22 && config.username === 'u')
    check('a checked password host passes ssh2 connect validation',
      connectRejection(config) === undefined, connectRejection(config))
    engine.dispose()

    // The key-auth variant of the same report — the config that used to throw.
    const keyEngine = quietEngine()
    const keyConfig = keyEngine.connectConfig({
      alias: 'checked-key', host: 'h', port: 22, user: 'u',
      auth: { kind: 'key', keyPath: TEST_KEY_PATH },
      agentForward: true,
    })
    check('a checked key host carries no connect-level agentForward flag',
      keyConfig.agentForward === undefined, String(keyConfig.agentForward))
    // On Windows the resolver's default IS `pageant` (ssh2's native agent
    // transport), so an attached agent there is the platform convention rather
    // than an invented one; elsewhere nothing may be attached without a sock.
    if (process.platform === 'win32') {
      check('a checked key host attaches only the platform default agent',
        keyConfig.agent === 'pageant', String(keyConfig.agent))
    } else {
      check('a checked key host invents no agent without a local ssh-agent',
        keyConfig.agent === undefined, String(keyConfig.agent))
    }
    check('a checked key host passes ssh2 connect validation',
      connectRejection(keyConfig) === undefined, connectRejection(keyConfig))
    keyEngine.dispose()
  } finally {
    if (previousSock !== undefined) process.env.SSH_AUTH_SOCK = previousSock
  }
}

// --- #6: with a local agent the channel flag has something to forward ------
{
  const fakeSock = path.join(tmpdir(), 'dsh-transport-fake-agent.sock')
  const previousSock = process.env.SSH_AUTH_SOCK
  process.env.SSH_AUTH_SOCK = fakeSock
  try {
    const engine = quietEngine()
    const config = engine.connectConfig({
      alias: 'forwarded', host: 'h', port: 22, user: 'u',
      auth: { kind: 'key', keyPath: TEST_KEY_PATH },
      agentForward: true,
    })
    check('a local agent is attached so per-channel forwarding can work', config.agent === fakeSock, String(config.agent))
    check('the attach still adds no connect-level agentForward', config.agentForward === undefined, String(config.agentForward))
    check('the connection still validates under real ssh2', connectRejection(config) === undefined)

    // Agent auth keeps its own path and its clear failure when none exists.
    const agentConfig = engine.connectConfig({
      alias: 'agent-auth', host: 'h', port: 22, user: 'u',
      auth: { kind: 'agent', agentPath: fakeSock },
      agentForward: true,
    })
    check('agent auth keeps its explicit path', agentConfig.agent === fakeSock, String(agentConfig.agent))
    delete process.env.SSH_AUTH_SOCK
    // Windows falls back to pageant, so "no agent" is only reachable off-win32;
    // asserting the refusal there would be asserting a non-Windows contract on
    // a Windows host.
    if (process.platform === 'win32') {
      check('agent auth on Windows falls back to the platform agent',
        quietEngine().connectConfig({ alias: 'noagent', host: 'h', port: 22, user: 'u', auth: { kind: 'agent' } }).agent === 'pageant',
        'pageant fallback missing')
    } else {
      let refusal = 'no throw'
      try {
        quietEngine().connectConfig({ alias: 'noagent', host: 'h', port: 22, user: 'u', auth: { kind: 'agent' } })
      } catch (error) { refusal = error.message }
      check('agent auth with no ssh-agent keeps the clear error',
        refusal.includes('uses agent auth but no ssh-agent is available'), refusal)
    }
    engine.dispose()
  } finally {
    if (previousSock !== undefined) process.env.SSH_AUTH_SOCK = previousSock
    else delete process.env.SSH_AUTH_SOCK
  }
}

{
  // A falsy-but-not-false value must not enable the flag.
  const engine = quietEngine()
  const config = engine.connectConfig({
    alias: 'sloppy', host: 'h', port: 22, user: 'u',
    auth: { kind: 'password', password: 'p' },
    agentForward: 'yes',
    compress: 1,
  })
  check('a non-boolean flag does not enable agentForward', config.agentForward === undefined && config.agent === undefined,
    JSON.stringify({ agentForward: config.agentForward, agent: config.agent }))
  check('a non-boolean flag does not enable compress', config.compress === undefined, String(config.compress))
  engine.dispose()
}

// --- #6: the wish travels on the record, expressed per command channel -----
{
  check('a forwarding record asks on its command channels', JSON.stringify(channelExecOptions({ agentForward: true })) === JSON.stringify({ agentForward: true }),
    JSON.stringify(channelExecOptions({ agentForward: true })))
  const withPty = channelExecOptions({ agentForward: true }, { pty: { cols: 80, rows: 24 } })
  check('caller channel options survive the merge', withPty.agentForward === true && withPty.pty?.cols === 80, JSON.stringify(withPty))
  const plain = channelExecOptions({})
  check('a non-forwarding record adds nothing', plain.agentForward === undefined && Object.keys(plain).length === 0, JSON.stringify(plain))

  // Every command-channel open site goes through the same seam; the connect
  // config must never carry the flag again.
  const engineSource = readFileSync(path.join(pluginRoot, 'lib/engine.js'), 'utf8')
  const shellSource = readFileSync(path.join(pluginRoot, 'lib/patch-shell.js'), 'utf8')
  const subprocessSource = readFileSync(path.join(pluginRoot, 'lib/patch-subprocess.js'), 'utf8')
  check('connectConfig no longer assigns a connect-level agentForward',
    !engineSource.includes('config.agentForward'), 'config.agentForward still assigned')
  check('the snapshot exec passes the record wish to its channel',
    engineSource.includes('agentForward: record.agentForward === true'), 'exec() does not pass the wish')
  check('openChannel builds its options through channelExecOptions',
    engineSource.includes('channelExecOptions(record, { pty: options.pty })') && engineSource.includes('channelExecOptions(record)'),
    'openChannel does not route through the helper')
  check('the shell router exec asks through the same helper',
    shellSource.includes('record.client.exec(script, channelExecOptions(record)'), 'patch-shell.js bypasses the helper')
  check('the subprocess router exec asks through the same helper',
    subprocessSource.includes('record.client.exec(script, channelExecOptions(record)'), 'patch-subprocess.js bypasses the helper')
}

// --- #6: an agent must ANSWER before it joins the connection ---------------
{
  // The gate exists because a named-but-dead agent fails INSIDE authentication,
  // where its error replaces the real one. `pageant` is the case that matters on
  // Windows: `resolveAgentPath` answers it unconditionally.
  const unreachable = await agentIsReachable('pageant')
  check('a pageant that is not running is unreachable', unreachable === false || process.platform !== 'win32',
    String(unreachable))
  check('an endpoint that is not a socket is unreachable', (await agentIsReachable(path.join(tmpdir(), 'definitely-not-a-socket'))) === false,
    'a bogus endpoint was treated as reachable')
  check('a missing endpoint is unreachable', (await agentIsReachable('')) === false, 'an empty endpoint was treated as reachable')

  // The retry discriminator: only forwarding refusals qualify.
  check('ssh2 forwarding refusal is recognised',
    isAgentForwardingRefusal(new Error('Unable to request agent forwarding')) === true, 'not recognised')
  check('a dead socket is not a forwarding refusal',
    isAgentForwardingRefusal(new Error('Not connected')) === false, 'misclassified as forwarding')
  check('an admin prohibition is not a forwarding refusal',
    isAgentForwardingRefusal(new Error('administratively prohibited')) === false, 'misclassified as forwarding')
  check('a null error is not a forwarding refusal', isAgentForwardingRefusal(undefined) === false, 'misclassified')
}

// --- #6: round-trip through the JSON store --------------------------------
{
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-transport-'))
  const file = path.join(dir, 'dsh-ssh.json')
  try {
    const store = new HostConfigStore(file)
    store.save([entry('stored', { agentForward: true, compress: true }), entry('bare')])

    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const stored = raw.hosts.find(host => host.alias === 'stored')
    const bare = raw.hosts.find(host => host.alias === 'bare')
    check('the store persists agentForward', stored.agentForward === true, JSON.stringify(stored.agentForward))
    check('the store persists compress', stored.compress === true, JSON.stringify(stored.compress))
    check('a host without the flags stays flag-free',
      bare.agentForward === undefined && bare.compress === undefined,
      JSON.stringify({ agentForward: bare.agentForward, compress: bare.compress }))

    // Resolve back through the engine's descriptor shape: compress is a real
    // connection option and reaches the config; the agent-forward wish stays
    // off the connect config by design (the record carries it — see the
    // channel section above).
    const engine = quietEngine()
    const resolvedStored = engine.connectConfig({
      ...stored,
      auth: { kind: 'password', password: 'p' },
    })
    check('a stored compress flag survives into the connect config', resolvedStored.compress === true, String(resolvedStored.compress))
    check('a stored agentForward wish stays off the connect config',
      resolvedStored.agentForward === undefined, String(resolvedStored.agentForward))
    // Only the platform-default agent may appear here; see the key-host case
    // above for why Windows has one.
    check('a stored agentForward wish invents no agent beyond the platform default',
      process.platform === 'win32' ? resolvedStored.agent === 'pageant' : resolvedStored.agent === undefined,
      String(resolvedStored.agent))
    engine.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- #8: background exec registers a job ----------------------------------
{
  const started = []
  const jobs = {
    start (spec) {
      started.push(spec)
      return {
        id: 'job-42',
        async wait () { return { success: true, exitCode: 0, stdout: 'done', stderr: '', timedOut: false, truncated: false, durationMs: 1 } },
        kill () {},
      }
    },
  }
  const ctx = {
    get (name) { return name === 'jobs' ? jobs : undefined },
    jobs,
  }
  const engine = {
    async exec () {
      return { success: true, exitCode: 0, timedOut: false, stdout: 'inline', stderr: '', truncated: false, durationMs: 2 }
    },
    listMounted: () => [],
    listConnections: () => [],
  }
  const router = new RemoteFileSystem({ engine })
  const tools = workspaceTools(ctx, engine, router, { list: () => [] }, { list: () => [] })
  const exec = tools.find(tool => tool.name === 'ssh_workspace_exec')

  const result = await exec.execute({ alias: 'a', command: 'sleep 1', run_in_background: true }, { agent: { id: 'agent-1' } })
  check('a background call registers exactly one job', started.length === 1, `started=${started.length}`)
  check('a background call returns the job id', result.jobId === 'job-42', JSON.stringify(result.jobId))
  check('a background call does not report the inline output', result.stdout === '', JSON.stringify(result.stdout))
}

// --- #8: no jobs seam degrades to inline, not to a dangling id -------------
{
  const ctx = { get: () => undefined }
  const engine = {
    async exec () {
      return { success: true, exitCode: 0, timedOut: false, stdout: 'inline-ran', stderr: '', truncated: false, durationMs: 3 }
    },
    listMounted: () => [],
    listConnections: () => [],
  }
  const router = new RemoteFileSystem({ engine })
  const tools = workspaceTools(ctx, engine, router, { list: () => [] }, { list: () => [] })
  const exec = tools.find(tool => tool.name === 'ssh_workspace_exec')

  const result = await exec.execute({ alias: 'a', command: 'echo hi', run_in_background: true }, {})
  check('without a jobs seam the command still runs', result.stdout === 'inline-ran', JSON.stringify(result.stdout))
  check('without a jobs seam no job id is invented', result.jobId === undefined, JSON.stringify(result.jobId))
  check('without a jobs seam the caller is told it ran inline',
    typeof result.error === 'string' && result.error.includes('inline'), JSON.stringify(result.error))
}

let exitCode = 0
console.log(`\n=== ${passed} passed, ${failures} failed ===`)
if (failures > 0) exitCode = 1
process.exit(exitCode)
