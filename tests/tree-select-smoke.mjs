/**
 * The host file tree's multi-select bridge, driven against a real DOM shape.
 *
 * The tree in DSH's Files panel belongs to the host. This plugin cannot give it
 * a selection model, so it decorates host rows through classes of its own and
 * acts through document-level capture listeners. That makes "does it work?"
 * a question about DOM behaviour, not about source text — so this suite lifts
 * the SHIPPED bridge out of `lib/client.js`, binds it to a DOM double shaped
 * like the host's tree (a `[data-files-body]` container holding
 * `li[data-files-entry][data-files-path]` rows with a button inside), and
 * dispatches real click and keydown events through it.
 *
 * The gestures pinned here are the ones the user asked for, and the decisive
 * one is the conflict: a plain click on a directory must REACH the host (which
 * expands it), while a Ctrl or Shift click on that same directory must be
 * swallowed so it only selects. A grep cannot tell those apart; a dispatched
 * event can, because the host handler's call count is observable.
 *
 * Run: node tests/tree-select-smoke.mjs
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeTreeDom } from './support/tree-dom.mjs'
import { endOfBlock } from './support/toast-dom.mjs'

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

console.log('\n=== tree select smoke ===\n')

// ---- lift the shipped pieces ----------------------------------------------
//
// Three contiguous regions, each located by a marker the source itself has to
// carry: the pure reducer, the tree bridge's helpers, and the bridge installer.
// A reordering that breaks a slice throws here instead of producing a suite
// that passes because it tested nothing.
function slice (startMarker, endMarker, label) {
  const start = source.indexOf(startMarker)
  if (start < 0) throw new Error(`client.js no longer marks ${label} (start)`)
  const end = source.indexOf(endMarker, start + startMarker.length)
  if (end < 0) throw new Error(`client.js no longer marks ${label} (end)`)
  return source.slice(start, end)
}

/** The bridge's own source region, kept for the assertions about its shape. */
let bridgeSlice = ''

let api
try {
  const reducer = slice('    // ---- selection state machine', '    // ---- queue state machine', 'the selection state machine')
  const bridge = slice('    // =========================================================================\n    // Host file tree: Windows-style multi-select', '    let composerBridgesInstalled = false', 'the tree selection bridge')
  // Named once: the "no checkbox" assertion must look at THIS region, not at
  // "everything after the banner" — the panel's own checkbox inputs live later
  // in the file and made that slice match its own unrelated code.
  bridgeSlice = bridge

  // The bridge body is a long run of helpers ending with `installTreeSelectionBridge`.
  // Everything it reaches for is injected: the DOM, the reducer, and the few
  // services (a download queue, a toaster, a translator) whose real bodies are
  // irrelevant to a gesture assertion.
  const factory = new Function(
    'document', 'window', 'Element', 'Node', 'MutationObserver',
    'translate', 'notifyUser', 'remoteTargetOf', 'pickDirTarget', 'enqueueDownloadJobs',
    `
    ${reducer}
    const TREE_ROW_SELECTOR = '[data-files-entry][data-files-path]'
    ${bridge}
    return { installTreeSelectionBridge, selectReduce, treeSelectableRows, TREE_SELECTED_CLASS, TREE_CURSOR_CLASS }
    `,
  )
  api = (dom, overrides = {}) => {
    const calls = { downloads: [], notices: [] }
    const built = factory(
      dom.document,
      dom.window,
      Object,
      Object,
      dom.MutationObserver,
      key => overrides[key] ?? key,
      (text, kind) => { calls.notices.push({ text, kind }) },
      overrides.remoteTargetOf ?? ((absPath) => {
        if (typeof absPath !== 'string' || !absPath.startsWith('ssh://')) return null
        const match = /^ssh:\/\/([^/]+)(\/.*)$/u.exec(absPath)
        if (match === null) return null
        return { alias: match[1], remotePath: match[2] }
      }),
      async () => ({ kind: 'unsupported' }),
      (jobs) => { calls.downloads.push(...jobs); return [] },
    )
    return { ...built, calls }
  }
} catch (error) {
  console.log(`  FAIL  the bridge could be lifted out of the bundle — ${error.message}`)
  process.exit(1)
}

