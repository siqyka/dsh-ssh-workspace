/**
 * Reading `~/.ssh/config`: parsing, auditing, Include following, Match evaluation.
 *
 * The plugin deliberately does not reimplement OpenSSH. That makes four
 * questions worth pinning separately, and they share one parser:
 *   - ssh-config — `Match` ends a section; a wildcard block cannot silently
 *     rewrite identity (O-17/O-18);
 *   - config-audit — an unsupported keyword is REPORTED, not dropped, and
 *     "ignored" / "refused" / "unknown" stay three distinct verdicts;
 *   - include-chain — order, globs, cycles and the depth cap, each against
 *     real temporary directories;
 *   - match-eval — "does not apply", "would run a local command" and "cannot
 *     tell" must never collapse into two.
 *
 * Run: node tests/ssh-config-smoke.mjs
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

let totalPassed = 0
let totalFailures = 0

// ---------------------------------------------------------------------------
// ssh-config-smoke.mjs
// ---------------------------------------------------------------------------
await (async () => {
/**
 * `Match` blocks end a section; a wildcard block cannot silently rewrite identity.
 *
 * Two failures motivated this suite, and the second is the one that matters:
 *
 *  1. **O-17 (P0).** All three config scanners reset their selection state on
 *     `Host` but not on `Match`, so a `Match` body was collected as part of the
 *     PREVIOUS `Host` block. `Match host db` after `Host web` gave `web` the
 *     `User`, `Port` and `IdentityFile` written for `db` — right host, someone
 *     else's credentials — and a `ProxyJump none` in that body cancelled the
 *     `Host *` bastion that should have refused the host. A protection was
 *     silently switched off by a block that has nothing to do with the host.
 *
 *  2. **O-18 (P1).** Identity keywords are read only from an exact block. That
 *     is a deliberate subset, but the audit called those keywords "supported"
 *     and skipped them, so a `User deploy` in `Host *` was neither adopted nor
 *     reported: the user connected as the local account and nothing said why.
 *
 * Both are properties of ONE thing — where a section starts and ends — which
 * is why they share a suite: a fix that splits them is a fix that reintroduces
 * the disagreement.
 *
 * Run: node tests/ssh-config-smoke.mjs
 */
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { sectionsOf, selects, isExact, patternMatches } = await import(pathToFileURL(path.join(pluginRoot, 'lib/hosts/ssh-config.js')).href)
const { HostStore } = await import(pathToFileURL(path.join(pluginRoot, 'lib/hosts/hosts.js')).href)
const { auditConfigText, KNOWN_UNSUPPORTED, verdictFor } = await import(pathToFileURL(path.join(pluginRoot, 'lib/report/report.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const cleanups = []
const track = (dir) => { cleanups.push(() => rmSync(dir, { recursive: true, force: true })) }

/**
 * A HostStore over a throwaway config file, with an empty entry store.
 *
 * The real constructor and the real ssh-config parsing are used; only the
 * editable store is replaced, because that is not what this suite tests.
 */
function storeWith (configText) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-sshcfg-'))
  track(dir)
  const configPath = path.join(dir, 'ssh_config')
  writeFileSync(configPath, configText)
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
  return { store, dir }
}

console.log('\n=== ssh config section boundary smoke ===\n')

// ---------------------------------------------------------------------------
console.log('[1] a `Match` line starts a section of its own')

{
  const sections = sectionsOf([
    'Host web',
    '  HostName web.example',
    '',
    'Match host db',
    '  User evil',
    '  Port 2222',
    '',
    'Host other',
    '  HostName other.example',
    '',
  ].join('\n'))
  const kinds = sections.map(section => section.kind)
  check('the sections are top / host / match / host', JSON.stringify(kinds) === JSON.stringify(['top', 'host', 'match', 'host']), JSON.stringify(kinds))
  // Optional chaining, not a direct read: when the section rule regresses the
  // `match` section is missing, and a TypeError would abort the whole suite —
  // one crash instead of the several red lines that localise the bug.
  const match = sections.find(section => section.kind === 'match')
  check('the Match body belongs to the Match section, not to `web`',
    match?.entries.map(entry => entry.keyword).join(',') === 'user,port',
    JSON.stringify(match?.entries ?? null))
  const web = sections.find(section => section.kind === 'host' && section.patterns.includes('web'))
  check('`web` keeps only its own keywords',
    web?.entries.map(entry => entry.keyword).join(',') === 'hostname', JSON.stringify(web?.entries ?? null))
}

{
  // `Match host <alias>` now EVALUATES, so a block naming the alias applies to
  // it — that is what the construct is for. What must not change is that a
  // Match body is never an EXACT declaration: identity keywords (`User`, `Port`,
  // `IdentityFile`) still come only from a literal `Host` block, so a Match
  // cannot rewrite who you log in as.
  const sections = sectionsOf('Host web\nMatch host web\n  User evil\n')
  const match = sections.find(section => section.kind === 'match')
  check('a Match naming the alias selects it', selects(match, 'web') === true)
  check('...but is never an exact declaration, so it cannot set identity',
    isExact(match, 'web') === false)

  // The security half of O-10, restated for the evaluated form: a Match naming
  // a DIFFERENT host must not select this one.
  const other = sectionsOf('Host web\nMatch host db\n  User evil\n').find(section => section.kind === 'match')
  check('a Match naming another host does not select it', selects(other, 'web') === false)

  // And a Match whose condition cannot be decided selects nobody.
  const undecidable = sectionsOf('Host web\nMatch address 10.0.0.1\n  User evil\n').find(section => section.kind === 'match')
  check('an undecidable Match selects nobody', selects(undecidable, 'web') === false)

  // `Match exec` is refused outright: it would run a local command.
  const refused = sectionsOf('Host web\nMatch exec true\n  User evil\n').find(section => section.kind === 'match')
  check('a Match exec selects nobody', selects(refused, 'web') === false)
}

{
  // Lines before the first Host form a `top` section that selects no host.
  // OpenSSH would apply them globally; this plugin never has, and changing that
  // is F-10 rather than a silent side effect of the section split.
  const sections = sectionsOf('User deploy\nHost web\n  HostName web.example\n')
  check('leading lines form a top section', sections[0].kind === 'top' && sections[0].entries.length === 1, JSON.stringify(sections[0]))
  check('the top section selects nobody', selects(sections[0], 'web') === false)
}

// ---------------------------------------------------------------------------
console.log('[2] O-17: a Match body cannot leak into the previous Host')

{
  const { store } = storeWith([
    'Host web',
    '  HostName web.example',
    '',
    'Match host db',
    '  User evil',
    '  IdentityFile ~/.ssh/evil',
    '  Port 2222',
    '',
  ].join('\n'))
  const resolved = store.resolve('web')
  check('the host name is still the one written for web', resolved.host === 'web.example', JSON.stringify(resolved))
  check('the user is NOT taken from the Match body', resolved.user !== 'evil', JSON.stringify(resolved.user))
  check('the port is NOT taken from the Match body', resolved.port !== 2222, JSON.stringify(resolved.port))
  check('the key is NOT taken from the Match body',
    resolved.auth.kind !== 'key' || !String(resolved.auth.keyPath ?? '').includes('evil'),
    JSON.stringify(resolved.auth))
}

{
  // The security half: a `ProxyJump none` under a non-matching `Match` used to
  // cancel the `Host *` bastion, so a host that must go through a bastion was
  // reported as directly connectable. That is a protection switched off by a
  // block unrelated to the host.
  const { store } = storeWith([
    'Host web',
    '  HostName web.example',
    '',
    'Match host db',
    '  ProxyJump none',
    '',
    'Host *',
    '  ProxyJump bastion',
    '',
  ].join('\n'))
  // A `Match` body selecting nobody means its `ProxyJump none` does not
  // cancel the catch-all bastion. The host must therefore route THROUGH the
  // bastion — not connect directly, which is what reading that `none` would do.
  const resolved = store.resolve('web')
  check('the Host * bastion is still honoured', resolved.jump?.kind === 'chain',
    JSON.stringify(resolved.jump))
  check('...and the chain names the jump host',
    resolved.jump?.hops?.[0]?.host === 'bastion', JSON.stringify(resolved.jump))

  const listing = store.listing()
  check('the host is listed', listing.rows.some(row => row.alias === 'web'),
    JSON.stringify(listing.rows.map(row => row.alias)))
  check('...and nothing is skipped for a proxy reason', (listing.skipped ?? []).length === 0,
    JSON.stringify(listing.skipped))
}

{
  // The mirror image: an exact `ProxyJump none` really does cancel a catch-all
  // bastion. The section fix must not break the idiom it protects.
  const { store } = storeWith([
    'Host direct',
    '  HostName direct.example',
    '  ProxyJump none',
    '',
    'Host *',
    '  ProxyJump bastion',
    '',
  ].join('\n'))
  const resolved = store.resolve('direct')
  check('an explicit ProxyJump none still connects directly', resolved.host === 'direct.example', JSON.stringify(resolved))
}

{
  // A `Match` that NAMES the alias DOES apply now — that is the point of
  // evaluating the construct. Here the user wrote "for web, do not proxy", and
  // first-obtained-wins makes that the answer even though `Host *` below says
  // otherwise. Asserting `direct` is asserting that the directive was READ.
  const { store } = storeWith([
    'Host web',
    '  HostName web.example',
    '',
    'Match host web',
    '  ProxyJump none',
    '',
    'Host *',
    '  ProxyJump bastion',
    '',
  ].join('\n'))
  const resolved = store.resolve('web')
  check('a Match naming the alias applies its settings',
    resolved.jump?.kind === 'direct', JSON.stringify(resolved.jump))

  // The mirror case, which is the one that must never regress: a Match naming a
  // DIFFERENT host leaves the bastion alone.
  const other = storeWith([
    'Host web',
    '  HostName web.example',
    '',
    'Match host db',
    '  ProxyJump none',
    '',
    'Host *',
    '  ProxyJump bastion',
    '',
  ].join('\n'))
  const otherResolved = other.store.resolve('web')
  check('a Match naming another host does not cancel the bastion',
    otherResolved.jump?.kind === 'chain' && otherResolved.jump.hops[0]?.host === 'bastion',
    JSON.stringify(otherResolved.jump))
}

{
  // A `Match` whose body contains a Host-like keyword must not resurrect the
  // previous block: `Match host db` is one section, and the next real `Host`
  // starts the next one.
  const { store } = storeWith([
    'Host web',
    '  HostName web.example',
    'Match host db',
    '  User evil',
    'Host after',
    '  HostName after.example',
    '',
  ].join('\n'))
  const after = store.resolve('after')
  check('the host after a Match block resolves to its own values', after.host === 'after.example', JSON.stringify(after))
  check('...and does not inherit the Match body user', after.user !== 'evil', JSON.stringify(after.user))
}

// ---------------------------------------------------------------------------
console.log('[3] O-18: a wildcard identity keyword is reported, not silently dropped')

{
  const config = [
    'Host *',
    '  User deploy',
    '  IdentityFile ~/.ssh/id_ed25519',
    '  ForwardAgent yes',
    '',
    'Host web',
    '  HostName web.example',
    '',
  ].join('\n')
  const entries = auditConfigText(config, 'web')
  const keywords = entries.map(entry => entry.keyword)
  check('every wildcard identity keyword is reported', keywords.length === 3, JSON.stringify(keywords))
  check('...including the user', keywords.includes('user'), JSON.stringify(keywords))
  check('...including the key', keywords.includes('identityfile'), JSON.stringify(keywords))
  check('...including agent forwarding', keywords.includes('forwardagent'), JSON.stringify(keywords))
  check('...as LOST, not as merely ignored',
    entries.every(entry => entry.verdict === 'lost'), JSON.stringify(entries.map(entry => entry.verdict)))
  check('...with a sentence naming the exact-block rule',
    entries.every(entry => /exact `Host <alias>` block/u.test(entry.detail)),
    JSON.stringify(entries.map(entry => entry.detail)))
}

{
  // The same keywords in an exact block ARE adopted, so they must stay silent.
  // Reporting them would turn every correctly configured host into a warning.
  const entries = auditConfigText([
    'Host web',
    '  HostName web.example',
    '  User deploy',
    '  IdentityFile ~/.ssh/id_ed25519',
    '  ForwardAgent yes',
    '',
  ].join('\n'), 'web')
  check('an exact block reports nothing', entries.length === 0, JSON.stringify(entries))
}

{
  // A wildcard `ProxyJump` is read from every matching block (that is why the
  // resolver refuses such hosts), so the audit must NOT claim it was ignored.
  // It is reported through `skipped` instead — one problem, one place.
  const entries = auditConfigText('Host *\n  ProxyJump bastion\n\nHost web\n  HostName web.example\n', 'web')
  check('a wildcard ProxyJump is not mislabelled as a lost identity keyword',
    entries.every(entry => entry.keyword !== 'proxyjump'), JSON.stringify(entries))
}

{
  // A `Match` body must not contribute audit rows: nothing in it applies.
  const entries = auditConfigText('Host web\n  HostName web.example\n\nMatch host db\n  LocalForward 5432 localhost:5432\n', 'web')
  check('a LocalForward under a Match is not attributed to the host', entries.length === 0, JSON.stringify(entries))
}

// ---------------------------------------------------------------------------
console.log('[4] every vocabulary key is reachable')

{
  // `verdictFor` is called with what the parser produced: lowercase, no hyphens.
  // A key that cannot be reached is a sentence nobody will ever read — and two
  // keys were exactly that before this suite existed.
  const unreachable = Object.keys(KNOWN_UNSUPPORTED).filter((key) => {
    if (!/^[a-z][a-z0-9]*$/u.test(key)) return true
    // Reaching it means the lookup returns THAT entry, not the generic fallback.
    return verdictFor(key).detail !== KNOWN_UNSUPPORTED[key].detail
  })
  check('no vocabulary key is unreachable', unreachable.length === 0, unreachable.join(', ') || 'none')
}

{
  // The two spellings that used to be unreachable, pinned by name so the
  // regression cannot come back under a different casing.
  check('AddKeysToAgent has a hand-written sentence',
    verdictFor('addkeystoagent').detail.includes('never added to the agent'),
    verdictFor('addkeystoagent').detail)
  check('StrictHostKeyChecking has a hand-written sentence',
    verdictFor('stricthostkeychecking').detail.includes('always verifies the host key'),
    verdictFor('stricthostkeychecking').detail)
  check('the generic fallback is not used for either',
    !verdictFor('addkeystoagent').detail.includes('has no effect on a remote workspace'))
}

{
  // The parser's keyword charset has no hyphen, so a hyphenated key is dead by
  // construction. Asserting the invariant keeps a future "fix" from adding one.
  const { CONFIG_LINE } = await import(pathToFileURL(path.join(pluginRoot, 'lib/hosts/ssh-config.js')).href)
  check('the config keyword charset excludes hyphens',
    CONFIG_LINE.test('StrictHostKeyChecking no') && !CONFIG_LINE.test('strict-host-key-checking no'))
  const entries = auditConfigText('Host web\n  strict-host-key-checking no\n', 'web')
  check('a hyphenated spelling is not even an entry', entries.length === 0, JSON.stringify(entries))
}

// ---------------------------------------------------------------------------
console.log('[5] one section rule, every consumer')

{
  // The contract this suite exists to hold: the audit and the resolver must
  // agree on WHICH blocks select an alias. If they ever diverge, a user is
  // told something different from what happened.
  const config = [
    'Host *',
    '  LocalForward 5432 localhost:5432',
    '',
    'Host web !web-test',
    '  HostName web.example',
    '',
    'Match host web',
    '  User nobody',
    '',
  ].join('\n')
  const web = auditConfigText(config, 'web').map(entry => entry.keyword)
  check('the audit sees the wildcard block that selects the host', web.includes('localforward'), JSON.stringify(web))
  check('...and not the Match body, though it names the host', !web.includes('user'), JSON.stringify(web))

  // `web-test` is excluded from `Host web !web-test`, but `Host *` still selects
  // it — so it keeps the catch-all tunnel and gains nothing from the negated
  // block. Both halves are asserted: an exclusion that also dropped the
  // catch-all would be as wrong as one that ignored the `!`.
  const excluded = auditConfigText(config, 'web-test').map(entry => entry.keyword)
  check('a negated pattern excludes the alias from the negated block',
    !excluded.includes('hostname') && !excluded.includes('user'), JSON.stringify(excluded))
  check('...while a separate catch-all block still selects it',
    excluded.includes('localforward'), JSON.stringify(excluded))
}

{
  // The exclusion on its own, with nothing else in the file: the negated block
  // is the ONLY block carrying the keyword, so an audit row for `web-test`
  // would mean the `!` was not honoured.
  const entries = auditConfigText('Host web !web-test\n  LocalForward 5432 localhost:5432\n', 'web-test')
  check('a negated pattern alone yields no audit rows', entries.length === 0, JSON.stringify(entries))
}

{
  // `patternMatches` is now the single implementation both modules read.
  check('a catch-all pattern matches anything', patternMatches('*', 'web') === true)
  check('a literal pattern matches only itself', patternMatches('web', 'web') === true && patternMatches('web', 'web2') === false)
  check('a ? matches exactly one character', patternMatches('db-?', 'db-1') === true && patternMatches('db-?', 'db-12') === false)
  check('matching is case-sensitive, as in OpenSSH', patternMatches('WEB', 'web') === false)
}

for (const cleanup of cleanups) cleanup()


  totalPassed += passed
  totalFailures += failures
})()

