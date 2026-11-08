/**
 * Behaviour checks for the archive writer and the exclude rules.
 *
 * ## Why these two modules share a suite
 *
 * They are the two pieces `downloadTreeAsTar` is built from, and neither is
 * reachable through a route without a live host: the tar writer is pure, and the
 * rule matcher is pure. Testing them here means the failure modes that matter —
 * a header field written as decimal instead of octal, a rule that matches a
 * substring instead of a segment — are caught without an SSH server.
 *
 * ## The tar fixture is checked against a REAL reader
 *
 * A hand-written tar writer whose verification is another hand-written parser
 * proves only that the two agree. The assertions below therefore ALSO decode with
 * `python -m tarfile` when a Python interpreter is available, and say so when it
 * is not. That is not decoration: the first version of `tar.js` wrote the size
 * field in DECIMAL, every byte-level assertion here passed, and the archive was
 * unreadable — `tar -tvf` said "Unrecognized archive format".
 *
 * Run: node tests/archive-smoke.mjs
 */

import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')

const { BLOCK, splitTarName, tarHeader, tarPadding, tarStream } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'tar.js')).href)
const { globToRegExp, relativeForRule, treeFilter } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'tree-filter.js')).href)
// The toast helpers are lifted from the shipped bundle by a shared harness so
// this suite and `client-shape-smoke` drive the SAME code rather than two
// retyped copies.
const { liftToasts } = await import(pathToFileURL(path.join(pluginRoot, 'tests', 'support', 'toast-dom.mjs')).href)
// `transfer.js` reaches the shared SFTP primitives, which resolve the DSH peer
// packages — so only the part of this suite that drives `downloadTreeAsTar`
// needs an assembled tree. The tar writer and the rule matcher are pure and run
// everywhere, which is the whole reason they are separate modules.
const coreRoot = process.env.DSH_CORE_ROOT
let downloadTreeAsTar
let tarNameOf
if (coreRoot !== undefined && coreRoot !== '') {
  process.env.DSH_PEER_ROOT = [coreRoot, process.env.DSH_PEER_ROOT].filter(Boolean).join(path.delimiter)
  const transfer = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'transfer.js')).href)
  downloadTreeAsTar = transfer.downloadTreeAsTar
  tarNameOf = transfer.tarNameOf
}

let passed = 0
const failures = []
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** Collect an entire archive into one buffer. */
async function collect (entries) {
  const parts = []
  for await (const chunk of tarStream(entries())) parts.push(chunk)
  return Buffer.concat(parts)
}

/**
 * Read the numeric field of a header the way a tar reader does: octal.
 *
 * Deliberately NOT `parseInt(text)` — that would accept a decimal field and hide
 * the bug this suite exists to catch.
 */
function octalField (block, offset, width) {
  const text = block.subarray(offset, offset + width).toString('ascii').replace(/\0.*$/su, '').trim()
  return text === '' ? 0 : Number.parseInt(text, 8)
}

console.log('\n=== archive smoke ===\n')

// --------------------------------------------------------------- the header
console.log('[tar headers]')

{
  const block = tarHeader({ path: 'a.txt', size: 1234, mtime: 1700000000, mode: 0o644 })
  check('a header is exactly one 512-byte block', block.length === BLOCK, String(block.length))
  check('the name field holds the path', block.subarray(0, 5).toString('utf8') === 'a.txt')
  // THE assertion this suite exists for: 1234 octal, not the decimal string
  // "00000001234" (which reads as octal 668).
  check('the size field is OCTAL', octalField(block, 124, 12) === 1234,
    JSON.stringify(block.subarray(124, 136).toString('ascii')))
  check('...and not the decimal spelling of the same digits',
    block.subarray(124, 136).toString('ascii') === '00000002322\0',
    JSON.stringify(block.subarray(124, 136).toString('ascii')))
  check('the mtime field is octal', octalField(block, 136, 12) === 1700000000,
    JSON.stringify(block.subarray(136, 148).toString('ascii')))
  check('the mode field is octal', octalField(block, 100, 8) === 0o644,
    JSON.stringify(block.subarray(100, 108).toString('ascii')))
  check('the typeflag says regular file', block.subarray(156, 157).toString('ascii') === '0')
  check('the magic is ustar', block.subarray(257, 262).toString('ascii') === 'ustar')
  check('the ustar version is 00', block.subarray(263, 265).toString('ascii') === '00')
  let sum = 0
  const scratch = Buffer.from(block)
  scratch.fill(0x20, 148, 156)
  for (const byte of scratch) sum += byte
  check('the checksum field matches a recomputation',
    Number.parseInt(block.subarray(148, 154).toString('ascii'), 8) === sum,
    `${block.subarray(148, 154).toString('ascii')} vs ${sum.toString(8)}`)
  check('the checksum is terminated by NUL and space',
    block[154] === 0 && block[155] === 0x20, JSON.stringify([block[154], block[155]]))
}