// ---- build a tree shaped like the host's ----------------------------------
//
// The shape is copied from `dsh-client-ui-sidebar-files`, not invented: a
// `[data-files-body]` div inside a `[data-files-state="tree"]` carrying
// `data-files-root`, a `ul`, and `li` rows that each hold one `button`.
function buildTree (dom, entries, root = 'ssh://qiyk/home/qiyk/test') {
  const tree = dom.make({ tag: 'div', attrs: { 'data-files-state': 'tree', 'data-files-root': root } })
  const body = dom.make({ tag: 'div', attrs: { 'data-files-body': '' } })
  const list = dom.make({ tag: 'ul' })
  body.appendChild(list)
  tree.appendChild(body)
  dom.document.body.appendChild(tree)
  const rows = []
  for (const entry of entries) {
    const li = dom.make({ tag: 'li', attrs: { 'data-files-entry': entry.kind, 'data-files-path': entry.path } })
    const button = dom.make({ tag: 'button' })
    li.appendChild(button)
    list.appendChild(li)
    rows.push({ li, button, path: entry.path, kind: entry.kind })
  }
  return { tree, body, list, rows }
}

/** Add rows to an existing tree, as the host's async listing would. */
function appendRows (dom, tree, entries) {
  for (const entry of entries) {
    const li = dom.make({ tag: 'li', attrs: { 'data-files-entry': entry.kind, 'data-files-path': entry.path } })
    const button = dom.make({ tag: 'button' })
    li.appendChild(button)
    tree.list.appendChild(li)
    tree.rows.push({ li, button, path: entry.path, kind: entry.kind })
  }
}

/** Which rows currently carry the selected class. */
const selected = (rows) => rows
  .filter(row => row.li.classList.contains('sshwsp-tree-row-selected'))
  .map(row => row.path)

/** Dispatch one click from the pointer at a node, with modifiers. */
function clickOn (dom, node, modifiers = {}) {
  return dom.document.dispatch('click', {
    type: 'click',
    target: node,
    ctrlKey: modifiers.ctrl === true,
    metaKey: false,
    shiftKey: modifiers.shift === true,
  })
}

/** Dispatch one keydown from a focused node. */
function keyOn (dom, node, key, modifiers = {}) {
  dom.document.activeElement = node
  return dom.document.dispatch('keydown', {
    type: 'keydown',
    target: node,
    key,
    ctrlKey: modifiers.ctrl === true,
    metaKey: false,
    shiftKey: modifiers.shift === true,
  })
}

/** Fresh tree + installed bridge, with the host's own click handler counted. */
function setup (entries) {
  const dom = makeTreeDom()
  const built = api(dom)
  const tree = buildTree(dom, entries)
  const detach = built.installTreeSelectionBridge({})
  const hostClicks = []
  for (const row of tree.rows) {
    row.button.addEventListener('click', () => hostClicks.push(row.path))
  }
  dom.raf()
  return { dom, built, tree, detach, hostClicks }
}

const FILE_TREE = [
  { kind: 'directory', path: 'ssh://qiyk/home/u/proj/a-dir' },
  { kind: 'file', path: 'ssh://qiyk/home/u/proj/b.txt' },
  { kind: 'file', path: 'ssh://qiyk/home/u/proj/c.txt' },
  { kind: 'directory', path: 'ssh://qiyk/home/u/proj/d-dir' },
  { kind: 'file', path: 'ssh://qiyk/home/u/proj/e.txt' },
]