// ---------------------------------------------------------------------------
// config-audit-smoke.mjs
// ---------------------------------------------------------------------------
await (async () => {
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
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { auditConfigText, summarizeAudit, SUPPORTED_KEYWORDS, KNOWN_UNSUPPORTED } = await import(pathToFileURL(path.join(pluginRoot, 'lib/report/report.js')).href)
const { HostStore } = await import(pathToFileURL(path.join(pluginRoot, 'lib/hosts/hosts.js')).href)

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


  totalPassed += passed
  totalFailures += failures
})()

// ---------------------------------------------------------------------------
// include-chain-smoke.mjs
// ---------------------------------------------------------------------------
await (async () => {
/**
 * `Include` following: order, globs, cycles, and the depth cap.
 *
 * Every case here is a file-system hazard that would otherwise become an
 * infinite loop or a silently misordered configuration, so each is executed
 * against real temporary directories rather than asserted from source text.
 *
 * Run: node tests/include-chain-smoke.mjs
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const { readConfigWithIncludes, expandGlob, MAX_INCLUDE_DEPTH } =
  await import(pathToFileURL(path.join(pluginRoot, 'lib', 'hosts', 'hosts.js')).href)
const { sectionsOf, selects } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'hosts', 'ssh-config.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const cleanups = []
function scratch () {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-include-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
/** Write a file, creating parent directories as needed. */
function write (file, text) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text, 'utf8')
}

