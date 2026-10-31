/**
 * Phase 6 correctness regression checks (6.1 / 6.2 / 6.3).
 *
 * Each of these covers a defect that is invisible to the happy path and only
 * shows up under a specific failure or scale condition, so they are driven
 * directly rather than through a full DSH boot:
 *
 * - 6.1: a channel that closes with NO exit status (dropped transport) must
 *   fail the exec instead of settling it as a completed command.
 * - 6.2: the atomic-replace fallback must only unlink a destination it has
 *   PROVEN exists, otherwise a failed rename destroys an unrelated file.
 * - 6.3: `listDir` must consume the attributes readdir already returned rather
 *   than stat-ing every child (1 + N serial round trips).
 *
 * Requires an assembled DSH dependency tree; SKIPs when DSH_CORE_ROOT is unset.
 * Run: DSH_CORE_ROOT=/path/to/node_modules node tests/phase6-smoke.mjs
 */

import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const coreRoot = process.env.DSH_CORE_ROOT
if (!coreRoot) {
  console.log('\n=== phase6 smoke ===\n')
  console.log('  SKIP  DSH_CORE_ROOT is not set (needs @deepseek-ai/dsh-fs and @deepseek-ai/dsh-tools)')
  console.log('\n=== 0 passed, 0 failed, 1 suite skipped ===')
  process.exit(0)
}
process.env.DSH_PEER_ROOT = [coreRoot, process.env.DSH_PEER_ROOT].filter(Boolean).join(path.delimiter)

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const requireFromCore = createRequire(path.join(coreRoot, 'noop.cjs'))
requireFromCore('@deepseek-ai/dsh-fs')
requireFromCore('@deepseek-ai/dsh-tools')