// ---- plain clicks ---------------------------------------------------------
{
  const { dom, tree, hostClicks } = setup(FILE_TREE)
  const selectedClass = 'sshwsp-tree-row-selected'

  clickOn(dom, tree.rows[0].button)
  check('a plain click on a directory DOES reach the host (so it expands)',
    hostClicks.length === 1 && hostClicks[0] === FILE_TREE[0].path, JSON.stringify(hostClicks))
  check('...and leaves nothing selected', selected(tree.rows).length === 0, JSON.stringify(selected(tree.rows)))

  clickOn(dom, tree.rows[1].button)
  check('a plain click on a file selects only it',
    tree.rows[1].li.classList.contains(selectedClass) && selected(tree.rows).length === 1,
    JSON.stringify(selected(tree.rows)))
  check('...and STILL opens it, because "click a file to look at it" must keep working',
    hostClicks.length === 2 && hostClicks[1] === FILE_TREE[1].path, JSON.stringify(hostClicks))
}

// ---- Ctrl: selection wins over navigation ---------------------------------
{
  const { dom, tree, built, hostClicks } = setup(FILE_TREE)
  const selectedClass = 'sshwsp-tree-row-selected'

  clickOn(dom, tree.rows[3].button, { ctrl: true })
  check('Ctrl+click on a directory selects it',
    tree.rows[3].li.classList.contains(selectedClass), JSON.stringify(selected(tree.rows)))
  check('...and does NOT reach the host, so the directory is not entered',
    hostClicks.length === 0, JSON.stringify(hostClicks))

  clickOn(dom, tree.rows[4].button, { ctrl: true })
  check('Ctrl+click adds a second row',
    selected(tree.rows).join(',') === `${FILE_TREE[3].path},${FILE_TREE[4].path}`,
    JSON.stringify(selected(tree.rows)))
  check('...still without opening anything', hostClicks.length === 0, JSON.stringify(hostClicks))

  clickOn(dom, tree.rows[4].button, { ctrl: true })
  check('Ctrl+click again toggles that row off',
    selected(tree.rows).join(',') === FILE_TREE[3].path, JSON.stringify(selected(tree.rows)))
  void built
}

// ---- Shift: range from the anchor, never moves it --------------------------
{
  const { dom, tree, hostClicks } = setup(FILE_TREE)

  clickOn(dom, tree.rows[1].button)
  clickOn(dom, tree.rows[4].button, { shift: true })
  check('Shift+click selects the inclusive range from the anchor',
    selected(tree.rows).join(',') === [1, 2, 3, 4].map(index => FILE_TREE[index].path).join(','),
    JSON.stringify(selected(tree.rows)))
  check('...including the directory in the middle of the range',
    tree.rows[3].li.classList.contains('sshwsp-tree-row-selected'))
  // The ANCHOR click was a plain click on a file, which opens it (that is the
  // panel's oldest gesture and it stays). What must NOT happen is the Shift
  // click adding a second host activation.
  check('...and the Shift gesture itself reached no host handler',
    hostClicks.length === 1 && hostClicks[0] === FILE_TREE[1].path, JSON.stringify(hostClicks))

  // Shift does not move the anchor: a second shift-click measures from b.txt.
  clickOn(dom, tree.rows[2].button, { shift: true })
  check('a second Shift+click still measures from the original anchor',
    selected(tree.rows).join(',') === [1, 2].map(index => FILE_TREE[index].path).join(','),
    JSON.stringify(selected(tree.rows)))

  clickOn(dom, tree.rows[3].button, { ctrl: true, shift: true })
  check('Ctrl+Shift+click appends the range to the existing selection',
    selected(tree.rows).join(',') === [1, 2, 3].map(index => FILE_TREE[index].path).join(','),
    JSON.stringify(selected(tree.rows)))
}

