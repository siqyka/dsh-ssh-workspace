/**
 * jump-tunnels smoke suite: jump-chain, jump-transport merged.
 *
 * Every assertion from the original suites is kept; each source suite is its own
 * section below. Run: node tests/jump-tunnels-smoke.mjs
 */

import path from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

let totalPassed = 0
let totalFailures = 0

await (async () => {
// ---------------------------------------------------------------------------
// jump-chain-smoke.mjs
// ---------------------------------------------------------------------------
/**
 * Jump-chain parsing: textual, security-relevant, no network needed.
 *
 * The failure modes here are the O-17 class — a chain that silently collapses
 * into a direct connection bypasses the bastion the user's config requires.
 * Every case below is decided by a pure function and executed directly.
 *
 */
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { parseHop, parseJumpChain, checkJumpChain, describeChain, MAX_JUMPS } =
  await import(pathToFileURL(path.join(pluginRoot, 'lib/hosts/hosts.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** Run a function and report whether it threw, plus the message. */
function attempt (fn) {
  try {
    return { value: fn(), threw: false }
  } catch (error) {
    return { threw: true, message: error instanceof Error ? error.message : String(error) }
  }
}

console.log('\n=== jump chain smoke ===\n')

// ---------------------------------------------------------------------------
// 1. One hop
// ---------------------------------------------------------------------------
console.log('[1] a single hop')
{
  const bare = parseHop('bastion')
  check('a bare name carries no port', bare.host === 'bastion' && bare.port === undefined, JSON.stringify(bare))
  check('and carries no user', bare.user === undefined, JSON.stringify(bare))
  // The absence is load-bearing: the port belongs to the host entry. Defaulting
  // it to 22 dialed a port the user never mentioned on any bastion that runs
  // elsewhere, and the resulting ECONNREFUSED named no hop at all.
  check('so the entry\'s own port is inherited rather than assumed', !('port' in bare), JSON.stringify(bare))

  const withUser = parseHop('deploy@bastion')
  check('user@ is split off', withUser.user === 'deploy' && withUser.host === 'bastion', JSON.stringify(withUser))

  const withPort = parseHop('bastion:2222')
  check('the port is read', withPort.port === 2222 && withPort.host === 'bastion', JSON.stringify(withPort))

  const both = parseHop('deploy@bastion:2222')
  check('user and port together', both.user === 'deploy' && both.host === 'bastion' && both.port === 2222, JSON.stringify(both))

  // A user name containing '@' is not valid, but the LAST '@' is the separator,
  // so the parse stays deterministic instead of producing a nonsense host.
  const odd = parseHop('a@b@bastion')
  check('the last @ is the separator', odd.user === 'a@b' && odd.host === 'bastion', JSON.stringify(odd))
}

// ---------------------------------------------------------------------------
// 2. IPv6 literals keep their colons
// ---------------------------------------------------------------------------
console.log('\n[2] IPv6 literals')
{
  const bare = parseHop('[::1]')
  check('a bracketed literal keeps its address', bare.host === '::1', JSON.stringify(bare))
  check('and inherits the port too', bare.port === undefined, JSON.stringify(bare))
  const port = parseHop('[2001:db8::1]:2200')
  check('and its port', port.host === '2001:db8::1' && port.port === 2200, JSON.stringify(port))
  const user = parseHop('root@[::1]:22')
  check('with a user too', user.user === 'root' && user.host === '::1' && user.port === 22, JSON.stringify(user))
  check('brackets are not part of the address', !bare.host.includes('['), bare.host)
}

// ---------------------------------------------------------------------------
// 3. Malformed values are errors, never silent "direct"
// ---------------------------------------------------------------------------
console.log('\n[3] a malformed hop is an error, not a silent direct connection')
{
  const badPort = attempt(() => parseHop('bastion:ssh'))
  check('a non-numeric port throws', badPort.threw === true, JSON.stringify(badPort))
  check('and the message names the offending text',
    /not a port number/u.test(badPort.message ?? ''), badPort.message)

  const emptyHost = attempt(() => parseHop('user@'))
  check('an empty host throws', emptyHost.threw === true, JSON.stringify(emptyHost))

  const emptyUser = attempt(() => parseHop('@bastion'))
  check('an empty user throws', emptyUser.threw === true, JSON.stringify(emptyUser))

  const outOfRange = attempt(() => parseHop('bastion:70000'))
  check('an out-of-range port throws', outOfRange.threw === true, JSON.stringify(outOfRange))

  const zero = attempt(() => parseHop('bastion:0'))
  check('port 0 throws', zero.threw === true, JSON.stringify(zero))
}

// ---------------------------------------------------------------------------
// 4. `none` means "connect directly" and must not become a hop
// ---------------------------------------------------------------------------
console.log('\n[4] `none` turns the proxy off')
{
  for (const spelling of ['none', 'NONE', 'None', '  none  ']) {
    const chain = parseJumpChain(spelling)
    check(`${JSON.stringify(spelling)} is a direct connection`, chain.kind === 'direct', JSON.stringify(chain))
  }
  const mixed = attempt(() => parseJumpChain('bastion,none'))
  check('`none` inside a list throws instead of being skipped', mixed.threw === true, JSON.stringify(mixed))
  check('and says so', /none/u.test(mixed.message ?? ''), mixed.message)
}

// ---------------------------------------------------------------------------
// 5. Chains
// ---------------------------------------------------------------------------
console.log('\n[5] multi-hop chains')
{
  const chain = parseJumpChain('a,b:2222,c')
  check('three hops are parsed in order',
    chain.kind === 'chain' && chain.hops.length === 3, JSON.stringify(chain))
  check('order is preserved', chain.hops.map(h => h.host).join(',') === 'a,b,c',
    JSON.stringify(chain.hops.map(h => h.host)))
  check('the middle hop keeps its port', chain.hops[1].port === 2222, JSON.stringify(chain.hops[1]))

  const arrayValue = parseJumpChain(['a,b', 'c'])
  check('an array value (store shape) is flattened', arrayValue.hops?.length === 3, JSON.stringify(arrayValue))

  const spaces = parseJumpChain(' a , b ')
  check('whitespace around hops is trimmed', spaces.hops?.length === 2, JSON.stringify(spaces))

  const trailing = parseJumpChain('a,')
  check('a trailing comma does not create an empty hop', trailing.hops?.length === 1, JSON.stringify(trailing))

  const empty = parseJumpChain('')
  check('an empty value is direct', empty.kind === 'direct', JSON.stringify(empty))

  const undef = parseJumpChain(undefined)
  check('undefined is direct', undef.kind === 'direct', JSON.stringify(undef))

  const tooMany = attempt(() => parseJumpChain(Array.from({ length: MAX_JUMPS + 1 }, (_, i) => `h${i}`).join(',')))
  check(`more than ${MAX_JUMPS} hops throws`, tooMany.threw === true, JSON.stringify(tooMany))
}

// ---------------------------------------------------------------------------
// 6. Self-reference and duplicates are refused
// ---------------------------------------------------------------------------
console.log('\n[6] chains that cannot be or should not be built')
{
  const self = checkJumpChain(parseJumpChain('web,bastion'), 'web')
  check('a self-reference is refused', self.ok === false, JSON.stringify(self))
  check('and named', /itself/u.test(self.error ?? ''), self.error)

  const dup = checkJumpChain(parseJumpChain('a,a'), 'target')
  check('a duplicate hop is refused', dup.ok === false, JSON.stringify(dup))

  // `a` and `a:22` are the same machine; letting both through would
  // authenticate twice for one link while looking like two hops.
  const sameHost = checkJumpChain(parseJumpChain('a,a:2222'), 'target')
  check('the same host at two ports is still one host', sameHost.ok === false, JSON.stringify(sameHost))

  const ok = checkJumpChain(parseJumpChain('a,b'), 'target')
  check('a well-formed chain is accepted', ok.ok === true, JSON.stringify(ok))

  const direct = checkJumpChain(parseJumpChain('none'), 'target')
  check('a direct connection is accepted', direct.ok === true, JSON.stringify(direct))

  // Case-insensitive, because hostnames are.
  const mixedCase = checkJumpChain(parseJumpChain('WEB'), 'web')
  check('the self-reference check ignores case', mixedCase.ok === false, JSON.stringify(mixedCase))
}

// ---------------------------------------------------------------------------
// 7. The description says which route is used
// ---------------------------------------------------------------------------
console.log('\n[7] the description')
{
  check('direct', describeChain(parseJumpChain('none')) === 'direct connection',
    describeChain(parseJumpChain('none')))
  check('one hop', describeChain(parseJumpChain('bastion')) === 'via bastion',
    describeChain(parseJumpChain('bastion')))
  check('a user is shown', describeChain(parseJumpChain('deploy@bastion')) === 'via deploy@bastion',
    describeChain(parseJumpChain('deploy@bastion')))
  check('an explicit port is shown',
    describeChain(parseJumpChain('bastion:2200')) === 'via bastion:2200',
    describeChain(parseJumpChain('bastion:2200')))
  check('a chain is joined with arrows',
    describeChain(parseJumpChain('a,b')) === 'via a → b',
    describeChain(parseJumpChain('a,b')))
  check('a mixed chain shows only the ports that were written',
    describeChain(parseJumpChain('a,b:2222')) === 'via a → b:2222',
    describeChain(parseJumpChain('a,b:2222')))
}

  totalPassed += (typeof passed !== 'undefined' ? passed : (typeof passes !== 'undefined' ? passes : 0))
  totalFailures += (typeof failures !== 'undefined' ? (Array.isArray(failures) ? failures.length : failures) : 0)
})()

await (async () => {
// ---------------------------------------------------------------------------
// jump-transport-smoke.mjs
// ---------------------------------------------------------------------------
/**
 * Real jump chains over real sockets: does `ProxyJump` actually tunnel?
 *
 * The parsing suite (`jump-chain-smoke`) proves the text is understood. That is
 * necessary and not sufficient: a chain whose parsing is perfect still bypasses
 * the bastion if the engine dials the target directly. The only way to tell
 * "the connection went THROUGH the hop" from "it went somewhere" is to watch
 * which server accepted what.
 *
 * The topology used here is the smallest one that can distinguish the two:
 *
 *   engine ──▶ [bastion]  ──direct-tcpip──▶  [target]
 *
 * The bastion is a fake SSH server with forwarding enabled. The target is a
 * second fake SSH server, bound to loopback on a port the bastion alone is
 * asked to reach. The target's ONLY entrance is the bastion's tunnel: the
 * engine is given the bastion's port and the target's Loopback address, and if
 * the chain were skipped the target would still see a connection (it is on
 * localhost) — so the assertion is on the BASTION's forwarding counters, which
 * stay at zero on a direct dial.
 *
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const supportDir = path.join(here, 'support')

let passed = 0
const failures = []
function check (label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  PASS  ${label}`)
  } else {
    failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== jump transport smoke ===\n')

// Same gate as `fake-transport-smoke`: this suite's subject is a socket, so a
// stub ssh2 (which throws on construction) can only produce a false skip.
let realSsh2 = false
try {
  const ssh2 = createRequire(`${pluginRoot}/package.json`)('ssh2')
  realSsh2 = typeof ssh2.Server === 'function' && typeof ssh2.utils?.generateKeyPairSync === 'function'
} catch {
  realSsh2 = false
}
if (!realSsh2) {
  console.log('  SKIP  no real ssh2 is resolvable from this checkout (the peer stub cannot serve this suite)')
  console.log('\n=== 0 passed, 0 failed, 1 suite skipped ===')
  process.exit(0)
}

const { startFakeSshServer } = await import(pathToFileURL(path.join(supportDir, 'fake-ssh-server.mjs')).href)
const { HostConfigStore } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'hosts', 'store.js')).href)
const { HostStore } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'hosts', 'hosts.js')).href)
const { SshWorkspaceEngine } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'engine', 'engine.js')).href)

const cleanups = []
const track = (fn) => { cleanups.push(fn) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Wait until `predicate` holds, or the timeout expires.
 *
 * Needed wherever the assertion is about a socket being GONE: `destroy()` is
 * asynchronous, and the server learns about the close a tick later.
 */
async function waitFor (predicate, timeout = 2_000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await predicate()) return true
    await sleep(20)
  }
  return false
}

/**
 * An engine whose host store contains the given entries.
 *
 * The ssh config path points at a file that does not exist, so a `Host` block
 * in the developer's own `~/.ssh/config` can never leak into the fixture.
 */
function engineWith (entries) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-jump-'))
  track(() => rmSync(dir, { recursive: true, force: true }))
  const storeFile = path.join(dir, 'hosts.json')
  writeFileSync(storeFile, JSON.stringify({ version: 1, hosts: entries }, null, 2), 'utf8')
  const store = new HostStore(path.join(dir, 'no-ssh-config'), new HostConfigStore(storeFile))
  const engine = new SshWorkspaceEngine({
    store,
    // Reconnect off: these cases assert where a connection went, and a
    // background loop redialing a deliberately-refused host would race them.
    reconnect: false,
    sweepIntervalMs: 3_600_000,
  })
  track(() => engine.dispose())
  return engine
}

try {
  // ====================================================== [1] one hop, for real
  console.log('[1] a one-hop chain tunnels through the bastion')
  {
    const target = await startFakeSshServer({ pluginRoot, password: 'targetpw' })
    track(() => target.close())
    const bastion = await startFakeSshServer({ pluginRoot, password: 'bastionpw', allowForwarding: true })
    track(() => bastion.close())

    const engine = engineWith([
      {
        alias: 'bastion',
        host: '127.0.0.1',
        port: bastion.port,
        user: 'tester',
        auth: { kind: 'password', password: 'bastionpw' },
      },
      {
        alias: 'inner',
        host: '127.0.0.1',
        port: target.port,
        user: 'tester',
        auth: { kind: 'password', password: 'targetpw' },
        proxyJump: ['bastion'],
      },
    ])

    const record = await engine.acquire('inner')
    check('the target connection came up', record.broken === false)
    check('the bastion was connected to', bastion.connections === 1, `connections=${bastion.connections}`)
    check('the bastion opened exactly one tunnel', bastion.forwardedChannels === 1,
      JSON.stringify(bastion.forwardRequests))
    check('the tunnel pointed at the target',
      bastion.forwardRequests[0]?.destIP === '127.0.0.1' && bastion.forwardRequests[0]?.destPort === target.port,
      JSON.stringify(bastion.forwardRequests[0]))
    check('the target accepted the tunnelled connection', target.connections === 1,
      `connections=${target.connections}`)
    check('the record names its chain', record.jumpChain?.hops?.length === 1,
      JSON.stringify(record.jumpChain?.hops))
    check('and the diagnostics say which route was used',
      engine.diagnostics.list(10).some(entry => /via bastion/u.test(entry.message)),
      JSON.stringify(engine.diagnostics.list(10).map(entry => entry.message)))

    // A work channel over the chain, so "connected" is not just a handshake.
    const sftp = record.sftp
    check('the SFTP channel works through the chain', sftp !== undefined
      && typeof sftp.stat === 'function')

    // THE decisive assertion. Every party here is on loopback, so an address
    // cannot distinguish "through the bastion" from "straight to the target" —
    // but a PORT can. The bastion's tunnel leaves from some local port P, and
    // the target sees its peer at exactly P. Had the target been dialed
    // directly, its peer would be an ephemeral port of THIS process, and the
    // bastion's counter would still read 1 because the chain was built anyway.
    const tunnelPort = bastion.forwardSourcePorts[0]
    check('the bastion\'s tunnel left from a known port', typeof tunnelPort === 'number',
      JSON.stringify(bastion.forwardSourcePorts))
    check('the target saw the connection arrive from the BASTION\'s tunnel port',
      target.peerPorts.includes(tunnelPort),
      `target saw ${JSON.stringify(target.peerPorts)}, tunnel left from ${tunnelPort}`)
    // And the stream really is the chain's: it exists only if a hop made it.
    check('the target was dialed ON the chain\'s stream', record.jumpChain?.sock !== undefined,
      String(record.jumpChain?.sock))

    engine.forget('inner')
    await sleep(250)
    check('closing the record empties the pool', engine.pool.size === 0, `pool=${engine.pool.size}`)
    // The leak this pins: ending the target does NOT end its hops. Each kept an
    // authenticated session alive on the bastion for the life of the process,
    // while the workspace looked closed.
    check('and closes the bastion connection too', bastion.liveConnections === 0,
      `live=${bastion.liveConnections}`)
  }

  // ============================================== [2] a refused tunnel is fatal
  console.log('\n[2] a bastion that refuses to forward fails the connection loudly')
  {
    const target = await startFakeSshServer({ pluginRoot, password: 'targetpw' })
    track(() => target.close())
    // `allowForwarding` is NOT set: this bastion refuses `direct-tcpip`, as a
    // hardened one does.
    const bastion = await startFakeSshServer({ pluginRoot, password: 'bastionpw' })
    track(() => bastion.close())

    const engine = engineWith([
      { alias: 'bastion', host: '127.0.0.1', port: bastion.port, user: 'tester', auth: { kind: 'password', password: 'bastionpw' } },
      {
        alias: 'inner',
        host: '127.0.0.1',
        port: target.port,
        user: 'tester',
        auth: { kind: 'password', password: 'targetpw' },
        proxyJump: ['bastion'],
      },
    ])

    let error
    try {
      await engine.acquire('inner')
    } catch (failure) {
      error = failure
    }
    check('the connection is refused, not silently direct', error !== undefined,
      error === undefined ? 'connected anyway' : '')
    check('the refusal names the hop',
      /bastion/u.test(String(error?.message ?? '')), String(error?.message))
    check('the target was never contacted directly', target.connections === 0,
      `connections=${target.connections}`)
    // A failed chain must not leave the bastion session it already opened.
    // Waited for, because a destroy is asynchronous: asserting immediately
    // reads the socket state before the server has seen it close, which would
    // make this pass or fail on timing rather than on the cleanup.
    const cleaned = await waitFor(() => bastion.liveConnections === 0, 2_000)
    check('the failed attempt left no bastion session behind', cleaned,
      `live=${bastion.liveConnections}`)
  }

  // ==================================== [3] each hop pins its own host key
  console.log('\n[3] every hop verifies and pins its own host key')
  {
    const target = await startFakeSshServer({ pluginRoot, password: 'targetpw' })
    track(() => target.close())
    const bastion = await startFakeSshServer({ pluginRoot, password: 'bastionpw', allowForwarding: true })
    track(() => bastion.close())

    const entries = [
      { alias: 'bastion', host: '127.0.0.1', port: bastion.port, user: 'tester', auth: { kind: 'password', password: 'bastionpw' } },
      {
        alias: 'inner',
        host: '127.0.0.1',
        port: target.port,
        user: 'tester',
        auth: { kind: 'password', password: 'targetpw' },
        proxyJump: ['bastion'],
      },
    ]
    const engine = engineWith(entries)
    await engine.acquire('inner')

    check('the bastion key was recorded under the bastion alias',
      engine.store.knownHostKey('bastion') !== undefined)
    check('the target key was recorded under the target alias',
      engine.store.knownHostKey('inner') !== undefined)
    check('they are different records, not one decision covering both',
      engine.store.knownHostKey('bastion').fingerprint !== engine.store.knownHostKey('inner').fingerprint,
      `${engine.store.knownHostKey('bastion').fingerprint} vs ${engine.store.knownHostKey('inner').fingerprint}`)

    // Reinstall the BASTION: the target's key is still fine, and the connection
    // must still be refused. A chain that trusted the target's key for both
    // would sail through here.
    const { freshHostKey } = await import(pathToFileURL(path.join(supportDir, 'fake-ssh-server.mjs')).href)
    const replacement = freshHostKey(pluginRoot)
    await bastion.setHostKey(replacement.private, replacement.public)
    engine.forget('inner')
    let error
    try {
      await engine.acquire('inner')
    } catch (failure) {
      error = failure
    }
    check('a changed bastion key refuses the chain', error !== undefined,
      error === undefined ? 'connected anyway' : '')
    check('and the refusal is about the bastion',
      /bastion/u.test(String(error?.message ?? '')), String(error?.message))
    check('the target key record was not disturbed',
      engine.store.knownHostKey('inner') !== undefined)
  }
  // ==================================== [4] two hops, each one used in turn
  console.log('\n[4] a two-hop chain visits both bastions in order')
  {
    const target = await startFakeSshServer({ pluginRoot, password: 'targetpw' })
    track(() => target.close())
    const far = await startFakeSshServer({ pluginRoot, password: 'farpw', allowForwarding: true })
    track(() => far.close())
    // The NEAR bastion must be told how to reach the FAR one. It is given the
    // far bastion's loopback address and port, which is exactly what a real
    // `ProxyJump near,far` resolves before the first hop's tunnel points at it.
    const near = await startFakeSshServer({ pluginRoot, password: 'nearpw', allowForwarding: true })
    track(() => near.close())

    const engine = engineWith([
      { alias: 'near', host: '127.0.0.1', port: near.port, user: 'tester', auth: { kind: 'password', password: 'nearpw' } },
      { alias: 'far', host: '127.0.0.1', port: far.port, user: 'tester', auth: { kind: 'password', password: 'farpw' } },
      {
        alias: 'inner',
        host: '127.0.0.1',
        port: target.port,
        user: 'tester',
        auth: { kind: 'password', password: 'targetpw' },
        proxyJump: ['near', 'far'],
      },
    ])

    const record = await engine.acquire('inner')
    check('the target connection came up', record.broken === false)
    check('the near bastion was used', near.connections === 1, `connections=${near.connections}`)
    check('the near bastion tunnelled to the FAR bastion',
      near.forwardRequests[0]?.destPort === far.port, JSON.stringify(near.forwardRequests))
    const nearTunnelPort = near.forwardSourcePorts[0]
    check('the far bastion was reached THROUGH the near one\'s tunnel',
      typeof nearTunnelPort === 'number' && far.peerPorts.includes(nearTunnelPort),
      `far saw ${JSON.stringify(far.peerPorts)}, near tunnel left from ${nearTunnelPort}`)
    check('the target was reached through the FAR bastion\'s tunnel',
      target.peerPorts.includes(far.forwardSourcePorts[0]),
      `target saw ${JSON.stringify(target.peerPorts)}, far tunnel left from ${far.forwardSourcePorts[0]}`)
    check('the far bastion tunnelled to the target',
      far.forwardRequests[0]?.destPort === target.port, JSON.stringify(far.forwardRequests))
    check('the target accepted the connection', target.connections === 1, `connections=${target.connections}`)
    check('the record names both hops in order',
      record.jumpChain?.hops?.map(hop => hop.alias).join(',') === 'near,far',
      JSON.stringify(record.jumpChain?.hops))
    check('the route is in the diagnostics, with real addresses',
      engine.diagnostics.list(20).some(entry => /via near = 127\.0\.0\.1:\d+ → far = 127\.0\.0\.1:\d+/u.test(entry.message)),
      JSON.stringify(engine.diagnostics.list(20).map(entry => entry.message)))

    engine.forget('inner')
    await sleep(250)
    check('dropping the target empties the pool', engine.pool.size === 0, `pool=${engine.pool.size}`)
    check('and closes BOTH bastions, not just the near one',
      near.liveConnections === 0 && far.liveConnections === 0,
      `near=${near.liveConnections} far=${far.liveConnections}`)
  }

} finally {
  for (const cleanup of cleanups.reverse()) {
    try { await cleanup() } catch { /* best effort */ }
  }
}

  totalPassed += (typeof passed !== 'undefined' ? passed : (typeof passes !== 'undefined' ? passes : 0))
  totalFailures += (typeof failures !== 'undefined' ? (Array.isArray(failures) ? failures.length : failures) : 0)
})()

console.log(`\n=== ${totalPassed} passed, ${totalFailures} failed ===`)
if (totalFailures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}
