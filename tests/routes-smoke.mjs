/**
 * Route-level checks for the transfer/download surface.
 *
 * The `download` route is the one route that streams raw bytes instead of
 * answering JSON, which means it deliberately bypasses the shared `guard()`
 * helper and re-applies the fence itself. That makes its refusals worth testing
 * directly: a missing loopback check here would serve arbitrary remote files to
 * any web page that can reach the port.
 *
 * These tests drive the registered handler objects with synthetic request and
 * response doubles, so no server and no SSH host are involved.
 *
 * Run: node tests/routes-smoke.mjs
 */

import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== routes smoke ===\n')

// ---------------------------------------------------------------------------
// Bare-identifier audit (runs even when the DSH tree is absent)
//
// routes.js cannot be imported without @deepseek-ai/dsh-fs, so this suite
// skips on a plain checkout. That skip is exactly how a real bug shipped: the
// upload handler called `remoteParentOf`/`sftpUnlink`, which live in
// transfer.js and were never imported — the suite was green because it only
// exercised the refusal branches and never reached SFTP.
//
// This pass reads the source instead and proves that every SFTP helper the
// transfer routes call is imported or declared in the module.
// ---------------------------------------------------------------------------
{
  const source = readFileSync(path.join(pluginRoot, 'lib/routes.js'), 'utf8')
  const declared = new Set()
  const imported = new Set()
  for (const m of source.matchAll(/\bimport\s*\{([^}]+)\}\s*from/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim()
      if (name) imported.add(name)
    }
  }
  for (const m of source.matchAll(/\bimport\s+(\w+)\s+from/g)) imported.add(m[1])
  for (const m of source.matchAll(/\b(?:function|class)\s+(\w+)/g)) declared.add(m[1])
  for (const m of source.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=/g)) declared.add(m[1])

  const requiredHelpers = [
    'remoteParentOf', 'sftpUnlink', 'sftpMkdirp', 'sftpOpenHandle',
    'sftpReadHandle', 'sftpCloseHandle', 'sftpPublishRename', 'sftpStatOrNull',
  ]
  const missing = requiredHelpers.filter((helper) => {
    const used = new RegExp(`\\b${helper}\\s*\\(`).test(source)
    if (!used) return false
    return !(declared.has(helper) || imported.has(helper))
  })
  for (const helper of missing) {
    check(`routes.js can resolve ${helper}()`, false, 'called but neither declared nor imported')
  }
  if (missing.length === 0) {
    check('every SFTP helper the transfer routes call is imported', true)
  }
}

// routes.js pulls the SFTP primitives from remote-fs.js, which resolves the DSH
// peer packages; the suite needs the assembled tree even though it never opens
// a connection.
const coreRoot = process.env.DSH_CORE_ROOT
if (!coreRoot) {
  console.log('  SKIP  DSH_CORE_ROOT is not set (needs @deepseek-ai/dsh-fs)')
  console.log(`\n=== ${passed} passed, ${failures} failed, 1 suite skipped ===`)
  process.exit(failures === 0 ? 0 : 1)
}
process.env.DSH_PEER_ROOT = [coreRoot, process.env.DSH_PEER_ROOT].filter(Boolean).join(path.delimiter)

const { makeRoutes, ROUTES } = await import(pathToFileURL(path.join(pluginRoot, 'lib/routes.js')).href)

/** A response double that records what the handler wrote. */
function fakeRes () {
  const state = { status: undefined, headers: undefined, body: '', headersSent: false }
  const res = {
    get headersSent () { return state.headersSent },
    writeHead (status, headers) {
      state.status = status
      state.headers = headers
      state.headersSent = true
      return res
    },
    write (chunk) { state.body += String(chunk); return true },
    end (chunk) { if (chunk !== undefined) state.body += String(chunk); return res },
    on () {},
  }
  return { res, state }
}

/**
 * A request double carrying the fields the fence reads.
 *
 * `body` is delivered the way `readJsonBody` consumes it — as data/end events —
 * so a handler's JSON parsing runs for real instead of being stubbed.
 */
function fakeReq (options = {}) {
  const url = new URL(options.url ?? '/', 'http://localhost')
  const handlers = new Map()
  return {
    method: options.method ?? 'GET',
    url: options.url ?? '/',
    headers: options.headers ?? {},
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1', localPort: options.localPort ?? 4074 },
    on (event, handler) {
      handlers.set(event, handler)
      if (options.body !== undefined && event === 'end') {
        // Deliver asynchronously so the handler's promise chain matches a real
        // socket: readers attach both listeners before any data arrives.
        setImmediate(() => {
          const dataHandler = handlers.get('data')
          if (dataHandler !== undefined) dataHandler(Buffer.from(JSON.stringify(options.body)))
          handler()
        })
      }
    },
  }
}

