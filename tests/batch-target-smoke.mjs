/**
 * One destination for a whole batch, chosen once.
 *
 * The complaint this suite answers was concrete: "批量下载现在是一个个弹窗".
 * A batch used to reach the queue with `{ kind: 'unsupported' }` whenever the
 * page could not write through a `FileSystemDirectoryHandle`, and that value
 * means "let each item open its own save dialog" — ten rows, ten dialogs.
 *
 * Two things had to change for one dialog to be enough, and both are pinned
 * here as SHIPPED code, lifted out of `lib/client.js` the same way the other
 * client suites do it (a retyped copy would prove nothing about what the
 * browser gets):
 *
 *  1. `pickDirTarget` now falls back to the HOST's own folder chooser and
 *     answers `{kind:'path'}` — a plain local directory the server can write
 *     to directly.
 *  2. `enqueueDownloadsInto` hands that folder to every item at once, and the
 *     three destination kinds stay distinguishable instead of collapsing into
 *     "unsupported".
 *
 * Run: node tests/batch-target-smoke.mjs
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

let passed = 0
const failures = []
function check (name, condition, detail) {
  if (condition) { passed += 1; console.log(`  PASS  ${name}`) } else {
    failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== batch target smoke ===\n')

/** Slice one marked region, failing loudly when the marker moved. */
function slice (startMarker, endMarker, label) {
  const start = source.indexOf(startMarker)
  if (start < 0) throw new Error(`client.js no longer marks ${label} (start)`)
  const end = source.indexOf(endMarker, start + startMarker.length)
  if (end < 0) throw new Error(`client.js no longer marks ${label} (end)`)
  return source.slice(start, end)
}

// ---- lift the two shipped pieces ------------------------------------------
let api
try {
  const picker = slice('    /**\n     * Ask the DESKTOP shell for a folder through its preload bridge.', '    /**\n     * Stream a response body into a writable file handle.', 'the destination picker')
  const batch = slice('    /**\n     * Queue several downloads that all land in ONE chosen folder.', '    /**\n     * One download: file or directory archive', 'the batch enqueue')

  // The picker reaches for exactly two globals; the batch enqueue reaches for
  // the single-job enqueue it wraps. Everything else is injected so the suite
  // can observe what the real code decided.
  const factory = new Function('window', 'globalThis', 'enqueueDownloadJobs', `
    ${picker}
    ${batch}
    return { pickDirTarget, pickHostFolder, pickDesktopFolder, enqueueDownloadsInto }
  `)
  api = (env = {}, overrides = {}) => {
    const queued = []
    const built = factory(
      env.window ?? {},
      env.globalThis ?? {},
      (jobs) => { queued.push(...jobs); return jobs.map((_, index) => `job-${index}`) },
      overrides,
    )
    return { ...built, queued }
  }
} catch (error) {
  console.log(`  FAIL  the picker could be lifted out of the bundle — ${error.message}`)
  process.exit(1)
}

const ITEMS = [
  { alias: 'a', remotePath: '/srv/report.txt', suggestedName: 'report.txt', isDir: false },
  { alias: 'a', remotePath: '/srv/logs', suggestedName: 'logs.zip', isDir: true },
]

// ---- the browser picker still wins when it exists -------------------------
{
  const handle = { getFileHandle: async () => ({}) }
  const { pickDirTarget } = api({ window: { showDirectoryPicker: async () => handle } })
  const folder = await pickDirTarget({ get: () => undefined })
  check('the File System Access API is used when it exists', folder.kind === 'handle' && folder.handle === handle,
    JSON.stringify(folder))
}

{
  const { pickDirTarget } = api({
    window: { showDirectoryPicker: async () => { const err = new Error('closed'); err.name = 'AbortError'; throw err } },
  })
  const folder = await pickDirTarget({ get: () => ({ pickDirectory: async () => '/should/not/be/asked' }) })
  check('cancelling the browser picker is a CANCEL, not a fallback', folder.kind === 'canceled', JSON.stringify(folder))
}

