/**
 * System-file drops onto DSH's own Files tree.
 *
 * The tree belongs to the host, so this suite runs the SHIPPED target resolver
 * against a DOM double shaped like the host's nested rows, and then pins the
 * document-capture wiring at the source. The split is deliberate: a fake DOM
 * can prove "which directory owns this spot", while a source assertion is the
 * only way to show the browser's file-drop event never reaches the host's
 * attachment intake.
 *
 * Run: node tests/tree-os-drop-smoke.mjs
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

console.log('\n=== tree os drop smoke ===\n')

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

// ---- a small DOM double ----------------------------------------------------

/** Parse the selector subset these functions actually use. */
function selectorParts (selector) {
  return String(selector).split(',').map(part => {
    const tag = /^[a-zA-Z][\w-]*/u.exec(part)?.[0]?.toLowerCase() ?? null
    const attrs = []
    const attrRe = /\[([\w-]+)(?:="([^"]*)")?\]/gu
    for (const match of part.matchAll(attrRe)) attrs.push({ name: match[1], value: match[2] ?? null })
    return { tag, attrs }
  })
}

function selectorMatches (element, selector) {
  return selectorParts(selector).some(part => {
    if (part.tag !== null && element.tagName.toLowerCase() !== part.tag) return false
    for (const attr of part.attrs) {
      const value = element.getAttribute(attr.name)
      if (value === null) return false
      if (attr.value !== null && value !== attr.value) return false
    }
    return true
  })
}

class FakeElement {
  constructor (tagName, attrs = {}, children = []) {
    this.tagName = tagName.toUpperCase()
    this.attributes = new Map(Object.entries(attrs).map(([key, value]) => [key, String(value)]))
    this.children = []
    this.parentNode = null
    const properties = new Map()
    this.style = {
      setProperty (name, value) { properties.set(name, String(value)) },
      removeProperty (name) { properties.delete(name) },
      getPropertyValue (name) { return properties.get(name) ?? '' },
    }
    for (const child of children) this.append(child)
  }

  getAttribute (name) { return this.attributes.has(name) ? this.attributes.get(name) : null }
  setAttribute (name, value) { this.attributes.set(name, String(value)) }
  hasAttribute (name) { return this.attributes.has(name) }
  removeAttribute (name) { this.attributes.delete(name) }

  append (...children) {
    for (const child of children) {
      child.parentNode = this
      this.children.push(child)
    }
    return this
  }

  contains (node) {
    if (node === this) return true
    return this.children.some(child => child.contains(node))
  }

  closest (selector) {
    let node = this
    while (node !== null) {
      if (selectorMatches(node, selector)) return node
      node = node.parentNode
    }
    return null
  }

  querySelectorAll (selector) {
    const found = []
    const walk = (node) => {
      for (const child of node.children) {
        if (selectorMatches(child, selector)) found.push(child)
        walk(child)
      }
    }
    walk(this)
    return found
  }

  querySelector (selector) { return this.querySelectorAll(selector)[0] ?? null }
}

class FakeDocument {
  constructor () {
    this.body = new FakeElement('body')
    this.created = []
  }

  querySelectorAll (selector) {
    const found = []
    if (selectorMatches(this.body, selector)) found.push(this.body)
    for (const child of this.body.querySelectorAll(selector)) found.push(child)
    return found
  }

  querySelector (selector) { return this.querySelectorAll(selector)[0] ?? null }

  createElement (tagName) {
    const node = new FakeElement(tagName)
    this.created.push(node)
    return node
  }
}

function makeDirectory (document, remotePath, options = {}) {
  const li = new FakeElement('li', { 'data-files-entry': 'directory', 'data-files-path': remotePath })
  const expanded = options.expanded === true || (options.children?.length ?? 0) > 0
  const button = new FakeElement('button', { 'aria-expanded': String(expanded) })
  li.append(button)
  if (expanded) {
    const ul = new FakeElement('ul')
    for (const child of options.children ?? []) ul.append(child.li)
    li.append(ul)
    return { li, button, ul }
  }
  return { li, button, ul: null }
}

function makeFileLike (document, kind, remotePath) {
  const li = new FakeElement('li', { 'data-files-entry': kind, 'data-files-path': remotePath })
  const button = new FakeElement('button')
  li.append(button)
  return { li, button }
}

