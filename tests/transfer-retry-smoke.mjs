/**
 * Transfer retry over a real SSH socket.
 *
 * A resume path is only worth anything if a REAL transport break leaves the
 * staged part recoverable. This suite starts the fake SSH server, keeps a tiny
 * in-memory SFTP filesystem, and kills every live socket in the middle of a
 * write. It then retries the same `transferFile(..., { resume: true, verify:
 * true })` and checks:
 *
 *  1. the first attempt fails with a partial + sidecar left behind;
 *  2. the retry sends only the missing bytes and finishes;
 *  3. the published file matches the source and `verified === true`.
 *
 * Run: node tests/transfer-retry-smoke.mjs
 */

import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const supportDir = path.join(pluginRoot, 'tests', 'support')
const coreRoot = process.env.DSH_CORE_ROOT
if (!coreRoot) {
  console.log('\n=== transfer retry smoke ===\n')
  console.log('  SKIP  DSH_CORE_ROOT is not set (needs @deepseek-ai/dsh-fs)')
  console.log('\n=== 0 passed, 0 failed, 1 suite skipped ===')
  process.exit(0)
}
process.env.DSH_PEER_ROOT = [coreRoot, process.env.DSH_PEER_ROOT].filter(Boolean).join(path.delimiter)

const { startFakeSshServer } = await import(pathToFileURL(path.join(supportDir, 'fake-ssh-server.mjs')).href)
const { SshWorkspaceEngine } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'engine.js')).href)
const { HostConfigStore } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'store.js')).href)
const { HostStore } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'hosts.js')).href)
const { transferFile } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'transfer.js')).href)

const cleanups = []
const track = (fn) => { cleanups.push(fn) }
const cleanup = () => { while (cleanups.length > 0) { try { cleanups.pop()() } catch { /* gone */ } } }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

