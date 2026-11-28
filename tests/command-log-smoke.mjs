/**
 * Command audit: persistence, retention, and typing capture.
 *
 * Three subjects that share one file because they share one fact — "what ran on
 * this host, and how much of it is kept". The ring itself is covered by
 * audit-smoke; this suite covers what happens around it: the document on disk,
 * the retention setting that sizes it, and the terminal recorder that feeds it
 * from keystrokes.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** `file://` URLs, because a Windows absolute path is not an ESM specifier. */
const load = (relative) => import(pathToFileURL(path.join(ROOT, relative)).href)

let failures = 0
let passes = 0
function check (name, ok, detail = '') {
  if (ok) { passes += 1; console.log(`  PASS  ${name}`) } else { failures += 1; console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`) }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sshwsp-cmdlog-'))

// The store resolves $DSH_HOME on every call, so pointing it at a scratch
// directory keeps this suite away from the real one.
process.env.DSH_HOME = path.join(tmpRoot, 'home')

const {
  CommandAudit,
  AUDIT_CAPACITY,
  AUDIT_MAX_CAPACITY,
  AUDIT_MIN_CAPACITY,
} = await load('lib/engine/engine.js')
const {
  CommandLog,
  commandLogPath,
  serializeCommandLog,
  parseCommandLog,
  MAX_LOG_BYTES,
  LOG_VERSION,
} = await load('lib/engine/command-log.js')
const { auditRetentionPatchOf } = await load('lib/engine/audit-limits.js')
const { TerminalTyping, TYPED_LINE_CHARS } = await load('lib/patch/terminal-typing.js')
const { HostConfigStore } = await load('lib/hosts/store.js')

function row (overrides = {}) {
  return {
    seq: 1,
    at: 1_700_000_000_000,
    alias: 'box',
    command: 'ls',
    channel: 'exec',
    durationMs: 5,
    exitCode: 0,
    timedOut: false,
    ...overrides,
  }
}

// ---- the document shape

console.log('\n[the document round-trips]')
{
  const text = JSON.stringify({ version: LOG_VERSION, entries: [row()] })
  check('a document parses back to its rows', parseCommandLog(text).length === 1)
  check('an unknown version is ignored, not guessed', parseCommandLog(JSON.stringify({ version: 99, entries: [row()] })).length === 0)
  check('a non-array entries field is ignored', parseCommandLog(JSON.stringify({ version: 1, entries: {} })).length === 0)
  check('a torn document is not an error', parseCommandLog('{ not json').length === 0)
  check('the empty document parses to nothing', parseCommandLog('').length === 0)
}

console.log('\n[the byte ceiling drops the OLDEST rows]')
{
  const big = 'x'.repeat(4000)
  const rows = Array.from({ length: 300 }, (_, index) => row({ seq: index + 1, command: `${index} ${big}` }))
  const { text, entries } = serializeCommandLog(rows)
  check('the serialized document fits the ceiling', Buffer.byteLength(text, 'utf8') <= MAX_LOG_BYTES)
  check('...and it dropped rows rather than the shape', entries.length > 0 && entries.length < rows.length)
  check('...keeping the NEWEST', entries[entries.length - 1].seq === 300)
}

// ---- the writer

console.log('\n[the writer is atomic, bounded, and idempotent]')
{
  const audit = new CommandAudit(10)
  audit.record(row({ command: 'echo one' }))
  const file = path.join(tmpRoot, 'state', 'dsh-ssh-commands.json')
  const log = new CommandLog({ file, audit, delayMs: 0 })
  const wrote = log.flush()
  check('the first flush writes the file', wrote === true && fs.existsSync(file))
  check('the written document parses', parseCommandLog(fs.readFileSync(file, 'utf8')).length === 1)
  check('an unchanged ring does not rewrite', log.flush() === false)
  audit.record(row({ seq: 2, command: 'echo two' }))
  check('a changed ring rewrites', log.flush() === true)
  check('...and the new row is on disk', parseCommandLog(fs.readFileSync(file, 'utf8')).length === 2)
  check('the temp file is gone, not left beside it', fs.readdirSync(path.dirname(file)).every(name => !name.endsWith('.tmp')))
  if (process.platform !== 'win32') {
    const mode = fs.statSync(file).mode & 0o777
    check('the file is owner-only', mode === 0o600, `mode ${mode.toString(8)}`)
  }

  const loaded = new CommandAudit(10)
  loaded.restore(log.load())
  check('load() seeds a fresh ring', loaded.list().length === 2)
  check('...and seq continues past what was read', loaded.record(row())?.seq === 3)

  const noFile = new CommandLog({ file: undefined, audit, delayMs: 0 })
  check('no path disables the writer instead of throwing', noFile.flush() === false && noFile.load().length === 0)
}

console.log('\n[restore goes through the same sanitizer]')
{
  const audit = new CommandAudit(10)
  const kept = audit.restore([
    row({ seq: 4, command: 'curl -H "Authorization: Bearer sk-live-123" https://x' }),
    row({ seq: 5, sessionId: 's'.repeat(200) }),
    null,
    'nope',
  ])
  check('malformed rows are dropped', kept === 2)
  check('a secret in a restored row is redacted', !audit.list()[0].command.includes('sk-live-123'))
  check('a restored session id is bounded', audit.list()[1].sessionId.length === 64)
  check('rows are ordered by seq', audit.list()[0].seq === 4 && audit.list()[1].seq === 5)
}

// ---- the ring's capacity

console.log('\n[capacity is one number, enforced in one place]')
{
  const audit = new CommandAudit(5)
  for (let index = 0; index < 5; index += 1) audit.record(row({ command: `c${index}` }))
  check('setCapacity trims immediately', audit.setCapacity(2) === 2 && audit.list().length === 2)
  check('...keeping the newest', audit.list()[1].command === 'c4')
  check('a nonsense capacity falls back to the default', audit.setCapacity(0) === AUDIT_CAPACITY)
  check('a capacity above the ceiling falls back too', audit.setCapacity(AUDIT_MAX_CAPACITY + 1) === AUDIT_CAPACITY)
  check('the bounds are the advertised ones', AUDIT_MIN_CAPACITY === 1 && AUDIT_MAX_CAPACITY === 2000)
}

console.log('\n[the retention body is validated, not coerced]')
{
  check('a whole number passes', auditRetentionPatchOf({ retention: 50 }).ok === true)
  check('...and comes back unchanged', auditRetentionPatchOf({ retention: 50 }).retention === 50)
  check('a float is refused', auditRetentionPatchOf({ retention: 5.5 }).ok === false)
  check('a string is refused', auditRetentionPatchOf({ retention: '50' }).ok === false)
  check('a missing field is refused', auditRetentionPatchOf({}).ok === false)
  check('below the floor is refused', auditRetentionPatchOf({ retention: 0 }).ok === false)
  check('above the ceiling is refused', auditRetentionPatchOf({ retention: 2001 }).ok === false)
  check('an unknown key is refused, not ignored', auditRetentionPatchOf({ retention: 5, extra: 1 }).ok === false)
  check('a non-object body is refused', auditRetentionPatchOf(null).ok === false)
}

// ---- the store's section

console.log('\n[the store keeps the retention]')
{
  // An explicit path keeps this away from the real store the wrapper reads.
  const store = new HostConfigStore(path.join(tmpRoot, 'store.json'))
  check('a fresh store reports the default', store.audit().retention === AUDIT_CAPACITY)
  check('setAudit keeps the number', store.setAudit(77).retention === 77)
  check('...and a re-read agrees', store.audit().retention === 77)
  check('an out-of-range save falls back to the default', store.setAudit(5000).retention === AUDIT_CAPACITY)
  check('...and the file agrees', store.audit().retention === AUDIT_CAPACITY)
}

// ---- typing capture

console.log('\n[a typed line becomes one row]')
{
  const lines = []
  const typing = new TerminalTyping({ onCommit: line => lines.push(line) })
  typing.feed('ls -la\r')
  check('Enter commits the line', lines.length === 1 && lines[0] === 'ls -la')
  typing.feed('echo hi')
  typing.feed('\r')
  check('a second line commits separately', lines[1] === 'echo hi')
  typing.feed('abc\u007f\u007fd\n')
  check('Backspace removes characters', lines[2] === 'ad', JSON.stringify(lines[2]))
  typing.feed('rm -rf /tmp/x\u0003')
  typing.feed('\r')
  check('Ctrl-C abandons the line', lines.length === 3)
  typing.feed('\u001b[A\u001b')
  typing.feed('\r')
  check('an escape sequence is not typed into the command', lines.length === 3)
  typing.feed('   \r')
  check('an empty line records nothing', lines.length === 3)
  typing.feed('x'.repeat(TYPED_LINE_CHARS + 20) + '\r')
  check('a very long line is capped', lines[3].length === TYPED_LINE_CHARS)
  const broken = new TerminalTyping({ onCommit: () => { throw new Error('nope') } })
  broken.feed('boom\r')
  check('a throwing commit does not escape the keystroke', true)
}

// ---- the wiring

const terminalSource = fs.readFileSync(path.join(ROOT, 'lib/patch/patch-terminal.js'), 'utf8')
const engineSource = fs.readFileSync(path.join(ROOT, 'lib/engine/engine.js'), 'utf8')
const shellSource = fs.readFileSync(path.join(ROOT, 'lib/surface/shell.js'), 'utf8')
const toolsSource = fs.readFileSync(path.join(ROOT, 'lib/surface/tools.js'), 'utf8')
const routesSource = fs.readFileSync(path.join(ROOT, 'lib/routes/workspaces.js'), 'utf8')
const routesTable = fs.readFileSync(path.join(ROOT, 'lib/routes/routes.js'), 'utf8')
const indexSource = fs.readFileSync(path.join(ROOT, 'lib/index.js'), 'utf8')
const panelSource = fs.readFileSync(path.join(ROOT, 'lib/client/client.panel.js'), 'utf8')
const kernelSource = fs.readFileSync(path.join(ROOT, 'lib/client/client.kernel.js'), 'utf8')
const localeSource = fs.readFileSync(path.join(ROOT, 'lib/client/client.locale.js'), 'utf8')

console.log('\n[the audit reaches every channel]')
{
  check('the terminal feeds the recorder only after the write was accepted',
    /this\.channel\.write\(data[\s\S]{0,400}?this\.typing\?\.feed\(data\)/u.test(terminalSource))
  check('the terminal records channel "terminal"', /channel: 'terminal'/u.test(terminalSource))
  check('...with the session id from the spec env', /spec\.env\.DSH_SESSION_ID/u.test(terminalSource))
  check('the shell manager records its own runs', /channel: 'shell'/u.test(shellSource))
  check('...after a real run, not on a refusal', /const result = await shell\.run[\s\S]{0,1600}?this\.engine\?\.audit\?\.record/u.test(shellSource))
  check('the exec tool passes its channel and session', /channel: 'exec',\s*\n\s*sessionId: sessionIdOf\(exec\)/u.test(toolsSource))
  check('background runs get their own channel', /channel: 'background'/u.test(toolsSource))
  check('the refusal rows carry the session too', /refused: true,[\s\S]{0,200}?sessionId: sessionIdOf\(exec\)/u.test(toolsSource))
  check('engine.exec forwards the session to the ring', /sessionId: options\.sessionId/u.test(engineSource))
}

console.log('\n[the audit is readable, and the retention writable]')
{
  check('the route table declares the audit read', /audit: '\/api\/dsh-ssh-workspace\/audit'/u.test(routesTable))
  check('...and the retention write', /auditSettings: '\/api\/dsh-ssh-workspace\/audit\/settings'/u.test(routesTable))
  const auditReadBlock = routesSource.slice(routesSource.indexOf('path: ROUTES.audit,'), routesSource.indexOf('path: ROUTES.auditSettings,'))
  check('the read route serves the rows', /audit\.list\(limit\)/u.test(auditReadBlock))
  check('...and reports the sequence the ring is on', /sequence: audit\.sequence/u.test(auditReadBlock))
  check('...and can filter by session', /listForSession\(sessionId, limit\)/u.test(routesSource))
  check('the write route stores BEFORE the ring', /store\.setAudit\(verdict\.retention\)\s*\n\s*const retention = audit\.setCapacity/u.test(routesSource))
  check('a failed read of the audit is reported, not hidden', /could not restore the command log/u.test(indexSource))
  check('the writer is disposed with the plugin', /commandLog\.dispose\(\)/u.test(indexSource))
  check('the ring change schedules a write', /commandAudit\.onChange = \(\) => \{ commandLog\.schedule\(\) \}/u.test(indexSource))
}

console.log('\n[the panel has a tab for it]')
{
  check('the tab list carries the audit', /const PANEL_TABS = \['hosts', 'workspaces', 'audit', 'settings'\]/u.test(panelSource))
  check('the pane renders the rows', /className: 'sshwsp-audit sshwsp-audit-full'/u.test(panelSource))
  check('the panel asks the audit route', /fetchJson\(API\.audit\)/u.test(panelSource))
check('the tab opens a fifteen-row window, not a fifteen-row log',
  /const AUDIT_LIST_CAP = 15/u.test(panelSource) &&
    /auditVisible\.slice\(\)\.reverse\(\)/u.test(panelSource) &&
    /cap: AUDIT_LIST_CAP,/u.test(panelSource) &&
    !/AUDIT_ROWS_SHOWN/u.test(panelSource),
  'every recorded row stays reachable by scrolling; the window is the only thing that got taller')
  check('the retention is saved through the route', /fetchJson\(API\.auditSettings/u.test(panelSource))
  check('the kernel names both routes', /audit: '\/api\/dsh-ssh-workspace\/audit'/u.test(kernelSource) && /auditSettings: '\/api\/dsh-ssh-workspace\/audit\/settings'/u.test(kernelSource))
  for (const key of ['audit.tab', 'audit.summary', 'audit.retention', 'audit.empty', 'audit.channel.terminal', 'panel.tabAudit']) {
    check(`'${key}' is defined in both dictionaries`,
      (localeSource.match(new RegExp(`'${key.replace(/\./gu, '\\.')}':`, 'gu')) ?? []).length === 2)
  }
  check('the tab label is translated through the id list', /PANEL_TAB_KEYS\[id\]/u.test(panelSource))
}

// ---- done

try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* best effort */ }

console.log(`\n=== ${passes} passed, ${failures} failed ===`)
process.exit(failures === 0 ? 0 : 1)