function makeTree (root, rows = [], options = {}) {
  const document = new FakeDocument()
  const attrs = { 'data-files-state': 'tree' }
  if (root !== null) attrs['data-files-root'] = root
  const tree = new FakeElement('div', attrs)
  const body = new FakeElement('div', { 'data-files-body': '1' })
  tree.append(body)
  for (const row of rows) body.append(row)
  // The host wraps the tree in the panel page; its header carries the path
  // label. Both are the same drop destination, so the double keeps that shape.
  const page = new FakeElement('div', { 'data-files-page': '1' })
  const header = new FakeElement('div')
  const label = new FakeElement('span', { 'data-path-label': '1' })
  header.append(label)
  const content = new FakeElement('div')
  content.append(tree)
  page.append(header, content)
  document.body.append(page)
  return { document, tree, body, page, header, label }
}

function planText (plan) {
  if (plan === null || plan === undefined) return 'null'
  return JSON.stringify({
    alias: plan.alias,
    dir: plan.dir,
    refusal: plan.refusal,
    root: plan.root,
    highlight: plan.highlight?.tagName ?? null,
  })
}

function makeApi (document, overrides = {}) {
  const calls = { enqueues: [], notices: [] }
  const translate = (key, params) => key + (params === undefined ? '' : ':' + JSON.stringify(params))
  const notifyUser = (input) => { calls.notices.push(input) }
  const toastError = (text, detail, code) => ({ text, detail, code })
  const enqueueUploads = overrides.enqueueUploads ?? ((alias, dir, files) => {
    calls.enqueues.push({ alias, dir, files })
    return { accepted: files, rejected: [] }
  })
  const oversizeTransferText = (rejected) => 'oversize:' + rejected.map(file => file.name).join(',')
  const factory = new Function(
    'Element', 'document', 'translate', 'notifyUser', 'toastError', 'enqueueUploads',
    'oversizeTransferText', 'remoteTargetOf', 'remoteDirOf',
    `
    const OS_TREE_SELECTOR = '[data-files-state="tree"]'
    const OS_PAGE_SELECTOR = '[data-files-page]'
    const TREE_ROW_SELECTOR = '[data-files-entry][data-files-path]'
    const TREE_BODY_SELECTOR = '[data-files-body]'
    const OS_DROP_ATTR = 'data-sshwsp-osdrop'
    ${functionText('remoteTargetOf')}
    ${functionText('remoteDirOf')}
    ${functionText('dropFolderNames')}
    ${functionText('queueTreeUploads')}
    ${functionText('osDropPlan')}
    ${functionText('dropHighlightOf')}
    ${functionText('filesTransferOf')}
    ${functionText('splitDroppedFolders')}
    ${functionText('clearOsDropHighlight')}
    ${functionText('setOsDropHighlight')}
    return { osDropPlan, dropHighlightOf, filesTransferOf, splitDroppedFolders, queueTreeUploads, dropFolderNames, setOsDropHighlight, clearOsDropHighlight }
    `,
  )
  const api = factory(
    FakeElement, document, translate, notifyUser, toastError, enqueueUploads,
    oversizeTransferText, function () {}, function () {},
  )
  return { api, calls }
}

// ---- target resolution -----------------------------------------------------

console.log('[the target directory, including nested host rows]')
{
  const folded = makeDirectory(null, 'ssh://qiyk/home/qiyk/project')
  const tree = makeTree('ssh://qiyk/home/qiyk', [folded.li])
  const { api } = makeApi(tree.document)
  const plan = api.osDropPlan(folded.button)
  check('a folded directory row is its own destination',
    plan?.alias === 'qiyk' && plan?.dir === '/home/qiyk/project',
    planText(plan))
  check('...and its row button is the highlight',
    plan?.highlight === folded.button,
    String(plan?.highlight?.tagName))
}

{
  const expanded = makeDirectory(null, 'ssh://qiyk/home/qiyk/dir', { expanded: true })
  const tree = makeTree('ssh://qiyk/home/qiyk', [expanded.li])
  const { api } = makeApi(tree.document)
  const plan = api.osDropPlan(expanded.ul)
  check('blank space under an expanded directory belongs to that directory, not the root',
    plan?.dir === '/home/qiyk/dir',
    planText(plan))
  check('...and the outline is the owning row button, not the whole li',
    plan?.highlight === expanded.button,
    String(plan?.highlight?.tagName))
}