{
  const block = tarHeader({ path: 'sub', type: '5', mode: 0o755 })
  check('a directory header carries typeflag 5', block.subarray(156, 157).toString('ascii') === '5')
  check('a directory declares size 0', octalField(block, 124, 12) === 0)
}

// ------------------------------------------------------------ long names
console.log('\n[long names split into prefix and name]')

{
  const short = splitTarName('a/b.txt')
  check('a short path stays in `name`', short.prefix === '' && short.name === 'a/b.txt', JSON.stringify(short))
  const deep = `${'d'.repeat(60)}/${'e'.repeat(60)}/${'f'.repeat(60)}.txt`
  const split = splitTarName(deep)
  check('a long path is split at a separator',
    `${split.prefix}/${split.name}` === deep, JSON.stringify(split))
  check('the name half fits in 100 bytes', Buffer.byteLength(split.name, 'utf8') <= 100, String(split.name.length))
  check('the prefix half fits in 155 bytes', Buffer.byteLength(split.prefix, 'utf8') <= 155, String(split.prefix.length))
  // A single segment longer than 100 bytes cannot be split at all; silently
  // truncating it would produce an archive that explodes into the wrong file.
  let refused = false
  try {
    splitTarName(`${'x'.repeat(300)}.txt`)
  } catch { refused = true }
  check('a path that cannot be represented is REFUSED, not truncated', refused)
}

// -------------------------------------------------------------- streaming
console.log('\n[the stream]')

{
  const archive = await collect(async function * () {
    yield { path: 'keep.txt', size: 11, type: '0', mtime: 1, chunks: (async function * () { yield Buffer.from('hello world') })() }
  })
  check('the archive ends on a 512-byte boundary', archive.length % BLOCK === 0, String(archive.length))
  check('the payload follows the header', archive.subarray(BLOCK, BLOCK + 11).toString('utf8') === 'hello world')
  check('the end-of-archive marker is two zero blocks',
    archive.subarray(archive.length - 2 * BLOCK).every(byte => byte === 0))
}

{
  // A file whose content is NOT a multiple of 512 must be padded, or every
  // following header lands at the wrong offset.
  const archive = await collect(async function * () {
    yield { path: 'a', size: 3, type: '0', chunks: (async function * () { yield Buffer.from([1, 2, 3]) })() }
    yield { path: 'b', size: 3, type: '0', chunks: (async function * () { yield Buffer.from([4, 5, 6]) })() }
  })
  const second = archive.subarray(BLOCK * 2, BLOCK * 3)
  check('a short file is padded to the block boundary',
    second.subarray(0, 1).toString('utf8') === 'b', JSON.stringify(second.subarray(0, 8).toString('utf8')))
  check('the padding is zero bytes', archive.subarray(BLOCK + 3, BLOCK * 2).every(byte => byte === 0))
  check('tarPadding rounds up', tarPadding(1) === 511 && tarPadding(512) === 0 && tarPadding(513) === 511)
}