// ---- Shift twice: the first Shift seeds the anchor -------------------------
//
// The user asked for "Shift+click, then click" range selection — without an
// ordinary click in between. An ordinary click on a FILE opens the preview, so
// requiring it first made the gesture both slower and destructive. The first
// Shift now seeds the anchor at the row it landed on; the second grows.
{
  const { dom, tree, hostClicks } = setup(FILE_TREE)
  const selectedClass = 'sshwsp-tree-row-selected'

  clickOn(dom, tree.rows[1].button, { shift: true })
  check('the first Shift+click selects the row it landed on',
    selected(tree.rows).join(',') === FILE_TREE[1].path,
    JSON.stringify(selected(tree.rows)))
  check('...without reaching the host, so no file opens', hostClicks.length === 0,
    JSON.stringify(hostClicks))

  clickOn(dom, tree.rows[4].button, { shift: true })
  check('the second Shift+click selects the inclusive range',
    selected(tree.rows).join(',') === [1, 2, 3, 4].map(index => FILE_TREE[index].path).join(','),
    JSON.stringify(selected(tree.rows)))
  check('...and still opens nothing', hostClicks.length === 0, JSON.stringify(hostClicks))
}

// ---- clearing and select-all ----------------------------------------------
{
  const { dom, tree } = setup(FILE_TREE)
  clickOn(dom, tree.rows[1].button)
  clickOn(dom, tree.rows[2].button, { ctrl: true })
  check('two rows are selected before clearing', selected(tree.rows).length === 2)

  keyOn(dom, tree.rows[2].button, 'Escape')
  check('Escape clears the selection', selected(tree.rows).length === 0, JSON.stringify(selected(tree.rows)))

  keyOn(dom, tree.rows[1].button, 'a', { ctrl: true })
  check('Ctrl+A selects every row, directories included',
    selected(tree.rows).length === FILE_TREE.length &&
      selected(tree.rows).includes(FILE_TREE[0].path) &&
      selected(tree.rows).includes(FILE_TREE[3].path),
    JSON.stringify(selected(tree.rows)))

  // Empty space inside the tree body, not a row.
  clickOn(dom, tree.list)
  check('a click on empty space inside the tree clears the selection',
    selected(tree.rows).length === 0, JSON.stringify(selected(tree.rows)))
}

// ---- keyboard -------------------------------------------------------------
{
  const { dom, tree } = setup(FILE_TREE)
  const cursorClass = 'sshwsp-tree-row-cursor'

  keyOn(dom, tree.rows[0].button, 'ArrowDown')
  check('ArrowDown moves the cursor and selects', selected(tree.rows).join(',') === FILE_TREE[0].path,
    JSON.stringify(selected(tree.rows)))
  check('...and paints a cursor row', tree.rows[0].li.classList.contains(cursorClass))

  keyOn(dom, tree.rows[0].button, 'ArrowDown')
  check('ArrowDown again selects the next row only', selected(tree.rows).join(',') === FILE_TREE[1].path,
    JSON.stringify(selected(tree.rows)))

  keyOn(dom, tree.rows[1].button, 'ArrowDown', { ctrl: true })
  check('Ctrl+ArrowDown moves the cursor without changing the selection',
    selected(tree.rows).join(',') === FILE_TREE[1].path && tree.rows[2].li.classList.contains(cursorClass),
    JSON.stringify(selected(tree.rows)))

  keyOn(dom, tree.rows[2].button, 'ArrowDown', { shift: true })
  check('Shift+ArrowDown extends the range from the anchor',
    selected(tree.rows).join(',') === [1, 2, 3].map(index => FILE_TREE[index].path).join(','),
    JSON.stringify(selected(tree.rows)))

  keyOn(dom, tree.rows[3].button, 'Home')
  check('Home selects the first row', selected(tree.rows).join(',') === FILE_TREE[0].path,
    JSON.stringify(selected(tree.rows)))
  keyOn(dom, tree.rows[0].button, 'End')
  check('End selects the last row', selected(tree.rows).join(',') === FILE_TREE[4].path,
    JSON.stringify(selected(tree.rows)))
}

// ---- Space is inert -------------------------------------------------------
{
  const { dom, tree } = setup(FILE_TREE)
  const event = keyOn(dom, tree.rows[1].button, ' ')
  check('Space does not toggle a selection', selected(tree.rows).length === 0,
    JSON.stringify(selected(tree.rows)))
  check('...and is swallowed, so the host does not treat it as a click',
    event.defaultPrevented === true)
}