function digestOf (bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * A minimal SFTP filesystem: enough of OPEN/READ/WRITE/STAT/RENAME for
 * `uploadFile`, and it drops the whole connection after `dropAfter` bytes have
 * been written into the staging file.
 */
function makeSftpStore ({ total, digest }) {
  const files = new Map()
  const dirs = new Set(['/', '/tmp'])
  const handles = new Map()
  const counters = { open: 0, stagedBytes: 0, resumedBytes: 0, drops: 0 }
  let dropOnce = true
  let server = null

  const attrsOf = (target) => {
    const bytes = files.get(target)
    if (bytes === undefined) return dirs.has(target)
      ? { mode: 0o040755, uid: 0, gid: 0, size: 0, atime: 0, mtime: 1 }
      : null
    return { mode: 0o100644, uid: 0, gid: 0, size: bytes.length, atime: 0, mtime: 1 }
  }

  const onSftp = (sftp) => {
    sftp.on('OPEN', (reqid, filename, flags) => {
      const mode = typeof flags === 'number' ? flags : 0
      const READ = mode & 0x01
      const WRITE = mode & 0x02
      const CREAT = mode & 0x08
      const TRUNC = mode & 0x10
      const EXCL = mode & 0x20
      if (WRITE && EXCL && files.has(filename)) { sftp.status(reqid, 4); return }
      if (dirs.has(filename)) { sftp.status(reqid, 4); return }
      if (WRITE && !files.has(filename)) {
        if (!CREAT) { sftp.status(reqid, 2); return }
        files.set(filename, Buffer.alloc(0))
      }
      if (WRITE && TRUNC) files.set(filename, Buffer.alloc(0))
      counters.open += 1
      const id = String(1000 + counters.open)
      handles.set(id, { path: filename, writable: WRITE === 1 || WRITE === 0x02, readable: READ === 1 })
      sftp.handle(reqid, Buffer.from(id))
    })
    sftp.on('WRITE', (reqid, handle, offset, data) => {
      const entry = handles.get(String(handle))
      if (entry === undefined) { sftp.status(reqid, 4); return }
      const current = files.get(entry.path) ?? Buffer.alloc(0)
      const end = offset + data.length
      const next = current.length >= end ? current : Buffer.concat([current, Buffer.alloc(end - current.length)])
      data.copy(next, offset)
      files.set(entry.path, next)
      const isStaging = entry.path.includes('.dsh-up-partial') && !entry.path.endsWith('.json')
      if (isStaging) {
        counters.stagedBytes += data.length
        if (counters.drops === 0) counters.resumedBytes = 0
        else counters.resumedBytes += data.length
        if (dropOnce && counters.stagedBytes > total * 0.4) {
          dropOnce = false
          counters.drops += 1
          // Answer with a failure, then kill the socket: a real link also
          // breaks the request it was carrying instead of leaving a client
          // waiting for a reply that can never arrive.
          sftp.status(reqid, 4)
          server?.dropAll()
          return
        }
      }
      sftp.status(reqid, 0)
    })
    sftp.on('READ', (reqid, handle, offset, length) => {
      const entry = handles.get(String(handle))
      if (entry === undefined) { sftp.status(reqid, 4); return }
      const bytes = files.get(entry.path) ?? Buffer.alloc(0)
      if (offset >= bytes.length) { sftp.status(reqid, 1); return }
      sftp.data(reqid, bytes.subarray(offset, offset + length))
    })
    sftp.on('CLOSE', (reqid, handle) => {
      handles.delete(String(handle))
      sftp.status(reqid, 0)
    })
    sftp.on('FSTAT', (reqid, handle) => {
      const entry = handles.get(String(handle))
      if (entry === undefined) { sftp.status(reqid, 4); return }
      const attrs = attrsOf(entry.path)
      if (attrs === null) { sftp.status(reqid, 2); return }
      sftp.attrs(reqid, attrs)
    })
    sftp.on('STAT', (reqid, target) => {
      const attrs = attrsOf(target)
      if (attrs === null) { sftp.status(reqid, 2); return }
      sftp.attrs(reqid, attrs)
    })
    sftp.on('LSTAT', (reqid, target) => {
      const attrs = attrsOf(target)
      if (attrs === null) { sftp.status(reqid, 2); return }
      sftp.attrs(reqid, attrs)
    })
    sftp.on('REALPATH', (reqid, target) => {
      sftp.name(reqid, [{ filename: target, longname: target, attrs: attrsOf(target) ?? {} }])
    })
    sftp.on('MKDIR', (reqid, target) => {
      dirs.add(target)
      sftp.status(reqid, 0)
    })
    sftp.on('RENAME', (reqid, from, to) => {
      const bytes = files.get(from)
      if (bytes === undefined) { sftp.status(reqid, 2); return }
      files.set(to, bytes)
      files.delete(from)
      sftp.status(reqid, 0)
    })
    sftp.on('REMOVE', (reqid, target) => {
      if (!files.has(target)) { sftp.status(reqid, 2); return }
      files.delete(target)
      sftp.status(reqid, 0)
    })
  }

  const onExec = ({ command, stream }) => {
    if (command.includes('command -v')) {
      stream.write('dsh-hash:sha256sum\n')
      stream.exit(0)
      stream.end()
      return
    }
    const quoted = /\s'([^']+)'\s*$/u.exec(command)
    const target = quoted === null ? '/tmp/dest.bin' : quoted[1]
    const bytes = files.get(target) ?? Buffer.alloc(0)
    stream.write(`${digest}  ${target}\n`)
    stream.exit(0)
    stream.end()
  }

  return { files, dirs, counters, onSftp, onExec, attachServer: (value) => { server = value } }
}

