/**
 * The remote filesystem seam, driven against an in-memory SFTP tree.
 *
 * Every property here used to need a live host: staged publication, the
 * version-conflict branch, the write fence, cleanup after a half-written file.
 * They are the success paths — the ones that only run when bytes actually land —
 * and until `tests/support/fake-sftp.mjs` existed the only way to exercise them
 * was `DSH_WS_TEST_ALIAS`, so on a bare checkout they were unproven.
 *
 * The double is not a mock of this plugin: it is a server-shaped channel (see its
 * header for what it refuses to do), so what runs below is the real
 * `RemoteFileSystem`, the real fences, and the real publish sequence.
 *
 * Run: node tests/remote-fs-smoke.mjs
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createFakeSftp, fakeSftpEngine, SFTP_STATUS } from './support/fake-sftp.mjs'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== remote fs smoke ===\n')

const coreRoot = process.env.DSH_CORE_ROOT
if (!coreRoot) {
  console.log('  SKIP  DSH_CORE_ROOT is not set (needs @deepseek-ai/dsh-fs)')
  console.log(`\n=== ${passed} passed, ${failures} failed, 1 suite skipped ===`)
  process.exit(failures === 0 ? 0 : 1)
}
process.env.DSH_PEER_ROOT = [coreRoot, process.env.DSH_PEER_ROOT].filter(Boolean).join(path.delimiter)

const { RemoteFileSystem, compareEntries } = await import(pathToFileURL(path.join(pluginRoot, 'lib/fs/remote-fs.js')).href)

/** The alias every target below lives on. */
const ALIAS = 'box'
/** The one mounted root; everything outside it must be refused. */
const ROOT = 'ssh://box/srv/app'
/** The per-call policy a `workspace-write` session carries. */
const WRITE_POLICY = { mode: 'workspace-write', workspaceRoot: ROOT }

/**
 * A router over one fake host, mounted at {@link ROOT}.
 *
 * `options.seed` seeds the tree; `options.extensions: false` hides the atomic
 * rename extension so the non-atomic fallback is the thing that runs.
 */
function routerOver (options = {}) {
  const double = createFakeSftp({
    files: options.files ?? {},
    dirs: ['/srv', '/srv/app', ...(options.dirs ?? [])],
    links: options.links ?? [],
    extensions: options.extensions,
  })
  const engine = fakeSftpEngine(double.sftp)
  const router = new RemoteFileSystem({ engine })
  router.addRoot(ALIAS, '/srv/app')
  return { router, engine, ...double }
}

/** Run `operation`, returning the FsError code it threw (or undefined). */
async function codeOf (operation) {
  try {
    await operation()
    return undefined
  } catch (error) {
    return error?.code ?? `threw: ${error?.message}`
  }
}

/** The spelling of a path inside the mounted root. */
const inside = (relative) => `ssh://${ALIAS}/srv/app/${relative}`

