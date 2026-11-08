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
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import os from 'node:os'
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
// ---------------------------------------------------------------------------
// Provenance travels with the status payload
// ---------------------------------------------------------------------------
// Asserted against the SOURCE rather than a live route: this suite needs the
// assembled tree for its route tests and skips without one, and a skip in CI is
// exactly where "the payload stopped carrying its ages" would go unnoticed. A
// source check runs everywhere.
{
  const source = readFileSync(path.join(pluginRoot, 'lib', 'routes.js'), 'utf8')
  // Anchored on the exact property name AND the call, because a renamed field
  // (`provenanceDisabled: statusProvenance(...)`) satisfies "a statusProvenance
  // call exists" while the panel reads `status.provenance` and renders nothing.
  check('the status route ships a field literally named `provenance`',
    /^\s{8,}provenance: statusProvenance\(\{/mu.test(source),
    'no `provenance:` field')
  check('...computed from the probe cache, not a constant',
    /oldestProbe\(engine\)/u.test(source), 'no oldestProbe call')
  // The panel reads `status.provenance.capabilities`; a renamed field would make
  // it render nothing while every other assertion here still passed.
  const client = readFileSync(path.join(pluginRoot, 'lib', 'client.js'), 'utf8')
  check('...under the name the panel reads',
    /status\.provenance\?\.capabilities/u.test(client), 'panel reads a different field')
}

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
  const state = { opened: 0, closed: 0, renamed: [], unlinked: [], mkdirs: [], holds: 0, holdPeak: 0, inFlight: 0 }
  return {
    state,
    async withSftp (_alias, work) {
      // The record is passed to the callback the way the real engine passes it:
      // `holds` is the sweeper's long-lived-consumer counter, and a streaming
      // read pins it for as long as the generator is open (see openRemoteRead).
      const record = { holds: 0, idleAt: Date.now(), inFlight: 0 }
      state.record = record
      state.inFlight += 1
      try {
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
          // Record what the route actually asked for. The upload path opens
          // staging files with 'wx' (O_EXCL) so two concurrent uploads to one
          // destination cannot share a staging name — a double that only knows
          // 'w' would silently send that request down the READ branch, which is
          // how this stub hid the flag change instead of verifying it.
          state.openFlags = [...(state.openFlags ?? []), { target, flags }]
          if (flags.includes('w')) {
            // Writes go to a buffer the handle accumulates; publish renames it.
            callback(null, { __content: Buffer.alloc(0), __write: true, __target: target })
            return
          }
          // `r+` is a WRITE open too — it keeps the bytes already there and
          // publishes them on close. The chunked upload transport depends on
          // exactly that: chunk N reopens the staging file its predecessor
          // closed, appends at an offset, and the last one renames it. A double
          // that treated `r+` as read-only would deliver a file holding only the
          // first chunk, which is the silent truncation this suite exists to
          // catch.
          if (flags.includes('r+')) {
            const existing = files.get(target)
            if (existing === undefined) { callback(Object.assign(new Error('no such file'), { code: 2 })); return }
            callback(null, { __content: existing, __write: true, __target: target })
            return
          }
          const content = files.get(target)
          if (content === undefined) { callback(Object.assign(new Error('no such file'), { code: 2 })); return }
          callback(null, { __content: content, __position: 0 })
        },
        write (handle, buffer, offset, length, position, callback) {
          // `position` is honoured, not appended. The stub used to do
          // `handle.__content = concat([__content, ...])`, which IGNORES the
          // offset — so a route that wrote every chunk at offset 0 (the real bug
          // that shipped: a 700 MB upload landed as one 64 KiB chunk while the
          // response said `ok: true`) produced a correct-looking file here. A
          // double that cannot represent the bug cannot catch it.
          const start = typeof position === 'number' && position >= 0 ? position : handle.__content.length
          const end = start + length
          if (handle.__content.length < end) {
            const grown = Buffer.alloc(end)
            handle.__content.copy(grown, 0)
            handle.__content = grown
          }
          buffer.copy(handle.__content, start, offset, offset + length)
          state.writes = [...(state.writes ?? []), { position: start, length }]
          callback(null)
        },
        read (handle, buffer, offset, length, position, callback) {
          // The stream is live right now, so this is where the connection pin
          // must be observable. Recording it here (rather than after the
          // request returns) is the difference between "the hold was released"
          // and "the hold was never taken".
          state.holdsDuringStream = state.record?.holds ?? 0
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
      }, record)
      } finally {
        state.inFlight -= 1
      }
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
  // The sweeper reaps a connection whose `holds` is 0 and whose idle time
  // exceeds the timeout, so a download that outlives `idleTimeoutMs` must pin
  // the connection for as long as its stream is open. `withSftp` alone cannot
  // do this: it decrements `inFlight` when the callback returns, and the
  // callback returns a generator, so the read happens outside that window.
  check('the connection is pinned while the stream is live',
    engine.state.holdsDuringStream >= 1, String(engine.state.holdsDuringStream))
  check('the pin is released once the stream ends',
    (engine.state.record?.holds ?? -1) === 0, String(engine.state.record?.holds))
}

// --- download: a file name node refuses to put in a header ----------------
//
// The failure being guarded is node's own, not ours: `res.writeHead` throws
// `ERR_INVALID_CHAR` for any byte outside Latin-1 in a header value, and a
// remote file name is UTF-8. A request double cannot reproduce that — `fakeRes`
// accepts everything it is handed — so this block runs the real handler on a
// REAL http server and lets node judge the header. That is the only way the
// assertion below can fail for the reason it claims to.
//
// Measured before the fix, against the running app: a 149 605-byte
// `dzfp_…_戚盈凯_….pdf` answered 500 with
// `{"error":"Invalid character in header content [\"content-disposition\"]"}`.
{
  const name = 'dzfp_20260602_戚盈凯_发票.pdf'
  const payload = Buffer.from('%PDF-1.4\n% remote invoice\n')
  const files = new Map([[`/srv/${name}`, payload]])
  const localEngine = fakeEngine(files)
  const localRoutes = makeRoutes({ engine: localEngine, router: {}, forwards, shells, ctx: { get: () => undefined } })
  const route = localRoutes.find(entry => entry.path === ROUTES.download)
  const server = createHttpServer((req, res) => {
    // The handler answers its own failures; a throw here would be the bug.
    route.handler(req, res).catch(() => { try { res.writeHead(599); res.end() } catch { /* closed */ } })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const result = await httpGetOnce(port, `/download?alias=a&path=${encodeURIComponent(`/srv/${name}`)}`)
    check('a non-ASCII name downloads instead of throwing ERR_INVALID_CHAR',
      result.status === 200, `status=${result.status} body=${result.body.toString('utf8').slice(0, 160)}`)
    check('the bytes arrive whole', result.body.equals(payload),
      `${result.body.length} of ${payload.length}`)
    const disposition = String(result.headers['content-disposition'] ?? '')
    check('every byte of the disposition is ASCII',
      /^[\x20-\x7e]*$/u.test(disposition), JSON.stringify(disposition))
    const star = /filename\*=UTF-8''([^;]+)/u.exec(disposition)?.[1]
    check('the real name travels in the extended form',
      star !== undefined && decodeURIComponent(star) === name, String(star))
    const plain = /filename="([^"]*)"/u.exec(disposition)?.[1]
    check('the ASCII fallback keeps the extension',
      /^[\x20-\x7e]*[.]pdf$/u.test(plain ?? ''), String(plain))
  } finally {
    await new Promise(resolve => server.close(resolve))
  }

  // A remote name carrying CRLF must not become a header line. Either outcome
  // is safe — a refusal keeps the bytes off the wire — so both are accepted,
  // but a 200 that SHIPPED a line break is not. The name's own text (here
  // "x-injected") is not evidence of anything: it travels inside a quoted
  // string when the header is well formed.
  const hostile = 'evil\r\nx-injected: yes.txt'
  files.set(`/srv/${hostile}`, Buffer.from('x'))
  const server2 = createHttpServer((req, res) => {
    route.handler(req, res).catch(() => { try { res.writeHead(599); res.end() } catch { /* closed */ } })
  })
  await new Promise(resolve => server2.listen(0, '127.0.0.1', resolve))
  const port2 = server2.address().port
  try {
    const result = await httpGetOnce(port2, `/download?alias=a&path=${encodeURIComponent(`/srv/${hostile}`)}`)
    const disposition = String(result.headers['content-disposition'] ?? '')
    check('a CRLF in the remote name never reaches the headers',
      result.status !== 200 || (!/[\r\n]/u.test(disposition) && /^[\x20-\x7e]*$/u.test(disposition)),
      `status=${result.status} disposition=${JSON.stringify(disposition)}`)
    check('the two halves of the name are not run together',
      result.status !== 200 || /evil__x-injected/u.test(disposition),
      `status=${result.status} disposition=${JSON.stringify(disposition)}`)
  } finally {
    await new Promise(resolve => server2.close(resolve))
  }
}

