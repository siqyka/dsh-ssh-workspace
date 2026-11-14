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
 * its source contract (exactly two items, copy always available) is pinned here.
 *
 * Run: node tests/tree-blank-menu-smoke.mjs
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeTreeDom } from './support/tree-dom.mjs'

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

console.log('\n=== tree blank menu smoke ===\n')

/** Pull one function declaration out of the bundle by brace matching. */
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
  check('the local blank menu creates exactly two items',
    (menu.match(/createTransferItem\(/gu) ?? []).length === 2,
    `items=${(menu.match(/createTransferItem\(/gu) ?? []).length}`)
  check('...new folder and copy path, and nothing else',
    menu.includes("translate('rowmenu.newFolder')") &&
    menu.includes("translate('rowmenu.copyPath')") &&
    !/rowmenu\.(rename|delete|upload|download)|transfer\.(download|upload)|createMenuSeparator/u.test(menu))
  check('...new folder asks the shared dialog for the resolved directory',
    /requestRowNewFolder\(\{ path: dir, root, sessionId, row: null, container \}\)/u.test(menu))
  check('...copy always works, while only create is disabled by policy',
    menu.includes("create.disabled = true") &&
    !/copy\.disabled|copy\.title/u.test(menu) &&
    menu.includes('mutationPolicyOf({ sessionId, root })'))
  check('a row point that is not a nested list keeps the row menu',
    /const nestedBlank = !onButton && row\.getAttribute\('data-files-entry'\) === 'directory'/u.test(source) &&
    /if \(!nestedBlank\) \{\n\s+if \(!openForRow\(row, event\)\) return/u.test(source))
  check('the shared menu lifecycle owns the dismissal listeners',
    /function openMenuAt \(x, y, fill\)/.test(source) &&
    /const local = localBlankTargetOf\(target\)/.test(source) &&
    /openLocalBlankMenu\(local, event\.clientX, event\.clientY\)/.test(source))
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

console.log(`\n=== ${passed} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