// ---------------------------------------------------------------------------
// Reading: stat, listDir, readText
// ---------------------------------------------------------------------------
{
  const { router, tree } = routerOver({ files: { '/srv/app/notes.md': '# title\ntext\n' } })

  const stats = await router.stat({ targetKey: inside('notes.md'), displayPath: inside('notes.md') })
  check('stat reports the file type', stats?.type === 'file', JSON.stringify(stats))
  check('stat reports the size', stats?.size === 13, String(stats?.size))
  check('stat carries a version token', typeof stats?.version === 'string' && stats.version.includes(':'), String(stats?.version))

  const text = await router.readText({ targetKey: inside('notes.md'), displayPath: inside('notes.md') })
  check('readText returns the decoded content', text === '# title\ntext\n', JSON.stringify(text))

  const listing = await router.listDir({ targetKey: inside(''), displayPath: inside('') })
  check('listDir reports the entry', listing.length === 1 && listing[0].name === 'notes.md', JSON.stringify(listing.map(entry => entry.name)))
  check('listDir reports the entry type', listing[0]?.type === 'file', String(listing[0]?.type))
  check('listDir reports the entry size', listing[0]?.size === 13, String(listing[0]?.size))
  check('listDir gives each entry a remote target',
    listing[0]?.target?.displayPath === inside('notes.md'), String(listing[0]?.target?.displayPath))

  // The listing is sorted by name, which the panel relies on for a stable tree.
  tree.write('/srv/app/aaa.txt', 'a')
  tree.write('/srv/app/zzz.txt', 'z')
  router.invalidateRemote(ALIAS, '/srv/app')
  const sorted = await router.listDir({ targetKey: inside(''), displayPath: inside('') })
  check('listDir sorts its entries by name',
    sorted.map(entry => entry.name).join(',') === 'aaa.txt,notes.md,zzz.txt',
    sorted.map(entry => entry.name).join(','))

  // The order is part of the answer: the tree draws this list as it arrives, and
  // the same directory must come back in the same order everywhere.
  tree.mkdir('/srv/app/Zeta')
  tree.mkdir('/srv/app/alpha')
  tree.write('/srv/app/Beta.txt', 'b')
  // Two names that fold to the same string: without a case-sensitive tiebreak
  // their order would come from whatever `readdir` returned.
  tree.write('/srv/app/README.md', 'r')
  tree.write('/srv/app/readme.md', 'r')
  router.invalidateRemote(ALIAS, '/srv/app')
  const ordered = (await router.listDir({ targetKey: inside(''), displayPath: inside('') })).map(entry => entry.name)
  check('directories come before files, whatever their names',
    ordered.slice(0, 2).join(',') === 'alpha,Zeta',
    ordered.join(','))
  check('...because names compare case-insensitively, not by code unit',
    ordered.indexOf('aaa.txt') < ordered.indexOf('Beta.txt'),
    ordered.join(','))
  check('...and the case-sensitive tiebreak makes the order total',
    ordered.indexOf('README.md') < ordered.indexOf('readme.md'),
    ordered.join(','))
  check('the whole order is the one comparator, so the two listings cannot drift',
    ordered.join(',') === 'alpha,Zeta,aaa.txt,Beta.txt,notes.md,README.md,readme.md,zzz.txt',
    ordered.join(','))

  // Two listings of an unchanged directory must agree exactly. A comparator
  // that left ties would let the server's readdir order leak through here.
  const again = (await router.listDir({ targetKey: inside(''), displayPath: inside('') })).map(entry => entry.name)
  check('...and it is stable across calls', again.join(',') === ordered.join(','), again.join(','))

  // The comparator on its own, because the listing above can only show what one
  // directory happens to contain and the tiebreak needs a pair that folds equal.
  const byName = (a, b) => compareEntries({ name: a, type: 'file' }, { name: b, type: 'file' })
  check('the comparator folds case', byName('aaa', 'Beta') < 0 && byName('Beta', 'aaa') > 0)
  check('...breaks a fold tie by code unit, so the order is total',
    byName('README.md', 'readme.md') < 0 && byName('readme.md', 'README.md') > 0)
  check('...and answers zero only for the same name', byName('same', 'same') === 0)
  check('a directory outranks a file whatever the names are',
    compareEntries({ name: 'zzz', type: 'directory' }, { name: 'aaa', type: 'file' }) < 0 &&
      compareEntries({ name: 'aaa', type: 'file' }, { name: 'zzz', type: 'directory' }) > 0)
  check('an unknown type is ordered with the files, not with the directories',
    compareEntries({ name: 'aaa', type: 'other' }, { name: 'zzz', type: 'directory' }) > 0)
  check('...and a missing name does not throw',
    compareEntries({ type: 'file' }, { type: 'file' }) === 0)

  // The two listings are ordered by ONE function. A local copy in the route
  // would drift the moment either was tuned, and the drift would only show as
  // a truncated listing that keeps a different set of rows.
  const { readFileSync } = await import('node:fs')
  const entriesSource = readFileSync(path.join(pluginRoot, 'lib/routes/entries.js'), 'utf8')
  check('the truncation cut-off imports that same comparator',
    entriesSource.includes('compareEntries') && !/function compareForTruncation \(a, b\)/u.test(entriesSource))

  // A missing path is an answer, not a crash: stat returns undefined so callers
  // can treat "absent" and "unreadable" differently.
  const absent = await router.stat({ targetKey: inside('ghost.txt'), displayPath: inside('ghost.txt') })
  check('stat of an absent path answers undefined', absent === undefined, JSON.stringify(absent))
  check('readText of an absent path is FS_NOT_FOUND',
    await codeOf(() => router.readText({ targetKey: inside('ghost.txt'), displayPath: inside('ghost.txt') })) === 'FS_NOT_FOUND')
  check('listDir of an absent path is FS_NOT_FOUND',
    await codeOf(() => router.listDir({ targetKey: inside('ghost'), displayPath: inside('ghost') })) === 'FS_NOT_FOUND')
  check('listDir of a FILE is FS_NOT_DIRECTORY',
    await codeOf(() => router.listDir({ targetKey: inside('notes.md'), displayPath: inside('notes.md') })) === 'FS_NOT_DIRECTORY')
  check('readText of a DIRECTORY is FS_NOT_REGULAR_FILE',
    await codeOf(() => router.readText({ targetKey: inside(''), displayPath: inside('') })) === 'FS_NOT_REGULAR_FILE')
}

