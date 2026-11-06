/**
 * Reverse verification for the tree-upload conflict policy and the shared size
 * limit.
 *
 * Run: node scripts/reverse-verify-tree-conflict.mjs
 *
 * Each mutation must turn at least one assertion RED. A mutation that leaves the
 * suite green proves the test was never exercising the behaviour — which is the
 * failure mode this repository has shipped four times.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stubs = path.join(root, 'tests', '.peer-stubs', 'node_modules')

const MUTATIONS = [
  {
    name: 'uploadTree ignores onConflict again (the original bug)',
    file: 'lib/transfer.js',
    find: '  const policy = normalizeConflictPolicy(options.onConflict)',
    replace: "  const policy = normalizeConflictPolicy(undefined)",
  },
  {
    name: 'the tree decision reads the SOURCE path instead of the remote one',
    file: 'lib/transfer.js',
    find: '          exists: await remoteExists(engine, alias, target),',
    replace: '          exists: await remoteExists(engine, alias, source),',
  },
  {
    name: 'refuse degrades to overwrite',
    file: 'lib/transfer.js',
    find: "        if (decision.action === 'refuse') throw new Error(decision.note ?? `the destination already exists: ${target}`)",
    replace: "        if (decision.action === 'refuse') { /* mutated */ }",
  },
  {
    name: 'skip is counted but still uploaded',
    file: 'lib/transfer.js',
    find: "        if (decision.action === 'skip') {\n          skipped += 1\n          continue\n        }",
    replace: "        if (decision.action === 'skip') {\n          skipped += 1\n        }",
  },
  {
    name: 'rename collapses into overwrite',
    file: 'lib/transfer.js',
    find: '        const result = await uploadFile(engine, { alias, localPath: source, remotePath: decision.path ?? target, roots, signal })',
    replace: '        const result = await uploadFile(engine, { alias, localPath: source, remotePath: target, roots, signal })',
  },
  {
    name: 'the refuse pre-pass never runs',
    file: 'lib/transfer.js',
    find: '    if (policy !== \'refuse\') return',
    replace: '    return',
  },
  {
    name: 'the refuse pre-pass stops at the top directory',
    file: 'lib/transfer.js',
    find: '          await scan(path.join(from, entry.name), target)',
    replace: '          /* mutated: do not descend */',
  },
  {
    name: 'the shared limit drifts to 2 GiB',
    file: 'lib/transfer.js',
    find: 'export const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024',
    replace: 'export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024',
  },
  {
    name: 'routes.js hard-codes its own copy of the limit',
    file: 'lib/routes.js',
    find: "import { DEFAULT_MAX_BYTES, fenceUploadTarget, oversizeMessage, remoteParentOf, sftpUnlink, stagingNameOf, transferFile, uploadTree } from './transfer.js'",
    replace: "import { fenceUploadTarget, oversizeMessage, remoteParentOf, sftpUnlink, stagingNameOf, transferFile, uploadTree } from './transfer.js'\nconst DEFAULT_MAX_BYTES = 1024 * 1024 * 1024",
  },
  {
    name: 'the browser upload stops bounding the running total',
    file: 'lib/routes.js',
    find: '        if (written > DEFAULT_MAX_BYTES) throw codedError(oversizeMessage(\'upload\', written), \'FS_TOO_LARGE\')',
    replace: '        /* mutated: no running-total check */',
  },
  {
    name: 'the browser upload drops the declared-length pre-check',
    file: 'lib/routes.js',
    find: '  if (Number.isFinite(declared) && declared > DEFAULT_MAX_BYTES) {',
    replace: '  if (false) {',
  },
  {
    name: 'the browser download stops bounding the file size',
    file: 'lib/routes.js',
    find: '          if (size > DEFAULT_MAX_BYTES) {',
    replace: '          if (false) {',
  },
  {
    name: 'the oversize refusal answers 500 instead of 413',
    file: 'lib/routes.js',
    find: "    case 'FS_TOO_LARGE': return 413",
    replace: "    case 'FS_TOO_LARGE': return 500",
  },
]

let failures = 0
for (const mutation of MUTATIONS) {
  const file = path.join(root, mutation.file)
  const original = readFileSync(file, 'utf8')
  if (!original.includes(mutation.find)) {
    console.log(`  BROKEN  ${mutation.name}`)
    console.log(`          the anchor text does not exist in ${mutation.file} — this mutation never applied`)
    failures += 1
    continue
  }
  writeFileSync(file, original.replace(mutation.find, mutation.replace), 'utf8')
  let result
  try {
    result = spawnSync(process.execPath, [path.join(root, 'tests', 'transfer-smoke.mjs')], {
      cwd: root,
      env: { ...process.env, DSH_CORE_ROOT: stubs, DSH_PEER_ROOT: stubs },
      encoding: 'utf8',
    })
  } finally {
    writeFileSync(file, original, 'utf8')
  }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  // A crashed suite also "fails", so require an actual FAIL line: a mutation
  // that breaks the module into not loading proves nothing about the assertion.
  //
  // The `m` flag is not optional. Without it `^` only matches at offset 0, so
  // this counted ZERO failures for every mutation and reported GREEN for all
  // thirteen — a reverse-verification script that always passes is worse than
  // none, because it is read as evidence.
  const red = (output.match(/^ {2}FAIL/mgu) ?? []).length
  if (red > 0) {
    console.log(`  RED     ${mutation.name} (${red} assertion(s))`)
  } else {
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
