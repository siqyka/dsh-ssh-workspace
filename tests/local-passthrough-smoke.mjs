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

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
  buildPassthrough, DEFAULT_PASSTHROUGH, hostReferencePathsInText,
  isWindowsHostPath, looksLocalAbsolute, normalizeLocalSpelling,
} = await import(pathToFileURL(nodePath.join(pluginRoot, 'lib/passthrough.js')).href)
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

  if (process.platform === 'win32') {
    check('Windows matching is case-insensitive',
      matcher.matches(`${FAKE_HOME.toUpperCase()}\\ATTACHMENTS\\v1\\files\\x.txt`) === true)
  } else {
    check('POSIX case-insensitivity is not applicable on this platform', true)
  }
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
    /for \(const spelling of hostReferencesInMessage\(event\.data\)\)\s*\n?\s*passthrough\.addHostReference\(spelling\)/u.test(index))
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

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
process.exit(failures === 0 ? 0 : 1)