// ---- the fallback that makes one dialog enough ----------------------------
{
  // No File System Access API at all: the host chooser answers instead.
  const ctx = { get: (name) => (name === 'uiWorkspace' ? { pickDirectory: async () => 'C:\\Users\\u\\Downloads' } : undefined) }
  const { pickDirTarget } = api({ window: {} })
  const folder = await pickDirTarget(ctx)
  check('without the browser picker the HOST chooser supplies a plain path',
    folder.kind === 'path' && folder.path === 'C:\\Users\\u\\Downloads', JSON.stringify(folder))
}

{
  // A page policy refuses the browser picker (not a user cancel): falling back
  // is the whole point — a forbidden API must not leave the user without a
  // destination.
  const { pickDirTarget } = api({
    window: { showDirectoryPicker: async () => { const err = new Error('blocked'); err.name = 'SecurityError'; throw err } },
  })
  const ctx = { get: () => ({ pickDirectory: async () => '/home/u/out' }) }
  const folder = await pickDirTarget(ctx)
  check('a refused browser picker falls THROUGH to the host chooser',
    folder.kind === 'path' && folder.path === '/home/u/out', JSON.stringify(folder))
}

{
  // The desktop preload bridge is preferred over the service when present: it
  // is the same native dialog, reached without a round trip.
  const desktop = { pick: async () => 'D:\\downloads' }
  const { pickDirTarget } = api({ window: {}, globalThis: { __DSH_DIRECTORY_PICKER__: desktop } })
  const folder = await pickDirTarget({ get: () => ({ pickDirectory: async () => '/ignored' }) })
  check('the desktop preload bridge is used when the app provides it',
    folder.kind === 'path' && folder.path === 'D:\\downloads', JSON.stringify(folder))
}

{
  // The regression that started this: the FIRST batch download after the app
  // opened showed a folder dialog, accepted a folder, and still ended in the
  // cancel branch. The page's own picker can answer `AbortError` after the real
  // dialog was accepted, so the shell bridge must be asked FIRST — the page's
  // picker is not allowed to see the gesture at all when a bridge exists.
  let askedPage = 0
  const { pickDirTarget } = api({
    window: { showDirectoryPicker: async () => { askedPage += 1; const err = new Error('closed by the page'); err.name = 'AbortError'; throw err } },
    globalThis: { __DSH_DIRECTORY_PICKER__: { pick: async () => 'D:\\downloads' } },
  })
  const folder = await pickDirTarget({ get: () => ({ pickDirectory: async () => '/ignored' }) })
  check('the desktop bridge is asked BEFORE the page picker (first-call AbortError)',
    folder.kind === 'path' && folder.path === 'D:\\downloads' && askedPage === 0, JSON.stringify(folder))
}

{
  // A bridge that is present but refuses (not a cancel) must not strand the
  // batch: the page's picker is still worth a try, and a cancel there is real.
  const { pickDirTarget } = api({
    window: { showDirectoryPicker: async () => ({ getFileHandle: async () => ({}) }) },
    globalThis: { __DSH_DIRECTORY_PICKER__: { pick: async () => { throw new Error('no window to attach to') } } },
  })
  const folder = await pickDirTarget({ get: () => undefined })
  check('a refusing bridge leaves the page picker in play',
    folder.kind === 'handle', JSON.stringify(folder))
}

{
  // A native dialog reports a cancel by REJECTING on some platforms. That is a
  // cancel; a genuine failure is not, because the two lead to opposite advice.
  const { pickDirTarget } = api({ window: {} })
  const cancelled = await pickDirTarget({ get: () => ({ pickDirectory: async () => { throw new Error('User cancelled the dialog') } }) })
  check('a native cancel reported as an error is still a cancel', cancelled.kind === 'canceled', JSON.stringify(cancelled))

  const failed = await pickDirTarget({ get: () => ({ pickDirectory: async () => { throw new Error('no display available') } }) })
  check('a genuine picker failure is NOT reported as a cancel', failed.kind === 'unsupported', JSON.stringify(failed))
}

{
  // Neither chooser exists: the caller must fall back to per-file dialogs, and
  // saying "unsupported" is what makes it do that.
  const { pickDirTarget } = api({ window: {} })
  const folder = await pickDirTarget({ get: () => undefined })
  check('a platform with no chooser at all is UNSUPPORTED, not canceled',
    folder.kind === 'unsupported', JSON.stringify(folder))
}

