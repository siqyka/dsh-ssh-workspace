/**
 * Reverse verification for local-path passthrough.
 *
 * Run: node scripts/reverse-verify-passthrough.mjs
 *
 * The suite this exercises is half behaviour (a real matcher, a real router) and
 * half source contract (the call sites must keep the passthrough check BEFORE
 * the remote classification). Both halves are mutated here: a mutation that only
 * breaks parsing proves nothing, so every entry must produce at least one real
 * FAIL line.
 *
 * Each mutation rewrites one file, runs the suite, and restores the original
 * bytes in a `finally` — this is a review action and never runs in CI.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stubs = path.join(root, 'tests', '.peer-stubs', 'node_modules')

const MUTATIONS = [
  {
    name: 'the default prefix list drops the attachments directory',
    file: 'lib/passthrough.js',
    find: "export const DEFAULT_PASSTHROUGH = ['$DSH_HOME/attachments', '$DSH_HOME/plugins']",
    replace: "export const DEFAULT_PASSTHROUGH = ['$DSH_HOME/plugins']",
  },
  {
    name: 'an unsupported environment variable is expanded instead of refused',
    file: 'lib/passthrough.js',
    find: '  if (UNKNOWN_VAR_RE.test(value)) {',
    replace: '  if (false) {',
  },
  {
    name: 'a prefix match ignores the path-component boundary',
    file: 'lib/passthrough.js',
    find: '  return isPathSeparator(left.charAt(right.length), platform)',
    replace: '  return true',
  },
  {
    name: 'the whole DSH home is accepted when named with @',
    file: 'lib/passthrough.js',
    find: '      if (isWithinPrefix(normalized, normalizedDshHome, platform)) return false',
    replace: '      if (false) return false',
  },
  {
    name: 'a host reference is accepted on every platform',
    file: 'lib/passthrough.js',
    find: "      if (!enabled || platform !== 'win32') return false",
    replace: '      if (!enabled) return false',
  },
  {
    name: 'a non-drive spelling is recorded as a host reference',
    file: 'lib/passthrough.js',
    find: '      if (!isWindowsHostPath(spelling)) return false',
    replace: '      if (spelling === undefined) return false',
  },
  {
    name: 'the reference list is unbounded',
    file: 'lib/passthrough.js',
    find: '      if (hostReferences.length >= HOST_REFERENCE_CAP) {',
    replace: '      if (false) {',
  },
  {
    name: 'a recorded reference stops matching its own path',
    file: 'lib/passthrough.js',
    find: '      return hostReferences.some(reference => isWithinPrefix(candidate, reference, platform))',
    replace: '      return false',
  },
  {
    name: 'quoted @ mentions are not extracted',
    file: 'lib/passthrough.js',
    find: "  for (const match of text.matchAll(AT_QUOTED_RE)) remember((match[1] ?? '').slice(1, -1))",
    replace: "  for (const match of []) remember((match[1] ?? '').slice(1, -1))",
  },
  {
    name: 'the @ extractor accepts a POSIX absolute spelling',
    file: 'lib/passthrough.js',
    find: '    if (!isWindowsHostPath(spelling)) return',
    replace: '    if (spelling === undefined) return',
  },
  {
    name: 'the router hands the remote cwd back to the local backend',
    file: 'lib/remote-fs.js',
    find: '      const localOpts = opts === undefined ? undefined : { ...opts, cwd: undefined }',
    replace: '      const localOpts = opts',
  },
  {
    name: 'the router stops recognising passthrough spellings',
    file: 'lib/remote-fs.js',
    find: "    return typeof spelling === 'string' && !isRemotePath(spelling) && this.passthrough?.matches?.(spelling) === true",
    replace: '    return false',
  },
  {
    name: 'path.resolve stops honouring the passthrough matcher',
    file: 'lib/fs-shim.js',
    find: '    if (state.passthrough?.matches?.(arg) === true) {',
    replace: '    if (false) {',
  },
  {
    name: 'path.relative stops returning a host target unchanged',
    file: 'lib/fs-shim.js',
    find: '  if (state.passthrough?.matches?.(to) === true) return to',
    replace: '  if (false) return to',
  },
  {
    name: 'a hot reload keeps the stale matcher',
    file: 'lib/fs-shim.js',
    find: '    existing.passthrough = passthrough',
    replace: '    existing.passthrough = existing.passthrough',
  },
  {
    name: 'the first install site forgets to pass the matcher',
    file: 'lib/index.js',
    find: 'installRemoteFileSystem(scoped, { engine, passthrough }, RemoteFileSystem)',
    replace: 'installRemoteFileSystem(scoped, { engine }, RemoteFileSystem)',
  },
  {
    name: 'the built-in bridge is installed without the matcher',
    file: 'lib/index.js',
    find: 'installBuiltinBridge({ engine, router, logger: scoped.logger, passthrough })',
    replace: 'installBuiltinBridge({ engine, router, logger: scoped.logger })',
  },
  {
    name: 'the listener feeds the raw event instead of the message',
    file: 'lib/index.js',
    find: 'hostReferencesInMessage(event.data)',
    replace: 'hostReferencesInMessage(event)',
  },
  {
    name: 'a restored session is never rescanned',
    file: 'lib/index.js',
    find: "    ctx.on('session/created', session => { noteSession(session) }, { global: true })",
    replace: '    void noteSession',
  },
  {
    name: 'the guidance loses the passthrough boundary paragraph',
    file: 'lib/index.js',
    find: "  '**直通的边界（重要）**：只覆盖经过 ctx.fs 的文件系统调用（宿主 write / edit / read_image、node:fs，',",
    replace: "  '',",
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
    result = spawnSync(process.execPath, [path.join(root, 'tests', 'local-passthrough-smoke.mjs')], {
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
console.log(`=== ${MUTATIONS.length} confirmed, 0 not ===`)
