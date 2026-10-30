/**
 * The bounded event log behind the status surfaces.
 *
 * Two properties matter and neither is obvious from reading the class:
 *
 *  - **bounded**: a session left open for days reconnects many times, and a log
 *    that grows per event is a slow leak in the Host process. The oldest
 *    entries must fall off, and the NEWEST must survive — an off-by-one that
 *    dropped the newest would hide the event that just happened.
 *  - **infallible**: every call site is already inside a failure path, so a
 *    record that could throw would turn "connection dropped" into "connection
 *    dropped and the diagnostic threw".
 *
 * The suite also pins the reason this module exists at all: `ctx.logger.debug`
 * is not observable in this Host, so removing this log in favour of a `debug()`
 * call would remove the only reachable history rather than relocate it.
 *
 * Run: node tests/diagnostics-smoke.mjs
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { Diagnostics, CAPACITY, KINDS, SCHEMA_VERSION } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'diagnostics.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== diagnostics smoke ===\n')

// ------------------------------------------------------------- basic recording
console.log('[entries are recorded and read back]')

const log = new Diagnostics()
check('a fresh log is empty', log.list().length === 0, JSON.stringify(log.list()))

log.record(KINDS.connect, 'connected to user@host:22', { alias: 'box' })
check('one entry after one record', log.list().length === 1, String(log.list().length))

const [entry] = log.list()
check('the entry carries its kind', entry.kind === 'connect', entry.kind)
check('the entry carries its message', entry.message === 'connected to user@host:22', entry.message)
check('the entry carries the alias when given one', entry.alias === 'box', String(entry.alias))
check('the entry carries a millisecond timestamp', Number.isInteger(entry.at) && entry.at > 0, String(entry.at))

log.record(KINDS.connect, 'no alias here')
check('an entry without an alias omits the field entirely', log.list()[1].alias === undefined, String(log.list()[1].alias))

// ---------------------------------------------------------------- bounded size
console.log('\n[bounded: the newest survive, the oldest fall off]')

const small = new Diagnostics(3)
for (const n of [1, 2, 3, 4, 5]) small.record(KINDS.connect, `event ${n}`)
const kept = small.list()
check('capacity is honoured', kept.length === 3, String(kept.length))
check('the oldest entries are the ones dropped', kept[0].message === 'event 3', kept[0].message)
check('the newest entry is retained', kept[kept.length - 1].message === 'event 5', kept[kept.length - 1].message)
check(
  'a log of exactly capacity does not drop anything',
  (() => {
    const exact = new Diagnostics(2)
    exact.record(KINDS.connect, 'a')
    exact.record(KINDS.connect, 'b')
    return exact.list().length === 2 && exact.list()[0].message === 'a'
  })()
)
check('the default capacity is a positive integer', Number.isInteger(CAPACITY) && CAPACITY > 0, String(CAPACITY))

// ------------------------------------------------------------------- read API
console.log('\n[reading cannot corrupt the log]')

const guard = new Diagnostics()
guard.record(KINDS.connect, 'original')
const copy = guard.list()
copy[0].message = 'mutated by caller'
check('list() hands out copies, so a caller cannot rewrite history', guard.list()[0].message === 'original', guard.list()[0].message)
check('list(limit) keeps the newest N', (() => {
  const tail = new Diagnostics()
  for (const n of [1, 2, 3, 4]) tail.record(KINDS.connect, `e${n}`)
  const lastTwo = tail.list(2)
  return lastTwo.length === 2 && lastTwo[0].message === 'e3' && lastTwo[1].message === 'e4'
})())
check('clear() empties the log', (() => { guard.clear(); return guard.list().length === 0 })())

// ------------------------------------------------------------------ infallible
console.log('\n[recording never throws]')

check('an unusable message argument does not throw', (() => {
  const risky = new Diagnostics()
  const circular = {}
  circular.self = circular
  try {
    risky.record(KINDS.connect, circular)
    risky.record(KINDS.connect, Symbol('weird'))
    risky.record(undefined, undefined, { alias: 42 })
    return true
  } catch { return false }
})())
check('a bad capacity falls back to a usable log', (() => {
  for (const bad of [0, -5, 1.5, 'nope', null, undefined]) {
    const log = new Diagnostics(bad)
    if (!(Number.isInteger(log.capacity) && log.capacity > 0)) return false
  }
  return true
})())

// ------------------------------------------------------------------- the kinds
console.log('\n[the kind vocabulary is closed]')

check('every advertised kind is a non-empty string', Object.values(KINDS).every(kind => typeof kind === 'string' && kind !== ''))
check(
  'the kinds cover connecting, dropping, degrading and forwarding',
  ['connect', 'disconnect', 'reconnect', 'degraded', 'forward'].every(kind => Object.values(KINDS).includes(kind)),
  JSON.stringify(Object.values(KINDS))
)
check(
  'an upstream workaround verdict is its own kind, not squeezed into `degraded`',
  KINDS.upstream === 'upstream', String(KINDS.upstream)
)

// --------------------------------------------- why a debug() call is not enough
console.log('\n[the Host drops logger.debug, so this log is the reachable one]')

// Guard the reasoning, not the mechanism: if a future Host starts exporting
// debug, this assertion telling us to reconsider is better than silently
// keeping a redundant surface. It is pinned against the SOURCE of the engine,
// which must record through this module rather than assert observability.
const engineSource = readFileSync(path.join(pluginRoot, 'lib', 'engine.js'), 'utf8')
check(
  'the engine records connection events into this log',
  /diagnostics\.record\(KINDS\.connect/.test(engineSource)
)
check(
  'the engine does not rely on logger.debug for connection events',
  !/logger\?\.debug\?\.\([^)]*connected/.test(engineSource)
)
// Every kind in the vocabulary must have a real producer, or the constant is
// advertising an event that never happens.
check(
  'every kind in the vocabulary is actually recorded somewhere',
  (() => {
    const sources = ['engine.js', 'remote-fs.js', 'forward.js']
      .map(file => readFileSync(path.join(pluginRoot, 'lib', file), 'utf8'))
      .join('\n')
    return Object.entries(KINDS).every(([name]) => new RegExp(`KINDS\\.${name}\\b`).test(sources))
  })()
)

// -------------------------------------- the upstream verdict reaches a surface
// The whole reason `KINDS.upstream` exists: `patch-projection.js` used to report
// its verdict with `logger.info`, which in this Host lands in a ring buffer
// nothing reads. Asserting the module's return value alone would NOT catch that
// regression coming back — the value was always correct, it just went nowhere.
// So this drives the real engine and the real status feed end to end.
console.log('\n[an obsolete workaround reaches the status surfaces]')

{
  const { SshWorkspaceEngine } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'engine.js')).href)
  const engine = new SshWorkspaceEngine({})

  check('a fresh engine reports no workaround verdicts', engine.upstreamWorkarounds.length === 0)

  engine.noteUpstreamWorkaround('UPSTREAM-9-test-fixed', { probe: 'fixed', detail: 'the Host schema accepts it' })
  check('a fixed verdict is retained on the engine', engine.upstreamWorkarounds.length === 1)
  check('...with its id, probe and detail intact',
    engine.upstreamWorkarounds[0].id === 'UPSTREAM-9-test-fixed' &&
    engine.upstreamWorkarounds[0].probe === 'fixed' &&
    engine.upstreamWorkarounds[0].detail === 'the Host schema accepts it')
  check('...and is recorded as an event, so it is visible chronologically too',
    engine.diagnostics.list().some(entry => entry.kind === 'upstream' && /UPSTREAM-9-test-fixed/u.test(entry.message)),
    JSON.stringify(engine.diagnostics.list()))
  check('...and the event says DELETE, not merely "changed"',
    /delete/u.test(engine.diagnostics.list().find(entry => entry.kind === 'upstream')?.message ?? ''))

  engine.noteUpstreamWorkaround('UPSTREAM-8-test-unprobeable', { probe: 'unprobeable', detail: 'registrations is not a Map' })
  check('an unprobeable verdict is retained and warned about, not swallowed',
    engine.upstreamWorkarounds.some(entry => entry.id === 'UPSTREAM-8-test-unprobeable' && entry.probe === 'unprobeable') &&
    engine.diagnostics.list().some(entry => /cannot judge/u.test(entry.message)),
    JSON.stringify(engine.diagnostics.list().map(entry => entry.message)))

  const before = engine.diagnostics.list().length
  engine.noteUpstreamWorkaround('UPSTREAM-7-test-broken', { probe: 'broken', detail: 'still rejects ssh://' })
  engine.noteUpstreamWorkaround('UPSTREAM-7-test-pending', { probe: 'pending', detail: 'not registered yet' })
  check('the normal states are retained but do NOT flood the bounded log',
    engine.upstreamWorkarounds.length === 4 && engine.diagnostics.list().length === before,
    `${engine.diagnostics.list().length} events, ${engine.upstreamWorkarounds.length} verdicts`)
  check('a verdict never carries a log-only shape (no functions, no undefined)',
    engine.upstreamWorkarounds.every(entry =>
      typeof entry.id === 'string' && typeof entry.probe === 'string' &&
      typeof entry.detail === 'string' && Number.isInteger(entry.at)))

  engine.dispose()
}

// The status tool must SERVE the field, not just compute it. Asserted against
// source because the tool needs a live ctx.fs to construct; the shape check
// above already proved the engine side of the join.
{
  const toolsSource = readFileSync(path.join(pluginRoot, 'lib', 'tools.js'), 'utf8')
  const routesSource = readFileSync(path.join(pluginRoot, 'lib', 'routes.js'), 'utf8')
  check('ssh_workspace_status returns the verdicts', /upstreamWorkarounds: \(engine\.upstreamWorkarounds/u.test(toolsSource))
  check('the panel status route returns them too', /upstreamWorkarounds: engine\.upstreamWorkarounds/u.test(routesSource))
  check('the status tool surfaces an obsolete patch in its rendered text', /OBSOLETE/u.test(toolsSource))
  check('...and the unprobeable state as well',
    /workaround\.probe === 'unprobeable'/u.test(toolsSource), 'no unprobeable branch in the renderer')
  // The join itself: a verdict computed but never handed to the engine is
  // exactly the regression this whole change exists to prevent (it was
  // `logger.info` before). Nothing below the wiring would notice it going away.
  const indexSource = readFileSync(path.join(pluginRoot, 'lib', 'index.js'), 'utf8')
  check('lib/index.js hands the projection verdict to the engine',
    /engine\.noteUpstreamWorkaround\(installed\.id/u.test(indexSource),
    'installProjectionRelaxation() returns probe/detail but nothing records them')
}


console.log('\n[seq and the shareable report]')

// An outage is read as a sequence, and the ring drops its oldest entries. A
// position-in-array is therefore useless for ordering: the numbers must keep
// increasing across evictions.
{
  const log = new Diagnostics(3)
  for (let index = 0; index < 6; index += 1) log.record(KINDS.connect, `event ${index}`)
  const kept = log.list()
  check('the ring keeps only its capacity', kept.length === 3, String(kept.length))
  check('seq keeps increasing after eviction',
    kept.map(entry => entry.seq).join(',') === '4,5,6', JSON.stringify(kept.map(entry => entry.seq)))
  check('the newest entry has the highest seq',
    kept.at(-1).seq === 6, String(kept.at(-1).seq))
  check('a gap is visible: the report says how many were recorded',
    log.exportText().includes('entries: 3 of 6 recorded'), log.exportText().split('\n')[1])
}

console.log('\n[a shared report must not leak secrets]')

{
  const log = new Diagnostics(10)
  log.record(KINDS.degraded, 'could not read /home/alice/.ssh/id_ed25519')
  log.record(KINDS.connect, 'password=hunter2 rejected')
  log.record(KINDS.connect, 'could not write /Users/alice/project')
  log.record(KINDS.connect, 'ok', { alias: 'alice-laptop' })
  const text = log.exportText()

  check('the report names its schema version', text.includes(`schemaVersion: ${SCHEMA_VERSION}`), text.split('\n')[0])
  check('the local username is masked', !text.includes('alice/.ssh'), text)
  check('the private key path is masked', !/id_ed25519/u.test(text), text)
  check('a password value is masked', !text.includes('hunter2'), text)
  // "alice-laptop" → "al***p": enough to correlate two events from the same
  // host, not enough to identify the machine.
  check('the alias is shortened, not dropped',
    /al\*\*\*p/u.test(text), text)
  check('the redaction is on by default', !text.includes('hunter2') && text.includes('<redacted>'), text)
}

console.log('\n[the report is plain text, not a serialised object]')

{
  const log = new Diagnostics(5)
  log.record(KINDS.connect, 'connected to box.example:22')
  const text = log.exportText()
  check('the report has no JSON braces', !text.trimStart().startsWith('{') && !text.includes('":'), text)
  check('every event is numbered', text.includes('#1'), text)
  check('the timestamp is ISO, so two machines can be compared',
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/u.test(text), text)
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
process.exit(failures === 0 ? 0 : 1)