// ---- one folder, every item ----------------------------------------------
{
  const { enqueueDownloadsInto, queued } = api()
  const ids = enqueueDownloadsInto(ITEMS, { kind: 'path', path: '/home/u/out' })
  check('a batch enqueues every item in ONE call', queued.length === 2 && ids.length === 2, JSON.stringify(ids))
  check('...and every item inherits the chosen local directory',
    queued.every(job => job.localDir === '/home/u/out'), JSON.stringify(queued.map(job => job.localDir)))
  check('...with no per-item save dialog left to open',
    queued.every(job => job.target === null), JSON.stringify(queued.map(job => job.target)))
  check('...and no page-owned folder either',
    queued.every(job => job.folder === null), JSON.stringify(queued.map(job => job.folder)))
  check('the directory flag survives the trip', queued[1].isDir === true && queued[0].isDir === false,
    JSON.stringify(queued.map(job => job.isDir)))
}

{
  const handle = { getFileHandle: async () => ({}) }
  const { enqueueDownloadsInto, queued } = api()
  enqueueDownloadsInto(ITEMS, { kind: 'handle', handle })
  check('a page-owned folder is passed as a handle, not a path',
    queued.every(job => job.folder === handle && job.localDir === null), JSON.stringify(queued.map(job => job.localDir)))
}

{
  const { enqueueDownloadsInto, queued } = api()
  enqueueDownloadsInto(ITEMS, { kind: 'unsupported' })
  check('with no folder at all each item keeps its own save dialog',
    queued.every(job => job.target?.kind === 'unsupported' && job.folder === null && job.localDir === null),
    JSON.stringify(queued))
}

{
  const { enqueueDownloadsInto, queued } = api()
  check('an empty batch enqueues nothing', enqueueDownloadsInto([], { kind: 'unsupported' }).length === 0 && queued.length === 0)
  check('a missing batch enqueues nothing', enqueueDownloadsInto(undefined, { kind: 'path', path: '/x' }).length === 0 && queued.length === 0)
}