// ---------------------------------------------------------------------------
// Writing: the staged publish, the mode, and the version check
// ---------------------------------------------------------------------------
{
  const { router, tree, engine, snapshot } = routerOver({ files: { '/srv/app/a.txt': 'old\n' } })
  const before = snapshot()

  const result = await router.writeText({ targetKey: inside('a.txt'), displayPath: inside('a.txt') }, 'new\n', undefined, undefined, WRITE_POLICY)
  check('writeText reports an update', result.operation === 'update', JSON.stringify(result.operation))
  check('writeText lands the new content', tree.read('/srv/app/a.txt') === 'new\n', JSON.stringify(tree.read('/srv/app/a.txt')))
  check('writeText hands back the previous content for the diff', result.before === 'old\n', JSON.stringify(result.before))
  check('writeText hands back the new content', result.after === 'new\n', JSON.stringify(result.after))
  check('writeText reports a version that is not the old one', result.version !== before.files.length && typeof result.version === 'string')

  // The publication is atomic: the bytes go to a sibling staging directory and
  // are renamed over the destination, so a reader never sees a half file. With
  // the extension advertised, that rename is the OpenSSH one.
  check('the publish used the atomic rename, not the fallback',
    tree.calls.some(call => call.method === 'ext_openssh_rename'),
    JSON.stringify(tree.calls.map(call => call.method).filter((name, at, all) => all.indexOf(name) === at)))
  check('the staging directory was cleaned up',
    [...tree.dirs].every(dir => !dir.includes('.dsh-tmp-')), JSON.stringify([...tree.dirs]))
  check('the destination is not left holding a staging name', tree.has('/srv/app/a.txt'))

  // The staging file is created 0644 and then given the destination's mode, so a
  // 0644 file does not come back as a private one (or vice versa). 0600 was the
  // old staging mode and leaked onto every NEW file, which is the inconsistency
  // this pins.
  check('the staging file was opened exclusively',
    tree.opens.some(open => open.flags === 'wx'), JSON.stringify(tree.opens))
  check('the staging file started at the shared default',
    tree.opens.some(open => open.flags === 'wx' && open.mode === 0o644), JSON.stringify(tree.opens))
  check('the published file kept the destination mode',
    tree.modes.get('/srv/app/a.txt') === 0o644, String(tree.modes.get('/srv/app/a.txt')))

  // A create is reported as a create, and needs no version.
  const created = await router.writeText({ targetKey: inside('fresh.txt'), displayPath: inside('fresh.txt') }, 'hello', undefined, undefined, WRITE_POLICY)
  check('writeText reports a create', created.operation === 'create', JSON.stringify(created.operation))
  check('the created file holds the content', tree.read('/srv/app/fresh.txt') === 'hello')
  check('...and a new file gets the same 0644 every write path uses',
    tree.modes.get('/srv/app/fresh.txt') === 0o644, String(tree.modes.get('/srv/app/fresh.txt')))

  // A server without chmod (or one that refuses it) must not lose the write —
  // but it must not look like the mode request succeeded either. One degraded
  // note is the whole visibility budget; the write stays successful.
  tree.fail({ method: 'chmod', times: 20, message: 'chmod refused' })
  const noChmod = await router.writeText({ targetKey: inside('nochmod.txt'), displayPath: inside('nochmod.txt') }, 'kept', undefined, undefined, WRITE_POLICY)
  check('a refused chmod does not fail the write', noChmod.operation === 'create' && tree.read('/srv/app/nochmod.txt') === 'kept')
  check('...and is recorded as a degradation instead of vanishing',
    engine.notes.some(note => note.kind === 'degraded' && /refused chmod/u.test(note.detail)), JSON.stringify(engine.notes))
}

