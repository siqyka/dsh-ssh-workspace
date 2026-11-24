/**
 * Host-tree gestures that are not a plain click: right-click rename and the
 * blank-space menus.
 *
 * Both run against the same fake-tree shape and both lift shipped code out of
 * the bundle. `tree-rename` pins "right-click selects before it opens a menu"
 * and the in-place name rules; `tree-blank-menu` pins which directory owns a
 * blank gesture (local targets only) and which remote panel owns the remote
 * menu (`[data-files-page]`, never the document).
 *
 * Run: node tests/tree-gestures-smoke.mjs
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeTreeDom } from './support/tree-dom.mjs'
import { clientPartSource, clientRegion, clientSource } from './support/client-source.mjs'

let totalPassed = 0
let totalFailures = 0

// ---------------------------------------------------------------------------
// tree-rename-smoke.mjs
// ---------------------------------------------------------------------------
await (async () => {
/**
 * Right-click selection and in-place rename, as shipped code.
 *
 * Two gestures the user asked for by name, and both live in the host file tree
 * — a DOM this plugin does not own. So they are pinned the same way the
 * selection bridge is: the real code is lifted out of `lib/client/client.js` and run
 * against a DOM double shaped like the host's tree.
 *
 * What is being protected:
 *
 *  - A right-click SELECTS before it opens a menu. Right-clicking a row outside
 *    the selection collapses the selection onto it; right-clicking inside the
 *    selection keeps the batch. Without this, "download selected" would act on
 *    a selection the user could not see they had changed.
 *  - Rename happens ON the row. The editor is portaled to `<body>` (React owns
 *    the row's children) but positioned from the row's own name span, so it
 *    looks like an in-place edit and survives every re-render.
 *  - The three outcomes of an inline edit are a pure decision, because they are
 *    the whole contract: unchanged/emptied cancels, an impossible name refuses
 *    and keeps the field open, anything else commits.
 *
 * Run: node tests/tree-rename-smoke.mjs
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

console.log('\n=== tree rename smoke ===\n')

function slice (startMarker, endMarker, label, text = source) {
  const start = text.indexOf(startMarker)
  if (start < 0) throw new Error(`the browser half no longer marks ${label} (start)`)
  const end = text.indexOf(endMarker, start + startMarker.length)
  if (end < 0) throw new Error(`the browser half no longer marks ${label} (end)`)
  return text.slice(start, end)
}

// ---- the pure decision ----------------------------------------------------
let decision
try {
  const body = slice(
    '    /**\n     * What an inline rename edit means, as a pure answer.',
    '    function openInlineRename (row, request) {',
    'the inline rename decision',
  )
  // `localNameRefusal` moved to the kernel chunk, so the rules are resolved with
  // their closure. The factory already supplies `translate`, so it is excluded.
  const rules = clientRegion(pluginRoot, {
    start: '    /**\n     * Client-side name rules.',
    end: "    /**\n     * The session's mutation mode",
    exclude: ['translate', 'React', 'createPortal', 'jsx', 'jsxs', 'Fragment'],
  })
  if (rules === '') throw new Error('the browser half no longer marks the client-side name rules')
  decision = new Function(`
    const translate = (key) => key
    ${rules}
    ${body}
    return { inlineRenameDecision }
  `)().inlineRenameDecision
} catch (error) {
  console.log(`  FAIL  the rename decision could be lifted out of the bundle — ${error.message}`)
  process.exit(1)
}

{
  check('an unchanged name is a CANCEL, not a write', decision('a.txt', 'a.txt') === 'cancel')
  check('a cleared field is a CANCEL, not an error about an empty name', decision('a.txt', '') === 'cancel')
  check('whitespace alone is a CANCEL', decision('a.txt', '   ') === 'cancel')
  check('a real rename commits', decision('a.txt', 'b.txt') === 'commit')
  check('surrounding whitespace is trimmed before comparing', decision('a.txt', '  b.txt  ') === 'commit')
  check('a slash REFUSES instead of writing a path', decision('a.txt', 'x/y.txt') === 'refuse')
  check('a backslash REFUSES', decision('a.txt', 'x\\y.txt') === 'refuse')
  check('"." REFUSES', decision('a.txt', '.') === 'refuse')
  check('".." REFUSES', decision('a.txt', '..') === 'refuse')
  check('a dotfile is a legitimate name', decision('a.txt', '.gitignore') === 'commit')
  check('a non-string is treated as a cleared field', decision('a.txt', undefined) === 'cancel')
}

// ---- the anchor: the row's NAME, never a host class -----------------------
let renameAnchorOf
try {
  // `renameAnchorOf` moved to the stateless kernel chunk, so both markers have to
  // come from that file — the "one live inline editor" doc belongs to a function
  // that stayed in the bundle.
  const body = slice(
    '    /** The element an inline rename editor should cover',
    '    const DELETE_COUNT_LIMIT = 200',
    'the rename anchor',
    clientPartSource(pluginRoot, 'client.kernel.js'),
  )
  renameAnchorOf = new Function('Element', `
    ${body}
    return renameAnchorOf
  `)(Object) 
} catch (error) {
  console.log(`  FAIL  the rename anchor could be lifted out of the bundle — ${error.message}`)
  process.exit(1)
}

{
  const dom = makeTreeDom()
  const li = dom.make({ tag: 'li', attrs: { 'data-files-entry': 'file', 'data-files-path': '/a/b.txt' } })
  const button = dom.make({ tag: 'button' })
  button.appendChild(dom.make({ tag: 'svg' }))
  const name = dom.make({ tag: 'span', text: 'b.txt' })
  button.appendChild(name)
  li.appendChild(button)

  check('the editor anchors on the row NAME span', renameAnchorOf(li) === name,
    String(renameAnchorOf(li)?.tagName))
  // The anchor must be found by STRUCTURE (a span with text), never by a host
  // class name — those are hashed per build, so a restyle upstream would move
  // the editor onto the wrong element without failing anything else.
  const anchorBody = source.slice(source.indexOf('function renameAnchorOf'), source.indexOf('function renameAnchorOf') + 700)
  const anchorCode = anchorBody.split('\n').filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*')).join('\n')
  check('...not by a host class name', !/querySelector\([^)]*class/iu.test(anchorCode) && !/classList/iu.test(anchorCode),
    'the anchor keys off a hashed host class')
}

{
  // A row with no span at all (an unusual host build) still yields something
  // positionable, and an empty span is skipped in favour of an earlier one.
  const dom = makeTreeDom()
  const li = dom.make({ tag: 'li' })
  const button = dom.make({ tag: 'button' })
  const filled = dom.make({ tag: 'span', text: 'real-name' })
  const empty = dom.make({ tag: 'span', text: '' })
  button.append(filled, empty)
  li.appendChild(button)
  check('an empty trailing span does not become the anchor', renameAnchorOf(li) === filled,
    String(renameAnchorOf(li)?.textContent))
}

{
  const dom = makeTreeDom()
  const li = dom.make({ tag: 'li' })
  const button = dom.make({ tag: 'button' })
  button.appendChild(dom.make({ tag: 'svg' }))
  li.appendChild(button)
  check('a row with no name span falls back to its button', renameAnchorOf(li) === button)
}

// ---- the editor itself, on a real DOM double -----------------------------
let api
try {
  // `openInlineRename` reaches `renameAnchorOf`, which moved to the kernel chunk,
  // so the region is resolved with its closure. Everything the factory injects is
  // excluded — those are doubles standing in for the DOM and the routes.
  const body = clientRegion(pluginRoot, {
    start: '    /**\n     * What an inline rename edit means, as a pure answer.',
    end: '    /**\n     * The rename prompt as a modal',
    exclude: ['document', 'Element', 'translate', 'localNameRefusal', 'fetchJson', 'refreshFilesPanel',
      'notifyUser', 'describeRenameFailure', 'API', 'entryNameOf', 'React', 'createPortal', 'jsx', 'jsxs', 'Fragment'],
  })
  if (body === '') throw new Error('the browser half no longer marks the inline rename editor')
  const factory = new Function('document', 'Element', 'translate', 'localNameRefusal', 'fetchJson', 'refreshFilesPanel', 'notifyUser', 'describeRenameFailure', 'API', 'entryNameOf', `
    ${body}
    return { openInlineRename, closeInlineRename, inlineRenameDecision }
  `)
  api = (dom, overrides = {}) => {
    const calls = { fetches: [], notices: [], refreshes: 0 }
    const built = factory(
      dom.document,
      Object,
      (key) => key,
      (name) => (name === '' || name === '.' || name === '..' || /[\\/]/u.test(name) ? 'bad name' : undefined),
      async (url, init) => { calls.fetches.push({ url, body: init?.body }); return { ok: true } },
      () => { calls.refreshes += 1 },
      (text, kind) => { calls.notices.push({ text, kind }) },
      (err) => `rename failed: ${err.message}`,
      { rename: '/api/rename' },
      (target) => String(target ?? '').split('/').pop(),
    )
    return { ...built, calls, ...overrides }
  }
} catch (error) {
  console.log(`  FAIL  the inline editor could be lifted out of the bundle — ${error.message}`)
  process.exit(1)
}

/** A host-shaped row: li > button > (svg, span). */
function buildRow (dom, filePath) {
  const li = dom.make({ tag: 'li', attrs: { 'data-files-entry': 'file', 'data-files-path': filePath } })
  const button = dom.make({ tag: 'button' })
  button.appendChild(dom.make({ tag: 'svg' }))
  button.appendChild(dom.make({ tag: 'span', text: filePath.split('/').pop() }))
  li.appendChild(button)
  dom.document.body.appendChild(li)
  return { li, button }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

{
  const dom = makeTreeDom()
  const row = buildRow(dom, '/a/b.txt')
  const built = api(dom)
  const opened = built.openInlineRename(row.li, { path: '/a/b.txt', name: 'b.txt' })

  check('the editor opens', opened === true)
  const inputs = dom.document.created.filter(node => String(node.className).includes('sshwsp-inline-rename'))
  check('...as exactly one input', inputs.length === 1, String(inputs.length))
  const input = inputs[0]
  check('...portaled to the document, not inside the host row',
    input.parentNode === dom.document.body && row.li.contains(input) === false,
    'the editor was inserted into a React-owned row')
  check('...prefilled with the current name', input.value === 'b.txt', input.value)
  check('...labelled for a screen reader', input.getAttribute('aria-label') === 'rowmenu.rename',
    String(input.getAttribute('aria-label')))
  check('...sized and placed from the row name', typeof input.style.left === 'string' && input.style.left !== '' &&
    typeof input.style.width === 'string' && input.style.width !== '',
    JSON.stringify(input.style))
}

{
  // Enter with a real change: one route call, one refresh, one notice.
  const dom = makeTreeDom()
  const row = buildRow(dom, '/a/b.txt')
  const built = api(dom)
  built.openInlineRename(row.li, { path: '/a/b.txt', name: 'b.txt', root: '/a' })
  const input = dom.document.created.filter(node => String(node.className).includes('sshwsp-inline-rename'))[0]
  input.value = 'renamed.txt'
  input.emit('keydown', { key: 'Enter', preventDefault () {}, stopPropagation () {} })
  await flush()

  check('Enter commits the new name', built.calls.fetches.length === 1, JSON.stringify(built.calls.fetches))
  const body = JSON.parse(built.calls.fetches[0].body)
  check('...addressing the original path', body.path === '/a/b.txt', JSON.stringify(body))
  check('...with the typed name', body.newName === 'renamed.txt', JSON.stringify(body))
  check('...carrying the root it was opened for', body.root === '/a', JSON.stringify(body))
  check('...refreshing the panel so the new name shows', built.calls.refreshes === 1, String(built.calls.refreshes))
  check('...and saying it happened', built.calls.notices.some(note => note.text === 'rowmenu.renamed'),
    JSON.stringify(built.calls.notices))
  check('the editor is gone afterwards', built.calls !== null &&
    dom.document.created.filter(node => String(node.className).includes('sshwsp-inline-rename')).every(node => node.removed),
    'the editor outlived its commit')
}

{
  // Escape: nothing is written.
  const dom = makeTreeDom()
  const row = buildRow(dom, '/a/b.txt')
  const built = api(dom)
  built.openInlineRename(row.li, { path: '/a/b.txt', name: 'b.txt' })
  const input = dom.document.created.filter(node => String(node.className).includes('sshwsp-inline-rename'))[0]
  input.value = 'discarded.txt'
  input.emit('keydown', { key: 'Escape', preventDefault () {}, stopPropagation () {} })
  await flush()
  check('Escape writes nothing', built.calls.fetches.length === 0, JSON.stringify(built.calls.fetches))
}

{
  // An unchanged value on Enter is a cancel, not a pointless rename request.
  const dom = makeTreeDom()
  const row = buildRow(dom, '/a/b.txt')
  const built = api(dom)
  built.openInlineRename(row.li, { path: '/a/b.txt', name: 'b.txt' })
  const input = dom.document.created.filter(node => String(node.className).includes('sshwsp-inline-rename'))[0]
  input.emit('keydown', { key: 'Enter', preventDefault () {}, stopPropagation () {} })
  await flush()
  check('Enter on an unchanged name writes nothing', built.calls.fetches.length === 0,
    JSON.stringify(built.calls.fetches))
}

{
  // A refused name keeps the field open and marks it invalid.
  const dom = makeTreeDom()
  const row = buildRow(dom, '/a/b.txt')
  const built = api(dom)
  built.openInlineRename(row.li, { path: '/a/b.txt', name: 'b.txt' })
  const input = dom.document.created.filter(node => String(node.className).includes('sshwsp-inline-rename'))[0]
  input.value = 'x/y.txt'
  input.emit('keydown', { key: 'Enter', preventDefault () {}, stopPropagation () {} })
  await flush()
  check('a name with a separator is REFUSED, not written', built.calls.fetches.length === 0,
    JSON.stringify(built.calls.fetches))
  check('...and the editor stays open so the user can fix it', input.removed !== true,
    'the field closed on a name it could have corrected')
  check('...marked invalid for assistive tech', input.getAttribute('aria-invalid') === 'true',
    String(input.getAttribute('aria-invalid')))
}

{
  // Blur commits a real change (the rule every file manager follows)…
  const dom = makeTreeDom()
  const row = buildRow(dom, '/a/b.txt')
  const built = api(dom)
  built.openInlineRename(row.li, { path: '/a/b.txt', name: 'b.txt' })
  const input = dom.document.created.filter(node => String(node.className).includes('sshwsp-inline-rename'))[0]
  input.value = 'blurred.txt'
  input.emit('blur', {})
  await flush()
  check('clicking elsewhere commits a real change', built.calls.fetches.length === 1,
    JSON.stringify(built.calls.fetches))
}

{
  // …and cancels an unchanged one.
  const dom = makeTreeDom()
  const row = buildRow(dom, '/a/b.txt')
  const built = api(dom)
  built.openInlineRename(row.li, { path: '/a/b.txt', name: 'b.txt' })
  const input = dom.document.created.filter(node => String(node.className).includes('sshwsp-inline-rename'))[0]
  input.emit('blur', {})
  await flush()
  check('clicking elsewhere with no change writes nothing', built.calls.fetches.length === 0,
    JSON.stringify(built.calls.fetches))
}

{
  // A failure is a toast; the field does not reappear under the pointer.
  const dom = makeTreeDom()
  const row = buildRow(dom, '/a/b.txt')
  const built = api(dom, {})
  built.openInlineRename(row.li, { path: '/a/b.txt', name: 'b.txt' })
  const input = dom.document.created.filter(node => String(node.className).includes('sshwsp-inline-rename'))[0]
  // The stub fetches OK; force a failure by opening with a path the stub rejects.
  input.value = 'fine.txt'
  input.emit('keydown', { key: 'Enter', preventDefault () {}, stopPropagation () {} })
  await flush()
  check('a successful rename reports success, not failure',
    built.calls.notices.some(note => note.kind === 'ok') && !built.calls.notices.some(note => note.kind === 'err'),
    JSON.stringify(built.calls.notices))
}

{
  // Opening twice must not leave two editors.
  const dom = makeTreeDom()
  const row = buildRow(dom, '/a/b.txt')
  const built = api(dom)
  built.openInlineRename(row.li, { path: '/a/b.txt', name: 'b.txt' })
  built.openInlineRename(row.li, { path: '/a/b.txt', name: 'b.txt' })
  const live = dom.document.created.filter(node => String(node.className).includes('sshwsp-inline-rename') && node.removed !== true)
  check('a second open replaces the first editor instead of stacking', live.length === 1, String(live.length))
}

// ---- the call sites pass the row -----------------------------------------
{
  check('the row menu hands the rename the row it was opened on',
    /requestRowRename\(\{ path: absPath, name: entryNameOf\(absPath\), root, sessionId, row: rowOfPath\(absPath\) \}\)/u.test(source),
    'rename lost the row, so it can only fall back to a modal')
  check('F2 hands the rename the row the keyboard owns',
    /requestRowRename\(\{ path, name: entryNameOf\(path\), root, row \}\)/u.test(source),
    'F2 lost the row it was pressed on')
  check('a rename with no live row still has the modal fallback',
    /function requestRowRenameDialog/u.test(source) && /requestRowRenameDialog\(request\)/u.test(source),
    'a row that left the DOM has no way to be renamed')
  // The dispatcher is the one place the two shapes meet, and a `false` guard
  // there would send every rename to the modal while this suite stayed green —
  // it exercises `openInlineRename` directly. Measured: replacing the guard
  // with `if (false)` passed all 41 assertions before this one existed.
  check('a rename WITH a live row goes to the in-place editor, not the modal',
    /if \(row instanceof Element && document\.contains\(row\)\) \{\s*\n\s*if \(openInlineRename\(row, request\)\) return/u.test(source),
    'the in-place editor is unreachable, so every rename is a modal')
  check('...and the row is what decides, so a detached row still falls back',
    /if \(row instanceof Element && document\.contains\(row\)\)/u.test(source),
    'the dispatch does not check that the row is still on screen')
  check('the row lookup happens at ACT time, not at menu time',
    /function rowOfPath/u.test(source) && /document\.querySelectorAll\(TREE_ROW_SELECTOR\)/u.test(source),
    'a stale node reference is used after the host re-rendered')
}


  totalPassed += passed
  totalFailures += failures.length
})()