console.log('\n=== include chain smoke ===\n')

// ---------------------------------------------------------------------------
// 1. A plain include is spliced IN PLACE
// ---------------------------------------------------------------------------
console.log('[1] an included file is inserted where the directive is')
{
  const dir = scratch()
  write(path.join(dir, 'main'), 'Host first\n  HostName one.example\nInclude inc\nHost last\n  HostName three.example\n')
  write(path.join(dir, 'inc'), 'Host middle\n  HostName two.example\n')

  const { text, files, problems } = readConfigWithIncludes(path.join(dir, 'main'))
  const sections = sectionsOf(text)
  check('three host blocks', sections.filter(section => section.kind === 'host').length === 3,
    JSON.stringify(sections.map(section => section.patterns)))
  check('the order is main, included, main',
    sections.filter(section => section.kind === 'host').map(section => section.patterns[0]).join(',') === 'first,middle,last',
    JSON.stringify(sections.filter(section => section.kind === 'host').map(section => section.patterns[0])))
  check('both files were read', files.length === 2, JSON.stringify(files))
  check('nothing was reported as a problem', problems.length === 0, JSON.stringify(problems))
}

// ---------------------------------------------------------------------------
// 2. Order decides precedence, which is the reason for splicing
// ---------------------------------------------------------------------------
console.log('\n[2] a value after the Include overrides the included one')
{
  const dir = scratch()
  // This is the whole point of in-place expansion. If an implementation put the
  // included file at the END, `Host *` from the include would come last and the
  // specific `Host web` written above would still win — but the reverse case
  // (an include that must lose) would be silently inverted.
  write(path.join(dir, 'main'), 'Host web\n  User specific\nInclude inc\n')
  write(path.join(dir, 'inc'), 'Host *\n  User catchall\n')

  const { text } = readConfigWithIncludes(path.join(dir, 'main'))
  // First-wins across the merged text, exactly as hosts.js resolves it.
  const props = {}
  for (const section of sectionsOf(text)) {
    if (!selects(section, 'web')) continue
    for (const { keyword, value } of section.entries) {
      if (!(keyword in props)) props[keyword] = value
    }
  }
  check('the specific block still wins', props.user === 'specific', JSON.stringify(props))
}

