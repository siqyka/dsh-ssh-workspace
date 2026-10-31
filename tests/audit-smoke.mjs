/**
 * The command audit: what was run on a host, bounded, redacted, and honest.
 *
 * This is the "auditable before isolable" half of F-07. It does not prevent
 * anything — it cannot, and the plugin says so — so the properties that matter
 * are the ones that make a RECORD trustworthy:
 *
 *  1. **Redaction happens on WRITE.** A raw copy that is masked only at export
 *     leaks through any other reader, and there is no "raw" switch to leave
 *     switched on.
 *  2. **Redaction keeps the command readable.** Over-redacting makes the log
 *     useless ("what did I run?"), so the tests pin both directions: the secret
 *     is gone AND the shape of the command survives.
 *  3. **A refusal is recorded.** It is the one case where "did anything run?"
 *     has a definite answer (no), and a log with a gap there is worse than no
 *     log — the reader cannot tell "not run" from "not recorded".
 *  4. **Bounded, with `seq` surviving eviction.** A session left open for days
 *     must not grow, and a reader must be able to tell a gap from a repeat.
 *  5. **Infallible.** Every call site is inside a command path; a record that
 *     throws would turn "the command ran" into "the command ran and the log
 *     broke".
 *
 * Run: node tests/audit-smoke.mjs
 */