/**
 * One GET against a live server, collecting status, headers and body.
 *
 * @param {number} port - the listening port.
 * @param {string} urlPath - path plus query.
 * @returns {Promise<{ status: number, headers: object, body: Buffer }>} the reply.
 */
function httpGetOnce (port, urlPath) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path: urlPath,
      method: 'GET',
      headers: { host: `localhost:${port}`, connection: 'close' },
    }, (response) => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }))
      response.on('error', reject)
    })
    request.on('error', reject)
    request.end()
  })
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

// --- download-tree (the archive route) ------------------------------------
//
// A browser cannot be handed a folder, so "download this directory" is answered
// as one tar archive. The route must refuse everything the single-file route
// refuses, and must also refuse the case that route accepts (a plain file):
// the two answer different questions, and a file sent through the archive route
// would arrive as a tar the user did not ask for.
const downloadTree = routes.find(route => route.path === ROUTES.downloadTree)
check('the directory-archive route is registered', downloadTree !== undefined)

{
  const { res, state } = fakeRes()
  await downloadTree.handler(fakeReq({ remoteAddress: '10.0.0.5' }), res)
  check('a non-loopback archive request is refused', state.status === 403, String(state.status))
}

{
  const { res, state } = fakeRes()
  await downloadTree.handler(fakeReq({ headers: { host: 'evil.example:4074' } }), res)
  check('a rebinding Host is refused for the archive route', state.status === 403, String(state.status))
}

{
  const { res, state } = fakeRes()
  await downloadTree.handler(fakeReq({ method: 'POST', headers: { host: 'localhost:4074' } }), res)
  check('a non-GET archive request is refused', state.status === 405, String(state.status))
}

{
  const { res, state } = fakeRes()
  await downloadTree.handler(fakeReq({ url: `${ROUTES.downloadTree}?alias=a`, headers: { host: 'localhost:4074' } }), res)
  check('an archive request without a path is refused', state.status === 400, String(state.status))
}

{
  const { res, state } = fakeRes()
  await downloadTree.handler(fakeReq({
    url: `${ROUTES.downloadTree}?alias=a&path=${encodeURIComponent('/srv/missing')}`,
    headers: { host: 'localhost:4074' },
  }), res)
  check('a missing remote directory answers 404', state.status === 404, String(state.status))
}

