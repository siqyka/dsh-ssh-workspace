/**
 * The shared selection reducer, driven as a pure state machine.
 *
 * `lib/client.js` is a single browser bundle with no build step, so the rules
 * live in a marked region of the shipped file and this suite slices them out and
 * runs them. That is the same rule `transfer-queue-smoke` follows: a retyped
 * copy would prove nothing about the code the browser actually gets.
 *
 * The gestures this pins are the ones that separate a real multi-select from
 * "click a row": a plain click on a directory navigates, while a Ctrl/Shift
 * click on the SAME row selects without navigating; Shift never moves the
 * anchor; navigation resets the selection.
 *
 * Run: node tests/selection-smoke.mjs
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

console.log('\n=== selection smoke ===\n')

const START = '    // ---- selection state machine'
const END = '    // ---- queue state machine'

function liftSelection () {
  const start = source.indexOf(START)
  if (start < 0) throw new Error('client.js no longer marks the pure selection state machine')
  const end = source.indexOf(END, start)
  if (end < 0) throw new Error('client.js no longer marks the queue state machine boundary')
  const body = source.slice(start, end)
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

console.log(`\n=== ${passed} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('failures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
