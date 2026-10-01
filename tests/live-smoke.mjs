/**
 * Live SFTP filesystem smoke test against a real SSH host.
 *
 * Exercises the RemoteFileSystem contract end to end — resolve / stat /
 * listDir / readText / streamText / writeText / editText / readBytes / the
 * write fence / the error taxonomy / atomic publication / symlinks — plus the
 * engine's tuning knobs and shell quoting. Nothing here touches DSH: it mounts
 * the router directly.
 *
 * The host is taken from the environment — no aliases are baked in:
 *   DSH_WS_TEST_ALIAS  an alias resolvable from the host store / ~/.ssh/config
 *   DSH_WS_TEST_DIR    remote scratch parent dir (default /tmp/dsh-ssh-workspace-test)
 *   DSH_CORE_ROOT      a node_modules dir holding ssh2 and @deepseek-ai/dsh-fs
 *                      (when unset, the plugin's own node_modules must have them)
 *
 * The suite SKIPs cleanly when DSH_WS_TEST_ALIAS is unset or the peers cannot
 * be resolved.
 *
 * Run: DSH_WS_TEST_ALIAS=myhost node tests/live-smoke.mjs
 */

import path from 'node:path'

const alias = process.env.DSH_WS_TEST_ALIAS
if (!alias) {
  console.log('\n=== live smoke ===\n')
  console.log('  SKIP  DSH_WS_TEST_ALIAS is not set (needs a real SSH host)')
  console.log('\n=== 0 passed, 0 failed, 1 suite skipped ===')
  process.exit(0)
}
if (process.env.DSH_CORE_ROOT !== undefined && process.env.DSH_CORE_ROOT !== '') {
  process.env.DSH_PEER_ROOT = [process.env.DSH_CORE_ROOT, process.env.DSH_PEER_ROOT].filter(Boolean).join(path.delimiter)
}

const sandbox = process.env.DSH_WS_TEST_DIR ?? '/tmp/dsh-ssh-workspace-test'

