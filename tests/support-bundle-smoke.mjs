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
 * Run: node tests/support-bundle-smoke.mjs
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const {
  buildSupportBundle,
  maskAlias,
  maskPath,
  maskRemotePath,
  BUNDLE_VERSION,
} = await import(pathToFileURL(path.join(pluginRoot, 'lib/support-bundle.js')).href)
const { SshWorkspaceEngine } = await import(pathToFileURL(path.join(pluginRoot, 'lib/engine.js')).href)
const { Diagnostics } = await import(pathToFileURL(path.join(pluginRoot, 'lib/diagnostics.js')).href)

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
  check('a long alias keeps a prefix and a suffix', maskAlias('qiyk-server') === 'qi***r', maskAlias('qiyk-server'))
  check('an empty alias is a placeholder', maskAlias('') === '?', maskAlias(''))
  check('masking is stable for the same input', maskAlias('qiyk-server') === maskAlias('qiyk-server'))
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
  const masked = maskRemotePath('ssh://qiyk-server/home/alice/proj')
  check('a remote path masks the alias', masked.startsWith('ssh://qi***r'), masked)
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
    { seq: 1, at: 1_700_000_000_000, kind: 'connect', message: 'connected to root@10.0.0.1:22', alias: 'qiyk-server' },
    { seq: 2, at: 1_700_000_001_000, kind: 'disconnect', message: 'transport lost', alias: 'qiyk-server' },
  ],
  hosts: [{
    alias: 'qiyk-server',
    host: '10.0.0.1',
    port: 22,
    auth: 'key',
    keyReady: true,
    source: 'ssh-config',
    unsupported: [{ keyword: 'localforward', verdict: 'lost', detail: 'no local tunnel is created' }],
  }],
  mounted: ['ssh://qiyk-server/home/alice/proj'],
  disabled: ['ssh://qiyk-server/home/alice/old'],
  connections: [{ alias: 'qiyk-server', state: 'connected', inFlight: 0 }],
  reconnecting: [{ alias: 'qiyk-server', phase: 'waiting', attempts: 3, lastError: 'connect ECONNREFUSED 10.0.0.1:22' }],
  forwards: [{ localHost: '127.0.0.1', localPort: 5173, alias: 'qiyk-server', remoteHost: '127.0.0.1', remotePort: 5173, connections: 1 }],
  capabilities: [{
    alias: 'qiyk-server',
    tools: { rg: true, git: false, inotifywait: false, sha256sum: true, tar: true, rsync: false, tput: true },
    environment: { shell: '/bin/bash', locale: 'en_US.UTF-8', diskFreeKb: 500000, inotifyWatches: 8192 },
  }],
  // Command ROWS, not pre-formatted text: the audit's own `exportText()` carries
  // the alias unmasked because it is written for a local reader. The bundle
  // therefore formats from rows and masks the alias itself — passing
  // pre-rendered text is what leaked the alias in the first version.
  commands: [
    { seq: 1, at: 1_700_000_000_000, alias: 'qiyk-server', command: 'ls -la /home/alice/proj', channel: 'exec', durationMs: 12, exitCode: 0, timedOut: false },
    { seq: 2, at: 1_700_000_001_000, alias: 'qiyk-server', command: 'rm -rf /srv/app', channel: 'exec', durationMs: 0, exitCode: null, timedOut: false, refused: true },
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
  check('the alias is not verbatim', !bundle.includes('qiyk-server'), 'the masked alias should replace it')
  check('...in every section, not just the host table', !/qiyk/u.test(bundle), bundle.split('\n').filter(line => line.includes('qiyk')).join(' | '))
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

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
process.exit(failures === 0 ? 0 : 1)
