/**
 * One composer insertion, four historical defects.
 *
 * Drag a row from the Files tree, drop it at a point, insert exactly one @
 * reference, leave the caret after it:
 *   - tree-drag — the drag payload carries the selection, and the drop calls
 *     the batch inserter once with the recomputed point;
 *   - composer-drop-point — the DOM-boundary -> detect-offset walk (chip = 1,
 *     managed br = 0, one newline between paragraphs);
 *   - insert-once — one drop is one chip even across HMR re-materializations;
 *   - caret-after-insert — the focus order that leaves the caret AFTER the chip.
 *
 * They share the shipped bundle and the fake-node helpers, which is why they
 * now share a file.
 *
 * Run: node tests/composer-insert-smoke.mjs
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { clientSource } from './support/client-source.mjs'

let totalPassed = 0
let totalFailures = 0

// ---------------------------------------------------------------------------
// tree-drag-smoke.mjs
// ---------------------------------------------------------------------------
await (async () => {
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
const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const source = clientSource(pluginRoot)

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
    /run: \(\) => addPathsToTask\(ctx, targets, root\),/u.test(source))
}


  totalPassed += passed
  totalFailures += failures.length
})()

// ---------------------------------------------------------------------------
// composer-drop-point-smoke.mjs
// ---------------------------------------------------------------------------
await (async () => {
/**
 * Drop-point insertion for tree-row drags.
 *
 * The host composer has no public "insert at this pixel" API. It does expose
 * `captureInsertion()` (a detect-coordinate span plus `draftRev`) and the
 * `slash/input-insert-reference` event, which accepts any span that maps into
 * the current draft. This suite therefore pins the two pure pieces that turn a
 * pointer position into that span:
 *
 *   - the DOM-boundary -> detect-offset walk (chip = 1, managed br = 0, one
 *     newline between paragraphs), and
 *   - the one-attempt semantics of `addPathsToTask(... , at)`.
 *
 * It uses fake nodes rather than jsdom: the plugin has no DOM dependency and
 * this suite must run on a bare checkout. The real GUI pass owns the visual
 * caret and the actual browser `caretRangeFromPoint` behavior.
 *
 * Run: node tests/composer-drop-point-smoke.mjs
 */
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

console.log('\n=== composer drop point smoke ===\n')

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

// ---------------------------------------------------------------- fake DOM ---

function makeText (data) {
  return {
    nodeType: 3,
    data,
    parentNode: null,
    previousSibling: null,
    childNodes: [],
    children: [],
  }
}

function makeElement (tagName, attrs = {}, kids = []) {
  const node = {
    nodeType: 1,
    tagName: String(tagName).toUpperCase(),
    attributes: { ...attrs },
    parentNode: null,
    previousSibling: null,
    childNodes: kids,
    children: kids.filter(kid => kid.nodeType === 1),
    style: {},
    hasAttribute (name) { return Object.prototype.hasOwnProperty.call(node.attributes, name) },
    getAttribute (name) { return node.hasAttribute(name) ? node.attributes[name] : null },
    getBoundingClientRect () { return node.rect ?? { left: 0, top: 0, width: 0, height: 0 } },
  }
  for (let index = 0; index < kids.length; index += 1) {
    kids[index].parentNode = node
    kids[index].previousSibling = index === 0 ? null : kids[index - 1]
  }
  return node
}

function makeInput (blocks) {
  return makeElement('div', { 'data-composer-input': 'true' }, blocks)
}

function makeCard (input, selector = '[data-composer-input]') {
  return { querySelector: (value) => (value === selector ? input : null) }
}

function makeRange (startContainer, startOffset) {
  return {
    startContainer,
    startOffset,
    getBoundingClientRect: () => ({ left: 40, top: 20, width: 0, height: 18 }),
  }
}

// ------------------------------------------------------------- pure mapping ---

const mappingNames = [
  'composerTextNode',
  'composerElement',
  'composerHasAttribute',
  'composerChildren',
  'composerContains',
  'composerChipOf',
  'composerRenderedLength',
  'composerChildPrefix',
  'composerLengthBeforeNode',
  'composerLengthBefore',
  'composerBlockOf',
  'composerOffsetOf',
  'caretRangeAt',
  'dropPointFromEvent',
  'dropOffsetFromEvent',
]
const mappingSource = mappingNames.map(functionText).join('\n')

