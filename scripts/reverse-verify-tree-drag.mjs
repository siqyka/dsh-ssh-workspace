/**
 * Reverse verification for the three behaviours this round added: the local
 * blank menu, the multi-selection drag, and the local mkdir branch.
 *
 * Run: node scripts/reverse-verify-tree-drag.mjs
 *
 * A mutation must turn at least one assertion RED. The suites here mix a lifted
 * function body with a source contract, so a mutation that only makes the file
 * unparseable proves nothing — the counts below are real FAIL lines.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stubs = path.join(root, 'tests', '.peer-stubs', 'node_modules')

const MUTATIONS = [
  {
    name: 'the blank menu resolves the tree root instead of the nearest directory',
    file: 'lib/client.js',
    find: "      const dir = dirRow === null ? root : dirRow.getAttribute('data-files-path')",
    replace: '      const dir = root',
    suite: 'tree-blank-menu',
  },
  {
    name: 'the blank menu stops fencing the target inside the root',
    file: 'lib/client.js',
    find: "      if (dir === null || dir === '' || !localPathWithin(root, dir)) return null",
    replace: "      if (dir === null || dir === '') return null",
    suite: 'tree-blank-menu',
  },
  {
    name: 'a directory row button counts as blank space',
    file: 'lib/client.js',
    find: '        if (ownButton !== null && ownButton.contains(target)) return null',
    replace: '        if (ownButton === null) return null',
    suite: 'tree-blank-menu',
  },
  {
    name: 'a remote root enters the local blank path',
    file: 'lib/client.js',
    find: "      if (root === null || root === '' || remoteTargetOf(root) !== null) return null",
    replace: "      if (root === null || root === '') return null",
    suite: 'tree-blank-menu',
  },
  {
    name: 'the blank menu grows a third item',
    file: 'lib/client.js',
    find: "        const copy = createTransferItem({",
    replace: "        const extra = createTransferItem({ label: 'x', glyph: 'copy', onSelect: () => {} })\n        const copy = createTransferItem({",
    suite: 'tree-blank-menu',
  },
  {
    name: 'the blank menu disables copy in a read-only session',
    file: 'lib/client.js',
    find: '          create.disabled = true',
    replace: '          create.disabled = true\n          copy.disabled = true',
    suite: 'tree-blank-menu',
  },
  {
    name: 'the nested list of an expanded directory stops being blank space',
    file: 'lib/client.js',
    find: "          const nestedBlank = !onButton && row.getAttribute('data-files-entry') === 'directory'",
    replace: "          const nestedBlank = false",
    suite: 'tree-blank-menu',
  },
  {
    name: 'the drag carries one path again instead of the target set',
    file: 'lib/client.js',
    find: '          transfer.setData(DRAG_MIME, JSON.stringify(payload))',
    replace: '          transfer.setData(DRAG_MIME, path)',
    suite: 'tree-drag',
  },
  {
    name: 'the drop inserts only the first item',
    file: 'lib/client.js',
    find: '        addPathsToTask(ctx, payload.items, payload.root, card, at)',
    replace: '        addPathsToTask(ctx, payload.items.slice(0, 1), payload.root, card, at)',
    suite: 'tree-drag',
  },
  {
    name: 'the row menu drops the target set and inserts the clicked row alone',
    file: 'lib/client.js',
    find: '        onSelect: () => addPathsToTask(ctx, targets, root),',
    replace: '        onSelect: () => addPathsToTask(ctx, [{ path: absPath, isDir }], root),',
    suite: 'tree-drag',
  },
  {
    name: 'the batch inserter focuses per item instead of once',
    file: 'lib/client.js',
    find: '      if (added > 0) focusSoleComposer(card)',
    replace: '      if (added > 0) focusSoleComposer(card)\n      if (added > 0) focusSoleComposer(card)',
    suite: 'tree-drag',
  },
  {
    name: 'duplicate paths are no longer collapsed',
    file: 'lib/client.js',
    find: '        if (seen.has(item.path)) continue',
    replace: '        if (seen.has(item.path)) { /* mutated */ }',
    suite: 'tree-drag',
  },
  {
    name: 'a partial failure aborts the whole batch',
    file: 'lib/client.js',
    find: '        if (applied) added += 1\n        else failures.push({ name: entryNameOf(item.path), reason: \'insert\' })',
    replace: '        if (applied) added += 1\n        else { failures.push({ name: entryNameOf(item.path), reason: \'insert\' }); break }',
    suite: 'tree-drag',
  },
  {
    name: 'the drop forgets which card received it',
    file: 'lib/client.js',
    find: '        addPathsToTask(ctx, payload.items, payload.root, card, at)',
    replace: '        addPathsToTask(ctx, payload.items, payload.root, null, at)',
    suite: 'tree-drag',
  },
  {
    name: 'a shared title marks the local row again (the title rule loses its local half)',
    file: 'lib/client.js',
    find: "      return text !== '' && remoteMarks.titles.has(text) && !remoteMarks.localTitles.has(text)",
    replace: "      return text !== '' && remoteMarks.titles.has(text)",
    suite: 'client-shape',
  },
  {
    name: 'the detached rule loses its local half, so a local twin goes inert',
    file: 'lib/client.js',
    find: "      return text !== '' && remoteMarks.disabledTitles.has(text) && !remoteMarks.localTitles.has(text)",
    replace: "      return text !== '' && remoteMarks.disabledTitles.has(text)",
    suite: 'client-shape',
  },
  {
    name: 'an unsettled title rule marks anyway',
    file: 'lib/client.js',
    find: "      if (!remoteMarks.titlesSettled) return false\n      return text !== '' && remoteMarks.titles.has(text)",
    replace: "      return text !== '' && remoteMarks.titles.has(text)",
    suite: 'client-shape',
  },
  {
    name: 'the sidebar row forgets its id and matches on title alone',
    file: 'lib/client.js',
    find: "remoteMarks.ids.has(id) || remoteTitleMatch(title))",
    replace: "remoteTitleMatch(title))",
    suite: 'client-shape',
  },
  {
    name: 'the local mkdir branch reads its root from the request',
    file: 'lib/routes.js',
    find: '  const root = localRootOf(owner)',
    replace: '  const root = body.root ?? localRootOf(owner)',
    suite: 'mutations',
  },
  {
    name: 'the local mkdir branch skips the realpath parent check',
    file: 'lib/routes.js',
    find: '  if (!isWithinLocalRoot(realRoot, realParent)) {',
    replace: '  if (false) {',
    suite: 'mutations',
  },
  {
    name: 'the local mkdir branch adopts a remote session workspace',
    file: 'lib/routes.js',
    find: "  if (isRemotePath(root)) {\n    throw codedError('the session workspace is remote; a local path cannot belong to it', 'FS_PERMISSION_DENIED')\n  }",
    replace: '  if (false) { /* mutated */ }',
    suite: 'mutations',
  },
  {
    name: 'the first drop item ignores the pointer offset',
    file: 'lib/client.js',
    find: '      let pendingAt = at !== null && Number.isInteger(at) && at >= 0 ? at : null',
    replace: '      let pendingAt = null',
    suite: 'composer-drop-point',
  },
  {
    name: 'the pointer offset is reused after the first attempt',
    file: 'lib/client.js',
    find: '        if (usedAt) pendingAt = null',
    replace: '        if (false) pendingAt = null',
    suite: 'composer-drop-point',
  },
  {
    name: 'a managed empty-block linebreak counts as a character',
    file: 'lib/client.js',
    find: "        return composerHasAttribute(node, 'data-lexical-managed-linebreak') ? 0 : 1",
    replace: "        return composerHasAttribute(node, 'data-lexical-managed-linebreak') ? 1 : 1",
    suite: 'composer-drop-point',
  },
  {
    name: 'a chip is counted by its label instead of atomically',
    file: 'lib/client.js',
    find: "      if (composerHasAttribute(node, 'data-composer-chip')) return 1",
    replace: "      if (false) return 1",
    suite: 'composer-drop-point',
  },
  {
    name: 'the caret inside a chip ignores the pointer half',
    file: 'lib/client.js',
    find: '        return before + (Number(clientX) > middle ? 1 : 0)',
    replace: '        return before',
    suite: 'composer-drop-point',
  },
  {
    name: 'the multi-composer guard is dropped',
    file: 'lib/client.js',
    find: '        if (input !== soleComposerInput()) return null',
    replace: '        if (false) return null',
    suite: 'composer-drop-point',
  },
  {
    name: 'top-level block gaps lose one newline',
    file: 'lib/client.js',
    find: '        if (index > 0) at += 1',
    replace: '        if (index > 1) at += 1',
    suite: 'composer-drop-point',
  },
  {
    name: 'the drag end leaves the drop caret visible',
    file: 'lib/client.js',
    find: [
      '        hideDropCaret()',
      '        clearTreeTextSelection()',
    ].join('\n'),
    replace: '        clearTreeTextSelection()',
    suite: 'composer-drop-point',
  },
]