// ---- source wiring --------------------------------------------------------
{
  check('the tree batch surface asks for ONE folder, once',
    (source.match(/pickDirTarget\(ctx\)/gu) ?? []).length === 1,
    'the batch surface stopped asking for a single destination')
  check('...and routes it through the one shared batch enqueue',
    /async function downloadTreeItems[\s\S]{0,1400}?enqueueDownloadsInto\(/u.test(source),
    'a surface grew its own per-item destination handling')
  check('the per-file dialogs are still the documented fallback',
    /const target = await pickFileTarget\(/u.test(source),
    'the single-file path lost its save dialog')
  // Cancelling a host-side copy must stop it WHILE it runs. That path awaits a
  // single promise that settles only when the whole tree has landed, so a check
  // placed after the await would make the stop button inert for exactly the
  // copy it was meant to cancel.
  check('a host-side copy polls for cancellation instead of checking afterwards',
    /setInterval\(\(\) => \{ if \(ctx\.isCancelled\(\)\) stop\(\) \}/u.test(source),
    'cancelling a host-side copy does nothing until it finishes')
  check('...and the poll is cleared on both outcomes',
    /finally \{\s*\n\s*if \(poll !== null\) clearInterval\(poll\)/u.test(source),
    'the cancellation poll leaks after the request settles')
  check('...and the request is aborted, so the HOST stops walking the tree',
    /controller\?\.abort\(\)/u.test(source) && /signal: controller\.signal/u.test(source),
    'the client stops listening but the server keeps copying')
  check('the host folder chooser reuses the workspace service, not a new one',
    /ctx\?\.get\?\.\('uiWorkspace'\)/u.test(source) && /pickDirectory/u.test(source),
    'a second directory-picking mechanism was introduced')
  check('the desktop bridge is consulted before the page picker',
    /async function pickDirTarget \(ctx\) \{\s*\n\s*const desktop = await pickDesktopFolder\(\)/u.test(source) &&
      source.slice(source.indexOf('async function pickDirTarget (ctx)')).indexOf('await pickDesktopFolder()') <
        source.slice(source.indexOf('async function pickDirTarget (ctx)')).indexOf('window.showDirectoryPicker()'),
    'the page picker runs before the shell bridge again')
  check('a cancelled destination says so instead of vanishing',
    (source.match(/notifyUser\(translate\('transfer\.pickCanceled'\), 'muted'\)/gu) ?? []).length === 1 &&
      (source.match(/notifyUser\(t\('transfer\.pickCanceled'\), 'muted'\)/gu) ?? []).length === 0,
    'a batch that ended in the cancel branch is silent again')
  check('...and the key exists in both dictionaries',
    (source.match(/      'transfer\.pickCanceled': '/gu) ?? []).length === 2,
    'the cancel notice has no translation')
}

// ---- the cancel notice has a face of its own ------------------------------
//
// `armToast` used to know two outcomes. A cancel is neither: painting it green
// would announce a download that did not happen, painting it red would alarm
// about a gesture the user chose — so a third face exists, and this is the
// shipped `notifyUser` proving it.
{
  const { makeToastDom } = await import(pathToFileURL(path.join(here, 'support', 'toast-dom.mjs')).href)
  const dom = makeToastDom()
  const { notifyUser } = dom.build(source)
  notifyUser('已取消：没有选择目标文件夹', 'muted')
  const node = dom.nodes[0]
  check('a muted notice wears neither outcome colour',
    !node.className.includes('sshwsp-toast-ok') && !node.className.includes('sshwsp-toast-err'), node.className)
  check('...it is neutral instead', node.className.includes('sshwsp-toast-muted'), node.className)
  check('...it does not steal focus from the user', dom.document.activeElement === null, String(dom.document.activeElement))
  check('...but it still expires on the one seven-second window',
    dom.timers.length === 1 && dom.timers[0].ms === 7000,
    `${dom.timers.length} timer(s), ms=${dom.timers.map(timer => timer.ms).join(',')}`)
  check('...and it is still dismissible from the keyboard', node.tabIndex === 0, String(node.tabIndex))

  notifyUser('boom', 'err')
  check('a failure still interrupts with role="alert"', dom.nodes.length === 1 && dom.nodes[0].role === 'alert', dom.nodes[0].role)
  check('...and still takes focus, for Esc/Enter', dom.document.activeElement === dom.nodes[0])
}

// ---- the route the queue posts to actually exists --------------------------
//
// The 405 the user saw was not a server bug: `runDownloadJob` posts
// `API.transfer`, and the page's API table had no `transfer` key — so `fetch`
// received `undefined`, resolved it against the app URL, and requested
// `dsh-app://app/undefined`. Both halves are pinned here, because a lift-out
// test that stops at `runDownloadJob` never performs the fetch and cannot see
// this.
{
  const table = /const API = \{\n([\s\S]*?)\n    \}/u.exec(source)
  check('the page API table registers the transfer route',
    table !== null && /\n\s*transfer: '\/api\/dsh-ssh-workspace\/transfer',/u.test(table[1]),
    'the queue posts an undefined URL and the host answers 405')
  check('...and the one-shot folder download is what posts to it',
    /await fetchJson\(API\.transfer, \{/u.test(source),
    'the queue stopped using the route it advertises')
}

// ---- the server side: a folder download is now a folder -------------------
{
  const routes = readFileSync(path.join(here, '..', 'lib', 'routes.js'), 'utf8')
  check('the transfer route walks a remote tree down when recursive is set',
    /recursive && direction === 'download'/u.test(routes) && /await downloadTree\(engine, \{/u.test(routes),
    'a recursive download still falls through to the single-file branch')
  check('...and a cancelled request aborts the walk instead of finishing it',
    /abortOnClientGone/u.test(routes) && /signal,\s*\n\s*onConflict/u.test(routes),
    'closing the panel no longer stops the copy')
  check('the abort listener is on the RESPONSE, not the request',
    /res\.once\?\.\('close', onClose\)/u.test(routes) &&
      // The OTHER two `req.once('close')` listeners belong to the streaming
      // download routes, which check `res.writableEnded` and are unrelated to
      // this helper. What must not exist is one inside `abortOnClientGone`.
      !/function abortOnClientGone[\s\S]{0,400}req\.once\?\.\('close'/u.test(routes),
    'the signal fires as soon as the request body is read, aborting every transfer')
  check('a normal completion is not mistaken for an abandonment',
    /res\.writableFinished !== true/u.test(routes),
    'a finished transfer would abort its own final write')
}

console.log(`\n=== ${passed} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('failures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
