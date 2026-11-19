/**
 * The directory dialog renders rows, not `undefined`.
 *
 * ## The bug this suite still guards
 *
 * The listing is a `.map((entry) => { … })` with a BLOCK body. Every branch has
 * to `return` its element: with a block body a bare `jsx(…)` evaluates the
 * element, discards it, and `.map` yields an array of `undefined`. The dialog
 * then renders nothing while `entries` is non-empty, `loading` is false and
 * `error` is null, so the "loading", "empty" and "error" branches are all
 * skipped too and the user sees a blank list that reads as a dead connection.
 *
 * ## Why the real callback, not a grep
 *
 * A grep for `jsx('button'` is green on the broken build; the missing token is
 * a six-letter `return` in a long body. So this suite lifts the SHIPPED
 * callback out of `lib/client.js` by brace matching, binds its free
 * identifiers to recording stubs, and calls it for two different entries.
 *
 * ## One kind of row
 *
 * The dialog used to render a file as a static row and a directory as a button.
 * It now asks the server for directories only (`dirs=1`) and renders every row
 * the same way, so the assertions below do not branch on `entry.type`: a file
 * row coming back would be a second kind of row in a dialog whose only question
 * is "which directory am I mounting?".
 *
 * Run: node tests/browser-rows-smoke.mjs
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { endOfBlock } from './support/toast-dom.mjs'

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

console.log('\n=== browser rows smoke ===\n')

// ---- lift the shipped row callback ------------------------------------------

const MAP_MARKER = ': entries?.map((entry) => {'
const mapAt = source.indexOf(MAP_MARKER)
if (mapAt < 0) throw new Error('client.js no longer marks the directory listing map')
const arrowAt = source.indexOf('(entry) => {', mapAt)
if (arrowAt < 0) throw new Error('the listing map is no longer an inline arrow with a block body')
const bodyOpen = source.indexOf('{', arrowAt)
const bodyEnd = endOfBlock(source, bodyOpen)
const callbackSource = source.slice(arrowAt, bodyEnd)
// The map call's own closing parenthesis follows the callback body. If a
// reordering moved the closing paren, the slice stopped somewhere else and the
// assertions below would describe a different function.
if (source[bodyEnd] !== ')') throw new Error('the lifted listing callback does not end where the map call does')

const FolderIcon = function FolderIcon () {}

/**
 * Render one row through the shipped callback with recording stubs.
 *
 * `FileIcon` and `formatSize` are deliberately NOT injected: the dialog no
 * longer renders files or sizes, and a callback that still reached for either
 * would throw here instead of passing a grep.
 *
 * @param {object} entry - listing entry from `/ls`.
 * @returns {{row: object|undefined, navigated: string[]}} the element, and the
 *   directories the row asked to enter.
 */
function renderRow (entry) {
  const navigated = []
  const jsx = (type, props) => ({ type, props })
  const jsxs = jsx
  const React = { createElement: (type, props) => ({ type, props }) }
  const handleEntry = (clicked) => { navigated.push(clicked.name) }

  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'jsxs', 'jsx', 'React', 'FolderIcon', 'handleEntry',
    `return (${callbackSource})`,
  )
  const callback = factory(jsxs, jsx, React, FolderIcon, handleEntry)
  return { row: callback(entry), navigated }
}

/** Element children only: a row mixes elements with `false` placeholders. */
function partsOf (row) {
  return Array.isArray(row?.props?.children)
    ? row.props.children.filter(child => child !== null && typeof child === 'object')
    : []
}

const logs = { name: 'logs', type: 'directory', size: 0 }
// A file cannot reach this callback any more — the server drops it — but a
// listing from an older server, or a filter someone removes, must still render
// a row rather than `undefined`.
const stray = { name: 'alpha.txt', type: 'file', size: 1234 }

// ---- a row is an element, not undefined -------------------------------------

const dirRow = renderRow(logs)
const fileRow = renderRow(stray)
check('a directory entry renders an element at all', dirRow.row !== undefined,
  'the listing map returned undefined — the dialog renders an empty list')