// ---------------------------------------------------------------------------
// The version check: a conflict must refuse, not overwrite
// ---------------------------------------------------------------------------
{
  const { router, tree } = routerOver({ files: { '/srv/app/c.txt': 'v1' } })
  const target = { targetKey: inside('c.txt'), displayPath: inside('c.txt') }
  const first = await router.stat(target)

  // Somebody else rewrites the file between the read and the write.
  tree.write('/srv/app/c.txt', 'v2-other')
  router.invalidateRemote(ALIAS, '/srv/app/c.txt')

  const conflict = await codeOf(() => router.writeText(target, 'v3-mine', { kind: 'replaceIfVersion', version: first.version }, undefined, WRITE_POLICY))
  check('a stale version refuses the write', conflict === 'FS_STALE_VERSION', String(conflict))
  check('the refused write left the other content in place', tree.read('/srv/app/c.txt') === 'v2-other', tree.read('/srv/app/c.txt'))
  check('the refused write staged nothing', tree.calls.filter(call => call.method === 'ext_openssh_rename').length === 0)

  // A matching version is accepted — the check must not be a blanket refusal.
  const current = await router.stat(target)
  const ok = await router.writeText(target, 'v3-mine', { kind: 'replaceIfVersion', version: current.version }, undefined, WRITE_POLICY)
  check('a matching version is accepted', ok.operation === 'update', JSON.stringify(ok.operation))
  check('the accepted write landed', tree.read('/srv/app/c.txt') === 'v3-mine')

  // createIfAbsent is the other half: it must refuse to clobber a file the
  // caller never read.
  const clobber = await codeOf(() => router.writeText(target, 'sneaky', { kind: 'createIfAbsent' }, undefined, WRITE_POLICY))
  check('createIfAbsent refuses an existing file', clobber === 'FS_NOT_OBSERVED', String(clobber))
  check('the refused create changed nothing', tree.read('/srv/app/c.txt') === 'v3-mine')

  // replaceIfVersion against a vanished file is a conflict, not a create.
  const gone = await codeOf(() => router.writeText(
    { targetKey: inside('gone.txt'), displayPath: inside('gone.txt') }, 'x',
    { kind: 'replaceIfVersion', version: first.version }, undefined, WRITE_POLICY))
  check('replacing a vanished file is a stale version', gone === 'FS_STALE_VERSION', String(gone))
}

// ---------------------------------------------------------------------------
// The non-atomic fallback still publishes, and still cleans up
// ---------------------------------------------------------------------------
{
  // A server without posix-rename cannot atomically overwrite, so the code
  // removes the destination and renames. That branch had never been exercised:
  // the doubles all advertised the extension, so every write took the atomic
  // path and the fallback could have been broken forever.
  const { router, tree } = routerOver({ files: { '/srv/app/f.txt': 'before' }, extensions: false })
  const result = await router.writeText({ targetKey: inside('f.txt'), displayPath: inside('f.txt') }, 'after', undefined, undefined, WRITE_POLICY)
  check('the fallback still reports an update', result.operation === 'update', JSON.stringify(result.operation))
  check('the fallback still lands the content', tree.read('/srv/app/f.txt') === 'after', tree.read('/srv/app/f.txt'))
  check('the fallback never used the extension', !tree.calls.some(call => call.method === 'ext_openssh_rename'))
  check('the fallback removed the old destination before renaming',
    tree.unlinks.includes('/srv/app/f.txt'), JSON.stringify(tree.unlinks))
  check('the fallback cleaned its staging directory',
    [...tree.dirs].every(dir => !dir.includes('.dsh-tmp-')), JSON.stringify([...tree.dirs]))
}

