/**
 * Recent-host ordering: which hosts climb the list, and which must not.
 *
 * The rule is narrow on purpose — "recently USED", where used means a connection
 * actually succeeded. A listing that reordered on mere inspection, or on a
 * failed attempt, would teach the user that the order means nothing.
 *
 * Run: node tests/recent-hosts-smoke.mjs
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const { HostConfigStore } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'store.js')).href)
const { HostStore } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'hosts.js')).href)

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

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
if (failures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}
