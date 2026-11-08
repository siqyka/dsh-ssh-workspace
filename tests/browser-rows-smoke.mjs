/**
 * The browse-only directory dialog must render rows, not `undefined`.
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
 * identifiers to recording stubs, and calls it for a file and a directory.
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

const FileIcon = function FileIcon () {}
const FolderIcon = function FolderIcon () {}

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
  const formatSize = (bytes) => `${bytes} B`
  const handleEntry = (clicked) => { navigated.push(clicked.name) }

  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'jsxs', 'jsx', 'React', 'FolderIcon', 'FileIcon', 'formatSize', 'handleEntry',
    `return (${callbackSource})`,
  )
  const callback = factory(jsxs, jsx, React, FolderIcon, FileIcon, formatSize, handleEntry)
  return { row: callback(entry), navigated }
}

/** Element children only: a row mixes elements with `false` placeholders. */
function partsOf (row) {
  return Array.isArray(row?.props?.children)
    ? row.props.children.filter(child => child !== null && typeof child === 'object')
    : []
}

const alpha = { name: 'alpha.txt', type: 'file', size: 1234 }
const logs = { name: 'logs', type: 'directory', size: 0 }

// ---- a row is an element, not undefined -------------------------------------

const fileRow = renderRow(alpha)
check('a file entry renders an element at all', fileRow.row !== undefined,
  'the listing map returned undefined — the dialog renders an empty list')
check('a file row is static: it is not a control',
  fileRow.row?.type === 'div' && fileRow.row.props.onClick === undefined)
check('the row is keyed by the entry name', fileRow.row?.props.key === 'alpha.txt')
check('a file row has no selection or focus semantics',
  fileRow.row?.props.role === undefined &&
    fileRow.row?.props['aria-selected'] === undefined &&
    fileRow.row?.props.tabIndex === undefined)

// ---- a directory is the only actionable row --------------------------------

const dirRow = renderRow(logs)
check('a directory row is a button', dirRow.row?.type === 'button' && dirRow.row.props.type === 'button')
check('...and is distinguishable from a file row',
  dirRow.row?.props.className.includes('sshwsp-entry-dir') &&
  !fileRow.row.props.className.includes('sshwsp-entry-dir'))
dirRow.row.props.onClick()
check('...whose click asks to enter that directory', dirRow.navigated.join() === 'logs')

// ---- row anatomy -------------------------------------------------------------

const fileParts = partsOf(fileRow.row)
check('a file row is icon, name and size — and nothing else',
  fileParts.length === 3, `${fileParts.length} parts`)
check('the icon span names the file glyph',
  fileParts[0].props.className === 'sshwsp-entry-icon' &&
  fileParts[0].props.children.type === FileIcon)
check('the name span prints the entry name',
  fileParts[1].props.className === 'sshwsp-entry-name' &&
  fileParts[1].props.children === 'alpha.txt')
check('the size span carries the formatted size',
  fileParts[2].props.className === 'sshwsp-entry-meta' &&
  fileParts[2].props.children === '1234 B')

const dirParts = partsOf(dirRow.row)
check('a directory row is icon and name, with no size line',
  dirParts.length === 2, `${dirParts.length} parts`)
check('a directory row names the folder glyph', dirParts[0].props.children.type === FolderIcon)

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
  'jsxs', 'jsx', 'React', 'FolderIcon', 'FileIcon', 'formatSize', 'handleEntry',
  `return (${withoutReturn})`,
)((type, props) => ({ type, props }), (type, props) => ({ type, props }),
  { createElement: () => ({}) }, FolderIcon, FileIcon, String, () => {})
check('without the return the same callback yields undefined',
  stripped(alpha) === undefined && stripped(logs) === undefined,
  'the regression assertion above would not have caught the shipped bug')

console.log(`\n=== ${passed} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('failures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
