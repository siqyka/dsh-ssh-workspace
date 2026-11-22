/**
 * The text-editing routes: read, write, and the two-token conflict check.
 *
 * The properties worth proving here are the ones a user would only discover by
 * losing work, so every one of them is asserted against real bytes rather than
 * against a call log:
 *
 *  - a save whose `version` still matches but whose content does not is REFUSED
 *    (the same-second, same-size rewrite an `ino:size:mtime` token cannot see);
 *  - a refused save leaves the file exactly as it was, re-read afterwards;
 *  - CRLF stays CRLF and LF stays LF, and a BOM survives;
 *  - a truncated read cannot be saved at all (its revision is null);
 *  - the fence refuses an escape on both halves, and the read-only mode refuses
 *    a save while still allowing a read.
 *
 * The remote half runs on the in-memory SFTP double, so the real
 * `RemoteFileSystem`, the real publish sequence and the real fences are what
 * execute. The local half runs on real files in a temp directory.
 *
 * Run: node tests/text-routes-smoke.mjs
 */

import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createFakeSftp, fakeSftpEngine } from './support/fake-sftp.mjs'
import { createHost } from './support/plugin-host.mjs'
import { routeModuleSource, routeSource } from './support/route-source.mjs'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0
const failures = []
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== text routes smoke ===\n')

// ---------------------------------------------------------------------------
// Source wiring (always runs, even without a Host tree)
// ---------------------------------------------------------------------------
{
  const routes = routeSource(pluginRoot)
  const text = routeModuleSource(pluginRoot, 'text')
  check('the route table declares all three text endpoints',
    routes.includes("readText: '/api/dsh-ssh-workspace/read-text'") &&
      routes.includes("writeText: '/api/dsh-ssh-workspace/write-text'") &&
      routes.includes("editText: '/api/dsh-ssh-workspace/edit-text'"))
  check('a stale save maps to 409, not to the fallback',
    /case 'FS_STALE_VERSION': return 409/u.test(routes))
  // Scoped to the text module on purpose: `force` is a legitimate option of
  // `node:fs`'s `rm` in entries.js, so a family-wide regex would either miss a
  // real bypass or fire on an unrelated one.
  check('the text module offers no force / skipExpected escape hatch',
    !/\bforce\b\s*:/u.test(text) && !/skipExpected/u.test(text) && !/skipVersion/iu.test(text) &&
      !/body\?\.force/u.test(text))
  check('expected is required rather than defaulted',
    /function requireExpected \(body\)/u.test(text) &&
      /expected is required: send the version and revision the editor opened/u.test(text))
  // `indexOf` alone is not enough here: a deleted check returns -1, and -1 is
  // less than any real offset, so "the cheap check runs first" would keep
  // passing on a file that no longer has a cheap check at all. Both markers
  // have to be present before their order means anything.
  const fastAt = text.indexOf('if (current.version !== expected.version)')
  const slowAt = text.indexOf('if (currentRevision !== expected.revision)')
  check('both the cheap and the expensive check still exist',
    fastAt >= 0 && slowAt >= 0, `fast ${fastAt}, slow ${slowAt}`)
  check('the cheap version check runs before the content hash', fastAt < slowAt)
  // The size of the request is knowable before the file is read, so an
  // oversized body must be refused without pulling the current file over SFTP.
  // Asserted by position because the cost is the point: a check that runs
  // after the read is correct but pays for a transfer it did not need.
  const sentSizeAt = text.indexOf("Buffer.byteLength(body.text, 'utf8') > EDIT_MAX_BYTES")
  const firstReadAt = text.indexOf('const current = context.remote')
  check('the sent body is measured before the file is read',
    sentSizeAt >= 0 && firstReadAt >= 0 && sentSizeAt < firstReadAt,
    `size ${sentSizeAt}, read ${firstReadAt}`)
}