{
  const childFile = makeFileLike(null, 'file', 'ssh://qiyk/home/qiyk/dir/a.txt')
  const expanded = makeDirectory(null, 'ssh://qiyk/home/qiyk/dir', { children: [childFile] })
  const tree = makeTree('ssh://qiyk/home/qiyk', [expanded.li])
  const { api } = makeApi(tree.document)
  const plan = api.osDropPlan(childFile.button)
  check('a child file row uploads beside that file (its parent directory)',
    plan?.dir === '/home/qiyk/dir',
    planText(plan))
  check('...and highlights the parent directory row',
    plan?.highlight === expanded.button,
    String(plan?.highlight?.tagName))
}

{
  const childDir = makeDirectory(null, 'ssh://qiyk/home/qiyk/dir/sub', { expanded: true })
  const expanded = makeDirectory(null, 'ssh://qiyk/home/qiyk/dir', { children: [childDir] })
  const tree = makeTree('ssh://qiyk/home/qiyk', [expanded.li])
  const { api } = makeApi(tree.document)
  const plan = api.osDropPlan(childDir.button)
  check('a nested directory row uploads into that directory',
    plan?.dir === '/home/qiyk/dir/sub',
    planText(plan))
  check('...and highlights its own button',
    plan?.highlight === childDir.button,
    String(plan?.highlight?.tagName))
}

{
  const other = makeFileLike(null, 'other', 'ssh://qiyk/home/qiyk/dir/socket')
  const expanded = makeDirectory(null, 'ssh://qiyk/home/qiyk/dir', { children: [other] })
  const tree = makeTree('ssh://qiyk/home/qiyk', [expanded.li])
  const { api } = makeApi(tree.document)
  const plan = api.osDropPlan(other.button)
  check('the non-interactive `other` row means its parent directory',
    plan?.dir === '/home/qiyk/dir',
    planText(plan))
}

{
  const tree = makeTree('ssh://qiyk/home/qiyk')
  const { api } = makeApi(tree.document)
  const plan = api.osDropPlan(tree.body)
  check('the tree body itself is the workspace root',
    plan?.dir === '/home/qiyk' && plan?.highlight === tree.body,
    planText(plan))
}

{
  // The path label and the toolbar sit in the page header, OUTSIDE the tree
  // body. A drop there still belongs to this panel, so it goes to the tree root
  // rather than falling through to the composer attachment handler.
  const tree = makeTree('ssh://qiyk/home/qiyk')
  const { api } = makeApi(tree.document)
  const plan = api.osDropPlan(tree.label)
  check('the panel header is the tree root, not the composer',
    plan?.dir === '/home/qiyk' && plan?.alias === 'qiyk',
    planText(plan))
  check('...and outlines the tree body, which is what it targets',
    plan?.highlight === tree.body,
    String(plan?.highlight?.tagName))
  const loose = api.osDropPlan(tree.header)
  check('the whole header band resolves the same way',
    loose?.dir === '/home/qiyk',
    planText(loose))
}

{
  // A dialog can be portalled anywhere; a drop aimed at it must keep the
  // host's behaviour instead of being swallowed by this panel.
  const tree = makeTree('ssh://qiyk/home/qiyk')
  const { api } = makeApi(tree.document)
  const dialog = new FakeElement('div', { role: 'dialog' })
  const inner = new FakeElement('div')
  dialog.append(inner)
  tree.page.append(dialog)
  check('a drop inside a dialog is not claimed by the tree',
    api.osDropPlan(inner) === null)
}

{
  const tree = makeTree('ssh://qiyk/home/qiyk')
  const { api } = makeApi(tree.document)
  const outside = new FakeElement('div')
  tree.document.body.append(outside)
  const plan = api.osDropPlan(outside)
  check('outside the file panel is not intercepted', plan === null, planText(plan))
}

{
  // A page whose tree has not mounted yet has no root to resolve against.
  const page = new FakeElement('div', { 'data-files-page': '1' })
  const header = new FakeElement('span', { 'data-path-label': '1' })
  page.append(header)
  const document = new FakeDocument()
  document.body.append(page)
  const { api } = makeApi(document)
  check('a header with no tree behind it resolves nothing',
    api.osDropPlan(header) === null)
}

{
  const missingRoot = new FakeElement('div', { 'data-files-state': 'tree' })
  const emptyRoot = new FakeElement('div', { 'data-files-state': 'tree', 'data-files-root': '' })
  const document = new FakeDocument()
  document.body.append(missingRoot, emptyRoot)
  const { api } = makeApi(document)
  check('a missing root is not resolved', api.osDropPlan(missingRoot) === null)
  check('an empty root is not resolved', api.osDropPlan(emptyRoot) === null)
}

