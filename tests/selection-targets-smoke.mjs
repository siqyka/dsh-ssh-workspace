/**
 * "Which rows does this action act on?" — asked once, answered once.
 *
 * ## Why this suite exists
 *
 * The row menu used to carry TWO verbs per action: "delete" acted on the row
 * under the pointer, and a separate "删除所选（N 项）" acted on the selection.
 * Two labels for one verb means two code paths, and the count in the label was
 * computed from a DIFFERENT array than the one the delete then walked — so a
 * menu could promise three rows and remove one.
 *
 * The rule now is:
 *
 *  - ONE label per verb ("删除", "下载到本机"), never a count;
 *  - ONE function, `resolveTargets`, decides between "this row" and "these
 *    rows", and the selection it returns is painted BEFORE the menu opens;
 *  - the scope is stated where the consequence is — the delete confirmation and
 *    the download destination dialog — from the SAME array the action uses.
 *
 * ## What is lifted
 *
 * The shipped functions, not a retyped copy: `resolveTargets`,
 * `countDeleteContents` (with its real `listRemoteForCount`), `requestRowDelete`,
 * `requestBatchDownload` and `downloadRows` are read out of `lib/client.js` and
 * driven with doubles for `document`, `fetch`, the folder picker and the
 * dialog. A copy would prove nothing about what the browser runs.
 *
 * Run: node tests/selection-targets-smoke.mjs
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

let passed = 0
const failures = []
function check (name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== selection targets smoke ===\n')

// ---- slicing ---------------------------------------------------------------

/** Index just past the `}` that closes the `{` at `open` (raw brace counting). */
function endOfBlock (text, open) {
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1
    else if (text[index] === '}') {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  throw new Error('unbalanced braces: the slice was pointed at a truncated body')
}

/** One function's full text, located by its declaration line. */
function functionText (declaration) {
  const at = source.indexOf(declaration)
  if (at < 0) throw new Error(`client.js no longer declares ${declaration}`)
  return source.slice(at, endOfBlock(source, source.indexOf('{', at)))
}

/** A contiguous region, failing loudly when either marker moved. */
function sliceBetween (startMarker, endMarker, label) {
  const start = source.indexOf(startMarker)
  if (start < 0) throw new Error(`client.js no longer marks ${label} (start)`)
  const end = source.indexOf(endMarker, start + startMarker.length)
  if (end < 0) throw new Error(`client.js no longer marks ${label} (end)`)
  return source.slice(start, end)
}

const remoteTargetOfSrc = functionText('    function remoteTargetOf (absPath) {')
const entryNameOfSrc = functionText('    function entryNameOf (target) {')
const resolveTargetsSrc = functionText('    function resolveTargets (clickedRow, selection) {')
const counterSrc = sliceBetween(
  '    /** How many entries a delete confirmation counts',
  '\n    /**\n     * The delete confirmation',
  'the delete counters',
)
const requestRowDeleteSrc = functionText('    async function requestRowDelete (request) {')
const requestBatchDownloadSrc = functionText('    function requestBatchDownload (chosen, skipped, ctx) {')
const downloadRowsSrc = functionText('    async function downloadRows (items, ctx) {')

// ---- doubles ---------------------------------------------------------------

/** A DOM element double: enough for the dialog bodies these functions build. */
function makeElement (tag = 'div') {
  const node = {
    tagName: String(tag).toUpperCase(),
    className: '',
    title: '',
    text: '',
    children: [],
    appendChild (child) {
      node.children.push(child)
      return child
    },
    append (...kids) {
      for (const kid of kids) node.children.push(kid)
    },
    get textContent () {
      return node.text + node.children.map(child => child.textContent).join('')
    },
    set textContent (value) {
      node.text = String(value)
      node.children = []
    },
    /** Every descendant's text, flattened — the dialog body as a reader sees it. */
    allText () {
      const parts = [node.text]
      for (const child of node.children) parts.push(child.allText())
      return parts.join('')
    },
  }
  return node
}

const documentDouble = { createElement: (tag) => makeElement(tag) }

/**
 * The shipped Chinese dictionary, evaluated rather than parsed.
 *
 * It is a JS object literal with comments, so it is not JSON — the same lift
 * `locale-register-smoke` uses. The `{x}` placeholders are filled by
 * `translate` below, which is deliberately dumb: these assertions compare
 * sentences the dialogs build, not the interpolation engine.
 *
 * @param {string} name - `zh` or `en`.
 * @returns {object} the dictionary.
 */
function dictionaryLiteral (name) {
  const at = source.indexOf(`const ${name} = {`)
  if (at < 0) throw new Error(`client.js does not define ${name}`)
  const open = source.indexOf('{', at)
  return source.slice(open, endOfBlock(source, open))
}

const strings = eval(`(${dictionaryLiteral('zh')})`) // eslint-disable-line no-eval

const translate = (key, params) => {
  const template = strings[key]
  if (template === undefined) throw new Error(`missing dictionary key: ${key}`)
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/gu, (whole, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole)
}

/**
 * One factory for everything that needs the same doubles.
 *
 * @param {object} [options] - overrides for the fetch, picker and dialog.
 * @returns {object} the shipped functions, plus every call they made.
 */
function build (options = {}) {
  const dialogs = []
  const notices = []
  const fetched = []
  const enqueued = []
  const downloads = []
  // Every listing is recorded, including one the caller injected: the paths the
  // counter asks for are the evidence that it walked the tree it promised to.
  const innerFetch = options.fetchJson ?? (async () => ({ entries: [] }))
  const fetchJson = async (url, init) => {
    fetched.push(url)
    return innerFetch(url, init)
  }
  const api = { ls: '/api/dsh-ssh-workspace/ls', deleteEntry: '/api/dsh-ssh-workspace/delete' }
  // The counter calls `fetchJson` and `API`; `requestRowDelete` calls the
  // counter. Everything is injected rather than imported, so the suite observes
  // what the shipped code decided instead of re-deriving it.
  const factory = new Function(
    'document', 'translate', 'fetchJson', 'API', 'openRowActionDialog', 'notifyUser',
    'toastError', 'refreshFilesPanel', 'countDeleteContents', 'pickDirTarget',
    'enqueueDownloadsInto', 'downloadTreeRow',
    `
    ${remoteTargetOfSrc}
    ${entryNameOfSrc}
    ${resolveTargetsSrc}
    ${counterSrc}
    return { remoteTargetOf, entryNameOf, resolveTargets, listRemoteForCount, countDeleteContents }
    `,
  )
  const lifted = factory(
    documentDouble, translate, fetchJson, api,
    (dialog) => {
      dialogs.push(dialog)
      // The confirmation refines its title once the walk ends, so the double
      // has to accept that call rather than only record the opening sentence.
      return { close () {}, setTitle (text) { dialog.title = text } }
    },
    (input, kind) => { notices.push({ input, kind }) },
    (text, detail, code) => ({ text, detail, code }),
    () => {},
    // Placeholder: replaced below with the real one, after it is lifted.
    null,
    options.pickDirTarget ?? (async () => ({ kind: 'canceled' })),
    (items, folder, opening) => { enqueued.push({ items, folder, opening }); return [] },
    async (absPath, isDir) => { downloads.push({ absPath, isDir }) },
  )
  // Second pass: lift the confirmation and the download gestures with the real
  // counter in scope, so a wrong count fails the dialog assertions too.
  const gestures = new Function(
    'document', 'translate', 'fetchJson', 'API', 'openRowActionDialog', 'notifyUser',
    'toastError', 'refreshFilesPanel', 'countDeleteContents', 'pickDirTarget',
    'enqueueDownloadsInto', 'downloadTreeRow', 'remoteTargetOf', 'entryNameOf',
    'DELETE_COUNT_LIMIT',
    `
    ${requestRowDeleteSrc}
    ${requestBatchDownloadSrc}
    ${downloadRowsSrc}
    return { requestRowDelete, requestBatchDownload, downloadRows }
    `,
  )(
    documentDouble, translate, fetchJson, api,
    (dialog) => {
      dialogs.push(dialog)
      // The confirmation refines its title once the walk ends, so the double
      // has to accept that call rather than only record the opening sentence.
      return { close () {}, setTitle (text) { dialog.title = text } }
    },
    (input, kind) => { notices.push({ input, kind }) },
    (text, detail, code) => ({ text, detail, code }),
    () => {},
    lifted.countDeleteContents,
    options.pickDirTarget ?? (async () => ({ kind: 'canceled' })),
    (items, folder, opening) => { enqueued.push({ items, folder, opening }); return [] },
    async (absPath, isDir) => { downloads.push({ absPath, isDir }) },
    lifted.remoteTargetOf,
    lifted.entryNameOf,
    Number(/const DELETE_COUNT_LIMIT = (\d+)/u.exec(source)[1]),
  )
  return { ...lifted, ...gestures, dialogs, notices, fetched, enqueued, downloads }
}

// ---- resolveTargets: the whole matrix --------------------------------------

console.log('\n[resolveTargets]')

const row = (name, isDir = false) => ({ path: `ssh://h/${name}`, name, isDir })
const clicked = row('clicked.txt')
const other = row('a.txt')
const third = row('b.txt')

const MATRIX = [
  {
    label: 'nothing selected',
    selection: [],
    expectPaths: ['ssh://h/clicked.txt'],
    collapsed: false,
  },
  {
    label: 'only the clicked row selected',
    selection: [clicked],
    expectPaths: ['ssh://h/clicked.txt'],
    collapsed: false,
  },
  {
    label: 'clicked row inside a three-row selection',
    selection: [other, clicked, third],
    expectPaths: ['ssh://h/a.txt', 'ssh://h/clicked.txt', 'ssh://h/b.txt'],
    collapsed: false,
  },
  {
    label: 'clicked row OUTSIDE a two-row selection',
    selection: [other, third],
    expectPaths: ['ssh://h/clicked.txt'],
    collapsed: true,
  },
]

for (const action of ['delete', 'download']) {
  for (const entry of MATRIX) {
    // Both verbs read the SAME resolved array; the action name takes no part in
    // the decision, so running the matrix under both names proves neither verb
    // grew a private rule of its own.
    const { resolveTargets } = build()
    const resolved = resolveTargets(clicked, entry.selection)
    check(`${action}: ${entry.label} → ${entry.expectPaths.length} target(s)`,
      resolved.targets.map(item => item.path).join('|') === entry.expectPaths.join('|'),
      JSON.stringify(resolved.targets.map(item => item.path)))
    check(`${action}: ${entry.label} → selection painted as the targets`,
      resolved.selection.map(item => item.path).join('|') === entry.expectPaths.join('|'),
      JSON.stringify(resolved.selection.map(item => item.path)))
    check(`${action}: ${entry.label} → collapsed=${entry.collapsed}`,
      resolved.collapsed === entry.collapsed, String(resolved.collapsed))
  }
}

{
  const { resolveTargets } = build()
  const empty = resolveTargets(null, [other])
  check('a missing clicked row resolves to nothing at all',
    empty.targets.length === 0 && empty.selection.length === 0, JSON.stringify(empty))
  const garbage = resolveTargets(clicked, [null, { path: '' }, { path: 42 }, other])
  check('junk entries are dropped instead of counted',
    garbage.targets.map(item => item.path).join('|') === 'ssh://h/clicked.txt', JSON.stringify(garbage.targets))
  const single = resolveTargets(clicked, [clicked])
  check('a one-row selection is NOT a batch and needs no collapse',
    single.targets.length === 1 && single.collapsed === false, JSON.stringify(single.collapsed))
}

// ---- countDeleteContents ---------------------------------------------------

console.log('\n[countDeleteContents]')

/** A fake listing route keyed by the `path` query parameter. */
function listingRoutes (routes) {
  return async (url) => {
    const asked = new URL(url, 'http://x').searchParams.get('path')
    const entries = routes[asked]
    if (entries === 'FAIL') throw new Error('permission denied')
    return { entries: entries ?? [] }
  }
}

{
  const api = build({
    fetchJson: listingRoutes({
      '/home/u/proj': [
        { name: 'a.txt', type: 'file' },
        { name: 'b.txt', type: 'file' },
        { name: 'c.txt', type: 'file' },
        { name: 'd.txt', type: 'file' },
        { name: 'e.txt', type: 'file' },
      ],
    }),
  })
  const counts = await api.countDeleteContents([{ path: 'ssh://h/home/u/proj', name: 'proj', isDir: true }])
  check('one directory with five files counts as 1 directory and 5 files',
    counts.files === 5 && counts.dirs === 1 && !counts.truncated && !counts.localUnknown && !counts.failed,
    JSON.stringify(counts))
}

{
  const api = build({
    fetchJson: listingRoutes({
      '/srv/tree': [
        { name: 'sub', type: 'directory' },
        { name: 'top.txt', type: 'file' },
      ],
      '/srv/tree/sub': [
        { name: 'deep.txt', type: 'file' },
      ],
    }),
  })
  const counts = await api.countDeleteContents([{ path: 'ssh://h/srv/tree', isDir: true }])
  check('a nested directory is entered, not counted as one opaque row',
    counts.dirs === 2 && counts.files === 2, JSON.stringify(counts))
}

{
  // A directory AT the filesystem root has no trailing segment to append to: a
  // naive `${parent}/${name}` would ask the host for `//sub`, which is a
  // different path to most SFTP servers and an error to some.
  const api = build({
    fetchJson: listingRoutes({
      '/': [{ name: 'sub', type: 'directory' }],
      '/sub': [{ name: 'inside.txt', type: 'file' }],
    }),
  })
  const counts = await api.countDeleteContents([{ path: 'ssh://h/', isDir: true }])
  check('a child of the filesystem root is joined without a doubled slash',
    api.fetched.some(url => new URL(url, 'http://x').searchParams.get('path') === '/sub') &&
      counts.files === 1, api.fetched.join(' '))
}

{
  const api = build({
    fetchJson: listingRoutes({
      '/srv/root': [{ name: 'sub', type: 'directory' }],
      '/srv/root/sub': [{ name: 'inside.txt', type: 'file' }],
    }),
  })
  const counts = await api.countDeleteContents([{ path: 'ssh://h/srv/root', isDir: true }])
  check('the child path is the parent plus one segment',
    api.fetched.some(url => url.includes(encodeURIComponent('/srv/root/sub'))) &&
      counts.files === 1, api.fetched.join(' '))
}

{
  // The cap is the promise that one confirmation stays fast. Past it the count
  // is a floor, and `truncated` is what makes the dialog say "200+".
  const many = Array.from({ length: 400 }, (_, index) => ({ name: `f${index}.txt`, type: 'file' }))
  const api = build({ fetchJson: listingRoutes({ '/srv/big': many }) })
  const counts = await api.countDeleteContents([{ path: 'ssh://h/srv/big', isDir: true }])
  const limit = Number(/const DELETE_COUNT_LIMIT = (\d+)/u.exec(source)[1])
  // The cap bounds what was SCANNED — the children. The selected directory is
  // counted once by the caller and costs no listing, so `files + dirs` is one
  // more than the limit by construction.
  check('a huge directory stops at the announced limit and says it did',
    counts.truncated === true && counts.files === limit &&
      api.fetched.length === 1,
    JSON.stringify({ counts, limit, fetched: api.fetched.length }))
}

{
  const api = build({ fetchJson: listingRoutes({}) })
  const counts = await api.countDeleteContents([{ path: 'C:\\Users\\u\\proj', isDir: true }])
  check('a LOCAL directory is never counted through the SSH listing route',
    counts.localUnknown === true && api.fetched.length === 0, JSON.stringify(counts))
}

{
  const api = build({ fetchJson: listingRoutes({ '/srv/locked': 'FAIL' }) })
  const counts = await api.countDeleteContents([{ path: 'ssh://h/srv/locked', isDir: true }])
  check('a directory that refuses to list still lets the confirmation open',
    counts.failed === true, JSON.stringify(counts))
}

{
  const api = build({
    fetchJson: listingRoutes({
      '/srv/mix': [
        { name: 'link', type: 'symlink' },
        { name: 'real.txt', type: 'file' },
      ],
    }),
  })
  const counts = await api.countDeleteContents([{ path: 'ssh://h/srv/mix', isDir: true }])
  check('a symlink counts as ONE entry and is never entered',
    counts.files === 2 && counts.dirs === 1 && api.fetched.length === 1,
    JSON.stringify({ counts, fetched: api.fetched.length }))
}

{
  const api = build({ fetchJson: listingRoutes({}) })
  const counts = await api.countDeleteContents([
    { path: 'ssh://h/srv/a.txt', isDir: false },
    { path: 'ssh://h/srv/b.txt', isDir: false },
  ])
  check('plain files cost no round trip at all',
    counts.files === 2 && api.fetched.length === 0, JSON.stringify(counts))
}

// ---- the delete confirmation states the scope -----------------------------

console.log('\n[delete confirmation]')

{
  const api = build({ fetchJson: listingRoutes({}) })
  await api.requestRowDelete({ items: [row('one.txt')] })
  const dialog = api.dialogs.at(-1)
  check('one file asks "delete this file?" and never pluralises',
    dialog.title === translate('rowmenu.deleteOneFile') &&
      !dialog.title.includes('项'),
    dialog.title)
  check('...with the file\'s own name in the body',
    dialog.buildBody().allText().includes('one.txt'), dialog.buildBody().allText())
}

{
  const api = build({
    fetchJson: listingRoutes({
      '/srv/proj': [
        { name: 'a.txt', type: 'file' },
        { name: 'b.txt', type: 'file' },
        { name: 'c.txt', type: 'file' },
        { name: 'd.txt', type: 'file' },
        { name: 'e.txt', type: 'file' },
      ],
    }),
  })
  await api.requestRowDelete({ items: [{ path: 'ssh://h/srv/proj', name: 'proj', isDir: true }] })
  const dialog = api.dialogs.at(-1)
  check('one directory names how much is under it',
    dialog.title === translate('rowmenu.deleteOneDir', { count: 5 }), dialog.title)
  check('...and its body repeats the directory/file split',
    dialog.buildBody().allText().includes(translate('rowmenu.deleteCounts', { dirs: 1, files: '5' })),
    dialog.buildBody().allText())
}

{
  const api = build({ fetchJson: listingRoutes({}) })
  await api.requestRowDelete({ items: [{ path: 'ssh://h/srv/empty', name: 'empty', isDir: true }] })
  const dialog = api.dialogs.at(-1)
  check('an empty directory is not described as holding zero files',
    dialog.title === translate('rowmenu.deleteOneEmptyDir'), dialog.title)
}

{
  const many = Array.from({ length: 300 }, (_, index) => ({ name: `f${index}.txt`, type: 'file' }))
  const api = build({ fetchJson: listingRoutes({ '/srv/big': many }) })
  await api.requestRowDelete({ items: [{ path: 'ssh://h/srv/big', name: 'big', isDir: true }] })
  const dialog = api.dialogs.at(-1)
  check('a count past the cap reads as "200+", never as a precise number',
    dialog.title === translate('rowmenu.deleteOneDir', { count: '200+' }), dialog.title)
  check('...and the body admits the total is a floor',
    dialog.buildBody().allText().includes(translate('rowmenu.deleteCountTruncated', { limit: 200 })),
    dialog.buildBody().allText())
}

{
  // Three targets that the selection named: ONE directory (2 files inside) and
  // 2 plain files. The title counts the SELECTION; the body counts the
  // contents — so 1 directory and 4 files, not 2 directories.
  const api = build({
    fetchJson: listingRoutes({
      '/srv/proj': [
        { name: 'a.txt', type: 'file' },
        { name: 'b.txt', type: 'file' },
      ],
    }),
  })
  await api.requestRowDelete({
    items: [
      { path: 'ssh://h/srv/proj', name: 'proj', isDir: true },
      row('x.txt'),
      row('y.txt'),
    ],
  })
  const dialog = api.dialogs.at(-1)
  check('three targets ask "delete 3 entries?"',
    dialog.title === translate('rowmenu.deleteMany', { count: 3 }), dialog.title)
  check('...and the body states 2 directories and 4 files',
    dialog.buildBody().allText().includes(translate('rowmenu.deleteCounts', { dirs: 1, files: '4' })),
    dialog.buildBody().allText())
  check('...and lists the entries it was given, e.g. "proj"',
    dialog.buildBody().allText().includes('proj'), dialog.buildBody().allText())
}

{
  const api = build({ fetchJson: listingRoutes({}) })
  await api.requestRowDelete({ items: [{ path: 'C:\\u\\proj', name: 'proj', isDir: true }] })
  const dialog = api.dialogs.at(-1)
  check('a local directory declines to guess its size',
    dialog.title === translate('rowmenu.deleteOneDirAll') &&
      dialog.buildBody().allText().includes(translate('rowmenu.deleteCountLocal')),
    `${dialog.title} / ${dialog.buildBody().allText()}`)
}

{
  const api = build({ fetchJson: listingRoutes({}) })
  await api.requestRowDelete({ items: [] })
  check('an empty target list opens no dialog at all', api.dialogs.length === 0, String(api.dialogs.length))
}

{
  // The reason the dialog opens first: counting a deep tree is a queue of /ls
  // round trips (a 27-directory /home tree measured 42s against the real host),
  // so a confirmation that appears only after the last one is a button that
  // looks dead. Hold the walk open and assert the frame the user sees.
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const api = build({
    fetchJson: async () => {
      await gate
      return { entries: [{ name: 'a.txt', type: 'file' }] }
    },
  })
  const pending = api.requestRowDelete({ items: [{ path: 'ssh://h/srv/slow', name: 'slow', isDir: true }] })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const first = api.dialogs.at(-1)
  // A missing dialog must be a reported failure, not a thrown TypeError that
  // hides the two assertions after it.
  const opened = first === undefined ? { title: '<no dialog>', buildBody: () => ({ allText: () => '<no dialog>' }) } : first
  check('the confirmation is on screen BEFORE the walk finishes',
    api.dialogs.length === 1, String(api.dialogs.length))
  check('...opening with the sentence the selection alone can answer',
    opened.title === translate('rowmenu.deleteOneDirAll'), opened.title)
  check('...and saying that it is still counting',
    opened.buildBody().allText().includes(translate('rowmenu.deleteCountPending')),
    opened.buildBody().allText())
  release()
  await pending
  check('...then the SAME dialog states the count, without reopening',
    api.dialogs.length === 1 && opened.title === translate('rowmenu.deleteOneDir', { count: 1 }), opened.title)
  check('...and its body carries the directory/file split',
    opened.buildBody().allText().includes(translate('rowmenu.deleteCounts', { dirs: 1, files: '1' })),
    opened.buildBody().allText())
}

// ---- the download destination dialog --------------------------------------

console.log('\n[download destination]')

{
  let picked = 0
  const api = build({
    pickDirTarget: async () => { picked += 1; return { kind: 'path', path: '/tmp/out' } },
  })
  const rows = [row('a.txt'), row('b.txt'), row('c.txt')]
  api.requestBatchDownload(rows, 0, {})
  const dialog = api.dialogs.at(-1)
  check('a batch download states the count BEFORE a folder is chosen',
    dialog.buildBody().allText().includes(translate('transfer.downloadTargetSubtitle', { count: 3 })),
    dialog.buildBody().allText())
  check('...and the picker is the dialog\'s own submit, not a pre-step',
    picked === 0 && dialog.onSubmit !== undefined, String(picked))
  await dialog.onSubmit()
  check('...submitting asks the folder picker exactly once', picked === 1, String(picked))
  check('...and one enqueue call carries every row',
    api.enqueued.length === 1 && api.enqueued[0].items.length === 3,
    JSON.stringify(api.enqueued.map(call => call.items.length)))
  check('...with the count repeated in the queue notice',
    api.enqueued[0].opening === translate('transfer.downloadQueued', { count: 3 }),
    api.enqueued[0].opening)
}

{
  const api = build({
    pickDirTarget: async () => ({ kind: 'path', path: '/tmp/out' }),
  })
  api.requestBatchDownload([row('a.txt'), row('b.txt')], 2, {})
  const dialog = api.dialogs.at(-1)
  check('rows that are not remote are counted out loud, not dropped',
    dialog.buildBody().allText().includes(translate('transfer.skippedLocal', { count: 2 })),
    dialog.buildBody().allText())
  await dialog.onSubmit()
  check('...and the queue line repeats both numbers',
    api.enqueued[0].opening === translate('transfer.downloadQueuedSkipped', { count: 2, skipped: 2 }),
    api.enqueued[0].opening)
}

{
  const api = build({ pickDirTarget: async () => ({ kind: 'canceled' }) })
  api.requestBatchDownload([row('a.txt'), row('b.txt')], 0, {})
  const dialog = api.dialogs.at(-1)
  await dialog.onSubmit()
  check('cancelling the folder picker enqueues nothing and says so',
    api.enqueued.length === 0 &&
      api.notices.some(notice => notice.input === translate('transfer.pickCanceled') && notice.kind === 'muted'),
    JSON.stringify(api.notices))
}

// ---- one gesture entry -----------------------------------------------------

console.log('\n[downloadRows]')

{
  const api = build({})
  await api.downloadRows([row('only.txt')], {})
  check('a single remote row keeps the per-file save dialog',
    api.downloads.length === 1 && api.downloads[0].absPath === 'ssh://h/only.txt' && api.dialogs.length === 0,
    JSON.stringify(api.downloads))
}

{
  const api = build({})
  await api.downloadRows([row('a.txt'), row('b.txt')], {})
  check('two rows ask for ONE folder instead of two save dialogs',
    api.downloads.length === 0 && api.dialogs.length === 1, JSON.stringify(api.downloads))
}

{
  const api = build({})
  await api.downloadRows([{ path: 'C:\\u\\local.txt', name: 'local.txt', isDir: false }], {})
  check('an all-local target is refused with the reason, not silently ignored',
    api.notices.some(notice => notice.kind === undefined && String(notice.input?.text ?? '').includes(translate('transfer.notRemote'))) ||
      api.notices.some(notice => String(notice.input).includes(translate('transfer.notRemote'))),
    JSON.stringify(api.notices))
}

{
  const api = build({})
  await api.downloadRows([row('a.txt'), { path: 'C:\\u\\l.txt', isDir: false }], {})
  const dialog = api.dialogs.at(-1)
  check('a mixed selection downloads the remote rows and counts the skipped ones',
    dialog.buildBody().allText().includes(translate('transfer.skippedLocal', { count: 1 })),
    dialog.buildBody().allText())
}

// ---- the menu itself -------------------------------------------------------

console.log('\n[menu wiring]')

const menuSource = functionText('    function openTaskMenu (ctx, absPath, isDir, root, x, y, sessionId, selection) {')
check('the menu resolves its targets through resolveTargets',
  /const resolved = resolveTargets\(clickedRow, selection\?\.items\)/u.test(menuSource) &&
    /const targets = resolved\.targets/u.test(menuSource),
  'the menu decided its own target set')
check('the download label is fixed and count-free',
  /label: translate\('transfer\.download'\),/u.test(menuSource) &&
    !/label: translate\('transfer\.download'[^)]*\{ count/u.test(menuSource),
  'the download label carries a count again')
check('the delete label is fixed and count-free',
  /label: translate\('rowmenu\.delete'\),/u.test(menuSource) &&
    !/label: translate\('rowmenu\.delete'[^)]*\{ count/u.test(menuSource),
  'the delete label carries a count again')
check('the delete action runs over the resolved array, not the clicked row',
  /void requestRowDelete\(\{ items: targets, root, sessionId \}\)/u.test(menuSource),
  'the delete still rebuilds a one-item array from the clicked row')
check('there is no second, selection-sized verb left in the menu',
  !/downloadSelected/u.test(menuSource) && !/batch/u.test(menuSource),
  'a batch-only verb survived the merge')
check('the download item stays on screen for a local row, disabled with a reason',
  /disabled: downloadable\.length === 0,/u.test(menuSource) &&
    /reason: downloadable\.length === 0 \? translate\('transfer\.notRemote'\) : ''/u.test(menuSource),
  'the download item vanishes for local rows instead of explaining itself')
check('...and the reason is withheld from an item that is ENABLED',
  !/^\s*reason: translate\('transfer\.notRemote'\),$/mu.test(menuSource),
  'an enabled remote row still claims it is not on the host')
check('the download action filters to remote rows before asking for a folder',
  /const downloadable = targets\.filter\(item => remoteTargetOf\(item\.path\) !== null\)/u.test(menuSource),
  'a local row would reach the folder picker')
check('the bridge hands the whole selection over and pre-filters nothing',
  /openTaskMenu\(ctx, path, kind === 'directory', treeRootOf\(row\), x, y, undefined, \{ items: selected \}\)/u.test(
    functionText('    function installTreeMenuBridge (ctx) {'),
  ),
  'the bridge still decides between "this row" and "these rows"')
check('the keyboard Delete collapses the selection first, then resolves',
  (() => {
    const body = functionText('    function installTreeMenuBridge (ctx) {')
    const collapseAt = body.indexOf("reduceTree(container, { type: 'point', index, ctrl: false, shift: false, append: false })")
    const resolveAt = body.indexOf('resolveTargets(')
    return collapseAt > 0 && resolveAt > collapseAt &&
      /void requestRowDelete\(\{ items: resolved\.targets, root \}\)/u.test(body)
  })(),
  'the Delete key still removes exactly one row')
check('the old selection-sized locale keys are gone',
  !source.includes("'rowmenu.downloadSelected'") &&
    !source.includes("'transfer.downloadDir'") &&
    !source.includes("'transfer.selected'"),
  'a superseded key survived the merge')
check('the confirmation and destination keys exist in BOTH dictionaries',
  ['transfer.downloadTargetTitle', 'transfer.downloadTargetSubtitle', 'transfer.chooseTarget',
    'transfer.downloadQueued', 'transfer.downloadQueuedSkipped', 'transfer.skippedLocal',
    'rowmenu.deleteOneFile', 'rowmenu.deleteOneEmptyDir', 'rowmenu.deleteOneDir',
    'rowmenu.deleteOneDirAll', 'rowmenu.deleteMany', 'rowmenu.deleteCounts',
    'rowmenu.deleteCountTruncated', 'rowmenu.deleteCountLocal', 'rowmenu.deleteCountFailed',
    'rowmenu.deleteCountPending']
    .every(key => (source.match(new RegExp(`'${key.replace(/\./gu, '\\.')}':`, 'gu')) ?? []).length === 2),
  'a message would render as its namespace path')

console.log(`\n=== ${passed} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('failures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
