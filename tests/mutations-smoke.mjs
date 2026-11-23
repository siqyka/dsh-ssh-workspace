/**
 * Rename / delete / mkdir / create-file: the pure rules, the route fences, and
 * the local authority.
 *
 * The pure half runs on a bare checkout. The route half needs the assembled DSH
 * tree (`DSH_CORE_ROOT`) because the route family imports the host's peer packages,
 * and it is skipped without one — the same rule as `routes-smoke`.
 *
 * The load-bearing assertion is the local one: a request may NAME a root, but it
 * may not DEFINE one. A request that names a root no session owns must be
 * refused even when it also carries a perfectly plausible absolute path.
 *
 * Run: node tests/mutations-smoke.mjs
 */

import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createHost } from './support/plugin-host.mjs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isWithinLocalRoot, mutationNameRefusal, renameTargetPath, rootMutationRefusal, deletionSummary } from '../lib/transfer/transfer-rules.js'
import { routeSource } from './support/route-source.mjs'
import { clientSource } from './support/client-source.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
function exists (target) { try { lstatSync(target); return true } catch { return false } }
const pluginRoot = path.resolve(here, '..')
let passed = 0
const failures = []
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== mutations smoke ===\n')

// ---------------------------------------------------------------------------
// Pure rules (always run)
// ---------------------------------------------------------------------------
{
  check('an empty name is refused', mutationNameRefusal('') !== undefined)
  check('a whitespace-only name is refused', mutationNameRefusal('   ') !== undefined)
  check('"." is refused', mutationNameRefusal('.') !== undefined)
  check('".." is refused', mutationNameRefusal('..') !== undefined)
  check('a forward slash is refused', mutationNameRefusal('a/b') !== undefined)
  check('a backslash is refused', mutationNameRefusal('a\\b') !== undefined)
  check('a NUL byte is refused', mutationNameRefusal('a\u0000b') !== undefined)
  check('a name longer than 255 characters is refused', mutationNameRefusal('x'.repeat(256)) !== undefined)
  check('an ordinary name is accepted', mutationNameRefusal('report.txt') === undefined)
  check('a dotfile is accepted', mutationNameRefusal('.gitignore') === undefined)
  check('a non-string is refused', mutationNameRefusal(undefined) !== undefined)

  const root = path.resolve(tmpdir())
  check('the root itself is inside the root', isWithinLocalRoot(root, root))
  check('a child is inside the root', isWithinLocalRoot(root, path.join(root, 'a', 'b.txt')))
  check('a parent is outside the root', !isWithinLocalRoot(root, path.join(root, '..')))
  check('a sibling with a shared prefix is outside', !isWithinLocalRoot(path.join(root, 'a'), path.join(root, 'ab')))

  check('the workspace root itself cannot be deleted', rootMutationRefusal(root, root) !== undefined)
  check('a child can be deleted', rootMutationRefusal(root, path.join(root, 'x')) === undefined)
  check('a directory deletion says so', /subdirectories/iu.test(deletionSummary(1, true)))
  check('a file deletion does not claim subdirectories', !/subdirectories/iu.test(deletionSummary(1, false)))
  check('the rename target is a sibling', renameTargetPath(path.join(root, 'a'), 'b.txt') === path.join(root, 'a', 'b.txt'))
  check('the rename target name cannot escape', () => {
    try { renameTargetPath(path.join(root, 'a'), '../evil') } catch { return false }
    return false
  })
}

