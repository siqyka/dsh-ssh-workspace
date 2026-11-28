/**
 * Host hard-disable (the power switch).
 *
 * The rule the feature is built on: "switched off" must mean "does nothing
 * now", not "the row is greyed". That makes the interesting part an
 * ORCHESTRATION — every resource held for the alias, in an order that cannot
 * leave a half-open host behind — so this suite drives the real HostDisabler
 * with fake managers and checks what actually got called, in what order.
 *
 * The transport-level gate (engine.execute refusing while disabled) lives in
 * the engine and is asserted here at the source level: the engine imports the
 * DSH peer packages, so importing it would skip exactly where the suite is most
 * useful. The client half is likewise source-level: the suite that compiles
 * components (render.mjs) is a different tool.
 *
 * Run: node tests/host-disable-smoke.mjs
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { HostConfigStore } from '../lib/hosts/store.js'
import { HostDisabler } from '../lib/hosts/disable.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')

let passed = 0
const failures = []
function check (name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

function readSource (relative) {
  return readFileSync(path.join(pluginRoot, relative), 'utf8')
}

console.log('\n=== host disable smoke ===\n')

// ---------------------------------------------------------------------------
// [store] the flag is opt-out, and only store entries carry it
// ---------------------------------------------------------------------------
console.log('[store]')
const scratch = mkdtempSync(path.join(os.tmpdir(), 'sshwsp-hostdisable-'))
try {
  const storePath = path.join(scratch, 'dsh-ssh.json')
  const store = new HostConfigStore(storePath)
  store.save([
    { alias: 'alpha', host: 'alpha.example.com', user: 'me', port: 22, auth: 'agent' },
    { alias: 'beta', host: 'beta.example.com', user: 'me', port: 22, auth: 'agent' },
  ])

  check('a host without the flag reads as enabled', store.isHostEnabled('alpha') === true)
  check('an unknown alias reads as enabled too (nothing to disable)', store.isHostEnabled('nope') === true)

  check('switching off writes the flag', store.setHostEnabled('alpha', false) === false && store.isHostEnabled('alpha') === false)
  check('...and the row still lists the host (it is disabled, not deleted)',
    store.find('alpha') !== undefined)
  check('a second host is untouched', store.isHostEnabled('beta') === true)

  check('switching back on removes the flag', store.setHostEnabled('alpha', true) === true && store.isHostEnabled('alpha') === true)
  const written = JSON.parse(readFileSync(storePath, 'utf8'))
  check('the enabled entry keeps no disabled key', written.hosts.find(row => row.alias === 'alpha')?.enabled === undefined,
    JSON.stringify(written.hosts[0]))

  let refused = false
  try { store.setHostEnabled('ghost', false) } catch { refused = true }
  check('a host the store does not own cannot be switched', refused)
  check('...and the refusal is a store error, not a silent no-op',
    (() => { try { store.setHostEnabled('ghost', false) } catch (error) { return /not in the editable store/u.test(String(error.message)) } return false })())
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// [orchestration] one switch-off tears down every resource the host holds
// ---------------------------------------------------------------------------
console.log('[orchestration]')

/** A HostDisabler wired to recording fakes. */
function harness (patch = {}) {
  const calls = []
  const engine = {
    pool: { has: (alias) => alias === 'alpha' },
    hostAborts: new Map([['alpha', new Set([{}, {}])]]),
    setHostDisabled: (alias, on) => calls.push(`gate:${alias}:${String(on)}`),
    abortHost: (alias) => { calls.push(`abort:${alias}`); return 2 },
    forget: (alias) => calls.push(`forget:${alias}`),
    acquire: () => calls.push('acquire'),
  }
  const shells = { list: () => [{ alias: 'alpha' }], close: (alias) => { calls.push(`shells:${alias}`); return 1 } }
  const forwards = { list: () => [{ alias: 'alpha' }], closeForAlias: (alias) => { calls.push(`forward:${alias}`); return 1 } }
  const savedForwards = { list: () => [{ alias: 'alpha' }], closeAlias: (alias) => { calls.push(`saved:${alias}`); return 1 } }
  const reverseForwards = { list: () => [], closeForAlias: (alias) => { calls.push(`reverse:${alias}`); return 0 } }
  const watches = { targets: () => [{ alias: 'alpha' }, { alias: 'beta' }], closeForAlias: (alias) => { calls.push(`watch:${alias}`); return 1 } }
  const terminals = { handles: new Set([{ alias: 'alpha' }, { alias: 'beta' }]), closeForAlias: (alias) => { calls.push(`terminal:${alias}`); return 1 } }
  const store = {
    find: (alias) => (alias === 'alpha' ? { alias: 'alpha' } : undefined),
    setHostEnabled: (alias, on) => calls.push(`persist:${alias}:${String(on)}`),
  }
  const disabler = new HostDisabler({
    engine,
    shells,
    forwards,
    savedForwards,
    reverseForwards,
    watches,
    terminals,
    store,
    ...patch,
  })
  return { disabler, calls, engine, shells, forwards, savedForwards, reverseForwards, watches, terminals, store }
}

