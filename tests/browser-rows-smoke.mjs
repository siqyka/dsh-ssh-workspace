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
 * callback out of `lib/client/client.js` by brace matching, binds its free
 * identifiers to recording stubs, and calls it for both kinds of entry.
 *
 * ## One kind of row
 *
 * The picker lists DIRECTORIES: they are the rows it exists to navigate (a
 * button; double-click enters, keyboard activation enters). Files are not
 * rows at all — the request asks the server for directories only (`dirs=1`),
 * so a file entry reaching this callback means the request or the filter
 * regressed. The suite still calls the callback with one to prove it is not
 * rendered as a half-control: this dialog cannot enter a file and offers no
 * download, so a file row would be a button that does nothing.
 *
 * Run: node tests/browser-rows-smoke.mjs
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { endOfBlock } from './support/toast-dom.mjs'
import { clientSource } from './support/client-source.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const source = clientSource(pluginRoot)

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
 * @param {object} entry - listing entry from `/ls`.
 * @returns {{row: object|undefined, navigated: string[]}} the element, and the
 *   directories the row asked to enter.
 */
function renderRow (entry, options = {}) {
  const navigated = []
  const picks = []
  const jsx = (type, props) => ({ type, props })
  const jsxs = jsx
  const React = { createElement: (type, props) => ({ type, props }) }
  const handleEntry = (clicked) => { navigated.push(clicked.name) }
  // The row's closure reads these from the component: the listing it belongs to
  // and the pick made in it. Passed in rather than faked globally, so the row is
  // rendered by the shipped code with exactly the inputs a real render gives it.
  const path = options.path ?? '/home/me'
  const picked = options.picked ?? null
  const setPicked = (value) => { picks.push(value) }
  const childDirectoryPath = (dir, name) => `${String(dir).replace(/\/+$/u, '')}/${name}`

  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'jsxs', 'jsx', 'React', 'FolderIcon', 'handleEntry',
    'path', 'picked', 'setPicked', 'childDirectoryPath',
    `return (${callbackSource})`,
  )
  const callback = factory(jsxs, jsx, React, FolderIcon, handleEntry, path, picked, setPicked, childDirectoryPath)
  return { row: callback(entry), navigated, picks }
}

/** Element children only: a row mixes elements with `false` placeholders. */
function partsOf (row) {
  return Array.isArray(row?.props?.children)
    ? row.props.children.filter(child => child !== null && typeof child === 'object')
    : []
}

const logs = { name: 'logs', type: 'directory', size: 0 }
const readme = { name: 'README.md', type: 'file', size: 120 }

// ---- the row is an element, not undefined -----------------------------------

const dirRow = renderRow(logs)
const fileRow = renderRow(readme)
check('a directory entry renders an element at all', dirRow.row !== undefined,
  'the listing map returned undefined — the dialog renders an empty list')

// ---- a directory row is the control ----------------------------------------

check('a directory row is a button control',
  dirRow.row?.type === 'button' && dirRow.row.props.type === 'button',
  'the directory row is no longer an actionable control')
check('...keyed by the entry name', dirRow.row?.props.key === 'logs')
check('...and carrying the directory-row class',
  dirRow.row?.props.className.includes('sshwsp-entry-dir'),
  'the row lost the class that gives it a pointer cursor')
// One pick, not a selection model: `aria-selected` belongs to listbox/option
// semantics this listing does not have, and `role`/`tabIndex` are not overridden
// on a button. `aria-current` is how the picked row is announced.
check('...with no batch-selection or focus override',
  dirRow.row?.props.role === undefined &&
    dirRow.row?.props['aria-selected'] === undefined &&
    dirRow.row?.props.tabIndex === undefined &&
    dirRow.row?.props['aria-current'] === undefined,
  'an unpicked row claims to be picked, or the row re-declares its own role')

// ---- and a file entry is not rendered as a second kind of row ---------------

// `dirs=1` means a file should never arrive. If one does, the callback still
// answers with the directory row (it does not branch on type any more): the
// alternative — a file row with its own glyph and no handler — is the
// half-control this dialog deliberately does not have.
check('a file entry gets the same directory row, not a file row of its own',
  fileRow.row?.type === 'button' &&
    fileRow.row?.props.className === dirRow.row?.props.className,
  String(fileRow.row?.props?.className))
check('...with no class or glyph for a file row anywhere in the bundle',
  !/sshwsp-entry-file|function FileIcon/u.test(source),
  'a file-row style or glyph survived in a dialog that only lists directories')

// ---- entering a directory is a double click ---------------------------------