{
  // A FILE through the archive route: the status line has to say so, because
  // once headers are out the only signal left is a truncated archive.
  const { res, state } = fakeRes()
  await downloadTree.handler(fakeReq({
    url: `${ROUTES.downloadTree}?alias=a&path=${encodeURIComponent('/srv/report.txt')}`,
    headers: { host: 'localhost:4074' },
  }), res)
  check('a plain file is refused by the archive route', state.status === 400, String(state.status))
  check('...and the refusal names the route that does handle it',
    String(JSON.parse(state.body).error ?? '').includes('/download'), state.body)
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
function fakeUploadReq ({ url, host = 'localhost:4074', chunks, method = 'POST', contentType = 'application/octet-stream', remoteAddress = '127.0.0.1' }) {
  let index = 0
  return {
    method,
    url,
    // `null` means "send no Content-Type at all": a default parameter would
    // silently turn an explicit `undefined` into the accepted type, which is
    // exactly the case this fixture exists to send.
    headers: contentType === null ? { host } : { host, 'content-type': contentType },
    socket: { remoteAddress, localPort: 4074 },
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

// --- upload: an empty file is still a real upload -------------------------
//
// A zero-byte file is not a no-op: the staging file must be created, published
// by rename and reported as `bytes: 0`. Reported from the field as a failure,
// so it is pinned here — `for await` over a stream with no chunk must still
// reach the publish step instead of falling through as "nothing to send".
{
  const files = new Map()
  const emptyEngine = fakeEngine(files)
  const emptyRoutes = makeRoutes({
    engine: emptyEngine, router: {}, forwards, shells, ctx: { get: () => undefined },
  })
  const emptyUpload = emptyRoutes.find(route => route.path === ROUTES.upload)
  const { res, state } = fakeRes()
  await emptyUpload.handler(fakeUploadReq({
    url: `${ROUTES.upload}?alias=a&path=${encodeURIComponent('/srv/app')}&name=${encodeURIComponent('empty.txt')}`,
    chunks: [],
  }), res)
  const body = JSON.parse(state.body)
  check('a zero-byte upload succeeds', body.ok === true && body.bytes === 0, state.body)
  check('a zero-byte upload reports the destination path',
    body.remotePath === '/srv/app/empty.txt', String(body.remotePath))
  check('a zero-byte upload still publishes by rename',
    emptyEngine.state.renamed.length === 1 && emptyEngine.state.renamed[0][1] === '/srv/app/empty.txt',
    JSON.stringify(emptyEngine.state.renamed))
  check('a zero-byte upload leaves an empty file at the destination',
    files.get('/srv/app/empty.txt')?.length === 0, String(files.get('/srv/app/empty.txt')?.length))
}

// --- upload: the chunked JSON transport -----------------------------------
//
// The desktop shell serves the panel from `dsh-app://app/`, where a request
// body that is a Blob never reaches a handler: the network service fails it
// with `net::ERR_UNEXPECTED` ("请求在 0 秒后中断" in the panel) before any code of
// ours runs. JSON bodies are what every other action already posts through that
// scheme, so the same bytes travel base64-encoded, one bounded chunk per
// request. These pin the APPEND semantics, which is where a silent truncation
// would live: chunk 2 must add to chunk 1 rather than replace it.
const chunkRoute = routes.find(route => route.path === ROUTES.uploadChunk)
check('the chunked upload route is registered', chunkRoute !== undefined)

async function postChunk (route, body, chunks = []) {
  const { res, state } = fakeRes()
  await route.handler(fakeReq({
    method: 'POST',
    url: ROUTES.uploadChunk,
    headers: { host: 'localhost:4074', 'content-type': 'application/json' },
    body,
  }), res)
  return state
}
{
  const files = new Map()
  const chunkEngine = fakeEngine(files)
  const chunkRoutes = makeRoutes({ engine: chunkEngine, router: {}, forwards, shells, ctx: { get: () => undefined } })
  const route = chunkRoutes.find(entry => entry.path === ROUTES.uploadChunk)
  const dir = '/srv/chunked'
  const name = 'three-chunks.bin'
  const uploadId = 'a'.repeat(32)
  const parts = [Buffer.from('abc'), Buffer.from('de'), Buffer.from('fghi')]
  let offset = 0
  for (const [index, part] of parts.entries()) {
    const state = await postChunk(route, {
      alias: 'a',
      path: dir,
      name,
      uploadId,
      offset,
      data: Buffer.from(part).toString('base64'),
      final: index === parts.length - 1,
    })
    check(`chunk ${index} is accepted`, JSON.parse(state.body).ok === true, state.body)
    offset += part.length
  }
  check('the chunks are concatenated in order, not overwritten',
    files.get(`${dir}/${name}`)?.toString() === 'abcdefghi', String(files.get(`${dir}/${name}`)))
  check('the chunked upload publishes exactly once',
    chunkEngine.state.renamed.length === 1 && chunkEngine.state.renamed[0][1] === `${dir}/${name}`,
    JSON.stringify(chunkEngine.state.renamed))
  check('the first chunk truncates any previous attempt for the same id',
    chunkEngine.state.openFlags[0]?.flags === 'w', String(chunkEngine.state.openFlags[0]?.flags))
  check('later chunks reopen the staging file for appending',
    chunkEngine.state.openFlags.slice(1).every(entry => entry.flags === 'r+'),
    JSON.stringify(chunkEngine.state.openFlags.slice(1)))
  check('a zero-byte file still lands when sent as one empty chunk', await (async () => {
    const emptyFile = await postChunk(route, {
      alias: 'a', path: dir, name: 'empty.bin', uploadId: 'b'.repeat(32), offset: 0, data: '', final: true,
    })
    return JSON.parse(emptyFile.body).ok === true && files.get(`${dir}/empty.bin`)?.length === 0
  })() === true)
  check('a chunk whose staging file is gone is refused, not written mid-file', await (async () => {
    const missing = await postChunk(route, {
      alias: 'a', path: dir, name: 'orphan.bin', uploadId: 'c'.repeat(32), offset: 0, data: '', final: false,
    })
    const second = await postChunk(route, {
      alias: 'a', path: dir, name: 'orphan.bin', uploadId: 'd'.repeat(32), offset: 3, data: 'AAAA', final: false,
    })
    return JSON.parse(missing.body).ok === true && JSON.parse(second.body).ok !== true
  })() === true)
  check('an abort removes the staged part and publishes nothing', await (async () => {
    const before = chunkEngine.state.unlinked.length
    const abort = await postChunk(route, {
      alias: 'a', path: dir, name: 'aborted.bin', uploadId: 'e'.repeat(32), offset: 0, data: '', final: false, abort: true,
    })
    return JSON.parse(abort.body).aborted === true && chunkEngine.state.unlinked.length >= before + 1 &&
      !files.has(`${dir}/aborted.bin`)
  })() === true)
  for (const [label, body] of [
    ['a name with a separator', { name: '../escape.txt' }],
    ['a non-hex upload id', { uploadId: '../../etc' }],
    ['an offset past the size limit', { offset: 2 * 1024 * 1024 * 1024 }],
    ['a non-integer offset', { offset: 1.5 }],
    ['data that is not base64', { data: 'not base64 !!!' }],
  ]) {
    const state = await postChunk(route, {
      alias: 'a', path: dir, name: 'x.bin', uploadId: 'f'.repeat(32), offset: 0, data: '', final: false, ...body,
    })
    check(`the chunked route refuses ${label}`, state.status === 400, `status=${state.status} ${state.body}`)
  }
}

// --- upload: the host's whole-request deadline ----------------------------
//
// The DSH web server builds `node:http` with DEFAULT options, so
// `requestTimeout` is 300 000 ms — a deadline on receiving the ENTIRE request,
// not on idleness. A browser sending a large file is cut off mid-body once five
// minutes pass and reports it as `Failed to fetch`, a message that names
// neither the size nor the deadline. The route raises the deadline for the
// duration of the body read and restores it when the last upload ends.
//
// Every case here is a property of the WINDOW, not of a particular file size:
// what can be asserted without waiting five minutes is that the value is raised
// while a body is arriving, restored afterwards, and never left raised.
{
  const server = { requestTimeout: 300_000, setTimeout () {} }
  const gated = makeRoutes({
    engine: fakeEngine(new Map()),
    router: {},
    forwards,
    shells,
    ctx: { get: (name) => (name === 'webServer' ? { server } : undefined) },
  })
  const gatedUpload = gated.find(route => route.path === ROUTES.upload)
  const ask = (name) => `${ROUTES.upload}?alias=a&path=${encodeURIComponent('/srv/app')}&name=${encodeURIComponent(name)}`

  {
    const { res, state } = fakeRes()
    // Not awaited yet: the window opens synchronously at the top of the
    // handler, which is the only instant at which the raised value is
    // observable without holding a real socket open.
    const running = gatedUpload.handler(fakeUploadReq({ url: ask('big.bin'), chunks: [Buffer.from('x')] }), res)
    check('an upload raises the host request deadline while its body is arriving',
      server.requestTimeout === 7_200_000, String(server.requestTimeout))
    await running
    check('the raised deadline is restored when that upload ends',
      server.requestTimeout === 300_000, String(server.requestTimeout))
    check('raising the deadline does not disturb the upload itself',
      JSON.parse(state.body).ok === true, state.body)
  }

  {
    // Two uploads overlap, and one finishes FIRST. The deadline must stay
    // raised until BOTH finish: restoring on the first would cut the second off
    // at what it believes is a five-minute limit while a body is still
    // arriving. The bodies are gated so the interleaving is real rather than
    // merely microtask-scheduled.
    let openFirst
    let openSecond
    const firstGate = new Promise((resolve) => { openFirst = resolve })
    const secondGate = new Promise((resolve) => { openSecond = resolve })
    const gatedReq = (url, gate) => {
      let sent = false
      return {
        method: 'POST',
        url,
        headers: { host: 'localhost:4074', 'content-type': 'application/octet-stream' },
        socket: { remoteAddress: '127.0.0.1', localPort: 4074 },
        on () {},
        [Symbol.asyncIterator] () {
          return {
            async next () {
              if (sent) return { done: true, value: undefined }
              sent = true
              await gate
              return { done: false, value: Buffer.from('x') }
            },
          }
        },
      }
    }
    const first = gatedUpload.handler(gatedReq(ask('one.bin'), firstGate), fakeRes().res)
    const second = gatedUpload.handler(gatedReq(ask('two.bin'), secondGate), fakeRes().res)
    openFirst()
    await first
    check('the deadline stays raised while a second upload is still open',
      server.requestTimeout === 7_200_000, String(server.requestTimeout))
    openSecond()
    await second
    check('the deadline is restored once the last upload ends',
      server.requestTimeout === 300_000, String(server.requestTimeout))
  }

  {
    // The primary source. Node puts the `http.Server` on every accepted socket,
    // so the route can raise the deadline from the response alone — without
    // depending on the host exposing its server through a service field whose
    // name we would otherwise have to guess. This deployment's `webServer`
    // service documents `host` and `protocol`; whether it also carries the node
    // server is not something the plugin should bet an upload on.
    const socketServer = { requestTimeout: 300_000, setTimeout () {} }
    const { res, state } = fakeRes()
    res.socket = { server: socketServer }
    const viaSocket = makeRoutes({
      engine: fakeEngine(new Map()),
      router: {},
      forwards,
      shells,
      ctx: { get: () => undefined },
    }).find(route => route.path === ROUTES.upload)
    const running = viaSocket.handler(fakeUploadReq({ url: ask('sock.bin'), chunks: [Buffer.from('s')] }), res)
    check('the deadline is raised from the response socket alone',
      socketServer.requestTimeout === 7_200_000, String(socketServer.requestTimeout))
    await running
    check('...and restored on that same server',
      socketServer.requestTimeout === 300_000, String(socketServer.requestTimeout))
    check('...while the upload still succeeds',
      JSON.parse(state.body).ok === true, state.body)
  }

  {
    // alone: writing a number over it would impose a limit that was
    // deliberately absent, turning a working deployment into a failing one.
    const disabled = { requestTimeout: 0, setTimeout () {} }
    const routesFor = makeRoutes({
      engine: fakeEngine(new Map()),
      router: {},
      forwards,
      shells,
      ctx: { get: (name) => (name === 'webServer' ? { server: disabled } : undefined) },
    }).find(route => route.path === ROUTES.upload)
    await routesFor.handler(fakeUploadReq({ url: ask('x.bin'), chunks: [Buffer.from('x')] }), fakeRes().res)
    check('a host with the deadline disabled keeps it disabled',
      disabled.requestTimeout === 0, String(disabled.requestTimeout))
  }

  {
    // A deployment with no web server service (the route mounted elsewhere)
    // must still serve the upload — the window is an optimisation, not a
    // requirement.
    const headless = makeRoutes({
      engine: fakeEngine(new Map()),
      router: {},
      forwards,
      shells,
      ctx: { get: () => undefined },
    }).find(route => route.path === ROUTES.upload)
    const { res, state } = fakeRes()
    await headless.handler(fakeUploadReq({ url: ask('y.bin'), chunks: [Buffer.from('y')] }), res)
    check('an upload still succeeds when the web server service is unavailable',
      JSON.parse(state.body).ok === true, state.body)
  }

  check('the deadline is restored to the host value at the end of the block',
    server.requestTimeout === 300_000, String(server.requestTimeout))
}

{
  // A MULTI-CHUNK upload must land its bytes end to end.
  //
  // This is the regression the shipped route actually had: `sftpWriteHandle`
  // defaults its file offset to 0, and the upload loop called it without one, so
  // every chunk was written at offset 0 and each overwrote the last. The route
  // still answered `{ok: true, bytes: <the whole size>}` and published the
  // fragment under the destination name — silent truncation with a success
  // response. Measured against a real host: 300000 bytes on the wire, 65536 on
  // disk.
  //
  // The check above (`'hello remote'`) could never catch it: two 6-byte chunks
  // happen to produce the right content when the second overwrites the first
  // from offset 0, because the second chunk IS the whole answer. So the payload
  // here is deliberately several DISTINCT chunks of unequal length.
  const files = new Map()
  const localEngine = fakeEngine(files)
  const localRoutes = makeRoutes({
    engine: localEngine, router: {}, forwards, shells, ctx: { get: () => undefined },
  })
  const localUpload = localRoutes.find(route => route.path === ROUTES.upload)
  const { res, state } = fakeRes()
  const chunks = [Buffer.from('AAAA'), Buffer.from('BBBBBBBBB'), Buffer.from('CC')]
  const expected = Buffer.concat(chunks).toString()
  await localUpload.handler(fakeUploadReq({
    url: `${ROUTES.upload}?alias=a&path=${encodeURIComponent('/srv/app')}&name=multi.bin`,
    chunks,
  }), res)
  const body = JSON.parse(state.body)
  check('a multi-chunk upload reports the full byte count', body.bytes === expected.length, String(body.bytes))
  check('a multi-chunk upload keeps EVERY chunk, not just the last',
    files.get('/srv/app/multi.bin')?.toString() === expected,
    JSON.stringify(String(files.get('/srv/app/multi.bin'))))
  // Each chunk must be written at the offset it belongs at. Asserting the
  // positions directly names the defect even if a future doppelganger appends
  // instead of seeking.
  const positions = (localEngine.state.writes ?? []).map(entry => entry.position)
  check('each chunk is written at its own offset, starting at 0',
    positions.length === 3 && positions[0] === 0 && positions[1] === 4 && positions[2] === 13,
    JSON.stringify(positions))
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
  {
    // O-07's fix reached the agent tool but not this route for a long time: the
    // route kept `pid-Date.now().toString(36)` as its staging token and opened
    // `'w'`, so two uploads to one destination in the same millisecond shared a
    // staging path and the loser's cleanup deleted the winner's file.
    //
    // Both halves are asserted here, because either alone is insufficient:
    // randomness without O_EXCL still acts on a collision, and O_EXCL without
    // randomness turns a common case into a spurious failure.
    const { res, state } = fakeRes()
    await upload.handler(fakeUploadReq({
      url: `${ROUTES.upload}?alias=a&path=${encodeURIComponent('/srv/app')}&name=staged.txt`,
      chunks: [Buffer.from('z')],
    }), res)
    const opened = inRootsEngine.state.openFlags ?? []
    const stagingOpen = opened.find(entry => entry.target.startsWith('/srv/app/staged.txt.'))
    check('the upload opens a sibling staging name, never the destination',
      stagingOpen !== undefined && stagingOpen.target.startsWith('/srv/app/staged.txt.dsh-up-'),
      JSON.stringify(opened))
    check('the upload opens its staging file with wx (O_EXCL)',
      stagingOpen?.flags === 'wx', JSON.stringify(stagingOpen))
    check('the staging name carries a random suffix, not just a timestamp',
      // `pid-<base36 time>-<16 hex>`: the old spelling had no third segment, so
      // this fails if the timestamp-only token comes back.
      /\.dsh-up-\d+-[0-9a-z]+-[0-9a-f]{16}$/u.test(stagingOpen?.target ?? ''),
      String(stagingOpen?.target))
  }
}

// --- the reverse-forward TOOL is registered and wired ---------------------
//
// The route half above can pass while no tool exists: a manager reachable from
// the browser but not from the agent is half a feature, and the mutation that
// unregistered the tool left every route assertion green. These two assertions
// exist to make that impossible.
{
  const { workspaceTools } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'tools.js')).href)
  const reverseStub = { list: () => [], open: async () => ({ id: 'rfwd-9' }), close: () => true }
  const withReverse = workspaceTools({ get: () => undefined }, engine, {}, forwards, undefined, reverseStub)
  const names = withReverse.map(tool => tool.name)
  check('the agent is offered ssh_workspace_reverse_forward',
    names.includes('ssh_workspace_reverse_forward'), JSON.stringify(names))

  // Without the manager the tool must be ABSENT rather than present-and-broken:
  // a tool that always throws teaches the agent to stop calling it.
  const withoutReverse = workspaceTools({ get: () => undefined }, engine, {}, forwards, undefined, undefined)
  check('no reverse tool is offered when the manager is absent',
    !withoutReverse.map(tool => tool.name).includes('ssh_workspace_reverse_forward'),
    JSON.stringify(withoutReverse.map(tool => tool.name)))

  // unforward has to accept a reverse id: the local manager declines it.
  const unforward = withReverse.find(tool => tool.name === 'ssh_workspace_unforward')
  const closed = await unforward.execute({ id: 'rfwd-9' }, {})
  check('ssh_workspace_unforward falls through to the reverse manager',
    closed.ok === true && closed.closed === true, JSON.stringify(closed))
}