// ---- Enter opens the cursor row -------------------------------------------
{
  const { dom, tree, hostClicks } = setup(FILE_TREE)
  keyOn(dom, tree.rows[0].button, 'Enter')
  check('Enter opens the row under the keyboard', hostClicks.length === 1 && hostClicks[0] === FILE_TREE[0].path,
    JSON.stringify(hostClicks))
  check('...and that open is not re-read as a new selection click', selected(tree.rows).length === 0,
    JSON.stringify(selected(tree.rows)))
}

// ---- no floating bar over the host's panel --------------------------------
//
// The bar was removed on request: a strip pinned over a pane this plugin does
// not own was one surface too many, and the batch verb moved into the row menu
// (which lives outside this lifted slice, so it is pinned by client-shape-smoke
// instead). What matters HERE is that selecting rows still creates nothing in
// the document — the bridge paints onto host nodes and nothing else.
{
  const { dom, tree } = setup(FILE_TREE)
  const floating = () => dom.document.created.filter(node => String(node.className).includes('sshwsp-tree-batchbar'))
  clickOn(dom, tree.rows[1].button)
  check('selecting a row still creates no floating toolbar', floating().length === 0,
    JSON.stringify(floating().map(node => node.className)))
  clickOn(dom, tree.rows[2].button, { ctrl: true })
  check('...not even for a multi-row selection', floating().length === 0,
    JSON.stringify(floating().map(node => node.className)))
  check('...while the selection itself is intact', selected(tree.rows).length === 2,
    JSON.stringify(selected(tree.rows)))

  // Clearing still works without a bar: Escape is the gesture that replaced it.
  keyOn(dom, tree.rows[2].button, 'Escape')
  check('Escape clears the selection without any bar present', selected(tree.rows).length === 0,
    JSON.stringify(selected(tree.rows)))
}

// ---- rows the host dropped ------------------------------------------------
{
  const { dom, tree } = setup(FILE_TREE)
  clickOn(dom, tree.rows[3].button, { ctrl: true })
  clickOn(dom, tree.rows[4].button, { ctrl: true })
  check('two rows selected before the host re-renders', selected(tree.rows).length === 2)

  // The host collapses a directory: its rows leave the DOM.
  tree.rows[4].li.remove()
  tree.rows[4].li.parentNode = null
  // The host's removal reaches the observer, which schedules the re-sync.
  dom.notifyMutation({ target: tree.list, addedNodes: [] })
  dom.raf()
  dom.raf()
  check('a row the host removed stops being selected',
    !tree.rows[4].li.classList.contains('sshwsp-tree-row-selected'))
  check('...and the surviving selection is intact',
    tree.rows[3].li.classList.contains('sshwsp-tree-row-selected'))
}

