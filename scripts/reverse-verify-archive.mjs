/**
 * Reverse verification for the archive writer, the exclude rules and the
 * transfer-completion notice.
 *
 * Run: node scripts/reverse-verify-archive.mjs
 *
 * Each mutation must turn at least one assertion in `tests/archive-smoke.mjs`
 * RED. A mutation that leaves the suite green proves the assertion was never
 * exercising the behaviour.
 *
 * ## Why the files are written with `writeFileSync(..., 'utf8')`
 *
 * An earlier version of this script shelled out to PowerShell's `Set-Content`,
 * which re-encodes through the machine's ANSI code page. On a Chinese Windows
 * that is GBK, and it destroyed every non-ASCII character in four source files —
 * 278 in `client.js` alone. The damage is not reversible (a probe confirmed
 * U+FFFD cannot be mapped back), and repairing it took longer than the
 * verification was worth. Everything here is therefore done in Node, with an
 * explicit encoding, and the damaged-UTF-8 count is asserted to be zero after
 * each restore.
 *
 * ## Why a crash is not a pass
 *
 * A suite that dies on import produces no `FAIL` line. Counting only `FAIL`
 * lines would then read as "the mutation was not caught" (GREEN), which is the
 * opposite of the truth — the test never ran. The runner below therefore
 * distinguishes three outcomes: RED (a FAIL line), CRASH (non-zero exit with no
 * FAIL line) and GREEN (exit 0).
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stubs = path.join(root, 'tests', '.peer-stubs', 'node_modules')
const coreRoot = process.env.DSH_CORE_ROOT ?? stubs
if (!path.isAbsolute(coreRoot)) {
  console.error(`reverse-verify-archive: DSH_CORE_ROOT must be an absolute path, got ${JSON.stringify(coreRoot)}`)
  process.exit(1)
}

const MUTATIONS = [
  {
    name: 'the tar size field is written in DECIMAL (the bug a real reader caught)',
    file: 'lib/tar.js',
    find: '  const digits = Math.max(0, Math.trunc(value)).toString(8)',
    replace: '  const digits = String(Math.max(0, Math.trunc(value)))',
    suite: 'archive',
  },
  {
    name: 'the tar mtime is written in decimal',
    file: 'lib/tar.js',
    find: '  writeOctal(header, 136, 12, Math.max(0, Math.trunc(entry.mtime ?? 0)))',
    replace: "  header.write(String(Math.max(0, Math.trunc(entry.mtime ?? 0))).padStart(11, '0') + '\\0', 136, 12, 'ascii')",
    suite: 'archive',
  },
  {
    name: 'a short entry is emitted instead of refused',
    file: 'lib/tar.js',
    find: '    if (written !== size) {',
    replace: '    if (false) {',
    suite: 'archive',
  },
  {
    name: 'a file past 100 bytes is silently truncated instead of split',
    file: 'lib/tar.js',
    find: "  if (name <= 100) return { prefix: '', name: path }",
    replace: "  return { prefix: '', name: path.slice(0, 100) }",
    suite: 'archive',
  },
  {
    name: 'the exclusion rules become first-match-wins (a re-include stops working)',
    file: 'lib/tree-filter.js',
    find: '      let verdict\n      for (const rule of compiled) {\n        if (rule.test(path, isDir)) verdict = !rule.include\n      }\n      return verdict === true',
    replace: '      return compiled.some(rule => !rule.include && rule.test(path, isDir))',
    suite: 'archive',
  },
  {
    name: "an anchored rule stops matching its own path",
    file: 'lib/tree-filter.js',
    find: "        if (pattern.test(clean)) return true\n        let cut = clean.lastIndexOf('/')",
    replace: "        if (pattern.test(clean)) return false\n        let cut = clean.lastIndexOf('/')",
    suite: 'archive',
  },
  {
    name: 'the glob compiles to a substring match instead of an anchored one',
    file: 'lib/tree-filter.js',
    find: "  return new RegExp(`^${out}$`, 'u')",
    replace: "  return new RegExp(out, 'u')",
    suite: 'archive',
  },
  {
    name: 'the tar walk ignores the exclude rules',
    file: 'lib/transfer.js',
    // The anchor extends past the filter into the tar walk's own `yield`, and
    // that matters: `downloadTree`'s walk contains the SAME filter lines, so a
    // shorter anchor is replaced in the wrong function — the mutation then
    // applies, the archive suite stays green (correctly, since nothing in the
    // archive path changed), and the report says "not covered".
    find: '      if (filter.excluded(relativeForRule(remotePath, source), isDirectory)) {\n        excluded += 1\n        continue\n      }\n      if (isDirectory) {\n        yield { path: relative, type: \'5\'',
    replace: '      if (false) {\n        excluded += 1\n        continue\n      }\n      if (isDirectory) {\n        yield { path: relative, type: \'5\'',
    suite: 'archive',
  },
  {
    name: 'the archive silently omits the skips instead of reporting them',
    file: 'lib/transfer.js',
    find: '    if (links.length === 0 && excluded === 0) return',
    replace: '    if (true) return',
    suite: 'archive',
  },
  {
    name: 'downloadTreeAsTar returns RAW ENTRIES instead of archive bytes',
    file: 'lib/transfer.js',
    find: "  return { stream: format === 'tar' ? tarStream(archiveEntries()) : zipStream(archiveEntries()), format }",
    replace: "  return { stream: archiveEntries(), format }",
    suite: 'archive',
  },
  {
    name: 'a symlink inside the tree is followed into the archive',
    file: 'lib/transfer.js',
    find: "      if (typeof attrs.isSymbolicLink === 'function' && attrs.isSymbolicLink() === true) {\n        links.push(source)\n        continue\n      }\n      const isDirectory = typeof attrs.isDirectory === 'function' && attrs.isDirectory() === true\n      if (filter.excluded(relativeForRule(remotePath, source), isDirectory)) {",
    replace: "      const isDirectory = typeof attrs.isDirectory === 'function' && attrs.isDirectory() === true\n      if (filter.excluded(relativeForRule(remotePath, source), isDirectory)) {",
    suite: 'archive',
  },
  {
    // The BEHAVIOUR is pinned by the `transferNotice` assertions (one node,
    // edited in place, timer armed at completion). This mutation attacks the
    // other half — whether the tree-row upload actually USES that handle — and
    // the assertion that catches it is necessarily a source check, because the
    // call site lives inside `sendTreeUpload`, which needs a live `fetch` and
    // DOM to run. Saying that plainly beats pretending the behavioural test
    // covers a wiring change it cannot see.
    name: 'the tree-row upload goes back to two separate toasts',
    file: 'lib/client.js',
    find: "      transferQueueNotice = { handle: transferNotice(line), ids: new Set(items.map(item => item.id)), line }",
    replace: "      notifyUser(toastError(line))\n      transferQueueNotice = null",
    suite: 'archive',
  },
  {
    name: 'a completion notice survives navigation',
    file: 'lib/client.js',
    find: "function TransferQueuePanel ({ anchor, onClose, t }) {\n      const queue = useTransferQueue()",
    replace: "function TransferQueuePanel ({ anchor, onClose, t }) {\n      const queue = transferQueueState",
    suite: 'archive',
  },
  {
    name: 'the upload reports the LOCAL file size instead of what landed',
    file: 'lib/client.js',
    find: "        const landed = typeof parsed?.bytes === 'number' && Number.isFinite(parsed.bytes) ? parsed.bytes : file.size",
    replace: "        const landed = file.size",
    suite: 'archive',
  },
  {
    name: 'the completion line is moved behind the modal backdrop as a toast',
    file: 'lib/client.js',
    find: "    function TransferQueuePanel ({ anchor, onClose, t }) {",
    replace: "    function TransferQueueInline () {}\n    function TransferQueuePanel ({ anchor, onClose, t }) {",
    suite: 'archive',
  },
  {
    // The whole point of asking first: activation is spent by the first network
    // round trip, so a picker asked for afterwards fails exactly on the large
    // transfers where a destination matters.
    name: 'the destination is chosen AFTER the bytes arrive',
    file: 'lib/client.js',
    find: "      const target = await pickFileTarget(suggested)\n      if (target.kind === 'canceled') return",
    replace: "      await Promise.resolve()\n      const target = await pickFileTarget(suggested)\n      if (target.kind === 'canceled') return",
    suite: 'archive',
  },
  {
    name: 'a cancelled picker still fetches the file',
    file: 'lib/client.js',
    find: "      const target = await pickFileTarget(suggested)\n      if (target.kind === 'canceled') return",
    replace: "      const target = await pickFileTarget(suggested)",
    suite: 'archive',
  },
  {
    // Closing instead of aborting publishes a truncated file under the name the
    // user chose, which reads as a successful download.
    name: 'a failed write CLOSES the file instead of aborting it',
    file: 'lib/client.js',
    find: '        try { await writable.abort() } catch { /* already closed */ }',
    replace: '        try { await writable.close() } catch { /* already closed */ }',
    suite: 'archive',
  },
  {
    name: 'the fallback claims a save it cannot observe',
    file: 'lib/client.js',
    find: "      'transfer.downloadStarted': '已开始下载 {name}（{size}），保存位置由浏览器决定',",
    replace: "      'transfer.downloadStarted': '已下载 {name}（{size}）',",
    suite: 'archive',
  },
  {
    name: 'a picker refusal is collapsed into a cancel',
    file: 'lib/client.js',
    find: "        if (err?.name === 'AbortError') return { kind: 'canceled' }\n        return { kind: 'unsupported' }",
    replace: "        return { kind: 'canceled' }",
    suite: 'archive',
  },
]

