/**
 * The one selection model: the pure reducer and the host-tree bridge.
 *
 * `client.selection.js` decides what a gesture MEANS; the bridge in the bundle
 * decides when a gesture happened (capture listeners, host row decoration,
 * remount survival). The first section drives the reducer as a state machine;
 * the second drives the shipped bridge against a DOM tree shaped like the
 * host's, so both halves of the same contract are pinned together.
 *
 * Run: node tests/selection-smoke.mjs
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { clientPartSource, clientSource, clientRegion } from './support/client-source.mjs'
import { makeTreeDom } from './support/tree-dom.mjs'

let totalPassed = 0
let totalFailures = 0

// ---------------------------------------------------------------------------
// selection-smoke.mjs
// ---------------------------------------------------------------------------
await (async () => {
/**
 * The shared selection reducer, driven as a pure state machine.
 *
 * The rules live in `lib/client/client.selection.js`, a chunk the bundle loads in
 * `apply`. This suite lifts them out of that shipped file and runs them — the
 * same rule `transfer-queue-smoke` follows: a retyped copy would prove nothing
 * about the code the browser actually gets. Reading the chunk rather than the
 * concatenation is deliberate: after the split the bundle keeps only three
 * placeholder bindings, and a splice over those would pass while testing nothing.
 *
 * The gestures this pins are the ones that separate a real multi-select from
 * "click a row": a plain click on a directory navigates, while a Ctrl/Shift
 * click on the SAME row selects without navigating; Shift never moves the
 * anchor; navigation resets the selection.
 *
 * Run: node tests/selection-smoke.mjs
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
// Two readings, for two different questions. The reducer is driven from the chunk
// that ships it; the wiring assertions at the bottom ask "does the tree still USE
// the shared reducer and not a private one", which is a question about the whole
// browser half, so they read the concatenation.
const source = clientSource(pluginRoot)
const selectionSource = clientPartSource(pluginRoot, 'client.selection.js')

let passed = 0
const failures = []
function check (name, condition, detail) {
  if (condition) { passed += 1; console.log(`  PASS  ${name}`) } else {
    failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== selection smoke ===\n')

// The chunk IS the region: it opens with its own doc comment and closes at the
// exports block, so there is nothing left to slice between markers.
const START = '    /**\n     * The ONE selection model'
const END = '    // The pure surface.'

function liftSelection () {
  const start = selectionSource.indexOf(START)
  if (start < 0) throw new Error('client.selection.js no longer holds the selection model')
  const end = selectionSource.indexOf(END, start)
  if (end < 0) throw new Error('client.selection.js no longer separates the model from its exports')
  const body = selectionSource.slice(start, end)
  const factory = new Function(`
    const translate = (key) => key
    ${body}
    return { SELECTION_EMPTY, selectReduce, selectionRange }
  `)
  return factory()
}

let api
try { api = liftSelection() } catch (error) {
  console.log(`  FAIL  the selection reducer could be lifted out of the bundle — ${error.message}`)
  process.exit(1)
}

const rows = [
  { name: 'a-dir', isDir: true },
  { name: 'b.txt', isDir: false },
  { name: 'c.txt', isDir: false },
  { name: 'd-dir', isDir: true },
  { name: 'e.txt', isDir: false },
]
const ids = (state) => state.ids
const { SELECTION_EMPTY, selectReduce } = api

// ---- plain clicks ---------------------------------------------------------
{
  const dir = selectReduce(SELECTION_EMPTY, { type: 'row', rows, index: 0 })
  check('a plain click on a directory navigates', dir.navigate === 0, JSON.stringify(dir))
  check('...and clears the selection', dir.ids.length === 0, JSON.stringify(dir.ids))
  check('...and resets the anchor', dir.anchor === null, String(dir.anchor))

  const file = selectReduce(SELECTION_EMPTY, { type: 'row', rows, index: 1 })
  check('a plain click on a file selects only it', file.ids.length === 1 && file.ids[0] === 'b.txt', JSON.stringify(file.ids))
  check('...and still lets the caller activate it, so a click still opens the file',
    file.navigate === 1, String(file.navigate))
  check('...and sets the anchor to that row', file.anchor === 1, String(file.anchor))

  const fromSelection = selectReduce({ ids: ['b.txt', 'c.txt'], anchor: 1, cursor: 2 }, { type: 'row', rows, index: 4 })
  check('a plain file click clears the other selections', fromSelection.ids.length === 1 && fromSelection.ids[0] === 'e.txt', JSON.stringify(fromSelection.ids))
}

// ---- right-click: select, then show the menu -------------------------------
{
  const alone = selectReduce({ ids: ['a-dir', 'b.txt'], anchor: 0, cursor: 1 }, { type: 'point', rows, index: 4 })
  check('right-clicking OUTSIDE the selection collapses it onto that row',
    alone.ids.join(',') === 'e.txt', JSON.stringify(alone.ids))
  check('...and never activates anything', alone.navigate === null, String(alone.navigate))

  const inside = selectReduce({ ids: ['b.txt', 'c.txt'], anchor: 1, cursor: 2 }, { type: 'point', rows, index: 2 })
  check('right-clicking INSIDE the selection keeps the whole batch',
    inside.ids.join(',') === 'b.txt,c.txt', JSON.stringify(inside.ids))
  check('...so the batch verb in the menu still addresses every picked row',
    inside.navigate === null && inside.cursor === 2, JSON.stringify(inside))

  const ctrlPoint = selectReduce({ ids: ['b.txt'], anchor: 1, cursor: 1 }, { type: 'point', rows, index: 3, ctrl: true })
  check('Ctrl+right-click toggles one row', ctrlPoint.ids.join(',') === 'b.txt,d-dir', JSON.stringify(ctrlPoint.ids))
  check('...and never activates it', ctrlPoint.navigate === null, String(ctrlPoint.navigate))

  const shiftPoint = selectReduce({ ids: ['b.txt'], anchor: 1, cursor: 1 }, { type: 'point', rows, index: 3, shift: true })
  check('Shift+right-click selects the range from the anchor',
    shiftPoint.ids.join(',') === 'b.txt,c.txt,d-dir', JSON.stringify(shiftPoint.ids))
  check('...and does not move the anchor', shiftPoint.anchor === 1, String(shiftPoint.anchor))

  const shiftPointCtrl = selectReduce({ ids: ['a-dir', 'b.txt'], anchor: 1, cursor: 1 }, { type: 'point', rows, index: 4, shift: true, append: true })
  check('Ctrl+Shift+right-click appends the range', shiftPointCtrl.ids.join(',') === 'a-dir,b.txt,c.txt,d-dir,e.txt',
    JSON.stringify(shiftPointCtrl.ids))
}

// ---- Ctrl / Cmd -----------------------------------------------------------
{
  const ctrlDir = selectReduce(SELECTION_EMPTY, { type: 'row', rows, index: 3, ctrl: true })
  check('Ctrl-click on a directory selects it and does NOT navigate', ctrlDir.navigate === null && ctrlDir.ids[0] === 'd-dir', JSON.stringify(ctrlDir))
  check('...and moves the anchor', ctrlDir.anchor === 3, String(ctrlDir.anchor))

  const ctrlFile = selectReduce({ ids: ['b.txt'], anchor: 1, cursor: 1 }, { type: 'row', rows, index: 2, ctrl: true })
  check('Ctrl-click toggles a file on', ctrlFile.ids.includes('c.txt') && ctrlFile.ids.includes('b.txt'), JSON.stringify(ctrlFile.ids))
  const toggledOff = selectReduce(ctrlFile, { type: 'row', rows, index: 2, ctrl: true })
  check('Ctrl-click toggles the same file off', !toggledOff.ids.includes('c.txt'), JSON.stringify(toggledOff.ids))
}

// ---- Shift ----------------------------------------------------------------
{
  const base = selectReduce(SELECTION_EMPTY, { type: 'row', rows, index: 1 })
  const shifted = selectReduce(base, { type: 'row', rows, index: 4, shift: true })
  check('Shift-click selects the inclusive range from the anchor', shifted.ids.join(',') === 'b.txt,c.txt,d-dir,e.txt', JSON.stringify(shifted.ids))
  check('Shift-click does NOT move the anchor', shifted.anchor === 1, String(shifted.anchor))
  check('Shift-click does not navigate', shifted.navigate === null, String(shifted.navigate))

  const shiftDir = selectReduce(base, { type: 'row', rows, index: 3, shift: true })
  check('Shift-click on a directory selects it and does NOT navigate', shiftDir.navigate === null && shiftDir.ids.includes('d-dir'), JSON.stringify(shiftDir))

  const appended = selectReduce({ ids: ['a-dir', 'b.txt'], anchor: 1, cursor: 1 }, { type: 'row', rows, index: 4, shift: true, append: true })
  check('Ctrl+Shift-click appends the range to the existing selection', appended.ids[0] === 'a-dir' && appended.ids.includes('e.txt'), JSON.stringify(appended.ids))
  check('...and still does not move the anchor', appended.anchor === 1, String(appended.anchor))

  const noAnchor = selectReduce(SELECTION_EMPTY, { type: 'row', rows, index: 2, shift: true })
  check('Shift-click with no anchor seeds the anchor at the row it landed on',
    noAnchor.ids.join(',') === 'c.txt' && noAnchor.anchor === 2, JSON.stringify(noAnchor))
  const secondShift = selectReduce(noAnchor, { type: 'row', rows, index: 4, shift: true })
  check('...so a second Shift-click selects the range without any ordinary click',
    secondShift.ids.join(',') === 'c.txt,d-dir,e.txt' && secondShift.anchor === 2,
    JSON.stringify(secondShift))

  const noAnchorPoint = selectReduce(SELECTION_EMPTY, { type: 'point', rows, index: 2, shift: true })
  check('Shift+right-click with no anchor seeds it the same way',
    noAnchorPoint.ids.join(',') === 'c.txt' && noAnchorPoint.anchor === 2,
    JSON.stringify(noAnchorPoint))

  const noAnchorMove = selectReduce(SELECTION_EMPTY, { type: 'move', rows, delta: 1, extend: true })
  check('Shift+ArrowDown with no anchor seeds it at the row it reached',
    noAnchorMove.ids.join(',') === 'a-dir' && noAnchorMove.anchor === 0,
    JSON.stringify(noAnchorMove))
}

// ---- clearing and select-all ----------------------------------------------
{
  const blank = selectReduce({ ids: ['b.txt'], anchor: 1, cursor: 1 }, { type: 'blank' })
  check('a click on empty space clears everything', blank.ids.length === 0 && blank.anchor === null && blank.navigate === null, JSON.stringify(blank))
  const esc = selectReduce({ ids: ['b.txt'], anchor: 1, cursor: 2 }, { type: 'escape' })
  check('Escape clears the selection and the anchor', esc.ids.length === 0 && esc.anchor === null, JSON.stringify(esc))
  check('...but keeps the keyboard cursor where it was', esc.cursor === 2, String(esc.cursor))
  const all = selectReduce(SELECTION_EMPTY, { type: 'selectAll', rows })
  check('Ctrl+A selects every row, directories included', all.ids.length === rows.length && all.ids.includes('a-dir') && all.ids.includes('d-dir'), JSON.stringify(all.ids))
}

// ---- keyboard movement -----------------------------------------------------
{
  const down = selectReduce(SELECTION_EMPTY, { type: 'move', rows, delta: 1 })
  check('ArrowDown selects the first row', down.ids.join(',') === 'a-dir' && down.cursor === 0, JSON.stringify(down))
  const next = selectReduce(down, { type: 'move', rows, delta: 1 })
  check('ArrowDown again selects the next row only', next.ids.join(',') === 'b.txt' && next.anchor === 1, JSON.stringify(next))

  const focusOnly = selectReduce({ ids: ['b.txt'], anchor: 1, cursor: 1 }, { type: 'move', rows, delta: 1, focusOnly: true })
  check('Ctrl+Arrow moves the cursor without changing the selection', focusOnly.cursor === 2 && focusOnly.anchor === 1 && focusOnly.ids.join(',') === 'b.txt', JSON.stringify(focusOnly))

  const extend = selectReduce({ ids: ['b.txt'], anchor: 1, cursor: 1 }, { type: 'move', rows, delta: 1, extend: true })
  check('Shift+Arrow extends the range from the anchor', extend.ids.join(',') === 'b.txt,c.txt' && extend.anchor === 1, JSON.stringify(extend))

  const end = selectReduce({ ids: ['b.txt'], anchor: 1, cursor: 1 }, { type: 'to', rows, end: true, extend: true })
  check('Shift+End extends to the last row', end.ids.includes('e.txt') && end.cursor === 4, JSON.stringify(end))
  const home = selectReduce({ ids: ['e.txt'], anchor: 4, cursor: 4 }, { type: 'to', rows })
  check('Home selects the first row and moves the anchor', home.ids.join(',') === 'a-dir' && home.anchor === 0, JSON.stringify(home))

  const opened = selectReduce({ ids: ['a-dir'], cursor: 0 }, { type: 'open', rows })
  check('Enter asks the caller to open the cursor row', opened.navigate === 0, String(opened.navigate))
  const openedFile = selectReduce({ ids: ['b.txt'], cursor: 1 }, { type: 'open', rows })
  check('...and the caller decides a file does not open a directory', openedFile.navigate === 1, String(openedFile.navigate))
}

// ---- invariants ------------------------------------------------------------
{
  // Shift with no anchor seeds the anchor at the row it lands on, so the NEXT
  // Shift grows a range instead of starting over.
  let state = selectReduce(SELECTION_EMPTY, { type: 'row', rows, index: 1 })
  for (let i = 0; i < 6; i += 1) {
    state = selectReduce(state, { type: 'move', rows, delta: 1, extend: true })
  }
  check('extending past the last row is clamped, not thrown', state.cursor === 4 && state.ids.length === 4, JSON.stringify(state))
  const repeated = selectReduce(state, { type: 'move', rows, delta: 1, extend: true })
  check('a clamped repeat is stable', repeated.cursor === state.cursor && repeated.ids.join(',') === state.ids.join(','), JSON.stringify(repeated))
  check('the reducer never mutates the previous ids array',
    SELECTION_EMPTY.ids.length === 0 && Object.isFrozen(SELECTION_EMPTY.ids), 'the empty constant was mutated')
  const unknown = selectReduce(state, { type: 'nonsense', rows })
  check('an unknown action leaves the selection alone', unknown.ids.join(',') === state.ids.join(','), JSON.stringify(unknown))
}

// ---- source wiring ---------------------------------------------------------
{
  // The host tree is now the ONLY selection surface. The dialog is a pure
  // browser, so these assertions describe one surface — and each also pins
  // that the dialog did not quietly grow a second one.
  const dialog = source.slice(source.indexOf('    function DirectoryBrowser'), source.indexOf('    // =========================================================================\n    // Diagnostic report dialog'))
  check('the host tree resets the selection when the workspace root changes',
    /state\.selection = SELECTION_EMPTY/u.test(source),
    'a stale selection can survive into another workspace root')
  check('the host tree exposes the listbox contract',
    (source.match(/setAttribute\('aria-multiselectable', 'true'\)/gu) ?? []).length >= 1 &&
      (source.match(/setAttribute\('aria-selected', /gu) ?? []).length >= 1 &&
      !/aria-multiselectable|aria-selected/u.test(dialog),
    'the tree lost its accessible selection state, or the dialog grew one')
  check('Space is inert in the tree keyboard handler',
    (source.match(/if \(event\.key === ' '\)/gu) ?? []).length >= 1 &&
      !/if \(event\.key === ' '\)/u.test(dialog),
    'Space still toggles a selection')
  check('the host-tree bridge calls the shared reducer',
    /selectReduce\(state\.selection, /u.test(source) &&
      !/selectReduce\(/u.test(dialog),
    'the tree grew a private selector, or the dialog kept one')
  check('the tree bridge clears the selection on a click in empty space',
    /reduceTree\(container, \{ type: 'blank' \}\)/u.test(source) &&
      !/type: 'blank'/u.test(dialog),
    'the blank gesture is reachable only from the reducer test')
}


  totalPassed += passed
  totalFailures += failures.length
})()

// ---------------------------------------------------------------------------
// tree-select-smoke.mjs
// ---------------------------------------------------------------------------
await (async () => {
/**
 * The host file tree's multi-select bridge, driven against a real DOM shape.
 *
 * The tree in DSH's Files panel belongs to the host. This plugin cannot give it
 * a selection model, so it decorates host rows through classes of its own and
 * acts through document-level capture listeners. That makes "does it work?"
 * a question about DOM behaviour, not about source text — so this suite lifts
 * the SHIPPED bridge out of `lib/client/client.js`, binds it to a DOM double shaped
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
const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
// Two readings for two questions: the reducer is driven from the chunk that ships
// it, the bridge from the bundle that installs it.
const source = clientSource(pluginRoot)
const selectionSource = clientPartSource(pluginRoot, 'client.selection.js')

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
function slice (startMarker, endMarker, label, text = source) {
  const start = text.indexOf(startMarker)
  if (start < 0) throw new Error(`the shipped source no longer marks ${label} (start)`)
  const end = text.indexOf(endMarker, start + startMarker.length)
  if (end < 0) throw new Error(`the shipped source no longer marks ${label} (end)`)
  return text.slice(start, end)
}

/** The bridge's own source region, kept for the assertions about its shape. */
let bridgeSlice = ''

