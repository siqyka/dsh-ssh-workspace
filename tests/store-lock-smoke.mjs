/**
 * Behavioural check for 6.4: the store's cross-process write lock.
 *
 * `#writeDocument` is read-modify-write; two DSH instances editing the same
 * $DSH_HOME/dsh-ssh.json used to let the later rename silently discard the
 * other's section. The lock is a sibling `*.lock` created with `open(...,'wx')`,
 * which is atomic on POSIX and Windows alike.
 *
 * Run: node tests/store-lock-smoke.mjs
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { HostConfigStore } from '../lib/hosts/store.js'

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

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
process.exit(failures === 0 ? 0 : 1)