// ---------------------------------------------------------------------------
// 3. Globs
// ---------------------------------------------------------------------------
console.log('\n[3] a glob include reads every match, in order')
{
  const dir = scratch()
  write(path.join(dir, 'main'), 'Include conf.d/*.conf\n')
  write(path.join(dir, 'conf.d', 'b.conf'), 'Host bee\n  HostName b.example\n')
  write(path.join(dir, 'conf.d', 'a.conf'), 'Host aye\n  HostName a.example\n')
  write(path.join(dir, 'conf.d', 'ignored.txt'), 'Host nope\n  HostName n.example\n')

  const { text } = readConfigWithIncludes(path.join(dir, 'main'))
  const names = sectionsOf(text).filter(section => section.kind === 'host').map(section => section.patterns[0])
  check('only the matching suffix is read', !names.includes('nope'), JSON.stringify(names))
  check('both matches are read', names.includes('aye') && names.includes('bee'), JSON.stringify(names))
  check('matches are in sorted order, not directory order', names.join(',') === 'aye,bee', JSON.stringify(names))
}

// ---------------------------------------------------------------------------
// 4. A glob matching nothing is not an error
// ---------------------------------------------------------------------------
console.log('\n[4] an empty glob is reported, not thrown')
{
  const dir = scratch()
  write(path.join(dir, 'main'), 'Include conf.d/*.conf\nHost web\n  HostName w.example\n')
  mkdirSync(path.join(dir, 'conf.d'))
  const { text, problems } = readConfigWithIncludes(path.join(dir, 'main'))
  check('the rest of the file still reads', /Host web/u.test(text), JSON.stringify(text))
  check('the empty glob is reported', problems.some(entry => entry.kind === 'no-match'),
    JSON.stringify(problems))
  check('and it did not throw', true)
}

