/**
 * One redaction rule for every text this plugin lets a user paste in public.
 *
 * ## The leak this suite exists for
 *
 * Three surfaces emit text meant to be pasted into an issue: `exportText()`
 * (diagnostics), the support bundle, and the audit rows. Each had its own
 * masking, and they disagreed. `lib/engine.js` records
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
 * Run: node tests/redact-smoke.mjs
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { maskText, maskAlias, maskPath, maskLine } = await import(pathToFileURL(path.join(pluginRoot, 'lib/redact.js')).href)
const { Diagnostics } = await import(pathToFileURL(path.join(pluginRoot, 'lib/diagnostics.js')).href)
const { buildSupportBundle } = await import(pathToFileURL(path.join(pluginRoot, 'lib/support-bundle.js')).href)
const { redactCommand } = await import(pathToFileURL(path.join(pluginRoot, 'lib/audit.js')).href)

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
  // `alice@host` WITHOUT a `:port` is deliberately left alone (see redact.js:
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

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
if (failures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}