// ---- a remounted tab (the host unmounts inactive tab bodies) --------------
//
// Clicking a file opens its preview tab, which makes the Files tab inactive.
// The host renders an inactive tab body as NOTHING — `keepMounted` is opt-in
// and the Files type does not ask for it — so the `[data-files-body]` element
// is destroyed, and a fresh one appears when the user clicks back, with the
// root listing refetched a commit later. The anchor a Shift range extends from
// must survive that; otherwise the gesture works only until the user opens a
// file, which is the first thing they do.
{
  const dom = makeTreeDom()
  const built = api(dom)
  const tree = buildTree(dom, FILE_TREE)
  const detach = built.installTreeSelectionBridge({})
  dom.raf()

  clickOn(dom, tree.rows[1].button)
  check('the anchor row is selected before the host unmounts the tab',
    selected(tree.rows).join(',') === FILE_TREE[1].path, JSON.stringify(selected(tree.rows)))

  // The preview tab took the pane: the body is gone.
  tree.tree.remove()
  // The user clicks back: a new body renders, with no rows yet.
  const tree2 = buildTree(dom, [], 'ssh://qiyk/home/qiyk/test')
  dom.notifyMutation({ target: tree2.list, addedNodes: [] })
  dom.raf()

  // The rows arrive a commit later, and the user clicks BEFORE the scheduled
  // re-sync has run. The reducer must resolve the remembered path itself, not
  // wait for the paint pass to do it.
  appendRows(dom, tree2, FILE_TREE)
  clickOn(dom, tree2.rows[4].button, { shift: true })
  check('Shift after a remount still selects the range from the remembered anchor',
    selected(tree2.rows).join(',') === [1, 2, 3, 4].map(index => FILE_TREE[index].path).join(','),
    JSON.stringify(selected(tree2.rows)))
  dom.notifyMutation({ target: tree2.list, addedNodes: [] })
  dom.raf()
  check('...and the later re-sync leaves the range alone',
    selected(tree2.rows).join(',') === [1, 2, 3, 4].map(index => FILE_TREE[index].path).join(','),
    JSON.stringify(selected(tree2.rows)))
  detach()
}

// A fresh body adopts an EMPTY listing on mount, because the host refetches
// the root. Pruning the selection against that empty listing would discard a
// claim that becomes paintable a moment later, and Shift would lose its anchor
// even though the row is about to come back.
{
  const dom = makeTreeDom()
  const built = api(dom)
  const tree = buildTree(dom, FILE_TREE)
  const detach = built.installTreeSelectionBridge({})
  dom.raf()

  clickOn(dom, tree.rows[1].button)
  tree.tree.remove()
  const tree2 = buildTree(dom, [], 'ssh://qiyk/home/qiyk/test')
  dom.notifyMutation({ target: tree2.list, addedNodes: [] })
  dom.raf()

  appendRows(dom, tree2, FILE_TREE)
  dom.notifyMutation({ target: tree2.list, addedNodes: [] })
  dom.raf()
  check('a selection survives the empty listing between remount and load',
    selected(tree2.rows).join(',') === FILE_TREE[1].path, JSON.stringify(selected(tree2.rows)))
  detach()
}

// ---- a different workspace in the same panel -----------------------------
{
  const { dom, tree } = setup(FILE_TREE)
  clickOn(dom, tree.rows[1].button)
  check('a row is selected', selected(tree.rows).length === 1)
  tree.tree.setAttribute('data-files-root', 'ssh://qiyk/home/u/other')
  dom.notifyMutation({ target: tree.list, addedNodes: [] })
  dom.raf()
  check('switching the panel to another root drops the old selection',
    selected(tree.rows).length === 0, JSON.stringify(selected(tree.rows)))
}

// ---- detach ---------------------------------------------------------------
{
  const { dom, tree, detach } = setup(FILE_TREE)
  detach()
  clickOn(dom, tree.rows[1].button, { ctrl: true })
  check('after detach the bridge no longer responds', selected(tree.rows).length === 0,
    JSON.stringify(selected(tree.rows)))
}

// ---- the same reducer, not a second dialect -------------------------------
{
  check('the bridge calls the SAME selectReduce the other two surfaces use',
    /selectReduce\(state\.selection, \{ \.\.\.action, rows: treeRowModel\(rows\) \}\)/u.test(source),
    'the tree grew a private selection rule')
  check('...and the reducer is the one file-wide definition',
    (source.match(/function selectReduce \(state, action\)/gu) ?? []).length === 1,
    'a second reducer exists')
  check('the host tree is decorated through classes of our own only',
    /const TREE_SELECTED_CLASS = 'sshwsp-tree-row-selected'/u.test(source) &&
      /const TREE_CURSOR_CLASS = 'sshwsp-tree-row-cursor'/u.test(source),
    'the bridge writes a host class name')
  check('no row renders a checkbox',
    !/type: 'checkbox'/u.test(bridgeSlice),
    'a checkbox column came back')
  check('the bridge is installed with the other tree bridges',
    /installTreeDragBridge\(ctx\), installTreeMenuBridge\(ctx\), installTreeSelectionBridge\(ctx\)/u.test(source),
    'the bridge is never installed')
  // The bridge once called `isRemotePath`, a name `client.js` never defines: a
  // bundled browser module cannot import `protocol.js`, so the first gesture
  // through that line threw a ReferenceError. It now calls `remoteTargetOf`.
  check('the bridge calls the path test the bundle actually defines',
    !bridgeSlice.includes('isRemotePath'),
    'the bridge calls a name the bundle never defines, so its gestures throw')
}