// ---------------------------------------------------------------------------
// 5. Cycles
// ---------------------------------------------------------------------------
console.log('\n[5] a cycle stops instead of hanging')
{
  const dir = scratch()
  write(path.join(dir, 'a'), 'Host alpha\n  HostName a.example\nInclude b\n')
  write(path.join(dir, 'b'), 'Host beta\n  HostName b.example\nInclude a\n')
  const { text, problems } = readConfigWithIncludes(path.join(dir, 'a'))
  check('the first file read completely', /Host alpha/u.test(text) && /Host beta/u.test(text),
    JSON.stringify(text))
  check('the cycle was detected', problems.some(entry => entry.kind === 'cycle'),
    JSON.stringify(problems))
  check('it terminated', true)
}

{ // A self-include is the smallest cycle.
  const dir = scratch()
  write(path.join(dir, 'self'), 'Host me\n  HostName me.example\nInclude self\n')
  const { text, problems } = readConfigWithIncludes(path.join(dir, 'self'))
  check('a self-include terminates', /Host me/u.test(text), JSON.stringify(text))
  check('and is reported as a cycle', problems.some(entry => entry.kind === 'cycle'),
    JSON.stringify(problems))
}

// ---------------------------------------------------------------------------
// 6. Two different PATHS naming one file are still one file
// ---------------------------------------------------------------------------
console.log('\n[6] a cycle reached through a second path is detected')
{
  // The property under test is not "symlinks work" — it is that cycle detection
  // compares REAL paths, so two spellings of one file cannot be walked twice.
  //
  // Built without a symlink on purpose. `symlinkSync` needs Developer Mode or
  // elevation on Windows and silently EPERMs elsewhere, and a case that skips
  // on the platform CI runs most is a case that proves nothing there. A `./`
  // in the include path produces the same two-spellings-of-one-file situation
  // portably, because `realpathSync` collapses it.
  const dir = scratch()
  write(path.join(dir, 'self'), 'Host me\n  HostName me.example\nInclude ./self\n')
  const first = readConfigWithIncludes(path.join(dir, 'self'))
  check('a `.`-spelled self-include terminates', /Host me/u.test(first.text), JSON.stringify(first.text))
  check('and is reported as a cycle', first.problems.some(entry => entry.kind === 'cycle'),
    JSON.stringify(first.problems))

  // And the same thing one level out: a includes b, b includes a.
  write(path.join(dir, 'x'), 'Host ex\n  HostName x.example\nInclude y\n')
  write(path.join(dir, 'y'), 'Host why\n  HostName y.example\nInclude x\n')
  const second = readConfigWithIncludes(path.join(dir, 'x'))
  check('a two-file cycle is detected',
    second.problems.some(entry => entry.kind === 'cycle'), JSON.stringify(second.problems))
  check('and both files were still read', /Host ex/u.test(second.text) && /Host why/u.test(second.text),
    JSON.stringify(second.text))
}