const { installRemoteShell } = await import(pathToFileURL(path.join(pluginRoot, 'lib/patch-shell.js')).href)
const { RemoteFileSystem, sftpPublishRename } = await import(pathToFileURL(path.join(pluginRoot, 'lib/remote-fs.js')).href)
const { StreamTail } = await import(pathToFileURL(path.join(pluginRoot, 'lib/patch-subprocess.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** ssh2's SSH_FX_NO_SUCH_FILE — the numeric code `fsCodeOf` maps to FS_NOT_FOUND. */
const NO_SUCH_FILE = 2
const err = (code) => { const e = new Error(String(code)); e.code = code; return e }

// ---------------------------------------------------------------------------
// 6.1 exec close with no exit status
// ---------------------------------------------------------------------------

/** A channel that ends by emitting close with the scenario's arguments. */
function fakeChannel (closeArgs, output) {
  const stream = new EventEmitter()
  stream.stderr = new EventEmitter()
  stream.signal = () => {}
  stream.close = () => {}
  stream.end = () => {
    if (output !== undefined) stream.emit('data', Buffer.from(output, 'utf8'))
    setImmediate(() => stream.emit('close', ...closeArgs))
  }
  return stream
}

async function runExec (closeArgs, output) {
  const record = {
    inFlight: 0,
    idleAt: Date.now(),
    broken: false,
    // Real ssh2's exec is `exec(command[, options], callback)`; the shell
    // router passes the channel-options bag (agent forwarding lives there),
    // so the double honours both arities like the real API does.
    client: {
      exec: (_script, optionsOrCb, maybeCb) => {
        const cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb
        cb(undefined, fakeChannel(closeArgs, output))
      },
    },
  }
  const engine = { acquire: async () => record, release: () => {}, forget: () => {}, assertNotDisabled () {} }
  const ctx = {
    get: (name) => (name === 'shell' ? { execute: async () => ({}) } : undefined),
    effect: (fn) => { fn() },
  }
  const router = installRemoteShell(ctx, { engine, logger: undefined })
  const handle = await router.execute({ workdir: 'ssh://h/root', command: 'sleep 999', timeoutMs: 0, onExpiry: 'none' })
  const outcome = {}
  try { outcome.result = await handle.result() } catch (error) { outcome.threw = error }
  outcome.status = handle.status
  outcome.exitCode = handle.exitCode
  return outcome
}

console.log('\n[6.1] exec close with no exit status')
{
  const dropped = await runExec([undefined, undefined], undefined)
  check('close(undefined) does NOT settle as completed', dropped.status !== 'completed', `status=${dropped.status}`)
  check('close(undefined) rejects result()', dropped.threw !== undefined)
  check('close(undefined) names the dropped connection',
    /connection dropped/i.test(String(dropped.threw?.message ?? '')), String(dropped.threw?.message))

  const droppedNull = await runExec([null, null], undefined)
  check('close(null) does NOT settle as completed', droppedNull.status !== 'completed', `status=${droppedNull.status}`)

  const ok = await runExec([0, undefined], 'hello')
  check('close(0) still settles as completed', ok.status === 'completed', `status=${ok.status}`)
  check('close(0) stamps exitCode 0', ok.exitCode === 0, String(ok.exitCode))

  const nonzero = await runExec([1, undefined], undefined)
  check('close(1) stamps exitCode 1', nonzero.exitCode === 1, String(nonzero.exitCode))
}

// ---------------------------------------------------------------------------
// 6.2 publishRename fallback must not delete an unrelated destination
// ---------------------------------------------------------------------------

const FROM = '/root/.dsh-tmp-ab/staged.txt'
const TO = '/root/target.txt'
const FILE_STATS = { size: 7, ino: 1, mtime: 5, mode: 0o100644, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }

function fakeSftpRename ({ destExists, statError, renameSucceedsAfterUnlink = false }) {
  const events = []
  let renames = 0
  return {
    events,
    _extensions: {},
    stat (p, cb) {
      events.push(['stat', p])
      if (p !== TO) return cb(err(NO_SUCH_FILE))
      if (statError) return cb(statError)
      return destExists ? cb(undefined, FILE_STATS) : cb(err(NO_SUCH_FILE))
    },
    unlink (p, cb) { events.push(['unlink', p]); cb(undefined) },
    rename (from, to, cb) {
      renames += 1
      events.push(['rename', from, to])
      if (renameSucceedsAfterUnlink && events.some(([n]) => n === 'unlink')) cb(undefined)
      else cb(err('FAILURE'))
    },
    renames: () => renames,
  }
}

const targetUnlinks = (sftp) => sftp.events.filter(([n, p]) => n === 'unlink' && p === TO)

console.log('\n[6.2] rename fallback and the destination file')
{
  const absent = fakeSftpRename({ destExists: false })
  let absentError
  try { await sftpPublishRename(absent, FROM, TO, true) } catch (e) { absentError = e }
  check('a failed rename with no destination keeps the destination untouched', targetUnlinks(absent).length === 0)
  check('the destination is probed before any unlink', absent.events.some(([n, p]) => n === 'stat' && p === TO))
  check('the original rename error is what surfaces', absentError?.message === 'FAILURE', String(absentError?.message))

  const present = fakeSftpRename({ destExists: true, renameSucceedsAfterUnlink: true })
  let presentError
  try { await sftpPublishRename(present, FROM, TO, true) } catch (e) { presentError = e }
  check('an existing destination IS unlinked and retried', targetUnlinks(present).length === 1)
  check('the retry ran', present.renames() === 2, String(present.renames()))
  check('the retry published successfully', presentError === undefined, presentError?.message)

  const unprobeable = fakeSftpRename({ destExists: false, statError: err('PERMISSION_DENIED') })
  let probeError
  try { await sftpPublishRename(unprobeable, FROM, TO, true) } catch (e) { probeError = e }
  check('an unprobeable destination is never unlinked', targetUnlinks(unprobeable).length === 0)
  check('the probe failure surfaces', probeError !== undefined)

  const noReplace = fakeSftpRename({ destExists: true })
  let noReplaceError
  try { await sftpPublishRename(noReplace, FROM, TO, false) } catch (e) { noReplaceError = e }
  check('replace=false never unlinks', targetUnlinks(noReplace).length === 0)
  check('replace=false surfaces the rename error', noReplaceError !== undefined)
}

// ---------------------------------------------------------------------------
// 6.3 listDir must not stat every child
// ---------------------------------------------------------------------------

function attrsOf ({ dir = false, size = 0, ino = 1, mtime = 1000 } = {}) {
  return {
    mode: dir ? 0o40755 : 0o100644,
    size,
    ino,
    mtime,
    isDirectory: () => dir,
    isFile: () => !dir,
    isSymbolicLink: () => false,
  }
}

function fakeSftpList (children, { withAttrs = true } = {}) {
  const calls = []
  return {
    calls,
    stat (p, cb) { calls.push(['stat', p]); cb(undefined, attrsOf({ dir: true })) },
    lstat (p, cb) { calls.push(['lstat', p]); cb(undefined, attrsOf({ dir: true })) },
    readdir (p, cb) {
      calls.push(['readdir', p])
      cb(undefined, children.map(c => ({
        filename: c.name,
        longname: c.name,
        ...(withAttrs ? { attrs: c.attrs } : {}),
      })))
    },
  }
}

function routerOver (sftp) {
  const engine = { withSftp: async (_alias, fn) => await fn(sftp), attachFileSystem () {}, dispose () {} }
  const router = new RemoteFileSystem({ engine, base: {}, baseProto: {} })
  router.addRoot('testhost', '/root')
  return router
}

const CHILD_COUNT = 25
const CHILDREN = [
  { name: 'aaa.txt', attrs: attrsOf({ size: 11, ino: 2 }) },
  { name: 'sub', attrs: attrsOf({ dir: true, ino: 3 }) },
  ...Array.from({ length: CHILD_COUNT - 2 }, (_, i) => ({ name: `f${String(i).padStart(3, '0')}.js`, attrs: attrsOf({ size: 100 + i, ino: 10 + i }) })),
]

console.log('\n[6.3] listDir round trips')
{
  const sftp = fakeSftpList(CHILDREN)
  const entries = await routerOver(sftp).listDir({ targetKey: 'ssh://testhost/root', displayPath: 'ssh://testhost/root' })
  const stats = sftp.calls.filter(([n]) => n === 'stat').length
  check(`all ${CHILD_COUNT} children are listed`, entries.length === CHILD_COUNT, String(entries.length))
  check(`a ${CHILD_COUNT}-child directory costs no per-child stat`, stats <= 1, `stat calls=${stats}`)

  const file = entries.find(e => e.name === 'aaa.txt')
  check('a file child is typed from attrs', file?.type === 'file', JSON.stringify(file))
  check('a file child carries its size', file?.size === 11, String(file?.size))
  check('a file child carries a version', typeof file?.version === 'string' && file.version.length > 0, String(file?.version))
  check('a directory child is typed from attrs', entries.find(e => e.name === 'sub')?.type === 'directory')

  const statless = fakeSftpList(CHILDREN, { withAttrs: false })
  const fallbackEntries = await routerOver(statless).listDir({ targetKey: 'ssh://testhost/root', displayPath: 'ssh://testhost/root' })
  check('a server omitting attrs still lists every child', fallbackEntries.length === CHILD_COUNT, String(fallbackEntries.length))
  check('a server omitting attrs falls back to stat',
    statless.calls.filter(([n]) => n === 'stat').length >= 1)
}

console.log('\n[6.5] StreamTail caches its joined window')
{
  const tail = new StreamTail(1024)
  tail.push('alpha ')
  tail.push('beta')
  const first = tail.readFrom(0)
  check('the first read returns the whole window', first.text === 'alpha beta', JSON.stringify(first.text))
  const joinedAfterPush = tail.joined

  const second = tail.readFrom(0)
  check('a repeat read returns the same text', second.text === 'alpha beta', JSON.stringify(second.text))
  check('the join is reused rather than rebuilt', tail.joined === joinedAfterPush)

  check('finalize reuses the same join too', tail.finalize().text === 'alpha beta')
  check('finalize did not invalidate the cache', tail.joined === joinedAfterPush)

  tail.push(' gamma')
  check('a push invalidates the cached join', tail.joined === undefined)
  check('the next read sees the new chunk', tail.readFrom(0).text === 'alpha beta gamma', JSON.stringify(tail.readFrom(0).text))

  // Offsets and the lossy flag must be unaffected by the caching.
  const capped = new StreamTail(5)
  capped.push('12345')
  capped.push('67890')
  const lossyRead = capped.readFrom(0)
  check('a capped window still reports lossy', lossyRead.lossy === true)
  check('a capped window keeps only the newest bytes', lossyRead.text === '67890', JSON.stringify(lossyRead.text))
  check('a capped window still reports the total offset', lossyRead.nextOffset === 10, String(lossyRead.nextOffset))
  check('a mid-window read starts at the requested offset', capped.readFrom(6).text === '7890', JSON.stringify(capped.readFrom(6).text))
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
process.exit(failures === 0 ? 0 : 1)