{
  const localRoot = 'F:\\project'
  const localTree = makeTree(localRoot, [
    makeFileLike(null, 'file', `${localRoot}\\a.txt`).li,
  ])
  const { api, calls } = makeApi(localTree.document)
  const target = localTree.body.querySelector('[data-files-entry="file"]')
  const plan = api.osDropPlan(target)
  check('a local workspace is refused explicitly, not turned into a composer attachment',
    plan?.refusal === 'local' && plan?.root === localRoot,
    planText(plan))
  check('...and resolving a target queues nothing', calls.enqueues.length === 0)
}

// ---- the gesture's content -------------------------------------------------

console.log('\n[files versus folders]')
{
  const fake = new FakeElement('div')
  const labelled = { dataTransfer: { types: ['Files'] } }
  const lower = { dataTransfer: { types: ['files'] } }
  const text = { dataTransfer: { types: ['text/plain'] } }
  const none = {}
  const api = makeApi(new FakeDocument()).api
  check('`Files` is recognized', api.filesTransferOf(labelled) === labelled.dataTransfer)
  check('the comparison is case-insensitive', api.filesTransferOf(lower) === lower.dataTransfer)
  check('a plain text drag is not an OS drop', api.filesTransferOf(text) === null)
  check('an event without dataTransfer is not an OS drop', api.filesTransferOf(none) === null)
  void fake
  void none
}

{
  const api = makeApi(new FakeDocument()).api
  const fileA = { name: 'a.txt' }
  const fileB = { name: 'b.txt' }
  const folder = { name: 'album' }
  const transfer = {
    items: [
      { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) },
      { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false }) },
      { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false }) },
    ],
  }
  const split = api.splitDroppedFolders(transfer, [folder, fileA, fileB])
  check('one folder is refused and two files are kept',
    split.folders.length === 1 && split.files.length === 2,
    JSON.stringify({ folders: split.folders.length, files: split.files.length }))
  check('...and the kept files keep their order', split.files[0] === fileA && split.files[1] === fileB)

  const flat = api.splitDroppedFolders({}, [fileA, fileB])
  check('without an entry API every file is kept', flat.folders.length === 0 && flat.files.length === 2)

  const throws = {
    items: [{ kind: 'file', webkitGetAsEntry: () => { throw new Error('entry unavailable') } }],
  }
  const fallback = api.splitDroppedFolders(throws, [fileA])
  check('a throwing entry API degrades to a file, not a crash',
    fallback.folders.length === 0 && fallback.files.length === 1)
}

// ---- the one upload queue ---------------------------------------------------

console.log('\n[queueing and the oversize refusal]')
{
  const document = new FakeDocument()
  const { api, calls } = makeApi(document)
  const fileA = { name: 'a.txt' }
  const fileB = { name: 'b.txt' }
  const split = api.queueTreeUploads('qiyk', '/home/qiyk/dir', [fileA, fileB])
  check('one call queues the whole batch', split.accepted.length === 2)
  check('...with the exact host, directory and files',
    calls.enqueues.length === 1 &&
    calls.enqueues[0].alias === 'qiyk' &&
    calls.enqueues[0].dir === '/home/qiyk/dir' &&
    calls.enqueues[0].files.length === 2,
    JSON.stringify(calls.enqueues))
}

{
  const rejected = [{ name: 'too-big.bin' }]
  const accepted = [{ name: 'ok.txt' }]
  const document = new FakeDocument()
  const { api, calls } = makeApi(document, {
    enqueueUploads: (alias, dir, files) => {
      calls.enqueues.push({ alias, dir, files })
      return { accepted, rejected }
    },
  })
  api.queueTreeUploads('qiyk', '/home/qiyk/dir', [accepted[0], rejected[0]])
  check('the enqueue is called once', calls.enqueues.length === 1)
  check('...and a rejected file produces one oversize notice',
    calls.notices.length === 1 && calls.notices[0].text.startsWith('oversize:too-big.bin'),
    JSON.stringify(calls.notices))
}

