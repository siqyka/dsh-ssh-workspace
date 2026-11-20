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
 * identifiers to recording stubs, and calls it for both kinds of entry.
 *
 * ## Two kinds of row, one control
 *
 * The picker shows a directory's whole contents: directories are the rows it
 * exists to navigate (a button; double-click enters, keyboard activation
 * enters), and files are context for the directory about to be mounted (a plain
 * div with no handlers — not a disabled button, which would announce itself as
 * something the user ought to be able to operate). This suite pins that
 * split, because "a file row is a button that does nothing" is exactly the kind
 * of half-control that makes a picker feel broken.
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
const FileIcon = function FileIcon () {}

/**
 * Render one row through the shipped callback with recording stubs.
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
    'jsxs', 'jsx', 'React', 'FolderIcon', 'FileIcon', 'handleEntry',
    `return (${callbackSource})`,
  )
  const callback = factory(jsxs, jsx, React, FolderIcon, FileIcon, handleEntry)
  return { row: callback(entry), navigated }
}

/** Element children only: a row mixes elements with `false` placeholders. */
function partsOf (row) {
  return Array.isArray(row?.props?.children)
    ? row.props.children.filter(child => child !== null && typeof child === 'object')
    : []
}

const logs = { name: 'logs', type: 'directory', size: 0 }
const readme = { name: 'README.md', type: 'file', size: 120 }

// ---- both rows are elements, not undefined ----------------------------------

const dirRow = renderRow(logs)
const fileRow = renderRow(readme)
check('a directory entry renders an element at all', dirRow.row !== undefined,
  'the listing map returned undefined — the dialog renders an empty list')
check('...and so does a file entry', fileRow.row !== undefined,
  'a file row is missing — the picker cannot show what the directory contains')

// ---- a directory row is the control ----------------------------------------

check('a directory row is a button control',
  dirRow.row?.type === 'button' && dirRow.row.props.type === 'button',
  'the directory row is no longer an actionable control')
check('...keyed by the entry name', dirRow.row?.props.key === 'logs')
check('...and carrying the directory-row class',
  dirRow.row?.props.className.includes('sshwsp-entry-dir'),
  'the row lost the class that gives it a pointer cursor')
check('...with no selection or focus semantics',
  dirRow.row?.props.role === undefined &&
    dirRow.row?.props['aria-selected'] === undefined &&
    dirRow.row?.props.tabIndex === undefined)

// ---- a file row is inert context -------------------------------------------

check('a file row is NOT a button (nothing it could do)',
  fileRow.row?.type === 'div' && fileRow.row?.props.type === undefined,
  'a file row is a button that does nothing — a half-control the user will try')
check('...with no click handlers at all',
  fileRow.row?.props.onClick === undefined && fileRow.row?.props.onDoubleClick === undefined)
check('...carrying the file-row class',
  fileRow.row?.props.className.includes('sshwsp-entry-file'),
  'the file row has no class of its own')
check('...keyed by the entry name', fileRow.row?.props.key === 'README.md')

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
const fileParts = partsOf(fileRow.row)
check('a directory row is an icon and a name, with no size line',
  dirParts.length === 2, `${dirParts.length} parts`)
check('...the icon being the folder glyph',
  dirParts[0].props.className === 'sshwsp-entry-icon' &&
    dirParts[0].props.children.type === FolderIcon)
check('...and the name span printing the entry name',
  dirParts[1].props.className === 'sshwsp-entry-name' &&
    dirParts[1].props.children === 'logs')
check('a file row has the same anatomy with the file glyph',
  fileParts.length === 2 &&
    fileParts[0].props.className === 'sshwsp-entry-icon' &&
    fileParts[0].props.children.type === FileIcon &&
    fileParts[1].props.className === 'sshwsp-entry-name' &&
    fileParts[1].props.children === 'README.md',
  `${fileParts.length} parts`)

// ---- both dialogs ask for the whole listing ---------------------------------

// `all=1` keeps the one-round-trip path (and its remote-side cap) while also
// returning files, which `dirs=1` filtered out before the cap.
const allQueries = source.match(/limit=\$\{BROWSE_LIST_LIMIT\}&all=1/gu) ?? []
check('both directory pickers request the whole listing', allQueries.length === 2,
  `${allQueries.length} of 2 listings ask for all=1`)
const dirsQueries = source.match(/limit=\$\{BROWSE_LIST_LIMIT\}&dirs=1/gu) ?? []
check('...and neither still asks for directories only', dirsQueries.length === 0,
  `${dirsQueries.length} listing(s) still send dirs=1`)

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
  'jsxs', 'jsx', 'React', 'FolderIcon', 'FileIcon', 'handleEntry',
  `return (${withoutReturn})`,
)((type, props) => ({ type, props }), (type, props) => ({ type, props }),
  { createElement: () => ({}) }, FolderIcon, FileIcon, () => {})
check('without the returns the same callback yields undefined',
  stripped(logs) === undefined && stripped(readme) === undefined,
  'the regression assertion above would not have caught the shipped bug')

console.log(`\n=== ${passed} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('failures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