function makeMapping ({ document = null, sole = null } = {}) {
  return new Function(
    'document',
    'soleComposerInput',
    'COMPOSER_INPUT_SELECTOR',
    `${mappingSource}
    return { ${mappingNames.join(', ')}, composerRenderedLength }
    `,
  )(document, sole, '[data-composer-input]')
}

function offsetOf (input, node, offset, clientX = 0) {
  return makeMapping().composerOffsetOf(input, node, offset, clientX)
}

console.log('[single paragraph]')
{
  const text = makeText('abc')
  const block = makeElement('p', {}, [text])
  const input = makeInput([block])
  check('text offset 2 maps to detect offset 2', offsetOf(input, text, 2) === 2, String(offsetOf(input, text, 2)))
  check('text offset 3 maps to the end offset 3', offsetOf(input, text, 3) === 3, String(offsetOf(input, text, 3)))
}

console.log('\n[paragraph gaps are one newline]')
{
  const a = makeText('a')
  const b = makeText('b')
  const input = makeInput([makeElement('p', {}, [a]), makeElement('p', {}, [b])])
  const second = input.childNodes[1]
  check('second paragraph start is after "a" + newline = 2', offsetOf(input, b, 0) === 2, String(offsetOf(input, b, 0)))
  check('second paragraph offset 1 is 3', offsetOf(input, b, 1) === 3, String(offsetOf(input, b, 1)))
  check('the document end is 3', offsetOf(input, second, 1, 0) === 3, String(offsetOf(input, second, 1, 0)))
}

console.log('\n[an empty paragraph contributes no character]')
{
  const a = makeText('a')
  const b = makeText('b')
  const empty = makeElement('p', {}, [makeElement('br', { 'data-lexical-managed-linebreak': 'true' })])
  const input = makeInput([makeElement('p', {}, [a]), empty, makeElement('p', {}, [b])])
  const third = input.childNodes[2]
  check('third paragraph starts at 3, not 4', offsetOf(input, b, 0) === 3, String(offsetOf(input, b, 0)))
  check('...so the whole projection is 4', offsetOf(input, third, 1, 0) === 4, String(offsetOf(input, third, 1, 0)))
  check('the managed br itself maps to the block start', offsetOf(input, empty.childNodes[0], 0) === 2, String(offsetOf(input, empty.childNodes[0], 0)))
}

console.log('\n[chips are atomic]')
{
  const chip = makeElement('span', { 'data-composer-chip': 'file' }, [makeText('a.txt')])
  chip.rect = { left: 10, top: 20, width: 40, height: 18 }
  const text = makeText(' x')
  const block = makeElement('p', {}, [chip, text])
  const input = makeInput([block])
  check('a chip contributes exactly one character', offsetOf(input, chip, 0, 0) === 0, String(offsetOf(input, chip, 0)))
  check('the right half of a chip is after it', offsetOf(input, chip, 0, 31) === 1, String(offsetOf(input, chip, 0, 31)))
  check('the left half of a chip is before it', offsetOf(input, chip, 0, 10) === 0, String(offsetOf(input, chip, 0, 10)))
  check('text after the chip offsets from chip = 1', offsetOf(input, text, 2, 0) === 3, String(offsetOf(input, text, 2, 0)))
  check('the inner chip label is never counted as text', offsetOf(input, chip.childNodes[0], 3, 0) === 0, String(offsetOf(input, chip.childNodes[0], 3)))
}