console.log('\n[the refusal rides on the batch toast, never beside it]')
{
  const notes = []
  const document = new FakeDocument()
  const { api, calls } = makeApi(document, {
    enqueueUploads: (alias, dir, files, note) => {
      notes.push({ alias, dir, files, note })
      return { accepted: files, rejected: [] }
    },
  })
  const folder = { name: 'album' }
  const fileA = { name: 'a.txt' }
  api.queueTreeUploads('qiyk', '/home/qiyk/dir', [fileA], [folder])
  check('the refused folder is handed to the ONE enqueue as a note',
    notes.length === 1 && typeof notes[0].note === 'string' && notes[0].note.includes('album'),
    JSON.stringify(notes))
  check('...and it does NOT open a second toast of its own',
    calls.notices.length === 0,
    JSON.stringify(calls.notices))
  check('the note names the skipped folder, not the dropped one',
    notes[0].note.startsWith('osdrop.foldersSkipped'),
    notes[0].note)
}

{
  const notes = []
  const document = new FakeDocument()
  const { api } = makeApi(document, {
    enqueueUploads: (alias, dir, files, note) => {
      notes.push(note)
      return { accepted: files, rejected: [] }
    },
  })
  api.queueTreeUploads('qiyk', '/home/qiyk/dir', [{ name: 'a.txt' }])
  check('a drop without folders carries no note at all',
    notes.length === 1 && notes[0] === '',
    JSON.stringify(notes))
}

{
  // Folders alone: nothing is queued, so the refusal IS the outcome and must
  // still be said out loud.
  const onDrop = source.slice(
    source.indexOf('      const onDrop = (event) => {'),
    source.indexOf('      const onDragLeave = (event) => {'),
  )
  check('folders-only still reports the refusal',
    onDrop.includes("translate('osdrop.folders'") && onDrop.includes('SSHWSP-E-OSDROP-FOLDER'),
    'a gesture with nothing queued would otherwise be silent')
  check('...and the refusal is the ELSE branch of the queue call',
    onDrop.indexOf('} else if (split.folders.length > 0) {') > onDrop.indexOf('queueTreeUploads(plan.alias'),
    'a mixed drop must not open the standalone refusal')
  check('the mixed drop passes the folders to the one queue call',
    onDrop.includes('queueTreeUploads(plan.alias, plan.dir, split.files, split.folders)'),
    'the skipped folders have to reach the batch sentence')
}

console.log('\n[folder names]')
{
  const api = makeApi(new FakeDocument()).api
  const names = api.dropFolderNames([
    { name: 'one' }, { name: 'two' }, { name: 'three' }, { name: 'four' },
  ])
  check('four folders are summarized with three names and an ellipsis',
    names === 'one, two, three, \u2026',
    names)
}

// ---- the document-capture wiring -------------------------------------------

console.log('\n[the bridge brings the OS branch before the internal payload]')
{
  const onDragOver = source.slice(
    source.indexOf('      const onDragOver = (event) => {'),
    source.indexOf('      const onDrop = (event) => {'),
  )
  const onDrop = source.slice(
    source.indexOf('      const onDrop = (event) => {'),
    source.indexOf('      const onDragLeave = (event) => {'),
  )
  const onDragEnd = source.slice(
    source.indexOf('      const onDragEnd = (event) => {'),
    source.indexOf('      document.addEventListener(\'dragstart\'', source.indexOf('      const onDragEnd = (event) => {')),
  )
  const onDragEnter = source.slice(
    source.indexOf('      const onDragEnter = (event) => {'),
    source.indexOf('      const onDragOver = (event) => {'),
  )
  const onDragLeave = source.slice(
    source.indexOf('      const onDragLeave = (event) => {'),
    source.indexOf('      const onDragEnd = (event) => {'),
  )

  check('dragover reads the OS transfer before the internal payload guard',
    onDragOver.includes('const transfer = filesTransferOf(event)') &&
    onDragOver.indexOf('const transfer = filesTransferOf(event)') < onDragOver.indexOf('if (dragPayload === null)'),
    'the OS branch must not be gated by a stale internal payload')
  check('drop reads the OS transfer before the internal payload',
    onDrop.includes('const transfer = filesTransferOf(event)') &&
    onDrop.indexOf('const transfer = filesTransferOf(event)') < onDrop.indexOf('const payload ='),
    'the host attachment must never see a tree drop')
  const osDragOver = onDragOver.slice(0, onDragOver.indexOf('if (dragPayload === null)'))
  const osDrop = onDrop.slice(0, onDrop.indexOf('const payload ='))
  check('the OS branches stop the document event',
    /event\.preventDefault\(\)[\s\S]*event\.stopPropagation\(\)/u.test(osDragOver) &&
    /event\.preventDefault\(\)[\s\S]*event\.stopPropagation\(\)/u.test(osDrop),
    'preventDefault/stopPropagation are the two halves of the capture contract')
  check('the OS branches never call the composer inserter',
    !osDragOver.includes('addPathsToTask') && !osDrop.includes('addPathsToTask'),
    'composer insertion is a different gesture')
  check('dragover advertises a copy',
    onDragOver.includes("transfer.dropEffect = 'copy'"),
    'the OS branch must claim the drop')
  check('the local refusal runs before any queue call',
    onDrop.indexOf("plan.refusal === 'local'") >= 0 &&
    onDrop.indexOf('queueTreeUploads(plan.alias') > onDrop.indexOf("plan.refusal === 'local'"),
    'a local tree must never upload')
  check('a stale OS highlight is cleared by dragleave and dragend',
    onDragLeave.includes('clearOsDropHighlight()') &&
    onDragEnd.includes('clearOsDropHighlight()'),
    'a dismissed drag must not leave an outline behind')
  check('dragenter is registered and removed in capture phase',
    source.includes("document.addEventListener('dragenter', onDragEnter, true)") &&
    source.includes("document.removeEventListener('dragenter', onDragEnter, true)"),
    'a non-paired listener outlives the materialization')
  check('dragleave is registered and removed in capture phase',
    source.includes("document.addEventListener('dragleave', onDragLeave, true)") &&
    source.includes("document.removeEventListener('dragleave', onDragLeave, true)"),
    'a non-paired listener outlives the materialization')
  check('dragenter kills stale internal state before deciding the target',
    onDragEnter.includes('dragPayload = null') &&
    onDragEnter.includes('osDropPlan(event.target)'),
    'an OS gesture must not inherit an internal payload')
}