{
  const { disabler, calls } = harness()
  const counts = disabler.counts('alpha')
  check('counts reads the live managers for one alias',
    counts.connections === 1 && counts.inFlight === 2 && counts.shells === 1 &&
      counts.forwards === 1 && counts.savedForwards === 1 && counts.reverseForwards === 0 &&
      counts.watches === 1 && counts.terminals === 1,
    JSON.stringify(counts))
  check('counts ignores another alias', disabler.counts('beta').shells === 0)

  const report = disabler.disable('alpha')
  check('the report names what was interrupted', report.before.shells === 1 && report.before.inFlight === 2,
    JSON.stringify(report.before))
  check('the persisted intent comes first', calls[0] === 'persist:alpha:false', calls.join(' '))
  check('the gate closes before any teardown', calls[1] === 'gate:alpha:true', calls.join(' '))
  check('in-flight commands are aborted', calls.includes('abort:alpha'))
  check('persistent shells close', calls.includes('shells:alpha'))
  check('the saved tunnel closes through its own manager', calls.includes('saved:alpha') && !calls.includes('forward:alpha'),
    calls.join(' '))
  check('reverse tunnels close', calls.includes('reverse:alpha'))
  check('change watchers stop', calls.includes('watch:alpha'))
  check('remote terminals terminate', calls.includes('terminal:alpha'))
  check('the pooled connection is dropped last', calls[calls.length - 1] === 'forget:alpha', calls.join(' '))
  check('the report counts what actually closed',
    report.enabled === false && report.closed.aborted === 2 && report.closed.shells === 1 &&
      report.closed.watches === 1 && report.closed.terminals === 1 && report.closed.connection === true,
    JSON.stringify(report.closed))
}

{
  // No saved-tunnel manager: the live forward manager must take over rather than
  // leaving the listener behind.
  const { disabler, calls } = harness({ savedForwards: undefined })
  disabler.disable('alpha')
  check('without saved tunnels the live forward manager closes them',
    calls.includes('forward:alpha'), calls.join(' '))
}

{
  // Switching ON is a permission change, not a connection: it must never dial.
  const { disabler, calls } = harness()
  const report = disabler.enable('alpha')
  check('switching on persists and re-opens the gate', report.enabled === true && calls.includes('persist:alpha:true') && calls.includes('gate:alpha:false'),
    calls.join(' '))
  check('...and never dials the host', !calls.includes('acquire') && !calls.includes('forget:alpha'), calls.join(' '))
}

{
  // A hostile/broken manager must not stop the rest of the teardown, and must not
  // throw out of the switch: the user asked for the host to be off.
  const broken = harness()
  broken.shells.close = () => { throw new Error('pty is wedged') }
  let threw = false
  let report
  try { report = broken.disabler.disable('alpha') } catch { threw = true }
  check('a wedged manager does not abort the switch', threw === false)
  check('...and the rest of the teardown still runs', report !== undefined && broken.calls.includes('forget:alpha'),
    broken.calls.join(' '))
}

{
  const { disabler } = harness()
  check('only a store entry is switchable', disabler.isStoreHost('alpha') === true && disabler.isStoreHost('beta') === false)
}

// ---------------------------------------------------------------------------
// [route] the switch has one writer, and a switched-off host is refused
// ---------------------------------------------------------------------------
console.log('[route]')
{
  const routes = readSource('lib/routes/routes.js')
  const hosts = readSource('lib/routes/hosts.js')
  const engine = readSource('lib/engine/engine.js')

  check('the toggle route exists in the route table', /hostToggle:\s*'\/api\/dsh-ssh-workspace\/hosts\/toggle'/u.test(routes))
  check('every host row carries its live resource counts', /resources:\s*disabler\?\.counts\?\.\(row\.alias\)/u.test(hosts))
  check('the route refuses a ~/.ssh/config host instead of pretending', /comes from ~\/\.ssh\/config/u.test(hosts))
  check('the route reports a deployment without the switch', /disabled in this deployment/u.test(hosts))
  check('/hosts/test refuses a switched-off host',
    /isHostDisabled\?\.\(alias\)\s*===\s*true/u.test(hosts) && /switch it on before testing it/u.test(hosts))
  check('/hosts/reconnect refuses a switched-off host', /switch it on before reconnecting/u.test(hosts))
  check('the gate lives in the engine, not in the routes', /assertHostEnabled/u.test(engine) && /HOST_DISABLED/u.test(engine))
  check('the gate is checked on acquire', /assertHostEnabled\((\w+)\)/u.test(engine))
  check('the gate refuses with the alias named', /is switched off; switch it on before using it/u.test(engine))
}