// --- reverse forwards through the SAME two routes -------------------------
//
// `ssh -R` reuses /forward and /unforward with `direction: 'reverse'` rather
// than adding routes. What has to be proven here is the part the manager's own
// suite cannot see: the ROUTE maps the request correctly, refuses a request it
// cannot honour with a sentence the user can act on, and lets unforward close a
// remote listener by its `rfwd-` id — the id space the local manager will
// always decline.
{
  const calls = []
  const reverseForwards = {
    list: () => [{ id: 'rfwd-1', alias: 'a', localHost: '127.0.0.1', localPort: 9000, remoteHost: '127.0.0.1', remotePort: 9100, requestedRemotePort: 0, exposed: false, connections: 0 }],
    open: async (alias, options) => {
      calls.push({ alias, options })
      return { id: 'rfwd-1', alias, localHost: options.localHost ?? '127.0.0.1', localPort: options.localPort, remoteHost: options.remoteHost ?? '127.0.0.1', remotePort: 9100, requestedRemotePort: options.remotePort, exposed: (options.remoteHost ?? '127.0.0.1') !== '127.0.0.1', connections: 0 }
    },
    close: (id) => id === 'rfwd-1',
  }
  const reverseRoutes = makeRoutes({
    engine, router: {}, forwards: { list: () => [], open: async () => ({}), close: () => false }, reverseForwards, shells, ctx: { get: () => undefined },
  })
  const find = (routePath) => reverseRoutes.find(route => route.path === routePath)
  const postTo = async (routePath, body) => {
    const route = find(routePath)
    const { res, state } = fakeRes()
    await route.handler(fakeReq({ method: 'POST', url: routePath, headers: { host: 'localhost:4074', 'content-type': 'application/json' }, body }), res)
    return { status: state.status, body: state.body === '' ? undefined : JSON.parse(state.body) }
  }

  {
    const state = await postTo(ROUTES.forward, { alias: 'a', direction: 'reverse', localPort: 9000, remotePort: 0 })
    check('POST /forward with direction=reverse reaches the reverse manager',
      calls.length === 1 && calls[0].alias === 'a' && calls[0].options.localPort === 9000 && calls[0].options.remotePort === 0,
      JSON.stringify(calls))
    check('and the reply carries the forward it opened',
      state.status === 200 && state.body?.ok === true && state.body?.forward?.id === 'rfwd-1',
      JSON.stringify(state))
  }

  {
    // remotePort 0 is legal here (the HOST picks), localPort 0 is not (there is
    // nothing to dial). Naming which one is missing is the difference between a
    // fixable message and "invalid request".
    const state = await postTo(ROUTES.forward, { alias: 'a', direction: 'reverse', remotePort: 0 })
    check('a reverse request without localPort is refused',
      state.body?.ok === false && /localPort/iu.test(String(state.body?.error ?? '')),
      JSON.stringify(state))
  }

  {
    const state = await postTo(ROUTES.forward, { alias: 'a', direction: 'reverse', localPort: 9000, remotePort: 70000 })
    check('a reverse request with an impossible port is refused',
      state.body?.ok === false && /65535/u.test(String(state.body?.error ?? '')),
      JSON.stringify(state))
  }

  {
    const state = await postTo(ROUTES.unforward, { id: 'rfwd-1' })
    check('POST /unforward closes a remote listener by its rfwd- id',
      state.status === 200 && state.body?.ok === true && state.body?.closed === true,
      JSON.stringify(state))
  }

  {
    // Without the manager the route must say so rather than silently report
    // success: an unreachable feature that answers 200 is indistinguishable
    // from a working one until the user checks the remote host.
    const noReverse = makeRoutes({ engine, router: {}, forwards: { list: () => [], open: async () => ({}), close: () => false }, shells, ctx: { get: () => undefined } })
    const route = noReverse.find(candidate => candidate.path === ROUTES.forward)
    const { res, state } = fakeRes()
    await route.handler(fakeReq({ method: 'POST', url: ROUTES.forward, headers: { host: 'localhost:4074', 'content-type': 'application/json' }, body: { alias: 'a', direction: 'reverse', localPort: 9000, remotePort: 0 } }), res)
    state.body = state.body === '' ? undefined : JSON.parse(state.body)
    check('a build without the reverse manager refuses instead of pretending',
      state.body?.ok === false && /unavailable/u.test(String(state.body?.error ?? '')),
      JSON.stringify(state))
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

// --- allowLan: the LAN-deployment fence ------------------------------------
//
// `allowLan` widens "who may call these endpoints" from the loopback interface
// to this machine's own addresses, for deployments whose webserver is bound to
// a LAN interface. Both halves of the fence must survive the widening: the
// remote address has to be loopback or a PRIVATE network one (a public address
// is still refused), and the Host header has to name this server — a rebound
// page must send its own hostname, so the anti-rebinding property carries
// over. The default mode keeps its historical wording byte for byte, asserted
// here explicitly so a future rewording is a conscious act.
{
  const doubles = () => ({
    engine: { pool: new Map(), store: { rows: () => [] } },
    router: { listRoots: () => [], listDisabled: () => [] },
    forwards: { list: () => [] },
    shells: { list: () => [] },
    ctx: { get: () => undefined },
  })

  // The engine behind the streaming routes must be able to serve a file, so
  // the download assertions prove the fence PASSES and the bytes flow — not
  // merely that the answer is not 403.
  const lanEngine = Object.assign(fakeEngine(new Map([
    ['/srv/report.txt', Buffer.from('hello from the remote host')],
  ])), { pool: new Map() })
  const lanRoutes = makeRoutes({
    ...doubles(),
    engine: lanEngine,
    allowLan: true,
    allowedHosts: ['Panel.LAN', ' panel2.lan '],
  })
  const lanStatus = lanRoutes.find(route => route.path === ROUTES.status)
  const lanDownload = lanRoutes.find(route => route.path === ROUTES.download)
  const lanUpload = lanRoutes.find(route => route.path === ROUTES.upload)

  const realHosts = Object.values(os.networkInterfaces()).flat()
    .filter(entry => entry?.internal === false && typeof entry?.address === 'string' && entry.address !== '')
    .map(entry => (entry.address.includes(':') ? `[${entry.address.toLowerCase()}]:4074` : `${entry.address.toLowerCase()}:4074`))

  // A private origin with a configured extra Host passes the shared guard —
  // and the configured value is normalized, so mixed case and stray spaces
  // still match.
  {
    const { res, state } = fakeRes()
    await lanStatus.handler(fakeReq({ remoteAddress: '192.168.1.244', headers: { host: 'panel.lan:4074' } }), res)
    check('allowLan admits a private origin with a configured Host', state.status === 200, `${state.status} ${state.body}`)
  }
  // The machine's own interface address is a valid Host by construction.
  if (realHosts.length > 0) {
    const { res, state } = fakeRes()
    await lanStatus.handler(fakeReq({ remoteAddress: '10.66.0.7', headers: { host: realHosts[0] } }), res)
    check(`allowLan admits the machine's own interface Host (${realHosts[0]})`, state.status === 200, `${state.status} ${state.body}`)
  } else {
    check("allowLan admits the machine's own interface Host", true, 'no non-internal interface on this machine — case not exercisable')
  }
  // All private-network address classes are admitted: RFC1918, the mapped
  // IPv4 spelling, IPv6 ULA and link-local (with its zone suffix).
  for (const [address, label] of [
    ['10.0.0.5', 'RFC1918'],
    ['172.16.5.5', 'RFC1918 172.16/12'],
    ['::ffff:192.168.9.9', 'mapped IPv4'],
    ['fd12:3456:789a::1', 'IPv6 ULA'],
    ['fe80::1%eth0', 'IPv6 link-local'],
  ]) {
    const { res, state } = fakeRes()
    await lanStatus.handler(fakeReq({ remoteAddress: address, headers: { host: 'panel2.lan:4074' } }), res)
    check(`allowLan admits a ${label} origin`, state.status === 200, `${state.status} ${state.body}`)
  }
  // A wrong Host is still refused, and the reason stays distinguishable from
  // the origin refusal.
  {
    const { res, state } = fakeRes()
    await lanStatus.handler(fakeReq({ remoteAddress: '192.168.1.244', headers: { host: 'evil.example:4074' } }), res)
    check('allowLan still refuses a rebinding Host header', state.status === 403, String(state.status))
    check('...naming the Host header as the cause', JSON.parse(state.body).error.includes('unexpected Host header'), state.body)
  }
  // A Host naming a DIFFERENT private address is not this server.
  {
    const { res, state } = fakeRes()
    await lanStatus.handler(fakeReq({ remoteAddress: '192.168.1.244', headers: { host: '192.168.1.1:4074' } }), res)
    check('allowLan refuses a Host that names another machine', state.status === 403, String(state.status))
  }
  // A public origin is refused even with a perfect Host, and the refusal says
  // why rather than claiming "loopback-only".
  {
    const { res, state } = fakeRes()
    await lanStatus.handler(fakeReq({ remoteAddress: '8.8.8.8', headers: { host: 'panel.lan:4074' } }), res)
    check('allowLan still refuses a public origin', state.status === 403, String(state.status))
    check('...naming the address class as the cause',
      JSON.parse(state.body).error.includes('neither loopback nor a private network address'), state.body)
  }
  // The byte-streaming routes apply the same verdict with their terse wording.
  {
    const { res, state } = fakeRes()
    await lanDownload.handler(fakeReq({
      url: `${ROUTES.download}?alias=a&path=${encodeURIComponent('/srv/report.txt')}`,
      remoteAddress: '192.168.1.244',
      headers: { host: 'panel.lan:4074' },
    }), res)
    check('allowLan lets a LAN browser download', state.status === 200, `${state.status} ${state.body}`)
    check('...the body is the remote content', state.body === 'hello from the remote host', JSON.stringify(state.body))
  }
  {
    const { res, state } = fakeRes()
    await lanDownload.handler(fakeReq({ remoteAddress: '192.168.1.244', headers: { host: 'evil.example:4074' } }), res)
    check('allowLan download still refuses a rebinding Host', state.status === 403 && state.body === '{"error":"forbidden"}',
      `${state.status} ${state.body}`)
  }
  {
    // `fakeReq` has no body iterator, so the handler used to fail past the
    // fence with `req is not async iterable` and still answer 200 — which made
    // "the route proceeds" pass for the wrong reason. The fixture now carries
    // real bytes, so 200 here means the upload actually ran.
    const { res, state } = fakeRes()
    await lanUpload.handler(fakeUploadReq({
      url: `${ROUTES.upload}?alias=a&path=${encodeURIComponent('/srv')}&name=x.txt`,
      host: 'panel.lan:4074',
      chunks: [Buffer.from('lan bytes')],
    }), res)
    check('allowLan upload passes the fence (route proceeds)', state.status === 200, `${state.status} ${state.body}`)
    check('...and writes the uploaded bytes', JSON.parse(state.body).ok === true && JSON.parse(state.body).bytes === 9,
      state.body)
  }
  {
    const { res, state } = fakeRes()
    await lanUpload.handler(fakeReq({
      method: 'POST',
      url: `${ROUTES.upload}?alias=a&path=${encodeURIComponent('/srv')}&name=x.txt`,
      remoteAddress: '8.8.8.8',
      headers: { host: 'panel.lan:4074' },
    }), res)
    check('allowLan upload still refuses a public origin', state.status === 403, String(state.status))
  }

  // Default mode: the wording the loopback fence has always answered with.
  const plainRoutes = makeRoutes(doubles())
  const plainStatus = plainRoutes.find(route => route.path === ROUTES.status)
  const plainDownload = plainRoutes.find(route => route.path === ROUTES.download)
  {
    const { res, state } = fakeRes()
    await plainStatus.handler(fakeReq({ remoteAddress: '192.168.1.244', headers: { host: 'panel.lan:4074' } }), res)
    check('default mode refuses a LAN origin with the historical wording',
      state.status === 403 && state.body === '{"error":"forbidden: loopback-only"}', `${state.status} ${state.body}`)
  }
  {
    const { res, state } = fakeRes()
    await plainStatus.handler(fakeReq({ remoteAddress: '127.0.0.1', headers: { host: 'evil.example:4074' } }), res)
    check('default mode refuses a rebinding Host with the historical wording',
      state.status === 403 && state.body === `{"error":"forbidden: unexpected Host header \\"evil.example:4074\\""}`,
      `${state.status} ${state.body}`)
  }
  {
    const { res, state } = fakeRes()
    await plainStatus.handler(fakeReq({ url: ROUTES.status, headers: { host: 'localhost:4074' } }), res)
    check('default mode still serves a loopback request', state.status === 200, `${state.status} ${state.body}`)
  }
  {
    const { res, state } = fakeRes()
    await plainDownload.handler(fakeReq({ remoteAddress: '192.168.1.244', headers: { host: 'panel.lan:4074' } }), res)
    check('default download keeps its terse refusal for a LAN origin',
      state.status === 403 && state.body === '{"error":"forbidden"}', `${state.status} ${state.body}`)
  }
}

// --- the error contract: a failure is a status, not a 200 with ok:false ---
//
// The route family used to answer almost every business failure with
// `200 + { ok: false, error }`, while parameter errors used 4xx. Two
// conventions in one file meant a caller had to read `response.ok`, parse the
// body, AND check `body.ok` — because either half could be the failure — and
// a monitor saw a wall of 200s. This block pins the contract from the route
// side, which is where the browser half's branches come from.
{
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { HostConfigStore } = await import(pathToFileURL(path.join(pluginRoot, 'lib/store.js')).href)

  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-routes-contract-'))
  try {
    const store = new HostConfigStore(path.join(dir, 'dsh-ssh.json'))
    const contractEngine = {
      pool: new Map(),
      store: { entryStore: store, sshConfigAliases: () => [] },
      capabilities: new Map(),
      forget () {},
      assertNotDisabled () {},
      async acquire () { throw Object.assign(new Error('host unreachable'), { code: 'EHOSTUNREACH' }) },
      async withSftp () { throw Object.assign(new Error('no such file'), { code: 'FS_NOT_FOUND' }) },
    }
    const contractRoutes = makeRoutes({
      engine: contractEngine,
      router: { assertEnabled () {}, roots: new Set(['ssh://a/srv']) },
      forwards: { list: () => [], open: async () => { throw new Error('cannot bind') }, close: () => false },
      shells,
      ctx: { get: () => undefined },
    })
    const findRoute = (routePath) => contractRoutes.find(route => route.path === routePath)

    // A duplicate alias is the caller's to fix: 409, not 200.
    {
      const { res, state } = fakeRes()
      await findRoute(ROUTES.hostSave).handler(fakeReq({
        method: 'POST',
        headers: { host: 'localhost:4074', 'content-type': 'application/json' },
        body: { alias: 'alpha', host: '10.0.0.1', user: 'dev', auth: { kind: 'agent' } },
      }), res)
      const body = JSON.parse(state.body)
      check('saving a new host succeeds with 200', state.status === 200 && body.ok === true, `${state.status} ${state.body}`)
      const { res: res2, state: state2 } = fakeRes()
      await findRoute(ROUTES.hostSave).handler(fakeReq({
        method: 'POST',
        headers: { host: 'localhost:4074', 'content-type': 'application/json' },
        body: { alias: 'alpha', host: '10.0.0.2', user: 'dev', auth: { kind: 'agent' } },
      }), res2)
      check('saving a duplicate alias answers 409, not 200',
        state2.status === 409, `${state2.status} ${state2.body}`)
      check('the duplicate is still explained in the body',
        JSON.parse(state2.body).error.includes('already exists'), state2.body)
    }

    // A form the store rejects is the caller's to fix too: 400.
    {
      const { res, state } = fakeRes()
      await findRoute(ROUTES.hostSave).handler(fakeReq({
        method: 'POST',
        headers: { host: 'localhost:4074', 'content-type': 'application/json' },
        body: { alias: 'beta', host: '', user: 'dev', auth: { kind: 'agent' } },
      }), res)
      check('an invalid host form answers 400, not 200', state.status === 400, `${state.status} ${state.body}`)
      check('...and says what was wrong', typeof JSON.parse(state.body).error === 'string', state.body)
    }

    // Tags had no way IN: the store kept them, the search box and the agent
    // tool both matched them, and this route dropped the field on the floor —
    // so the panel's editor could have posted anything and nothing was saved.
    {
      const { res, state } = fakeRes()
      await findRoute(ROUTES.hostSave).handler(fakeReq({
        method: 'POST',
        headers: { host: 'localhost:4074', 'content-type': 'application/json' },
        body: {
          alias: 'gamma', host: '10.0.0.3', user: 'dev', auth: { kind: 'agent' },
          tags: ['  prod  ', 'prod', '', 'db', 42],
        },
      }), res)
      check('saving a host with tags succeeds', state.status === 200, `${state.status} ${state.body}`)
      const rows = contractEngine.store.entryStore.load()
      const saved = rows.find(row => row.alias === 'gamma')
      check('the tags survive the save route', Array.isArray(saved?.tags) && saved.tags.length === 2,
        JSON.stringify(saved?.tags))
      check('...trimmed and de-duplicated, with non-strings dropped',
        JSON.stringify(saved?.tags) === JSON.stringify(['prod', 'db']), JSON.stringify(saved?.tags))
      check('...and a blank list is stored as an empty array, not omitted',
        Array.isArray(rows.find(row => row.alias === 'alpha')?.tags),
        JSON.stringify(rows.find(row => row.alias === 'alpha')?.tags))
    }

    // A transport failure is not the caller's fault: 502.
    {
      const { res, state } = fakeRes()
      await findRoute(ROUTES.forward).handler(fakeReq({
        method: 'POST',
        headers: { host: 'localhost:4074', 'content-type': 'application/json' },
        body: { alias: 'alpha', remotePort: 8080 },
      }), res)
      check('a host that cannot be reached answers 502, not 200',
        state.status === 502, `${state.status} ${state.body}`)
      check('...and still explains itself', typeof JSON.parse(state.body).error === 'string', state.body)
    }

    // A transfer that cannot read the file is a 404 (the file is absent).
    {
      const { res, state } = fakeRes()
      await findRoute(ROUTES.transfer).handler(fakeReq({
        method: 'POST',
        headers: { host: 'localhost:4074', 'content-type': 'application/json' },
        body: { alias: 'alpha', direction: 'download', localPath: '/tmp/x', remotePath: '/srv/x' },
      }), res)
      check('a missing remote file in a transfer answers 404, not 200',
        state.status === 404, `${state.status} ${state.body}`)
    }

    // A success keeps its shape: 200 plus ok:true, so a caller that checks
    // either half agrees with a caller that checks the status.
    {
      const { res, state } = fakeRes()
      await findRoute(ROUTES.hostDisconnect).handler(fakeReq({
        method: 'POST',
        headers: { host: 'localhost:4074', 'content-type': 'application/json' },
        body: { alias: 'alpha' },
      }), res)
      check('a successful disconnect is 200 + ok:true',
        state.status === 200 && JSON.parse(state.body).ok === true, `${state.status} ${state.body}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}


// --- the directory listing route -------------------------------------------
// This route had no coverage at all until the cap was added, which is exactly
// how it came to return every entry a directory held: nothing was asserting
// anything about its response shape. These cases pin the cap, the accounting
// that makes truncation visible, and the refusal of a nonsense `limit`.
{
  const makeListingEngine = (entries) => {
    const calls = { limits: [] }
    return {
      calls,
      async withSftp (_alias, work) {
        return await work({
          readdir (target, callback) {
            calls.limits.push(target)
            callback(null, entries.map(entry => ({
              filename: entry.name,
              attrs: {
                size: entry.size ?? 0,
                mtime: 1,
                isDirectory: () => entry.type === 'directory',
                isSymbolicLink: () => entry.type === 'symlink',
              },
            })))
          },
          realpath (_target, callback) { callback(null, '/home/dev') },
        })
      },
      async exec () { return { exitCode: 0, stdout: '', stderr: '' } },
    }
  }
  const big = []
  for (let i = 0; i < 700; i += 1) big.push({ name: `file-${String(i).padStart(4, '0')}.txt`, type: 'file' })
  big.push({ name: 'zdir', type: 'directory' })
  const listingEngine = makeListingEngine(big)
  const listingRoutes = makeRoutes({
    engine: listingEngine,
    router: {},
    forwards: { list: () => [], open: async () => ({}), close: () => false },
    shells,
    ctx: { get: () => undefined },
  })
  const ls = listingRoutes.find(route => route.path === ROUTES.ls)
  check('the ls route is registered', ls !== undefined)

  const lsRequest = async (query) => {
    const { res, state } = fakeRes()
    await ls.handler(fakeReq({ url: `${ROUTES.ls}?alias=a${query}`, headers: { host: 'localhost:4074' } }), res)
    return { state, body: JSON.parse(state.body) }
  }

  {
    const { state, body } = await lsRequest('&path=%2Fhome%2Fdev%2Fbig')
    check('a large directory is capped at the default limit', body.entries.length === 500, String(body.entries.length))
    check('the cap is announced, not silent', body.truncated === true, String(body.truncated))
    check('the response carries the true total', body.total === 701, String(body.total))
    check('the response echoes the limit it applied', body.limit === 500, String(body.limit))
    check('a capped listing still answers 200', state.status === 200, String(state.status))
  }

  {
    const { body } = await lsRequest('&path=%2Fhome%2Fdev%2Fbig&limit=3')
    check('an explicit limit is honoured', body.entries.length === 3, String(body.entries.length))
    // Directories must survive the cut: they are what a picker can navigate
    // into, and the whole reason this route exists.
    check('directories are kept ahead of files when truncating',
      body.entries.some(entry => entry.name === 'zdir'), JSON.stringify(body.entries.map(e => e.name)))
  }

  {
    const { state } = await lsRequest('&path=%2Fhome%2Fdev%2Fbig&limit=abc')
    check('a non-numeric limit is refused rather than coerced', state.status === 400, String(state.status))
  }

  {
    const { state } = await lsRequest('&path=%2Fhome%2Fdev%2Fbig&limit=0')
    check('a zero limit is refused', state.status === 400, String(state.status))
  }

  {
    const { body } = await lsRequest('&path=%2Fhome%2Fdev%2Fbig&limit=99999')
    check('a limit above the ceiling is clamped, not accepted', body.limit === 2000, String(body.limit))
  }

  {
    // A small directory must NOT be reported as truncated: a panel that warned
    // on every listing would train the user to ignore the warning.
    const small = makeListingEngine([{ name: 'a.txt', type: 'file' }, { name: 'd', type: 'directory' }])
    const smallRoutes = makeRoutes({
      engine: small,
      router: {},
      forwards: { list: () => [], open: async () => ({}), close: () => false },
      shells,
      ctx: { get: () => undefined },
    })
    const { res, state } = fakeRes()
    await smallRoutes.find(route => route.path === ROUTES.ls).handler(
      fakeReq({ url: `${ROUTES.ls}?alias=a&path=%2Fhome%2Fdev%2Fsmall`, headers: { host: 'localhost:4074' } }), res)
    const body = JSON.parse(state.body)
    check('a directory under the cap is not reported as truncated', body.truncated === false, String(body.truncated))
    check('an untruncated listing still reports its total', body.total === 2, String(body.total))
    check('an untruncated listing is returned whole', body.entries.length === 2, String(body.entries.length))
  }
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
process.exit(failures === 0 ? 0 : 1)