let api
try {
  const reducer = slice('    // ---- selection state machine', '    // The pure surface.', 'the selection state machine', selectionSource)
  // The bridge calls into `client.kernel.js` now (`treeSelectableRows` being the
  // one this suite named when the cut landed), so the region is resolved with its
  // closure rather than sliced thin. The names the factory injects are excluded —
  // they are doubles standing in for the DOM and for services, not for helpers.
  // Whatever the reducer slice already declares wins: the bridge region is
  // resolved with those names excluded, so the two never declare the same
  // `const` twice.
  const reducerNames = new Set()
  for (const m of reducer.matchAll(/^[ \t]*(?:async )?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gmu)) reducerNames.add(m[1])
  const bridge = clientRegion(pluginRoot, {
    start: '    // =========================================================================\n    // Host file tree: Windows-style multi-select',
    end: '    let composerBridgesInstalled = false',
    exclude: [
      'document', 'window', 'Element', 'Node', 'MutationObserver',
      'translate', 'notifyUser', 'remoteTargetOf', 'pickDirTarget', 'enqueueDownloadJobs',
      'React', 'createPortal', 'jsx', 'jsxs', 'Fragment',
      ...reducerNames,
    ],
  })
  if (bridge === '') throw new Error('the shipped source no longer marks the tree selection bridge')
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
function buildTree (dom, entries, root = 'ssh://dev/home/dev/test') {
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
  { kind: 'directory', path: 'ssh://dev/home/u/proj/a-dir' },
  { kind: 'file', path: 'ssh://dev/home/u/proj/b.txt' },
  { kind: 'file', path: 'ssh://dev/home/u/proj/c.txt' },
  { kind: 'directory', path: 'ssh://dev/home/u/proj/d-dir' },
  { kind: 'file', path: 'ssh://dev/home/u/proj/e.txt' },
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
  const tree2 = buildTree(dom, [], 'ssh://dev/home/dev/test')
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
  const tree2 = buildTree(dom, [], 'ssh://dev/home/dev/test')
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
  tree.tree.setAttribute('data-files-root', 'ssh://dev/home/u/other')
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


  totalPassed += passed
  totalFailures += failures.length
})()

console.log(`\n=== ${totalPassed} passed, ${totalFailures} failed ===`)
if (totalFailures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}