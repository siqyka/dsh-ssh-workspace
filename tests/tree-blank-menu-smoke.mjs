/**
 * The local blank-space resolver and the menu contract.
 *
 * The host tree is DSH-owned DOM. This suite lifts the shipped
 * `localBlankTargetOf` helper and drives it against the same fake tree shape
 * `tree-select-smoke` uses: nearest expanded directory row, otherwise the
 * root; local roots only; and nothing outside the root. The menu itself is a
 * DOM overlay whose real acceptance is the GUI pass, so its source contract
 * (exactly two items, copy always available) is pinned here.
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
  'normalizeRoot', 'localPathWithin', 'localBlankTargetOf', 'treeContainerOf', 'treeSessionOfContainer',
  `
  ${functionText('normalizeRoot')}
  ${functionText('localPathWithin')}
  ${functionText('localBlankTargetOf')}
  ${functionText('treeContainerOf')}
  ${functionText('treeSessionOfContainer')}
  return { localBlankTargetOf, localPathWithin }
  `,
)
const api = factory(
  Object,
  '[data-files-entry][data-files-path]',
  '[data-files-body]',
  remoteTargetOf,
)

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
  const dom = makeTreeDom()
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
  const dom = makeTreeDom()
  const built = buildTree(dom, 'C:\\work\\project')
  const outside = addRow(dom, built.list, 'directory', 'C:/work2/elsewhere')
  const nested = dom.make({ tag: 'ul' })
  outside.row.appendChild(nested)
  check('a directory outside the root is refused', api.localBlankTargetOf(nested) === null)
  check('a root that is not a prefix is refused', !api.localPathWithin('C:/work', 'C:/work2'))

  const remote = makeTreeDom()
  const remoteTree = buildTree(remote, 'ssh://qiyk/home/qiyk/test')
  addRow(remote, remoteTree.list, 'directory', 'ssh://qiyk/home/qiyk/test/sub')
  check('a remote tree does not enter the local blank path',
    api.localBlankTargetOf(remoteTree.list) === null)
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

console.log(`\n=== ${passed} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
