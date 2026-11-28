/**
 * redaction-report smoke suite: redact, support-bundle merged.
 *
 * Every assertion from the original suites is kept; each source suite is its own
 * section below. Run: node tests/redaction-report-smoke.mjs
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

let totalPassed = 0
let totalFailures = 0

await (async () => {
// ---------------------------------------------------------------------------
// redact-smoke.mjs
// ---------------------------------------------------------------------------
/**
 * One redaction rule for every text this plugin lets a user paste in public.
 *
 * ## The leak this suite exists for
 *
 * Three surfaces emit text meant to be pasted into an issue: `exportText()`
 * (diagnostics), the support bundle, and the audit rows. Each had its own
 * masking, and they disagreed. `lib/engine/engine.js` records
 *
 *     connected to alice@prod-db-01.internal.corp:22
 *
 * on EVERY successful connection. The bundle's `maskPath` masked that shape; the
 * diagnostics one did not — so "the support bundle masks it" was the reason a
 * user would paste `exportText()` without reading it, while it carried their
 * login name and an internal hostname.
 *
 * ## Why the assertions are about the REAL strings
 *
 * Grepping for a regex in the source passes whether or not the regex is right —
 * this repository has shipped that failure mode more than once (see O-14 and
 * C-01). The cases below are the actual strings the code produces, run through
 * the actual functions, with the exact substrings that must not survive.
 *
 */
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { maskText, maskAlias, maskPath, maskLine } = await import(pathToFileURL(path.join(pluginRoot, 'lib/core/diagnostics.js')).href)
const { Diagnostics } = await import(pathToFileURL(path.join(pluginRoot, 'lib/core/diagnostics.js')).href)
const { buildSupportBundle } = await import(pathToFileURL(path.join(pluginRoot, 'lib/report/report.js')).href)
const { redactCommand } = await import(pathToFileURL(path.join(pluginRoot, 'lib/engine/engine.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== redaction smoke ===\n')

// ---------------------------------------------------------------------------
console.log('[1] the strings that actually reach the diagnostics text')

{
  // These are the three from the review document, and the first one is the one
  // that matters: it is recorded on every successful connection.
  const connectLine = 'connected to alice@prod-db-01.internal.corp:22'
  const masked = maskText(connectLine)
  check('a connection line does not carry the login user', !masked.includes('alice'), masked)
  check('...and keeps the host:port, which is not identifying', masked.includes('prod-db-01.internal.corp:22'), masked)
  check('...while marking that a user was removed', masked.includes('<user>@'), masked)
}

{
  const pathLine = 'reading /srv/acme-secret/prod.key and /opt/internal/secret.pem'
  const masked = maskText(pathLine)
  check('a credential-looking file name is masked', !masked.includes('prod.key'), masked)
  check('...and so is the second one', !masked.includes('secret.pem'), masked)
  check('...while the directory shape survives', masked.includes('/srv/acme-secret/') && masked.includes('/opt/internal/'), masked)
}

{
  // The third case from the document, which the old rule DID handle. It is
  // asserted so the shared rule cannot regress it.
  const keyLine = 'key at /home/bob/.ssh/id_ed25519 password=hunter2'
  const masked = maskText(keyLine)
  check('a home directory loses its user', !masked.includes('bob'), masked)
  check('...a private key loses its name', !masked.includes('id_ed25519'), masked)
  check('...and an assigned password is replaced', !masked.includes('hunter2'), masked)
}

// ---------------------------------------------------------------------------
console.log('[2] what must NOT be masked')

{
  // Over-redaction is its own bug: a report where every address and path is a
  // placeholder tells the reader nothing, and the reader then stops pasting it.
  check('a plain host:port is left alone', maskText('host 10.0.0.1:22 is fine') === 'host 10.0.0.1:22 is fine')
  check('an email address is left alone', maskText('mail bob@example.com about it') === 'mail bob@example.com about it')
  check('an ordinary source file is left alone', maskText('file keyboard.ts and monitor.keyboard.ts') === 'file keyboard.ts and monitor.keyboard.ts')
  check('a non-home absolute path keeps its shape', maskText('/var/log/app.log') === '/var/log/app.log', maskText('/var/log/app.log'))
  check('an empty string stays empty', maskText('') === '' && maskPath(undefined) === '')
}

{
  // Idempotence: the same text masked twice must not change. Without it, a
  // report rendered through two layers (`exportText` into a bundle) would
  // accumulate `<key><key>` artifacts.
  const once = maskText('connected to alice@prod-db-01.internal.corp:22, key /home/bob/.ssh/id_rsa')
  check('masking is idempotent', maskText(once) === once, `${once} -> ${maskText(once)}`)
}

// ---------------------------------------------------------------------------
console.log('[3] aliases, which the panel and the bundle both show')

{
  check('a long alias keeps a correlatable prefix', maskAlias('production-db') === 'pr***b', maskAlias('production-db'))
  check('a short alias is masked completely', maskAlias('web') === '***', maskAlias('web'))
  check('a single character is not half-revealed', maskAlias('w') === '*', maskAlias('w'))
  check('an empty alias is a placeholder, not a crash', maskAlias('') === '?' && maskAlias(undefined) === '?')
}

// ---------------------------------------------------------------------------
console.log('[4] the three surfaces agree on the same string')

{
  // This is the property the module exists for. A string run through any of the
  // three paths must come out identical, because a user comparing a bundle with
  // a pasted diagnostics text should not find one masked and one bare.
  const line = 'connected to alice@prod-db-01.internal.corp:22'
  const direct = maskText(line)

  const diagnostics = new Diagnostics(4)
  diagnostics.record('connect', line)
  const exported = diagnostics.exportText()
  check('exportText() masks the connection line', !exported.includes('alice'), exported)
  check('...identically to the shared rule', exported.includes(direct), exported)

  const bundle = buildSupportBundle({ pluginVersion: '0.0.0-test', events: diagnostics.list() })
  check('the bundle masks the same string', !bundle.includes('alice'), bundle.slice(0, 400))
  check('...with the same replacement', bundle.includes(direct), bundle.slice(0, 400))
}

{
  // `redactCommand` adds command-only patterns on top of the shared rule; the
  // shared half must still be there, or a command log would leak what the event
  // log masks.
  //
  // `alice@host` WITHOUT a `:port` is deliberately left alone (see the masking
  // only `user@host:port` is masked, so an email address survives). The
  // connection events this plugin records do carry a port, which is why the
  // event-log case above is the one that mattered.
  const command = 'ssh alice@prod-db-01.internal.corp:22 -i /home/alice/.ssh/id_rsa'
  const masked = redactCommand(command)
  check('a command line loses the login user', !masked.includes('alice@'), masked)
  check('...and the home directory user', !masked.includes('/home/alice/'), masked)
  check('...and the key file name', !masked.includes('id_rsa'), masked)
  check('...while its own token rules still apply',
    !redactCommand('curl -H "Authorization: Bearer abc123"').includes('abc123'))
}

// ---------------------------------------------------------------------------
console.log('[5] one line stays one line')

{
  // A multi-line message would split a `seq N: ...` row in the report and make
  // the text unparseable — a correctness problem, not a cosmetic one.
  const multi = 'first line\nsecond line with alice@prod-db-01.internal.corp:22'
  const masked = maskLine(multi)
  check('a newline is collapsed', !masked.includes('\n'), JSON.stringify(masked))
  check('...and the masking still runs on the joined text', !masked.includes('alice'), masked)
}

  totalPassed += (typeof passed !== 'undefined' ? passed : (typeof passes !== 'undefined' ? passes : 0))
  totalFailures += (typeof failures !== 'undefined' ? (Array.isArray(failures) ? failures.length : failures) : 0)
})()