/** A fake engine that serves and accepts in-memory files. */
function fakeEngine (files, directories = new Set()) {
  const state = { opened: 0, closed: 0, renamed: [], unlinked: [], mkdirs: [] }
  return {
    state,
    async withSftp (_alias, work) {
      return await work({
        stat (target, callback) {
          if (directories.has(target)) {
            callback(null, { size: 0, isDirectory: () => true, mode: 0o040755 })
            return
          }
          if (!files.has(target)) { callback(Object.assign(new Error('no such file'), { code: 2 })); return }
          const content = files.get(target)
          callback(null, { size: content.length, isDirectory: () => false, mode: 0o100644 })
        },
        open (target, flags, callback) {
          state.opened += 1
          if (flags === 'w') {
            // Writes go to a buffer the handle accumulates; publish renames it.
            callback(null, { __content: Buffer.alloc(0), __write: true, __target: target })
            return
          }
          const content = files.get(target)
          if (content === undefined) { callback(Object.assign(new Error('no such file'), { code: 2 })); return }
          callback(null, { __content: content, __position: 0 })
        },
        write (handle, buffer, offset, length, position, callback) {
          handle.__content = Buffer.concat([handle.__content, buffer.subarray(offset, offset + length)])
          callback(null)
        },
        read (handle, buffer, offset, length, position, callback) {
          const slice = handle.__content.subarray(position, position + length)
          slice.copy(buffer, offset)
          callback(null, slice.length, buffer)
        },
        close (_handle, callback) {
          state.closed += 1
          // A write handle publishes its bytes into the virtual filesystem on
          // close, which is what makes the following rename carry real content.
          // Without this the double loses every uploaded byte and the rename
          // publishes an empty file.
          if (_handle?.__write === true && typeof _handle.__target === 'string') {
            files.set(_handle.__target, _handle.__content ?? Buffer.alloc(0))
          }
          callback(null)
        },
        mkdir (target, callback) { state.mkdirs.push(target); callback(null) },
        // The upload fence walks the destination with `lstat` and asks the
        // server to `realpath` the deepest existing component. This double has
        // no symbolic links, so a resolved spelling is the spelling itself —
        // enough to let an in-roots upload pass and to keep the walk honest
        // about what exists.
        lstat (target, callback) {
          if (target === '/' || directories.has(target)) { callback(null, { mode: 0o040755, isDirectory: () => true }); return }
          if (files.has(target)) { callback(null, { mode: 0o100644, isDirectory: () => false }); return }
          callback(Object.assign(new Error('no such file'), { code: 2 }))
        },
        realpath (target, callback) {
          if (target === '/') { callback(null, '/'); return }
          if (!directories.has(target) && !files.has(target)) { callback(Object.assign(new Error('no such file'), { code: 2 }), null); return }
          callback(null, target)
        },
        rename (from, to, callback) {
          state.renamed.push([from, to])
          const content = files.get(from) ?? Buffer.alloc(0)
          files.delete(from)
          files.set(to, content)
          callback(null)
        },
        unlink (target, callback) { state.unlinked.push(target); files.delete(target); callback(null) },
      })
    },
  }
}

console.log('\n=== routes smoke ===\n')

const engine = fakeEngine(new Map([
  ['/srv/report.txt', Buffer.from('hello from the remote host')],
]), new Set(['/srv/subdir']))
const forwards = { list: () => [], open: async () => ({}), close: () => false }
const shells = { list: () => [], run: async () => ({}), close: () => 0 }
const routes = makeRoutes({ engine, router: {}, forwards, shells, ctx: { get: () => undefined } })
const download = routes.find(route => route.path === ROUTES.download)

check('the download route is registered', download !== undefined)
check('the transfer route is registered', routes.some(route => route.path === ROUTES.transfer))

{
  const { res, state } = fakeRes()
  await download.handler(fakeReq({ remoteAddress: '10.0.0.5' }), res)
  check('a non-loopback request is refused', state.status === 403, String(state.status))
}

{
  const { res, state } = fakeRes()
  await download.handler(fakeReq({ headers: { host: 'evil.example:4074' } }), res)
  check('a rebinding Host header is refused', state.status === 403, String(state.status))
}

{
  const { res, state } = fakeRes()
  await download.handler(fakeReq({ method: 'POST', headers: { host: 'localhost:4074' } }), res)
  check('a non-GET method is refused', state.status === 405, String(state.status))
}

{
  const { res, state } = fakeRes()
  await download.handler(fakeReq({ url: `${ROUTES.download}?alias=a`, headers: { host: 'localhost:4074' } }), res)
  check('a missing path is refused', state.status === 400, String(state.status))
}

{
  const { res, state } = fakeRes()
  await download.handler(fakeReq({
    url: `${ROUTES.download}?alias=a&path=${encodeURIComponent('/srv/report.txt')}`,
    headers: { host: 'localhost:4074' },
  }), res)
  check('a valid request streams the file', state.status === 200, String(state.status))
  check('the body is the remote content', state.body === 'hello from the remote host', JSON.stringify(state.body))
  check('the response declares a download disposition',
    String(state.headers?.['content-disposition'] ?? '').includes('attachment'), JSON.stringify(state.headers?.['content-disposition']))
  check('the file handle is closed after streaming', engine.state.closed === engine.state.opened && engine.state.opened > 0,
    `opened=${engine.state.opened} closed=${engine.state.closed}`)
}

{
  const { res, state } = fakeRes()
  await download.handler(fakeReq({
    url: `${ROUTES.download}?alias=a&path=${encodeURIComponent('/srv/missing.txt')}`,
    headers: { host: 'localhost:4074' },
  }), res)
  // A 2xx here would be saved by the browser as a file named after the remote
  // target, containing the JSON error. The status is the only channel the
  // download flow honours, so it has to carry the failure.
  check('a missing remote file is NOT answered with 2xx', state.status !== 200 && state.status !== 204,
    String(state.status))
  check('a missing remote file answers 404', state.status === 404, String(state.status))
  check('a missing remote file still explains itself', JSON.parse(state.body).error !== undefined, state.body)
}

{
  // A directory target is a bad request, not a server failure: the user asked
  // for the wrong row, and 500 would blame the host.
  const { res, state } = fakeRes()
  await download.handler(fakeReq({
    url: `${ROUTES.download}?alias=a&path=${encodeURIComponent('/srv/subdir')}`,
    headers: { host: 'localhost:4074' },
  }), res)
  check('download of a directory answers 400', state.status === 400, String(state.status))
}

// --- upload ---------------------------------------------------------------
const upload = routes.find(route => route.path === ROUTES.upload)
check('the upload route is registered', upload !== undefined)

{
  const { res, state } = fakeRes()
  await upload.handler(fakeReq({ remoteAddress: '10.0.0.5', method: 'POST' }), res)
  check('a non-loopback upload is refused', state.status === 403, String(state.status))
}

{
  const { res, state } = fakeRes()
  await upload.handler(fakeReq({ method: 'POST', headers: { host: 'evil.example:4074' } }), res)
  check('a rebinding Host header is refused for upload', state.status === 403, String(state.status))
}

{
  const { res, state } = fakeRes()
  await upload.handler(fakeReq({ method: 'GET', headers: { host: 'localhost:4074' } }), res)
  check('a non-POST upload is refused', state.status === 405, String(state.status))
}

{
  const { res, state } = fakeRes()
  await upload.handler(fakeReq({
    method: 'POST',
    url: `${ROUTES.upload}?alias=a&path=${encodeURIComponent('/srv')}`,
    headers: { host: 'localhost:4074', 'content-type': 'application/octet-stream' },
  }), res)
  check('an upload without a name is refused', state.status === 400, String(state.status))
}

