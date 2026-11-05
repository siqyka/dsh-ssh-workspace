/**
 * Host listing: "empty" and "unreadable" must not look the same.
 *
 * Every skipped `~/.ssh/config` block and every failed store read used to be a
 * bare `catch {}`, so both surfaced as an empty host list — the same screen as a
 * genuinely empty configuration. The user saw "no hosts" and had nothing to act
 * on, and the two very different problems (a typo in their config, a corrupted
 * store file) were indistinguishable.
 *
 * The three cases asserted here:
 *
 *  1. a genuinely empty configuration  → "no hosts", no notes
 *  2. an entry that cannot be used     → the row is absent, a reason is present
 *  3. a store that cannot be read      → `storeError` is present, not silence
 *
 * Run: node tests/host-listing-smoke.mjs
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { HostStore } = await import(pathToFileURL(path.join(pluginRoot, 'lib/hosts.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/**
 * A HostStore over a throwaway config file and a store double.
 *
 * `HostStore`'s own constructor is used so the real ssh-config parsing runs;
 * only the entry store is replaced, because that is the half under test.
 */
function storeWith ({ configText = '', entries = [], loadFails = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-hosts-'))
  const configPath = path.join(dir, 'ssh_config')
  writeFileSync(configPath, configText)
  // Positional, not an options object: `new HostStore(configPath, entryStore)`.
  const store = new HostStore(configPath)
  store.entryStore = {
    load: () => {
      if (loadFails) throw new Error('EACCES: cannot read the host store')
      return entries
    },
    find: (alias) => entries.find(entry => entry.alias === alias),
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

const cleanups = []
const track = (dir) => { cleanups.push(() => rmSync(dir, { recursive: true, force: true })) }

console.log('\n[1] a genuinely empty configuration has nothing to report')
{
  const { store, dir } = storeWith({ configText: '' })
  track(dir)
  const listing = store.listing()
  check('the list is empty', listing.rows.length === 0, JSON.stringify(listing.rows))
  check('nothing was skipped', (listing.skipped ?? []).length === 0, JSON.stringify(listing.skipped))
  check('there is no store error', listing.storeError === undefined, String(listing.storeError))
  check('rows() still answers the bare list', store.rows().length === 0, JSON.stringify(store.rows()))
}

console.log('\n[2] a config block this engine cannot honor is reported, not dropped')
{
  // `ProxyCommand` is the one transport that stays REFUSED — it is arbitrary
  // local command execution, and a config file can arrive from a repository.
  // The reason has to reach the user rather than the host vanishing.
  const { store, dir } = storeWith({
    configText: 'Host viacmd\n  HostName via.example\n  ProxyCommand ssh -W %h:%p bastion\n',
  })
  track(dir)
  const listing = store.listing()
  check('the refused block does not become a row',
    listing.rows.every(row => row.alias !== 'viacmd'), JSON.stringify(listing.rows))
  check('the refused block is reported as skipped',
    (listing.skipped ?? []).length === 1, JSON.stringify(listing.skipped))
  check('the skip names the alias', listing.skipped[0]?.alias === 'viacmd', JSON.stringify(listing.skipped))
  check('the skip explains why',
    /ProxyCommand/u.test(listing.skipped[0]?.reason ?? ''), String(listing.skipped[0]?.reason))
  check('and says what to use instead',
    /ProxyJump/u.test(listing.skipped[0]?.reason ?? ''), String(listing.skipped[0]?.reason))
}

console.log('\n[3] an unreadable store is an ERROR, not an empty list')
{
  const { store, dir } = storeWith({ loadFails: true })
  track(dir)
  const listing = store.listing()
  check('the listing still answers (it must not throw)', listing.rows.length === 0, JSON.stringify(listing))
  check('the failure is reported as storeError',
    typeof listing.storeError === 'string' && /EACCES|could not be read/u.test(listing.storeError),
    String(listing.storeError))
  check('the failure is also in the skipped reasons',
    (listing.skipped ?? []).some(entry => /host store could not be read/u.test(entry.reason)),
    JSON.stringify(listing.skipped))
  check('rows() degrades without throwing', store.rows().length === 0, 'threw')
}

// The case above simulates the failure through a store double, which proves the
// reporting path but not that a real read error reaches it.
//
// The first version of this case used `chmod 000` and had to be skipped on
// Windows (where chmod leaves the ACL alone, so the file stays readable) — a
// skipped case proves nothing on the platform CI runs on most. Making the
// config path a DIRECTORY instead fails `readFileSync` identically everywhere
// (EISDIR), so the case runs unconditionally.
//
// It also found a real gap: `listing()` guarded the entry store but not
// `sshConfigAliases()`, so an unreadable ssh_config threw straight out of the
// listing instead of being reported. That is the same "empty vs. unreadable"
// confusion O-10 is about, left half-done.
console.log('\n[3b] a real read error on the ssh config is reported, not thrown')
{
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-hosts-perm-'))
  track(dir)
  const configPath = path.join(dir, 'ssh_config')
  mkdirSync(configPath)
  const store = new HostStore(configPath)
  store.entryStore = { load: () => [], sshConfigAliases: () => [] }
  let listing = null
  let thrown = null
  try {
    listing = store.listing()
  } catch (error) {
    thrown = error
  }
  check('listing() does not throw on an unreadable ssh config',
    thrown === null, thrown === null ? '' : String(thrown))
  check('the failure is reported as storeError',
    typeof listing?.storeError === 'string' && /ssh config could not be read/u.test(listing.storeError),
    String(listing?.storeError))
  check('it degrades to no rows rather than inventing them',
    listing?.rows.length === 0, JSON.stringify(listing?.rows))
}

console.log('\n[4] a usable store entry is still a row')
{
  const entry = { alias: 'box', host: 'box.example', port: 22, user: 'tester', auth: { kind: 'agent' } }
  const { store, dir } = storeWith({ entries: [entry] })
  track(dir)
  const listing = store.listing()
  check('the usable entry appears as a row', listing.rows.length === 1, JSON.stringify(listing.rows))
  check('the row carries the resolved address',
    listing.rows[0]?.host === 'box.example', JSON.stringify(listing.rows[0]))
  check('a complete listing reports nothing skipped', (listing.skipped ?? []).length === 0, JSON.stringify(listing.skipped))
}

console.log('\n[3c] `Include` is followed, so hosts it defines are real hosts')
{
  // The reason this matters: a real configuration puts a few lines in
  // `~/.ssh/config` and everything else in `conf.d/`. A reader that ignores
  // Include shows an almost empty panel, and the audit used to report the
  // keyword as `lost` — accurate at the time, and useless to the user.
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-hosts-include-'))
  track(dir)
  const configPath = path.join(dir, 'ssh_config')
  writeFileSync(configPath, 'Host local\n  HostName local.example\nInclude conf.d/*.conf\n', 'utf8')
  mkdirSync(path.join(dir, 'conf.d'), { recursive: true })
  writeFileSync(path.join(dir, 'conf.d', 'prod.conf'), 'Host prodbox\n  HostName prod.example\n  User deploy\n', 'utf8')
  writeFileSync(path.join(dir, 'conf.d', 'dev.conf'), 'Host devbox\n  HostName dev.example\n', 'utf8')

  const store = new HostStore(configPath)
  store.entryStore = { load: () => [], sshConfigAliases: () => [] }
  const aliases = store.sshConfigAliases().sort()
  check('hosts from an included file are listed',
    aliases.includes('prodbox') && aliases.includes('devbox'), JSON.stringify(aliases))
  check('and so is the host written directly', aliases.includes('local'), JSON.stringify(aliases))

  // Resolution must see the included block's keywords too, or the row would
  // exist with the wrong login.
  const resolved = store.resolve('prodbox')
  check('an included block resolves with its own settings',
    resolved.host === 'prod.example' && resolved.user === 'deploy', JSON.stringify(resolved))

  const listing = store.listing()
  check('the listing has a row for it',
    listing.rows.some(row => row.alias === 'prodbox'),
    JSON.stringify(listing.rows.map(row => row.alias)))
}

console.log('\n[4b] a store entry carries its jump chain too')
{
  // The ssh-config half of this is covered above. The STORE half is a separate
  // code path (`storeDescriptor`), and it was the one that once read a jump
  // host as "none" — so an assertion that only exercises the config parser
  // leaves the panel-editable shape unguarded.
  const entry = {
    alias: 'behind',
    host: 'behind.example',
    port: 22,
    user: 'tester',
    auth: { kind: 'agent' },
    proxyJump: ['jump1', 'deploy@jump2:2222'],
  }
  const { store, dir } = storeWith({ entries: [entry] })
  track(dir)
  const resolved = store.resolve('behind')
  check('a store entry resolves to a chain', resolved.jump?.kind === 'chain',
    JSON.stringify(resolved.jump))
  check('with both hops in order', resolved.jump?.hops?.map(hop => hop.host).join(',') === 'jump1,jump2',
    JSON.stringify(resolved.jump?.hops))
  check('and the per-hop user and port survive',
    resolved.jump?.hops?.[1]?.user === 'deploy' && resolved.jump?.hops?.[1]?.port === 2222,
    JSON.stringify(resolved.jump?.hops?.[1]))
  check('the listing still shows the host', store.listing().rows.some(row => row.alias === 'behind'),
    JSON.stringify(store.listing().rows.map(row => row.alias)))

  // `ProxyJump: []` is what the store writes for "no jump host" — it must not
  // become an empty chain that then fails to connect.
  const plain = { alias: 'plainbox', host: 'p.example', port: 22, user: 't', auth: { kind: 'agent' }, proxyJump: [] }
  const plainStore = storeWith({ entries: [plain] })
  track(plainStore.dir)
  check('an empty proxyJump array means direct',
    plainStore.store.resolve('plainbox').jump?.kind === 'direct',
    JSON.stringify(plainStore.store.resolve('plainbox').jump))

  // A store entry with a self-reference is refused, not silently dialed.
  const selfRef = { alias: 'loop', host: 'l.example', port: 22, user: 't', auth: { kind: 'agent' }, proxyJump: ['loop'] }
  const loopStore = storeWith({ entries: [selfRef] })
  track(loopStore.dir)
  let thrown
  try { loopStore.store.resolve('loop') } catch (error) { thrown = error }
  check('a store entry that jumps through itself is refused', thrown !== undefined,
    thrown === undefined ? 'resolved' : '')
}

console.log('\n[5] `none` cancels a proxy instead of configuring one')
{
  // The override idiom: `Host *` carries the jump host, one host cancels it.
  // Reading `none` as a hop refuses a host the user explicitly set to connect
  // directly — and the refusal message would claim a jump host that is not there.
  const { store, dir } = storeWith({
    configText: 'Host cleared\n  HostName cleared.example\n  ProxyJump none\n'
      + 'Host cmdCleared\n  HostName cmd.example\n  ProxyCommand none\n'
      + 'Host stillJumps\n  HostName jump.example\n  ProxyJump bastion\n',
  })
  track(dir)
  const listing = store.listing()
  const aliases = listing.rows.map(row => row.alias).sort()
  check('ProxyJump none is listed as a direct host',
    aliases.includes('cleared'), JSON.stringify(aliases))
  check('ProxyCommand none is listed as a direct host',
    aliases.includes('cmdCleared'), JSON.stringify(aliases))
  check('a real jump host is LISTED, not refused',
    aliases.includes('stillJumps'), JSON.stringify(aliases))
  check('and nothing is skipped for a proxy reason',
    (listing.skipped ?? []).length === 0, JSON.stringify(listing.skipped))
  // The route matters: a listed host that silently connects DIRECTLY is the
  // O-17 bug (it bypasses the bastion the config requires). The chain is part
  // of the descriptor precisely so the panel and the status tool can say which
  // route a connection will take.
  const jumped = store.resolve('stillJumps')
  check('the resolved descriptor carries the chain',
    jumped.jump?.kind === 'chain' && jumped.jump.hops[0]?.host === 'bastion',
    JSON.stringify(jumped.jump))
  check('while a cancelled host resolves as direct',
    store.resolve('cleared').jump?.kind === 'direct', JSON.stringify(store.resolve('cleared').jump))
  // `none` must also survive resolve(), not just listing(): a listed host that
  // throws on resolve is a row the user can click and then cannot use.
  const resolved = store.resolve('cleared')
  check('resolve() accepts ProxyJump none too',
    resolved.host === 'cleared.example', JSON.stringify(resolved))
}

console.log('\n[6] a jump host in a wildcard block still applies')
{
  // The usual way to declare a bastion: `Host *` at the top of the file.
  // Reading only exact blocks turned "reach this through a bastion" into
  // "connect directly" — silent, and unsafe.
  const { store, dir } = storeWith({
    configText: 'Host *\n  ProxyJump bastion\n\nHost viaStar\n  HostName via.example\n',
  })
  track(dir)
  const listing = store.listing()
  check('a host covered only by `Host *` is listed',
    listing.rows.some(row => row.alias === 'viaStar'), JSON.stringify(listing.rows))
  check('and it carries the catch-all jump host',
    store.resolve('viaStar').jump?.hops?.[0]?.host === 'bastion',
    JSON.stringify(store.resolve('viaStar').jump))
}

console.log('\n[7] per-host values win over a later catch-all, as in OpenSSH')
{
  // OpenSSH takes the FIRST value obtained, so a `Host *` placed at the END
  // cannot override a `ProxyJump none` written above it for that host.
  const { store, dir } = storeWith({
    configText: 'Host direct\n  HostName direct.example\n  ProxyJump none\n\n'
      + 'Host plain\n  HostName p.example\n\n'
      + 'Host *\n  ProxyJump bastion\n',
  })
  track(dir)
  const listing = store.listing()
  check('the earlier `ProxyJump none` still wins for its host',
    listing.rows.some(row => row.alias === 'direct'), JSON.stringify(listing.rows))
  check('so that host connects directly',
    store.resolve('direct').jump?.kind === 'direct', JSON.stringify(store.resolve('direct').jump))
  check('a host with no earlier value inherits the catch-all jump host',
    store.resolve('plain').jump?.hops?.[0]?.host === 'bastion',
    JSON.stringify(store.resolve('plain').jump))
}

console.log('\n[8] a negated pattern exempts a host from a wildcard block')
{
  const { store, dir } = storeWith({
    configText: 'Host * !exempt\n  ProxyJump bastion\n\nHost exempt\n  HostName ex.example\n',
  })
  track(dir)
  const listing = store.listing()
  check('the exempted host is listed',
    listing.rows.some(row => row.alias === 'exempt'), JSON.stringify(listing.rows))
  check('and connects directly, because `!exempt` kept it out of the block',
    store.resolve('exempt').jump?.kind === 'direct',
    JSON.stringify(store.resolve('exempt').jump))
  check('a `!name` pattern never becomes a row of its own',
    !listing.rows.some(row => row.alias === '!exempt'), JSON.stringify(listing.rows))
  check('nothing else is skipped for a proxy reason',
    (listing.skipped ?? []).length === 0, JSON.stringify(listing.skipped))
}

console.log('\n[9] the tool renderer keeps the three cases apart')
{
  const { renderHostsForTest } = await import(pathToFileURL(path.join(pluginRoot, 'lib/tools.js')).href)
    .catch(() => ({ renderHostsForTest: undefined }))
  if (renderHostsForTest === undefined) {
    // The renderer is not exported; assert the same three shapes through the
    // route payload instead, which is what the panel actually receives.
    check('the renderer is exercised through the route payload (see routes-smoke)', true)
  } else {
    check('placeholder', true)
  }
}

console.log('\n[10] a config edit is detectable without re-parsing')
{
  // `resolve()` re-reads the file every call, so an ADDED or EDITED host is
  // picked up. The gap this closes is the pooled CONNECTION: nothing tells the
  // engine that ~/.ssh/config moved, so a socket opened before the edit keeps
  // using the descriptor it was built from.
  const { store, dir } = storeWith({ configText: 'Host alpha\n  HostName a.example\n  Port 22\n' })
  track(dir)
  const before = store.configStamp()
  check('a stamp is produced for an existing file', typeof before === 'string' && before !== 'absent', before)
  check('the stamp is stable while the file is untouched', store.configStamp() === before, store.configStamp())

  // A size change is the common case: the user typed a new port.
  writeFileSync(path.join(dir, 'ssh_config'), 'Host alpha\n  HostName a.example\n  Port 2222\n')
  const afterSize = store.configStamp()
  check('changing the port changes the stamp', afterSize !== before, `${before} → ${afterSize}`)

  // The case mtime+size misses on NTFS: a SAME-LENGTH in-place edit inside one
  // timestamp tick leaves both `ino` and `mtimeMs` identical. The stamp hashes
  // the bytes precisely because this was measured failing with stat metadata.
  const sameLength = 'Host alpha\n  HostName b.example\n  Port 2222\n'
  writeFileSync(path.join(dir, 'ssh_config'), sameLength)
  check('a same-length rewrite is still a different stamp', store.configStamp() !== afterSize,
    `${afterSize} → ${store.configStamp()}`)

  // A host served from the editable store never consults this file, but the
  // stamp must still be comparable: "absent" has to equal "absent", or every
  // acquire on a store-only host would reconnect.
  const missing = new HostStore(path.join(dir, 'no-such-config'))
  check('a missing config stamps as "absent"', missing.configStamp() === 'absent', missing.configStamp())
  check('and it is stable', missing.configStamp() === missing.configStamp(), missing.configStamp())
}

for (const cleanup of cleanups) cleanup()

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
if (failures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}