console.log('\n[linebreaks and nesting]')
{
  const br = makeElement('br')
  const text = makeText('b')
  const block = makeElement('p', {}, [makeText('a'), br, text])
  const input = makeInput([block])
  check('a non-managed br counts as one', offsetOf(input, text, 0) === 2, String(offsetOf(input, text, 0)))
  check('an element boundary after the br counts it', offsetOf(input, block, 2) === 2, String(offsetOf(input, block, 2)))
  check('an element boundary before the br excludes it', offsetOf(input, block, 1) === 1, String(offsetOf(input, block, 1)))

  const span = makeElement('span', {}, [makeText('bc')])
  const nested = makeElement('p', {}, [makeText('a'), span, makeText('d')])
  const nestedInput = makeInput([nested])
  check('nested text is counted by data length', offsetOf(nestedInput, nested.childNodes[2], 0) === 3, String(offsetOf(nestedInput, nested.childNodes[2], 0)))
}

console.log('\n[empty and foreign boundaries]')
{
  const empty = makeElement('p', {}, [makeElement('br', { 'data-lexical-managed-linebreak': 'true' })])
  const input = makeInput([empty])
  check('an empty composer maps to 0', offsetOf(input, empty, 0) === 0, String(offsetOf(input, empty, 0)))
  check('a node outside the input maps to null', offsetOf(input, makeText('x'), 0) === null, String(offsetOf(input, makeText('x'), 0)))
}

console.log('\n[drop event adapter]')
{
  const text = makeText('abc')
  const block = makeElement('p', {}, [text])
  const input = makeInput([block])
  const card = makeCard(input)
  const range = makeRange(text, 2)
  const doc = { caretRangeFromPoint: () => range }
  const mapping = makeMapping({ document: doc, sole: () => input })
  const event = { target: block, clientX: 50, clientY: 20 }
  check('a valid caret maps to an offset', mapping.dropOffsetFromEvent(event, card) === 2, String(mapping.dropOffsetFromEvent(event, card)))
  check('the point also carries the range for the visual caret',
    mapping.dropPointFromEvent(event, card).range === range)

  const outside = makeRange(makeText('x'), 0)
  const outsideDoc = { caretRangeFromPoint: () => outside }
  const outsideMapping = makeMapping({ document: outsideDoc, sole: () => input })
  check('a caret outside the input maps to null',
    outsideMapping.dropOffsetFromEvent(event, card) === null)

  const otherInput = makeInput([makeElement('p', {}, [makeText('abc')])])
  const ambiguous = makeMapping({ document: doc, sole: () => otherInput })
  check('more than one visible composer degrades to null',
    ambiguous.dropOffsetFromEvent(event, card) === null)

  const targetOutside = { target: makeElement('div'), clientX: 50, clientY: 20 }
  check('a drop target outside the input maps to null',
    mapping.dropOffsetFromEvent(targetOutside, card) === null)

  const broken = makeMapping({ document: { caretRangeFromPoint: () => { throw new Error('no layout') } }, sole: () => input })
  check('a browser caret failure maps to null instead of throwing',
    broken.dropOffsetFromEvent(event, card) === null)

  const fallbackDoc = {
    caretPositionFromPoint: () => ({ offsetNode: text, offset: 1 }),
    createRange: () => makeRange(null, 0),
  }
  const fallback = makeMapping({ document: fallbackDoc, sole: () => input })
  // The fake Range needs setStart to be a real fallback implementation.
  fallbackDoc.createRange = () => {
    const rangeObj = makeRange(null, 0)
    rangeObj.setStart = (node, offset) => { rangeObj.startContainer = node; rangeObj.startOffset = offset }
    return rangeObj
  }
  check('caretPositionFromPoint + createRange is supported',
    fallback.dropOffsetFromEvent(event, card) === 1,
    String(fallback.dropOffsetFromEvent(event, card)))

  check('the source uses caretRangeFromPoint, never getSelection',
    source.includes('document.caretRangeFromPoint') &&
    !/dropPointFromEvent[\s\S]{0,800}getSelection/u.test(source))
}

// -------------------------------------------------------- insertion harness ---

