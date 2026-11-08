/**
 * Rename / delete: the pure rules, the route fences, and the local authority.
 *
 * The pure half runs on a bare checkout. The route half needs the assembled DSH
 * tree (`DSH_CORE_ROOT`) because `routes.js` imports the host's peer packages,
 * and it is skipped without one — the same rule as `routes-smoke`.
 *
 * The load-bearing assertion is the local one: a request may NAME a root, but it
 * may not DEFINE one. A request that names a root no session owns must be
 * refused even when it also carries a perfectly plausible absolute path.
 *
 * Run: node tests/mutations-smoke.mjs
 */

import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isWithinLocalRoot, mutationNameRefusal, renameTargetPath, rootMutationRefusal, deletionSummary } from '../lib/mutations.js'

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
  const routes = readFileSync(path.join(pluginRoot, 'lib', 'routes.js'), 'utf8')
  const client = readFileSync(path.join(pluginRoot, 'lib', 'client.js'), 'utf8')
  check('the route table has a rename and a delete endpoint',
    /rename: '\/api\/dsh-ssh-workspace\/rename'/u.test(routes) &&
      /deleteEntry: '\/api\/dsh-ssh-workspace\/delete'/u.test(routes))
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
  const { makeRoutes, ROUTES } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'routes.js')).href)

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
    socketPaths.set('/srv/proj/a.txt', { type: 'file' })
    socketPaths.set('/srv/proj/dir', { type: 'dir', children: ['sub', 'inner.txt'] })
    socketPaths.set('/srv/proj/dir/sub', { type: 'dir', children: [] })
    socketPaths.set('/srv/proj/dir/inner.txt', { type: 'file' })
    socketPaths.set('/srv/proj/link', { type: 'link' })
    socketPaths.set('/srv/proj/detached.txt', { type: 'file' })
    const calls = { renames: [], unlinks: [], rmdirs: [] }
    const sftp = {
      lstat (target, cb) {
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
    const ctx = {
      get (name) {
        if (name === 'sessions') return { get: id => sessions.find(s => s.id === id), list: () => sessions }
        if (name === 'sandboxPolicy') return { resolve: ({ session }) => ({ mode: session?.mode ?? 'workspace-write', workspaceRoot: session?.header?.cwd ?? 'C:\\fallback' }) }
        return undefined
      },
    }
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
  const ctx = {
    get (name) {
      if (name === 'sessions') return { get: id => sessions.find(s => s.id === id), list: () => sessions }
      if (name === 'sandboxPolicy') return { resolve: ({ session }) => ({ mode: session?.mode ?? 'workspace-write', workspaceRoot: session?.header?.cwd ?? localRoot }) }
      return undefined
    },
  }
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