const failures = []
const passes = []
function check (name, condition, detail) {
  if (condition) {
    passes.push(name)
    console.log(`  PASS  ${name}`)
  } else {
    failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log(`\n=== live smoke (alias=${alias}, dir=${sandbox}) ===\n`)

// The plugin's peers (ssh2, @deepseek-ai/dsh-fs) must resolve before the
// modules can even load; this is the one place that legitimately skips.
let HostStore, SshWorkspaceEngine, RemoteFileSystem, formatRemotePath, ENGINE_DEFAULTS, shellQuote
try {
  ;({ HostStore } = await import('../lib/hosts.js'))
  ;({ SshWorkspaceEngine, ENGINE_DEFAULTS, shellQuote } = await import('../lib/engine.js'))
  ;({ RemoteFileSystem } = await import('../lib/remote-fs.js'))
  ;({ formatRemotePath } = await import('../lib/protocol.js'))
} catch (error) {
  console.log(`  SKIP  the plugin's peers are not resolvable here: ${error instanceof Error ? error.message : String(error)}`)
  console.log('        set DSH_CORE_ROOT to an assembled node_modules tree, or run npm install in the package root')
  console.log('\n=== 0 passed, 0 failed, 1 suite skipped ===')
  process.exit(0)
}

console.log('[engine tuning]')
{
  const tuned = new SshWorkspaceEngine({ idleTimeoutMs: 1234, sweepIntervalMs: Number.NaN, connectTimeoutMs: -1 })
  check('a numeric option overrides the default', tuned.tuning.idleTimeoutMs === 1234, String(tuned.tuning.idleTimeoutMs))
  check('a NaN option falls back to the default', tuned.tuning.sweepIntervalMs === ENGINE_DEFAULTS.sweepIntervalMs, String(tuned.tuning.sweepIntervalMs))
  check('a negative option falls back to the default', tuned.tuning.connectTimeoutMs === ENGINE_DEFAULTS.connectTimeoutMs, String(tuned.tuning.connectTimeoutMs))
  check('unspecified options keep their defaults', tuned.tuning.keepaliveIntervalMs === ENGINE_DEFAULTS.keepaliveIntervalMs, String(tuned.tuning.keepaliveIntervalMs))
  tuned.dispose()
}

console.log('\n[shell quoting]')
check('quotes a plain word', shellQuote('plain') === "'plain'", shellQuote('plain'))
check('neutralizes an embedded single quote', shellQuote("a'b") === "'a'\\''b'", shellQuote("a'b"))
check('neutralizes shell metacharacters', shellQuote('a b; rm -rf /') === "'a b; rm -rf /'", shellQuote('a b; rm -rf /'))

const store = new HostStore()
console.log(`\n[hosts] store=${store.path}`)
const rows = store.rows()
console.log(`  available hosts: ${rows.map(row => `${row.alias}(${row.source})`).join(', ') || 'none'}`)
let resolved
try {
  resolved = store.resolve(alias)
} catch (error) {
  console.log(`  FAIL  alias ${JSON.stringify(alias)} is not resolvable: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
console.log(`  ${alias} -> ${resolved.user}@${resolved.host}:${resolved.port} auth=${resolved.auth.kind} source=${resolved.source}`)

const engine = new SshWorkspaceEngine({ store })
const router = new RemoteFileSystem({ engine })
engine.attachFileSystem(router)
const workspacePath = router.addRoot(alias, sandbox)
console.log(`  mounted root: ${workspacePath}`)

const target = (p) => ({ targetKey: formatRemotePath(alias, p), displayPath: formatRemotePath(alias, p) })

try {
  // Prepare a scratch directory through the engine's own exec (proves exec too).
  console.log('\n[exec]')
  const prepared = await engine.exec(alias, `rm -rf ${sandbox} && mkdir -p ${sandbox}/sub && echo READY`)
  check('remote exec runs a command', prepared.success && prepared.stdout.includes('READY'), JSON.stringify(prepared))
  check('remote exec reports an exit code', prepared.exitCode === 0, String(prepared.exitCode))

  const failing = await engine.exec(alias, 'exit 7')
  check('remote exec reports a non-zero exit code', failing.exitCode === 7, String(failing.exitCode))

  // --- resolve / stat ------------------------------------------------------
  console.log('\n[resolve + stat]')
  const resolvedTarget = await router.resolve(`${workspacePath}/sub`, {})
  check('resolve maps a relative remote path', resolvedTarget.displayPath === formatRemotePath(alias, `${sandbox}/sub`), resolvedTarget.displayPath)

  const dirStats = await router.stat(target(sandbox), undefined)
  check('stat reports a directory', dirStats?.type === 'directory', JSON.stringify(dirStats))

  const missing = await router.stat(target(`${sandbox}/nope`), undefined)
  check('stat of a missing path is undefined', missing === undefined, JSON.stringify(missing))

  // --- write / read --------------------------------------------------------
  console.log('\n[writeText + readText]')
  const filePath = `${sandbox}/hello.txt`
  const firstLine = 'line one'
  const content = `${firstLine}\nline two\nline three\n`
  const created = await router.writeText(target(filePath), content, undefined, undefined, undefined)
  check('writeText reports a create', created.operation === 'create', created.operation)
  check('writeText returns a version', typeof created.version === 'string' && created.version.length > 0, created.version)

  const readBack = await router.readText(target(filePath), undefined)
  check('readText round-trips exactly', readBack === content, JSON.stringify(readBack))

  // --- streamText rides its own channel ------------------------------------
  console.log('\n[streamText]')
  const chunks = []
  for await (const chunk of await router.streamText(target(filePath), undefined)) chunks.push(chunk)
  check('streamText yields the whole file', chunks.join('') === content, JSON.stringify(chunks.join('')))

  const update = await router.writeText(target(filePath), `${content}line four\n`, { kind: 'replaceIfVersion', version: created.version }, undefined, undefined)
  check('writeText reports an update', update.operation === 'update', update.operation)

  let staleCode
  try {
    await router.writeText(target(filePath), 'nope', { kind: 'replaceIfVersion', version: created.version }, undefined, undefined)
  } catch (error) {
    staleCode = error.code
  }
  check('a stale version is refused with FS_STALE_VERSION', staleCode === 'FS_STALE_VERSION', String(staleCode))

  let notObservedCode
  try {
    await router.writeText(target(`${sandbox}/fresh.txt`), 'x', { kind: 'createIfAbsent' }, undefined, undefined)
    await router.writeText(target(`${sandbox}/fresh.txt`), 'y', { kind: 'createIfAbsent' }, undefined, undefined)
  } catch (error) {
    notObservedCode = error.code
  }
  check('createIfAbsent refuses to clobber with FS_NOT_OBSERVED', notObservedCode === 'FS_NOT_OBSERVED', String(notObservedCode))

  // --- editText ------------------------------------------------------------
  console.log('\n[editText]')
  const beforeEdit = await router.stat(target(filePath), undefined)
  const edited = await router.editText(target(filePath), { oldString: firstLine, newString: 'LINE ONE' }, beforeEdit.version, undefined)
  check('editText replaced the literal', edited.after.includes('LINE ONE'), edited.after)
  check('editText returns the pre-edit content', edited.before.includes('line one'), edited.before)
  const afterEdit = await router.readText(target(filePath), undefined)
  check('editText persisted to the remote file', afterEdit.includes('LINE ONE') && !afterEdit.includes('line one'), JSON.stringify(afterEdit))

  let ambiguous
  try {
    await router.editText(target(filePath), { oldString: 'line', newString: 'x' }, undefined, undefined)
  } catch (error) {
    ambiguous = error.code
  }
  check('an ambiguous literal edit is refused', ambiguous === 'FS_AMBIGUOUS_EDIT', String(ambiguous))

  let notFound
  try {
    await router.editText(target(filePath), { oldString: 'zzz-not-present', newString: 'x' }, undefined, undefined)
  } catch (error) {
    notFound = error.code
  }
  check('a missing literal edit is refused', notFound === 'FS_EDIT_NOT_FOUND', String(notFound))

  // CRLF preservation
  const crlfPath = `${sandbox}/crlf.txt`
  await router.writeText(target(crlfPath), 'a\r\nb\r\nc\r\n', undefined, undefined, undefined)
  const crlfBefore = await router.stat(target(crlfPath), undefined)
  await router.editText(target(crlfPath), { oldString: 'b', newString: 'B' }, crlfBefore.version, undefined)
  const crlfAfter = await router.readBytes(target(crlfPath), undefined, 1024)
  check('editText preserves CRLF line endings', Buffer.from(crlfAfter).toString('utf8') === 'a\r\nB\r\nc\r\n', JSON.stringify(Buffer.from(crlfAfter).toString('utf8')))

  // --- listDir -------------------------------------------------------------
  console.log('\n[listDir]')
  const listing = await router.listDir(target(sandbox), undefined)
  const names = listing.map(entry => entry.name)
  check('listDir returns direct children', names.includes('hello.txt') && names.includes('sub'), names.join(','))
  check('listDir classifies a directory', listing.find(entry => entry.name === 'sub')?.type === 'directory', JSON.stringify(listing.find(entry => entry.name === 'sub')))
  check('listDir reports a file size', (listing.find(entry => entry.name === 'hello.txt')?.size ?? -1) > 0, String(listing.find(entry => entry.name === 'hello.txt')?.size))
  check('listDir entries are sorted', JSON.stringify(names) === JSON.stringify([...names].sort((a, b) => a.localeCompare(b))), names.join(','))
  check('listDir gives each child a resolved target', listing.every(entry => entry.target?.targetKey?.startsWith('ssh://')), JSON.stringify(listing[0]?.target))

  // --- binary / utf-8 ------------------------------------------------------
  console.log('\n[binary + encoding]')
  const binaryUpload = await engine.exec(alias, `printf 'a\\000b' > ${sandbox}/bin.dat && echo done`)
  check('prepared a binary file', binaryUpload.success, binaryUpload.stderr)
  let binaryCode
  try {
    await router.readText(target(`${sandbox}/bin.dat`), undefined)
  } catch (error) {
    binaryCode = error.code
  }
  check('readText refuses binary content with FS_NOT_TEXT', binaryCode === 'FS_NOT_TEXT', String(binaryCode))
  const rawBytes = await router.readBytes(target(`${sandbox}/bin.dat`), undefined, 1024)
  check('readBytes returns raw bytes including NUL', rawBytes.length === 3 && rawBytes[1] === 0, JSON.stringify([...rawBytes]))

  let tooLarge
  try {
    await router.readBytes(target(`${sandbox}/bin.dat`), undefined, 1)
  } catch (error) {
    tooLarge = error.code
  }
  check('readBytes enforces maxBytes with FS_TOO_LARGE', tooLarge === 'FS_TOO_LARGE', String(tooLarge))

  const window = await router.readByteRange(target(filePath), { offset: 0, length: 4 }, undefined)
  check('readByteRange returns the requested window', Buffer.from(window).toString('utf8') === 'LINE', JSON.stringify(Buffer.from(window).toString('utf8')))

  // --- nested write creates parents ---------------------------------------
  console.log('\n[parent creation]')
  const deep = `${sandbox}/a/b/c/deep.txt`
  await router.writeText(target(deep), 'deep\n', undefined, undefined, undefined)
  check('writeText creates missing parent directories', (await router.readText(target(deep), undefined)) === 'deep\n')

  // --- the write fence -----------------------------------------------------
  console.log('\n[write fence]')
  let fenceCode
  try {
    await router.writeText(target('/tmp/dsh-ssh-workspace-outside.txt'), 'nope', undefined, undefined, undefined)
  } catch (error) {
    fenceCode = error.code
  }
  check('writing outside every mounted root is refused', fenceCode === 'FS_SANDBOX_DENIED', String(fenceCode))
  const stillReadable = await router.stat(target('/tmp'), undefined)
  check('reads outside the fence remain available', stillReadable?.type === 'directory', JSON.stringify(stillReadable))

  // --- errors --------------------------------------------------------------
  console.log('\n[error taxonomy]')
  let missingRead
  try {
    await router.readText(target(`${sandbox}/absent.txt`), undefined)
  } catch (error) {
    missingRead = error.code
  }
  check('reading a missing file is FS_NOT_FOUND', missingRead === 'FS_NOT_FOUND', String(missingRead))

  let notADirectory
  try {
    await router.listDir(target(filePath), undefined)
  } catch (error) {
    notADirectory = error.code
  }
  check('listing a file is FS_NOT_DIRECTORY', notADirectory === 'FS_NOT_DIRECTORY', String(notADirectory))

  let notRegular
  try {
    await router.readText(target(sandbox), undefined)
  } catch (error) {
    notRegular = error.code
  }
  check('reading a directory is FS_NOT_REGULAR_FILE', notRegular === 'FS_NOT_REGULAR_FILE', String(notRegular))

  let watchUnsupported = false
  try {
    await router.watch(target(filePath), () => {}, new AbortController().signal)
  } catch {
    watchUnsupported = true
  }
  check('watch on a remote target rejects', watchUnsupported)

  // --- atomic publication leaves no litter --------------------------------
  console.log('\n[atomic publication]')
  const litter = await engine.exec(alias, `ls -a ${sandbox} | grep -c '^\\.dsh-tmp-' || true`)
  check('no staging directories were left behind', litter.stdout.trim() === '0', JSON.stringify(litter.stdout))

  const permissions = await engine.exec(alias, `stat -c '%a' ${sandbox}/hello.txt`)
  check('the published file has plausible permissions', /^[0-7]{3,4}$/.test(permissions.stdout.trim()), permissions.stdout.trim())

  // --- symlink handling ----------------------------------------------------
  console.log('\n[symlinks]')
  await engine.exec(alias, `ln -sf ${sandbox}/hello.txt ${sandbox}/link.txt`)
  const linkStat = await router.stat(target(`${sandbox}/link.txt`), undefined)
  check('stat follows a symlink to a file', linkStat?.type === 'file', JSON.stringify(linkStat))
  const linkLstat = await router.lstat(formatRemotePath(alias, `${sandbox}/link.txt`), {}, undefined)
  check('lstat reports the symlink itself', linkLstat?.type === 'symlink', JSON.stringify(linkLstat))
} catch (error) {
  failures.push(`unexpected exception: ${error?.stack ?? error}`)
  console.error('\nUNEXPECTED EXCEPTION\n', error)
} finally {
  try {
    await engine.exec(alias, `rm -rf ${sandbox}`)
    console.log('\ncleaned up the remote scratch directory')
  } catch { /* best effort */ }
  engine.dispose()
}

console.log(`\n=== ${passes.length} passed, ${failures.length} failed ===`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
