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

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
    /onSelect: \(\) => addPathsToTask\(ctx, targets, root\)/u.test(source))
}

console.log(`\n=== ${passed} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
