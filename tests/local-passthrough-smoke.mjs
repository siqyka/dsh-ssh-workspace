/**
 * Local-path passthrough smoke.
 *
 * A chat upload is stored on the machine running DSH, but a session whose
 * workspace is `ssh://<alias>/<path>` treats a bare absolute path as remote.
 * This suite pins the explicit-prefix exception: configured host prefixes keep
 * their local meaning, every other spelling keeps the remote meaning, and the
 * router never hands a remote cwd back to the patched local backend (which
 * would recurse).
 *
 * Run: node tests/local-passthrough-smoke.mjs
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import nodePath from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  PASS  ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

if (process.env.DSH_CORE_ROOT) {
  process.env.DSH_PEER_ROOT = [process.env.DSH_CORE_ROOT, process.env.DSH_PEER_ROOT]
    .filter(Boolean)
    .join(nodePath.delimiter)
}

const {
  buildPassthrough, DEFAULT_LOCAL_SCHEME, DEFAULT_PASSTHROUGH, hostReferencePathsInText,
  isPosixHostPath, isWindowsHostPath, looksLocalAbsolute, MIN_SCHEME_LENGTH, normalizeLocalSpelling,
  normalizeScheme, parseLocalScheme, SCHEMES_IN_USE, schemeRefusal, schemeRules,
} = await import(pathToFileURL(nodePath.join(pluginRoot, 'lib/passthrough.js')).href)
const { HostConfigStore, passthroughOf } = await import(pathToFileURL(nodePath.join(pluginRoot, 'lib/store.js')).href)
const { PassthroughSettings } = await import(pathToFileURL(nodePath.join(pluginRoot, 'lib/passthrough-settings.js')).href)
const { RemoteFileSystem } = await import(pathToFileURL(nodePath.join(pluginRoot, 'lib/remote-fs.js')).href)
const { installBuiltinBridge, uninstallBuiltinBridge } =
  await import(pathToFileURL(nodePath.join(pluginRoot, 'lib/fs-shim.js')).href)
const { installRemoteFileSystem, uninstallRemoteFileSystem } =
  await import(pathToFileURL(nodePath.join(pluginRoot, 'lib/patch-fs.js')).href)

const ALIAS = 'passthroughhost'
const REMOTE_ROOT = '/home/dev/proj'
const SSH_CWD = `ssh://${ALIAS}${REMOTE_ROOT}`
const FAKE_USER_HOME = process.platform === 'win32' ? 'C:\\Users\\me' : '/Users/me'
const FAKE_HOME = nodePath.join(FAKE_USER_HOME, '.dsh')

console.log('\n=== local-passthrough smoke ===\n')

console.log('[1] prefix configuration and expansion')
{
  const warnings = []
  const defaults = buildPassthrough(undefined, {
    env: { DSH_HOME: FAKE_HOME },
    home: FAKE_USER_HOME,
    warn: message => warnings.push(message),
  })
  check('undefined uses the two default prefixes',
    defaults.prefixes.length === 2 && defaults.enabled === true,
    JSON.stringify(defaults.prefixes))
  check('the default prefixes are attachments and plugins',
    defaults.prefixes[0] === normalizeLocalSpelling(`${FAKE_HOME}/attachments`) &&
      defaults.prefixes[1] === normalizeLocalSpelling(`${FAKE_HOME}/plugins`),
    JSON.stringify(defaults.prefixes))
  check('DEFAULT_PASSTHROUGH is exactly two entries',
    DEFAULT_PASSTHROUGH.length === 2,
    JSON.stringify(DEFAULT_PASSTHROUGH))
  check('the whole DSH home is not a default',
    !DEFAULT_PASSTHROUGH.some(entry => entry === '$DSH_HOME' || entry === '${DSH_HOME}'),
    JSON.stringify(DEFAULT_PASSTHROUGH))

  const expanded = buildPassthrough(
    ['$DSH_HOME/one', '${DSH_HOME}/two', '~/three'],
    { env: { DSH_HOME: FAKE_HOME }, home: FAKE_USER_HOME, warn: message => warnings.push(message) },
  )
  check('$DSH_HOME, ${DSH_HOME}, and ~ are expanded',
    expanded.prefixes.length === 3 &&
      expanded.prefixes[0] === normalizeLocalSpelling(`${FAKE_HOME}/one`) &&
      expanded.prefixes[1] === normalizeLocalSpelling(`${FAKE_HOME}/two`) &&
      expanded.prefixes[2] === normalizeLocalSpelling(nodePath.join(FAKE_USER_HOME, 'three')),
    JSON.stringify(expanded.prefixes))

  const refused = buildPassthrough(
    ['$FOO/x', 'relative/x', 'ssh://host/x', 42, ''],
    { env: { DSH_HOME: FAKE_HOME }, home: FAKE_USER_HOME, warn: message => warnings.push(message) },
  )
  check('unknown variables, relative paths, ssh:// spellings, non-strings, and empty entries are refused',
    refused.prefixes.length === 0 && refused.enabled === false,
    JSON.stringify(refused.prefixes))
  check('every refused entry produced a warning',
    warnings.length >= 5,
    `warnings=${warnings.length}`)
  check('an unsupported variable is named as the reason, not silently unchecked',
    warnings.some(message => message.includes('unsupported environment variable')),
    JSON.stringify(warnings))

  const wholeHome = buildPassthrough(
    ['$DSH_HOME'],
    { env: { DSH_HOME: FAKE_HOME }, home: FAKE_USER_HOME, warn: message => warnings.push(message) },
  )
  check('the whole DSH home is refused',
    wholeHome.prefixes.length === 0 && warnings.some(message => message.includes('whole DSH home')),
    JSON.stringify(wholeHome.prefixes))

  // An unsupported variable is refused even when the rest of the spelling is a
  // perfectly good absolute path — otherwise `$FOO` would silently become a
  // literal directory name and the prefix would match nothing the user meant.
  const unknownVariable = buildPassthrough(
    [`${FAKE_HOME}/$FOO/x`],
    { env: { DSH_HOME: FAKE_HOME }, home: FAKE_USER_HOME, warn: message => warnings.push(message) },
  )
  check('an unknown variable is refused even inside an absolute path',
    unknownVariable.prefixes.length === 0 && unknownVariable.enabled === false,
    JSON.stringify(unknownVariable.prefixes))

  const disabledArray = buildPassthrough([], { env: { DSH_HOME: FAKE_HOME }, home: FAKE_USER_HOME })
  const disabledFlag = buildPassthrough(false, { env: { DSH_HOME: FAKE_HOME }, home: FAKE_USER_HOME })
  check('false and [] both disable passthrough',
    disabledArray.enabled === false && disabledFlag.enabled === false)
  check('a single string is accepted as one prefix',
    buildPassthrough('$DSH_HOME/attachments', { env: { DSH_HOME: FAKE_HOME }, home: FAKE_USER_HOME }).enabled === true)
}

console.log('\n[2] lexical matching boundaries')
{
  const matcher = buildPassthrough(undefined, { env: { DSH_HOME: FAKE_HOME }, home: FAKE_USER_HOME })
  const attachment = `${FAKE_HOME}/attachments/v1/files/x.txt`
  check('a path at the prefix matches', matcher.matches(`${FAKE_HOME}/attachments`) === true)
  check('a path below the prefix matches', matcher.matches(attachment) === true)
  check('a sibling name with the same text prefix does not match',
    matcher.matches(`${FAKE_HOME}/attachments2/x.txt`) === false)
  check('a trailing separator still matches',
    matcher.matches(`${FAKE_HOME}/attachments/`) === true)
  check('a dot segment inside the prefix matches',
    matcher.matches(`${FAKE_HOME}/attachments/./x.txt`) === true)
  check('a .. escape out of the prefix does not match',
    matcher.matches(`${FAKE_HOME}/attachments/../dsh-ssh.json`) === false)
  check('an ssh:// spelling never matches',
    matcher.matches(`ssh://${ALIAS}/Users/me/.dsh/attachments/x`) === false)
  check('a relative spelling never matches', matcher.matches('attachments/x') === false)
  check('an empty spelling never matches', matcher.matches('') === false)
  check('a non-string never matches', matcher.matches(42) === false)
  check('looksLocalAbsolute accepts POSIX and Windows shapes',
    looksLocalAbsolute('/Users/me/x') && looksLocalAbsolute('C:\\Users\\me\\x') &&
      looksLocalAbsolute('\\\\server\\share\\x'))
  check('looksLocalAbsolute rejects ssh:// and relative spellings',
    !looksLocalAbsolute(`ssh://${ALIAS}/x`) && !looksLocalAbsolute('src/x.js'))

  // Case folding is a PLATFORM rule, not the process's: a matcher pinned to
  // `win32` folds the path behind the prefix, one pinned to `darwin` does not
  // (see the comment on `compareSpelling`). Pin both and assert each BOTH ways,
  // so a "helpful" darwin fold cannot pass by being right on only one side.
  // The old assertion here was `check('POSIX case-insensitivity is not
  // applicable on this platform', true)` — a constant `true`, i.e. no test at
  // all on every non-Windows host; that is exactly how a darwin regression
  // could have shipped unnoticed.
  // The fixture is Windows-shaped on purpose: a matcher pinned to `win32` must
  // fold a Windows path, and reusing the host's own spelling would make the
  // assertion true for the wrong reason on Windows and false on POSIX.
  const windowsPinned = buildPassthrough(undefined, {
    env: { DSH_HOME: 'C:\\Users\\me\\.dsh' },
    home: 'C:\\Users\\me',
    platform: 'win32',
  })
  const macPinned = buildPassthrough(undefined, {
    env: { DSH_HOME: FAKE_HOME },
    home: FAKE_USER_HOME,
    platform: 'darwin',
  })
  check('a win32 matcher folds a differently-cased spelling of a configured prefix',
    windowsPinned.matches('c:\\USERS\\ME\\.DSH\\ATTACHMENTS\\v1\\files\\x.txt') === true)
  check('...and folds a @ mention the same way',
    windowsPinned.addHostReference('C:\\Users\\me\\Notes\\a.md') === true &&
      windowsPinned.isNamed('c:\\USERS\\me\\notes\\A.md') === true)
  // The darwin pair is the point: the same fixture, the two spellings, opposite
  // answers. Only a rule that follows the platform can produce that.
  check('darwin matching keeps the case it was given',
    macPinned.addHostReference('/Volumes/SSD/x.md') === true &&
      macPinned.isNamed('/Volumes/SSD/x.md') === true)
  check('darwin does not fold a differently-cased mention',
    macPinned.isNamed('/volumes/ssd/x.md') === false,
    'darwin folded a path it must compare exactly — see compareSpelling')
}

console.log('\n[3] path.resolve, path.relative, and empty-passthrough fallback')
{
  // A POSIX spelling proves the path-resolver branch on every platform: on
  // Windows native resolve would otherwise turn it into a drive path before
  // the remote fold runs.
  const attachment = '/Users/me/.dsh/attachments/v1/files/x.txt'
  // Keep this fixture in POSIX form on Windows too: the prefix matcher is
  // lexical, so a Windows-shaped DSH_HOME would not cover this spelling.
  const matcher = buildPassthrough(undefined, { env: { DSH_HOME: '/Users/me/.dsh' }, home: '/Users/me' })
  const empty = buildPassthrough([], { env: { DSH_HOME: FAKE_HOME }, home: FAKE_USER_HOME })
  try {
    installBuiltinBridge({ engine: {}, router: {}, passthrough: matcher })
    check('path.resolve folds a matched host attachment back to the host path',
      nodePath.resolve(SSH_CWD, attachment) === nodePath.resolve(attachment),
      nodePath.resolve(SSH_CWD, attachment))
    check('path.relative answers the host attachment unchanged',
      nodePath.relative(SSH_CWD, attachment) === attachment,
      nodePath.relative(SSH_CWD, attachment))
    check('path.resolve keeps an unmatched local-looking path remote',
      nodePath.resolve(SSH_CWD, '/Users/me/notes') === `ssh://${ALIAS}/Users/me/notes`,
      nodePath.resolve(SSH_CWD, '/Users/me/notes'))
    check('path.resolve keeps a relative path under the remote cwd',
      nodePath.resolve(SSH_CWD, 'src/a.js') === `ssh://${ALIAS}${REMOTE_ROOT}/src/a.js`,
      nodePath.resolve(SSH_CWD, 'src/a.js'))

    installBuiltinBridge({ engine: {}, router: {}, passthrough: empty })
    check('a hot reload to an empty matcher restores the old remote spelling',
      nodePath.resolve(SSH_CWD, attachment) === `ssh://${ALIAS}/Users/me/.dsh/attachments/v1/files/x.txt`,
      nodePath.resolve(SSH_CWD, attachment))
  } finally {
    uninstallBuiltinBridge()
  }
}

console.log('\n[4] RemoteFileSystem routing')
{
  const temp = mkdtempSync(nodePath.join(tmpdir(), 'dsh-ws-passthrough-'))
  const dshHome = temp
  const attachment = nodePath.join(temp, 'attachments', 'v1', 'files', 'x.txt')
  const escape = nodePath.join(temp, 'attachments', '..', 'dsh-ssh.json')
  const matcher = buildPassthrough(undefined, { env: { DSH_HOME: dshHome }, home: temp })
  const calls = []
  const base = {
    async resolve (path, opts) {
      calls.push({ method: 'resolve', path, opts })
      return { targetKey: path, displayPath: path }
    },
    async lstat (path, opts) {
      calls.push({ method: 'lstat', path, opts })
      return { type: 'file', size: 3 }
    },
    async readText (target) {
      calls.push({ method: 'readText', target })
      return 'local-bytes'
    },
  }
  // A remote cwd handed back to the local backend would route through the
  // patched resolve again (routingSpelling reads opts.cwd) and recurse until the
  // stack overflows. Recording the cwd instead of throwing keeps that mutation a
  // readable FAIL line rather than an uncaught exception that hides the cause.
  const strippedCwd = () => calls.every(call => !String(call.opts?.cwd ?? '').startsWith('ssh://'))
  try {
    const router = new RemoteFileSystem({ engine: {}, base, passthrough: matcher })
    const resolved = await router.resolve(attachment, { cwd: SSH_CWD })
    check('router.resolve sends a matched host path to the local backend',
      resolved.displayPath === attachment && resolved.targetKey === attachment,
      JSON.stringify(resolved))
    check('the local backend never receives the remote cwd',
      calls.length === 1 && calls[0].method === 'resolve' && calls[0].opts?.cwd === undefined && strippedCwd(),
      JSON.stringify(calls))

    const stats = await router.lstat(attachment, { cwd: SSH_CWD })
    check('router.lstat also strips the remote cwd and reaches the local backend',
      stats.type === 'file' && calls.some(call => call.method === 'lstat' && call.opts?.cwd === undefined) &&
        strippedCwd(),
      JSON.stringify(stats))

    const unmatched = await router.resolve('/Users/me/notes', { cwd: SSH_CWD })
    check('an unmatched local-looking path keeps the remote meaning',
      unmatched.targetKey === `ssh://${ALIAS}/Users/me/notes`,
      unmatched.targetKey)
    const outside = nodePath.join(temp, 'outside.txt')
    writeFileSync(outside, 'exists locally but is not configured')
    const outsideTarget = await router.resolve(outside, { cwd: SSH_CWD })
    check('an existing host file outside the prefix stays remote (no existence probe)',
      String(outsideTarget.targetKey).startsWith(`ssh://${ALIAS}/`),
      outsideTarget.targetKey)
    const escaped = await router.resolve(escape, { cwd: SSH_CWD })
    check('a .. escape out of the prefix keeps the remote meaning',
      String(escaped.targetKey).startsWith(`ssh://${ALIAS}/`),
      escaped.targetKey)

    const read = await router.readText({ targetKey: attachment, displayPath: attachment })
    check('a local target reads through the local backend',
      read === 'local-bytes' && calls.some(call => call.method === 'readText'),
      read)

    const noBase = new RemoteFileSystem({ engine: {}, passthrough: matcher })
    try {
      await noBase.resolve(attachment, { cwd: SSH_CWD })
      check('a matched path without a local backend reports FS_IO_ERROR', false)
    } catch (error) {
      check('a matched path without a local backend reports FS_IO_ERROR',
        error?.code === 'FS_IO_ERROR' && String(error.message).includes('no local filesystem backend'),
        `${error?.code}: ${error?.message}`)
    }

    const disabledRouter = new RemoteFileSystem({ engine: {}, base, passthrough: buildPassthrough([], { env: { DSH_HOME: dshHome }, home: temp }) })
    const disabled = await disabledRouter.resolve(attachment, { cwd: SSH_CWD })
    check('an empty matcher keeps the attachment remote',
      String(disabled.targetKey).startsWith(`ssh://${ALIAS}/`) && disabled.targetKey !== attachment,
      disabled.targetKey)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

console.log('\n[5] hot reload rebinds the live matcher')
{
  const temp = mkdtempSync(nodePath.join(tmpdir(), 'dsh-ws-passthrough-'))
  const dshHome = temp
  const attachment = nodePath.join(temp, 'attachments', 'v1', 'files', 'x.txt')
  const matcher = buildPassthrough(undefined, { env: { DSH_HOME: dshHome }, home: temp })
  const empty = buildPassthrough([], { env: { DSH_HOME: dshHome }, home: temp })
  class BaseFs {
    async resolve (path, opts) {
      if (opts?.cwd?.startsWith('ssh://')) throw new Error('remote cwd was handed back to the local backend')
      return { targetKey: path, displayPath: path }
    }

    async lstat (path) { return { type: 'file' } }
  }
  const target = new BaseFs()
  const ctx = { get: name => name === 'fs' ? target : undefined }
  try {
    const first = installRemoteFileSystem(ctx, { engine: {}, passthrough: matcher }, RemoteFileSystem)
    check('installRemoteFileSystem passes the matcher to a fresh router',
      first?.passthrough === matcher)
    const local = await target.resolve(attachment, { cwd: SSH_CWD })
    check('the installed facade resolves a matched path locally',
      local.displayPath === attachment,
      JSON.stringify(local))

    const second = installRemoteFileSystem(ctx, { engine: {}, passthrough: empty }, RemoteFileSystem)
    check('a second install returns the same router', second === first)
    check('a second install rebinds the matcher', second.passthrough === empty)
    const remote = await target.resolve(attachment, { cwd: SSH_CWD })
    check('the rebound matcher restores the remote spelling',
      String(remote.targetKey).startsWith(`ssh://${ALIAS}/`) && remote.targetKey !== attachment,
      remote.targetKey)
  } finally {
    uninstallRemoteFileSystem(target)
    rmSync(temp, { recursive: true, force: true })
  }
}

console.log('\n[6] @ host references named by the user')
{
  const WINDOWS_HOME = 'C:\\Users\\me'
  const WINDOWS_DSH_HOME = 'C:\\Users\\me\\.dsh'
  const windowsMatcher = (options = {}) => buildPassthrough(['C:\\Users\\me\\.dsh\\attachments'], {
    env: { DSH_HOME: WINDOWS_DSH_HOME },
    home: WINDOWS_HOME,
    platform: 'win32',
    ...options,
  })

  check('isWindowsHostPath accepts drive and UNC spellings only',
    isWindowsHostPath('F:\\123.txt') &&
      isWindowsHostPath('\\\\server\\share\\x') &&
      !isWindowsHostPath('/tmp/x') &&
      !isWindowsHostPath('src/x') &&
      !isWindowsHostPath(`ssh://${ALIAS}/x`) &&
      !isWindowsHostPath('') &&
      !isWindowsHostPath(42))

  const text = '读 @F:\\123.txt，还有 @"C:\\Users\\me\\a b.txt" 和 @src/a.js 与 @/tmp/x'
  const extracted = hostReferencePathsInText(text)
  check('quoted and unquoted @ host paths are extracted in message order',
    JSON.stringify(extracted) === JSON.stringify(['C:\\Users\\me\\a b.txt', 'F:\\123.txt']),
    JSON.stringify(extracted))
  check('a trailing separator belongs to the punctuation, not the path',
    JSON.stringify(hostReferencePathsInText('see @F:\\dir\\ and @F:\\a.txt.')) ===
      JSON.stringify(['F:\\dir', 'F:\\a.txt']))
  check('a mention glued to a word is not a reference',
    hostReferencePathsInText('mail x@F:\\mail.txt').length === 0)
  check('an @ right after CJK text is still a reference',
    JSON.stringify(hostReferencePathsInText('读@F:\\a.txt')) === JSON.stringify(['F:\\a.txt']) &&
      JSON.stringify(hostReferencePathsInText('路径：@F:\\a.txt')) === JSON.stringify(['F:\\a.txt']))
  check('a quoted path may contain spaces and CJK text',
    JSON.stringify(hostReferencePathsInText('@"C:\\Users\\me\\目录 名\\x.txt"')) ===
      JSON.stringify(['C:\\Users\\me\\目录 名\\x.txt']))
  check('a UNC mention is extracted',
    JSON.stringify(hostReferencePathsInText('@\\\\server\\share\\x.txt')) ===
      JSON.stringify(['\\\\server\\share\\x.txt']))
  check('the same path twice in one message is returned once',
    hostReferencePathsInText('@F:\\a.txt and @f:\\A.TXT').length === 1)
  check('empty and non-string text yields no references',
    hostReferencePathsInText('').length === 0 && hostReferencePathsInText(42).length === 0)

  const matcher = windowsMatcher()
  check('a drive path stays remote until the user names it',
    matcher.matches('F:\\123.txt') === false)
  check('addHostReference accepts a drive path on a Windows platform',
    matcher.addHostReference('F:\\123.txt') === true)
  check('the named path now matches locally', matcher.matches('F:\\123.txt') === true)
  check('Windows case folding applies to a named path', matcher.matches('f:\\123.txt') === true)
  check('a sibling with the same text prefix does not match',
    matcher.matches('F:\\123.txt.bak') === false && matcher.matches('F:\\12\\x.txt') === false)
  check('a named directory covers its contents',
    matcher.addHostReference('F:\\proj') === true &&
      matcher.matches('F:\\proj\\a\\b.txt') === true &&
      matcher.matches('F:\\project\\x') === false)
  check('the reference list holds the normalized spelling',
    matcher.hostReferences.includes('F:\\123.txt'), JSON.stringify(matcher.hostReferences))
  check('the same reference twice is remembered once',
    matcher.addHostReference('F:\\123.txt') === false &&
      matcher.hostReferences.filter(entry => entry === 'F:\\123.txt').length === 1)

  check('the whole DSH home and its children are refused as references',
    matcher.addHostReference(WINDOWS_DSH_HOME) === false &&
      matcher.addHostReference(`${WINDOWS_DSH_HOME}\\dsh-ssh.json`) === false,
    JSON.stringify(matcher.hostReferences))
  check('a prefix inside the DSH home still matches without a mention',
    matcher.matches(`${WINDOWS_DSH_HOME}\\attachments\\v1\\x.txt`) === true)

  const posix = buildPassthrough(['/home/me/.dsh/attachments'], {
    env: { DSH_HOME: '/home/me/.dsh' },
    home: '/home/me',
    platform: 'linux',
  })
  check('a non-Windows platform never records an @ drive path',
    posix.addHostReference('F:\\123.txt') === false && posix.matches('F:\\123.txt') === false)

  // The platform gate alone is not the spelling gate: even on Windows a POSIX
  // or relative spelling must stay out of the table, or an /etc/passwd mention
  // pasted from a transcript would silently claim a remote path as local.
  check('a POSIX or relative spelling is never recorded, even on Windows',
    matcher.addHostReference('/tmp/x') === false &&
      matcher.addHostReference('src/a.js') === false &&
      matcher.matches('/tmp/x') === false &&
      !matcher.hostReferences.includes('/tmp/x'),
    JSON.stringify(matcher.hostReferences))
  const disabled = buildPassthrough(false, {
    env: { DSH_HOME: WINDOWS_DSH_HOME },
    home: WINDOWS_HOME,
    platform: 'win32',
  })
  check('a disabled matcher records nothing',
    disabled.addHostReference('F:\\123.txt') === false && disabled.matches('F:\\123.txt') === false)

  const capped = windowsMatcher()
  for (let index = 0; index < 256; index += 1) capped.addHostReference(`C:\\refs\\${index}.txt`)
  capped.addHostReference('C:\\refs\\last.txt')
  check('the reference list is bounded and evicts the oldest entry',
    capped.hostReferences.length === 256 &&
      !capped.hostReferences.includes('C:\\refs\\0.txt') &&
      capped.hostReferences.includes('C:\\refs\\last.txt') &&
      capped.matches('C:\\refs\\0.txt') === false &&
      capped.matches('C:\\refs\\last.txt') === true,
    `length=${capped.hostReferences.length}`)
}

console.log('\n[7] source wiring and single implementation')
{
  const index = readFileSync(nodePath.join(pluginRoot, 'lib/index.js'), 'utf8')
  const shim = readFileSync(nodePath.join(pluginRoot, 'lib/fs-shim.js'), 'utf8')
  const remote = readFileSync(nodePath.join(pluginRoot, 'lib/remote-fs.js'), 'utf8')
  const pass = readFileSync(nodePath.join(pluginRoot, 'lib/passthrough.js'), 'utf8')

  const installs = index.match(/installRemoteFileSystem\([^)]*passthrough[^)]*\)/gu) ?? []
  check('all three installRemoteFileSystem call sites carry passthrough',
    installs.length === 3,
    `found ${installs.length}`)
  check('installBuiltinBridge is called with passthrough',
    /installBuiltinBridge\(\{[^}]*passthrough[^}]*\}\)/u.test(index))
  check('index builds the matcher exactly once',
    (index.match(/buildPassthrough\(/gu) ?? []).length === 1)

  const shimSegment = shim.slice(
    shim.indexOf('function resolveRemoteSpelling'),
    shim.indexOf('function joinRemoteSpelling'),
  )
  check('the passthrough check precedes the POSIX absolute branch in fs-shim',
    shimSegment.indexOf('passthrough?.matches') >= 0 &&
      shimSegment.indexOf('passthrough?.matches') < shimSegment.indexOf("arg.startsWith('/')"))
  check('installBuiltinBridge rebinds passthrough on a reload',
    shim.includes('existing.passthrough = passthrough'))

  const resolveSegment = remote.slice(
    remote.indexOf('async resolve (path, opts)'),
    remote.indexOf('processPath (target)'),
  )
  check('RemoteFileSystem.resolve checks passthrough before the remote branch',
    resolveSegment.indexOf('#isPassthrough') >= 0 &&
      resolveSegment.indexOf('#isPassthrough') < resolveSegment.indexOf('isRemotePath(path)'))
  const lstatSegment = remote.slice(
    remote.indexOf('async lstat (path, opts, signal)'),
    remote.indexOf('async readText'),
  )
  check('RemoteFileSystem.lstat checks passthrough before the remote branch',
    lstatSegment.indexOf('#isPassthrough') >= 0 &&
      lstatSegment.indexOf('#isPassthrough') < lstatSegment.indexOf('isRemotePath(path)'))
  check('the router stores a matcher on construction',
    remote.includes('this.passthrough = options.passthrough'))

  const definitions = readdirSync(nodePath.join(pluginRoot, 'lib'))
    .filter(name => name.endsWith('.js'))
    .filter(name => /export function buildPassthrough|function expandPrefix/gu.test(
      readFileSync(nodePath.join(pluginRoot, 'lib', name), 'utf8'),
    ))
  check('prefix expansion is defined only in passthrough.js',
    definitions.length === 1 && definitions[0] === 'passthrough.js',
    JSON.stringify(definitions))
  check('passthrough.js does not call the patched path.isAbsolute',
    !pass.includes('nodePath.isAbsolute'))

  const limitIndex = index.indexOf('const HOST_REFERENCE_SCAN_LIMIT')
  const useIndex = index.indexOf('HOST_REFERENCE_SCAN_LIMIT)')
  check('the scan limit is defined before it is read',
    limitIndex >= 0 && useIndex > limitIndex,
    `defined=${limitIndex} used=${useIndex}`)
  check('index imports the @ extractor from the single passthrough module',
    /import \{[^}]*hostReferencePathsInText[^}]*\} from '\.\/passthrough\.js'/u.test(index))
  check('index listens for user messages to record @ references',
    index.includes("ctx.on('session/event'") && index.includes("event?.type !== 'user/message'"))
  check('index rescans a restored session once on creation',
    index.includes("ctx.on('session/created'"))
  check('the listener records what the message extractor returns',
    /for \(const spelling of hostReferencesInMessage\(event\.data, options\)\) passthrough\.addHostReference\(spelling\)/u.test(index))
  check('the listener drives the extractor with the matcher\'s own platform and scheme',
    /const options = \{ platform: passthrough\.platform, scheme: passthrough\.scheme \}/u.test(index))
  check('every recorded reference goes through the platform gate',
    index.includes('passthrough.addHostReference(') &&
      !index.includes('hostReferences.push('))
  check('the guidance states that passthrough stops at ctx.fs',
    /LOCAL_PASSTHROUGH_GUIDANCE[\s\S]*只覆盖经过 ctx\.fs/u.test(index) &&
      /LOCAL_PASSTHROUGH_GUIDANCE[\s\S]*EXECUTOR_UNAVAILABLE/u.test(index) &&
      /LOCAL_PASSTHROUGH_GUIDANCE[\s\S]*ssh_workspace_transfer/u.test(index))
  // The listener only ever sees user messages, but the extractor is where the
  // role and the block shape are decided; lift the real body and drive it.
  const extractorSource = index.slice(
    index.indexOf('function hostReferencesInMessage ('),
    index.indexOf('function recordSessionHostReferences ('),
  )
  const hostReferencesInMessage = new Function(
    'hostReferencePathsInText',
    `${extractorSource}; return hostReferencesInMessage`,
  )(hostReferencePathsInText)
  const userMessage = {
    role: 'user',
    content: [{ type: 'text', text: 'read @F:\\123.txt' }, { type: 'text', text: 'and @F:\\b.txt' }],
  }
  check('the message extractor reads every text block of a user message',
    JSON.stringify(hostReferencesInMessage(userMessage)) ===
      JSON.stringify(['F:\\123.txt', 'F:\\b.txt']),
    JSON.stringify(hostReferencesInMessage(userMessage)))
  check('a non-user message contributes no references',
    hostReferencesInMessage({ ...userMessage, role: 'assistant' }).length === 0 &&
      hostReferencesInMessage(undefined).length === 0 &&
      hostReferencesInMessage({ role: 'user', content: 'read @F:\\123.txt' }).length === 0)
  check('only text blocks are scanned',
    hostReferencesInMessage({
      role: 'user',
      content: [{ type: 'image', text: 'read @F:\\123.txt' }, { type: 'text', text: 'no mention here' }],
    }).length === 0)
  check('the guidance mentions @ host references only with passthrough on',
    /LOCAL_PASSTHROUGH_GUIDANCE[\s\S]*@[\s\S]*本机读取/u.test(index))
}

console.log('\n[8] the explicit host scheme')
{
  check('normalizeScheme lowercases and trims a usable name',
    normalizeScheme('  Local ') === 'local' && normalizeScheme('host') === 'host',
    String(normalizeScheme('  Local ')))
  check('normalizeScheme accepts letters, digits, "+", "-" and "."',
    normalizeScheme('dsh+local.1') === 'dsh+local.1' && normalizeScheme('a-b') === 'a-b')
  check('normalizeScheme refuses a name that is not a scheme',
    normalizeScheme('') === undefined &&
      normalizeScheme('1local') === undefined &&
      normalizeScheme('lo cal') === undefined &&
      normalizeScheme('local/x') === undefined &&
      normalizeScheme('loc@l') === undefined,
    JSON.stringify([normalizeScheme('1local'), normalizeScheme('lo cal')]))
  check('normalizeScheme refuses a non-string',
    normalizeScheme(42) === undefined && normalizeScheme(undefined) === undefined)
  check('normalizeScheme reserves ssh for remote spellings',
    normalizeScheme('ssh') === undefined && normalizeScheme('SSH') === undefined)
  check('the default scheme is local', DEFAULT_LOCAL_SCHEME === 'local')

  check('parseLocalScheme strips the bare form',
    parseLocalScheme('local:/Volumes/SSD/x.md') === '/Volumes/SSD/x.md')
  check('parseLocalScheme strips one to three slashes',
    parseLocalScheme('local://Volumes/SSD/x.md') === '/Volumes/SSD/x.md' &&
      parseLocalScheme('local:///Volumes/SSD/x.md') === '/Volumes/SSD/x.md')
  check('parseLocalScheme accepts a Windows path after the scheme',
    parseLocalScheme('local:F:\\123.txt') === 'F:\\123.txt' &&
      parseLocalScheme('local:/F:\\123.txt') === 'F:\\123.txt')
  check('parseLocalScheme accepts a UNC path after the scheme',
    parseLocalScheme('local:\\\\server\\share\\x.txt') === '\\\\server\\share\\x.txt')
  check('parseLocalScheme is case-insensitive in the scheme name',
    parseLocalScheme('LoCal:/Volumes/x') === '/Volumes/x')
  check('parseLocalScheme follows the configured name',
    parseLocalScheme('host:/Volumes/x', 'host') === '/Volumes/x' &&
      parseLocalScheme('local:/Volumes/x', 'host') === undefined)
  check('parseLocalScheme refuses a relative remainder',
    parseLocalScheme('local:tmp/x') === undefined && parseLocalScheme('local:') === undefined)
  check('parseLocalScheme refuses an ssh:// spelling',
    parseLocalScheme('ssh://host/x') === undefined)
  check('parseLocalScheme does not percent-decode',
    parseLocalScheme('local:/Volumes/a%20b.md') === '/Volumes/a%20b.md')

  // The scheme door: only a path the user granted opens it.
  const windows = buildPassthrough(['C:\\Users\\me\\.dsh\\attachments'], {
    env: { DSH_HOME: 'C:\\Users\\me\\.dsh' },
    home: 'C:\\Users\\me',
    platform: 'win32',
  })
  check('a scheme spelling of an unmentioned path is not a passthrough',
    windows.matches('local:F:\\123.txt') === false &&
      windows.localSpelling('local:F:\\123.txt') === undefined)
  check('but it is recognisable as a scheme spelling',
    windows.isSchemeSpelling('local:F:\\123.txt') === true &&
      windows.isSchemeSpelling('F:\\123.txt') === false)
  check('a scheme spelling does not make itself "named"',
    windows.isNamed('local:F:\\123.txt') === false)
  check('naming the path with the scheme authorizes exactly that path',
    windows.addHostReference('local:F:\\123.txt') === true &&
      windows.matches('local:F:\\123.txt') === true &&
      windows.localSpelling('local:F:\\123.txt') === 'F:\\123.txt')
  check('the bare spelling of that path stays remote',
    windows.matches('F:\\123.txt') === false,
    'a scheme mention must not widen the bare door')
  // A second scheme mention is still a scheme mention. Downgrading the entry on
  // a repeat would let the very same spelling drift into the bare door, so the
  // entry only ever opens when the user names it WITHOUT the scheme.
  windows.addHostReference('LOCAL:F:\\123.txt')
  check('repeating the scheme mention leaves the bare door closed',
    windows.matches('F:\\123.txt') === false,
    'a repeated scheme mention must not widen the bare door')
  windows.addHostReference('F:\\123.txt')
  check('a plain mention of the same path does open the bare door',
    windows.matches('F:\\123.txt') === true,
    'the bare mention is the only thing that opens the bare door')
  check('a sibling is not covered by a scheme mention',
    windows.matches('local:F:\\123.txt.bak') === false &&
      windows.matches('local:F:\\12\\x.txt') === false)
  check('the scheme is live and readable',
    windows.scheme === 'local' && windows.platform === 'win32')

  windows.configure({ scheme: 'host' })
  check('configure applies a new scheme name',
    windows.scheme === 'host' &&
      windows.matches('host:F:\\123.txt') === true &&
      windows.localSpelling('host:F:\\123.txt') === 'F:\\123.txt')
  check('the replaced scheme name stops working',
    windows.matches('local:F:\\123.txt') === false &&
      windows.isSchemeSpelling('local:F:\\123.txt') === false)
  const refusedWarnings = []
  const warned = buildPassthrough(['C:\\x'], {
    env: { DSH_HOME: 'C:\\Users\\me\\.dsh' },
    home: 'C:\\Users\\me',
    platform: 'win32',
    warn: message => refusedWarnings.push(message),
  })
  const fallback = warned.configure({ scheme: 'ssh' })
  check('configure refuses a reserved scheme and falls back to the default',
    fallback.scheme === DEFAULT_LOCAL_SCHEME && refusedWarnings.length === 1,
    JSON.stringify(fallback))
  check('configure leaves the fallback flag alone when only the scheme is set',
    warned.configure({ remoteMissFallback: true }).remoteMissFallback === true &&
      warned.configure({ scheme: 'host' }).remoteMissFallback === true)
}

console.log('\n[9] remote-miss fallback and the settings it obeys')
{
  // A host twin that only the fallback may reach: every base method records the
  // call, so "did the remote miss even try the host?" is observable.
  const makeHarness = (options = {}) => {
    const temp = mkdtempSync(nodePath.join(tmpdir(), 'dsh-ws-fallback-'))
    const hostFile = nodePath.join(temp, 'PARAMS.md')
    writeFileSync(hostFile, 'host copy\n', 'utf8')
    const calls = []
    const base = {
      async resolve (path, opts) {
        calls.push({ method: 'resolve', path, opts })
        return { targetKey: path, displayPath: path }
      },
      async stat (target) {
        calls.push({ method: 'stat', target })
        // The host answers for the spelling the fallback resolved, which is the
        // bare POSIX path the user named, not the temp file this harness made.
        // `hostAbsent` models the other half of the story: the user named a path
        // that exists on neither side, which is the only way to see the
        // "both worlds lack it" wording.
        if (options.hostAbsent === true) return undefined
        return { version: 'v1', type: 'file', size: 10 }
      },
      async lstat () { return { type: 'file', size: 10 } },
      async readText (target) {
        calls.push({ method: 'readText', target })
        return 'host copy\n'
      },
      async readBytes (target) {
        calls.push({ method: 'readBytes', target })
        return new Uint8Array([1, 2, 3])
      },
      async streamText () { return (async function * () { yield 'host copy\n' })() },
    }
    // The remote side is absent for EVERY path, which is the state the fallback
    // exists for.
    const engine = {
      async withSftp (_alias, operation) {
        return await operation({
          stat: (_path, callback) => callback(Object.assign(new Error('no such file'), { code: 2 })),
          lstat: (_path, callback) => callback(Object.assign(new Error('no such file'), { code: 2 })),
        })
      },
      // streamText takes a dedicated channel path, not withSftp: the generator
      // acquires a connection record and a stream channel before it stats.
      async acquire () {
        return { idleAt: 0, inFlight: 0, closePromise: undefined }
      },
      async streamChannel () {
        return {
          stat: (_path, callback) => callback(Object.assign(new Error('no such file'), { code: 2 })),
          lstat: (_path, callback) => callback(Object.assign(new Error('no such file'), { code: 2 })),
        }
      },
      async release () {},
      isDisabledTarget: () => false,
    }
    // A prefix has to exist for passthrough to be on at all: `enabled` gates the
    // @ table too, so an empty list means "the whole feature is off".
    const matcher = buildPassthrough(['/home/me/.dsh/attachments'], {
      env: { DSH_HOME: '/home/me/.dsh' },
      home: '/home/me',
      platform: options.platform ?? 'linux',
      scheme: options.scheme,
      remoteMissFallback: options.remoteMissFallback === true,
    })
    const router = new RemoteFileSystem({ engine, base, passthrough: matcher, logger: { debug: () => {} } })
    return { temp, hostFile, calls, matcher, router }
  }

  const target = spelling => ({ targetKey: spelling, displayPath: spelling })

  // ---- the three gates -----------------------------------------------------
  {
    const harness = makeHarness({ remoteMissFallback: false })
    try {
      // Not named at all: fallback off, and even with it on this path was never
      // pointed at, so the host must stay unprobed.
      const off = await harness.router.stat(target(`ssh://${ALIAS}/Volumes/SSD/PARAMS.md`), undefined)
      check('a remote miss with the flag off reports absent',
        off === undefined && harness.calls.length === 0,
        JSON.stringify(off))
      // Named but switched off isolates the flag: the spelling gate is open and
      // the answer must still be "absent", because the user never turned the
      // fallback on. Without this case a broken flag check hides behind the
      // un-named case above.
      harness.matcher.addHostReference('/Volumes/SSD/PARAMS.md')
      const stillOff = await harness.router.stat(target(`ssh://${ALIAS}/Volumes/SSD/PARAMS.md`), undefined)
      check('a named path still reports absent while the switch is off',
        stillOff === undefined && harness.calls.length === 0,
        `base calls=${JSON.stringify(harness.calls.map(call => call.method))}`)
    } finally {
      rmSync(harness.temp, { recursive: true, force: true })
    }
  }
  {
    const harness = makeHarness({ remoteMissFallback: true })
    try {
      const unnamed = await harness.router.stat(target(`ssh://${ALIAS}/Volumes/SSD/PARAMS.md`), undefined)
      check('a named-nowhere path is never probed on the host',
        unnamed === undefined && harness.calls.length === 0,
        `base calls=${harness.calls.length}`)
    } finally {
      rmSync(harness.temp, { recursive: true, force: true })
    }
  }

  // ---- a POSIX mention, named by the user ----------------------------------
  {
    const harness = makeHarness({ remoteMissFallback: true })
    try {
      // The user pointed at the path with @; the matcher keeps the bare POSIX
      // spelling named-but-remote, which is exactly the fallback's gate.
      harness.matcher.addHostReference('/Volumes/SSD/PARAMS.md')
      check('a bare @ POSIX mention is named without becoming local',
        harness.matcher.isNamed('/Volumes/SSD/PARAMS.md') === true &&
          harness.matcher.matches('/Volumes/SSD/PARAMS.md') === false)
      const info = await harness.router.stat(target(`ssh://${ALIAS}/Volumes/SSD/PARAMS.md`), undefined)
      check('the remote miss falls back to the host metadata',
        info !== undefined && info.type === 'file' && info.size === 10,
        JSON.stringify(info))
      check('the fallback probed the host, not the remote cache entry',
        harness.calls.some(call => call.method === 'stat'),
        JSON.stringify(harness.calls.map(call => call.method)))
      const text = await harness.router.readText(target(`ssh://${ALIAS}/Volumes/SSD/PARAMS.md`), undefined)
      check('the fallback text carries the host bytes',
        text.startsWith('host copy'), JSON.stringify(text.slice(0, 40)))
      check('the fallback text says where it came from',
        text.includes('[ssh-workspace]') && text.includes('/Volumes/SSD/PARAMS.md') &&
          text.includes('本机回退'),
        JSON.stringify(text))
      check('the fallback note names the scheme that pins the host read',
        text.includes('local:/Volumes/SSD/PARAMS.md'), JSON.stringify(text))
      const bytes = await harness.router.readBytes(target(`ssh://${ALIAS}/Volumes/SSD/PARAMS.md`), undefined, 1024)
      check('readBytes falls back without appending a note to binary payloads',
        bytes.length === 3 && bytes[0] === 1,
        JSON.stringify([...bytes]))
      let streamed = ''
      for await (const chunk of await harness.router.streamText(target(`ssh://${ALIAS}/Volumes/SSD/PARAMS.md`), undefined)) {
        streamed += chunk
      }
      check('streamText falls back and still closes with the note',
        streamed.startsWith('host copy') && streamed.includes('[ssh-workspace]') &&
          (streamed.match(/\[ssh-workspace\]/gu) ?? []).length === 1,
        JSON.stringify(streamed.slice(0, 60)))
    } finally {
      rmSync(harness.temp, { recursive: true, force: true })
    }
  }

  // ---- what never falls back -----------------------------------------------
  {
    const harness = makeHarness({ remoteMissFallback: true })
    try {
      harness.matcher.addHostReference('/Volumes/SSD/PARAMS.md')
      harness.calls.length = 0
      const resolved = await harness.router.resolve(`/Volumes/SSD/PARAMS.md`, { cwd: SSH_CWD })
      check('resolve keeps the remote meaning even for a named path',
        String(resolved.targetKey).startsWith(`ssh://${ALIAS}/Volumes/SSD/PARAMS.md`),
        resolved.targetKey)
      check('resolve never probes the host backend',
        harness.calls.length === 0,
        JSON.stringify(harness.calls.map(call => call.method)))
      let code
      try {
        await harness.router.listDir(target(`ssh://${ALIAS}/Volumes/SSD`), undefined)
      } catch (error) {
        code = error?.code
      }
      check('a directory listing never falls back', code === 'FS_NOT_FOUND', String(code))
      // A host copy of a remote path is not a write target: the fallback is a
      // READ rescue, and writing through it would silently create a file on
      // this machine that the remote never sees.
      harness.calls.length = 0
      let writeCode
      try {
        await harness.router.writeText(target(`ssh://${ALIAS}/Volumes/SSD/PARAMS.md`), 'x', undefined, undefined, { mode: 'danger-full-access' })
      } catch (error) {
        writeCode = error?.code
      }
      check('a write never falls back to the host copy',
        writeCode !== undefined && !harness.calls.some(call => call.method === 'writeText'),
        `${String(writeCode)} ${JSON.stringify(harness.calls.map(call => call.method))}`)
      // The sandbox mode is the fence the plugin does NOT own: a read-only
      // session must be refused before any mount check, and the refusal must
      // not consult the host backend either.
      harness.calls.length = 0
      let readOnlyCode
      try {
        await harness.router.writeText(target(`ssh://${ALIAS}/Volumes/SSD/PARAMS.md`), 'x', undefined, undefined, { mode: 'read-only' })
      } catch (error) {
        readOnlyCode = error?.code
      }
      check('a read-only session cannot write through a named path',
        readOnlyCode === 'FS_SANDBOX_DENIED',
        String(readOnlyCode))
    } finally {
      rmSync(harness.temp, { recursive: true, force: true })
    }
  }

  // ---- what a miss says when neither side has the file ---------------------
  {
    // The fallback ran and the host lacks it too. A bare "not found" here reads
    // as a typo and invites a retry that can never work, so the message has to
    // say both worlds were checked.
    const harness = makeHarness({ remoteMissFallback: true, hostAbsent: true })
    try {
      harness.matcher.addHostReference('/Volumes/SSD/PARAMS.md')
      const miss = await harness.router.readText(target(`ssh://${ALIAS}/Volumes/SSD/PARAMS.md`), undefined)
        .then(() => undefined, error => error)
      check('a miss on both sides keeps the FS_NOT_FOUND shape',
        miss?.code === 'FS_NOT_FOUND' && /^cannot read "/u.test(miss.message),
        `${String(miss?.code)} ${String(miss?.message)}`)
      check('a miss on both sides says the host copy was tried as well',
        miss.message.includes('missing as well') && miss.message.includes('/Volumes/SSD/PARAMS.md'),
        String(miss?.message))
      check('a miss on both sides still names the scheme that pins a host read',
        miss.message.includes('local:/Volumes/SSD/PARAMS.md'), String(miss?.message))
      check('the both-sides miss does not tell the caller to tick the box',
        !miss.message.includes('tick'), String(miss?.message))
    } finally {
      rmSync(harness.temp, { recursive: true, force: true })
    }
  }
  {
    // The fallback never ran because the user pointed at nothing. Issue #3: the
    // path was taken as remote, and the caller cannot tell that from the text
    // alone, so the message teaches both ways out.
    const harness = makeHarness({ remoteMissFallback: false })
    try {
      const miss = await harness.router.readText(target(`ssh://${ALIAS}/Volumes/SSD/PARAMS.md`), undefined)
        .then(() => undefined, error => error)
      check('an ineligible miss keeps the FS_NOT_FOUND shape',
        miss?.code === 'FS_NOT_FOUND' && /^cannot read "/u.test(miss.message),
        `${String(miss?.code)} ${String(miss?.message)}`)
      check('an ineligible miss says the spelling was read as a remote path',
        miss.message.includes('remote host only'), String(miss?.message))
      check('an ineligible miss names the scheme prefix as the way to this machine',
        miss.message.includes('local:<abs path>'), String(miss?.message))
      check('an ineligible miss points at the @ fallback on a POSIX host',
        miss.message.includes('name it with @'), String(miss?.message))
      check('the scheme in the miss text follows the configured name',
        await (async () => {
          const named = makeHarness({ remoteMissFallback: false, scheme: 'hostfile' })
          try {
            const other = await named.router.readText(target(`ssh://${ALIAS}/Volumes/SSD/PARAMS.md`), undefined)
              .then(() => undefined, error => error)
            return other.message.includes('hostfile:<abs path>') === true
          } finally {
            rmSync(named.temp, { recursive: true, force: true })
          }
        })() === true,
        'a renamed scheme must appear in the message')
    } finally {
      rmSync(harness.temp, { recursive: true, force: true })
    }
  }
  {
    // The same miss on a Windows host: the bare POSIX mention never entered the
    // reference table there (platform rules), so ticking the box cannot rescue
    // it. Advice that cannot work is worse than none.
    const harness = makeHarness({ remoteMissFallback: true, platform: 'win32' })
    try {
      harness.matcher.addHostReference('/Volumes/SSD/PARAMS.md')
      check('a bare POSIX mention is not named on a Windows host',
        harness.matcher.isNamed('/Volumes/SSD/PARAMS.md') === false)
      const miss = await harness.router.readText(target(`ssh://${ALIAS}/Volumes/SSD/PARAMS.md`), undefined)
        .then(() => undefined, error => error)
      check('a Windows-host miss omits the @ advice that cannot work',
        miss?.code === 'FS_NOT_FOUND' && !miss.message.includes('name it with @'),
        String(miss?.message))
      check('a Windows-host miss still offers the scheme prefix',
        miss.message.includes('local:<abs path>'), String(miss?.message))
    } finally {
      rmSync(harness.temp, { recursive: true, force: true })
    }
  }

  // ---- the scheme door stays separate from the bare door --------------------
  {
    const harness = makeHarness({ remoteMissFallback: false })
    try {
      check('an unauthorized scheme spelling is a loud refusal',
        await harness.router.resolve('local:/Volumes/SSD/PARAMS.md', { cwd: SSH_CWD })
          .then(() => 'resolved', error => error?.code) === 'FS_PERMISSION_DENIED')
      check('an unauthorized scheme spelling refuses without touching either backend',
        harness.calls.length === 0 && harness.matcher.matches('local:/Volumes/SSD/PARAMS.md') === false)
      harness.matcher.addHostReference('local:/Volumes/SSD/PARAMS.md')
      const local = await harness.router.resolve('local:/Volumes/SSD/PARAMS.md', { cwd: SSH_CWD })
      check('a scheme spelling the user named goes to the host, stripped of its prefix',
        local.targetKey === '/Volumes/SSD/PARAMS.md' &&
          harness.calls.some(call => call.method === 'resolve' && call.path === '/Volumes/SSD/PARAMS.md'),
        JSON.stringify([local.targetKey, harness.calls.map(call => call.path)]))
      check('the scheme mention does not widen the bare spelling',
        harness.matcher.matches('/Volumes/SSD/PARAMS.md') === false &&
          harness.matcher.isNamed('/Volumes/SSD/PARAMS.md') === true,
        'bare stays remote while staying named')
    } finally {
      rmSync(harness.temp, { recursive: true, force: true })
    }
  }

  // ---- the two miss wordings -----------------------------------------------
  // A miss can mean two very different things, and the way out differs, so the
  // message has to say which one happened. Both branches keep the exact
  // `cannot read "...": not found` prefix, because every consumer and the host's
  // own tooling branch on that shape.
  {
    const harness = makeHarness({ remoteMissFallback: true, hostAbsent: true })
    try {
      harness.matcher.addHostReference('/Volumes/SSD/PARAMS.md')
      const error = await harness.router
        .readText(target(`ssh://${ALIAS}/Volumes/SSD/PARAMS.md`), undefined)
        .then(() => undefined, caught => caught)
      check('a miss on both sides keeps the not-found shape',
        error?.code === 'FS_NOT_FOUND' &&
          error.message.startsWith('cannot read "ssh://'),
        `${error?.code} ${error?.message}`)
      check('a miss on both sides says the host copy was tried',
        /host copy/u.test(error.message) && /missing as well/u.test(error.message),
        error.message)
      check('a miss on both sides points at the scheme that pins a host read',
        error.message.includes('local:/Volumes/SSD/PARAMS.md'),
        error.message)
      check('a miss on both sides does not pretend the checkbox would help',
        !/tick "read the host copy/u.test(error.message),
        error.message)
    } finally {
      rmSync(harness.temp, { recursive: true, force: true })
    }
  }
  {
    // The flag is off but the path WAS named: the fallback never ran, so the
    // message must explain that the spelling means remote and how to say
    // "this machine" instead — without claiming a host read was attempted.
    const harness = makeHarness({ remoteMissFallback: false })
    try {
      harness.matcher.addHostReference('/Volumes/SSD/PARAMS.md')
      const error = await harness.router
        .readText(target(`ssh://${ALIAS}/Volumes/SSD/PARAMS.md`), undefined)
        .then(() => undefined, caught => caught)
      check('a miss with the fallback off keeps the not-found shape',
        error?.code === 'FS_NOT_FOUND' &&
          error.message.startsWith('cannot read "ssh://'),
        `${error?.code} ${error?.message}`)
      check('a miss with the fallback off says the path meant the remote',
        /remote host only/u.test(error.message), error.message)
      check('a miss with the fallback off names the scheme and the checkbox',
        error.message.includes('local:<abs path>') &&
          /tick "read the host copy when the remote misses"/u.test(error.message),
        error.message)
      check('a miss with the fallback off claims no host read',
        !/missing as well/u.test(error.message), error.message)
    } finally {
      rmSync(harness.temp, { recursive: true, force: true })
    }
  }
  {
    // Windows hosts do not record bare POSIX mentions at all, so offering the
    // checkbox there would send the caller chasing a switch that cannot help.
    const harness = makeHarness({ remoteMissFallback: false, platform: 'win32' })
    try {
      const error = await harness.router
        .readText(target(`ssh://${ALIAS}/home/me/x.md`), undefined)
        .then(() => undefined, caught => caught)
      check('a Windows host offers the scheme but not the useless checkbox',
        error?.code === 'FS_NOT_FOUND' &&
          error.message.includes('local:<abs path>') &&
          !/tick "read the host copy/u.test(error.message),
        error?.message)
    } finally {
      rmSync(harness.temp, { recursive: true, force: true })
    }
  }
}

console.log('\n[10] the settings store and its controller')
{
  const temp = mkdtempSync(nodePath.join(tmpdir(), 'dsh-ws-settings-'))
  const storeFile = nodePath.join(temp, 'dsh-ssh.json')
  try {
    check('an unwritten document has no passthrough section',
      JSON.stringify(passthroughOf({})) === JSON.stringify({ scheme: undefined, remoteMissFallback: undefined }))
    check('a damaged section degrades to no settings',
      JSON.stringify(passthroughOf({ passthrough: 'nope' })) ===
        JSON.stringify({ scheme: undefined, remoteMissFallback: undefined }) &&
        passthroughOf({ passthrough: [1, 2] }).scheme === undefined)
    check('only the right value types survive a read',
      passthroughOf({ passthrough: { scheme: '  Host  ', remoteMissFallback: 'yes' } }).scheme === 'Host' &&
        passthroughOf({ passthrough: { scheme: '  Host  ', remoteMissFallback: 'yes' } }).remoteMissFallback === undefined &&
        passthroughOf({ passthrough: { scheme: 42, remoteMissFallback: 1 } }).scheme === undefined &&
        passthroughOf({ passthrough: { scheme: {}, remoteMissFallback: [] } }).scheme === undefined)

    // The store is the runtime truth, so it must round-trip through a real file
    // rather than a stubbed document.
    const store = new HostConfigStore(storeFile)
    check('a store that was never written reports no settings',
      store.passthroughSettings().scheme === undefined)
    const saved = store.setPassthroughSettings({ scheme: 'host', remoteMissFallback: true })
    check('setPassthroughSettings returns what it stored',
      saved.scheme === 'host' && saved.remoteMissFallback === true, JSON.stringify(saved))
    check('the settings survive a fresh read of the file',
      new HostConfigStore(storeFile).passthroughSettings().scheme === 'host' &&
        new HostConfigStore(storeFile).passthroughSettings().remoteMissFallback === true)
    const mtimeBefore = statSync(storeFile).mtimeMs
    store.setPassthroughSettings({ scheme: 'host' })
    check('saving the same value does not rewrite the file',
      statSync(storeFile).mtimeMs === mtimeBefore)
    const partial = store.setPassthroughSettings({ remoteMissFallback: false })
    check('a partial patch leaves the other setting alone',
      partial.scheme === 'host' && partial.remoteMissFallback === false, JSON.stringify(partial))
    store.setPassthroughSettings({ scheme: '' })
    check('an empty scheme clears the stored value instead of storing one',
      store.passthroughSettings().scheme === undefined)

    // ---- the controller ----------------------------------------------------
    const warnings = []
    const matcher = buildPassthrough([], {
      env: { DSH_HOME: '/home/me/.dsh' },
      home: '/home/me',
      platform: 'linux',
      warn: message => warnings.push(message),
    })
    const controller = new PassthroughSettings({
      store: new HostConfigStore(storeFile),
      matcher,
      defaults: { scheme: 'local', remoteMissFallback: false },
      logger: { debug: () => {} },
    })
    check('the controller reports the plugin default before anything is saved',
      controller.settings().scheme === 'local' && controller.settings().remoteMissFallback === false,
      JSON.stringify(controller.settings()))
    const applied = controller.apply({ scheme: 'host', remoteMissFallback: true })
    check('apply validates, persists and applies in one step',
      applied.scheme === 'host' && applied.remoteMissFallback === true &&
        matcher.scheme === 'host' && matcher.remoteMissFallback === true,
      JSON.stringify(applied))
    check('the applied settings are readable from the store afterwards',
      new HostConfigStore(storeFile).passthroughSettings().scheme === 'host')
    let refused
    try {
      controller.apply({ scheme: 'ssh' })
    } catch (error) {
      refused = error
    }
    check('a reserved scheme is refused with the code the route maps',
      refused?.code === 'STORE_INVALID' && /reserved|not a usable/u.test(String(refused?.message)),
      String(refused?.message))
    check('a refused scheme changes neither the matcher nor the store',
      matcher.scheme === 'host' &&
        new HostConfigStore(storeFile).passthroughSettings().scheme === 'host')
    check('a hot reload re-reads the stored settings',
      controller.activate().scheme === 'host' && matcher.scheme === 'host')

    // A scheme stored by an older build (or edited by hand) may be unusable.
    // Reading it must never hand the seams a name nothing understands: the
    // reported value stays the last usable one, and reading does not rewrite
    // the file behind the user's back.
    writeFileSync(storeFile, JSON.stringify({ version: 1, passthrough: { scheme: 'Not A Scheme' } }), 'utf8')
    check('an unusable stored scheme is never reported as the effective one',
      controller.settings().scheme !== 'Not A Scheme' &&
        normalizeScheme(controller.settings().scheme) === controller.settings().scheme &&
        controller.activate().scheme === controller.settings().scheme,
      JSON.stringify(controller.settings()))
    check('an unusable stored scheme is not silently rewritten by reading it',
      JSON.parse(readFileSync(storeFile, 'utf8')).passthrough.scheme === 'Not A Scheme')
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

console.log('\n[11] the scheme rules')
{
  // ---- the minimum length -------------------------------------------------
  // Three characters is structural, not cosmetic: a one-character name is
  // exactly what a Windows drive letter looks like.
  check('a one-character name is refused', normalizeScheme('c') === undefined && normalizeScheme('C') === undefined)
  check('a two-character name is refused', normalizeScheme('ab') === undefined)
  check('three characters are enough', normalizeScheme('abc') === 'abc')
  check('the refusal names the rule, not the name',
    schemeRefusal('ab').code === 'too-short' && schemeRefusal('ab').message.includes(String(MIN_SCHEME_LENGTH)),
    JSON.stringify(schemeRefusal('ab')))
  check('the rule and the published constant are the same thing',
    MIN_SCHEME_LENGTH === 3 && schemeRules().minLength === MIN_SCHEME_LENGTH)

  // The reason the minimum exists, asserted rather than commented: with a
  // three-character scheme, `c:/x` can never be stripped — it stays a Windows
  // absolute path, so the two meanings cannot compete for the same text.
  check('a drive letter can no longer be a prefix, so c:/x keeps its Windows meaning',
    parseLocalScheme('c:/x', 'abc') === undefined && looksLocalAbsolute('c:/x') === true)

  // ---- the reserved table, driven -----------------------------------------
  // Table-driven on purpose: a new row in SCHEMES_IN_USE is covered without
  // touching this file, and an accidentally-empty table cannot pass the loop
  // vacuously because the size and the two load-bearing names are pinned.
  check('the reserved table is non-empty and keeps the names this build emits',
    SCHEMES_IN_USE.length >= 13 &&
      SCHEMES_IN_USE.some(entry => entry.name === 'ssh') &&
      SCHEMES_IN_USE.some(entry => entry.name === 'file') &&
      SCHEMES_IN_USE.some(entry => entry.name === 'sftp') &&
      SCHEMES_IN_USE.every(entry => typeof entry.reason === 'string' && entry.reason !== ''),
    `entries=${SCHEMES_IN_USE.length}`)
  for (const entry of SCHEMES_IN_USE) {
    const refusal = schemeRefusal(entry.name)
    // A reserved name SHORTER than the minimum is refused one rule earlier: `ws`
    // is two characters, so it could never be typed as a prefix even if the
    // table were empty. It stays in the table because the list is documentation
    // as well as enforcement, and the branch is pinned so an entry cannot move
    // between "too short" and "reserved" unnoticed.
    if (entry.name.length < MIN_SCHEME_LENGTH) {
      check(`"${entry.name}" is refused by the length rule before the table is consulted`,
        normalizeScheme(entry.name) === undefined && refusal.code === 'too-short',
        JSON.stringify(refusal))
      check(`"${entry.name.toUpperCase()}" is refused for the same structural reason`,
        normalizeScheme(entry.name.toUpperCase()) === undefined)
      continue
    }
    check(`"${entry.name}" is refused, and the refusal quotes the reason`,
      normalizeScheme(entry.name) === undefined &&
        refusal.code === 'reserved' && refusal.name === entry.name && refusal.message.includes(entry.reason),
      JSON.stringify(refusal))
    // The reserved test runs AFTER `trim().toLowerCase()`, which is why these two
    // spellings must hit the same row. Moving the fold after the table lookup
    // would let `FILE` through — this is the assertion that pins that order.
    check(`"${entry.name.toUpperCase()}" is refused by the same row`,
      normalizeScheme(entry.name.toUpperCase()) === undefined &&
        schemeRefusal(` ${entry.name} `).code === 'reserved')
  }
  check('every reserved name long enough to reach the table reports itself as reserved',
    SCHEMES_IN_USE.filter(entry => entry.name.length >= MIN_SCHEME_LENGTH)
      .every(entry => schemeRefusal(entry.name).code === 'reserved'))
  // `file` is the one entry whose reason is about THIS plugin rather than the
  // wider web: `formatRemoteFileUrl` (lib/protocol.js) writes `file:///srv/x`
  // for a REMOTE path, so a `file:` local prefix would exchange one spelling
  // between two machines. Do not remove this entry without removing that writer.
  check('file is refused because this plugin itself writes file:/// for remote paths',
    normalizeScheme('file') === undefined && normalizeScheme('FILE') === undefined,
    'the file: entry is gone — protocol.js still emits remote file:/// URIs')

  // ---- the case matrix ----------------------------------------------------
  check('the scheme NAME is folded, as the panel promises',
    normalizeScheme('Local') === 'local' && normalizeScheme(' LOCAL ') === 'local' &&
      parseLocalScheme('LOCAL:/x', 'local') === '/x' && parseLocalScheme('LoCal:/x', 'local') === '/x')
  // ...while the PATH behind it follows the platform. Same fixture, two
  // platforms, opposite answers.
  const winRefs = buildPassthrough(undefined, {
    env: { DSH_HOME: FAKE_HOME }, home: FAKE_USER_HOME, platform: 'win32',
  })
  const macRefs = buildPassthrough(undefined, {
    env: { DSH_HOME: FAKE_HOME }, home: FAKE_USER_HOME, platform: 'darwin',
  })
  check('a win32 path is folded, so f:\\x and F:\\x are one reference',
    winRefs.addHostReference('F:\\123.txt') === true && winRefs.isNamed('f:\\123.txt') === true)
  check('a darwin path is not folded, and the pair disagrees on purpose',
    macRefs.addHostReference('/Volumes/SSD/x.md') === true &&
      macRefs.isNamed('/Volumes/SSD/x.md') === true &&
      macRefs.isNamed('/volumes/ssd/x.md') === false)
  check('the two platforms really disagree on the same fixture',
    winRefs.addHostReference('C:\\Volumes\\SSD\\x.md') === true &&
      winRefs.isNamed('c:\\volumes\\ssd\\X.md') === true &&
      macRefs.isNamed('C:\\Volumes\\SSD\\x.md') === false)

  // ---- the controller refuses with the same words --------------------------
  const temp = mkdtempSync(nodePath.join(tmpdir(), 'dsh-ws-scheme-'))
  const storeFile = nodePath.join(temp, 'dsh-ssh.json')
  try {
    const matcher = buildPassthrough(undefined, { env: { DSH_HOME: FAKE_HOME }, home: FAKE_USER_HOME, platform: 'linux' })
    const controller = new PassthroughSettings({
      store: new HostConfigStore(storeFile),
      matcher,
      defaults: { scheme: 'local', remoteMissFallback: false },
      logger: { debug: () => {}, warn: () => {} },
    })
    check('nothing is stored, so there is nothing to warn about', controller.warning() === null)
    check('a reserved name is refused with the name AND the reason in the message',
      (() => {
        try {
          controller.apply({ scheme: 'file' })
          return false
        } catch (error) {
          return error.code === 'STORE_INVALID' &&
            String(error.message).includes('file') &&
            String(error.message).includes(SCHEMES_IN_USE.find(entry => entry.name === 'file').reason)
        }
      })(), 'the refusal does not explain why file is taken')
    check('a short name is refused with the number the user can act on',
      (() => {
        try {
          controller.apply({ scheme: 'ab' })
          return false
        } catch (error) {
          return error.code === 'STORE_INVALID' && String(error.message).includes('3')
        }
      })(), 'the refusal does not state the minimum length')
    check('two refusals change neither the matcher nor the store',
      controller.settings().scheme === 'local' &&
        new HostConfigStore(storeFile).passthroughSettings().scheme === undefined &&
        matcher.scheme === 'local')

    // ---- a value saved by an older build is degraded, visibly ---------------
    // `file` was legal before this build, so a store may already carry it. It
    // must not be obeyed (the seams would hold a name nothing parses), must not
    // be rewritten (the store is the user's file), and must not be silent.
    writeFileSync(storeFile, JSON.stringify({ version: 1, passthrough: { scheme: 'file' } }), 'utf8')
    const degraded = controller.settings()
    check('an unusable stored value degrades to a usable one',
      degraded.scheme === 'local' && matcher.scheme === 'local', JSON.stringify(degraded))
    const warning = controller.warning()
    check('...and the warning names the stored value, the effective one and the rule',
      warning !== null && warning.stored === 'file' && warning.effective === 'local' &&
        warning.code === 'reserved' && String(warning.message).includes('file'),
      JSON.stringify(warning))
    check('...and reading it does not rewrite the store',
      JSON.parse(readFileSync(storeFile, 'utf8')).passthrough.scheme === 'file')
    check('activating a degraded value warns on the logger instead of silently degrading',
      (() => {
        const logs = []
        const noisy = new PassthroughSettings({
          store: new HostConfigStore(storeFile),
          matcher: buildPassthrough(undefined, { env: { DSH_HOME: FAKE_HOME }, home: FAKE_USER_HOME, platform: 'linux' }),
          defaults: { scheme: 'local', remoteMissFallback: false },
          logger: { debug: () => {}, warn: message => logs.push(String(message)) },
        })
        noisy.activate()
        return logs.length === 1 && logs[0].includes('file') && logs[0].includes('local')
      })(), 'activate() did not warn about the degraded stored scheme')

    // The configured default is held to the same rule as the saved value: a
    // profile row naming `file` must not be obeyed either — and it must say so.
    const configuredWarnings = []
    const configured = buildPassthrough([], {
      env: { DSH_HOME: FAKE_HOME }, home: FAKE_USER_HOME, platform: 'linux',
      scheme: 'file', warn: message => configuredWarnings.push(String(message)),
    })
    check('an unusable configured default falls back to local and warns once',
      configured.scheme === 'local' && configuredWarnings.length === 1 &&
        configuredWarnings[0].includes('file'),
      JSON.stringify(configuredWarnings))
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }

  // ---- the published rules ------------------------------------------------
  const rules = schemeRules()
  check('the published rules carry the length, the syntax and the whole table',
    rules.minLength === MIN_SCHEME_LENGTH &&
      typeof rules.pattern === 'string' && rules.pattern.length > 0 &&
      rules.reserved.length === SCHEMES_IN_USE.length &&
      rules.reserved === SCHEMES_IN_USE,
    JSON.stringify({ ...rules, reserved: rules.reserved.length }))
  check('the published case flags follow the platform, not the process',
    rules.caseInsensitiveName === true &&
      schemeRules('win32').caseInsensitivePath === true &&
      schemeRules('darwin').caseInsensitivePath === false &&
      schemeRules('linux').caseInsensitivePath === false &&
      rules.caseInsensitivePath === (process.platform === 'win32'))
  check('the published syntax is the one the server enforces',
    new RegExp(schemeRules().pattern, 'u').test(normalizeScheme('local')) === true &&
      new RegExp(schemeRules().pattern, 'u').test('Local') === false,
    'the published pattern and normalizeScheme disagree')

  // ---- the status route publishes them (source, so it runs everywhere) -----
  // routes.js cannot be imported without the assembled tree; a skip there is
  // where "the panel stopped receiving its rules" would ship unnoticed.
  const routesSource = readFileSync(nodePath.join(pluginRoot, 'lib', 'routes.js'), 'utf8')
  check('the status route builds the rules from the module that enforces them',
    /schemeRules: schemeRules\(\)/u.test(routesSource),
    'the route no longer publishes schemeRules from passthrough.js')
  check('...and it publishes the degraded-value warning beside them',
    /schemeWarning: passthroughSettings\.warning\?\.\(\) \?\? null/u.test(routesSource),
    'the route no longer ships schemeWarning')
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
process.exit(failures === 0 ? 0 : 1)