let failures = 0
const fileCache = new Map()
for (const mutation of MUTATIONS) {
  const file = path.join(root, mutation.file)
  const original = fileCache.get(file) ?? readFileSync(file, 'utf8')
  fileCache.set(file, original)
  if (!original.includes(mutation.find)) {
    console.log(`  BROKEN  ${mutation.name}`)
    console.log(`          the anchor text does not exist in ${mutation.file} — this mutation never applied`)
    failures += 1
    continue
  }
  writeFileSync(file, original.replace(mutation.find, mutation.replace), 'utf8')
  let result
  try {
    result = spawnSync(process.execPath, [path.join(root, 'tests', `${mutation.suite}-smoke.mjs`)], {
      cwd: root,
      env: { ...process.env, DSH_CORE_ROOT: stubs, DSH_PEER_ROOT: stubs },
      encoding: 'utf8',
    })
  } finally {
    writeFileSync(file, original, 'utf8')
  }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const red = (output.match(/^ {2}FAIL/mgu) ?? []).length
  if (red > 0) console.log(`  RED     ${mutation.name} (${red} assertion(s))`)
  else {
    console.log(`  GREEN   ${mutation.name}  <-- the tests do not cover this`)
    failures += 1
  }
}

console.log()
if (failures > 0) {
  console.log(`=== ${failures} mutation(s) did NOT turn red ===`)
  process.exit(1)
}
console.log(`=== all ${MUTATIONS.length} mutations turned red ===`)