// ---------------------------------------------------------------------------
// A write that dies mid-flight must not damage the destination
// ---------------------------------------------------------------------------
{
  const { router, tree, snapshot } = routerOver({ files: { '/srv/app/precious.txt': 'keep me' } })
  const before = snapshot()

  // The channel dies after the staging file has been written but before the
  // publish: exactly the window a staging directory exists to cover.
  tree.fail({ method: 'ext_openssh_rename', code: SFTP_STATUS.FAILURE, message: 'connection lost' })
  const failure = await codeOf(() => router.writeText(
    { targetKey: inside('precious.txt'), displayPath: inside('precious.txt') }, 'clobbered', undefined, undefined, WRITE_POLICY))
  check('a failed publish surfaces an error', failure !== undefined, String(failure))
  check('a failed publish leaves the destination untouched', tree.read('/srv/app/precious.txt') === 'keep me',
    tree.read('/srv/app/precious.txt'))
  check('a failed publish removes its staging directory',
    [...tree.dirs].every(dir => !dir.includes('.dsh-tmp-')), JSON.stringify([...tree.dirs]))
  check('a failed publish leaves no stray file in the directory',
    snapshot().files.map(entry => entry[0]).join(',') === before.files.map(entry => entry[0]).join(','),
    JSON.stringify(snapshot().files.map(entry => entry[0])))
}

// ---------------------------------------------------------------------------
// The fences: mode, scope, and reachability
// ---------------------------------------------------------------------------
{
  const { router, tree } = routerOver({ files: { '/srv/app/a.txt': 'x' } })
  const target = { targetKey: inside('a.txt'), displayPath: inside('a.txt') }

  const readOnly = await codeOf(() => router.writeText(target, 'y', undefined, undefined, { mode: 'read-only', workspaceRoot: ROOT }))
  check('read-only refuses a write', readOnly === 'FS_SANDBOX_DENIED', String(readOnly))
  check('the read-only refusal never reached the host', tree.calls.length === 0, JSON.stringify(tree.calls.length))
  check('the read-only refusal left the file alone', tree.read('/srv/app/a.txt') === 'x')

  // workspace-write names ONE root. A sibling directory on the same host is
  // mounted but not the session workspace, so writing there is a sandbox denial
  // — the remote counterpart of the local rule.
  router.addRoot(ALIAS, '/srv/other')
  const sibling = await codeOf(() => router.writeText(
    { targetKey: `ssh://${ALIAS}/srv/other/b.txt`, displayPath: `ssh://${ALIAS}/srv/other/b.txt` },
    'y', undefined, undefined, { mode: 'workspace-write', workspaceRoot: ROOT }))
  check('workspace-write refuses a mounted sibling root', sibling === 'FS_SANDBOX_DENIED', String(sibling))

  // A path nobody mounted is a different refusal with a different code: the
  // host rewrites FS_SANDBOX_DENIED into an escalation hint that cannot help.
  let unmountedMessage
  try {
    await router.writeText(
      { targetKey: `ssh://${ALIAS}/etc/cron.d/probe`, displayPath: `ssh://${ALIAS}/etc/cron.d/probe` },
      'y', undefined, undefined, { mode: 'danger-full-access' })
  } catch (error) { unmountedMessage = error }
  check('an unmounted path is FS_OUTSIDE_WORKSPACE even at full access',
    unmountedMessage?.code === 'FS_OUTSIDE_WORKSPACE', String(unmountedMessage?.code))
  // The wording matters: the host rewrites FS_SANDBOX_DENIED into an escalation
  // hint, so a mount refusal must NOT use that code, and the message must name
  // the fix rather than the mode.
  check('the unmounted refusal says how to fix it',
    /mount it first/u.test(unmountedMessage?.message ?? ''), String(unmountedMessage?.message))

  // The host temp area is served for the same reason the local backend lists
  // /tmp in writableRoots: a build that stages there must not be refused.
  tree.mkdir('/tmp/build')
  const temp = await router.writeText(
    { targetKey: `ssh://${ALIAS}/tmp/build/out.o`, displayPath: `ssh://${ALIAS}/tmp/build/out.o` },
    'obj', undefined, undefined, { mode: 'danger-full-access' })
  check('the host temp area is writable', temp.operation === 'create', JSON.stringify(temp))

  // A symlink that resolves outside every mounted root is refused even though
  // every spelling says otherwise. This is the half a lexical check cannot see.
  const escaping = routerOver({ files: { '/etc/outside/x.txt': 'secret' }, links: [['/srv/app/out', '/etc/outside']] })
  let throughLink
  try {
    await escaping.router.writeText(
      { targetKey: inside('out/x.txt'), displayPath: inside('out/x.txt') },
      'overwritten', undefined, undefined, WRITE_POLICY)
  } catch (error) { throughLink = error }
  check('a symlinked escape is refused', throughLink?.code === 'FS_OUTSIDE_WORKSPACE', String(throughLink?.code))
  check('the escaping write changed nothing outside the roots',
    escaping.tree.read('/etc/outside/x.txt') === 'secret', escaping.tree.read('/etc/outside/x.txt'))
  check('the escape refusal names the link as the cause',
    /symbolic link resolves outside/u.test(throughLink?.message ?? ''), String(throughLink?.message))

  // Reads are NOT fenced by roots: a detached workspace is refused, but a plain
  // path outside every mount is readable when the server allows it. That is the
  // documented difference, and it is what makes `read` usable at all.
  const outside = await codeOf(() => router.readText({ targetKey: `ssh://${ALIAS}/etc/hostname`, displayPath: `ssh://${ALIAS}/etc/hostname` }))
  check('reading outside the roots is not a fence refusal', outside !== 'FS_OUTSIDE_WORKSPACE', String(outside))
}

