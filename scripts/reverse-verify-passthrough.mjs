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

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Where an interrupted run leaves the file it was mutating.
 *
 * The originals live only in memory, so a run killed between the write and its
 * `finally` (a piped stdout that dies, Ctrl-C, a crash) used to destroy them:
 * the mutated source stayed on disk and the next run — which reads the file
 * fresh — would take the mutation as the original and keep mutating it. The
 * backup makes the interruption recoverable.
 */
const BACKUP_SUFFIX = '.reverse-backup'

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
    find: '    if (isWithinPrefix(normalized, normalizedDshHome, platform)) return undefined',
    replace: '    if (false) return undefined',
  },
  {
    name: 'a host reference is accepted on every platform',
    file: 'lib/passthrough.js',
    find: "      const accepted = platform === 'win32' ? isWindowsHostPath(spelling) : isPosixHostPath(spelling)",
    replace: '      const accepted = true',
  },
  {
    name: 'a non-drive spelling is recorded as a host reference',
    file: 'lib/passthrough.js',
    find: "      const accepted = platform === 'win32' ? isWindowsHostPath(spelling) : isPosixHostPath(spelling)",
    replace: '      const accepted = typeof spelling === \'string\'',
  },
  {
    name: 'the reference list is unbounded',
    file: 'lib/passthrough.js',
    find: '    if (references.length >= HOST_REFERENCE_CAP) {',
    replace: '    if (false) {',
  },
  {
    name: 'a recorded reference stops matching its own path',
    file: 'lib/passthrough.js',
    find: '    references.some(entry => entry.viaScheme !== true && isWithinPrefix(candidate, entry.spelling, platform))',
    replace: '    false',
  },
  {
    name: 'quoted @ mentions are not extracted',
    file: 'lib/passthrough.js',
    find: "  for (const match of text.matchAll(AT_QUOTED_RE)) remember((match[1] ?? '').slice(1, -1))",
    replace: "  for (const match of []) remember((match[1] ?? '').slice(1, -1))",
  },
  {
    name: 'the @ extractor accepts a POSIX or scheme spelling',
    file: 'lib/passthrough.js',
    find: "  const accepts = platform === 'win32' ? isWindowsHostPath : isPosixHostPath",
    replace: '  const accepts = () => true',
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
    find: 'hostReferencesInMessage(event.data, options)',
    replace: 'hostReferencesInMessage(event, options)',
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
  {
    name: 'the scheme name is accepted whatever the user typed',
    file: 'lib/passthrough.js',
    // Re-anchored onto `schemeRefusal`, which now owns the test: `normalizeScheme`
    // is a thin wrapper and no longer contains the condition itself.
    find: '  if (!SCHEME_NAME_RE.test(candidate)) {',
    replace: '  if (false) {',
  },
  {
    name: 'the reserved ssh scheme becomes configurable',
    file: 'lib/passthrough.js',
    // Re-anchored for the same reason: the branch moved into `schemeRefusal`.
    find: '  if (RESERVED_SCHEMES.has(candidate)) {',
    replace: '  if (false) {',
  },
  {
    name: 'a scheme mention leaks onto the bare spelling',
    file: 'lib/passthrough.js',
    find: '      if (existing.viaScheme && !viaScheme) existing.viaScheme = false',
    replace: '      existing.viaScheme = false',
  },
  {
    name: 'the scheme spelling is handed to the host backend unstripped',
    file: 'lib/remote-fs.js',
    find: '      const local = this.#localSpelling(path)',
    replace: '        const local = path',
  },
  {
    name: 'an unauthorized scheme quietly becomes a remote path',
    file: 'lib/remote-fs.js',
    find: '    const unauthorized = this.#unauthorizedScheme(path, \'resolve\')',
    replace: '    const unauthorized = undefined',
  },
  {
    name: 'the fallback ignores the switch the user set',
    file: 'lib/remote-fs.js',
    find: "    if (this.passthrough?.remoteMissFallback !== true) return undefined",
    replace: '    if (false) return undefined',
  },
  {
    name: 'the fallback probes the host for a path nobody named',
    file: 'lib/remote-fs.js',
    find: "    return this.passthrough?.isNamed?.(remotePath) === true ? remotePath : undefined",
    replace: '    return remotePath',
  },
  {
    name: 'the fallback note no longer names the true source',
    file: 'lib/remote-fs.js',
    find: '    return `${text}${separator}[ssh-workspace] 注意：远端不存在 "${spelling}"，本次内容来自本机回退。` +',
    replace: '    return `${text}${separator}[ssh-workspace] 注意：远端不存在 "${spelling}"。` +',
  },
  {
    name: 'the read path skips the remote-miss fallback entirely',
    file: 'lib/remote-fs.js',
    find: '      const text = await this.#hostText(parts, signal)',
    replace: '      const text = undefined',
  },
  {
    name: 'the streamed read skips the remote-miss fallback entirely',
    file: 'lib/remote-fs.js',
    find: '      const twin = await router.#hostTwin(parts, signal)',
    replace: '      const twin = undefined',
  },
  {
    name: 'the metadata read skips the remote-miss fallback entirely',
    file: 'lib/remote-fs.js',
    find: '    const twin = await this.#hostTwin(parts, signal)',
    replace: '    const twin = undefined',
  },
  {
    name: 'a miss on both sides stops saying the host copy was tried',
    file: 'lib/remote-fs.js',
    find: '        `cannot read "${display}": not found — the host copy "${spelling}" is missing as well, ` +',
    replace: '        `cannot read "${display}": not found ` +',
  },
  {
    name: 'an ineligible miss stops saying the path meant the remote',
    file: 'lib/remote-fs.js',
    find: '        `cannot read "${display}": not found — this path was read on the remote host only. ` +',
    replace: '        `cannot read "${display}": not found ` +',
  },
  {
    name: 'a Windows host offers the @ advice that cannot work there',
    file: 'lib/remote-fs.js',
    find: "    if (this.passthrough?.platform === 'win32') return ''",
    replace: '    if (false) return \'\'',
  },
  {
    name: 'a write escapes the sandbox fence',
    file: 'lib/remote-fs.js',
    find: '    const modeRefusal = writeModeRefusal(mode, parts.displayPath)',
    replace: '    const modeRefusal = undefined',
  },
  {
    name: 'the resolved settings skip validation before they reach the store',
    file: 'lib/passthrough-settings.js',
    // Re-anchored: the controller now asks `schemeRefusal` for a verdict instead
    // of calling `normalizeScheme` inline.
    find: '      const refusal = schemeRefusal(patch.scheme)',
    replace: '      const refusal = { ok: true, scheme: String(patch.scheme) }',
  },
  {
    name: 'the store accepts a value it cannot read back',
    file: 'lib/store.js',
    find: "  const scheme = typeof section.scheme === 'string' && section.scheme.trim() !== ''",
    replace: '    const scheme = section.scheme',
  },
  // ---- the scheme rules ----------------------------------------------------
  // These six arrived with the reserved-name table and the 3-character minimum.
  // Each targets one rule, and each is phrased as "the rule stops applying"
  // rather than "the code throws": a mutation that only breaks parsing proves
  // nothing.
  {
    name: 'the minimum length is lowered to one character',
    file: 'lib/passthrough.js',
    find: 'export const MIN_SCHEME_LENGTH = 3',
    replace: 'export const MIN_SCHEME_LENGTH = 1',
  },
  {
    name: 'the reserved table stops refusing anything',
    file: 'lib/passthrough.js',
    find: 'const RESERVED_SCHEMES = new Set(SCHEMES_IN_USE.map(entry => entry.name))',
    replace: 'const RESERVED_SCHEMES = new Set()',
  },
  {
    // The reserved names are matched AFTER `trim().toLowerCase()`. Dropping the
    // fold is what lets `FILE`, `File` and ` file ` through, so this mutation is
    // the only way to prove the order is pinned.
    name: 'the name is no longer folded before the reserved lookup',
    file: 'lib/passthrough.js',
    find: '  const candidate = value.trim().toLowerCase()',
    replace: '  const candidate = value.trim()',
  },
  {
    name: 'darwin is folded like win32',
    file: 'lib/passthrough.js',
    find: '  return platform === \'win32\' ? spelling.toLowerCase() : spelling',
    replace: '  return platform === \'win32\' || platform === \'darwin\' ? spelling.toLowerCase() : spelling',
  },
  {
    name: 'a degraded stored value reports itself as effective',
    file: 'lib/passthrough-settings.js',
    find: '      effective: this.matcher?.scheme ?? this.defaults.scheme',
    replace: '      effective: name',
  },
  {
    name: 'the status route stops publishing the degraded-value warning',
    file: 'lib/routes.js',
    find: '                  schemeWarning: passthroughSettings.warning?.() ?? null,',
    replace: '                  schemeWarning: null,',
  },
]