{
  // THE case that distinguishes a real-path comparison from a written-path one.
  //
  // One file reached under TWO spellings — `conf.d/w` and `link/w`, with `link`
  // a junction to `conf.d` — is one file, and reading it twice yields two copies
  // of the same `Host` block. Comparing the strings a reader was handed sees two
  // names and obliges; comparing real paths sees one file and reports a cycle.
  //
  // Not a contrived shape: `Include conf.d/*` next to an explicit
  // `Include conf.d/web.conf` produces exactly it, as does any `..` or
  // symlinked config a person actually writes. The duplicate is SILENT —
  // first-wins makes the second copy change nothing — so the cycle report is
  // the only symptom a reader could act on.
  const dir = scratch()
  const realDir = path.join(dir, 'conf.d')
  mkdirSync(realDir, { recursive: true })
  write(path.join(realDir, 'w'), 'Host web\n  HostName w.example\n')
  let linked = true
  try {
    // `junction` is ignored on POSIX, where a symlink to a directory is what
    // this produces anyway. A file symlink needs a privilege on Windows while a
    // directory junction does not — and a case that skips on the platform CI
    // runs most proves nothing there.
    symlinkSync(realDir, path.join(dir, 'link'), 'junction')
  } catch {
    linked = false
  }
  if (linked) {
    write(path.join(dir, 'main'), 'Include conf.d/w\nInclude link/w\n')
    const outcome = readConfigWithIncludes(path.join(dir, 'main'))
    // Reported as a DUPLICATE, not a cycle: the walk terminates on its own,
    // so calling it a loop would be the wrong word for the right fix. What the
    // user needs to know is "this block appears twice", and only a real-path
    // comparison can know that two spellings are one file.
    check('one file included under two spellings is a DUPLICATE',
      outcome.problems.some(entry => entry.kind === 'duplicate'),
      JSON.stringify(outcome.problems.map(entry => entry.kind)))
    check('and it is not misreported as a cycle',
      !outcome.problems.some(entry => entry.kind === 'cycle'),
      JSON.stringify(outcome.problems.map(entry => entry.kind)))
    check('and its block was not read twice',
      outcome.text.split('Host web').length - 1 === 1,
      JSON.stringify(outcome.text))
  } else {
    console.log('  NOTE  no directory link could be created here; the realpath comparison is unpinned on this platform')
  }
}

// ---------------------------------------------------------------------------
// 7. The depth cap
// ---------------------------------------------------------------------------
console.log('\n[7] nesting is capped')
{
  const dir = scratch()
  const depth = MAX_INCLUDE_DEPTH + 3
  for (let index = 0; index < depth; index += 1) {
    const next = join(dir, `f${index}`)
    const text = index + 1 < depth ? `Host h${index}\n  HostName h.example\nInclude f${index + 1}\n` : `Host h${index}\n  HostName h.example\n`
    write(next, text)
  }
  const { text, problems } = readConfigWithIncludes(path.join(dir, 'f0'))
  check(`reading stops at the cap (${MAX_INCLUDE_DEPTH})`, problems.some(entry => entry.kind === 'too-deep'),
    JSON.stringify(problems.map(entry => entry.kind)))
  check('the shallow files were read', /Host h0/u.test(text), JSON.stringify(text.slice(0, 80)))
}

