/**
 * The caret must land AFTER the chip an insert just created.
 *
 * The reported bug: dragging `package-lock.json` from the Files panel into the
 * composer produced a chip at the end of the draft while the caret stayed at the
 * start — the screenshot shows the blue caret bar LEFT of the chip, so the next
 * character typed went in front of the path instead of after it.
 *
 * The cause is the ORDER of the two focus calls, and the two do different jobs:
 *
 *   editor.focus()  writes the DOM caret from the model selection. It does NOT
 *                   focus the element (verified against the host bundle: the
 *                   body ends in `Al("focus")` plus a deferred callback).
 *   input.focus()   the HTML focus. It PRESERVES a selection that already sits
 *                   inside the element.
 *
 * The old code called them the other way round. Dragging out of the tree blurs
 * the composer, so by the time `input.focus()` ran there was no usable internal
 * selection; the browser dropped the caret at the document start, Lexical's
 * `selectionchange` handler adopted that as a user move, and the following
 * `editor.focus()` faithfully restored the moved caret.
 *
 * Neither call looks wrong in isolation, which is why a grep for `focus(` could
 * never catch this. This suite drives a fake DOM and a fake Lexical that
 * reproduces the overwrite, then asserts where the caret ends up.
 *
 * Run: node tests/caret-after-insert-smoke.mjs
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')

const passes = []
const failures = []
function check (name, condition, detail) {
  if (condition) {
    passes.push(name)
    console.log(`  PASS  ${name}`)
  } else {
    failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== caret after insert smoke ===\n')

const source = readFileSync(path.join(pluginRoot, 'lib/client.js'), 'utf8')

/** Pull one top-level function out of the client source by brace matching. */
function extractFunction (name) {
  const start = source.indexOf(`function ${name} (`)
  if (start < 0) throw new Error(`client.js does not define ${name}()`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces in ${name}()`)
}

const focusSrc = extractFunction('focusSoleComposer')
const soleSrc = extractFunction('soleComposerInput')

// ---------------------------------------------------------------- fake DOM ---

/**
 * A fake Lexical editor reproducing the failure mechanism.
 *
 * `caret` is the position the next typed character would land at. Three
 * behaviours, all taken from the host bundle:
 *
 *  - `editor.focus()` writes the DOM range from the model selection and does
 *    NOT focus the element.
 *  - `input.focus()` is the HTML focus; it keeps a DOM range that is already
 *    inside the element, and otherwise drops the caret at the document start
 *    (offset 0) — the browser behaviour the bug depended on.
 *  - a `selectionchange` handler adopts the DOM caret as the model selection
 *    when the DOM caret moved while the editor was not focused.
 */
function makeEditor ({ modelCaret = 12, caretInside = false, adoptOnDomFocus = true } = {}) {
  const state = { caret: null, inside: false, order: [], model: modelCaret }
  const editor = {
    focus () {
      state.order.push('editor.focus')
      // Writes the DOM range from the model selection.
      state.caret = state.model
      state.inside = true
    },
  }
  const input = {
    __lexicalEditor: editor,
    focus () {
      state.order.push('input.focus')
      if (!state.inside) {
        // No usable internal selection: the caret goes to the document start.
        state.caret = 0
        state.inside = true
        // The browser fires selectionchange; Lexical adopts it.
        if (adoptOnDomFocus) state.model = state.caret
      }
    },
    getBoundingClientRect: () => ({ width: 400, height: 80 }),
  }
  // `caretInside` models "a previous focus left a valid range in the element".
  if (caretInside) {
    state.caret = modelCaret
    state.inside = true
  }
  return { input, state }
}

function makeDocument (inputs, visible = true) {
  const cards = inputs.map((input) => ({
    getBoundingClientRect: () => (visible ? { width: 400, height: 80 } : { width: 0, height: 0 }),
    querySelector: (sel) => (sel === '[data-composer-input]' ? input : null),
  }))
  return { querySelectorAll: () => cards }
}

/** Run the REAL helper against the fakes and report what it did. */
function runFocus (options = {}) {
  const { input, state } = makeEditor(options)
  if (options.withEditor === false) delete input.__lexicalEditor
  const factory = new Function(
    'document',
    'COMPOSER_CARD_SELECTOR',
    `${focusSrc}\n${soleSrc}\nreturn focusSoleComposer()`,
  )
  factory(makeDocument([input], options.visible !== false), '[data-composer-card]')
  return state
}

// ------------------------------------------------------------ registration ---

check('focusSoleComposer is registered in client.js', source.includes('function focusSoleComposer ('))
check(
  'the insert path calls the focus helper',
  /function addPathToTask[\s\S]{0,1500}?focusSoleComposer\(\)/.test(source),
)

console.log('\n[the bug: DOM focus first, caret ends up at the document start]')

{
  // Reproduce the OLD ordering directly, against the same fakes.
  const { input, state } = makeEditor({ modelCaret: 12 })
  input.focus()
  input.__lexicalEditor.focus()
  check('the old ordering leaves the caret at offset 0', state.caret === 0, `caret=${state.caret}`)
  check(
    'the old ordering called focus in the destructive order',
    state.order.join(',') === 'input.focus,editor.focus',
    state.order.join(','),
  )
}

console.log('\n[the fix: model selection first, then the HTML focus]')

{
  // Draft content ends at offset 12; the chip was just appended there. The
  // composer was blurred by the drag, so no valid internal range survives.
  const state = runFocus({ modelCaret: 12 })
  check('the helper reaches the composer', state.order.length > 0)
  check(
    'the caret stays at the insertion point (end of draft), not at 0',
    state.caret === 12,
    `caret=${state.caret}`,
  )
  check(
    'the editor writes the selection before the element is focused',
    state.order.join(',') === 'editor.focus,input.focus',
    state.order.join(','),
  )
  check(
    'the composer also ends up HTML-focused (the box is active)',
    state.order.includes('input.focus'),
  )
}

{
  // The other direction: a valid range already inside the element (the plain
  // pick path). The result must be the same and must not move it.
  const state = runFocus({ modelCaret: 30, caretInside: true })
  check('an existing internal range is preserved', state.caret === 30, `caret=${state.caret}`)
}

console.log('\n[fallbacks]')

{
  // A host without the Lexical handle: at least focus the box.
  const state = runFocus({ withEditor: false })
  check('without a Lexical handle the box is still focused', state.order.join(',') === 'input.focus')
}

{
  const state = runFocus({ visible: false })
  check('a hidden composer is never focused', state.order.length === 0, state.order.join(','))
}

{
  const one = makeEditor({ modelCaret: 5 })
  const two = makeEditor({ modelCaret: 7 })
  const factory = new Function(
    'document',
    'COMPOSER_CARD_SELECTOR',
    `${focusSrc}\n${soleSrc}\nreturn focusSoleComposer()`,
  )
  const bothVisible = {
    querySelectorAll: () => [one.input, two.input].map((input) => ({
      getBoundingClientRect: () => ({ width: 400, height: 80 }),
      querySelector: (sel) => (sel === '[data-composer-input]' ? input : null),
    })),
  }
  factory(bothVisible, '[data-composer-card]')
  check(
    'two visible composers are ambiguous, so neither is focused',
    one.state.order.length === 0 && two.state.order.length === 0,
    `${one.state.order.length}/${two.state.order.length}`,
  )
}

console.log('\n[source contract]')

{
  const body = focusSrc.slice(focusSrc.indexOf('{'))
  const editorAt = body.indexOf('editor.focus()')
  const inputAt = body.indexOf('target.focus(')
  check('the helper consults the Lexical handle', editorAt >= 0)
  check('the helper performs the HTML focus', inputAt >= 0)
  check(
    'the model-selection write precedes the HTML focus',
    editorAt >= 0 && inputAt >= 0 && editorAt < inputAt,
    `editor@${editorAt} input@${inputAt}`,
  )
  check(
    'the HTML focus is unconditional, not an else-branch of the editor call',
    !/if \(typeof editor\?\.focus === 'function'\) \{\s*\n\s*editor\.focus\(\)\s*\n\s*return\b/.test(body),
  )
  check(
    'the code documents why the order matters',
    // The rationale lives in the JSDoc above the function, so look at the
    // source region that precedes it rather than at the extracted body.
    /ORDER IS THE WHOLE CONTRACT/.test(
      source.slice(source.lastIndexOf('/**', source.indexOf('function focusSoleComposer (')), source.indexOf('function focusSoleComposer (')),
    ),
  )
}

console.log(`\n=== ${passes.length} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