// ---------------------------------------------------------------------------
// Behaviour (needs the assembled tree for @deepseek-ai/dsh-fs)
// ---------------------------------------------------------------------------
const coreRoot = process.env.DSH_CORE_ROOT
if (!coreRoot) {
  console.log('  SKIP  DSH_CORE_ROOT is not set (route behaviour needs @deepseek-ai/dsh-fs)')
} else {
  process.env.DSH_PEER_ROOT = [coreRoot, process.env.DSH_PEER_ROOT].filter(Boolean).join(path.delimiter)
  const { makeRoutes, ROUTES } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'routes', 'routes.js')).href)
  const { RemoteFileSystem } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'fs', 'remote-fs.js')).href)
  const { EDIT_MAX_BYTES } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'routes', 'text.js')).href)

  function fakeRes () {
    const state = { status: undefined, body: '', headers: {} }
    const res = {
      get headersSent () { return state.status !== undefined },
      writeHead (status, headers) { state.status = status; state.headers = headers ?? {}; return res },
      write (chunk) { state.body += String(chunk); return true },
      end (chunk) { if (chunk !== undefined) state.body += String(chunk); return res },
      on () {},
    }
    return { res, state }
  }
  function fakeReq (routePath, body) {
    const handlers = new Map()
    return {
      method: 'POST',
      url: routePath,
      headers: { host: 'localhost:13333', 'content-type': 'application/json' },
      socket: { remoteAddress: '127.0.0.1', localPort: 13333 },
      on (event, handler) {
        handlers.set(event, handler)
        if (event === 'end') setImmediate(() => {
          handlers.get('data')?.(Buffer.from(JSON.stringify(body)))
          handler()
        })
      },
    }
  }
  async function post (routes, routePath, body) {
    const route = routes.find(entry => entry.path === routePath)
    if (route === undefined) throw new Error(`no route ${routePath}`)
    const { res, state } = fakeRes()
    await route.handler(fakeReq(routePath, body), res)
    return { ...state, json: parseJson(state.body) }
  }
  async function get (routes, url) {
    const routePath = url.split('?')[0]
    const route = routes.find(entry => entry.path === routePath)
    if (route === undefined) throw new Error(`no route ${routePath}`)
    const { res, state } = fakeRes()
    await route.handler({
      method: 'GET',
      url,
      headers: { host: 'localhost:13333' },
      socket: { remoteAddress: '127.0.0.1', localPort: 13333 },
      on () {},
    }, res)
    return { ...state, json: parseJson(state.body) }
  }
  function parseJson (body) {
    try { return JSON.parse(body) } catch { return undefined }
  }
  const q = (params) => Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&')

  // ---- remote -----------------------------------------------------------------
  async function remoteCases () {
    const seeded = createFakeSftp({
      files: {
        '/srv/app/notes.md': 'alpha\nbeta\n',
        '/srv/app/crlf.txt': 'one\r\ntwo\r\n',
        '/srv/app/bom.txt': '\uFEFFwith a bom\n',
        '/srv/app/binary.bin': Buffer.from([0x41, 0x00, 0x42]),
        // Undecodable as UTF-8 AND as GB18030, which is what "not text" now
        // means: `E4 E8 2E` used to be the fixture and is a perfectly valid
        // GB18030 sequence for 滂, so it is readable text today.
        '/srv/app/latin.txt': Buffer.from([0xFF, 0xFF, 0x2E]),
        // Readable, but not writable: Node has no GB18030 encoder here.
        '/srv/app/gbk.txt': Buffer.from([0xC4, 0xE3, 0xBA, 0xC3]),
        // A genuine UTF-16LE body with a BOM. Opening it as text is only half
        // the point — a save has to put the bytes back the same way.
        '/srv/app/utf16.txt': Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('alpha\nbeta\n', 'utf16le')]),
      },
      dirs: ['/srv', '/srv/app'],
    })
    const engine = fakeSftpEngine(seeded.sftp)
    const router = new RemoteFileSystem({ engine })
    router.addRoot('box', '/srv/app')
    // A SECOND mount, holding the same POSIX root. The Files tab browses every
    // mount, so a preview opened from `other` is named by `/srv/app/...` too —
    // and a resolver that only consults the SESSION's root would refuse it.
    router.addRoot('other', '/srv/other')
    seeded.tree.write('/srv/other/twin.md', 'twin\n')
    // A mount the CLIENTS' sessions do not own. Reading a bare path here can
    // only be resolved from the mount table, never from a session root.
    router.addRoot('third', '/srv/third')
    seeded.tree.write('/srv/third/only.md', 'only\n')
    const sessions = [
      { id: 's-rw', header: { cwd: 'ssh://box/srv/app' }, mode: 'workspace-write' },
      { id: 's-ro', header: { cwd: 'ssh://box/srv/app' }, mode: 'read-only' },
      // A session whose own workspace is the SECOND mount.
      { id: 's-other', header: { cwd: 'ssh://other/srv/other' }, mode: 'workspace-write' },
    ]
    const ctx = createHost({
      services: {
        sessions: { get: id => sessions.find(entry => entry.id === id), list: () => sessions },
        sandboxPolicy: { resolve: ({ session }) => ({ mode: session?.mode ?? 'workspace-write', workspaceRoot: session?.header?.cwd ?? '/fallback' }) },
      },
    }).ctx
    const routes = makeRoutes({ engine, router, ctx, allowLan: false, allowedHosts: [] })
    const notes = 'ssh://box/srv/app/notes.md'

    // ---- read
    const read = await get(routes, `${ROUTES.readText}?${q({ sessionId: 's-rw', path: notes })}`)
    check('a read answers the text, LF-normalised',
      read.status === 200 && read.json?.text === 'alpha\nbeta\n', read.body)
    check('a read carries the tokens a save will need',
      typeof read.json?.version === 'string' && /^[0-9a-f]{64}$/u.test(read.json?.revision ?? ''), read.body)
    check('a read reports the line ending it found', read.json?.eol === 'LF', read.body)
    check('a read reports size and bom', read.json?.size === 11 && read.json?.bom === false, read.body)
    check('a read is not truncated when it fits', read.json?.truncated === false, read.body)

    const crlf = await get(routes, `${ROUTES.readText}?${q({ sessionId: 's-rw', path: 'ssh://box/srv/app/crlf.txt' })}`)
    check('a CRLF file reads back as LF', crlf.json?.text === 'one\ntwo\n', crlf.body)
    check('...and reports eol CRLF so a save can put it back', crlf.json?.eol === 'CRLF', crlf.body)

    const bom = await get(routes, `${ROUTES.readText}?${q({ sessionId: 's-rw', path: 'ssh://box/srv/app/bom.txt' })}`)
    check('a BOM is reported rather than silently stripped', bom.json?.bom === true, bom.body)
    check('...and the text handed to the editor has no BOM in it', bom.json?.text === 'with a bom\n', JSON.stringify(bom.json?.text))

    const binary = await get(routes, `${ROUTES.readText}?${q({ sessionId: 's-rw', path: 'ssh://box/srv/app/binary.bin' })}`)
    check('a binary file is a 400 FS_NOT_TEXT', binary.status === 400 && binary.json?.code === 'FS_NOT_TEXT', binary.body)

    // A file that is neither UTF-8 nor GB18030. The refusal now names both
    // attempts, because "not UTF-8" alone is no longer the whole rule.
    const latin = await get(routes, `${ROUTES.readText}?${q({ sessionId: 's-rw', path: 'ssh://box/srv/app/latin.txt' })}`)
    check('a file that is neither UTF-8 nor GB18030 is refused',
      latin.status === 400 && latin.json?.code === 'FS_NOT_TEXT', latin.body)

    // The other direction: a GB18030 file must OPEN, which is the whole point of
    // the encoding work. Reading it and refusing to write it are separate
    // answers, and both have to be right.
    const gbk = await get(routes, `${ROUTES.readText}?${q({ sessionId: 's-rw', path: 'ssh://box/srv/app/gbk.txt' })}`)
    check('a GB18030 file is readable rather than "binary"',
      gbk.status === 200 && gbk.json?.text === '你好', gbk.body)
    check('...and reports the encoding it was decoded with',
      gbk.json?.encoding === 'gb18030' && gbk.json?.bom === false, gbk.body)

    const missing = await get(routes, `${ROUTES.readText}?${q({ sessionId: 's-rw', path: 'ssh://box/srv/app/ghost.txt' })}`)
    check('a missing file is a 404', missing.status === 404, missing.body)

    const unknownSession = await get(routes, `${ROUTES.readText}?${q({ root: 'ssh://box/not-a-session', path: notes })}`)
    check('a read with no identifiable session is a 403',
      unknownSession.status === 403 && /could not identify the session/u.test(unknownSession.body), unknownSession.body)

    const readOnlyRead = await get(routes, `${ROUTES.readText}?${q({ sessionId: 's-ro', path: notes })}`)
    check('a read-only session can still READ', readOnlyRead.status === 200, readOnlyRead.body)

    // ---- the bare remote spelling -------------------------------------------
    //
    // The document preview hands the button `ctx.fs.processPath(target)`, and
    // for a remote target that is the REMOTE POSIX path — deliberately, because
    // every other consumer of that value runs on the far side. The route needs
    // the `ssh://` form (the alias is the only way to name the host), so it
    // recovers it from the session's own workspace root.
    //
    // This is the bug the user hit: the button rendered, the click worked, and
    // nothing happened, because `/srv/app/notes.md` was read as a LOCAL path and
    // refused with "the session workspace is remote".
    const bare = '/srv/app/notes.md'
    const bareRead = await get(routes, `${ROUTES.readText}?${q({ sessionId: 's-rw', path: bare })}`)
    check('a bare remote path is resolved through the session root',
      bareRead.status === 200 && bareRead.json?.text !== undefined, bareRead.body)
    check('...and the answer names the ssh:// spelling, so the client has one name per file',
      bareRead.json?.path === notes, bareRead.body)
    check('...with the same tokens the ssh:// form answers',
      bareRead.json?.version === read.json.version && bareRead.json?.revision === read.json.revision, bareRead.body)

    const bareProbe = await get(routes, `${ROUTES.readText}?${q({ sessionId: 's-rw', path: bare, probe: '1' })}`)
    check('a probe on a bare remote path answers too', bareProbe.status === 200 && bareProbe.json?.editable === true,
      bareProbe.body)

    // A bare path outside every root is NOT guessed at: it is still refused, and
    // with the same 403 the local branch has always given.
    const bareOutside = await get(routes, `${ROUTES.readText}?${q({ sessionId: 's-rw', path: '/etc/passwd' })}`)
    check('a bare path outside every root is still refused',
      bareOutside.status === 403 && bareOutside.json?.code === 'FS_PERMISSION_DENIED', bareOutside.body)

    // The escape matters: `..` must be resolved BEFORE the containment test, or
    // a path like `/srv/app/../../etc/passwd` would pass startsWith and only the
    // remote fence would catch it.
    const escaped = await get(routes, `${ROUTES.readText}?${q({ sessionId: 's-rw', path: '/srv/app/../../etc/passwd' })}`)
    check('a bare path that climbs out with .. is not smuggled in',
      escaped.status === 403, escaped.body)

    // A preview opened from a DIFFERENT mount than the session's own workspace:
    // the Files tab browses every mount, so the button must work there too. The
    // session's own root cannot vouch for this path — it is not under it at all
    // — so only the mount table can answer.
    const otherRead = await get(routes, `${ROUTES.readText}?${q({ sessionId: 's-other', path: '/srv/other/twin.md' })}`)
    check('a bare path under a different mount resolves through the mounts',
      otherRead.status === 200 && otherRead.json?.path === 'ssh://other/srv/other/twin.md', otherRead.body)

    // The stronger case: a mount NO session owns. If the resolver only ever
    // consulted the session root this is a 403; the preview, however, can show
    // it and the user can press the same button on it.
    const thirdRead = await get(routes, `${ROUTES.readText}?${q({ sessionId: 's-rw', path: '/srv/third/only.md' })}`)
    check('...including a mount no session owns',
      thirdRead.status === 200 && thirdRead.json?.path === 'ssh://third/srv/third/only.md', thirdRead.body)

    // ...but ONLY when the answer is unambiguous. Two aliases holding the same
    // POSIX root is exactly the case where guessing edits the wrong machine.
    router.addRoot('clone', '/srv/third')
    const ambiguous = await get(routes, `${ROUTES.readText}?${q({ sessionId: 's-rw', path: '/srv/third/only.md' })}`)
    check('an ambiguous bare path is refused rather than guessed at',
      ambiguous.status === 403, ambiguous.body)
    router.removeRoot('ssh://clone/srv/third')

    // A probe answers "could this be edited, and if not why" without shipping
    // the file — the button is rendered for every previewed file.
    const probeOk = await get(routes, `${ROUTES.readText}?${q({ sessionId: 's-rw', path: notes, probe: '1' })}`)
    check('a probe says an ordinary text file is editable',
      probeOk.status === 200 && probeOk.json?.probe === true && probeOk.json?.editable === true, probeOk.body)
    check('...and ships no content with that answer', probeOk.json?.text === undefined, probeOk.body)
    const probeBin = await get(routes, `${ROUTES.readText}?${q({ sessionId: 's-rw', path: 'ssh://box/srv/app/binary.bin', probe: '1' })}`)
    check('a probe names the reason a binary file is not editable',
      probeBin.status === 200 && probeBin.json?.editable === false && probeBin.json?.reason === 'binary', probeBin.body)
    const probeUtf = await get(routes, `${ROUTES.readText}?${q({ sessionId: 's-rw', path: 'ssh://box/srv/app/latin.txt', probe: '1' })}`)
    check('a probe names the reason a non-text file is not editable',
      probeUtf.status === 200 && probeUtf.json?.reason === 'not-utf8', probeUtf.body)
    // GB18030 reads but does not write, and the probe is where that has to show
    // up. Discovering it at save time would mean the first save silently
    // converts the file.
    const probeGbk = await get(routes, `${ROUTES.readText}?${q({ sessionId: 's-rw', path: 'ssh://box/srv/app/gbk.txt', probe: '1' })}`)
    check('a probe refuses to offer an edit it could not save',
      probeGbk.status === 200 && probeGbk.json?.reason === 'not-encodable', probeGbk.body)
    check('...and says which encoding it means',
      probeGbk.json?.encoding === 'gb18030', probeGbk.body)
    // The button has to disappear in a read-only session, and it has to
    // disappear for THAT reason: telling someone their file is binary when the
    // real answer is "this session cannot write" sends them looking for a
    // different file, and no file will help.
    const probeRo = await get(routes, `${ROUTES.readText}?${q({ sessionId: 's-ro', path: notes, probe: '1' })}`)
    check('a probe refuses in a read-only session, and says so',
      probeRo.status === 200 && probeRo.json?.editable === false && probeRo.json?.reason === 'read-only', probeRo.body)

    // ---- truncated read
    const big = 'x'.repeat(64)
    seeded.tree.write('/srv/app/big.txt', big)
    router.invalidateRemote('box', '/srv/app/big.txt')
    const truncated = await get(routes, `${ROUTES.readText}?${q({ sessionId: 's-rw', path: 'ssh://box/srv/app/big.txt', maxBytes: 16 })}`)
    check('a read over the limit answers the head and says so',
      truncated.status === 200 && truncated.json?.truncated === true && truncated.json?.text?.length === 16, truncated.body)
    check('...and reports the real size, not the cut length', truncated.json?.size === 64, truncated.body)
    check('...and offers NO revision, because it never saw the whole file',
      truncated.json?.revision === null, truncated.body)

    // ---- write
    const save = await post(routes, ROUTES.writeText, {
      sessionId: 's-rw',
      path: notes,
      text: 'alpha\nBETA\n',
      expected: { version: read.json.version, revision: read.json.revision },
    })
    check('a save with the right tokens lands', save.status === 200 && save.json?.ok === true, save.body)
    check('...and the bytes on the host are the new ones',
      seeded.tree.read('/srv/app/notes.md') === 'alpha\nBETA\n', JSON.stringify(seeded.tree.read('/srv/app/notes.md')))
    check('a save answers a new version and a new revision',
      typeof save.json?.version === 'string' && save.json.version !== read.json.version &&
        /^[0-9a-f]{64}$/u.test(save.json?.revision ?? ''), save.body)
    check('a save never echoes the file back', save.json?.text === undefined, save.body)
    check('a save reports the byte count it wrote', save.json?.bytes === 11, save.body)

    const noExpected = await post(routes, ROUTES.writeText, { sessionId: 's-rw', path: notes, text: 'x' })
    check('a save without expected is a 400', noExpected.status === 400, noExpected.body)
    const halfExpected = await post(routes, ROUTES.writeText, {
      sessionId: 's-rw', path: notes, text: 'x', expected: { version: save.json.version },
    })
    check('a save with only half the tokens is a 400', halfExpected.status === 400, halfExpected.body)

    // The load-bearing one: the version still matches, the content does not.
    // This is the same-second, same-size rewrite that `ino:size:mtime` cannot
    // see, and the whole reason `revision` exists.
    const before = seeded.tree.read('/srv/app/notes.md')
    seeded.tree.freezeMtime(true)
    seeded.tree.write('/srv/app/notes.md', 'alpha\nGAMMA\n')
    seeded.tree.freezeMtime(false)
    router.invalidateRemote('box', '/srv/app/notes.md')
    const stale = await post(routes, ROUTES.writeText, {
      sessionId: 's-rw',
      path: notes,
      text: 'clobbered\n',
      expected: { version: save.json.version, revision: save.json.revision },
    })
    check('a same-size, same-second external change is refused with 409',
      stale.status === 409 && stale.json?.error === 'stale', stale.body)
    check('...and the refusal names the state that won, so the client can reload',
      typeof stale.json?.current?.version === 'string' && typeof stale.json?.current?.revision === 'string', stale.body)
    check('...and the file on disk was NOT overwritten',
      seeded.tree.read('/srv/app/notes.md') === 'alpha\nGAMMA\n', JSON.stringify(seeded.tree.read('/srv/app/notes.md')))
    check('...which is different from what it held before the external change', before !== seeded.tree.read('/srv/app/notes.md'))

    // ---- line endings and BOM survive a save
    const crlfRead = await get(routes, `${ROUTES.readText}?${q({ sessionId: 's-rw', path: 'ssh://box/srv/app/crlf.txt' })}`)
    await post(routes, ROUTES.writeText, {
      sessionId: 's-rw',
      path: 'ssh://box/srv/app/crlf.txt',
      text: 'one\ntwo\nthree\n',
      expected: { version: crlfRead.json.version, revision: crlfRead.json.revision },
    })
    check('a CRLF file saved with eol auto stays CRLF',
      seeded.tree.read('/srv/app/crlf.txt') === 'one\r\ntwo\r\nthree\r\n', JSON.stringify(seeded.tree.read('/srv/app/crlf.txt')))

    const bomRead = await get(routes, `${ROUTES.readText}?${q({ sessionId: 's-rw', path: 'ssh://box/srv/app/bom.txt' })}`)
    await post(routes, ROUTES.writeText, {
      sessionId: 's-rw',
      path: 'ssh://box/srv/app/bom.txt',
      text: 'still a bom\n',
      expected: { version: bomRead.json.version, revision: bomRead.json.revision },
    })
    const bomAfter = seeded.tree.bytes('/srv/app/bom.txt')
    check('a file that had a BOM still has one after a save',
      bomAfter[0] === 0xEF && bomAfter[1] === 0xBB && bomAfter[2] === 0xBF, bomAfter.subarray(0, 3).toString('hex'))
    check('...and the BOM was not doubled', seeded.tree.read('/srv/app/bom.txt') === '\uFEFFstill a bom\n',
      JSON.stringify(seeded.tree.read('/srv/app/bom.txt')))

    // ---- the encoding survives a save
    //
    // This is the case the encoding work exists for. A UTF-16 file that opens
    // correctly and then saves as UTF-8 is DAMAGED by a one-character edit:
    // every byte in the file changes, so the whole thing shows up as rewritten
    // in a diff. The save has to write the bytes back in the encoding it read.
    const utf16Read = await get(routes, `${ROUTES.readText}?${q({ sessionId: 's-rw', path: 'ssh://box/srv/app/utf16.txt' })}`)
    check('a UTF-16LE file opens as text rather than "binary"',
      utf16Read.status === 200 && utf16Read.json?.text === 'alpha\nbeta\n', utf16Read.body)
    check('...and reports its encoding and BOM', utf16Read.json?.encoding === 'utf16le' && utf16Read.json?.bom === true,
      utf16Read.body)

    const utf16Save = await post(routes, ROUTES.writeText, {
      sessionId: 's-rw',
      path: 'ssh://box/srv/app/utf16.txt',
      text: 'alpha\nbeta\ngamma\n',
      expected: { version: utf16Read.json.version, revision: utf16Read.json.revision },
    })
    check('...and it saves', utf16Save.status === 200, utf16Save.body)
    const utf16After = seeded.tree.bytes('/srv/app/utf16.txt')
    check('the saved file is still UTF-16LE, not silently converted to UTF-8',
      utf16After[0] === 0xFF && utf16After[1] === 0xFE && utf16After.includes(0), utf16After.toString('hex'))
    check('...and the text round-trips through it',
      utf16After.subarray(2).toString('utf16le') === 'alpha\nbeta\ngamma\n',
      JSON.stringify(utf16After.subarray(2).toString('utf16le')))
    check('...and no UTF-8 BOM crept in at the front', utf16After[0] !== 0xEF, utf16After.subarray(0, 3).toString('hex'))

    // ---- the fences
    const roSave = await post(routes, ROUTES.writeText, {
      sessionId: 's-ro',
      path: notes,
      text: 'nope\n',
      expected: { version: save.json.version, revision: save.json.revision },
    })
    check('a read-only session cannot save',
      roSave.status === 403 && /read-only/u.test(roSave.body), roSave.body)

    const outside = await post(routes, ROUTES.writeText, {
      sessionId: 's-rw',
      path: 'ssh://box/etc/passwd',
      text: 'nope\n',
      expected: { version: '1:2:3', revision: 'a'.repeat(64) },
    })
    check('a path outside every mounted root is a 403',
      outside.status === 403 && /outside every mounted/u.test(outside.body), outside.body)

    const escape = await post(routes, ROUTES.writeText, {
      sessionId: 's-rw',
      path: 'ssh://box/srv/app/../../../etc/passwd',
      text: 'nope\n',
      expected: { version: '1:2:3', revision: 'a'.repeat(64) },
    })
    check('a lexically escaping path is refused before any SFTP call',
      escape.status === 403, escape.body)

    // A body that is already over the limit is refused before the current file
    // is read, so the tokens here are deliberately the LIVE ones — the refusal
    // must come from the size, not from a stale token.
    const liveRead = await get(routes, `${ROUTES.readText}?${q({ sessionId: 's-rw', path: notes })}`)
    const tooBig = await post(routes, ROUTES.writeText, {
      sessionId: 's-rw',
      path: notes,
      text: 'y'.repeat(EDIT_MAX_BYTES + 1),
      expected: { version: liveRead.json.version, revision: liveRead.json.revision },
    })
    check('a save over the editing limit is a 413',
      tooBig.status === 413 && tooBig.json?.code === 'FS_TOO_LARGE', tooBig.body)
    check('...and the oversized body was never written',
      seeded.tree.read('/srv/app/notes.md') === 'alpha\nGAMMA\n', JSON.stringify(seeded.tree.read('/srv/app/notes.md')))

    // ---- edit-text
    const editRead = await get(routes, `${ROUTES.readText}?${q({ sessionId: 's-rw', path: 'ssh://box/srv/app/notes.md' })}`)
    const edited = await post(routes, ROUTES.editText, {
      sessionId: 's-rw',
      path: notes,
      edit: { oldText: 'GAMMA', newText: 'DELTA' },
      expected: { version: editRead.json.version, revision: editRead.json.revision },
    })
    check('a literal edit lands', edited.status === 200 && seeded.tree.read('/srv/app/notes.md') === 'alpha\nDELTA\n', edited.body)
    const editMissing = await post(routes, ROUTES.editText, {
      sessionId: 's-rw',
      path: notes,
      edit: { oldText: 'NOT-THERE', newText: 'x' },
      expected: { version: edited.json.version, revision: edited.json.revision },
    })
    check('an edit whose oldText is absent is a 400',
      editMissing.status === 400 && /not found/u.test(editMissing.body), editMissing.body)
    const editAmbiguous = await post(routes, ROUTES.editText, {
      sessionId: 's-rw',
      path: notes,
      edit: { oldText: 'a', newText: 'A' },
      expected: { version: edited.json.version, revision: edited.json.revision },
    })
    check('an ambiguous edit is a 400 rather than a guess',
      editAmbiguous.status === 400 && /matched/u.test(editAmbiguous.body), editAmbiguous.body)

    // ---- audit
    const written = engine.notes.filter(note => note.kind === 'write')
    check('every save leaves one audit line', written.length > 0, String(written.length))
    check('...and no audit line quotes the file content',
      !written.some(note => /alpha|BETA|DELTA|still a bom/u.test(String(note.detail))),
      JSON.stringify(written.map(note => note.detail)))
  }

  await remoteCases()

  // ---- local ------------------------------------------------------------------
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-ws-text-'))
  const outsideRoot = mkdtempSync(path.join(tmpdir(), 'dsh-ws-text-out-'))
  const sessions = [
    { id: 'l-rw', header: { cwd: root }, mode: 'workspace-write' },
    { id: 'l-ro', header: { cwd: root }, mode: 'read-only' },
  ]
  const ctx = createHost({
    services: {
      sessions: { get: id => sessions.find(entry => entry.id === id), list: () => sessions },
      sandboxPolicy: { resolve: ({ session }) => ({ mode: session?.mode ?? 'workspace-write', workspaceRoot: session?.header?.cwd ?? root }) },
    },
  }).ctx
  const routes = makeRoutes({
    engine: { async withSftp () { throw new Error('a local path went to SFTP') }, notes: [], diagnostics: { record () {} } },
    router: { roots: new Set() },
    ctx,
    allowLan: false,
    allowedHosts: [],
  })

  const file = path.join(root, 'note.md')
  writeFileSync(file, 'local alpha\nlocal beta\n')
  const localRead = await get(routes, `${ROUTES.readText}?${q({ sessionId: 'l-rw', path: file })}`)
  check('a local file reads through the same route',
    localRead.status === 200 && localRead.json?.text === 'local alpha\nlocal beta\n', localRead.body)
  check('...with the same token shape as the remote half',
    typeof localRead.json?.version === 'string' && /^[0-9a-f]{64}$/u.test(localRead.json?.revision ?? ''), localRead.body)

  const localSave = await post(routes, ROUTES.writeText, {
    sessionId: 'l-rw',
    path: file,
    text: 'local alpha\nLOCAL BETA\n',
    expected: { version: localRead.json.version, revision: localRead.json.revision },
  })
  check('a local save lands', localSave.status === 200 && readFileSync(file, 'utf8') === 'local alpha\nLOCAL BETA\n', localSave.body)

  const localStale = await post(routes, ROUTES.writeText, {
    sessionId: 'l-rw',
    path: file,
    text: 'clobbered\n',
    expected: { version: localRead.json.version, revision: localRead.json.revision },
  })
  check('a local save with stale tokens is a 409', localStale.status === 409, localStale.body)
  check('...and the local file was not overwritten',
    readFileSync(file, 'utf8') === 'local alpha\nLOCAL BETA\n', JSON.stringify(readFileSync(file, 'utf8')))

  writeFileSync(path.join(root, 'crlf.txt'), 'a\r\nb\r\n')
  const localCrlf = await get(routes, `${ROUTES.readText}?${q({ sessionId: 'l-rw', path: path.join(root, 'crlf.txt') })}`)
  await post(routes, ROUTES.writeText, {
    sessionId: 'l-rw',
    path: path.join(root, 'crlf.txt'),
    text: 'a\nb\nc\n',
    expected: { version: localCrlf.json.version, revision: localCrlf.json.revision },
  })
  check('a local CRLF file stays CRLF',
    readFileSync(path.join(root, 'crlf.txt'), 'utf8') === 'a\r\nb\r\nc\r\n', JSON.stringify(readFileSync(path.join(root, 'crlf.txt'), 'utf8')))

  const outsideFile = path.join(outsideRoot, 'elsewhere.md')
  writeFileSync(outsideFile, 'outside\n')
  const localOutside = await post(routes, ROUTES.writeText, {
    sessionId: 'l-rw',
    path: outsideFile,
    text: 'nope\n',
    expected: { version: '1:2:3', revision: 'a'.repeat(64) },
  })
  check('a local path outside the session workspace is refused',
    localOutside.status === 403 && /outside the session workspace/u.test(localOutside.body), localOutside.body)
  check('...and the outside file is untouched', readFileSync(outsideFile, 'utf8') === 'outside\n')

  const localReadOnly = await post(routes, ROUTES.writeText, {
    sessionId: 'l-ro',
    path: file,
    text: 'nope\n',
    expected: { version: localSave.json.version, revision: localSave.json.revision },
  })
  check('a read-only local session cannot save',
    localReadOnly.status === 403 && /read-only/u.test(localReadOnly.body), localReadOnly.body)
  const localReadOnlyRead = await get(routes, `${ROUTES.readText}?${q({ sessionId: 'l-ro', path: file })}`)
  check('...but can still read', localReadOnlyRead.status === 200, localReadOnlyRead.body)

  // A directory that RESOLVES outside the root: the lexical check passes, so
  // only the realpath comparison can refuse it.
  let escapeReady = false
  try {
    symlinkSync(outsideRoot, path.join(root, 'escape-dir'), 'junction')
    escapeReady = true
  } catch {
    try { symlinkSync(outsideRoot, path.join(root, 'escape-dir')); escapeReady = true } catch { /* neither form available */ }
  }
  if (escapeReady) {
    const throughLink = path.join(root, 'escape-dir', 'planted.md')
    const escaped = await post(routes, ROUTES.writeText, {
      sessionId: 'l-rw',
      path: throughLink,
      text: 'planted\n',
      expected: { version: '1:2:3', revision: 'a'.repeat(64) },
    })
    check('a local directory that resolves outside the root is refused',
      escaped.status === 403 && /resolves outside/u.test(escaped.body), escaped.body)
    check('...and nothing was planted through the link',
      !(() => { try { lstatSync(path.join(outsideRoot, 'planted.md')); return true } catch { return false } })())
    rmSync(path.join(root, 'escape-dir'), { recursive: true, force: true })
  } else {
    console.log('  NOTE  no symlink/junction support (the local realpath fence is unproven on this machine)')
  }

  // A local file over the limit is refused for a save and truncated for a read.
  const bigPath = path.join(root, 'big.txt')
  writeFileSync(bigPath, 'z'.repeat(64))
  const bigRead = await get(routes, `${ROUTES.readText}?${q({ sessionId: 'l-rw', path: bigPath, maxBytes: 8 })}`)
  check('a local read over the limit answers the head and says so',
    bigRead.status === 200 && bigRead.json?.truncated === true && bigRead.json?.text?.length === 8, bigRead.body)
  check('...and offers no revision', bigRead.json?.revision === null, bigRead.body)

  const binaryPath = path.join(root, 'blob.bin')
  writeFileSync(binaryPath, Buffer.from([0x00, 0x01, 0x02]))
  const localBinary = await get(routes, `${ROUTES.readText}?${q({ sessionId: 'l-rw', path: binaryPath })}`)
  check('a local binary file is refused with FS_NOT_TEXT',
    localBinary.status === 400 && localBinary.json?.code === 'FS_NOT_TEXT', localBinary.body)

  mkdirSync(path.join(root, 'dir'), { recursive: true })
  const localDir = await get(routes, `${ROUTES.readText}?${q({ sessionId: 'l-rw', path: path.join(root, 'dir') })}`)
  check('a local directory is refused rather than read as a file',
    localDir.status === 400 && localDir.json?.code === 'FS_NOT_REGULAR_FILE', localDir.body)

  rmSync(root, { recursive: true, force: true })
  rmSync(outsideRoot, { recursive: true, force: true })
}

console.log(`\n=== ${passed} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('failures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