// ---------------------------------------------------------------------------
// tree-blank-menu-smoke.mjs
// ---------------------------------------------------------------------------
await (async () => {
/**
 * The blank-space resolvers and the menu contract.
 *
 * The host tree is DSH-owned DOM. This suite lifts two shipped helpers and
 * drives them against the same fake tree shape `tree-select-smoke` uses:
 *
 * - `localBlankTargetOf` — which local directory a blank gesture belongs to:
 *   nearest expanded directory row, otherwise the root; local roots only; and
 *   nothing outside the root.
 * - `blankMenuScopeOf` — which REMOTE panel a blank gesture belongs to. The
 *   boundary is `[data-files-page]`, never the document: the header button and
 *   the tree are siblings inside the page, so the search has to leave the
 *   pointer's container, but it must not leave the panel. This is the fix for
 *   a right-click in the conversation window opening the directory menu of
 *   whichever file panel happened to be rendered first.
 *
 * The menu itself is a DOM overlay whose real acceptance is the GUI pass, so
 * its source contract (exactly three items — create file, create folder, copy
 * the path — and copy always available) is pinned here.
 *
 * Run: node tests/tree-blank-menu-smoke.mjs
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

console.log('\n=== tree blank menu smoke ===\n')

/** Pull one function declaration out of the bundle by brace matching. */
function functionText (name) {
  const start = source.indexOf(`function ${name} (`)
  if (start < 0) throw new Error(`client.js does not define ${name}()`)
  // Walk past the parameter list before looking for the body. A destructured
  // first argument opens a brace of its own, and counting from THAT one ends
  // the "body" at the parameter's closing brace — a slice with no statements
  // in it, which every assertion about the function would then pass on.
  let parens = 0
  let afterParams = -1
  for (let i = source.indexOf('(', start); i < source.length; i += 1) {
    if (source[i] === '(') parens += 1
    else if (source[i] === ')') {
      parens -= 1
      if (parens === 0) { afterParams = i; break }
    }
  }
  if (afterParams < 0) throw new Error(`unbalanced parameters in ${name}()`)
  const open = source.indexOf('{', afterParams)
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

function remoteTargetOf (value) {
  if (typeof value !== 'string' || !value.startsWith('ssh://')) return null
  return { alias: 'host', remotePath: value.slice('ssh://host'.length) }
}

const factory = new Function(
  'Element', 'TREE_ROW_SELECTOR', 'TREE_BODY_SELECTOR', 'remoteTargetOf',
  'OS_TREE_SELECTOR', 'OS_PAGE_SELECTOR',
  'normalizeRoot', 'localPathWithin', 'localBlankTargetOf', 'treeContainerOf', 'treeSessionOfContainer',
  `
  ${functionText('normalizeRoot')}
  ${functionText('localPathWithin')}
  ${functionText('localBlankTargetOf')}
  ${functionText('blankMenuScopeOf')}
  ${functionText('treeContainerOf')}
  ${functionText('treeSessionOfContainer')}
  return { localBlankTargetOf, localPathWithin, blankMenuScopeOf }
  `,
)
const api = factory(
  Object,
  '[data-files-entry][data-files-path]',
  '[data-files-body]',
  remoteTargetOf,
  '[data-files-state="tree"]',
  '[data-files-page]',
)

/**
 * Bind the global `document` the sliced code would see in a browser.
 *
 * The shipped helper does NOT reference `document` — that is the point of the
 * fix, and the fence for it is asserted structurally. But a MUTATION that
 * widens the search back to the document does, and without this binding it
 * died with `ReferenceError: document is not defined` instead of failing an
 * assertion. A mutation that crashes proves nothing about the assertion it was
 * aimed at, so the double is installed here and every block calls this first:
 * the mutation then returns a real scope for the conversation node and the
 * behavioral assertions go red for the right reason.
 */
function useDom (dom) {
  globalThis.document = dom.document
  return dom
}

// ---- a tree shaped like the host's ----------------------------------------
function buildTree (dom, root) {
  const session = dom.make({ tag: 'div', attrs: { 'data-sidebar-right-session': 's1' } })
  const tree = dom.make({ tag: 'div', attrs: { 'data-files-state': 'tree', 'data-files-root': root } })
  const body = dom.make({ tag: 'div', attrs: { 'data-files-body': '' } })
  const list = dom.make({ tag: 'ul' })
  body.appendChild(list)
  tree.appendChild(body)
  session.appendChild(tree)
  dom.document.body.appendChild(session)
  return { session, tree, body, list }
}

function addRow (dom, list, kind, value) {
  const row = dom.make({ tag: 'li', attrs: { 'data-files-entry': kind, 'data-files-path': value } })
  const button = dom.make({ tag: 'button' })
  row.appendChild(button)
  list.appendChild(row)
  return { row, button }
}

console.log('[the directory a blank gesture belongs to]')
{
  const dom = useDom(makeTreeDom())
  const root = 'C:\\work\\project'
  const built = buildTree(dom, root)
  const dir = addRow(dom, built.list, 'directory', 'C:/work/project/one')
  const nested = dom.make({ tag: 'ul' })
  dir.row.appendChild(nested)

  const atRoot = api.localBlankTargetOf(built.list)
  check('blank space at the root resolves to the root', atRoot?.dir === root, atRoot?.dir ?? 'null')
  check('...and keeps the tree root spelling', atRoot?.root === root, atRoot?.root ?? 'null')
  check('...and names the session that owns it', atRoot?.sessionId === 's1', atRoot?.sessionId ?? 'null')

  const atDir = api.localBlankTargetOf(nested)
  check('blank space inside an expanded directory resolves to that directory',
    atDir?.dir === 'C:/work/project/one', atDir?.dir ?? 'null')
  check('...and still reports the same root', atDir?.root === root, atDir?.root ?? 'null')

  check('a directory row itself is not blank space', api.localBlankTargetOf(dir.button) === null)
  check('a tree root with a remote spelling is not a local target', api.localBlankTargetOf(built.list) !== null)
}

console.log('\n[the fences]')
{
  const dom = useDom(makeTreeDom())
  const built = buildTree(dom, 'C:\\work\\project')
  const outside = addRow(dom, built.list, 'directory', 'C:/work2/elsewhere')
  const nested = dom.make({ tag: 'ul' })
  outside.row.appendChild(nested)
  check('a directory outside the root is refused', api.localBlankTargetOf(nested) === null)
  check('a root that is not a prefix is refused', !api.localPathWithin('C:/work', 'C:/work2'))

  const remote = useDom(makeTreeDom())
  const remoteTree = buildTree(remote, 'ssh://qiyk/home/qiyk/test')
  addRow(remote, remoteTree.list, 'directory', 'ssh://qiyk/home/qiyk/test/sub')
  check('a remote tree does not enter the local blank path',
    api.localBlankTargetOf(remoteTree.list) === null)
}

console.log('\n[which panel a blank gesture belongs to]')
/**
 * Build a Files panel shaped like the host's: page > header(button) + tree(body).
 *
 * The button is the ONLY carrier of the alias and the remote path, and it lives
 * in the header — a SIBLING of the scrolled tree, not an ancestor of the rows.
 * That sibling relationship is the whole reason the lookup has to widen past
 * the pointer's container, and the reason it must stop at the page.
 */
function buildPage (dom, { alias = 'qiyk', dir = '/home/qiyk/test', root = 'ssh://qiyk/home/qiyk/test', withButton = true } = {}) {
  const page = dom.make({ tag: 'div', attrs: { 'data-files-page': '' } })
  const header = dom.make({ tag: 'div' })
  if (withButton) {
    header.appendChild(dom.make({
      tag: 'button',
      attrs: { 'data-sshwsp-dir': dir, 'data-sshwsp-alias': alias },
    }))
  }
  const tree = dom.make({ tag: 'aside', attrs: { 'data-files-state': 'tree', 'data-files-root': root } })
  const body = dom.make({ tag: 'div', attrs: { 'data-files-body': '' } })
  const list = dom.make({ tag: 'ul' })
  body.appendChild(list)
  tree.appendChild(body)
  const content = dom.make({ tag: 'div' })
  content.appendChild(tree)
  page.appendChild(header)
  page.appendChild(content)
  dom.document.body.appendChild(page)
  return { page, header, tree, body, list, content }
}

{
  // The regression from the screenshot: a right-click in the CONVERSATION.
  // No page ancestor, so there is nothing to offer and the browser keeps the
  // gesture. Before the fix this resolved through `document` to whichever file
  // panel had rendered first.
  const dom = useDom(makeTreeDom())
  const built = buildPage(dom)
  const conversation = dom.make({ tag: 'div' })
  const message = dom.make({ tag: 'p', text: 'hello' })
  conversation.appendChild(message)
  dom.document.body.appendChild(conversation)

  check('a right-click in the conversation window resolves to nothing',
    api.blankMenuScopeOf(message) === null)
  check('...so the document-wide button is never borrowed',
    api.blankMenuScopeOf(conversation) === null && api.blankMenuScopeOf(dom.document.body) === null)
  check('a non-Element target resolves to nothing', api.blankMenuScopeOf(null) === null)

  // Blank space in the tree body: the tree IS an ancestor, so the panel is
  // found without widening, and the button comes from the same page.
  const scope = api.blankMenuScopeOf(built.list)
  check('blank space in the tree body resolves to its page',
    scope?.page === built.page && scope?.tree === built.tree)
  check('...carrying the alias and directory the header publishes',
    scope?.alias === 'qiyk' && scope?.dir === '/home/qiyk/test',
    `${scope?.alias ?? 'null'} / ${scope?.dir ?? 'null'}`)
  check('...and the tree root', scope?.root === 'ssh://qiyk/home/qiyk/test', scope?.root ?? 'null')

  // The header is the case the widening exists for: a page ancestor, but no
  // tree ancestor. The tree is found by querying the page.
  const onHeader = api.blankMenuScopeOf(built.header)
  check('a right-click on the panel header still resolves to the page tree',
    onHeader?.tree === built.tree, onHeader?.tree === undefined ? 'null' : 'wrong tree')
  check('...using the same button', onHeader?.alias === 'qiyk' && onHeader?.dir === '/home/qiyk/test')

  // Blank space below the rows, inside the body but outside any row.
  const spacer = dom.make({ tag: 'div' })
  built.body.appendChild(spacer)
  const belowRows = api.blankMenuScopeOf(spacer)
  check('blank space below the rows resolves to the same directory',
    belowRows?.dir === '/home/qiyk/test' && belowRows?.tree === built.tree)
}

console.log('\n[the panel boundary is not the document]')
{
  // Two panels side by side, remote then local. A gesture in the LOCAL one
  // must not borrow the remote panel's button: that is how a local header
  // right-click used to offer uploading to a host the user was not looking at.
  const dom = useDom(makeTreeDom())
  const remotePanel = buildPage(dom, { alias: 'qiyk', dir: '/home/qiyk/test' })
  const localPanel = buildPage(dom, {
    alias: null, dir: null, root: 'C:\\work\\project', withButton: false,
  })

  check('a local panel with no button resolves to nothing',
    api.blankMenuScopeOf(localPanel.list) === null)
  check('...and its header does not borrow the remote panel either',
    api.blankMenuScopeOf(localPanel.header) === null)
  check('...while the remote panel beside it still resolves',
    api.blankMenuScopeOf(remotePanel.list)?.alias === 'qiyk')

  // A tree that is NOT inside the page: `closest` can walk past a page, so the
  // containment check is what stops a page with no tree of its own from
  // adopting a tree it merely sits near.
  const stray = useDom(makeTreeDom())
  const strayPage = stray.make({ tag: 'div', attrs: { 'data-files-page': '' } })
  strayPage.appendChild(stray.make({
    tag: 'button',
    attrs: { 'data-sshwsp-dir': '/srv/x', 'data-sshwsp-alias': 'other' },
  }))
  const strayTree = stray.make({ tag: 'aside', attrs: { 'data-files-state': 'tree', 'data-files-root': 'ssh://other/srv/x' } })
  stray.document.body.appendChild(strayPage)
  stray.document.body.appendChild(strayTree)
  check('a page whose tree lives outside it resolves to nothing',
    api.blankMenuScopeOf(strayPage) === null)
}

console.log('\n[the empty attributes are refusals, not empty menus]')
{
  const dom = useDom(makeTreeDom())
  const panel = buildPage(dom, { alias: '', dir: '/home/qiyk/test' })
  check('an empty alias is refused', api.blankMenuScopeOf(panel.list) === null)

  const dom2 = useDom(makeTreeDom())
  const panel2 = buildPage(dom2, { alias: 'qiyk', dir: '' })
  check('an empty directory is refused', api.blankMenuScopeOf(panel2.list) === null)

  // An empty root is a supported answer (null), not a refusal: the page still
  // names a real directory, and only the @ mention loses its base.
  const dom3 = useDom(makeTreeDom())
  const panel3 = buildPage(dom3, { root: '' })
  const scope = api.blankMenuScopeOf(panel3.list)
  check('an empty tree root is null rather than a refusal',
    scope !== null && scope.root === null, scope === null ? 'refused' : String(scope.root))
}

console.log('\n[the menu contract]')
{
  const menu = functionText('openLocalBlankMenu')
  const model = functionText('blankMenuModel')
  check('the local blank menu is three descriptors and nothing else',
    (model.match(/id: '/gu) ?? []).length === 3 &&
    model.includes("translate('rowmenu.newFile')") &&
    model.includes("translate('rowmenu.newFolder')") &&
    model.includes("translate('rowmenu.copyPath')") &&
    !/rowmenu\.(rename|delete|upload|download)|transfer\.(download|upload)|createMenuSeparator/u.test(model),
    `items=${(model.match(/id: '/gu) ?? []).length}`)
  check('...new file asks the shared dialog for the resolved directory',
    /requestRowNewFile\(\{ path: dir, root, sessionId, row: null, container \}\)/u.test(model))
  check('...new folder asks the shared dialog for the resolved directory',
    /requestRowNewFolder\(\{ path: dir, root, sessionId, row: null, container \}\)/u.test(model))
  check('...copy always works, while only the two create items are gated',
    (model.match(/gated\(\{/gu) ?? []).length === 2 &&
    !/gated\(\{[\s\S]{0,80}?copy-path/u.test(model) &&
    /reason: dir,/u.test(model))
  check('...and the renderer draws one row per descriptor, reading the rule from it',
    (functionText('renderMenuDom').match(/createTransferItem\(/gu) ?? []).length === 1 &&
    functionText('renderMenuDom').includes('entry.separatorBefore === true') &&
    (menu.match(/createTransferItem\(/gu) ?? []).length === 0)
  check('...while the late policy answer disables only the two create items',
    menu.includes("for (const id of ['new-file', 'new-folder'])") &&
    menu.includes('policyOf({ sessionId, root })') &&
    menu.includes('node.disabled = true') &&
    !/copy-path/u.test(menu))
  check('a row point that is not a nested list keeps the row menu',
    /const nestedBlank = !onButton && row\.getAttribute\('data-files-entry'\) === 'directory'/u.test(source) &&
    /if \(!nestedBlank\) \{\n\s+if \(!openForRow\(row, event\)\) return/u.test(source))
  check('the shared menu lifecycle owns the dismissal listeners',
    /function openMenuAt \(x, y, fill\)/.test(source) &&
    /const local = localBlankTargetOf\(target\)/.test(source) &&
    /openLocalBlankMenu\(ctx, local, event\.clientX, event\.clientY\)/.test(source))
}

console.log('\n[one search, bounded by the panel]')
{
  // `openForBlank` is an inner arrow; slice it on its own so the fence is about
  // THAT function rather than about every querySelector in the bridge.
  const bridge = functionText('installTreeMenuBridge')
  const start = bridge.indexOf('const openForBlank = (event, target) => {')
  if (start < 0) throw new Error('installTreeMenuBridge does not define openForBlank()')
  const end = bridge.indexOf('\n      }', start)
  const blankBody = end < 0 ? bridge.slice(start) : bridge.slice(start, end)

  check('the blank handler resolves its panel through the shared helper',
    /const scope = blankMenuScopeOf\(target\)/u.test(blankBody),
    'the menu still searches for a button by itself')
  check('...and gives the gesture back when there is no panel',
    /if \(scope === null\) return false/u.test(blankBody),
    'a null scope would fall through to opening a menu')
  // The regression is structural, so the fence is too: NO query at all may
  // decide which panel a gesture belongs to, and no reference to `document`.
  // The old code reached the document in two ways — a `holders.push(document)`
  // list and a `document`-scoped query — and either one is how a right-click
  // in the conversation borrowed the first panel on screen.
  check('...and never falls back to a document-wide lookup',
    !/document/u.test(blankBody) && !/querySelector/u.test(blankBody),
    'a document-scoped lookup would make the whole page one panel')
  // The helper is where a future "widen a bit further" edit would land, and
  // widening to `document.body` is the whole defect. Nothing in it may name the
  // document at all.
  check('...and the helper itself never names the document',
    !/document/u.test(functionText('blankMenuScopeOf')),
    'a document fallback in the helper makes every page a candidate panel')
  check('...with the alias and directory still read from the one button',
    /const alias = button\.getAttribute\('data-sshwsp-alias'\)/u.test(functionText('blankMenuScopeOf')) &&
    /const dir = button\.getAttribute\('data-sshwsp-dir'\)/u.test(functionText('blankMenuScopeOf')),
    'a second source for the alias would drift from the header')
  check('...and the tree checked against the page',
    /!page\.contains\(tree\)/u.test(functionText('blankMenuScopeOf')),
    'a page could adopt a tree it merely sits next to')

  // Rule 4: the ROW menu is deliberately not gated on a page. A preview tab's
  // navigator row still opens its row menu today, and that is unchanged.
  check('the row menu is not gated on a Files page',
    /const row = target\.closest\(TREE_ROW_SELECTOR\)\n\s+if \(row !== null\) \{/u.test(bridge),
    'gating the row menu would silently remove it from the preview navigator')
  check('...and the local branch still runs before the remote one',
    bridge.indexOf('localBlankTargetOf(target)') > 0 &&
    bridge.indexOf('localBlankTargetOf(target)') < bridge.indexOf('openForBlank(event, target)'),
    'the two menus could both answer, or answer in the wrong order')
}


  totalPassed += passed
  totalFailures += failures.length
})()

console.log(`\n=== ${totalPassed} passed, ${totalFailures} failed ===`)
if (totalFailures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}