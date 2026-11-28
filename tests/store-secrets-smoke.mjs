/**
 * store-secrets smoke suite: store-lock, secrets, recent-hosts merged.
 *
 * Every assertion from the original suites is kept; each source suite is its own
 * section below. Run: node tests/store-secrets-smoke.mjs
 */

import path from 'node:path'
import { HostStore } from '../lib/hosts/hosts.js'
import { HostConfigStore, SecretCodec, isEncrypted, keyPath } from '../lib/hosts/store.js'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

let totalPassed = 0
let totalFailures = 0

await (async () => {
// ---------------------------------------------------------------------------
// store-lock-smoke.mjs
// ---------------------------------------------------------------------------
/**
 * Behavioural check for 6.4: the store's cross-process write lock.
 *
 * `#writeDocument` is read-modify-write; two DSH instances editing the same
 * $DSH_HOME/dsh-ssh.json used to let the later rename silently discard the
 * other's section. The lock is a sibling `*.lock` created with `open(...,'wx')`,
 * which is atomic on POSIX and Windows alike.
 *
 */
const here = path.dirname(fileURLToPath(import.meta.url))

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const entry = (alias) => ({ alias, host: `${alias}.example`, port: 22, user: 'u', auth: { kind: 'agent' } })
const readDoc = (file) => JSON.parse(readFileSync(file, 'utf8'))
const aliasesOf = (file) => readDoc(file).hosts.map(h => h.alias)

console.log('\n=== store lock smoke ===\n')

// --- basic write + lock hygiene -------------------------------------------
{
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-store-lock-'))
  const file = path.join(dir, 'dsh-ssh.json')
  try {
    const store = new HostConfigStore(file)
    store.save([entry('alpha')])
    check('a plain save persists the entries', JSON.stringify(aliasesOf(file)) === '["alpha"]', JSON.stringify(aliasesOf(file)))
    check('no lock file is left behind', !existsSync(`${file}.lock`))

    const second = new HostConfigStore(file)
    second.save([...second.load(), entry('beta')])
    check('a second writer merges onto what is already there',
      JSON.stringify(aliasesOf(file)) === '["alpha","beta"]', JSON.stringify(aliasesOf(file)))

    // A section this plugin does not own must survive a rewrite.
    const doc = readDoc(file)
    doc.foreignSection = { keep: true }
    writeFileSync(file, JSON.stringify(doc, null, 2))
    store.save([...store.load(), entry('gamma')])
    check('a foreign top-level section survives a rewrite',
      readDoc(file).foreignSection?.keep === true)

    // A stale lock (dead writer) is taken over rather than blocking forever.
    writeFileSync(`${file}.lock`, 'stale')
    const old = new Date(Date.now() - 60_000)
    utimesSync(`${file}.lock`, old, old)
    const started = Date.now()
    store.save([...store.load(), entry('delta')])
    const elapsed = Date.now() - started
    check('a stale lock is taken over instead of deadlocking', elapsed < 3000, `${elapsed}ms`)
    check('the takeover still wrote the entry', aliasesOf(file).includes('delta'), JSON.stringify(aliasesOf(file)))
    check('the lock is gone after the takeover write', !existsSync(`${file}.lock`))

    // A fresh lock is respected: the writer waits, then still completes.
    writeFileSync(`${file}.lock`, 'held')
    const waitStart = Date.now()
    const worker = spawnSync(process.execPath, [
      '-e',
      `import(${JSON.stringify(new URL('../lib/hosts/store.js', import.meta.url).href)}).then(m => {
         const s = new m.HostConfigStore(${JSON.stringify(file)});
         s.save([...s.load(), ${JSON.stringify(entry('waited'))}]);
       })`,
    ], { encoding: 'utf8', timeout: 20_000 })
    const waitElapsed = Date.now() - waitStart
    check('a live lock makes the writer wait rather than clobber',
      waitElapsed >= 300, `${waitElapsed}ms`)
    check('the waiting writer still completed',
      worker.status === 0 && aliasesOf(file).includes('waited'),
      `${worker.status} ${worker.stderr?.slice(0, 200)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- two processes editing concurrently must not lose either side ----------
{
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-store-race-'))
  const file = path.join(dir, 'dsh-ssh.json')
  try {
    new HostConfigStore(file).save([])
    const aliases = Array.from({ length: 6 }, (_, i) => `host${i}`)
    // mutateHosts reads and writes inside one locked section, which is what
    // makes concurrent add-a-host safe across processes.
    const script = `import(${JSON.stringify(new URL('../lib/hosts/store.js', import.meta.url).href)}).then(m => {
      const s = new m.HostConfigStore(${JSON.stringify(file)});
      for (let i = 0; i < 12; i += 1) {
        const alias = process.argv[1] + '-' + i;
        s.mutateHosts(entries => [...entries, { alias, host: alias + '.example', port: 22, user: 'u', auth: { kind: 'agent' } }]);
      }
    })`

    const { spawn } = await import('node:child_process')
    const running = aliases.map(alias => new Promise((resolve) => {
      const child = spawn(process.execPath, ['-e', script, alias], { stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', (chunk) => { stderr += chunk })
      child.on('close', (status) => resolve({ alias, status, stderr }))
    }))
    const results = await Promise.all(running)

    check('every concurrent writer exited cleanly',
      results.every(r => r.status === 0),
      results.filter(r => r.status !== 0).map(r => `${r.alias}: ${r.stderr.slice(0, 160)}`).join(' | '))

    const final = new Set(aliasesOf(file))
    const expected = aliases.length * 12
    check(`concurrent mutateHosts loses nothing (${final.size}/${expected})`,
      final.size === expected, `missing ${expected - final.size}`)
    check('no lock file is left behind after the race', !existsSync(`${file}.lock`))
    check('no staging temp files are left behind',
      readdirSync(dir).filter(n => n.includes('.tmp-')).length === 0,
      JSON.stringify(readdirSync(dir)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- save() is replace-semantics; document that the lock cannot rescue it ---
{
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-store-replace-'))
  const file = path.join(dir, 'dsh-ssh.json')
  try {
    writeFileSync(file, '{}')
    const a = new HostConfigStore(file)
    const b = new HostConfigStore(file)
    const aSnapshot = a.load()
    const bSnapshot = b.load()
    a.save([...aSnapshot, entry('a1')])
    b.save([...bSnapshot, entry('b1')])
    // Both writes are locked and atomic, but b's base predates a's commit.
    check('save() from a stale snapshot replaces rather than merges (documented behaviour)',
      JSON.stringify(aliasesOf(file)) === '["b1"]', JSON.stringify(aliasesOf(file)))

    // The same interleaving through mutateHosts keeps both.
    writeFileSync(file, '{}')
    const c = new HostConfigStore(file)
    const d = new HostConfigStore(file)
    c.mutateHosts(entries => [...entries, entry('c1')])
    d.mutateHosts(entries => [...entries, entry('d1')])
    check('the same interleaving via mutateHosts keeps both entries',
      JSON.stringify(aliasesOf(file)) === '["c1","d1"]', JSON.stringify(aliasesOf(file)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

  totalPassed += (typeof passed !== 'undefined' ? passed : (typeof passes !== 'undefined' ? passes : 0))
  totalFailures += (typeof failures !== 'undefined' ? (Array.isArray(failures) ? failures.length : failures) : 0)
})()

await (async () => {
// ---------------------------------------------------------------------------
// secrets-smoke.mjs
// ---------------------------------------------------------------------------
/**
 * Encrypted-secret checks: at-rest encryption of stored SSH secrets.
 *
 * The shared host store must never hold a password or key passphrase in
 * plaintext. This suite drives the store directly (no DSH tree, no SSH host):
 * it writes hosts with secrets, and inspects both the file on disk and what the
 * store hands back to the engine.
 *
 */
console.log('\n=== secrets smoke ===\n')

const home = mkdtempSync(path.join(tmpdir(), 'dsh-secrets-'))
process.env.DSH_HOME = home
const storeFile = path.join(home, 'dsh-ssh.json')
const sshConfig = path.join(home, 'ssh_config')
writeFileSync(sshConfig, '', 'utf8')

const read = () => readFileSync(storeFile, 'utf8')
const parsed = () => JSON.parse(read())

let failures = 0
let passes = 0
function check (label, ok, detail) {
  if (ok) {
    passes += 1
    console.log(`  PASS  ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

function entry (alias, auth) {
  return { alias, host: `${alias}.example.com`, port: 22, user: 'root', auth }
}

try {
  const store = new HostConfigStore(storeFile)
  check('the key file is only created on demand', !existsSync(keyPath()))

  // -- create: the password reaches the file only as ciphertext -------------
  store.create(entry('alpha', { kind: 'password', password: 'hunter2' }))
  const alpha = parsed().hosts.find(item => item.alias === 'alpha')
  check('password is not written in plaintext', !read().includes('hunter2'))
  check('entry auth carries no secret field', alpha.auth.password === undefined && alpha.auth.kind === 'password', JSON.stringify(alpha.auth))
  check('ciphertext is stored under the plugin-owned section', isEncrypted(parsed().secrets?.alpha?.password))
  check('secretFor decrypts back to the original value', store.secretFor('alpha')?.password === 'hunter2', JSON.stringify(store.secretFor('alpha')))
  check('the key file exists once a secret is stored', existsSync(keyPath()))

  // -- key file ------------------------------------------------------------
  const rawKey = Buffer.from(readFileSync(keyPath(), 'utf8').trim(), 'base64')
  check('key file holds a 32-byte key', rawKey.length === 32, `length=${rawKey.length}`)
  if (process.platform !== 'win32') {
    check('key file is owner-only (0600)', (statSync(keyPath()).mode & 0o777) === 0o600, `mode=${(statSync(keyPath()).mode & 0o777).toString(8)}`)
  }

  // -- blank field keeps the stored secret ---------------------------------
  store.update('alpha', entry('alpha', { kind: 'password', password: '' }))
  check('a blank password keeps the stored secret', store.secretFor('alpha')?.password === 'hunter2')
  store.update('alpha', entry('alpha', { kind: 'password', password: 'hunter3' }))
  check('a new password replaces the stored secret', store.secretFor('alpha')?.password === 'hunter3')
  check('the replaced value is never written in plaintext', !read().includes('hunter3'))

  // -- create without a password is still rejected -------------------------
  let refused = false
  try {
    store.create(entry('nopass', { kind: 'password', password: '' }))
  } catch (error) {
    refused = /a password is required/u.test(String(error.message))
  }
  check('password auth without a password is rejected', refused)

  // -- non-password auth stores no secret ----------------------------------
  store.create(entry('gamma', { kind: 'agent' }))
  check('agent auth stores no secret entry', parsed().secrets?.gamma === undefined)
  check('secretFor is undefined without a secret', store.secretFor('gamma') === undefined)

  // -- rename moves the secret, delete drops it ----------------------------
  store.update('alpha', entry('beta', { kind: 'password', password: '' }))
  check('rename moves the secret to the new alias', parsed().secrets?.alpha === undefined && store.secretFor('beta')?.password === 'hunter3')
  store.delete('beta')
  check('delete drops the stored secret', parsed().secrets?.beta === undefined && parsed().hosts.every(item => item.alias !== 'beta'))

  // -- the engine-facing descriptor gets the decrypted value ---------------
  const hosts = new HostStore(sshConfig, store)
  store.create(entry('delta', { kind: 'password', password: 'open-sesame' }))
  check('resolve hands the decrypted password to the engine', hosts.resolve('delta').auth.password === 'open-sesame')

  // -- startup migration of legacy plaintext -------------------------------
  const legacy = {
    version: 1,
    hosts: [
      { alias: 'legacy', host: 'legacy.example.com', port: 22, user: 'root', auth: { kind: 'password', password: 'old-pass' } },
      { alias: 'legacykey', host: 'legacykey.example.com', port: 22, user: 'root', auth: { kind: 'key', keyPath: '/tmp/id_ed25519', passphrase: 'old-phrase' } },
      { alias: 'plain', host: 'plain.example.com', port: 22, user: 'root', auth: { kind: 'agent' } },
    ],
    knownHosts: { legacy: { fingerprint: 'SHA256:x' } },
  }
  writeFileSync(storeFile, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8')
  const legacyStore = new HostConfigStore(storeFile)
  const migrated = legacyStore.encryptStoredSecrets()
  check('migration reports both hosts', migrated === 2, `migrated=${migrated}`)
  check('migration leaves no plaintext behind', !read().includes('old-pass') && !read().includes('old-phrase'))
  check('migration preserves the decrypted secrets', legacyStore.secretFor('legacy')?.password === 'old-pass' && legacyStore.secretFor('legacykey')?.passphrase === 'old-phrase')
  check('migration drops the secret from the entry', parsed().hosts.find(item => item.alias === 'legacy').auth.password === undefined)
  check('migration keeps the unknown sections', parsed().knownHosts?.legacy?.fingerprint === 'SHA256:x')
  const stamp = statSync(storeFile).mtimeMs
  check('a second migration is a no-op', legacyStore.encryptStoredSecrets() === 0 && statSync(storeFile).mtimeMs === stamp)

  // -- a different key cannot open the store -------------------------------
  const otherKey = path.join(home, 'other.key')
  writeFileSync(otherKey, `${Buffer.alloc(32, 7).toString('base64')}\n`, 'utf8')
  const foreign = new HostConfigStore(storeFile, new SecretCodec({ path: otherKey }))
  let foreignError
  try {
    foreign.secretFor('legacy')
  } catch (error) {
    foreignError = String(error.message)
  }
  check('a foreign key fails loudly', typeof foreignError === 'string' && /cannot read the stored secret for host/u.test(foreignError), foreignError)

  // -- a plaintext secret from ~/.ssh/config still resolves ----------------
  writeFileSync(sshConfig, 'Host fromconfig\n  HostName 10.0.0.9\n  User deploy\n  Password mine\n', 'utf8')
  check('ssh-config plaintext keeps working', new HostStore(sshConfig, store).resolve('fromconfig').auth.password === 'mine')
  check('ssh-config is never rewritten as ciphertext', readFileSync(sshConfig, 'utf8').includes('Password mine'))
  // The key file outlives every edit and the ssh-config fallback: only the
  // deletion of the last secret would let it go. It is named for that claim,
  // not repeated from the "on demand" assertion at the top — a duplicate label
  // makes two opposite conditions look like one passing test.
  check('the key file survives edits and the ssh-config fallback', existsSync(keyPath()))
} finally {
  rmSync(home, { recursive: true, force: true })
}

// -- migration from the legacy root paths ----------------------------------
//
// Older releases kept dsh-ssh.json / dsh-ssh.key directly under $DSH_HOME.
// The default store must read them there and write the document to the new
// private subdirectory on the first save, without losing hosts or secrets.
{
  const legacyHome = mkdtempSync(path.join(tmpdir(), 'dsh-migrate-'))
  process.env.DSH_HOME = legacyHome
  const legacyJson = path.join(legacyHome, 'dsh-ssh.json')
  const legacyKey = path.join(legacyHome, 'dsh-ssh.key')
  const newDir = path.join(legacyHome, 'dsh-ssh-workspace')
  const newJson = path.join(newDir, 'dsh-ssh.json')
  const newKey = path.join(newDir, 'dsh-ssh.key')
  const migratedEntry = { alias: 'legacy-host', host: 'legacy.example.com', port: 22, user: 'root', auth: { kind: 'password' } }
  // A real key so the ciphertext in the legacy document is decryptable.
  const codec = new SecretCodec({ path: legacyKey })
  const cipher = codec.encrypt('legacy-secret')
  writeFileSync(legacyJson, `${JSON.stringify({
    version: 1,
    hosts: [migratedEntry],
    secrets: { 'legacy-host': { password: cipher } },
    knownHosts: { 'legacy-host': { fingerprint: 'SHA256:x' } },
  }, null, 2)}\n`, 'utf8')
  // Ensure the legacy key exists (encrypt created it lazily).

  const store = new HostConfigStore()
  check('default store reads hosts from the legacy root path', store.find('legacy-host')?.host === 'legacy.example.com')
  check('default store decrypts a secret with the legacy key', store.secretFor('legacy-host')?.password === 'legacy-secret')
  check('default store creates no new file before a write', !existsSync(newJson))

  // A write must migrate the whole document into the private subdirectory.
  store.create({ alias: 'fresh', host: 'fresh.example.com', port: 22, user: 'root', auth: { kind: 'password', password: 'fresh-pass' } })
  check('first write creates the private subdirectory', existsSync(newDir))
  check('first write migrates the document to the new path', existsSync(newJson))
  check('migrated document keeps the legacy host', new HostConfigStore(newJson).find('legacy-host') !== undefined)
  check('migrated document keeps the new host', new HostConfigStore(newJson).find('fresh') !== undefined)
  check('migrated document keeps unknown sections', JSON.parse(readFileSync(newJson, 'utf8')).knownHosts?.['legacy-host']?.fingerprint === 'SHA256:x')
  check('migrated document keeps the legacy secret', store.secretFor('legacy-host')?.password === 'legacy-secret')
  // The legacy key stays the source of truth; no duplicate is generated.
  check('no duplicate key is generated during migration', !existsSync(newKey))

  rmSync(legacyHome, { recursive: true, force: true })
}

  totalPassed += (typeof passed !== 'undefined' ? passed : (typeof passes !== 'undefined' ? passes : 0))
  totalFailures += (typeof failures !== 'undefined' ? (Array.isArray(failures) ? failures.length : failures) : 0)
})()

await (async () => {
// ---------------------------------------------------------------------------
// recent-hosts-smoke.mjs
// ---------------------------------------------------------------------------
/**
 * Recent-host ordering: which hosts climb the list, and which must not.
 *
 * The rule is narrow on purpose — "recently USED", where used means a connection
 * actually succeeded. A listing that reordered on mere inspection, or on a
 * failed attempt, would teach the user that the order means nothing.
 *
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const { HostConfigStore } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'hosts', 'store.js')).href)
const { HostStore } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'hosts', 'hosts.js')).href)

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
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-recent-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A store over a real file, so `#withDocumentLock` is exercised. */
function storeWith (entries, configText = '') {
  const dir = scratch()
  const storeFile = path.join(dir, 'hosts.json')
  writeFileSync(storeFile, JSON.stringify({ version: 1, hosts: entries }, null, 2), 'utf8')
  const configPath = path.join(dir, 'ssh_config')
  writeFileSync(configPath, configText, 'utf8')
  const entryStore = new HostConfigStore(storeFile)
  return { store: new HostStore(configPath, entryStore), entryStore, dir, storeFile }
}

const entry = (alias) => ({ alias, host: `${alias}.example`, port: 22, user: 'tester', auth: { kind: 'agent' } })

console.log('\n=== recent hosts smoke ===\n')

// ---------------------------------------------------------------------------
// 1. Recording and reading back
// ---------------------------------------------------------------------------
console.log('[1] a used host is remembered')
{
  const { entryStore } = storeWith([entry('a')])
  check('nothing is recent to start with',
    Object.keys(entryStore.recentHosts()).length === 0, JSON.stringify(entryStore.recentHosts()))
  entryStore.noteHostUsed('a', 1000)
  check('a use is recorded', entryStore.recentHosts().a === 1000,
    JSON.stringify(entryStore.recentHosts()))
  entryStore.noteHostUsed('a', 2000)
  check('a later use replaces the earlier one', entryStore.recentHosts().a === 2000,
    JSON.stringify(entryStore.recentHosts()))
  check('an empty alias is ignored', (entryStore.noteHostUsed(''), true) && Object.keys(entryStore.recentHosts()).length === 1,
    JSON.stringify(entryStore.recentHosts()))
}

// ---------------------------------------------------------------------------
// 2. The cap
// ---------------------------------------------------------------------------
console.log('\n[2] the section stays bounded')
{
  const { entryStore } = storeWith([entry('a')])
  for (let index = 0; index < 150; index += 1) entryStore.noteHostUsed(`h${index}`, 1000 + index)
  const recent = entryStore.recentHosts()
  check('the map is capped at 100', Object.keys(recent).length === 100, String(Object.keys(recent).length))
  check('the OLDEST are the ones dropped', recent.h0 === undefined && recent.h149 !== undefined,
    JSON.stringify({ has0: recent.h0, has149: recent.h149 }))
}

// ---------------------------------------------------------------------------
// 3. Ordering in the listing
// ---------------------------------------------------------------------------
console.log('\n[3] the listing puts used hosts first')
{
  const { store, entryStore } = storeWith([entry('a'), entry('b'), entry('c')])
  check('file order before anything is used',
    store.listing().rows.map(row => row.alias).join(',') === 'a,b,c',
    JSON.stringify(store.listing().rows.map(row => row.alias)))

  entryStore.noteHostUsed('c', 1000)
  check('the used host moves to the top',
    store.listing().rows.map(row => row.alias).join(',') === 'c,a,b',
    JSON.stringify(store.listing().rows.map(row => row.alias)))

  entryStore.noteHostUsed('b', 2000)
  check('the most recent comes first',
    store.listing().rows.map(row => row.alias).join(',') === 'b,c,a',
    JSON.stringify(store.listing().rows.map(row => row.alias)))

  check('and the timestamp travels with the row',
    store.listing().rows.find(row => row.alias === 'b')?.lastUsedAt === 2000,
    JSON.stringify(store.listing().rows.find(row => row.alias === 'b')))
}

// ---------------------------------------------------------------------------
// 4. A host with NO store entry can be recent too
// ---------------------------------------------------------------------------
console.log('\n[4] an ssh-config host can be recent as well')
{
  // The reason `recent` is its own section rather than a field on an entry:
  // there is no entry to write to for a host that only exists in ~/.ssh/config.
  const { store, entryStore } = storeWith([entry('stored')], 'Host confonly\n  HostName c.example\n')
  entryStore.noteHostUsed('confonly', 5000)
  const order = store.listing().rows.map(row => row.alias)
  check('the config-only host is first', order[0] === 'confonly', JSON.stringify(order))
  check('and carries its timestamp',
    store.listing().rows.find(row => row.alias === 'confonly')?.lastUsedAt === 5000,
    JSON.stringify(store.listing().rows.find(row => row.alias === 'confonly')))
}

// ---------------------------------------------------------------------------
// 5. A stale alias does not corrupt the order
// ---------------------------------------------------------------------------
console.log('\n[5] a remembered alias that no longer exists is harmless')
{
  const { store, entryStore } = storeWith([entry('a'), entry('b')])
  entryStore.noteHostUsed('gone', 9999)
  const order = store.listing().rows.map(row => row.alias)
  check('a removed host is not resurrected as a row', !order.includes('gone'), JSON.stringify(order))
  check('the surviving order is unaffected', order.join(',') === 'a,b', JSON.stringify(order))
}

// ---------------------------------------------------------------------------
// 6. An unreadable store degrades, it does not throw
// ---------------------------------------------------------------------------
console.log('\n[6] a broken store does not break the listing')
{
  const dir = scratch()
  const storeFile = path.join(dir, 'hosts.json')
  writeFileSync(storeFile, '{ this is not json', 'utf8')
  const entryStore = new HostConfigStore(storeFile)
  check('recentHosts answers with an empty map', Object.keys(entryStore.recentHosts()).length === 0,
    JSON.stringify(entryStore.recentHosts()))
  check('noteHostUsed does not throw', (entryStore.noteHostUsed('x', 1), true))
}

for (const cleanup of cleanups.reverse()) {
  try { cleanup() } catch { /* best effort */ }
}

  totalPassed += (typeof passed !== 'undefined' ? passed : (typeof passes !== 'undefined' ? passes : 0))
  totalFailures += (typeof failures !== 'undefined' ? (Array.isArray(failures) ? failures.length : failures) : 0)
})()

console.log(`\n=== ${totalPassed} passed, ${totalFailures} failed ===`)
if (totalFailures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}