{
  // A declared size that the content does not match would corrupt the archive,
  // so it must fail loudly rather than emit a short entry.
  let failed = false
  try {
    await collect(async function * () {
      yield { path: 'short', size: 10, type: '0', chunks: (async function * () { yield Buffer.from('abc') })() }
    })
  } catch { failed = true }
  check('a short entry is REFUSED', failed)

  let tooLong = false
  try {
    await collect(async function * () {
      yield { path: 'long', size: 2, type: '0', chunks: (async function * () { yield Buffer.from('abc') })() }
    })
  } catch { tooLong = true }
  check('an over-long entry is REFUSED', tooLong)
}

// -------------------------------------------------- the real reader
console.log('\n[a real tar reader agrees]')

/** A python command, or undefined when none is installed. */
function pythonCommand () {
  for (const candidate of ['python', 'python3']) {
    try {
      execFileSync(candidate, ['-c', 'pass'], { stdio: 'ignore' })
      return candidate
    } catch { /* try the next spelling */ }
  }
  return undefined
}

const python = pythonCommand()
if (python === undefined) {
  console.log('  SKIP  no python interpreter, so the archive is not decoded by a real reader')
} else {
  const scratch = await mkdtemp(path.join(tmpdir(), 'dsh-archive-'))
  try {
    const archive = await collect(async function * () {
      yield { path: 'dir', type: '5', mtime: 1700000000 }
      yield { path: 'dir/hello.txt', size: 5, type: '0', mtime: 1700000000, chunks: (async function * () { yield Buffer.from('hello') })() }
      yield { path: 'empty.txt', size: 0, type: '0', mtime: 1700000000 }
      yield { path: 'pad.bin', size: 3, type: '0', mtime: 1700000000, chunks: (async function * () { yield Buffer.from([1, 2, 3]) })() }
    })
    const file = path.join(scratch, 'probe.tar')
    await writeFile(file, archive)
    const script = [
      'import sys, tarfile',
      `t = tarfile.open(r"${file}")`,
      'for m in t.getmembers():',
      '    print(m.name, m.size, "dir" if m.isdir() else "file", oct(m.mode))',
      'print(t.extractfile("dir/hello.txt").read().decode())',
    ].join('\n')
    const out = execFileSync(python, ['-c', script], { encoding: 'utf8' })
    const lines = out.trim().split('\n')
    check('python reads every entry', lines.length === 5, JSON.stringify(lines))
    check('...with the right names and kinds',
      lines[0].startsWith('dir 0 dir') && lines[1].startsWith('dir/hello.txt 5 file'),
      JSON.stringify(lines.slice(0, 2)))
    check('...and the right content', lines[4] === 'hello', JSON.stringify(lines[4]))
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------- the rules
console.log('\n[exclude rules]')

{
  const filter = treeFilter(['node_modules', '*.log', '!keep.log', 'build/output', 'tmp/'])
  const cases = [
    ['node_modules', true, true],
    ['node_modules/x/y.js', false, true],
    ['src/a.log', false, true],
    ['keep.log', false, false],
    // An ANCHORED rule must exclude its own path, not only the files under it:
    // otherwise the walk descends into the excluded directory and copies its
    // contents, and only the leaf files happen to be filtered out.
    ['build/output', true, true],
    ['build/output/z', false, true],
    ['build/other', false, false],
    ['tmp', true, true],
    ['tmp', false, false],
    // `tmp/` is dir-only, so a FILE named `tmp` survives while a directory of
    // that name anywhere in the tree — including below another directory — is
    // excluded. Testing only the top-level case would miss the segment rule.
    ['src/tmp/x', true, true],
    ['src/tmp', true, true],
  ]
  for (const [subject, isDir, expected] of cases) {
    check(`${subject} (${isDir ? 'dir' : 'file'}) is ${expected ? 'excluded' : 'kept'}`,
      filter.excluded(subject, isDir) === expected, String(filter.excluded(subject, isDir)))
  }
}

{
  // Last match wins: a re-include written BEFORE the rule it excepts is
  // superseded, which is what makes the order meaningful rather than decorative.
  const reversed = treeFilter(['!keep.log', '*.log'])
  check('a re-include written before its exclude is superseded',
    reversed.excluded('keep.log', false) === true)
  check('an empty rule list excludes nothing', treeFilter([]).excluded('anything', false) === false)
  check('an undefined rule list excludes nothing', treeFilter(undefined).excluded('anything', false) === false)
  check('a single rule string is accepted', treeFilter('*.tmp').excluded('a.tmp', false) === true)
  check('a blank rule is ignored rather than matching everything', treeFilter(['', '  ']).excluded('a', false) === false)
}

{
  // A rule is a glob, not a regular expression: `.` must be literal.
  check('a dot in a rule is literal', globToRegExp('a.b').test('axb') === false)
  check('...and matches the literal dot', globToRegExp('a.b').test('a.b') === true)
  check('a single star does not cross a separator', globToRegExp('*.log').test('a/b.log') === false)
  check('a double star crosses separators', globToRegExp('**/dist').test('a/b/dist') === true)
  check('...and also matches at the root', globToRegExp('**/dist').test('dist') === true)
  check('a question mark is literal, not a wildcard', globToRegExp('a?b').test('axb') === false)
}

{
  check('a Windows path is relativised with forward slashes',
    relativeForRule('C:\\work\\tree', 'C:\\work\\tree\\src\\a.ts') === 'src/a.ts',
    relativeForRule('C:\\work\\tree', 'C:\\work\\tree\\src\\a.ts'))
  check('a POSIX path is relativised the same way',
    relativeForRule('/srv/tree', '/srv/tree/src/a.ts') === 'src/a.ts')
}

// ------------------------------------------------- the archive of a tree
console.log('\n[downloadTreeAsTar]')

if (downloadTreeAsTar === undefined) {
  // Not a skip of the whole suite: everything above ran. This block is named so
  // a reader can see exactly which evidence is missing and what supplies it.
  console.log('  SKIP  DSH_CORE_ROOT is not set (the archive-of-a-tree checks need @deepseek-ai/dsh-fs)')
} else {

/** An engine over a fake remote tree. */
function fakeEngine (tree) {
  return {
    async withSftp (_alias, work) {
      return await work({
        // `tree` maps an absolute directory to its entries; `files` maps an
        // absolute file path to its content.
        readdir (dir, callback) {
          const entries = tree.dirs.get(dir)
          if (entries === undefined) { callback(Object.assign(new Error('no such directory'), { code: 2 })); return }
          callback(null, entries.map(entry => ({
            filename: entry.name,
            attrs: {
              size: entry.size ?? 0,
              mtime: 1700000000,
              isDirectory: () => entry.dir === true,
              isFile: () => entry.dir !== true,
              isSymbolicLink: () => entry.link === true,
            },
          })))
        },
        open (target, flags, callback) {
          const content = tree.files.get(target)
          if (content === undefined) { callback(Object.assign(new Error('no such file'), { code: 2 })); return }
          callback(null, { __content: content })
        },
        read (handle, buffer, offset, length, position, callback) {
          const slice = handle.__content.subarray(position, position + length)
          slice.copy(buffer, offset)
          callback(null, slice.length, buffer)
        },
        close (_handle, callback) { callback(null) },
      })
    },
  }
}

{
  const dirs = new Map([
    ['/srv/project', [
      { name: 'src', dir: true },
      { name: 'README.md', size: 5 },
      { name: 'build', dir: true },
      { name: 'link', link: true },
    ]],
    ['/srv/project/src', [{ name: 'index.ts', size: 3 }]],
    ['/srv/project/build', [{ name: 'out.js', size: 2 }]],
  ])
  const files = new Map([
    ['/srv/project/README.md', Buffer.from('hello')],
    ['/srv/project/src/index.ts', Buffer.from('abc')],
    ['/srv/project/build/out.js', Buffer.from('xy')],
  ])
  const { stream } = await downloadTreeAsTar(fakeEngine({ dirs, files }), {
    alias: 'test',
    remotePath: '/srv/project',
    exclude: ['build'],
  })
  // The stream carries BYTES. Asserting that here rather than letting
  // `Buffer.concat` throw turns "the route wrote [object Object] in 512-byte
  // chunks" from a crashed suite into a named failure — a crash reports nothing
  // about what was wrong, and a reverse-verification run reads it as "not
  // covered".
  const parts = []
  for await (const chunk of stream) parts.push(chunk)
  const notBuffers = parts.filter(chunk => !Buffer.isBuffer(chunk)).length
  check('the archive stream yields Buffers, not tar entry objects', notBuffers === 0, `${notBuffers} non-Buffer chunk(s)`)
  const archive = Buffer.concat(parts)

  // Walk the archive the way a reader does: header, skip size+padding.
  const names = []
  for (let offset = 0; offset + BLOCK <= archive.length;) {
    const block = archive.subarray(offset, offset + BLOCK)
    if (block.every(byte => byte === 0)) break
    const name = block.subarray(0, 100).toString('utf8').replace(/\0.*$/su, '')
    const prefix = block.subarray(345, 500).toString('utf8').replace(/\0.*$/su, '')
    const size = octalField(block, 124, 12)
    names.push(prefix === '' ? name : `${prefix}/${name}`)
    offset += BLOCK + size + tarPadding(size)
  }

  check('the root directory is not itself an entry', !names.includes('') && !names.includes('project'), JSON.stringify(names))
  check('entry paths are relative to the downloaded directory',
    names.includes('README.md') && names.includes('src/index.ts'), JSON.stringify(names))
  check('a directory is an entry', names.includes('src/') || names.includes('src'), JSON.stringify(names))
  check('an excluded directory is absent', !names.some(name => name.startsWith('build')), JSON.stringify(names))
  check('a symlink is not an entry at all', !names.includes('link') && !names.includes('link/'), JSON.stringify(names))
  // The skip has to be REPORTED, or the archive silently misrepresents the tree.
  check('the skips are reported inside the archive', names.includes('SKIPPED.txt'), JSON.stringify(names))
}

{
  // Nothing skipped, nothing excluded: no note.
  const dirs = new Map([['/srv/plain', [{ name: 'a.txt', size: 1 }]]])
  const files = new Map([['/srv/plain/a.txt', Buffer.from('x')]])
  const { stream } = await downloadTreeAsTar(fakeEngine({ dirs, files }), { alias: 'test', remotePath: '/srv/plain' })
  const archive = Buffer.concat(await (async () => {
    const parts = []
    for await (const chunk of stream) parts.push(chunk)
    return parts
  })())
  check('a complete archive carries no SKIPPED note',
    archive.subarray(0, 100).toString('utf8').startsWith('a.txt'))
}

{
  // An EXCLUSION alone must produce the note, and the note must say how many
  // paths it was. Without this the walk could ignore the rules entirely and the
  // tree-names assertion above would still pass on a fixture that happens to
  // have no `build` directory.
  const dirs = new Map([
    ['/srv/only', [
      { name: 'keep.txt', size: 1 },
      { name: 'build', dir: true },
    ]],
    ['/srv/only/build', [{ name: 'out.js', size: 1 }]],
  ])
  const files = new Map([
    ['/srv/only/keep.txt', Buffer.from('k')],
    ['/srv/only/build/out.js', Buffer.from('o')],
  ])
  const { stream } = await downloadTreeAsTar(fakeEngine({ dirs, files }), {
    alias: 'test',
    remotePath: '/srv/only',
    exclude: ['build'],
  })
  const archive = Buffer.concat(await (async () => {
    const parts = []
    for await (const chunk of stream) parts.push(chunk)
    return parts
  })())
  const text = archive.toString('utf8')
  check('an exclusion alone still produces the note', text.includes('SKIPPED.txt'))
  check('the note states how many paths were skipped', /1 path\(s\) were skipped/u.test(text),
    JSON.stringify(text.slice(text.indexOf('were skipped') - 40, text.indexOf('were skipped') + 20)))
  check('the excluded file is not in the archive', !text.includes('build/out.js'))
}

{
  check('the archive is named after the directory', tarNameOf('/srv/project') === 'project.tar', tarNameOf('/srv/project'))
  check('a trailing slash does not produce an empty name', tarNameOf('/srv/project/') === 'project.tar', tarNameOf('/srv/project/'))
  check('a colon is replaced, because the name becomes a local filename',
    tarNameOf('/srv/a:b').includes('_'), tarNameOf('/srv/a:b'))
}
}

// ------------------------------------------------------ completion notices
console.log('\n[the completion notice is ONE element, edited in place]')

{
  const client = await readFile(path.join(pluginRoot, 'lib', 'client.js'), 'utf8')

  /**
   * Lift the toast helpers out of the bundle and run the REAL `transferNotice`
   * against a fake DOM.
   *
   * This is the assertion that matters, and the source-text checks below are
   * only its shadow: "the handle exists" is satisfied by a handle nobody uses,
   * and by an implementation that appends a SECOND node. The behaviour that
   * distinguishes a correct one is that the in-flight node and the outcome node
   * are the SAME object, so its dismissal timer starts when the outcome is
   * known — not when the transfer began.
   *
   * The fake DOM records the DELAY too. Since the 2026-11 change a failure
   * expires as well, so "a timer was armed" no longer says everything: when it
   * fires is the point.
   */
  function makeDom () {
    const nodes = []
    const timers = []
    const document = {
      body: { appendChild: (node) => { nodes.push(node); node.parent = document.body } },
      createElement: () => {
        const listeners = new Map()
        const node = {
          className: '',
          textContent: '',
          tabIndex: -1,
          parent: null,
          setAttribute (name, value) { this[name] = value },
          addEventListener (name, handler) { listeners.set(name, handler) },
          listeners,
          focus () { /* focus is client-shape's subject, not this suite's */ },
          remove () { const at = nodes.indexOf(this); if (at >= 0) nodes.splice(at, 1) },
        }
        return node
      },
      querySelectorAll: () => [...nodes],
    }
    const setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length }
    const clearTimeout = () => {}
    // The lift brings its own `domToastTimer` binding and `armToast`: the whole
    // point of the handle is that finishing CLEARS the pending timer before
    // arming its own, and a copy that skipped that would not be the real code.
    const build = liftToasts(client).build(document, setTimeout, clearTimeout)
    return { transferNotice: build.transferNotice, nodes, timers, document }
  }

  {
    const dom = makeDom()
    const handle = dom.transferNotice('Uploading a.zip…')
    check('opening a transfer creates exactly one node', dom.nodes.length === 1, String(dom.nodes.length))
    const live = dom.nodes[0]
    check('...which says it is working', live.textContent === 'Uploading a.zip…', live.textContent)
    handle.done('Uploaded a.zip (1.0 KB)')
    check('finishing does NOT add a second node', dom.nodes.length === 1, String(dom.nodes.length))
    check('...it edits the same one', live.textContent === 'Uploaded a.zip (1.0 KB)', live.textContent)
    check('...and only NOW starts the dismissal timer', dom.timers.length === 1, String(dom.timers.length))
    check('...marking it as a success', live.className.includes('sshwsp-toast-ok'), live.className)
  }

  {
    const dom = makeDom()
    const handle = dom.transferNotice('Uploading b.zip…')
    handle.failed('Upload failed: no space left')
    const node = dom.nodes[0]
    check('a failure turns the same node into an error', node.textContent === 'Upload failed: no space left', node.textContent)
    check('...with role="alert", because it must interrupt', node.role === 'alert', node.role)
    // The window is seven seconds for BOTH kinds now. The old rule kept failures
    // until clicked; a single-slot toast made a sticky failure hide the message
    // that followed it, so the permanence went and the wording stayed.
    check('...and it also expires, on the one seven-second window',
      dom.timers.length === 1 && dom.timers[0].ms === 7000,
      `${dom.timers.length} timer(s), ms=${dom.timers.map(timer => timer.ms).join(',')}`)
    check('...and it is focusable for keyboard dismissal', node.tabIndex === 0, String(node.tabIndex))
  }

  {
    const dom = makeDom()
    const handle = dom.transferNotice('Uploading c.zip…')
    handle.text('Uploading c.zip… 40%')
    check('the in-flight line can be updated in place',
      dom.nodes[0].textContent === 'Uploading c.zip… 40%', dom.nodes[0].textContent)
    handle.done('Uploaded c.zip')
    handle.done('Uploaded c.zip AGAIN')
    check('a second outcome does not overwrite the first',
      dom.nodes[0].textContent === 'Uploaded c.zip', dom.nodes[0].textContent)
    check('...and does not re-arm the timer', dom.timers.length === 1, String(dom.timers.length))
  }

  // The source checks below say WHERE the handle is used; the behaviour above
  // says what using it means.
  check('a transfer handle exists', /function transferNotice \(/u.test(client))
  check('the queue turns the in-flight notice into the result, in place',
    /notice\.handle\.done\(summary\.line, summary\.kind\)/u.test(client) &&
      /notice\.handle\.text\(line\)/u.test(client))
  // One toast owner: the queue opens the notice once per batch, and no upload
  // path opens a competing `notifyUser` progress line — that second toast is
  // exactly what resets the batch notice's dismissal clock.
  const noticeSection = client.slice(
    client.indexOf('function openTransferQueueNotice ('),
    client.indexOf('\n    /**', client.indexOf('function openTransferQueueNotice (')),
  )
  check('the transfer batch opens exactly one notice',
    (client.match(/transferNotice\(/gu) ?? []).length === 1,
    `${(client.match(/transferNotice\(/gu) ?? []).length} call(s)`)
  check('...and it does not open a second, competing toast',
    noticeSection.includes('transferNotice(') && !noticeSection.includes('notifyUser('),
    `${(noticeSection.match(/notifyUser\(/gu) ?? []).length} notifyUser call(s)`)
  check('a download reports its size', /translate\('transfer\.doneDownload', \{ name: [^)]*size:/u.test(client))
  // The upload's completion line must name the SERVER's byte count, and the
  // assertion is about the VALUE that reaches the message rather than about
  // the expression existing: `formatBytes(file.size)` and `formatBytes(landed)`
  // differ by a few characters and by everything the user reads.
  check('the upload reads the server\'s byte count',
    /const landed = typeof parsed\?\.bytes === 'number' && Number\.isFinite\(parsed\.bytes\) \? parsed\.bytes : file\.size/u.test(client))
  check('...and the queue\'s completion line names it',
    /note: translate\('transfer\.doneUpload', \{ name: file\.name, size: formatBytes\(landed\) \}\)/u.test(client))
  check('the directory browser no longer hosts the queue inside its modal',
    !/TransferQueueInline/u.test(client) && !/sshwsp-queueinline/u.test(client))
  // A transfer belongs to the plugin, not to the directory the user happens to
  // be looking at. The dialog is browse-only now; the queue still lives in the
  // Files panel and survives navigating and closing the modal.
  check('navigating does not discard the transfer queue',
    !/setTransferDone\(null\)/u.test(client) &&
      /function TransferQueuePanel[\s\S]{0,120}?useTransferQueue\(\)/u.test(client))
}

// ------------------------------------------------- where a download lands
console.log('\n[a download reports a save only when it can see one]')

{
  const client = await readFile(path.join(pluginRoot, 'lib', 'client.js'), 'utf8')

  /** Lift one top-level `async function` out of the bundle by brace matching. */
  function lift (name) {
    const start = client.indexOf(`async function ${name} (`)
    if (start < 0) throw new Error(`client.js does not define ${name}()`)
    let depth = 0
    for (let i = client.indexOf('{', start); i < client.length; i += 1) {
      if (client[i] === '{') depth += 1
      else if (client[i] === '}') {
        depth -= 1
        if (depth === 0) {
          // eslint-disable-next-line no-new-func
          return new Function('window', `${client.slice(start, i + 1)}; return ${name}`)
        }
      }
    }
    throw new Error(`unbalanced braces in ${name}()`)
  }

  const pickFileTarget = lift('pickFileTarget')({})

  // The three outcomes must stay apart. "You cancelled" and "this browser
  // cannot ask" lead to opposite next steps, and collapsing them into a falsy
  // return is exactly how a cancel gets reported as a failure — or worse, a
  // failure gets silently treated as a cancel.
  const unsupported = await pickFileTarget('a.txt')
  check('no picker means "unsupported", not an error',
    unsupported.kind === 'unsupported', JSON.stringify(unsupported))

  const handle = { name: 'a.txt' }
  const picked = await lift('pickFileTarget')({ showSaveFilePicker: async () => handle })('a.txt')
  check('a chosen destination comes back as a handle',
    picked.kind === 'handle' && picked.handle === handle, JSON.stringify(picked.kind))

  const canceled = await lift('pickFileTarget')({
    showSaveFilePicker: async () => { const err = new Error('closed'); err.name = 'AbortError'; throw err },
  })('a.txt')
  check('closing the picker is "canceled", a distinct outcome',
    canceled.kind === 'canceled', JSON.stringify(canceled))

  const refused = await lift('pickFileTarget')({
    showSaveFilePicker: async () => { const err = new Error('denied'); err.name = 'SecurityError'; throw err },
  })('a.txt')
  check('a refusal is NOT reported as a cancel',
    refused.kind === 'unsupported', JSON.stringify(refused))

  // The ordering claim is the whole point of asking first: the picker needs the
  // activation the click granted, and the first network `await` spends it. A
  // source check is the only way to see it, and it is worth having because the
  // alternative is a bug that shows up only on large files.
  const row = client.slice(
    client.indexOf('async function downloadTreeRow ('),
    client.indexOf('async function sendTreeUpload (') === -1
      ? undefined
      : client.indexOf('async function sendTreeUpload ('),
  )
  const pickAt = row.indexOf('await pickFileTarget(')
  const fetchAt = row.indexOf('await fetch(')
  check('the destination is chosen BEFORE the request is made',
    pickAt >= 0 && fetchAt > pickAt, `pick@${pickAt} fetch@${fetchAt}`)
  check('a cancelled picker transfers no bytes at all',
    row.includes('if (target.kind === \'canceled\') return'), 'the cancel branch is missing')

  /** A writable double that records writes and whether it was closed. */
  function makeWritable () {
    const state = { chunks: [], closed: false, aborted: false }
    state.write = async (chunk) => { state.chunks.push(chunk) }
    state.close = async () => { state.closed = true }
    state.abort = async () => { state.aborted = true }
    return state
  }

  const streamIntoHandle = lift('streamIntoHandle')({})

  {
    const writable = makeWritable()
    const seen = []
    const response = new Response(new Uint8Array([1, 2, 3, 4, 5]))
    const written = await streamIntoHandle(
      { createWritable: async () => writable },
      response,
      (bytes) => { seen.push(bytes) },
    )
    check('the reported size is what the DISK accepted', written === 5, String(written))
    check('...and the writable is closed, which is what publishes it', writable.closed === true)
    check('...with progress reported as a running count',
      seen.length > 0 && seen[seen.length - 1] === 5, JSON.stringify(seen))
  }

  {
    // A failed write must ABORT: closing a short file publishes a truncated
    // download under the name the user chose, which reads as success.
    const writable = makeWritable()
    writable.write = async () => { throw new Error('disk full') }
    let threw = false
    try {
      await streamIntoHandle({ createWritable: async () => writable }, new Response(new Uint8Array([1, 2, 3])))
    } catch { threw = true }
    check('a failed write throws', threw)
    check('...and ABORTS instead of closing a short file', writable.aborted === true && writable.closed === false,
      `aborted=${writable.aborted} closed=${writable.closed}`)
  }

  // The anchor path can never know whether the file was saved, so it must not
  // claim it. Both locales have to carry the honest wording, because the
  // fallback is what most Chromium builds actually use inside a sandboxed frame.
  const startedLines = [...client.matchAll(/'transfer\.downloadStarted': '([^']*)'/gu)].map(match => match[1])
  check('both locales define the "started" wording', startedLines.length === 2, `${startedLines.length}`)
  check('neither claims the file was saved',
    startedLines.every(line => !/已下载|Downloaded/u.test(line)), JSON.stringify(startedLines))
  check('the fallback says who chooses the location',
    /浏览器/u.test(startedLines[0] ?? '') && /browser/iu.test(startedLines[1] ?? ''), JSON.stringify(startedLines))
}

console.log(`\n=== ${passed} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