let failures = 0
const fileCache = new Map()
/** Files currently carrying a mutation, with the bytes to put back. */
const inFlight = new Map()

/**
 * Restore every mutated file, on any exit path.
 *
 * `try/finally` inside the loop cannot see a signal, and a script whose output
 * is piped into a pager or `Select-Object -First N` dies of EPIPE without ever
 * reaching it. 'exit' covers the exception and normal returns; the signals are
 * hooked separately because Node does not run 'exit' for those.
 */
const restoreAll = () => {
  for (const [file, original] of inFlight) {
    try {
      writeFileSync(file, original, 'utf8')
      const backup = `${file}${BACKUP_SUFFIX}`
      if (existsSync(backup)) unlinkSync(backup)
    } catch (error) {
      console.error(`could not restore ${file}: ${error.message}`)
      console.error(`the original is at ${file}${BACKUP_SUFFIX} — copy it back by hand`)
    }
  }
  inFlight.clear()
}
process.on('exit', restoreAll)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(signal, () => {
    restoreAll()
    process.exit(130)
  })
}

for (const mutation of MUTATIONS) {
  const file = path.join(root, mutation.file)
  const backup = `${file}${BACKUP_SUFFIX}`
  // A backup means a previous run died mid-mutation on THIS file. The backup is
  // the pre-mutation original, so it wins over whatever is on disk now.
  if (existsSync(backup)) {
    writeFileSync(file, readFileSync(backup))
    unlinkSync(backup)
    fileCache.delete(file)
    console.log(`  recovered ${mutation.file} from a previous run's backup`)
  }
  const original = fileCache.get(file) ?? readFileSync(file, 'utf8')
  fileCache.set(file, original)
  if (!original.includes(mutation.find)) {
    console.log(`  BROKEN  ${mutation.name}`)
    console.log(`          the anchor text does not exist in ${mutation.file} — this mutation never applied`)
    failures += 1
    continue
  }
  writeFileSync(backup, original, 'utf8')
  inFlight.set(file, original)
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
    unlinkSync(backup)
    inFlight.delete(file)
  }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const red = (output.match(/^ {2}FAIL/mgu) ?? []).length
  // A mutation can also break the suite outright (a ReferenceError before any
  // assertion runs). That is still red — the tests noticed — so the exit status
  // counts too; only a clean 0 with no FAIL line means the tests missed it.
  if (red > 0) console.log(`  RED     ${mutation.name} (${red} assertion(s))`)
  else if (result.status !== 0) {
    const detail = (output.match(/^[A-Za-z]*Error: .*$/mu) ?? [null])[0]
    console.log(`  RED     ${mutation.name} (suite failed${detail === null ? '' : `: ${detail.slice(0, 90)}`})`)
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
console.log(`=== ${MUTATIONS.length} confirmed, 0 not ===`)