{
  // A name carrying a separator would escape the directory being browsed.
  for (const hostile of ['../escape.txt', 'a/b.txt', 'a\\b.txt', '..', '.']) {
    const { res, state } = fakeRes()
    await upload.handler(fakeReq({
      method: 'POST',
      url: `${ROUTES.upload}?alias=a&path=${encodeURIComponent('/srv')}&name=${encodeURIComponent(hostile)}`,
      headers: { host: 'localhost:4074', 'content-type': 'application/octet-stream' },
    }), res)
    check(`the name ${JSON.stringify(hostile)} is refused as a path escape`, state.status === 400,
      `status=${state.status} body=${state.body}`)
  }
}

// --- upload: the CSRF premise is the media type ---------------------------
//
// Every other POST endpoint demands `application/json`, which a cross-site form
// cannot send. `/upload` carries raw bytes instead, so it demands
// `application/octet-stream` — equally impossible for a form, and therefore the
// same protection. Without this check the endpoint was the one write path a
// `text/plain` form post could reach.
{
  // A request that would otherwise be VALID: loopback, right Host, right method,
  // a legal single-segment name. Only the media type is wrong, so a refusal
  // here cannot be explained by anything else.
  const url = `${ROUTES.upload}?alias=a&path=${encodeURIComponent('/srv/app')}&name=notes.txt`
  for (const [label, contentType] of [
    ['missing content-type', null],
    ['text/plain (a form is allowed to send this)', 'text/plain'],
    ['application/x-www-form-urlencoded', 'application/x-www-form-urlencoded'],
    ['multipart/form-data', 'multipart/form-data; boundary=x'],
    ['application/json (the JSON guard is not the raw guard)', 'application/json'],
  ]) {
    const files = new Map()
    const localEngine = fakeEngine(files)
    const localRoutes = makeRoutes({
      engine: localEngine, router: {}, forwards, shells, ctx: { get: () => undefined },
    })
    const localUpload = localRoutes.find(route => route.path === ROUTES.upload)
    const { res, state } = fakeRes()
    await localUpload.handler(fakeUploadReq({
      url,
      chunks: [Buffer.from('attacker bytes')],
      contentType,
    }), res)
    check(`an upload with ${label} is refused with 415`, state.status === 415, `status=${state.status} body=${state.body}`)
    check(`an upload with ${label} writes NO bytes`, files.size === 0, `files=${[...files.keys()].join(',')}`)
    // No staging file was opened and no directory was created: the refusal
    // happened before the first remote call, not in the middle of the write.
    check(`an upload with ${label} never reached SFTP`,
      localEngine.state.opened === 0 && localEngine.state.mkdirs.length === 0,
      `opened=${localEngine.state.opened} mkdirs=${localEngine.state.mkdirs.length}`)
  }

  // The control: the same request WITH the right type succeeds, so the refusals
  // above are caused by the media type and not by a broken fixture.
  const files = new Map()
  const localEngine = fakeEngine(files)
  const localRoutes = makeRoutes({
    engine: localEngine, router: {}, forwards, shells, ctx: { get: () => undefined },
  })
  const localUpload = localRoutes.find(route => route.path === ROUTES.upload)
  const { res, state } = fakeRes()
  await localUpload.handler(fakeUploadReq({
    url,
    chunks: [Buffer.from('legitimate bytes')],
  }), res)
  check('the same request with application/octet-stream succeeds', state.status === 200, `status=${state.status} body=${state.body}`)
  check('the accepted upload actually wrote its bytes', files.size === 1, `files=${[...files.keys()].join(',')}`)
}

/**
 * A request double carrying a streamable body, for the routes that read bytes.
 *
 * The upload handler consumes `for await (const chunk of req)`, so the body is
 * exposed as an async iterator over fixed-size chunks — the same shape a real
 * IncomingMessage offers.
 */
function fakeUploadReq ({ url, host = 'localhost:4074', chunks, method = 'POST', contentType = 'application/octet-stream' }) {
  let index = 0
  return {
    method,
    url,
    // `null` means "send no Content-Type at all": a default parameter would
    // silently turn an explicit `undefined` into the accepted type, which is
    // exactly the case this fixture exists to send.
    headers: contentType === null ? { host } : { host, 'content-type': contentType },
    socket: { remoteAddress: '127.0.0.1', localPort: 4074 },
    on () {},
    [Symbol.asyncIterator] () {
      return {
        async next () {
          if (index >= chunks.length) return { done: true, value: undefined }
          const value = chunks[index]
          index += 1
          return { done: false, value }
        },
      }
    },
  }
}

// --- upload: the write path itself ---------------------------------------
//
// The refusals above never reach SFTP, so they cannot catch a broken write.
// These drive the real body of the handler: bytes in, staged, renamed, and the
// directory created when it does not exist yet.
{
  const files = new Map()
  const localEngine = fakeEngine(files)
  const localRoutes = makeRoutes({
    engine: localEngine, router: {}, forwards, shells, ctx: { get: () => undefined },
  })
  const localUpload = localRoutes.find(route => route.path === ROUTES.upload)
  const { res, state } = fakeRes()
  await localUpload.handler(fakeUploadReq({
    url: `${ROUTES.upload}?alias=a&path=${encodeURIComponent('/srv/app')}&name=${encodeURIComponent('artifact.bin')}`,
    chunks: [Buffer.from('hello '), Buffer.from('remote')],
  }), res)
  const body = JSON.parse(state.body)
  check('a real upload succeeds', body.ok === true, state.body)
  check('a real upload reports the byte count', body.bytes === 'hello remote'.length, String(body.bytes))
  check('a real upload publishes by rename onto the destination',
    localEngine.state.renamed.length === 1 && localEngine.state.renamed[0][1] === '/srv/app/artifact.bin',
    JSON.stringify(localEngine.state.renamed))
  check('a real upload stages under a sibling temp name, not the destination',
    localEngine.state.renamed.length === 1 && localEngine.state.renamed[0][0] !== '/srv/app/artifact.bin',
    JSON.stringify(localEngine.state.renamed[0] ?? null))
  check('a real upload creates the destination directory',
    localEngine.state.mkdirs.includes('/srv/app'), JSON.stringify(localEngine.state.mkdirs))
  check('the destination ends up holding the uploaded bytes',
    files.get('/srv/app/artifact.bin')?.toString() === 'hello remote',
    String(files.get('/srv/app/artifact.bin')))
  check('the upload answers with the resolved remote path',
    body.remotePath === '/srv/app/artifact.bin', String(body.remotePath))
}