async function main () {
  const source = mkdtempSync(path.join(tmpdir(), 'dsh-transfer-retry-'))
  track(() => rmSync(source, { recursive: true, force: true }))
  const localPath = path.join(source, 'source.bin')
  const bytes = Buffer.alloc(600 * 1024)
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 37 + 11) % 251
  writeFileSync(localPath, bytes)
  const digest = digestOf(bytes)
  const store = makeSftpStore({ total: 600 * 1024, digest })

  const server = await startFakeSshServer({
    pluginRoot,
    password: 'sekret',
    onSftp: store.onSftp,
    onExec: store.onExec,
  })
  store.attachServer(server)
  track(() => server.close())

  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-transfer-retry-host-'))
  track(() => rmSync(dir, { recursive: true, force: true }))
  const storeFile = path.join(dir, 'hosts.json')
  writeFileSync(storeFile, JSON.stringify({
    version: 1,
    hosts: [{ alias: 'fake', host: '127.0.0.1', port: server.port, user: 'tester', auth: { kind: 'password', password: 'sekret' } }],
  }, null, 2), 'utf8')
  const entryStore = new HostConfigStore(storeFile)
  const hostStore = new HostStore(path.join(dir, 'no-ssh-config'), entryStore)
  const engine = new SshWorkspaceEngine({
    store: hostStore,
    reconnect: { baseDelayMs: 50, maxDelayMs: 100, jitter: 0, maxAttempts: 8 },
    sweepIntervalMs: 3_600_000,
  })
  track(() => engine.dispose())
  await engine.acquire('fake')

  let firstError = null
  try {
    await transferFile(engine, {
      alias: 'fake',
      direction: 'upload',
      localPath,
      remotePath: '/tmp/dest.bin',
      roots: new Set(['ssh://fake/tmp']),
      resume: true,
      verify: true,
    })
  } catch (error) { firstError = error }
  check('the real socket dies mid-write and the first attempt fails', firstError !== null,
    firstError === null ? 'resolved' : `${firstError.code ?? ''} ${firstError.message}`)
  const partial = store.files.get('/tmp/dest.bin.dsh-up-partial')
  check('the failed attempt leaves a staged prefix shorter than the source',
    partial !== undefined && partial.length > 0 && partial.length < bytes.length,
    partial === undefined ? 'no staging' : `${partial.length} of ${bytes.length}`)
  check('...and its identity sidecar', store.files.has('/tmp/dest.bin.dsh-up-partial.json'))

  await engine.acquire('fake')
  const resumedBefore = store.counters.resumedBytes
  const second = await transferFile(engine, {
    alias: 'fake',
    direction: 'upload',
    localPath,
    remotePath: '/tmp/dest.bin',
    roots: new Set(['ssh://fake/tmp']),
    resume: true,
    verify: true,
  })
  const sentOnRetry = store.counters.resumedBytes - resumedBefore
  check('the retry resumes instead of re-sending the whole file',
    second.bytes === bytes.length && sentOnRetry > 0 && sentOnRetry < bytes.length,
    `sentOnRetry=${sentOnRetry}`)
  check('the retry publishes bytes identical to the source',
    Buffer.compare(store.files.get('/tmp/dest.bin') ?? Buffer.alloc(0), bytes) === 0)
  check('the retry reports a verified copy', second.verified === true,
    JSON.stringify({ verified: second.verified, verification: second.verification }))
  check('the staging file and sidecar are gone after publication',
    !store.files.has('/tmp/dest.bin.dsh-up-partial') && !store.files.has('/tmp/dest.bin.dsh-up-partial.json'))

  // The second attempt has to decide the destination again: a target that
  // appeared while the first attempt was dead is refused before any write.
  store.files.set('/tmp/blocked.bin', Buffer.from('occupied'))
  store.files.set('/tmp/blocked.bin.dsh-up-partial', Buffer.from('old'))
  store.files.set('/tmp/blocked.bin.dsh-up-partial.json', Buffer.from('{}'))
  let conflictError = null
  try {
    await transferFile(engine, {
      alias: 'fake',
      direction: 'upload',
      localPath,
      remotePath: '/tmp/blocked.bin',
      roots: new Set(['ssh://fake/tmp']),
      resume: true,
      onConflict: 'refuse',
    })
  } catch (error) { conflictError = error }
  check('a retry re-decides the conflict: a destination that appeared is refused',
    conflictError !== null && /refuse/u.test(String(conflictError.message)),
    conflictError === null ? 'resolved' : String(conflictError.message))
}

try {
  await main()
} finally {
  cleanup()
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
process.exit(failures === 0 ? 0 : 1)