// ---------------------------------------------------------------------------
// 8. Quoted arguments and several arguments on one line
// ---------------------------------------------------------------------------
console.log('\n[8] quoting and multiple arguments')
{
  const dir = scratch()
  write(path.join(dir, 'main'), 'Include "one" two\n')
  write(path.join(dir, 'one'), 'Host one\n  HostName one.example\n')
  write(path.join(dir, 'two'), 'Host two\n  HostName two.example\n')
  const { text } = readConfigWithIncludes(path.join(dir, 'main'))
  check('quotes are stripped', /Host one/u.test(text), JSON.stringify(text))
  check('both arguments are read', /Host two/u.test(text), JSON.stringify(text))
}

// ---------------------------------------------------------------------------
// 9. A missing top-level file is empty, not a throw
// ---------------------------------------------------------------------------
console.log('\n[9] a missing config file')
{
  const dir = scratch()
  const { text, problems } = readConfigWithIncludes(path.join(dir, 'nope'))
  check('the text is empty', text === '', JSON.stringify(text))
  check('and nothing is reported (this is the normal first-run state)',
    problems.length === 0, JSON.stringify(problems))
}

// ---------------------------------------------------------------------------
// 10. expandGlob's own contract
// ---------------------------------------------------------------------------
console.log('\n[10] expandGlob')
{
  const dir = scratch()
  write(path.join(dir, 'a.conf'), 'x')
  write(path.join(dir, 'b.conf'), 'x')
  mkdirSync(path.join(dir, 'sub.conf'))
  check('a literal path returns itself', expandGlob(path.join(dir, 'a.conf')).length === 1,
    JSON.stringify(expandGlob(path.join(dir, 'a.conf'))))
  check('a missing literal returns nothing', expandGlob(path.join(dir, 'none')).length === 0)
  check('a glob skips directories', expandGlob(path.join(dir, '*.conf')).every(item => !item.endsWith('sub.conf')),
    JSON.stringify(expandGlob(path.join(dir, '*.conf'))))
  check('? matches exactly one character',
    expandGlob(path.join(dir, '?.conf')).length === 2, JSON.stringify(expandGlob(path.join(dir, '?.conf'))))
}

for (const cleanup of cleanups.reverse()) {
  try { cleanup() } catch { /* best effort */ }
}


  totalPassed += passed
  totalFailures += failures
})()