// ---- right-click selects before it opens a menu ---------------------------
//
// The menu itself is built outside this lifted slice (it needs the whole
// plugin), so what is pinned HERE is the part that decides the selection: the
// bridge must feed `point` through the same reducer, with the same modifiers,
// before the menu is opened. A right-click that did not select would make
// "download selected" act on a batch the user could not see they had changed.
{
  const { dom, tree, built } = setup(FILE_TREE)

  // Two rows selected via Ctrl, then a right-click on a THIRD row: the
  // selection collapses onto it.
  clickOn(dom, tree.rows[1].button, { ctrl: true })
  clickOn(dom, tree.rows[2].button, { ctrl: true })
  check('two rows selected before the right-click', selected(tree.rows).length === 2,
    JSON.stringify(selected(tree.rows)))

  const container = built.treeSelectableRows === undefined ? null : null
  void container
  // The bridge exposes the reducer; drive the gesture through it directly, in
  // the same shape `openForRow` uses.
  const rows = tree.rows.map(row => ({ name: row.path, isDir: row.kind === 'directory' }))
  const outside = built.selectReduce({ ids: [FILE_TREE[1].path, FILE_TREE[2].path], anchor: 1, cursor: 2 }, {
    type: 'point', rows, index: 4,
  })
  check('right-clicking outside the selection collapses it onto that row',
    outside.ids.join(',') === FILE_TREE[4].path, JSON.stringify(outside.ids))
  check('...and does not activate it', outside.navigate === null, String(outside.navigate))

  const inside = built.selectReduce({ ids: [FILE_TREE[1].path, FILE_TREE[2].path], anchor: 1, cursor: 2 }, {
    type: 'point', rows, index: 2,
  })
  check('right-clicking inside the selection keeps the batch',
    inside.ids.length === 2, JSON.stringify(inside.ids))
}

{
  check('the menu bridge feeds the point gesture through the shared reducer',
    /reduceTree\(container, \{\s*\n\s*type: 'point'/u.test(source),
    'a right-click no longer selects, so a batch verb can act on an unseen selection')
  check('...with the modifier keys the gesture carried',
    /type: 'point',[\s\S]{0,300}ctrl: event\?\.ctrlKey === true \|\| event\?\.metaKey === true/u.test(source),
    'Ctrl+right-click lost its toggle meaning')
  check('...before the menu is opened',
    source.indexOf("type: 'point'") < source.indexOf('openTaskMenu(ctx, path, kind'),
    'the menu reads the selection before the gesture updates it')
  // The guard must be a REAL condition, not a placeholder. `if (false)` passed
  // every assertion above on the first reverse-verification run, because a
  // dead branch still contains the text they look for — the same class of hole
  // as an assertion that greps for a comment.
  const pointGuard = /if \((container !== null)\) \{\s*\n\s*const rows = treeSelectableRows\(container\)/u.exec(source)
  check('...and that gesture is not behind a dead branch',
    pointGuard !== null,
    'the right-click selection sits behind a condition that can never be true')
  check('...so the selection is computed BEFORE the batch verb is derived from it',
    source.indexOf("type: 'point'") < source.indexOf('const selected = container === null ? [] : treeSelectedItems(container)'),
    'the menu derives its batch from a selection the gesture has not updated yet')
}

console.log(`\n=== ${passed} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('failures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