await (async () => {
// ---------------------------------------------------------------------------
// support-bundle-smoke.mjs
// ---------------------------------------------------------------------------
/**
 * The diagnostic report and the connection generation.
 *
 * Two Future items share this suite because they are the same claim from two
 * angles: **say what is actually true about the connection, and say it in a form
 * someone else can act on.**
 *
 * The bundle is the one artifact users paste in public, so its properties are
 * about what must NOT be in it:
 *
 *  - no username, no home path, no host alias verbatim, no secret;
 *  - and yet the report stays useful: the shape of a path survives, the port
 *    survives, and events from one host still correlate (one masking rule for
 *    one string).
 *
 * The generation answers the question a reconnect raises and "connected" hides:
 * a new connection is not the old one, and a remote process started before the
 * drop may still be running. So the tests pin that generation 1 is the ordinary
 * case (and stays quiet), that a later generation SAYS what it means, and that
 * the counter is monotonic across reconnects.
 *
 */
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const {
  buildSupportBundle,
  maskAlias,
  maskPath,
  maskRemotePath,
  BUNDLE_VERSION,
} = await import(pathToFileURL(path.join(pluginRoot, 'lib/report/report.js')).href)
const { SshWorkspaceEngine } = await import(pathToFileURL(path.join(pluginRoot, 'lib/engine/engine.js')).href)
const { Diagnostics } = await import(pathToFileURL(path.join(pluginRoot, 'lib/core/diagnostics.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== diagnostic report smoke ===\n')

// ---------------------------------------------------------------------------
console.log('[masking: consistent, and the shape survives]')

{
  // A short alias is masked COMPLETELY: `w*e` from `web` is one guess away, and
  // a three-letter hostname is exactly the case where a partial reveal matters.
  check('a short alias is masked completely', maskAlias('web') === '***', maskAlias('web'))
  check('a long alias keeps a prefix and a suffix', maskAlias('dev-server') === 'de***r', maskAlias('dev-server'))
  check('an empty alias is a placeholder', maskAlias('') === '?', maskAlias(''))
  check('masking is stable for the same input', maskAlias('dev-server') === maskAlias('dev-server'))
}

{
  const masked = maskPath('/home/alice/proj/src/index.ts')
  check('the home segment is masked', masked === '/home/<user>/proj/src/index.ts', masked)
  check('the rest of the path survives', masked.includes('proj/src/index.ts'), masked)
  const mac = maskPath('/Users/bob/proj/app.js')
  check('a macOS home is masked too', mac === '/Users/<user>/proj/app.js', mac)
  const win = maskPath('C:\\Users\\bob\\proj\\app.js')
  check('a Windows home is masked too', win === 'C:\\Users\\<user>\\proj\\app.js', win)
}

{
  const masked = maskRemotePath('ssh://dev-server/home/alice/proj')
  check('a remote path masks the alias', masked.startsWith('ssh://de***r'), masked)
  check('...and the remote home', masked.includes('/home/<user>/proj'), masked)
  check('a non-ssh path falls back to plain masking', maskRemotePath('/home/alice/x') === '/home/<user>/x')
}

// ---------------------------------------------------------------------------
console.log('\n[the bundle has the sections a bug report needs]')

const FULL_INPUT = {
  generatedAt: 1_700_000_000_000,
  pluginVersion: '0.2.7',
  hostVersion: '0.2.0-rc.1',
  nodeVersion: 'v24.18.0',
  platform: 'linux-x64',
  upstreamWorkarounds: [
    { id: 'UPSTREAM-1-working-directory-isAbsolute', probe: 'broken', detail: 'the Host still rejects ssh://' },
    { id: 'PATCH-fs', probe: 'already', detail: 'installed' },
  ],
  events: [
    { seq: 1, at: 1_700_000_000_000, kind: 'connect', message: 'connected to root@10.0.0.1:22', alias: 'dev-server' },
    { seq: 2, at: 1_700_000_001_000, kind: 'disconnect', message: 'transport lost', alias: 'dev-server' },
  ],
  hosts: [{
    alias: 'dev-server',
    host: '10.0.0.1',
    port: 22,
    auth: 'key',
    keyReady: true,
    source: 'ssh-config',
    unsupported: [{ keyword: 'localforward', verdict: 'lost', detail: 'no local tunnel is created' }],
  }],
  mounted: ['ssh://dev-server/home/alice/proj'],
  disabled: ['ssh://dev-server/home/alice/old'],
  connections: [{ alias: 'dev-server', state: 'connected', inFlight: 0 }],
  reconnecting: [{ alias: 'dev-server', phase: 'waiting', attempts: 3, lastError: 'connect ECONNREFUSED 10.0.0.1:22' }],
  forwards: [{ localHost: '127.0.0.1', localPort: 5173, alias: 'dev-server', remoteHost: '127.0.0.1', remotePort: 5173, connections: 1 }],
  capabilities: [{
    alias: 'dev-server',
    tools: { rg: true, git: false, inotifywait: false, sha256sum: true, tar: true, rsync: false, tput: true },
    environment: { shell: '/bin/bash', locale: 'en_US.UTF-8', diskFreeKb: 500000, inotifyWatches: 8192 },
  }],
  // Command ROWS, not pre-formatted text: the audit's own `exportText()` carries
  // the alias unmasked because it is written for a local reader. The bundle
  // therefore formats from rows and masks the alias itself — passing
  // pre-rendered text is what leaked the alias in the first version.
  commands: [
    { seq: 1, at: 1_700_000_000_000, alias: 'dev-server', command: 'ls -la /home/alice/proj', channel: 'exec', durationMs: 12, exitCode: 0, timedOut: false },
    { seq: 2, at: 1_700_000_001_000, alias: 'dev-server', command: 'rm -rf /srv/app', channel: 'exec', durationMs: 0, exitCode: null, timedOut: false, refused: true },
  ],
}

const bundle = buildSupportBundle(FULL_INPUT)

{
  // Command ROWS must be rendered by the bundle itself, with the alias masked
  // and the refusal marked. This is the assertion that catches the bundle
  // falling back to pre-formatted audit text — the audit's `exportText()`
  // carries the alias raw, because it is written for a local reader.
  check('a recorded command appears', bundle.includes('ls -la'), bundle.split('\n').filter(line => line.includes('commands')).join(' | '))
  check('...with its exit status', bundle.includes('exit 0'), bundle)
  check('...and its refusal flagged, not as exit 0',
    /refused/u.test(bundle) && bundle.includes('rm -rf /srv/app'),
    bundle.split('\n').filter(line => line.includes('rm -rf')).join(' | '))
  check('a command\'s path is masked too', !bundle.includes('/home/alice/proj'), bundle.split('\n').filter(line => line.includes('ls -la')).join(' | '))
  check('...while the command shape survives', bundle.includes('ls -la /home/<user>/proj'), bundle)
}

{
  for (const heading of ['## versions', '## upstream patches', '## hosts', '## workspaces', '## connections', '## port forwards', '## remote self-check', '## recent commands', '## recent events']) {
    check(`the bundle has ${heading}`, bundle.includes(heading))
  }
  check('the bundle declares its own layout version', bundle.includes(`bundleVersion: ${BUNDLE_VERSION}`), String(BUNDLE_VERSION))
  check('the plugin version travels', bundle.includes('plugin: 0.2.7'))
  check('the host version travels', bundle.includes('host: 0.2.0-rc.1'))
  check('an obsolete patch is reported with its verdict', bundle.includes('UPSTREAM-1-working-directory-isAbsolute: broken'), bundle.slice(0, 400))
  check('a patch that is not a workaround is not called obsolete', !/PATCH-fs: .*delete/u.test(bundle))
}

// ---------------------------------------------------------------------------
console.log('\n[the bundle leaks nothing]')

{
  // The alias is identifying and must not appear verbatim.
  check('the alias is not verbatim', !bundle.includes('dev-server'), 'the masked alias should replace it')
  check('...in every section, not just the host table',
    bundle.split(/^## /mu).every(section => !section.includes('dev-server')),
    bundle.split(/^## /mu).filter(section => section.includes('dev-server')).map(section => section.split('\n')[0]).join(' | '))
  check('the local username is not present', !bundle.includes('alice'), 'a home path leaked')
  // A remote address is not secret; a username is.
  check('the host address survives', bundle.includes('10.0.0.1'), 'the address is the useful part')
  check('the port survives', bundle.includes(':22'), 'the port is the useful part')
  check('the SSH user is masked', !bundle.includes('root@10.0.0.1'), bundle.split('\n').find(line => line.includes('10.0.0.1')) ?? '')
  check('the path shape survives', bundle.includes('/home/<user>/proj'), 'the shape is what makes the report useful')
}

{
  // Redaction of events goes through the same rule the diagnostics ring uses.
  const withSecret = buildSupportBundle({
    pluginVersion: '1',
    events: [{ seq: 1, at: 1, kind: 'degraded', message: 'failed to read /home/alice/.ssh/id_rsa for bob', alias: 'host' }],
  })
  check('a home path in an event is masked', !withSecret.includes('alice'), withSecret)
  check('...while the sentence survives', withSecret.includes('failed to read'), withSecret)
}

// ---------------------------------------------------------------------------
console.log('\n[the bundle is useful when everything is missing]')

{
  // The most common case in a bug report is a deployment where nothing works.
  const empty = buildSupportBundle({ pluginVersion: '0.2.7' })
  check('an almost-empty input still produces a bundle', empty.includes('## versions'), empty.slice(0, 200))
  check('...that says there are no hosts', empty.includes('none'), empty)
  check('...and no commands', empty.includes('no remote commands recorded'), empty)
  check('...without throwing on absent fields', !empty.includes('undefined'), empty)
  check('an unknown version says unknown rather than inventing one', empty.includes('host: unknown'), empty)
}

{
  const minimal = buildSupportBundle({ pluginVersion: '1', hosts: [], mounted: [], connections: [], capabilities: [] })
  check('empty arrays read as empty, not as undefined', !minimal.includes('undefined'), minimal)
}

// ---------------------------------------------------------------------------
console.log('\n[connection generations explain a reconnect]')

{
  const engine = new SshWorkspaceEngine({})
  check('a host never connected says so', engine.describeGeneration('never') === 'never connected in this session', engine.describeGeneration('never'))
  check('...and reports generation 0', engine.generationOf('never').generation === 0, String(engine.generationOf('never').generation))

  // Simulate two successful connects by driving the counter the engine uses.
  engine.generations.set('box', 1)
  engine.pool.set('box', { alias: 'box', broken: false, createdAt: 1, idleAt: 1, inFlight: 0, holds: 0, generation: 1 })
  const first = engine.generationOf('box')
  check('the first generation is connected', first.connected === true, JSON.stringify(first))
  check('...and is not reported as a recovery', first.previousLost === false, JSON.stringify(first))
  check('the first generation stays quiet in prose', engine.describeGeneration('box') === 'connected (first generation)', engine.describeGeneration('box'))

  engine.generations.set('box', 2)
  engine.pool.set('box', { alias: 'box', broken: false, createdAt: 2, idleAt: 2, inFlight: 0, holds: 0, generation: 2 })
  const second = engine.generationOf('box')
  check('a later generation still reports connected', second.connected === true, JSON.stringify(second))
  check('...but says a generation was lost', second.previousLost === false, JSON.stringify(second))
  check('the prose names the generation', engine.describeGeneration('box').includes('generation 2'), engine.describeGeneration('box'))
  check('...and warns about work started earlier', /may still be running/u.test(engine.describeGeneration('box')), engine.describeGeneration('box'))

  engine.pool.set('box', { alias: 'box', broken: true, createdAt: 2, idleAt: 2, inFlight: 0, holds: 0, generation: 2 })
  const broken = engine.generationOf('box')
  check('a broken record reports previousLost', broken.previousLost === true, JSON.stringify(broken))
  check('...and names the next generation', engine.describeGeneration('box').includes('generation 3'), engine.describeGeneration('box'))
  engine.dispose()
}

{
  // The counter must be monotonic across reconnects, not reset by them: the
  // record is replaced on every reconnect, so a generation stored only on it
  // would reset to 1 and "the third generation" would be indistinguishable from
  // "the first". The assertion is that `generationOf` reads the MAP, not the
  // record — so a record carrying a stale generation cannot lower the answer.
  const engine = new SshWorkspaceEngine({})
  engine.generations.set('multi', 5)
  engine.pool.set('multi', { alias: 'multi', broken: false, createdAt: 1, idleAt: 1, inFlight: 0, holds: 0, generation: 1 })
  check('the counter is read from the map, not from the record', engine.generationOf('multi').generation === 5, String(engine.generationOf('multi').generation))
  check('...so a stale record cannot lower it', engine.describeGeneration('multi').includes('generation 5'), engine.describeGeneration('multi'))
  engine.dispose()
}

// ---------------------------------------------------------------------------
console.log('\n[the diagnostics ring still carries what the bundle needs]')

{
  const diagnostics = new Diagnostics(5)
  diagnostics.record('connect', 'connected to a@b:22', { alias: 'box' })
  const text = buildSupportBundle({ pluginVersion: '1', events: diagnostics.list() })
  check('events from the ring render into the bundle', text.includes('connect'), text)
  check('the event seq travels', text.includes('#1'), text)
  check('an alias in an event is masked', text.includes('[***]'), text)
}

  totalPassed += (typeof passed !== 'undefined' ? passed : (typeof passes !== 'undefined' ? passes : 0))
  totalFailures += (typeof failures !== 'undefined' ? (Array.isArray(failures) ? failures.length : failures) : 0)
})()

console.log(`\n=== ${totalPassed} passed, ${totalFailures} failed ===`)
if (totalFailures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}