const dirProps = dirRow.row.props
dirProps.onDoubleClick()
check('a double click asks to enter that directory', dirRow.navigated.join() === 'logs')

// A single click PICKS the row — it does not enter it. Reading the listing must
// not cost a navigation, and the pick is what "mount this directory" acts on.
dirProps.onClick({ detail: 1 })
check('a single mouse click does not enter the directory', dirRow.navigated.length === 1,
  'a plain click navigated, so the listing cannot be read without leaving it')
check('...it picks that directory as the target instead',
  dirRow.picks.length === 1 && dirRow.picks[0] === '/home/me/logs',
  JSON.stringify(dirRow.picks))

// React reports a keyboard activation as a click with `detail === 0`. It picks
// too — and pressing it again on the picked row enters, which is the keyboard
// path into a directory now that a plain activation no longer navigates.
const keyRow = renderRow(logs)
keyRow.row.props.onClick({ detail: 0 })
check('a keyboard activation on an unpicked row picks it', keyRow.navigated.length === 0 &&
  keyRow.picks.join() === '/home/me/logs',
  'a keyboard user cannot pick, so the pickers would be mouse-only')
const pickedRow = renderRow(logs, { picked: '/home/me/logs' })
pickedRow.row.props.onClick({ detail: 0 })
check('...and a second one on the picked row enters it',
  pickedRow.navigated.join() === 'logs',
  'a keyboard user can pick but never enter')
check('the picked row is painted and announced',
  pickedRow.row.props.className.includes('sshwsp-entry-picked') &&
    pickedRow.row.props['aria-current'] === 'true',
  'the pick has no visible or announced state')

// ---- row anatomy -------------------------------------------------------------

const dirParts = partsOf(dirRow.row)
check('a directory row is an icon and a name, with no size line',
  dirParts.length === 2, `${dirParts.length} parts`)
check('...the icon being the folder glyph',
  dirParts[0].props.className === 'sshwsp-entry-icon' &&
    dirParts[0].props.children.type === FolderIcon)
check('...and the name span printing the entry name',
  dirParts[1].props.className === 'sshwsp-entry-name' &&
    dirParts[1].props.children === 'logs')

// ---- both dialogs ask for directories only ----------------------------------

// `dirs=1` is what makes a directory row the only row: the server filters
// before it applies the cap, so `total` and `truncated` count the rows the
// picker shows. `all=1` was tried and removed — it listed files as context,
// which this dialog can neither enter nor act on.
const dirsQueries = source.match(/limit=\$\{BROWSE_LIST_LIMIT\}&dirs=1/gu) ?? []
check('both directory pickers request directories only', dirsQueries.length === 2,
  `${dirsQueries.length} of 2 listings send dirs=1`)
check('...and neither asks for the whole listing any more',
  !/BROWSE_LIST_LIMIT\}&all=1/u.test(source),
  'a picker still asks for files it cannot use')

// ---- the dialog is browse-only ---------------------------------------------

const dialog = source.slice(source.indexOf('    function DirectoryBrowser'), source.indexOf('    // =========================================================================\n    // Diagnostic report dialog'))
check('the dialog renders no download, upload or queue control',
  !/DownloadIcon|TransferProgressIcon|enqueueUploads|pickFileTarget|TransferQueueInline/u.test(dialog),
  'a transfer control survived in a dialog that is supposed to only browse')
check('the listing exposes no multi-select contract',
  !/aria-multiselectable|aria-selected|listbox|selectReduce/u.test(dialog),
  'the browse-only listing still advertises a selection model it does not have')
check('...while still announcing the one row it will act on',
  /'aria-current': isPicked \? 'true' : undefined/u.test(dialog),
  'the pick is invisible to assistive technology')

// ---- the harness can see the defect it guards --------------------------------

const withoutReturn = callbackSource.replace(/\breturn\s+jsx\(/gu, 'jsx(')
check('the stripped slice is a different program', withoutReturn !== callbackSource)
const stripped = new Function(
  'jsxs', 'jsx', 'React', 'FolderIcon', 'handleEntry',
  'path', 'picked', 'setPicked', 'childDirectoryPath',
  `return (${withoutReturn})`,
)((type, props) => ({ type, props }), (type, props) => ({ type, props }),
  { createElement: () => ({}) }, FolderIcon, () => {}, '/home/me', null, () => {},
  (dir, name) => `${dir}/${name}`)
check('without the return the same callback yields undefined',
  stripped(logs) === undefined,
  'the regression assertion above would not have caught the shipped bug')

console.log(`\n=== ${passed} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('failures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