import { EventEmitter } from 'node:events'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { CommandAudit, AUDIT_CAPACITY, redactCommand } = await import(pathToFileURL(path.join(pluginRoot, 'lib/audit.js')).href)
const { SshWorkspaceEngine } = await import(pathToFileURL(path.join(pluginRoot, 'lib/engine.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== audit smoke ===\n')

// ---------------------------------------------------------------------------
console.log('[redaction removes the secret and keeps the command]')

const SECRET_CASES = [
  ['an Authorization bearer header', 'curl -H "Authorization: Bearer abc123" https://api.example', ['abc123']],
  ['an Authorization basic header', 'curl -H "Authorization: Basic dXNlcjpwYXNz" https://api.example', ['dXNlcjpwYXNz']],
  ['an environment assignment', 'export DB_PASSWORD=s3cret && psql', ['s3cret']],
  ['a lowercase assignment', 'mysql -u root --password=hunter2', ['hunter2']],
  ['a token flag', 'deploy --token abcdef123456', ['abcdef123456']],
  ['a token query parameter', 'curl "https://x.example/api?token=zzz&page=1"', ['zzz']],
  ['a signature parameter', 'curl "https://x.example/api?sig=deadbeef"', ['deadbeef']],
  ['a home directory', 'ls /home/alice/.ssh', ['alice']],
  ['a Windows home directory', 'dir C:\\Users\\bob\\keys', ['bob']],
]

for (const [label, command, secrets] of SECRET_CASES) {
  const redacted = redactCommand(command)
  for (const secret of secrets) {
    check(`${label}: the secret is gone`, !redacted.includes(secret), redacted)
  }
  check(`${label}: the command is still recognisable`, redacted.length > 0 && /<redacted>|<user>/u.test(redacted), redacted)
}

{
  // The shape must survive: a reader needs to know WHICH header, WHICH variable.
  const redacted = redactCommand('curl -H "Authorization: Bearer abc123" https://api.example')
  check('the header name survives', redacted.includes('Authorization'), redacted)
  check('the url survives', redacted.includes('https://api.example'), redacted)
  const assigned = redactCommand('export DB_PASSWORD=s3cret')
  check('the variable name survives', assigned.includes('DB_PASSWORD'), assigned)
  const flag = redactCommand('mysql --password hunter2 -u root')
  check('the flag survives', flag.includes('--password'), flag)
  check('the rest of the command survives', flag.includes('-u root'), flag)
}

{
  // A command with nothing secret must come through untouched: an over-eager
  // redactor that mangles ordinary commands is a log nobody trusts.
  const plain = 'git status --short && ls -la /tmp'
  check('an ordinary command is unchanged', redactCommand(plain) === plain, redactCommand(plain))
  check('a quoted argument survives', redactCommand(`sh -c 'echo hello world'`) === `sh -c 'echo hello world'`, redactCommand(`sh -c 'echo hello world'`))
}

// ---------------------------------------------------------------------------
console.log('\n[the ring is bounded and seq survives eviction]')

{
  const audit = new CommandAudit(3)
  for (let n = 1; n <= 5; n += 1) {
    audit.record({ at: 1000 + n, alias: 'h', command: `cmd ${n}`, durationMs: 1, exitCode: 0 })
  }
  const entries = audit.list()
  check('the ring keeps only its capacity', entries.length === 3, String(entries.length))
  check('the newest survive', entries[entries.length - 1].command === 'cmd 5', entries[entries.length - 1].command)
  check('the oldest fell off', entries[0].command === 'cmd 3', entries[0].command)
  check('seq keeps increasing across eviction', entries[0].seq === 3 && entries[2].seq === 5, JSON.stringify(entries.map(e => e.seq)))
  check('a list call cannot mutate the ring', (() => {
    const copy = audit.list()
    copy[0].command = 'tampered'
    return audit.list()[0].command === 'cmd 3'
  })())
}

{
  const audit = new CommandAudit()
  check('the default capacity is the advertised one', audit.capacity === AUDIT_CAPACITY, String(audit.capacity))
  check('a fresh ring is empty', audit.list().length === 0)
  check('a fresh ring reports no commands in text', audit.exportText().includes('no remote commands recorded'), audit.exportText())
}

// ---------------------------------------------------------------------------
console.log('\n[a refusal is recorded, and says nothing ran]')

{
  const audit = new CommandAudit()
  const stored = audit.record({ alias: 'h', command: 'rm -rf /srv/app', durationMs: 0, refused: true, error: 'refused: read-only session' })
  check('the entry is stored', stored !== undefined && stored.refused === true, JSON.stringify(stored))
  check('a refusal records a null exit status', stored.exitCode === null, String(stored.exitCode))
  const text = audit.exportText()
  check('the text says refused, not exit 0', text.includes('refused'), text)
  check('...so a reader cannot mistake it for a run', !/exit 0/u.test(text), text)
}

// ---------------------------------------------------------------------------
console.log('\n[outcome-unknown is its own state]')

{
  const audit = new CommandAudit()
  audit.record({ alias: 'h', command: 'touch /srv/marker', durationMs: 5, outcomeUnknown: true, error: 'connection lost' })
  const text = audit.exportText()
  check('the text says the outcome is unknown', text.includes('outcome unknown'), text)
  check('...which is distinct from a timeout', !text.includes('timed out'), text)
}

// ---------------------------------------------------------------------------
console.log('\n[infallible: a record that cannot be built does not throw]')

{
  const audit = new CommandAudit()
  let threw
  try {
    audit.record(undefined)
    audit.record({ alias: 'h', command: 'x', durationMs: Number.NaN, exitCode: 'not-a-number' })
  } catch (error) { threw = error }
  check('a malformed entry does not throw', threw === undefined, String(threw))
  check('...and still produces a usable row', audit.list().length === 2, String(audit.list().length))
  check('a non-numeric duration becomes 0', audit.list()[1].durationMs === 0, String(audit.list()[1].durationMs))
  check('a non-numeric exit status becomes null', audit.list()[1].exitCode === null, String(audit.list()[1].exitCode))
}

// ---------------------------------------------------------------------------
console.log('\n[the engine records every command it runs]')

{
  // A real `exec` over a fake client: the audit must be written by the engine
  // itself, not by the tool layer, or a command run through the shell seam
  // would be invisible.
  const engine = new SshWorkspaceEngine({})
  const client = {
    // Real ssh2's exec is `exec(command[, options], callback)`; the engine
    // passes the channel-options bag (agent forwarding lives there), so the
    // double honours both arities like the real API does.
    exec (_command, optionsOrCallback, maybeCallback) {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
      const stream = new EventEmitter()
      stream.stderr = new EventEmitter()
      stream.signal = () => {}
      stream.close = () => {}
      callback(undefined, stream)
      setTimeout(() => {
        stream.emit('data', Buffer.from('hello'))
        stream.emit('close', 0)
      }, 0)
    },
  }
  engine.acquire = async () => ({ alias: 'audited', client, sftp: undefined, idleAt: Date.now(), inFlight: 0, holds: 0, broken: false })
  engine.closeRecord = () => {}
  const outcome = await engine.exec('audited', 'echo hello', { channel: 'shell' })
  check('the command succeeded', outcome.success === true, JSON.stringify(outcome))
  const rows = engine.audit.list()
  check('the engine wrote an audit row', rows.length === 1, String(rows.length))
  check('...with the command as the caller wrote it', rows[0].command === 'echo hello', rows[0].command)
  check('...with the channel it was given', rows[0].channel === 'shell', rows[0].channel)
  check('...with the exit status', rows[0].exitCode === 0, String(rows[0].exitCode))
  check('...with a duration', rows[0].durationMs >= 0, String(rows[0].durationMs))
  engine.dispose()
}

{
  // A cwd travels as its own field, not baked into the command line.
  const engine = new SshWorkspaceEngine({})
  const client = {
    exec (_command, optionsOrCallback, maybeCallback) {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
      const stream = new EventEmitter()
      stream.stderr = new EventEmitter()
      stream.signal = () => {}
      stream.close = () => {}
      callback(undefined, stream)
      setTimeout(() => { stream.emit('close', 0) }, 0)
    },
  }
  engine.acquire = async () => ({ alias: 'cwd', client, sftp: undefined, idleAt: Date.now(), inFlight: 0, holds: 0, broken: false })
  engine.closeRecord = () => {}
  await engine.exec('cwd', 'pwd', { cwd: '/srv/app' })
  const [row] = engine.audit.list()
  check('the cwd is recorded separately', row.cwd === '/srv/app', String(row.cwd))
  check('...so the command stays as the caller wrote it', row.command === 'pwd', row.command)
  engine.dispose()
}

{
  // A refused command never reaches `exec`, so the tool layer records it. This
  // pins the shape that path writes AND that the tool actually calls it: a
  // refusal missing from the log is a gap a reader cannot interpret, because
  // "not run" and "not recorded" look identical from outside.
  const { readFileSync } = await import('node:fs')
  const toolsSource = readFileSync(path.join(pluginRoot, 'lib/tools.js'), 'utf8')
  const refusalCall = /assertRemoteCommandAllowed[\s\S]{0,400}catch \(error\) \{[\s\S]{0,400}engine\.audit\?\.record\(\{[\s\S]{0,400}refused: true/u.test(toolsSource)
  check('the exec tool records a refusal into the audit', refusalCall, 'the catch around assertRemoteCommandAllowed must record')
  check('...with the refusal flag, so a reader knows nothing ran', /refused: true/u.test(toolsSource))

  const engine = new SshWorkspaceEngine({})
  engine.audit.record({ alias: 'refused-host', command: 'rm -rf /srv', channel: 'exec', durationMs: 0, refused: true, error: 'read-only' })
  const rows = engine.audit.listFor('refused-host')
  check('listFor answers for one host only', rows.length === 1, String(rows.length))
  check('...and keeps the refusal flag', rows[0].refused === true, JSON.stringify(rows[0]))
  engine.dispose()
}

// ---------------------------------------------------------------------------
console.log('\n[the audit and the diagnostics ring are separate]')

{
  const engine = new SshWorkspaceEngine({})
  check('the engine has both rings', engine.audit !== undefined && engine.diagnostics !== undefined)
  check('they are different objects', engine.audit !== engine.diagnostics)
  // A burst of commands must not flush the event history, and vice versa.
  for (let n = 0; n < 300; n += 1) engine.audit.record({ alias: 'h', command: `c${n}`, durationMs: 0, exitCode: 0 })
  engine.diagnostics.record('connect', 'still here', { alias: 'h' })
  check('a command burst did not flush the event ring', engine.diagnostics.list().length === 1, String(engine.diagnostics.list().length))
  engine.dispose()
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
process.exit(failures === 0 ? 0 : 1)