function makeHarness (options = {}) {
  const calls = { inserts: [], texts: [], textSpans: [], captures: [], focus: [] }
  let seq = 0
  const target = {
    actions: {
      captureInsertion: () => {
        const span = { draftRev: `r${++seq}`, id: seq }
        calls.captures.push(span)
        return span
      },
      insertText: (text, span) => {
        calls.texts.push(text)
        calls.textSpans.push(span)
        return options.insertText !== false
      },
    },
    actx: {
      bail (_actx, event, payload) {
        if (event !== 'slash/input-insert-reference') throw new Error(`unexpected event ${event}`)
        if (options.bail === false) return false
        if (options.failLabel === payload.reference.label) throw new Error('refused')
        calls.inserts.push({ reference: payload.reference, span: payload.span })
        return true
      },
    },
    sessionId: 's1',
  }
  const fn = new Function(
    'resolveComposerTarget', 'readComposerRoot', 'focusSoleComposer',
    'mentionToken', 'referenceFor', 'normalizeRoot', 'entryNameOf',
    'translate', 'notifyUser', 'toastError',
    `${functionText('addPathsToTask')}
     return addPathsToTask`,
  )(
    (ctx) => (ctx?.none === true ? null : target),
    () => '/work',
    (card) => { calls.focus.push(card) },
    (absPath, _root, isDir) => (String(absPath).includes('bad') ? null : `@${absPath}${isDir ? '/' : ''}`),
    (absPath, mention, isDir) => ({ label: entryNameOf(absPath) + (isDir ? '/' : ''), ref: mention }),
    (root) => root,
    entryNameOf,
    (key) => key,
    () => {},
    (text, detail, code) => ({ text, detail, code }),
  )
  return { addPathsToTask: fn, calls, target }
}

const card = { querySelector: () => null }
const items = [
  { path: '/work/a.txt', isDir: false },
  { path: '/work/dir', isDir: true },
  { path: '/work/b.txt', isDir: false },
]

console.log('\n[at is consumed by the first attempt only]')
{
  const h = makeHarness()
  h.addPathsToTask({}, items, '/work', card, 2)
  check('the first chip gets {start:2,end:2}',
    h.calls.inserts[0].span.start === 2 && h.calls.inserts[0].span.end === 2,
    JSON.stringify(h.calls.inserts[0].span))
  check('later chips use their live capture',
    h.calls.inserts[1].span === h.calls.captures[1] &&
    h.calls.inserts[2].span === h.calls.captures[2])

  const zero = makeHarness()
  zero.addPathsToTask({}, items, '/work', card, 0)
  check('offset 0 is not treated as absent', zero.calls.inserts[0].span.start === 0)

  const skipped = makeHarness()
  skipped.addPathsToTask({}, [{ path: '/work/bad.txt', isDir: false }, items[2]], '/work', card, 2)
  check('an unrepresentable item leaves the point for the next',
    skipped.calls.inserts.length === 1 && skipped.calls.inserts[0].span.start === 2)

  const failed = makeHarness({ failLabel: 'a.txt', insertText: false })
  failed.addPathsToTask({}, items, '/work', card, 2)
  check('a failed first attempt still consumes the point',
    failed.calls.captures.length === 3 &&
    failed.calls.textSpans.length === 1 &&
    failed.calls.textSpans[0].start === 2,
    JSON.stringify(failed.calls.textSpans))
  check('...so the second candidate uses its live capture',
    failed.calls.inserts.length === 2 &&
    failed.calls.inserts[0].span === failed.calls.captures[1] &&
    Object.prototype.hasOwnProperty.call(failed.calls.captures[1], 'start') === false,
    JSON.stringify(failed.calls.inserts.map(call => call.span)))
}

console.log('\n[four-argument calls and fallback reuse]')
{
  const h = makeHarness()
  h.addPathsToTask({}, items, '/work', card)
  check('no point means every span is the captured one',
    h.calls.inserts.length === 3 &&
    h.calls.inserts.every((call, index) => call.span === h.calls.captures[index]))

  const fallback = makeHarness({ bail: false })
  fallback.addPathsToTask({}, items, '/work', card, 2)
  check('the text fallback keeps the rejected chip span',
    fallback.calls.textSpans.length === 3 && fallback.calls.textSpans[0].start === 2,
    JSON.stringify(fallback.calls.textSpans))
  check('...without recapturing after the rejected chip',
    fallback.calls.captures.length === 3,
    `${fallback.calls.captures.length}`)
}