console.log('\n[the picker and the drop share one enqueue]')
{
  const upload = functionText('uploadTreeRow')
  check('the row picker routes through queueTreeUploads',
    upload.includes('queueTreeUploads(parts.alias, dir, files)'))
  check('...instead of its own split/enqueue copy',
    !upload.includes('enqueueUploads('),
    'the picker and the drop must not report oversize differently')
  const helper = source.indexOf('function queueTreeUploads (')
  const header = source.indexOf('function FilePanelTransferActions (props)')
  check('the shared upload helper lives outside the header component slice',
    helper >= 0 && header > helper,
    'tree-transfer-smoke pins that the header has no upload intake')
}

console.log('\n[one implementation of the folder test]')
{
  const splitter = functionText('splitDroppedFolders')
  check('webkitGetAsEntry is mentioned exactly once in the client source',
    (source.match(/webkitGetAsEntry/gu) ?? []).length === 1,
    `${(source.match(/webkitGetAsEntry/gu) ?? []).length} occurrences`)
  check('...and it is inside the splitter', splitter.includes('webkitGetAsEntry'))
  check('the tree OS selector is one constant',
    (source.match(/const OS_TREE_SELECTOR/gu) ?? []).length === 1)
  check('the OS highlight marker is one constant',
    (source.match(/const OS_DROP_ATTR/gu) ?? []).length === 1)
}

console.log('\n[highlight ownership]')
{
  const folder = makeDirectory(null, 'ssh://qiyk/home/qiyk/one', { expanded: true })
  const other = makeDirectory(null, 'ssh://qiyk/home/qiyk/two', { expanded: true })
  const tree = makeTree('ssh://qiyk/home/qiyk', [folder.li, other.li])
  const { api } = makeApi(tree.document)
  const first = api.osDropPlan(folder.button)
  const second = api.osDropPlan(other.button)
  api.setOsDropHighlight(first)
  check('the target carries the marker and an inline outline',
    folder.button.hasAttribute('data-sshwsp-osdrop') &&
    folder.button.style.getPropertyValue('outline').startsWith('2px solid'),
    JSON.stringify({ attr: folder.button.hasAttribute('data-sshwsp-osdrop'), outline: folder.button.style.getPropertyValue('outline') }))
  api.setOsDropHighlight(second)
  check('a new target clears the previous outline',
    !folder.button.hasAttribute('data-sshwsp-osdrop') &&
    other.button.hasAttribute('data-sshwsp-osdrop'))
  api.clearOsDropHighlight()
  check('clearing removes the marker and the inline style',
    !other.button.hasAttribute('data-sshwsp-osdrop') &&
    other.button.style.getPropertyValue('outline') === '' &&
    other.button.style.getPropertyValue('outline-offset') === '')
}

console.log(`\n=== ${passed} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