// ---------------------------------------------------------------------------
// [client] the switch is a switch, and the marks say which reason dimmed a row
// ---------------------------------------------------------------------------
console.log('[client]')
{
  const panel = readSource('lib/client/client.panel.js')
  const marks = readSource('lib/client/client.marks.js')
  const bundle = readSource('lib/client/client.js')
  const dialogs = readSource('lib/client/client.dialogs.js')
  const kernel = readSource('lib/client/client.kernel.js')
  const locale = readSource('lib/client/client.locale.js')

  check('the card renders a real switch, not a checkbox',
    /role:\s*'switch'/u.test(panel) && /'aria-checked'/u.test(panel))
  check('the switch is only offered on a stored host', /host\.source === 'store' && jsx\('button'/u.test(panel))
  check('switching off asks first', /setPowerHost\(host\)/u.test(panel))
  check('switching on does not', /host\.enabled === false\) \{\s*\n?\s*if \(await switchHost\(host\.alias, true\)\)/u.test(panel))
  check('the dialog lists the live counts', /hosts\.resources\.connections/u.test(dialogs))
  check('the dialog says the sessions stay', /powerOffStays/u.test(dialogs))
  check('the panel posts to the toggle route', /API\.hostToggle/u.test(panel) && /hostToggle:\s*'\/api\/dsh-ssh-workspace\/hosts\/toggle'/u.test(kernel))
  check('the status poll feeds the host-off marks', /syncRemoteWorkspaceMarks\(statusData\.workspaces, statusData\.disabled, statusData\.disabledHosts\)/u.test(panel))
check('a switched-off host also dims the panel workspace row, not only the sidebar', [
  /hosts\.filter\(host => host\.enabled === false\)\.map\(host => host\.alias\)/u,
  /sshwsp-mount-hostoff/u,
  /hosts\.powerOffBadge/u,
].every(pattern => pattern.test(panel)) && /\.sshwsp-mount-hostoff \{ opacity: 0\.55; \}/u.test(readFileSync(path.join(pluginRoot, 'lib/client/client.styles.js'), 'utf8')), 'the panel row kept its full colour')
check('the aliases survive the live re-read, instead of being wiped a frame later',
  /remoteMarks\.disabledHostAliases = new Set\(disabledHosts\.map\(String\)\)/u.test(marks) &&
    /const offHosts = new Set\(remoteMarks\.disabledHostAliases \?\? \[\]\)/u.test(marks) &&
    /collectRemoteWorkspaces\(items, currentDisabledPaths\(\), true\)/u.test(marks) &&
    /remoteMarks\.hostOffSessionIds = new Set\(\)/u.test(marks) &&
    /const hostOffSessions = new Set\(remoteMarks\.hostOffSessionIds \?\? \[\]\)/u.test(marks),
  'every pass re-reads the live workspace store, which knows nothing about the switch and carries no sessionIds; the remembered aliases and membership are what keep the dimming on')
  check('the marks attribute is distinct from detachment', /data-sshwsp-hostoff/u.test(marks) && /data-sshwsp-disabled/u.test(marks))
  check('the power dialog is lazily reachable', /lazyDialog\('HostPowerDialog'\)/u.test(bundle) && /exports\.HostPowerDialog/u.test(dialogs))
  check('host pickers skip switched-off hosts', /host\.enabled !== false/u.test(panel))
  check('both locales name the switch and its counts',
    ['hosts.power', 'hosts.powerOffTitle', 'hosts.powerOffStays', 'hosts.resources.connections', 'hosts.allOff', 'hosts.powerOffWarn']
      .every(key => locale.includes(`'${key}'`)) &&
      (locale.match(/'hosts\.powerOffTitle'/gu) ?? []).length === 2)

  // The confirm is a dialog of the SAME family as the rest, not a wide shell with a
  // flush body: narrow width, its own inset, and the consequence as a band.
  const powerDialog = dialogs.slice(dialogs.indexOf('function HostPowerDialog'), dialogs.indexOf('exports.HostEditor'))
  const styles = readSource('lib/client/client.styles.js')
  check('the confirm uses the narrow dialog shell',
    /className: 'sshwsp-dialog sshwsp-dialog-narrow'/u.test(powerDialog) &&
      /\.sshwsp-dialog-narrow \{ width: 480px; \}/u.test(styles))
  check('the confirm body carries its own inset',
    /sshwsp-dialog-body sshwsp-dialog-body-pad/u.test(powerDialog) &&
      /\.sshwsp-dialog-body-pad \{ padding: 18px 20px 20px; \}/u.test(styles))
  check('a quiet host reads as a sentence, not as an empty-state box',
    /sshwsp-power-idle/u.test(powerDialog) && !/sshwsp-empty/u.test(powerDialog) &&
      /\.sshwsp-power-idle \{/u.test(styles))
  check('the consequence is a band, not another grey line',
    /sshwsp-warnnote/u.test(powerDialog) && /\.sshwsp-warnnote \{/u.test(styles) &&
      /powerOffWarn/u.test(powerDialog))
}

console.log(`\n=== host disable smoke: ${passed} passed, ${failures.length} failed ===\n`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exitCode = 1
}