// ---------------------------------------------------------------------------
// match-eval-smoke.mjs
// ---------------------------------------------------------------------------
await (async () => {
/**
 * `Match` evaluation: what is decided, what is refused, and what is unknown.
 *
 * The three outcomes must stay three. "This block does not apply" is normal,
 * "this block could run a local command" is refused, and "I cannot tell" is
 * reported — collapsing any two of them is how O-10 became a security bug in the
 * first place.
 *
 * Run: node tests/match-eval-smoke.mjs
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
// `Match` evaluation and the `Host` pattern matcher it calls are one module
// now — they imported each other, which was the only functional cycle in `lib/`.
const { parseMatchConditions, matchSelects, patternMatches,
  EVALUABLE_CRITERIA, REFUSED_CRITERIA, DEFERRED_CRITERIA } =
  await import(pathToFileURL(path.join(pluginRoot, 'lib', 'hosts', 'ssh-config.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== match eval smoke ===\n')

// ---------------------------------------------------------------------------
// 1. The criteria are partitioned, and nothing is in two places
// ---------------------------------------------------------------------------
console.log('[1] every criterion has exactly one home')
{
  const all = [...EVALUABLE_CRITERIA, ...REFUSED_CRITERIA, ...DEFERRED_CRITERIA]
  check('no criterion is both evaluable and refused',
    ![...EVALUABLE_CRITERIA].some(item => REFUSED_CRITERIA.has(item)))
  check('no criterion is both refused and deferred',
    ![...REFUSED_CRITERIA].some(item => DEFERRED_CRITERIA.has(item)))
  check('exec is refused, not deferred',
    REFUSED_CRITERIA.has('exec') && !DEFERRED_CRITERIA.has('exec'))
  check('address is deferred, not refused',
    DEFERRED_CRITERIA.has('address') && !REFUSED_CRITERIA.has('address'))
  check('the partition has no duplicates', new Set(all).size === all.length, JSON.stringify(all))
}

// ---------------------------------------------------------------------------
// 2. host / originalhost
// ---------------------------------------------------------------------------
console.log('\n[2] host conditions, globbed like Host')
{
  check('an exact host matches', matchSelects(['host', 'web'], 'web').selects === true)
  check('a different host does not', matchSelects(['host', 'db'], 'web').selects === false)
  check('a glob matches', matchSelects(['host', 'web*'], 'web01').selects === true)
  check('a glob does not match a prefix', matchSelects(['host', 'prod*'], 'web01').selects === false)
  check('a ? matches one character', matchSelects(['host', 'we?'], 'web').selects === true)
  check('originalhost is the same fact here',
    matchSelects(['originalhost', 'web'], 'web').selects === true)
  check('a comma-separated list is split',
    matchSelects(['host', 'a,b'], 'b').selects === true, JSON.stringify(parseMatchConditions(['host', 'a,b'])))
  check('a negation excludes', matchSelects(['host', 'web,!web'], 'web').selects === false)
  // Matching itself is the same implementation the Host blocks use, and the
  // test pins that rather than trusting two copies to agree.
  check('the matcher is the same one Host blocks use',
    patternMatches('web*', 'web01') === true)
}

// ---------------------------------------------------------------------------
// 3. all
// ---------------------------------------------------------------------------
console.log('\n[3] `Match all`')
{
  check('all selects everyone', matchSelects(['all'], 'anything').selects === true)
  const parsed = parseMatchConditions(['all'])
  check('and takes no value', parsed.conditions.length === 1 && parsed.conditions[0].criterion === 'all',
    JSON.stringify(parsed))
}

// ---------------------------------------------------------------------------
// 4. exec is REFUSED, and refusing means selecting nobody
// ---------------------------------------------------------------------------
console.log('\n[4] `Match exec` is refused rather than run')
{
  const verdict = matchSelects(['exec', 'test', '-f', '/tmp/x'], 'web')
  check('the block selects nobody', verdict.selects === false, JSON.stringify(verdict))
  check('and the reason names exec', /exec/u.test(verdict.refused ?? ''),
    JSON.stringify(verdict))
  check('it is reported as REFUSED, not as undecidable', verdict.undecidable === undefined,
    JSON.stringify(verdict))
  // Even alongside a condition that matches: an undecided conjunction cannot be
  // true, and pretending otherwise would apply settings for an unchecked test.
  const mixed = matchSelects(['host', 'web', 'exec', 'true'], 'web')
  check('a matching host does not rescue an exec condition', mixed.selects === false,
    JSON.stringify(mixed))
}

// ---------------------------------------------------------------------------
// 5. Connection-dependent criteria are undecidable, not false
// ---------------------------------------------------------------------------
console.log('\n[5] criteria that need a connection are undecidable')
{
  for (const criterion of ['user', 'localuser', 'address', 'localaddress', 'port', 'final']) {
    const verdict = matchSelects([criterion, 'whatever'], 'web')
    check(`Match ${criterion} selects nobody`, verdict.selects === false, JSON.stringify(verdict))
    check(`...and says it cannot be decided`,
      typeof verdict.undecidable === 'string' && verdict.undecidable.includes(criterion),
      JSON.stringify(verdict))
  }
}

// ---------------------------------------------------------------------------
// 6. Unknown criteria
// ---------------------------------------------------------------------------
console.log('\n[6] an unknown criterion is reported')
{
  const parsed = parseMatchConditions(['frobnicate', 'x'])
  check('parsing records it', parsed.problems.some(problem => /unknown Match criterion/u.test(problem)),
    JSON.stringify(parsed.problems))
  const verdict = matchSelects(['frobnicate', 'x'], 'web')
  check('and it selects nobody', verdict.selects === false, JSON.stringify(verdict))
  check('as undecidable, not refused', verdict.undecidable !== undefined, JSON.stringify(verdict))
}

// ---------------------------------------------------------------------------
// 7. An empty or malformed Match line
// ---------------------------------------------------------------------------
console.log('\n[7] malformed lines select nobody')
{
  check('an empty Match line', matchSelects([], 'web').selects === false, JSON.stringify(matchSelects([], 'web')))
  check('host with no pattern', matchSelects(['host'], 'web').selects === false,
    JSON.stringify(matchSelects(['host'], 'web')))
  check('and it is reported', matchSelects(['host'], 'web').undecidable !== undefined,
    JSON.stringify(matchSelects(['host'], 'web')))
}

// ---------------------------------------------------------------------------
// 8. Several conditions are a conjunction
// ---------------------------------------------------------------------------
console.log('\n[8] several conditions all have to hold')
{
  check('both match', matchSelects(['host', 'web', 'originalhost', 'web'], 'web').selects === true)
  check('one fails', matchSelects(['host', 'web', 'originalhost', 'db'], 'web').selects === false)
  check('all plus host', matchSelects(['all', 'host', 'web'], 'web').selects === true)
}


  totalPassed += passed
  totalFailures += failures
})()

console.log(`\n=== ${totalPassed} passed, ${totalFailures} failed ===`)
if (totalFailures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}