// ---------------------------------------------------------------------------
// Source wiring (always run)
// ---------------------------------------------------------------------------
{
  const routes = routeSource(pluginRoot)
  const client = clientSource(pluginRoot)
  check('the route table has a rename and a delete endpoint',
    /rename: '\/api\/dsh-ssh-workspace\/rename'/u.test(routes) &&
      /deleteEntry: '\/api\/dsh-ssh-workspace\/delete'/u.test(routes))
  check('the route table has a remote-only mkdir endpoint',
    routes.includes("mkdir: '/api/dsh-ssh-workspace/mkdir'"))
  check('mkdir fences the CHILD it creates, not the parent it sits in',
    routes.includes('async function mkdirRemoteEntry (engine, router, ctx, body)') &&
      routes.includes("assertMutationAllowed(ctx, body, child.displayPath, 'create a folder')") &&
      routes.includes('assertRemoteFence(router, child)'))
  check('the row menu offers new folder only for a remote directory',
    client.includes('remote !== null && isDir') &&
      client.includes("translate('rowmenu.newFolder')"))
  check('...and the successful action re-lists and selects the new row',
    client.includes('fetchJson(API.mkdir') &&
      client.includes('selectCreatedRow(data?.path, request)'))
  check('the route table has a create-file endpoint',
    routes.includes("createFile: '/api/dsh-ssh-workspace/create-file'"))
  // Sliced to this ONE function: the mkdir twin contains the same two calls,
  // and a whole-file `includes` would let either fence be deleted here and
  // still find the other function's copy.
  const createFileRemoteFn = (() => {
    const start = routes.indexOf('async function createFileRemoteEntry')
    if (start < 0) return ''
    const end = routes.indexOf('async function createFileLocalEntry', start)
    return routes.slice(start, end < 0 ? undefined : end)
  })()
  check('create-file fences the CHILD it creates and creates exclusively',
    createFileRemoteFn.includes("assertMutationAllowed(ctx, body, child.displayPath, 'create a file')") &&
      createFileRemoteFn.includes('assertRemoteFence(router, child)') &&
      /openRemoteFile\(sftp, childPath, 'wx', child\.displayPath\)/u.test(createFileRemoteFn))
  // The new-file dialog is its own function; slice it so "the success path
  // re-lists and selects" cannot be satisfied by the new-folder twin.
  const newFilePrompt = (() => {
    const start = client.indexOf('function requestRowNewFile')
    if (start < 0) return ''
    const end = client.indexOf('function selectCreatedRow', start)
    return client.slice(start, end < 0 ? undefined : end)
  })()
  check('the row menu offers new file before new folder for a remote directory',
    client.indexOf("id: 'new-file'") >= 0 &&
      client.indexOf("id: 'new-file'") < client.indexOf("id: 'new-folder'") &&
      client.includes("translate('rowmenu.newFile')"))
  check('...and the new-file prompt posts create-file, re-lists and selects the row',
    newFilePrompt.includes('fetchJson(API.createFile') &&
      newFilePrompt.includes('refreshFilesPanel()') &&
      newFilePrompt.includes('selectCreatedRow(data?.path, request)'))
  check('the local branch re-reads the root from the session/policy, not the body',
    /function localRootOf \(owner\)/u.test(routes) &&
      /owner\?\.policy\?\.workspaceRoot/u.test(routes) &&
      /owner\?\.session\?\.header\?\.cwd/u.test(routes))
  check('the request root is only a SELECTOR for a session',
    /sessions\.list\(\)\.find\(candidate => sameWorkspaceRoot\(candidate\?\.header\?\.cwd, body\.root\)\)/u.test(routes) &&
      /function sameWorkspaceRoot \(left, right\)/u.test(routes))
  check('both halves apply the mode gate before touching a target',
    /assertMutationAllowed\(ctx, body, parts\.displayPath, 'rename'\)/u.test(routes) &&
      /assertMutationAllowed\(ctx, body, parts\.displayPath, 'delete'\)/u.test(routes))
  check('a remote delete never follows a symlink',
    /typeof info\.isSymbolicLink === 'function' && info\.isSymbolicLink\(\)/u.test(routes) && /removeRemoteTree/u.test(routes))
  // The dialog passes `request.sessionId` through; the host-tree bridge has no
  // session of its own and therefore sends only the root it read off the tree.
  check('the browser sends the session id where it has one',
    /sessionId: request\.sessionId/u.test(client) &&
      /sessionId: request\.sessionId \?\? undefined/u.test(client))
  check('the row menu offers rename and delete outside the remote branch',
    /translate\('rowmenu\.rename'\)/u.test(client) && /translate\('rowmenu\.delete'\)/u.test(client))
  check('F2 and Delete are wired for the host tree',
    /event\.key === 'F2' \|\| event\.key === 'Delete'/u.test(client))
}