console.log('\n[source wiring]')
{
  const onDrop = source.slice(source.indexOf('      const onDrop = (event) => {'), source.indexOf('      const onDragEnd = (event) => {'))
  const onDragOver = source.slice(source.indexOf('      const onDragOver = (event) => {'), source.indexOf('      const onDrop = (event) => {'))
  const onDragEnd = source.slice(source.indexOf('      const onDragEnd = (event) => {'), source.indexOf('      document.addEventListener(\'dragstart\'', source.indexOf('      const onDragEnd = (event) => {')))
  check('the mapping constants are declared',
    source.includes("const COMPOSER_INPUT_SELECTOR = '[data-composer-input]'") &&
    source.includes("const COMPOSER_CHIP_SELECTOR = '[data-composer-chip]'") &&
    source.includes("const DROP_CARET_ID = 'sshwsp-drop-caret'"))
  check('drop recomputes the point with the event, not a dragover cache',
    /dropOffsetFromEvent\(event, card\)/u.test(onDrop) &&
    /addPathsToTask\(ctx, payload\.items, payload\.root, card, at\)/u.test(onDrop))
  check('dragover paints the caret from the same mapping',
    /dropPointFromEvent\(event, card\)/u.test(onDragOver) && /showDropCaret\(point\)/u.test(onDragOver))
  check('drop and dragend hide the caret',
    /hideDropCaret\(\)/u.test(onDrop) && /hideDropCaret\(\)/u.test(onDragEnd))
  const payloadText = source.slice(source.indexOf('const payload = { v: 1'), source.indexOf('JSON.stringify(payload)'))
  check('the payload still carries no pointer coordinates',
    !/clientX|clientY/u.test(payloadText))
  check('row-menu invocation stayed four-argument',
    /run: \(\) => addPathsToTask\(ctx, targets, root\),/u.test(source))
}


  totalPassed += passed
  totalFailures += failures.length
})()

