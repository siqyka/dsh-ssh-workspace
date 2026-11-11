/**
 * Multi-selection drag into the composer.
 *
 * The drag bridge is host-DOM plumbing; its payload decision is pinned at the
 * source, while the one insertion path (`addPathsToTask`) is run as a real
 * function here. That split is deliberate: a source grep cannot prove the
 * order/count of inserted chips, and a fake DOM cannot prove the host row
 * gesture. The GUI pass owns the latter.
 *
 * Run: node tests/tree-drag-smoke.mjs
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

console.log('\n=== tree drag smoke ===\n')

function functionText (name) {
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

function entryNameOf (absPath) {
  const cut = absPath.replace(/[/\\]+$/, '')
  return cut.slice(Math.max(cut.lastIndexOf('/'), cut.lastIndexOf('\\')) + 1)
}

function makeHarness (options = {}) {
  const calls = { inserts: [], texts: [], textSpans: [], captures: [], notices: [], focus: [] }
  let spanSeq = 0
  const actions = {
    captureInsertion: () => {
      const span = { draftRev: `r${++spanSeq}` }
      calls.captures.push(span)
      return span
    },
    insertText: (text, span) => {
      calls.texts.push(text)
      calls.textSpans.push(span)
      if (options.insertText === false) return false
      if (typeof options.insertFails === 'string' && String(text).includes(options.insertFails)) return false
      return true
    },
  }
  const actx = {
    bail (_actx, event, payload) {
      if (event !== 'slash/input-insert-reference') throw new Error(`unexpected event ${event}`)
      if (options.bail === false) return false
      if (options.insertFails === payload.reference.label) throw new Error('insert refused')
      calls.inserts.push({ reference: payload.reference, span: payload.span })
      return true
    },
  }
  const target = { actions, actx, sessionId: 's1' }
  const addPathsToTask = new Function(
    'resolveComposerTarget', 'readComposerRoot', 'focusSoleComposer',
    'translate', 'notifyUser', 'toastError', 'entryNameOf',
    `
    ${functionText('normalizeRoot')}
    ${functionText('mentionToken')}
    ${functionText('referenceFor')}
    ${functionText('addPathsToTask')}
    return addPathsToTask
    `,
  )(
    (ctx) => (ctx?.none === true ? null : target),
    (ctx, sessionId) => ctx.composerRoot ?? '/work',
    (card) => { calls.focus.push(card) },
    (key, params) => key + (params === undefined ? '' : JSON.stringify(params)),
    (text, kind) => { calls.notices.push({ text, kind }) },
    (text, detail, code) => ({ kind: 'err', text, detail, code }),
    entryNameOf,
  )
  return { addPathsToTask, calls, target }
}

const card = { querySelector: () => null }
const items = [
  { path: '/work/a.txt', isDir: false },
  { path: '/work/dir', isDir: true },
  { path: '/work/b.txt', isDir: false },
]

console.log('[one insertion path, in tree order]')
{
  const h = makeHarness()
  const ok = h.addPathsToTask({}, items, '/work', card)
  check('a multi-item drop inserts every target', ok === true && h.calls.inserts.length === 3, `${h.calls.inserts.length}`)
  check('...in the order the selection supplied', h.calls.inserts.map(call => call.reference.label).join('|') === 'a.txt|dir/|b.txt', h.calls.inserts.map(call => call.reference.label).join('|'))
  check('...and focuses the receiving card exactly once, after all chips',
    h.calls.focus.length === 1 && h.calls.focus[0] === card, `${h.calls.focus.length}`)
  check('...with no partial-failure notice', h.calls.notices.length === 0)
}

console.log('\n[duplicates and failures]')
{
  const h = makeHarness()
  h.addPathsToTask({}, [...items, items[0]], '/work', card)
  check('a duplicated path is inserted once', h.calls.inserts.length === 3, `${h.calls.inserts.length}`)

  const partial = makeHarness()
  partial.addPathsToTask({}, [items[0], { path: '/work/bad"name', isDir: false }, items[2]], '/work', card)
  check('an unrepresentable item does not stop the others',
    partial.calls.inserts.length === 2 && partial.calls.focus.length === 1,
    `${partial.calls.inserts.length}/${partial.calls.focus.length}`)
  check('...and the partial notice names what failed',
    partial.calls.notices.length === 1 && partial.calls.notices[0].text.startsWith('mention.addedPartly'),
    JSON.stringify(partial.calls.notices))

  // A failure in the MIDDLE of the batch: the items after it must still be
  // attempted, which is what separates "skip this one" from "give up".
  const middleFail = makeHarness({ insertFails: 'dir/' })
  const stillRan = middleFail.addPathsToTask({}, items, '/work', card)
  check('a failed insert in the middle does not abandon the rest',
    stillRan === true && middleFail.calls.inserts.length === 2,
    `${middleFail.calls.inserts.length}`)
  check('...and it is reported as a partial batch',
    middleFail.calls.notices.length === 1 &&
      String(middleFail.calls.notices[0].text).includes('{added}') === false,
    JSON.stringify(middleFail.calls.notices))

  const allBad = makeHarness()
  const failed = allBad.addPathsToTask({}, [{ path: '/work/x"y', isDir: false }], '/work', card)
  check('all-unrepresentable is a failure', failed === false)
  check('...reported with the existing unrepresentable sentence',
    allBad.calls.notices.length === 1 && String(allBad.calls.notices[0].text?.text ?? allBad.calls.notices[0].text).startsWith('mention.unrepresentable'),
    JSON.stringify(allBad.calls.notices))
}

console.log('\n[fallbacks]')
{
  const h = makeHarness({ bail: false })
  h.addPathsToTask({}, items, '/work', card)
  check('when no listener claims the reference, plain text is inserted per item',
    h.calls.texts.length === 3 && h.calls.texts.every(text => text.startsWith('@') && text.endsWith(' ')),
    JSON.stringify(h.calls.texts))

  const none = makeHarness()
  none.addPathsToTask({ none: true }, items, '/work', card)
  check('without a composer nothing is inserted', none.calls.inserts.length === 0 && none.calls.notices.length === 1)
}

console.log('\n[the bridge feeds the same helper]')
{
console.log('\n[drop point is consumed once]')
{
  const h = makeHarness()
  h.addPathsToTask({}, items, '/work', card, 2)
  check('the first chip uses the requested point as a collapsed span',
    h.calls.inserts[0].span.start === 2 && h.calls.inserts[0].span.end === 2,
    JSON.stringify(h.calls.inserts[0].span))
  check('later chips use the live capture, not the original point',
    h.calls.inserts[1].span === h.calls.captures[1] &&
    h.calls.inserts[2].span === h.calls.captures[2],
    JSON.stringify(h.calls.inserts.map(call => call.span)))
  check('the point is zero-able, not mistaken for absent',
    (() => {
      const zero = makeHarness()
      zero.addPathsToTask({}, items, '/work', card, 0)
      return zero.calls.inserts[0].span.start === 0
    })())

  const skipped = makeHarness()
  skipped.addPathsToTask({}, [{ path: '/work/bad"name', isDir: false }, items[2]], '/work', card, 2)
  check('an unrepresentable first item leaves the point for the next',
    skipped.calls.inserts.length === 1 && skipped.calls.inserts[0].span.start === 2,
    JSON.stringify(skipped.calls.inserts))
}

console.log('\n[four-argument calls are unchanged]')
{
  const h = makeHarness()
  h.addPathsToTask({}, items, '/work', card)
  check('every span is the captured one when no point is supplied',
    h.calls.inserts.length === 3 &&
    h.calls.inserts.every((call, index) => call.span === h.calls.captures[index]),
    JSON.stringify(h.calls.inserts.map(call => call.span)))
}

console.log('\n[fallback reuses the same span]')
{
  const h = makeHarness({ bail: false })
  h.addPathsToTask({}, items, '/work', card, 2)
  check('the text fallback receives the rejected chip span',
    h.calls.textSpans.length === 3 && h.calls.textSpans[0].start === 2,
    JSON.stringify(h.calls.textSpans))
  check('...and does not re-capture after the rejected chip',
    h.calls.captures.length === 3,
    `${h.calls.captures.length}`)
}

  const start = source.indexOf('      const onDragStart = (event) => {')
  const end = source.indexOf('      const onDragOver = (event) => {', start)
  const dragStart = source.slice(start, end)
  check('a drag resolves the target set through resolveTargets',
    dragStart.includes('resolveTargets(clicked, container === null ? [] : treeSelectedItems(container))'))
  check('...and carries a versioned multi-item payload, not one path',
    dragStart.includes('const payload = { v: 1, items, root: treeRootOf(row) }') &&
    dragStart.includes('JSON.stringify(payload)') &&
    !dragStart.includes('transfer.setData(DRAG_MIME, path)'))
  check('drop calls the batch inserter once, with the card and the recomputed point',
    /const at = dropOffsetFromEvent\(event, card\)\s*\n\s*addPathsToTask\(ctx, payload\.items, payload\.root, card, at\)/u.test(source.slice(source.indexOf('      const onDrop = (event) => {'), source.indexOf('      const onDragEnd = (event) => {'))))
  check('the row menu uses the same target set and inserter without a drop point',
    /onSelect: \(\) => addPathsToTask\(ctx, targets, root\)/u.test(source))
}

console.log(`\n=== ${passed} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