{
  // A root-level destination must not produce a doubled slash.
  const files = new Map()
  const localEngine = fakeEngine(files)
  const localRoutes = makeRoutes({
    engine: localEngine, router: {}, forwards, shells, ctx: { get: () => undefined },
  })
  const localUpload = localRoutes.find(route => route.path === ROUTES.upload)
  const { res, state } = fakeRes()
  await localUpload.handler(fakeUploadReq({
    url: `${ROUTES.upload}?alias=a&path=${encodeURIComponent('/')}&name=top.txt`,
    chunks: [Buffer.from('x')],
  }), res)
  check('an upload into the remote root joins without a doubled slash',
    JSON.parse(state.body).remotePath === '/top.txt', state.body)
}

// --- the browser's upload answers to the mounted-root fence ----------------
//
// The panel reaches `POST /upload` directly, not `ctx.fs`, so without this the
// browser could land bytes where the model's own `write` was refused. The fence
// is the SAME pair the router applies (mounted roots, then the server's
// `realpath`), and it answers before a single byte is staged.
// Policy (mode / session scope) is deliberately absent here: this is a user
// action, and the mode governs the agent.
{
  const servedDirs = new Set(['/srv', '/srv/app', '/etc', '/tmp', '/tmp/build'])
  const inRoots = new Map()
  const inRootsEngine = fakeEngine(inRoots, servedDirs)
  const fencedRoutes = makeRoutes({
    engine: inRootsEngine,
    router: { assertEnabled () {}, roots: new Set(['ssh://a/srv/app']) },
    forwards, shells, ctx: { get: () => undefined },
  })
  const upload = fencedRoutes.find(route => route.path === ROUTES.upload)
  {
    const { res, state } = fakeRes()
    await upload.handler(fakeUploadReq({
      url: `${ROUTES.upload}?alias=a&path=${encodeURIComponent('/etc/cron.d')}&name=dsh-probe`,
      chunks: [Buffer.from('escape')],
    }), res)
    const body = JSON.parse(state.body)
    check('the browser cannot upload to a directory outside every mounted root',
      body.ok === false && /outside every mounted remote workspace/u.test(body.error ?? ''), state.body)
    check('the refused browser upload staged nothing',
      inRootsEngine.state.opened === 0 && inRootsEngine.state.renamed.length === 0,
      JSON.stringify(inRootsEngine.state))
    check('the refused browser upload created no directory',
      inRootsEngine.state.mkdirs.length === 0, JSON.stringify(inRootsEngine.state.mkdirs))
  }
  {
    // The host temp area stays reachable, matching `write`: a panel upload that
    // stages a build artifact outside the workspace must not fail for a reason
    // the local file panel never hits.
    const { res, state } = fakeRes()
    await upload.handler(fakeUploadReq({
      url: `${ROUTES.upload}?alias=a&path=${encodeURIComponent('/tmp/build')}&name=artifact.o`,
      chunks: [Buffer.from('staged')],
    }), res)
    check('the browser can upload into the host temp area',
      JSON.parse(state.body).ok === true && inRoots.get('/tmp/build/artifact.o')?.toString() === 'staged',
      state.body)
  }
  {
    // And the ordinary in-workspace upload still works with the fence in place.
    const { res, state } = fakeRes()
    await upload.handler(fakeUploadReq({
      url: `${ROUTES.upload}?alias=a&path=${encodeURIComponent('/srv/app')}&name=ok.txt`,
      chunks: [Buffer.from('y')],
    }), res)
    check('an in-workspace browser upload succeeds with the fence in place',
      JSON.parse(state.body).ok === true, state.body)
  }
}