// ---------------------------------------------------------------------------
// insert-once-smoke.mjs
// ---------------------------------------------------------------------------
await (async () => {
/**
 * One drop must insert exactly one @ reference, even across HMR reloads.
 *
 * The reported bug: dragging one file from the Files panel into the composer
 * produced ~22 identical chips. The plugin's per-materialization install flag
 * cannot see a PREVIOUS materialization's document listeners, and HMR drops the
 * module cache entry (`loadCache.delete`) so `apply` runs again with a fresh
 * closure — stacking one more set of listeners each time.
 *
 * The fix parks the claim set on the global so every materialization shares it,
 * and keyed on the event object so one dispatch can only be consumed once.
 * These checks exercise that contract directly, plus the wiring in the source.
 *
 * Run: node tests/insert-once-smoke.mjs
 */
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

console.log('\n=== insert once smoke ===\n')

const source = clientSource(pluginRoot)

/**
 * Pull one top-level function out of the client source by brace matching.
 * The helpers under test are dependency-free so they run here unchanged.
 */
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

console.log('[shared claim set]')

// Reproduce the closure the bundle builds, against a tiny global stand-in.
const KEY = '__dshSshWorkspaceGestureClaims__'

function makeClosure (scope) {
  const build = new Function('scope', 'WeakSet', `
    const GESTURE_CLAIMS_KEY = '${KEY}'
    const handledGestures = (() => {
      if (typeof WeakSet !== 'function') return null
      const host = typeof scope === 'object' && scope !== null ? scope : null
      if (host === null) return new WeakSet()
      const existing = host[GESTURE_CLAIMS_KEY]
      if (existing instanceof WeakSet) return existing
      const created = new WeakSet()
      try {
        Object.defineProperty(host, GESTURE_CLAIMS_KEY, { value: created, configurable: true, writable: false, enumerable: false })
      } catch { return created }
      return created
    })()
    ${extractFunction('firstClaim')}
    return { firstClaim, handledGestures }
  `)
  return build(scope, WeakSet)
}

{
  const scope = {}
  const a = makeClosure(scope)
  const b = makeClosure(scope)
  check('both closures find one shared WeakSet', a.handledGestures === b.handledGestures)
  check('the set is parked on the global scope', scope[KEY] instanceof WeakSet)

  const event = { type: 'drop' }
  check('the first materialization claims the event', a.firstClaim(event) === true)
  check('a re-materialized listener refuses the same event', b.firstClaim(event) === false)
  check('a different event is still free to claim', b.firstClaim({ type: 'drop' }) === true)
}

console.log('\n[destroyed previous closure]')

{
  // The old materialization's objects are collected; the global must survive it.
  const scope = {}
  {
    const a = makeClosure(scope)
    a.firstClaim({ type: 'x' })
  }
  const b = makeClosure(scope)
  check('a later closure still reuses the parked set', scope[KEY] instanceof WeakSet)
  const reused = b.firstClaim({ type: 'y' })
  check('claiming works after the earlier closure is gone', reused === true)
}

console.log('\n[wiring]')

check('the claim set is parked on a namespaced global key',
  source.includes("const GESTURE_CLAIMS_KEY = '__dshSshWorkspaceGestureClaims__'"))
check('the set is parked on globalThis, not the module closure',
  source.includes('globalThis') && source.includes('Object.defineProperty(scope, GESTURE_CLAIMS_KEY'))
check('every gesture handler consults firstClaim',
  (source.match(/if \(!firstClaim\(event\)\) return/g) ?? []).length >= 4,
  `${(source.match(/if \(!firstClaim\(event\)\) return/g) ?? []).length} guard(s)`)
check('the drop handler claims before touching its payload',
  /const onDrop = \(event\) => \{[\s\S]{0,240}?if \(!firstClaim\(event\)\) return[\s\S]{0,3000}?const payload = dragPayload/.test(source))
check('dragend deliberately does not claim (every instance must clear)',
  !/const onDragEnd = \(event\) => \{\s*\n\s*if \(!firstClaim\(event\)\)/.test(source))

console.log('\n[disposer]')

check('the drag bridge returns a detach function', /function installTreeDragBridge[\s\S]{0,120}?if \(typeof document === 'undefined'\) return \(\) => \{\}/.test(source))
check('the row menu returns a detach function', /function installTreeMenuBridge[\s\S]{0,120}?if \(typeof document === 'undefined'\) return \(\) => \{\}/.test(source))
const dragAdds = (source.match(/document\.addEventListener\('(dragstart|dragenter|dragover|dragleave|drop|dragend)'/g) ?? []).length
const dragRemovals = (source.match(/document\.removeEventListener\('(dragstart|dragenter|dragover|dragleave|drop|dragend)'/g) ?? []).length
check('the drag bridge removes every listener it added',
  dragAdds === 6 && dragRemovals === 6,
  `${dragAdds} add(s), ${dragRemovals} removal(s)`)
check('the row menu removes its listener',
  source.includes("document.removeEventListener('contextmenu', onContextMenu, true)"))
// The teardown is a list, not a shape: every document-level thing `apply` starts
// has to be stopped here or it outlives the materialization. So assert the set
// of stops, in the order they were added, instead of one hard-coded body.
// Anchor on the teardown's own first statement: `return () => {` appears all
// over the bundle, and the first match is a dialog's focus restore.
const teardown = source.match(/return \(\) => \{\s*\n\s*clearTimeout\(transferActionsProbe\)([\s\S]*?)\n      \}/)?.[1] ?? ''
const stops = ('clearTimeout(transferActionsProbe)' + teardown)
  .split('\n').map(line => line.trim()).filter(line => line !== '')
check('apply() returns the disposer',
  stops.join(' | ') === 'clearTimeout(transferActionsProbe) | sessionCatchUp.stop() | detachBridges() | detachTriggerRects() | detachMarks?.()',
  stops.join(' | '))
check('apply() keeps the installed disposer', source.includes('const detachBridges = installComposerBridges(ctx)'))
check('the trigger-rect capture listener is removable',
  /function trackTriggerRects[\s\S]{0,900}?return \(\) => document\.removeEventListener\('mousedown', onMouseDown, true\)/u.test(source))
check('...and apply keeps its detach function',
  source.includes('const detachTriggerRects = trackTriggerRects()') &&
    source.includes('const detachMarks = installRemoteWorkspaceMarks(ctx)'))


  totalPassed += passes.length
  totalFailures += failures.length
})()

// ---------------------------------------------------------------------------
// caret-after-insert-smoke.mjs
// ---------------------------------------------------------------------------
await (async () => {
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

const source = clientSource(pluginRoot)

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
    'COMPOSER_INPUT_SELECTOR',
    `${focusSrc}\n${soleSrc}\nreturn focusSoleComposer()`,
  )
  factory(makeDocument([input], options.visible !== false), '[data-composer-card]', '[data-composer-input]')
  return state
}

// ------------------------------------------------------------ registration ---

check('focusSoleComposer is registered in client.js', source.includes('function focusSoleComposer ('))
check(
  'the insert path calls the focus helper',
  extractFunction('addPathsToTask').includes('focusSoleComposer(card)'),
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
    'COMPOSER_INPUT_SELECTOR',
    `${focusSrc}\n${soleSrc}\nreturn focusSoleComposer()`,
  )
  const bothVisible = {
    querySelectorAll: () => [one.input, two.input].map((input) => ({
      getBoundingClientRect: () => ({ width: 400, height: 80 }),
      querySelector: (sel) => (sel === '[data-composer-input]' ? input : null),
    })),
  }
  factory(bothVisible, '[data-composer-card]', '[data-composer-input]')
  check(
    'two visible composers are ambiguous, so neither is focused',
    one.state.order.length === 0 && two.state.order.length === 0,
    `${one.state.order.length}/${two.state.order.length}`,
  )
}

console.log('\n[named drop card]')

{
  // The drop names the card it landed on, so two visible composers are not
  // ambiguous for that path: the receiving card must still get the caret.
  const { input, state } = makeEditor({ modelCaret: 9 })
  const card = { querySelector: (sel) => (sel === '[data-composer-input]' ? input : null) }
  const factory = new Function(
    'document',
    'COMPOSER_CARD_SELECTOR',
    'COMPOSER_INPUT_SELECTOR',
    'card',
    `${focusSrc}\n${soleSrc}\nreturn focusSoleComposer(card)`,
  )
  factory({
    querySelectorAll: () => [
      { getBoundingClientRect: () => ({ width: 400, height: 80 }), querySelector: (sel) => (sel === '[data-composer-input]' ? input : null) },
      { getBoundingClientRect: () => ({ width: 400, height: 80 }), querySelector: () => null },
    ],
  }, '[data-composer-card]', '[data-composer-input]', card)
  check('a named card is focused even when two are visible', state.order.join(',') === 'editor.focus,input.focus', state.order.join(','))
  check('...and the caret lands on that card insertion point', state.caret === 9, 'caret=' + state.caret)
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


  totalPassed += passes.length
  totalFailures += failures.length
})()

// ---------------------------------------------------------------------------
// marks lifecycle: the observer is owned, not leaked per materialization
// ---------------------------------------------------------------------------
{
  const marksRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const marks = readFileSync(path.join(marksRoot, 'lib', 'client', 'client.marks.js'), 'utf8')
  let markPassed = 0
  const markFailures = []
  const markCheck = (name, ok, detail) => {
    if (ok) { markPassed += 1; console.log(`  PASS  ${name}`) } else {
      markFailures.push(name)
      console.log(`  FAIL  ${name} — ${detail ?? ''}`)
    }
  }
  markCheck('the marks pass keeps one module-level observer',
    /let marksObserver = null/u.test(marks))
  markCheck('...disconnects a previous one before observing again',
    /marksObserver\?\.disconnect\(\)/u.test(marks))
  markCheck('install returns a remover instead of leaking the observer',
    /function installRemoteWorkspaceMarks[\s\S]{0,1400}?return \(\) => \{/u.test(marks) &&
      marks.includes('observer.disconnect()'))
  markCheck('...and the remover is idempotent (a stale remover cannot kill the new observer)',
    /if \(marksObserver !== observer\) return/u.test(marks))
  totalPassed += markPassed
  totalFailures += markFailures.length
}

console.log(`\n=== ${totalPassed} passed, ${totalFailures} failed ===`)
if (totalFailures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}