/** How many U+FFFD characters a file holds, as a UTF-8 damage witness. */
function damagedCount (text) {
  return (text.match(/\uFFFD/gu) ?? []).length
}

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
  let result
  try {
    writeFileSync(file, original.replace(mutation.find, mutation.replace), 'utf8')
    result = spawnSync(process.execPath, [path.join(root, 'tests', `${mutation.suite}-smoke.mjs`)], {
      cwd: root,
      env: { ...process.env, DSH_CORE_ROOT: coreRoot, DSH_PEER_ROOT: coreRoot },
      encoding: 'utf8',
    })
  } finally {
    writeFileSync(file, original, 'utf8')
    // Prove the restore is byte-exact rather than merely close: a lossy
    // round-trip here would corrupt the file this script is meant to protect.
    if (readFileSync(file, 'utf8') !== original) {
      console.log(`  CORRUPT ${mutation.file} did not restore exactly`)
      failures += 1
    }
  }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  // `m` is not optional: without it `^` matches only at offset 0, and an earlier
  // sibling script counted ZERO failures for every mutation while reporting
  // GREEN for all of them.
  const red = (output.match(/^ {2}FAIL/mgu) ?? []).length
  const crashed = result.status !== 0 && red === 0
  if (red > 0) {
    console.log(`  RED     ${mutation.name} (${red} assertion(s))`)
  } else if (crashed) {
    console.log(`  CRASH   ${mutation.name}  <-- the suite died without asserting anything`)
    console.log(`          ${output.split('\n').find(line => line.trim() !== '') ?? ''}`)
    failures += 1
  } else {
    console.log(`  GREEN   ${mutation.name}  <-- the tests do not cover this`)
    failures += 1
  }
}

const after = ['lib/tar.js', 'lib/tree-filter.js', 'lib/transfer.js', 'lib/client.js']
  .map(name => [name, damagedCount(readFileSync(path.join(root, name), 'utf8'))])
  .filter(([, count]) => count > 0)
if (after.length > 0) {
  console.log(`\n  CORRUPT  UTF-8 damage after the run: ${JSON.stringify(after)}`)
  failures += 1
}

console.log()
if (failures > 0) {
  console.log(`=== ${failures} problem(s) ===`)
  process.exit(1)
}
console.log(`=== all ${MUTATIONS.length} mutations turned red ===`)