// ---------------------------------------------------------------------------
// Route behaviour (needs the assembled tree)
// ---------------------------------------------------------------------------
const coreRoot = process.env.DSH_CORE_ROOT
if (!coreRoot) {
  console.log('  SKIP  DSH_CORE_ROOT is not set (route behaviour needs @deepseek-ai/dsh-fs)')
} else {
  process.env.DSH_PEER_ROOT = [coreRoot, process.env.DSH_PEER_ROOT].filter(Boolean).join(path.delimiter)
  const { makeRoutes, ROUTES } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'routes', 'routes.js')).href)

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
    return state
  }
  async function get (routes, url) {
    const routePath = url.split('?')[0]
    const route = routes.find(entry => entry.path === routePath)
    if (route === undefined) throw new Error(`no route ${routePath}`)
    const { res, state } = fakeRes()
    const handlers = new Map()
    await route.handler({
      method: 'GET',
      url,
      headers: { host: 'localhost:13333' },
      socket: { remoteAddress: '127.0.0.1', localPort: 13333 },
      on (event, handler) { handlers.set(event, handler) },
    }, res)
    return state
  }

  // ---- remote -----------------------------------------------------------------
  async function remoteCases () {
    const socketPaths = new Map()
    socketPaths.set('/srv/proj', { type: 'dir', children: ['a.txt', 'dir', 'link', 'detached.txt'] })
    socketPaths.set('/srv/proj/a.txt', { type: 'file' })
    socketPaths.set('/srv/proj/dir', { type: 'dir', children: ['sub', 'inner.txt'] })
    socketPaths.set('/srv/proj/dir/sub', { type: 'dir', children: [] })
    socketPaths.set('/srv/proj/dir/inner.txt', { type: 'file' })
    socketPaths.set('/srv/proj/link', { type: 'link' })
    socketPaths.set('/srv/proj/detached.txt', { type: 'file' })
    const calls = { renames: [], unlinks: [], rmdirs: [], mkdirs: [], opens: [], closes: [] }
    // Paths lstat pretends not to see, so a test can model the window between
    // the existence precheck and the exclusive open.
    const hiddenFromLstat = new Set()
    const sftp = {
      lstat (target, cb) {
        if (hiddenFromLstat.has(target)) { cb(Object.assign(new Error('no such file'), { code: 2 })); return }
        const entry = socketPaths.get(target)
        if (entry === undefined) { cb(Object.assign(new Error('no such file'), { code: 2 })); return }
        cb(null, {
          isDirectory: () => entry.type === 'dir',
          isSymbolicLink: () => entry.type === 'link',
          isFile: () => entry.type === 'file',
        })
      },
      stat (target, cb) {
        const entry = socketPaths.get(target)
        if (entry === undefined) { cb(Object.assign(new Error('no such file'), { code: 2 })); return }
        cb(null, {
          isDirectory: () => entry.type === 'dir',
          isSymbolicLink: () => entry.type === 'link',
          isFile: () => entry.type === 'file',
        })
      },
      readdir (target, cb) {
        const entry = socketPaths.get(target)
        if (entry === undefined || entry.type !== 'dir') { cb(Object.assign(new Error('not a directory'), { code: 2 })); return }
        cb(null, (entry.children ?? []).map(filename => ({ filename })))
      },
      realpath (target, cb) { cb(null, target) },
      mkdir (target, cb) {
        if (socketPaths.has(target)) {
          cb(Object.assign(new Error('failure'), { code: 4 }))
          return
        }
        const parent = target.slice(0, target.lastIndexOf('/')) || '/'
        const entry = socketPaths.get(parent)
        if (entry === undefined || entry.type !== 'dir') {
          cb(Object.assign(new Error('no such file'), { code: 2 }))
          return
        }
        calls.mkdirs.push(target)
        socketPaths.set(target, { type: 'dir', children: [] })
        cb(null)
      },
      rename (from, to, cb) {
        if (!socketPaths.has(from)) { cb(Object.assign(new Error('no such file'), { code: 2 })); return }
        if (socketPaths.has(to)) { cb(Object.assign(new Error('failure'), { code: 4 })); return }
        calls.renames.push([from, to])
        socketPaths.set(to, socketPaths.get(from))
        socketPaths.delete(from)
        cb(null)
      },
      unlink (target, cb) { calls.unlinks.push(target); socketPaths.delete(target); cb(null) },
      rmdir (target, cb) { calls.rmdirs.push(target); socketPaths.delete(target); cb(null) },
      // Exclusive create, as the real server answers it: `wx` on an existing
      // path FAILS (code 4, SFTP FAILURE) instead of truncating; the file it
      // does create starts at zero bytes because nothing is written.
      open (target, flags, cb) {
        // `w` truncates an existing file; `wx` REFUSES it. Modeling both is the
        // point: the route must never rely on the precheck alone.
        if (flags === 'w' && socketPaths.has(target)) {
          calls.opens.push([target, flags])
          socketPaths.get(target).size = 0
          cb(null, { path: target })
          return
        }
        if (flags !== 'wx') { cb(Object.assign(new Error('unsupported flags'), { code: 4 })); return }
        if (socketPaths.has(target)) { cb(Object.assign(new Error('failure'), { code: 4 })); return }
        const parent = target.slice(0, target.lastIndexOf('/')) || '/'
        const entry = socketPaths.get(parent)
        if (entry === undefined || entry.type !== 'dir') { cb(Object.assign(new Error('no such file'), { code: 2 })); return }
        calls.opens.push([target, flags])
        socketPaths.set(target, { type: 'file', size: 0 })
        cb(null, { path: target })
      },
      close (handle, cb) { calls.closes.push(handle.path); cb(null) },
    }
    const detached = new Set()
    const router = {
      roots: new Set(['ssh://qy/srv/proj']),
      assertEnabled (alias, remotePath) {
        if (detached.has(`${alias}:${remotePath}`)) throw Object.assign(new Error('the remote workspace is detached'), { code: 'FS_PERMISSION_DENIED' })
        if (!alias) throw new Error('missing alias')
      },
    }
    const engine = { async withSftp (_alias, work) { return await work(sftp) } }
    const sessions = [
      { id: 's-remote', header: { cwd: 'ssh://qy/srv/proj' }, mode: 'workspace-write' },
      { id: 's-remote-ro', header: { cwd: 'ssh://qy/srv/proj' }, mode: 'read-only' },
    ]
    const ctx = createHost({
      services: {
        sessions: { get: id => sessions.find(s => s.id === id), list: () => sessions },
        sandboxPolicy: { resolve: ({ session }) => ({ mode: session?.mode ?? 'workspace-write', workspaceRoot: session?.header?.cwd ?? 'C:\\fallback' }) },
      },
    }).ctx
    const routes = makeRoutes({ engine, router, ctx, allowLan: false, allowedHosts: [] })

    const rename = await post(routes, ROUTES.rename, { path: 'ssh://qy/srv/proj/a.txt', newName: 'b.txt', sessionId: 's-remote' })
    check('renaming a remote file moves it inside the root', rename.status === 200 && calls.renames.length === 1, JSON.stringify(rename))
    check('...and reports the new spelling', /b\.txt/u.test(rename.body), rename.body)

    const empty = await post(routes, ROUTES.rename, { path: 'ssh://qy/srv/proj/a.txt', newName: '', sessionId: 's-remote' })
    check('an empty remote name is a 400', empty.status === 400, JSON.stringify(empty))

    const separator = await post(routes, ROUTES.rename, { path: 'ssh://qy/srv/proj/a.txt', newName: 'x/y', sessionId: 's-remote' })
    check('a remote name with a separator is a 400', separator.status === 400, JSON.stringify(separator))

    const exists = await post(routes, ROUTES.rename, { path: 'ssh://qy/srv/proj/b.txt', newName: 'dir', sessionId: 's-remote' })
    check('an existing target is a 409', exists.status === 409, JSON.stringify(exists))

    const made = await post(routes, ROUTES.mkdir, { path: 'ssh://qy/srv/proj', name: 'created', sessionId: 's-remote' })
    check('creating a folder below the mounted root works',
      made.status === 200 && calls.mkdirs.includes('/srv/proj/created'), JSON.stringify(made))
    const madeExists = await post(routes, ROUTES.mkdir, { path: 'ssh://qy/srv/proj', name: 'dir', sessionId: 's-remote' })
    check('an existing folder name is a 409',
      madeExists.status === 409 && /already exists/u.test(madeExists.body), JSON.stringify(madeExists))
    const madeOutside = await post(routes, ROUTES.mkdir, { path: 'ssh://qy/other', name: 'x', sessionId: 's-remote' })
    check('creating outside every mounted root is a 403',
      madeOutside.status === 403 && /outside every mounted/u.test(madeOutside.body), JSON.stringify(madeOutside))
    const madeBadName = await post(routes, ROUTES.mkdir, { path: 'ssh://qy/srv/proj', name: 'x/y', sessionId: 's-remote' })
    check('a folder name carrying a separator is a 400',
      madeBadName.status === 400 && /single path segment/u.test(madeBadName.body), JSON.stringify(madeBadName))
    const madeReadOnly = await post(routes, ROUTES.mkdir, { path: 'ssh://qy/srv/proj', name: 'ro', sessionId: 's-remote-ro' })
    check('a read-only session cannot create a folder',
      madeReadOnly.status === 403 && /read-only/u.test(madeReadOnly.body), JSON.stringify(madeReadOnly))
    const madeLocal = await post(routes, ROUTES.mkdir, { path: '/tmp/not-a-workspace', name: 'x', sessionId: 's-remote' })
    check('a local path on a remote session is refused before any filesystem work',
      madeLocal.status === 403 && /cannot belong to it/u.test(madeLocal.body), JSON.stringify(madeLocal))
    check('...and the mkdir route really did reach the local branch',
      routes.length > 0 && madeLocal.body.includes('remote'))
    const madeMissing = await post(routes, ROUTES.mkdir, { path: 'ssh://qy/srv/proj/missing', name: 'x', sessionId: 's-remote' })
    check('a missing parent directory is a 404',
      madeMissing.status === 404 && /does not exist/u.test(madeMissing.body), JSON.stringify(madeMissing))

    // ---- remote create-file -------------------------------------------------
    const createdFile = await post(routes, ROUTES.createFile, { path: 'ssh://qy/srv/proj', name: 'notes.md', sessionId: 's-remote' })
    check('creating a file below the mounted root works',
      createdFile.status === 200 &&
        calls.opens.some(([target, flags]) => target === '/srv/proj/notes.md' && flags === 'wx'),
      JSON.stringify({ createdFile, opens: calls.opens }))
    check('...and the file really is zero bytes',
      socketPaths.get('/srv/proj/notes.md')?.type === 'file' && socketPaths.get('/srv/proj/notes.md')?.size === 0,
      JSON.stringify(socketPaths.get('/srv/proj/notes.md')))
    check('...and the route reports the created spelling',
      JSON.parse(createdFile.body).path === 'ssh://qy/srv/proj/notes.md', createdFile.body)
    check('...and the handle is closed rather than leaked',
      calls.closes.includes('/srv/proj/notes.md'), JSON.stringify(calls.closes))

    const createdTwice = await post(routes, ROUTES.createFile, { path: 'ssh://qy/srv/proj', name: 'notes.md', sessionId: 's-remote' })
    check('creating an existing file name is a 409',
      createdTwice.status === 409 && /already exists/u.test(createdTwice.body), JSON.stringify(createdTwice))
    check('...and the existing file was not touched',
      socketPaths.get('/srv/proj/notes.md')?.size === 0 &&
        calls.opens.filter(([target]) => target === '/srv/proj/notes.md').length === 1,
      JSON.stringify({ entry: socketPaths.get('/srv/proj/notes.md'), opens: calls.opens }))

    const createdDot = await post(routes, ROUTES.createFile, { path: 'ssh://qy/srv/proj', name: '.gitignore', sessionId: 's-remote' })
    check('a dot-leading file name is accepted', createdDot.status === 200, JSON.stringify(createdDot))

    const createdMissing = await post(routes, ROUTES.createFile, { path: 'ssh://qy/srv/proj/missing', name: 'x.txt', sessionId: 's-remote' })
    check('a missing parent directory is a 404',
      createdMissing.status === 404 && /does not exist/u.test(createdMissing.body), JSON.stringify(createdMissing))

    const createdOnFile = await post(routes, ROUTES.createFile, { path: 'ssh://qy/srv/proj/b.txt', name: 'x.txt', sessionId: 's-remote' })
    check('creating below a file is a 400',
      createdOnFile.status === 400 && /not a directory/u.test(createdOnFile.body), JSON.stringify(createdOnFile))

    const createdOutside = await post(routes, ROUTES.createFile, { path: 'ssh://qy/other', name: 'x.txt', sessionId: 's-remote' })
    check('creating outside every mounted root is a 403',
      createdOutside.status === 403 && /outside every mounted/u.test(createdOutside.body), JSON.stringify(createdOutside))

    const createdBadName = await post(routes, ROUTES.createFile, { path: 'ssh://qy/srv/proj', name: 'x/y.txt', sessionId: 's-remote' })
    check('a file name carrying a separator is a 400',
      createdBadName.status === 400 && /single path segment/u.test(createdBadName.body), JSON.stringify(createdBadName))

    const createdReadOnly = await post(routes, ROUTES.createFile, { path: 'ssh://qy/srv/proj', name: 'ro.txt', sessionId: 's-remote-ro' })
    check('a read-only session cannot create a file',
      createdReadOnly.status === 403 && /read-only/u.test(createdReadOnly.body), JSON.stringify(createdReadOnly))

    const createdDetached = await post(routes, ROUTES.createFile, { path: 'ssh://qy/srv/proj', name: 'locked.txt', sessionId: 's-remote' })
    detached.add('qy:/srv/proj/locked.txt')
    const createdDetachedNow = await post(routes, ROUTES.createFile, { path: 'ssh://qy/srv/proj', name: 'locked.txt', sessionId: 's-remote' })
    detached.delete('qy:/srv/proj/locked.txt')
    check('a workspace detached for this path refuses before any SFTP call',
      createdDetachedNow.status === 403 && /detached/u.test(createdDetachedNow.body), JSON.stringify(createdDetachedNow))
    check('...and the earlier, enabled attempt had created it', createdDetached.status === 200, JSON.stringify(createdDetached))

    // The precheck is not the boundary: a file can appear between it and the
    // open. `'wx'` then refuses and the file is left alone; a plain `'w'` would
    // truncate it and answer 200 — the failure mode this assertion pins.
    socketPaths.set('/srv/proj/racing.txt', { type: 'file', size: 5 })
    hiddenFromLstat.add('/srv/proj/racing.txt')
    const raced = await post(routes, ROUTES.createFile, { path: 'ssh://qy/srv/proj', name: 'racing.txt', sessionId: 's-remote' })
    hiddenFromLstat.delete('/srv/proj/racing.txt')
    check('a file that appears after the existence check is refused, not truncated',
      raced.status !== 200 && socketPaths.get('/srv/proj/racing.txt')?.size === 5,
      JSON.stringify({ raced, entry: socketPaths.get('/srv/proj/racing.txt') }))

    const root = await post(routes, ROUTES.deleteEntry, { path: 'ssh://qy/srv/proj', sessionId: 's-remote' })
    check('deleting the mounted root itself is refused', root.status === 403 && /root itself/u.test(root.body), JSON.stringify(root))

    const outside = await post(routes, ROUTES.deleteEntry, { path: 'ssh://qy/other/x', sessionId: 's-remote' })
    check('deleting outside every mounted root is refused', outside.status === 403 && /outside every mounted/u.test(outside.body), JSON.stringify(outside))

    const readOnly = await post(routes, ROUTES.deleteEntry, { path: 'ssh://qy/srv/proj/dir', sessionId: 's-remote-ro' })
    check('a read-only session cannot delete', readOnly.status === 403 && /read-only/u.test(readOnly.body), JSON.stringify(readOnly))

    const policy = await get(routes, `${ROUTES.mutationPolicy}?sessionId=s-remote-ro`)
    check('the policy endpoint reports read-only so the UI can disable the actions',
      policy.status === 200 && /"readOnly":true/u.test(policy.body), policy.body)
    const unknownPolicy = await get(routes, `${ROUTES.mutationPolicy}?root=ssh://qy/not-a-session`)
    check('...and reports no session for a root nothing owns',
      unknownPolicy.status === 200 && /"sessionFound":false/u.test(unknownPolicy.body), unknownPolicy.body)

    const unknownRoot = await post(routes, ROUTES.deleteEntry, { path: 'ssh://qy/srv/proj/dir', root: 'ssh://qy/not-a-session' })
    check('a request naming a root no session owns is refused', unknownRoot.status === 403 && /could not identify the session/u.test(unknownRoot.body), JSON.stringify(unknownRoot))

    detached.add('qy:/srv/proj/detached.txt')
    const detachedDelete = await post(routes, ROUTES.deleteEntry, { path: 'ssh://qy/srv/proj/detached.txt', sessionId: 's-remote' })
    check('a detached workspace refuses the mutation before any SFTP call',
      detachedDelete.status === 403 && /detached/u.test(detachedDelete.body), JSON.stringify(detachedDelete))
    detached.delete('qy:/srv/proj/detached.txt')

    const linkDelete = await post(routes, ROUTES.deleteEntry, { path: 'ssh://qy/srv/proj/link', sessionId: 's-remote' })
    check('a remote symlink is unlinked, not resolved', linkDelete.status === 200 && calls.unlinks.includes('/srv/proj/link'), JSON.stringify(linkDelete))

    const dirDelete = await post(routes, ROUTES.deleteEntry, { path: 'ssh://qy/srv/proj/dir', sessionId: 's-remote' })
    check('a remote directory is removed recursively', dirDelete.status === 200 &&
      calls.unlinks.includes('/srv/proj/dir/inner.txt') &&
      calls.rmdirs.includes('/srv/proj/dir'), JSON.stringify({ dirDelete, calls }))
  }

  await remoteCases()

  // ---- local ------------------------------------------------------------------
  const localRoot = mkdtempSync(path.join(tmpdir(), 'dsh-ws-mut-'))
  const outsideRoot = mkdtempSync(path.join(tmpdir(), 'dsh-ws-out-'))
  const sessions = [{ id: 's-local', header: { cwd: localRoot }, mode: 'workspace-write' }]
  const ctx = createHost({
    services: {
      sessions: { get: id => sessions.find(s => s.id === id), list: () => sessions },
      sandboxPolicy: { resolve: ({ session }) => ({ mode: session?.mode ?? 'workspace-write', workspaceRoot: session?.header?.cwd ?? localRoot }) },
    },
  }).ctx
  const routes = makeRoutes({
    engine: { async withSftp () { throw new Error('local path went to SFTP') } },
    router: { roots: new Set() },
    ctx,
    allowLan: false,
    allowedHosts: [],
  })

  writeFileSync(path.join(localRoot, 'file.txt'), 'hello')
  const renameLocal = await post(routes, ROUTES.rename, { path: path.join(localRoot, 'file.txt'), newName: 'renamed.txt', sessionId: 's-local' })
  check('renaming a local file works', renameLocal.status === 200 && lstatSync(path.join(localRoot, 'renamed.txt')).isFile(), JSON.stringify(renameLocal))

  const outsideChild = path.join(outsideRoot, 'elsewhere.txt')
  writeFileSync(outsideChild, 'outside')
  const localOutside = await post(routes, ROUTES.rename, { path: outsideChild, newName: 'moved.txt', sessionId: 's-local' })
  check('renaming outside the authoritative root is refused', localOutside.status === 403 && /outside the session workspace/u.test(localOutside.body), JSON.stringify(localOutside))

  // A client that invents a root must not move the boundary: the path is outside
  // BOTH the real root and the invented one, and no session owns the invented
  // root, so the request is refused before any filesystem work.
  const invented = await post(routes, ROUTES.deleteEntry, { path: outsideChild, root: outsideRoot })
  check('an invented root is not adopted as a boundary', invented.status === 403 && /could not identify the session/u.test(invented.body), JSON.stringify(invented))

  // The sharper case: a REAL session id plus a root the client invented. A
  // route that read the root from the request would accept this and delete a
  // file outside the session's workspace.
  const inventedWithSession = await post(routes, ROUTES.deleteEntry, {
    path: outsideChild,
    root: outsideRoot,
    sessionId: 's-local',
  })
  check('a real session id does not let the client redefine its root',
    inventedWithSession.status === 403 && /outside the session workspace/u.test(inventedWithSession.body),
    JSON.stringify(inventedWithSession))
  check('...and the outside file is untouched', lstatSync(outsideChild).isFile(), 'the refusal still deleted the file')


  // ---- local mkdir ----------------------------------------------------------
  // The same route serves both halves: the path spelling decides the branch, and
  // the local branch reads its root from the session, not from the request.
  const madeFolder = await post(routes, ROUTES.mkdir, { path: localRoot, name: 'fresh', sessionId: 's-local' })
  check('creating a folder in the local workspace works',
    madeFolder.status === 200 && lstatSync(path.join(localRoot, 'fresh')).isDirectory(), JSON.stringify(madeFolder))
  check('...and reports the created path',
    JSON.parse(madeFolder.body).path === path.join(localRoot, 'fresh'), madeFolder.body)

  const madeNested = await post(routes, ROUTES.mkdir, { path: path.join(localRoot, 'fresh'), name: 'inner', sessionId: 's-local' })
  check('a nested folder is created below its resolved directory',
    madeNested.status === 200 && lstatSync(path.join(localRoot, 'fresh', 'inner')).isDirectory(), JSON.stringify(madeNested))

  const madeTwice = await post(routes, ROUTES.mkdir, { path: path.join(localRoot, 'fresh'), name: 'inner', sessionId: 's-local' })
  check('creating an existing folder name is a 409', madeTwice.status === 409, JSON.stringify(madeTwice))

  const madeSeparator = await post(routes, ROUTES.mkdir, { path: localRoot, name: 'a/b', sessionId: 's-local' })
  check('a folder name carrying a separator is a 400', madeSeparator.status === 400, JSON.stringify(madeSeparator))

  const madeOutside2 = await post(routes, ROUTES.mkdir, { path: outsideRoot, name: 'escape', sessionId: 's-local' })
  check('creating outside the session workspace is refused',
    madeOutside2.status === 403 && /outside the session workspace/u.test(madeOutside2.body), JSON.stringify(madeOutside2))
  check('...and nothing was created there', !exists(path.join(outsideRoot, 'escape')))

  const madeOnFile = await post(routes, ROUTES.mkdir, { path: path.join(localRoot, 'renamed.txt'), name: 'x', sessionId: 's-local' })
  check('creating below a file is refused', madeOnFile.status === 400 && /not a directory/u.test(madeOnFile.body), JSON.stringify(madeOnFile))

  const madeMissingLocal = await post(routes, ROUTES.mkdir, { path: path.join(localRoot, 'no-such'), name: 'x', sessionId: 's-local' })
  check('a missing local parent directory is a 404',
    madeMissingLocal.status === 404 && /does not exist/u.test(madeMissingLocal.body), JSON.stringify(madeMissingLocal))

  // A request that names a DIFFERENT root must not move the boundary: the
  // folder has to appear under the session workspace, never under the named
  // root. This is the local-mkdir twin of the rename/delete rule above.
  const namedRoot = await post(routes, ROUTES.mkdir, { path: outsideRoot, name: 'invented', root: outsideRoot, sessionId: 's-local' })
  check('a foreign root on the local mkdir request does not become the boundary',
    namedRoot.status === 403 && /outside the session workspace/u.test(namedRoot.body), JSON.stringify(namedRoot))
  check('...and nothing was created under it', !exists(path.join(outsideRoot, 'invented')))

  const renamedRoot = await post(routes, ROUTES.mkdir, { path: localRoot, name: 'kept', root: outsideRoot, sessionId: 's-local' })
  check('the session root still wins when the request names another one',
    renamedRoot.status === 200 && lstatSync(path.join(localRoot, 'kept')).isDirectory(), JSON.stringify(renamedRoot))
  check('...and the named root stays untouched', !exists(path.join(outsideRoot, 'kept')))

  // A directory that RESOLVES outside the root: lexical containment passes, so
  // only the realpath comparison can refuse it. A junction works without
  // developer mode on Windows; a plain symlink covers POSIX.
  let escapeReady = false
  try {
    symlinkSync(outsideRoot, path.join(localRoot, 'escape-dir'), 'junction')
    escapeReady = true
  } catch {
    try {
      symlinkSync(outsideRoot, path.join(localRoot, 'escape-dir'))
      escapeReady = true
    } catch { /* neither form is available on this machine */ }
  }
  if (escapeReady) {
    const escaped = await post(routes, ROUTES.mkdir, { path: path.join(localRoot, 'escape-dir'), name: 'inside', sessionId: 's-local' })
    check('a directory that resolves outside the root is refused',
      escaped.status === 403 && /resolves outside/u.test(escaped.body), JSON.stringify(escaped))
    check('...and nothing was created through the link', !exists(path.join(outsideRoot, 'inside')))
    rmSync(path.join(localRoot, 'escape-dir'), { recursive: true, force: true })
  } else {
    console.log('  NOTE  no symlink/junction support (the realpath fence is unproven on this machine)')
  }

  // ---- local create-file ----------------------------------------------------
  // Same route shape as mkdir, and the same rule: the root comes from the
  // session, never from the request.
  const madeFile = await post(routes, ROUTES.createFile, { path: localRoot, name: 'notes.md', sessionId: 's-local' })
  check('creating a file in the local workspace works',
    madeFile.status === 200 && lstatSync(path.join(localRoot, 'notes.md')).isFile(), JSON.stringify(madeFile))
  check('...and it is zero bytes', statSync(path.join(localRoot, 'notes.md')).size === 0)
  const madeFileTwice = await post(routes, ROUTES.createFile, { path: localRoot, name: 'notes.md', sessionId: 's-local' })
  check('creating an existing local file name is a 409',
    madeFileTwice.status === 409 && /already exists/u.test(madeFileTwice.body), JSON.stringify(madeFileTwice))
  const madeFileOutside = await post(routes, ROUTES.createFile, { path: outsideRoot, name: 'escape.txt', sessionId: 's-local' })
  check('creating a file outside the session workspace is refused',
    madeFileOutside.status === 403 && /outside the session workspace/u.test(madeFileOutside.body), JSON.stringify(madeFileOutside))
  check('...and nothing was created there', !exists(path.join(outsideRoot, 'escape.txt')))
  const madeFileSeparator = await post(routes, ROUTES.createFile, { path: localRoot, name: 'a/b.txt', sessionId: 's-local' })
  check('a local file name carrying a separator is a 400',
    madeFileSeparator.status === 400 && /single path segment/u.test(madeFileSeparator.body), JSON.stringify(madeFileSeparator))
  const madeFileOnFile = await post(routes, ROUTES.createFile, { path: path.join(localRoot, 'renamed.txt'), name: 'x.txt', sessionId: 's-local' })
  check('creating a file below a file is a 400',
    madeFileOnFile.status === 400 && /not a directory/u.test(madeFileOnFile.body), JSON.stringify(madeFileOnFile))
  const madeDotFile = await post(routes, ROUTES.createFile, { path: localRoot, name: '.gitignore', sessionId: 's-local' })
  check('a dot-leading local file name is accepted',
    madeDotFile.status === 200 && lstatSync(path.join(localRoot, '.gitignore')).isFile(), JSON.stringify(madeDotFile))

  const readOnlySessions = sessions.concat([{ id: 's-local-ro', header: { cwd: localRoot }, mode: 'read-only' }])
  const readOnlyCtx = createHost({
    services: {
      sessions: { get: id => readOnlySessions.find(s => s.id === id), list: () => readOnlySessions },
      sandboxPolicy: { resolve: ({ session }) => ({ mode: session?.mode ?? 'workspace-write', workspaceRoot: session?.header?.cwd ?? localRoot }) },
    },
  }).ctx
  const readOnlyRoutes = makeRoutes({
    engine: { async withSftp () { throw new Error('local path went to SFTP') } },
    router: { roots: new Set() },
    ctx: readOnlyCtx,
    allowLan: false,
    allowedHosts: [],
  })
  const madeReadOnlyLocal = await post(readOnlyRoutes, ROUTES.mkdir, { path: localRoot, name: 'nope', sessionId: 's-local-ro' })
  check('a read-only local session cannot create a folder',
    madeReadOnlyLocal.status === 403 && /read-only/u.test(madeReadOnlyLocal.body), JSON.stringify(madeReadOnlyLocal))
  check('...and nothing was created', !exists(path.join(localRoot, 'nope')))
  const madeReadOnlyFile = await post(readOnlyRoutes, ROUTES.createFile, { path: localRoot, name: 'nope.txt', sessionId: 's-local-ro' })
  check('a read-only local session cannot create a file',
    madeReadOnlyFile.status === 403 && /read-only/u.test(madeReadOnlyFile.body), JSON.stringify(madeReadOnlyFile))
  check('...and nothing was created either', !exists(path.join(localRoot, 'nope.txt')))
  mkdirSync(path.join(localRoot, 'sub'))
  const existsAfter = await post(routes, ROUTES.rename, {
    path: path.join(localRoot, 'renamed.txt'),
    newName: 'sub',
    sessionId: 's-local',
  })
  check('renaming onto an existing local target is a 409', existsAfter.status === 409, JSON.stringify(existsAfter))

  const rootDelete = await post(routes, ROUTES.deleteEntry, { path: localRoot, sessionId: 's-local' })
  check('deleting the local workspace root is refused', rootDelete.status === 403 && /root itself/u.test(rootDelete.body), JSON.stringify(rootDelete))

  mkdirSync(path.join(localRoot, 'tree', 'child'), { recursive: true })
  writeFileSync(path.join(localRoot, 'tree', 'child', 'x.txt'), 'x')
  const treeDelete = await post(routes, ROUTES.deleteEntry, { path: path.join(localRoot, 'tree'), sessionId: 's-local' })
  check('deleting a local directory removes its subtree', treeDelete.status === 200 && !exists(path.join(localRoot, 'tree')), JSON.stringify(treeDelete))

  // Symlinks are platform-dependent to create; when the OS refuses, the route's
  // symlink branch is still proven on the remote fake above.
  let linkReady = false
  try {
    symlinkSync(path.join(localRoot, 'renamed.txt'), path.join(localRoot, 'link.txt'))
    linkReady = true
  } catch { /* Windows without developer mode */ }
  if (linkReady) {
    const linkDelete = await post(routes, ROUTES.deleteEntry, { path: path.join(localRoot, 'link.txt'), sessionId: 's-local' })
    check('deleting a local symlink removes only the link',
      linkDelete.status === 200 && lstatSync(path.join(localRoot, 'renamed.txt')).isFile() &&
        !(() => { try { lstatSync(path.join(localRoot, 'link.txt')); return true } catch { return false } })(),
    JSON.stringify(linkDelete))
  } else {
    console.log('  NOTE  local symlink creation needs developer mode / POSIX (remote fake covers the branch)')
  }

  rmSync(localRoot, { recursive: true, force: true })
  rmSync(outsideRoot, { recursive: true, force: true })
}

console.log(`\n=== ${passed} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('failures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
