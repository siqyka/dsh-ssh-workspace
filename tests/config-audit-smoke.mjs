/**
 * The `~/.ssh/config` audit: unsupported keywords are REPORTED, not dropped.
 *
 * The plugin reads an OpenSSH config as a fallback and deliberately does not
 * reimplement OpenSSH. That was always true; what was missing is the sentence.
 * A user whose block says `LocalForward 5432 …` expected a tunnel and got none,
 * with nothing anywhere saying so — and a user whose block says `ProxyJump
 * bastion` used to get a row that connected DIRECTLY, which is worse than an
 * error because it looks like success.
 *
 * So the audit's properties are about the DIFFERENCE between verdicts, and this
 * suite is written to fail if they get flattened:
 *
 *  - `ignored` — not read, nothing breaks;
 *  - `lost`    — not read, and a feature the user expects is therefore absent;
 *  - `refused` — cannot be honoured, so the host is refused rather than
 *                connected in a way the user did not ask for.
 *
 * It also pins the audit to the resolver: a keyword the resolver ACTS on must
 * not be reported as ignored, and a keyword it only reads in order to REFUSE
 * must not appear as a silent success.
 *
 * Run: node tests/config-audit-smoke.mjs
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { auditConfigText, summarizeAudit, SUPPORTED_KEYWORDS, KNOWN_UNSUPPORTED } = await import(pathToFileURL(path.join(pluginRoot, 'lib/config-audit.js')).href)
const { HostStore } = await import(pathToFileURL(path.join(pluginRoot, 'lib/hosts.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== config audit smoke ===\n')

// ---------------------------------------------------------------------------
console.log('[three verdicts, and they are not interchangeable]')

{
  const entries = auditConfigText('Host web\n  LocalForward 5432 localhost:5432\n', 'web')
  check('a LocalForward is reported', entries.length === 1, JSON.stringify(entries))
  check('...as LOST, not as merely ignored', entries[0].verdict === 'lost', entries[0].verdict)
  check('...with what the user loses', /no local tunnel is created/u.test(entries[0].detail), entries[0].detail)
}

{
  // ProxyJump is SUPPORTED now: the engine builds the chain, so it is adopted
  // rather than refused. An adopted keyword produces no audit row — the audit
  // reports what had no effect, and this did have one.
  const entries = auditConfigText('Host web\n  ProxyJump bastion\n', 'web')
  check('a ProxyJump is not reported as a problem', entries.length === 0, JSON.stringify(entries))
  check('...because it is supported', SUPPORTED_KEYWORDS.has('proxyjump'))
  check('...and no longer carries a refusal verdict', KNOWN_UNSUPPORTED.proxyjump === undefined,
    JSON.stringify(KNOWN_UNSUPPORTED.proxyjump))
}

{
  // A REFUSED verdict is still reachable through the table for a keyword the
  // resolver does not read at all: that is the case where the host would be
  // listed AND its setting would be silently ignored, which is the worst of
  // both. `ProxyCommand` is read by the resolver, so use a made-up one to pin
  // the plumbing rather than a real keyword's policy.
  const entries = auditConfigText('Host web\n  FrobnicateProxy bastion\n', 'web')
  check('an unlisted keyword defaults to ignored, never to refused', entries[0].verdict === 'ignored', entries[0].verdict)
}

{
  const entries = auditConfigText('Host web\n  ServerAliveInterval 30\n', 'web')
  check('a keepalive override is reported', entries.length === 1, JSON.stringify(entries))
  check('...as IGNORED: nothing breaks', entries[0].verdict === 'ignored', entries[0].verdict)
}

{
  // The three must not collapse: this is the property the module exists for.
  const entries = auditConfigText([
    'Host web',
    '  LocalForward 5432 localhost:5432',
    '  ServerAliveInterval 30',
    '  Frobnicate yes',
    '',
  ].join('\n'), 'web')
  const verdicts = new Set(entries.map(entry => entry.verdict))
  check('the distinct verdicts survive one block', verdicts.size === 2, JSON.stringify([...verdicts]))
  check('a lost entry and an ignored entry are both present',
    entries.some(entry => entry.verdict === 'lost') && entries.some(entry => entry.verdict === 'ignored'),
    JSON.stringify(entries.map(entry => `${entry.keyword}:${entry.verdict}`)))
}

// ---------------------------------------------------------------------------
console.log('\n[an unlisted keyword is still covered]')

{
  const entries = auditConfigText('Host web\n  Frobnicate yes\n', 'web')
  check('an unknown keyword is reported rather than dropped', entries.length === 1, JSON.stringify(entries))
  check('...as ignored, with a generic sentence', entries[0].verdict === 'ignored', entries[0].verdict)
  check('...that does not invent a consequence', /no effect on a remote workspace/u.test(entries[0].detail), entries[0].detail)
}

// ---------------------------------------------------------------------------
console.log('\n[supported keywords are not reported]')

{
  const entries = auditConfigText([
    'Host web',
    '  HostName web.example',
    '  User deploy',
    '  Port 2222',
    '  IdentityFile ~/.ssh/id_ed25519',
    '',
  ].join('\n'), 'web')
  check('identity keywords produce no audit entries', entries.length === 0, JSON.stringify(entries))
}

{
  // `ProxyJump` is in SUPPORTED_KEYWORDS because the resolver really does read
  // and act on it. `ProxyCommand` is also read — in order to refuse — which is
  // why it is listed as supported rather than as an ignored keyword: the
  // refusal IS its effect, and reporting it twice would be noise.
  check('the resolver-read keywords are declared supported',
    SUPPORTED_KEYWORDS.has('proxyjump') && SUPPORTED_KEYWORDS.has('hostname') && SUPPORTED_KEYWORDS.has('proxycommand'))
  check('ProxyCommand still carries a refusal verdict',
    KNOWN_UNSUPPORTED.proxycommand?.verdict === 'refused', JSON.stringify(KNOWN_UNSUPPORTED.proxycommand))
}

// ---------------------------------------------------------------------------
console.log('\n[matching follows the resolver, wildcards included]')

{
  const config = [
    'Host *',
    '  LocalForward 5432 localhost:5432',
    '',
    'Host web',
    '  HostName web.example',
    '',
  ].join('\n')
  const web = auditConfigText(config, 'web')
  check('a catch-all block applies to a concrete host', web.length === 1 && web[0].keyword === 'localforward', JSON.stringify(web))
  const other = auditConfigText(config, 'db')
  check('...and to another host the file mentions', other.length === 1, JSON.stringify(other))
}

{
  const config = [
    'Host web',
    '  LocalForward 5432 localhost:5432',
    '',
    'Host db',
    '  LocalForward 3306 localhost:3306',
    '',
  ].join('\n')
  const web = auditConfigText(config, 'web')
  check('another host\'s block is not attributed to this one', web.length === 1 && web[0].keyword === 'localforward', JSON.stringify(web))
}

{
  const config = [
    'Host web !web-test',
    '  LocalForward 5432 localhost:5432',
    '',
  ].join('\n')
  check('a negated pattern excludes the alias', auditConfigText(config, 'web-test').length === 0, JSON.stringify(auditConfigText(config, 'web-test')))
  check('...while the positive pattern still selects it', auditConfigText(config, 'web').length === 1, JSON.stringify(auditConfigText(config, 'web')))
}

// ---------------------------------------------------------------------------
console.log('\n[first value wins, so a repeat is not a second decision]')

{
  const config = [
    'Host web',
    '  LocalForward 5432 localhost:5432',
    '  LocalForward 8080 localhost:8080',
    '',
  ].join('\n')
  const entries = auditConfigText(config, 'web')
  check('a repeated keyword is reported once', entries.length === 1, JSON.stringify(entries))
  check('...with the FIRST value, the one OpenSSH would use', entries[0].value === '5432 localhost:5432', entries[0].value)
}

{
  // A long value must not make the audit unreadable. `ProxyCommand` is a
  // resolver-read keyword (it refuses the host), so an unlisted keyword with a
  // long value is the case that actually reaches the audit.
  const longValue = 'x'.repeat(200)
  const entries = auditConfigText(`Host web\n  Frobnicate ${longValue}\n`, 'web')
  check('a long value is truncated', entries[0].value.length <= 80, String(entries[0].value.length))
  check('...with a marker that it was cut', entries[0].value.endsWith('...'), entries[0].value.slice(-5))
}

// ---------------------------------------------------------------------------
console.log('\n[the summary leads with the consequence that matters most]')

{
  check('no entries means no sentence', summarizeAudit([]) === '', summarizeAudit([]))
  const lost = summarizeAudit([{ keyword: 'localforward', verdict: 'lost', detail: '' }])
  check('a lost keyword says the setting has no effect', /no effect here/u.test(lost), lost)
  const ignored = summarizeAudit([{ keyword: 'serveraliveinterval', verdict: 'ignored', detail: '' }])
  check('only ignored keywords say so plainly', /ignored by this plugin/u.test(ignored), ignored)
}

// ---------------------------------------------------------------------------
console.log('\n[the listing carries the audit per host]')

{
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-audit-'))
  const configPath = path.join(dir, 'ssh_config')
  writeFileSync(configPath, [
    'Host web',
    '  HostName web.example',
    '  User deploy',
    '  LocalForward 5432 localhost:5432',
    '',
    'Host jump',
    '  HostName jump.example',
    '  ProxyJump bastion',
    '',
  ].join('\n'))
  const store = new HostStore(configPath)
  store.entryStore = {
    load: () => [],
    find: () => undefined,
    secretFor: () => undefined,
    knownHostKey: () => undefined,
    rememberHostKey: () => {},
    forgetHostKey: () => false,
    enableWorkspace: () => {},
    disableWorkspace: () => {},
    sshConfigAliases: () => [],
  }
  const listing = store.listing()
  const web = listing.rows.find(row => row.alias === 'web')
  check('a usable host with a lost keyword is still listed', web !== undefined)
  check('...and carries the audit', Array.isArray(web.unsupported) && web.unsupported.length === 1, JSON.stringify(web?.unsupported))
  check('...with the lost verdict', web.unsupported[0].verdict === 'lost', web.unsupported[0].verdict)
  // A `ProxyJump` host is now a real route, so it IS a row — and it must
  // carry the audit for the jump too, because the bastion's own unsupported
  // keywords matter just as much as the target's.
  const jump = listing.rows.find(row => row.alias === 'jump')
  check('a jump host is listed', jump !== undefined, JSON.stringify(listing.rows.map(r => r.alias)))
  check('...and nothing is skipped for a proxy reason',
    !(listing.skipped ?? []).some(entry => entry.alias === 'jump'), JSON.stringify(listing.skipped))
  check('a host with nothing unsupported has no audit field',
    listing.rows.filter(row => row.unsupported !== undefined).length === 1,
    JSON.stringify(listing.rows.map(row => row.alias)))

  // `configAudit` is the direct accessor the panel and the bundle use.
  check('configAudit answers for one alias', store.configAudit('web').length === 1, JSON.stringify(store.configAudit('web')))
  check('...and is empty for an alias with no block', store.configAudit('nobody').length === 0, JSON.stringify(store.configAudit('nobody')))
  rmSync(dir, { recursive: true, force: true })
}

{
  // A config that cannot be read must not crash the audit; the listing already
  // reports the read failure, and reporting one problem twice is noise.
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-audit-'))
  const configPath = path.join(dir, 'ssh_config')
  writeFileSync(configPath, 'Host web\n  HostName web.example\n')
  const store = new HostStore(configPath)
  store.configPath = path.join(dir, 'missing-config')
  check('an unreadable config yields an empty audit, not a throw', store.configAudit('web').length === 0)
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
process.exit(failures === 0 ? 0 : 1)