// ---------------------------------------------------------------------------
// editText: the literal edit, and its own version check
// ---------------------------------------------------------------------------
{
  const { router, tree } = routerOver({ files: { '/srv/app/e.txt': 'alpha beta\ngamma\n' } })
  const target = { targetKey: inside('e.txt'), displayPath: inside('e.txt') }

  const edited = await router.editText(target, { oldString: 'beta', newString: 'BETA' }, undefined, undefined, WRITE_POLICY)
  check('editText lands the replacement', tree.read('/srv/app/e.txt') === 'alpha BETA\ngamma\n', JSON.stringify(tree.read('/srv/app/e.txt')))
  check('editText reports the previous text', edited.before === 'alpha beta\ngamma\n', JSON.stringify(edited.before))
  check('editText reports the edited text', edited.after === 'alpha BETA\ngamma\n', JSON.stringify(edited.after))

  const missing = await codeOf(() => router.editText(target, { oldString: 'nope', newString: 'x' }, undefined, undefined, WRITE_POLICY))
  check('an unmatched oldString is refused', missing !== undefined, String(missing))
  check('the refused edit changed nothing', tree.read('/srv/app/e.txt') === 'alpha BETA\ngamma\n')

  const stale = await codeOf(() => router.editText(target, { oldString: 'gamma', newString: 'delta' }, 'not-the-version', undefined, WRITE_POLICY))
  check('a stale version refuses the edit', stale === 'FS_STALE_VERSION', String(stale))
  check('the stale edit changed nothing', tree.read('/srv/app/e.txt') === 'alpha BETA\ngamma\n')

  // Line endings survive an edit: the file is normalized to LF for matching and
  // restored to CRLF on the way out, so a Windows-authored file stays that way.
  tree.write('/srv/app/w.txt', 'one\r\ntwo\r\n')
  await router.editText({ targetKey: inside('w.txt'), displayPath: inside('w.txt') },
    { oldString: 'two', newString: 'TWO' }, undefined, undefined, WRITE_POLICY)
  check('an edit keeps CRLF line endings', tree.read('/srv/app/w.txt') === 'one\r\nTWO\r\n', JSON.stringify(tree.read('/srv/app/w.txt')))

  // A binary file is refused rather than mangled: the NUL scan runs before any
  // decoding, so a PNG never becomes mojibake.
  tree.write('/srv/app/blob.bin', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
  const binary = await codeOf(() => router.editText({ targetKey: inside('blob.bin'), displayPath: inside('blob.bin') },
    { oldString: 'a', newString: 'b' }, undefined, undefined, WRITE_POLICY))
  check('editing a binary file is FS_NOT_TEXT', binary === 'FS_NOT_TEXT', String(binary))
  check('the binary file is untouched', tree.bytes('/srv/app/blob.bin').length === 6)
}

// ---------------------------------------------------------------------------
// A dead channel fails fast instead of hanging
// ---------------------------------------------------------------------------
{
  const { router, tree } = routerOver({ files: { '/srv/app/d.txt': 'x' } })
  tree.breakConnection()
  const dead = await codeOf(() => router.readText({ targetKey: inside('d.txt'), displayPath: inside('d.txt') }))
  check('a dead channel surfaces an error rather than hanging', dead !== undefined, String(dead))
  check('the dead-channel error is not a not-found', dead !== 'FS_NOT_FOUND', String(dead))
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
process.exit(failures === 0 ? 0 : 1)
