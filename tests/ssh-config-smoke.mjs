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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { sectionsOf, selects, isExact, patternMatches } = await import(pathToFileURL(path.join(pluginRoot, 'lib/ssh-config.js')).href)
const { HostStore } = await import(pathToFileURL(path.join(pluginRoot, 'lib/hosts.js')).href)
const { auditConfigText, KNOWN_UNSUPPORTED, verdictFor } = await import(pathToFileURL(path.join(pluginRoot, 'lib/config-audit.js')).href)

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
  const { CONFIG_LINE } = await import(pathToFileURL(path.join(pluginRoot, 'lib/ssh-config.js')).href)
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

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
if (failures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}