// --- saved forwards -------------------------------------------------------
//
// These routes are the browser's whole control surface for a stored mapping, so
// the refusals matter as much as the happy paths: an endpoint that accepted a
// mapping with no fixed local port, or that let a rebinding page toggle a
// tunnel, would be a real hole.
{
  const { SavedForwardManager } = await import(pathToFileURL(path.join(pluginRoot, 'lib/forward-persist.js')).href)
  const { ForwardManager } = await import(pathToFileURL(path.join(pluginRoot, 'lib/forward.js')).href)
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { HostConfigStore } = await import(pathToFileURL(path.join(pluginRoot, 'lib/store.js')).href)

  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-routes-forwards-'))
  try {
    const store = new HostConfigStore(path.join(dir, 'dsh-ssh.json'))
    /** A live manager whose engine double never accepts anything. */
    const forwards = new ForwardManager({ engine: { async acquire () { throw new Error('no connection in this test') } } })
    const saved = new SavedForwardManager({ forwards, store })
    const savedRoutes = makeRoutes({
      engine, router: {}, forwards, savedForwards: saved, shells, ctx: { get: () => undefined },
    })
    const find = (routePath) => savedRoutes.find(route => route.path === routePath)

    check('the saved-forward routes are registered',
      [ROUTES.forwardSave, ROUTES.forwardToggle, ROUTES.forwardDelete, ROUTES.forwardRemember, ROUTES.forwardProbe, ROUTES.forwardSettings]
        .every(routePath => find(routePath) !== undefined),
      JSON.stringify(savedRoutes.map(route => route.path)))

    // Status needs a root list from the router; this suite has no real one.
    const statusRoute = find(ROUTES.status)
    {
      const { res, state } = fakeRes()
      const statusRoutes = makeRoutes({
        engine: { ...engine, pool: new Map() },
        router: { listRoots: () => [], listDisabled: () => [] },
        forwards,
        savedForwards: saved,
        shells,
        ctx: { get: () => undefined },
      })
      await statusRoutes.find(route => route.path === ROUTES.status).handler(
        fakeReq({ url: ROUTES.status, headers: { host: 'localhost:4074' } }), res)
      const body = JSON.parse(state.body)
      check('status reports the saved forward rows', Array.isArray(body.forwardRows), JSON.stringify(Object.keys(body)))
      check('status reports the auto-start preference', body.forwardSettings?.autoStart === false, JSON.stringify(body.forwardSettings))
    }

    // The browser half greys a detached workspace's sessions, and a session row
    // carries nothing but its own id — so /status has to ship the membership.
    // Without it the group header greys while every session under it stays a
    // live, clickable session whose workspace fence is shut.
    {
      const { res, state } = fakeRes()
      const statusRoutes = makeRoutes({
        engine: { ...engine, pool: new Map() },
        router: { listRoots: () => [], listDisabled: () => ['ssh://box/srv/off'] },
        forwards,
        savedForwards: saved,
        shells,
        ctx: {
          get: (name) => name !== 'workspaceRegistry' ? undefined : {
            list: () => [
              { id: 'ws-off', path: 'ssh://box/srv/off', title: 'off', sessionIds: ['s1', 's2'] },
              { id: 'ws-on', path: 'ssh://box/srv/on', title: 'on', sessionIds: ['s3'] },
              // A registry entry with no membership array must not crash the
              // route: older hosts may omit it entirely.
              { id: 'ws-bare', path: 'ssh://box/srv/bare', title: 'bare' },
            ],
          },
        },
      })
      await statusRoutes.find(route => route.path === ROUTES.status).handler(
        fakeReq({ url: ROUTES.status, headers: { host: 'localhost:4074' } }), res)
      const body = JSON.parse(state.body)
      const byId = new Map((body.workspaces ?? []).map(ws => [ws.id, ws]))
      check('status ships the session membership of every workspace',
        JSON.stringify(byId.get('ws-off')?.sessionIds) === JSON.stringify(['s1', 's2']),
        JSON.stringify(byId.get('ws-off')))
      check('...coerced to strings, because session rows are keyed by text',
        (byId.get('ws-on')?.sessionIds ?? []).every(id => typeof id === 'string'),
        JSON.stringify(byId.get('ws-on')))
      check('...and an absent membership degrades to an empty list, not undefined',
        Array.isArray(byId.get('ws-bare')?.sessionIds), JSON.stringify(byId.get('ws-bare')))
    }

    // Fences on every new POST endpoint.
    for (const routePath of [ROUTES.forwardSave, ROUTES.forwardToggle, ROUTES.forwardDelete, ROUTES.forwardRemember, ROUTES.forwardSettings]) {
      const route = find(routePath)
      const { res, state } = fakeRes()
      await route.handler(fakeReq({ method: 'POST', remoteAddress: '10.0.0.5', headers: { 'content-type': 'application/json' } }), res)
      check(`${routePath} refuses a non-loopback request`, state.status === 403, String(state.status))

      const { res: res2, state: state2 } = fakeRes()
      await route.handler(fakeReq({ method: 'POST', headers: { host: 'evil.example:4074', 'content-type': 'application/json' } }), res2)
      check(`${routePath} refuses a rebinding Host header`, state2.status === 403, String(state2.status))

      const { res: res3, state: state3 } = fakeRes()
      await route.handler(fakeReq({ method: 'POST', headers: { host: 'localhost:4074', 'content-type': 'text/plain' } }), res3)
      check(`${routePath} requires a JSON content type`, state3.status === 415, String(state3.status))
    }

    // A saved mapping must name a fixed local port.
    {
      const { res, state } = fakeRes()
      await find(ROUTES.forwardSave).handler(fakeReq({
        method: 'POST',
        headers: { host: 'localhost:4074', 'content-type': 'application/json' },
        body: { alias: 'a', remotePort: 5173, localPort: 0 },
      }), res)
      const body = JSON.parse(state.body)
      check('a saved mapping with localPort 0 is refused', body.ok === false && typeof body.error === 'string', state.body)
      check('the refusal explains the port range', String(body.error).includes('1 and 65535'), String(body.error))
      check('nothing was stored for the refused mapping', store.forwards().items.length === 0)
    }

    // Deleting an id that is not stored reports false rather than throwing.
    {
      const { res, state } = fakeRes()
      await find(ROUTES.forwardDelete).handler(fakeReq({
        method: 'POST',
        headers: { host: 'localhost:4074', 'content-type': 'application/json' },
        body: { id: 'fwd-missing' },
      }), res)
      const body = JSON.parse(state.body)
      check('deleting an unknown saved id reports false', body.ok === true && body.deleted === false, state.body)
    }

    // The settings route stores the preference and ignores everything else.
    {
      const { res, state } = fakeRes()
      await find(ROUTES.forwardSettings).handler(fakeReq({
        method: 'POST',
        headers: { host: 'localhost:4074', 'content-type': 'application/json' },
        body: { autoStart: true, nonsense: 'ignored' },
      }), res)
      const body = JSON.parse(state.body)
      check('the settings route stores autoStart', body.ok === true && body.settings?.autoStart === true, state.body)
      check('the preference reached the store', store.forwards().settings.autoStart === true)
      check('an unknown setting did not reach the document',
        JSON.parse(readFileSync(path.join(dir, 'dsh-ssh.json'), 'utf8')).forwards.settings.nonsense === undefined)
    }

    // The probe validates its input before binding anything.
    {
      const { res, state } = fakeRes()
      await find(ROUTES.forwardProbe).handler(fakeReq({
        url: `${ROUTES.forwardProbe}?localPort=0`, headers: { host: 'localhost:4074' },
      }), res)
      check('the probe refuses port 0', state.status === 400, String(state.status))
    }
    {
      const { res, state } = fakeRes()
      await find(ROUTES.forwardProbe).handler(fakeReq({
        url: `${ROUTES.forwardProbe}?localHost=127.0.0.1&localPort=1`, headers: { host: 'localhost:4074' },
      }), res)
      const body = JSON.parse(state.body)
      check('the probe answers with a verdict', body.ok === true && typeof body.available === 'boolean', state.body)
      if (body.available === false) {
        check('an unavailable port comes with an explanation', typeof body.error === 'string' && body.error !== '', state.body)
      }
    }

    forwards.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- detach / enable ------------------------------------------------------
//
// The unmount endpoint is where an irreversible-looking action happens, so the
// mode default and the archive reporting are worth pinning: detach (the
// default) must keep the workspace record, and a session that could not be
// archived must be reported rather than silently dropped.
{
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { HostConfigStore } = await import(pathToFileURL(path.join(pluginRoot, 'lib/store.js')).href)

  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-routes-detach-'))
  try {
    const store = new HostConfigStore(path.join(dir, 'dsh-ssh.json'))
    const calls = { disabled: [], enabled: [], archived: [], unarchived: [], deleted: [] }
    const record = { id: 'ws-1', path: 'ssh://alpha/home/dev/proj', title: 'proj', sessionIds: ['s1', 's2'] }
    const registry = {
      list: () => [record],
      async archiveSession (id) {
        calls.archived.push(id)
        // A session with running work is refused by the registry; the route
        // must still archive the others and report this one.
        if (id === 's2') throw new Error('the session is active (turn)')
      },
      async unarchiveSession (id) { calls.unarchived.push(id) },
      async delete (id) { calls.deleted.push(id) },
      async createCanonical () { return record },
    }
    const fakeRouter = {
      listRoots: () => [],
      listDisabled: () => calls.disabled,
      disableRoot (path) { calls.disabled.push(path); return true },
      enableRoot (path) { calls.enabled.push(path); return true },
      addRoot (alias, remotePath) { return `ssh://${alias}${remotePath}` },
      assertEnabled () {},
    }
    // `engine.store.entryStore` is where the route persists the disabled list.
    const routeEngine = {
      ...engine,
      pool: new Map(),
      store: { entryStore: store },
      assertNotDisabled () {},
      async withSftp (_alias, fn) { return await fn({ stat: (_path, cb) => cb(undefined, { isDirectory: () => true }) }) },
    }
    const detachRoutes = makeRoutes({
      engine: routeEngine, router: fakeRouter, forwards: { list: () => [], open: async () => ({}), close: () => false },
      ctx: { get: (name) => (name === 'workspaceRegistry' ? registry : undefined) },
    })
    const findDetach = (routePath) => detachRoutes.find(route => route.path === routePath)

    check('the unmount and enable routes are registered',
      findDetach(ROUTES.unmount) !== undefined && findDetach(ROUTES.enable) !== undefined,
      JSON.stringify(detachRoutes.map(route => route.path)))

    // Default mode is detach: the record must survive.
    {
      const { res, state } = fakeRes()
      await findDetach(ROUTES.unmount).handler(fakeReq({
        method: 'POST',
        headers: { host: 'localhost:4074', 'content-type': 'application/json' },
        body: { workspacePath: record.path },
      }), res)
      const body = JSON.parse(state.body)
      check('unmount defaults to the detach mode', body.mode === 'detach', state.body)
      check('detach keeps the workspace record', body.deregistered === false, state.body)
      // Detach keeps the record, so the sidebar group and its sessions stay.
      // Archiving here would empty the very group the user chose to keep.
      check('detach archives nothing, so the kept group stays populated',
        body.archived.length === 0, state.body)
      check('detach reports no archive failures either',
        body.archiveFailed === undefined, state.body)
      check('detach persisted the disabled list', store.isWorkspaceDisabled(record.path))
      check('detach removed the workspace from the served roots', calls.disabled.includes(record.path))
    }

    // An explicit deregister removes the record too — but still no session files.
    // Requirement: "also delete the workspace record" must remove the row from
    // BOTH surfaces. Deleting the record takes the sidebar row; the panel's
    // detached list is driven by the persisted mark, so that mark has to come
    // down as well — otherwise the panel keeps offering a re-enable button for a
    // workspace that no longer exists, over a path the runtime still refuses.
    {
      calls.enabled.length = 0
      // Pre-mark it detached, so the assertion below can tell "cleared" from
      // "was never set".
      store.disableWorkspace(record.path)
      const { res, state } = fakeRes()
      await findDetach(ROUTES.unmount).handler(fakeReq({
        method: 'POST',
        headers: { host: 'localhost:4074', 'content-type': 'application/json' },
        body: { workspacePath: record.path, mode: 'deregister' },
      }), res)
      const body = JSON.parse(state.body)
      check('the deregister mode removes the workspace record', body.deregistered === true, state.body)
      check('deregister reached registry.delete', calls.deleted.includes('ws-1'), JSON.stringify(calls.deleted))
      check('deregister still only archived (never deleted) sessions', body.archived.length === 1, state.body)
      check('deregister clears the persisted mark, so the panel row goes too',
        !store.isWorkspaceDisabled(record.path))
      check('deregister lifts the runtime fence, so nothing refuses a gone workspace',
        calls.enabled.includes(record.path), JSON.stringify(calls.enabled))
    }

    // `forget` is the legacy spelling of the same mode: the two must not drift
    // apart, because a caller using the old name would otherwise keep the
    // re-enable button that this change exists to remove.
    {
      calls.enabled.length = 0
      store.disableWorkspace(record.path)
      const { res, state } = fakeRes()
      await findDetach(ROUTES.unmount).handler(fakeReq({
        method: 'POST',
        headers: { host: 'localhost:4074', 'content-type': 'application/json' },
        body: { workspacePath: record.path, mode: 'forget' },
      }), res)
      const body = JSON.parse(state.body)
      check('forget is normalized to the deregister mode', body.mode === 'deregister', state.body)
      check('forget removes the workspace record', body.deregistered === true, state.body)
      check('forget clears the persisted disabled mark', !store.isWorkspaceDisabled(record.path))
      check('forget lifts the runtime fence too', calls.enabled.includes(record.path), JSON.stringify(calls.enabled))
    }

    // An explicit `archiveSessions` still wins over the mode default, so a
    // caller that wants to hide the sessions while keeping the record can ask
    // for it. This is what makes the default a policy rather than a hard rule.
    {
      const before = calls.archived.length
      const { res, state } = fakeRes()
      await findDetach(ROUTES.unmount).handler(fakeReq({
        method: 'POST',
        headers: { host: 'localhost:4074', 'content-type': 'application/json' },
        body: { workspacePath: record.path, mode: 'detach', archiveSessions: true },
      }), res)
      const body = JSON.parse(state.body)
      check('an explicit archiveSessions:true archives even on detach',
        calls.archived.length === before + 2 && body.archived.length === 1, state.body)
      check('...and the failure is still reported', body.archiveFailed?.length === 1, state.body)
    }

    // The reverse: archiveSessions:false on deregister keeps the sessions
    // visible even though the row goes away.
    {
      const before = calls.archived.length
      const { res } = fakeRes()
      await findDetach(ROUTES.unmount).handler(fakeReq({
        method: 'POST',
        headers: { host: 'localhost:4074', 'content-type': 'application/json' },
        body: { workspacePath: record.path, mode: 'deregister', archiveSessions: false },
      }), res)
      check('archiveSessions:false archives nothing even on deregister',
        calls.archived.length === before, JSON.stringify(calls.archived))
    }

    // The legacy boolean spelling still maps onto the new modes.
    {
      const { res, state } = fakeRes()
      await findDetach(ROUTES.unmount).handler(fakeReq({
        method: 'POST',
        headers: { host: 'localhost:4074', 'content-type': 'application/json' },
        body: { workspacePath: record.path, deregister: true },
      }), res)
      check('deregister:true still means the deregister mode', JSON.parse(state.body).mode === 'deregister', state.body)
    }

    // Enable re-mounts and unarchives.
    {
      const { res, state } = fakeRes()
      await findDetach(ROUTES.enable).handler(fakeReq({
        method: 'POST',
        headers: { host: 'localhost:4074', 'content-type': 'application/json' },
        body: { workspacePath: record.path },
      }), res)
      const body = JSON.parse(state.body)
      check('enable answers ok', body.ok === true, state.body)
      check('enable mounted the workspace again', body.workspacePath === record.path, state.body)
      check('enable cleared the disabled list', !store.isWorkspaceDisabled(record.path))
      check('enable unarchived the workspace sessions', calls.unarchived.length >= 2, JSON.stringify(calls.unarchived))
      check('enable reports the workspace as registered', body.registered === true, state.body)
    }

    // A non-remote path is refused outright on enable.
    {
      const { res, state } = fakeRes()
      await findDetach(ROUTES.enable).handler(fakeReq({
        method: 'POST',
        headers: { host: 'localhost:4074', 'content-type': 'application/json' },
        body: { workspacePath: 'C:/Users/dev/proj' },
      }), res)
      check('enable refuses a local path', state.status === 400, String(state.status))
    }

    // Fences on both new routes.
    for (const routePath of [ROUTES.unmount, ROUTES.enable]) {
      const { res, state } = fakeRes()
      await findDetach(routePath).handler(fakeReq({ method: 'POST', remoteAddress: '10.0.0.5', headers: { 'content-type': 'application/json' } }), res)
      check(`${routePath} refuses a non-loopback request`, state.status === 403, String(state.status))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- test connection / disconnect ------------------------------------------
//
// Two requirements, both about what these two endpoints must NOT leave behind:
//
//   1. dropping the SSH connection takes its port forwards with it;
//   2. "test" proves the host answers and then releases the connection, so a
//      probe never quietly doubles as "connect".
//
// The second is asserted from the pool's own perspective: after a successful
// test the alias must be ABSENT from the pool, not merely reported as released.
{
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { HostConfigStore } = await import(pathToFileURL(path.join(pluginRoot, 'lib/store.js')).href)
  const { ForwardManager } = await import(pathToFileURL(path.join(pluginRoot, 'lib/forward.js')).href)

  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-routes-probe-'))
  try {
    const store = new HostConfigStore(path.join(dir, 'dsh-ssh.json'))

    // A pool double: `acquire` inserts, `forget` removes — the two operations
    // the routes use to establish and release a connection.
    const pool = new Map()
    const makeRecord = (holds = 0) => ({ alias: 'alpha', client: { end () {}, once () {}, off () {} }, holds, inFlight: 0, idleAt: Date.now(), broken: false })
    const forgets = []
    const probeEngine = {
      pool,
      store: { entryStore: store },
      capabilities: new Map(),
      async acquire (alias) {
        const existing = pool.get(alias)
        if (existing !== undefined) return existing
        const record = makeRecord()
        pool.set(alias, record)
        return record
      },
      forget (alias) { forgets.push(alias); pool.delete(alias) },
      assertNotDisabled () {},
      async withSftp (_alias, fn) { return await fn({ stat: (_p, cb) => cb(undefined, { isDirectory: () => true }) }) },
    }

    // A forward manager whose "connection" is the pool record above, so the
    // hold bookkeeping is real code rather than a stub.
    const forwardsReal = new ForwardManager({ engine: probeEngine })
    const probeRoutes = makeRoutes({
      engine: probeEngine,
      router: { assertEnabled () {} },
      forwards: forwardsReal,
      ctx: { get: () => undefined },
    })
    const findProbe = (routePath) => probeRoutes.find(route => route.path === routePath)
    check('the test and disconnect routes are registered',
      findProbe(ROUTES.test) !== undefined && findProbe(ROUTES.hostDisconnect) !== undefined)

    // --- test proves the host, then releases it ---------------------------
    {
      pool.clear()
      forgets.length = 0
      const { res, state } = fakeRes()
      await findProbe(ROUTES.test).handler(fakeReq({
        method: 'POST',
        headers: { host: 'localhost:4074', 'content-type': 'application/json' },
        body: { alias: 'alpha' },
      }), res)
      const body = JSON.parse(state.body)
      check('a successful test answers ok', body.ok === true, state.body)
      check('a successful test reports the round trip', Number.isInteger(body.durationMs), state.body)
      check('a successful test reports that it released the connection', body.released === true, state.body)
      check('a successful test leaves the pool empty', pool.size === 0, String(pool.size))
      check('a successful test went through forget()', forgets.includes('alpha'), JSON.stringify(forgets))
    }

    // A test whose connection is pinned by an open forward must NOT tear it
    // down: doing so would break a tunnel the user never asked to close.
    {
      pool.clear()
      forgets.length = 0
      const record = makeRecord()
      pool.set('alpha', record)
      // Pin it the way a real forward does.
      record.holds = 1
      const { res, state } = fakeRes()
      await findProbe(ROUTES.test).handler(fakeReq({
        method: 'POST',
        headers: { host: 'localhost:4074', 'content-type': 'application/json' },
        body: { alias: 'alpha' },
      }), res)
      const body = JSON.parse(state.body)
      check('a test still answers ok while a forward holds the connection', body.ok === true, state.body)
      check('a held connection is not released', body.released === false, state.body)
      check('a held connection survives the probe', pool.has('alpha') === true)
      check('a held connection explains why it stayed', String(body.heldBy).includes('forward'), state.body)
    }

    // A connection the user ALREADY had open is not this probe's to drop.
    // Releasing it would turn "check the host answers" into "disconnect me".
    {
      pool.clear()
      forgets.length = 0
      pool.set('alpha', makeRecord())
      const { res, state } = fakeRes()
      await findProbe(ROUTES.test).handler(fakeReq({
        method: 'POST',
        headers: { host: 'localhost:4074', 'content-type': 'application/json' },
        body: { alias: 'alpha' },
      }), res)
      const body = JSON.parse(state.body)
      check('a pre-existing connection is not released by a test', body.released === false, state.body)
      check('a pre-existing connection survives the probe', pool.has('alpha') === true)
      check('a pre-existing connection explains why it stayed', String(body.heldBy).includes('already open'), state.body)
      check('a pre-existing connection was not forgotten', forgets.length === 0, JSON.stringify(forgets))
    }

    // --- disconnect takes the forwards with it ----------------------------
    {
      pool.clear()
      // A saved row is not needed: a live tunnel is what matters here.
      const record = makeRecord()
      pool.set('alpha', record)
      const opened = await forwardsReal.open('alpha', { remotePort: 8080, localPort: 0 })
      check('a forward is live before the disconnect', forwardsReal.list().length === 1, JSON.stringify(forwardsReal.list()))
      check('the forward pinned the connection', record.holds === 1, String(record.holds))

      const { res, state } = fakeRes()
      await findProbe(ROUTES.hostDisconnect).handler(fakeReq({
        method: 'POST',
        headers: { host: 'localhost:4074', 'content-type': 'application/json' },
        body: { alias: 'alpha' },
      }), res)
      const body = JSON.parse(state.body)
      check('disconnect answers ok', body.ok === true, state.body)
      check('disconnect reports the connection gone', body.disconnected === true, state.body)
      check('disconnect reports how many forwards it closed', body.closedForwards === 1, state.body)
      check('disconnect removed the forward', forwardsReal.list().length === 0, JSON.stringify(forwardsReal.list()))
      check('disconnect released the hold', record.holds === 0, String(record.holds))
      check('disconnect dropped the pooled connection', pool.size === 0, String(pool.size))
      check('the local port is free again', await new Promise((resolve) => {
        const probe = createServer(() => {})
        probe.once('error', () => resolve(false))
        probe.listen(opened.localPort, '127.0.0.1', () => { probe.close(() => resolve(true)) })
      }) === true, String(opened.localPort))
    }

    // --- a deliberate disconnect leaves saved tunnels like a manual close --
    //
    // With saved mappings present the route must NOT take the unplanned-drop
    // path: that keeps `enabled` on and records "SSH connection closed", which
    // the panel renders as a red "connection lost" line. The user asked for the
    // shutdown, so the row has to end up exactly where the row's own close
    // button leaves it.
    {
      const { SavedForwardManager } = await import(pathToFileURL(path.join(pluginRoot, 'lib/forward-persist.js')).href)
      pool.clear()
      const record = makeRecord()
      pool.set('alpha', record)
      const savedForwards = new SavedForwardManager({ forwards: forwardsReal, store })
      forwardsReal.onClosed = (entry, reason) => { savedForwards.noteClosed(entry, reason) }

      const port = await new Promise((resolve) => {
        const server = createServer(() => {})
        server.listen(0, '127.0.0.1', () => {
          const bound = server.address().port
          server.close(() => resolve(bound))
        })
      })
      store.putForward({ id: 'fwd-route', alias: 'alpha', remotePort: 8080, localPort: port, enabled: true })
      await savedForwards.openById('fwd-route')
      check('a saved tunnel is live before the route disconnect',
        savedForwards.list().find(row => row.id === 'fwd-route')?.live === true,
        JSON.stringify(savedForwards.list()))

      const routesWithSaved = makeRoutes({
        engine: probeEngine,
        router: { assertEnabled () {} },
        forwards: forwardsReal,
        savedForwards,
        ctx: { get: () => undefined },
      })
      const { res, state } = fakeRes()
      await routesWithSaved.find(route => route.path === ROUTES.hostDisconnect).handler(fakeReq({
        method: 'POST',
        headers: { host: 'localhost:4074', 'content-type': 'application/json' },
        body: { alias: 'alpha' },
      }), res)
      const body = JSON.parse(state.body)
      const row = savedForwards.list().find(entry => entry.id === 'fwd-route')
      check('the route reports the tunnel it closed', body.closedForwards === 1, state.body)
      check('a deliberate route disconnect stops the listener', row?.live === false, JSON.stringify(row))
      check('a deliberate route disconnect turns the intent off', row?.enabled === false, JSON.stringify(row))
      check('a deliberate route disconnect records no failure', row?.error === undefined, JSON.stringify(row?.error))
      savedForwards.closeAlias('alpha')
      store.deleteForward('fwd-route')
      // Deliberately NOT disposing `forwardsReal`: the block below keeps using
      // it, and a disposed manager throws on the next open.
      forwardsReal.onClosed = undefined
    }

    // --- closing a forward must NOT disconnect the host -------------------
    //
    // The reverse direction: a tunnel going away is not a reason to drop the
    // connection. Asserted because both actions touch the same record, and a
    // future refactor that routed one through the other would be silent.
    {
      pool.clear()
      const record = makeRecord()
      pool.set('alpha', record)
      const opened = await forwardsReal.open('alpha', { remotePort: 8081, localPort: 0 })
      forwardsReal.close(opened.id)
      check('closing a forward releases its hold', record.holds === 0, String(record.holds))
      check('closing a forward keeps the host connected', pool.has('alpha') === true)
      forwardsReal.dispose()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
process.exit(failures === 0 ? 0 : 1)