check('...and so does a file entry, should one ever arrive', fileRow.row !== undefined,
  'a non-directory entry maps to undefined, which renders as a blank list')
check('every row is a button control',
  dirRow.row?.type === 'button' && dirRow.row.props.type === 'button' &&
    fileRow.row?.type === 'button' && fileRow.row.props.type === 'button',
  'a row is no longer an actionable control')
check('the row is keyed by the entry name', dirRow.row?.props.key === 'logs')
check('...and carries the directory-row class',
  dirRow.row?.props.className.includes('sshwsp-entry-dir'),
  'the row lost the class that gives it a pointer cursor')
check('a row keeps no selection or focus semantics',
  dirRow.row?.props.role === undefined &&
    dirRow.row?.props['aria-selected'] === undefined &&
    dirRow.row?.props.tabIndex === undefined)

// ---- entering a directory is a double click ---------------------------------

const dirProps = dirRow.row.props
dirProps.onDoubleClick()
check('a double click asks to enter that directory', dirRow.navigated.join() === 'logs')

// The gesture is a DOUBLE click on purpose: a listing the user cannot read
// without leaving it is a listing they navigate blind. React reports a
// keyboard activation as a click with `detail === 0`, so the row still works
// from the keyboard — that is the only click that navigates.
dirProps.onClick({ detail: 1 })
check('a single mouse click does not enter the directory', dirRow.navigated.length === 1,
  'a plain click navigated, so the listing cannot be read without leaving it')
dirProps.onClick({ detail: 0 })
check('...while a keyboard activation still enters it', dirRow.navigated.length === 2,
  'the row is unreachable from the keyboard')

// ---- row anatomy -------------------------------------------------------------

const dirParts = partsOf(dirRow.row)
check('a row is an icon and a name, with no size line',
  dirParts.length === 2, `${dirParts.length} parts`)
check('the icon span names the folder glyph',
  dirParts[0].props.className === 'sshwsp-entry-icon' &&
    dirParts[0].props.children.type === FolderIcon)
check('the name span prints the entry name',
  dirParts[1].props.className === 'sshwsp-entry-name' &&
    dirParts[1].props.children === 'logs')
check('a file entry gets the same two-part row, not a size column',
  partsOf(fileRow.row).length === 2, `${partsOf(fileRow.row).length} parts`)

// ---- both dialogs ask the server for directories only -----------------------

// The client-side filter is the wrong place for this: the cap runs on the
// server, so a listing filtered in the browser announces "2000 of 4213" about
// the three directories it actually shows.
const dirsQueries = source.match(/limit=\$\{BROWSE_LIST_LIMIT\}&dirs=1/gu) ?? []
check('both directory pickers request directories only', dirsQueries.length === 2,
  `${dirsQueries.length} of 2 listings ask for dirs=1`)

// ---- the dialog is browse-only ---------------------------------------------

const dialog = source.slice(source.indexOf('    function DirectoryBrowser'), source.indexOf('    // =========================================================================\n    // Diagnostic report dialog'))
check('the dialog renders no download, upload or queue control',
  !/DownloadIcon|TransferProgressIcon|enqueueUploads|pickFileTarget|TransferQueueInline/u.test(dialog),
  'a transfer control survived in a dialog that is supposed to only browse')
check('the listing exposes no selection contract',
  !/aria-multiselectable|aria-selected|listbox|selectReduce/u.test(dialog),
  'the browse-only listing still advertises a selection model it does not have')

// ---- the harness can see the defect it guards --------------------------------

const withoutReturn = callbackSource.replace(/\breturn\s+jsx\(/gu, 'jsx(')
check('the stripped slice is a different program', withoutReturn !== callbackSource)
const stripped = new Function(
  'jsxs', 'jsx', 'React', 'FolderIcon', 'handleEntry',
  `return (${withoutReturn})`,
)((type, props) => ({ type, props }), (type, props) => ({ type, props }),
  { createElement: () => ({}) }, FolderIcon, () => {})
check('without the return the same callback yields undefined',
  stripped(logs) === undefined && stripped(stray) === undefined,
  'the regression assertion above would not have caught the shipped bug')

console.log(`\n=== ${passed} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('failures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
