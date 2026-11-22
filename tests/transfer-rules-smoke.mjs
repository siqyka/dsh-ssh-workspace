/**
 * The transfer rule table: resume planning, digest verification, conflict policy.
 *
 * Three decisions that are made BEFORE bytes move, all living in
 * `lib/transfer/transfer-rules.js`, and all provable without a host. One module,
 * one file:
 *   - resume — appending to a staged part is safe only when the source identity
 *     matches; every case below is a way a naive seek produces a file of the
 *     right length and the wrong content;
 *   - verify — a digest comparison whose whole point is refusing to call two
 *     missing values a match;
 *   - conflict-policy — "skip" must be a reported outcome, not an error.
 *
 * Run: node tests/transfer-rules-smoke.mjs
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

let totalPassed = 0
let totalFailures = 0

// ---------------------------------------------------------------------------
// resume-smoke.mjs
// ---------------------------------------------------------------------------
await (async () => {
/**
 * Resume planning: the decisions that make appending safe, and the cases where
 * it must not happen.
 *
 * Every case below is a way a naive "seek to the staged size and keep writing"
 * produces a file of exactly the right length and the wrong content — the worst
 * possible outcome, because it publishes successfully.
 *
 * Run: node tests/resume-smoke.mjs
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const {
  sourceIdentity, resumableStagingName, resumeSidecarName, planResume,
  resumeRecord, parseResumeRecord,
} = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'transfer', 'transfer-rules.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== resume smoke ===\n')

// ---------------------------------------------------------------------------
// 1. Source identity
// ---------------------------------------------------------------------------
console.log('[1] the source identity')
{
  const a = sourceIdentity({ size: 100, mtimeMs: 1700000000000 })
  check('a size and an mtime make a token', typeof a === 'string' && a.includes(':'), a)
  check('the same stats give the same token',
    sourceIdentity({ size: 100, mtimeMs: 1700000000000 }) === a)
  check('a different size gives a different token',
    sourceIdentity({ size: 101, mtimeMs: 1700000000000 }) !== a)
  check('a different mtime gives a different token',
    sourceIdentity({ size: 100, mtimeMs: 1700000000001 }) !== a)
  // Sub-millisecond precision is not available everywhere; truncating keeps the
  // token stable across a filesystem that reports it inconsistently.
  check('sub-millisecond precision is dropped',
    sourceIdentity({ size: 1, mtimeMs: 1000.7 }) === sourceIdentity({ size: 1, mtimeMs: 1000.2 }),
    `${sourceIdentity({ size: 1, mtimeMs: 1000.7 })} vs ${sourceIdentity({ size: 1, mtimeMs: 1000.2 })}`)
  check('missing stats do not throw', typeof sourceIdentity({}) === 'string', sourceIdentity({}))
}

// ---------------------------------------------------------------------------
// 2. Deterministic names
// ---------------------------------------------------------------------------
console.log('[2] resumable names are DETERMINISTIC')
{
  const target = '/srv/app.bin'
  check('the staging name is stable', resumableStagingName(target) === resumableStagingName(target))
  check('and sits beside the destination', resumableStagingName(target).startsWith('/srv/app.bin.'))
  check('the sidecar is derived from it',
    resumeSidecarName(target) === `${resumableStagingName(target)}.json`)
  // Two DESTINATIONS must not share one partial file.
  check('different destinations get different names',
    resumableStagingName('/srv/a') !== resumableStagingName('/srv/b'))
  // A trailing slash must not change which file it is.
  check('a trailing slash does not change the name',
    resumableStagingName('/srv/a/') === resumableStagingName('/srv/a'))
}

// ---------------------------------------------------------------------------
// 3. Nothing staged
// ---------------------------------------------------------------------------
console.log('[3] nothing staged means a fresh copy')
{
  const plan = planResume({ partialBytes: 0, currentIdentity: 'x', totalBytes: 100 })
  check('no resume', plan.resume === false, JSON.stringify(plan))
  check('from zero', plan.offset === 0, JSON.stringify(plan))

  const missing = planResume({ currentIdentity: 'x', totalBytes: 100 })
  check('a missing size is also "nothing staged"', missing.resume === false, JSON.stringify(missing))
}

// ---------------------------------------------------------------------------
// 4. The happy path: a prefix of the same source
// ---------------------------------------------------------------------------
console.log('[4] a prefix of the SAME source resumes')
{
  const plan = planResume({
    partialBytes: 400,
    recordedIdentity: '1000:1700000000000',
    currentIdentity: '1000:1700000000000',
    totalBytes: 1000,
  })
  check('it resumes', plan.resume === true, JSON.stringify(plan))
  check('from where it stopped', plan.offset === 400, JSON.stringify(plan))
  check('and says why', /prefix/u.test(plan.reason), plan.reason)
}

// ---------------------------------------------------------------------------
// 5. THE dangerous case: the source changed
// ---------------------------------------------------------------------------
console.log('[5] a source that CHANGED must not be resumed')
{
  const plan = planResume({
    partialBytes: 400,
    recordedIdentity: '1000:1700000000000',
    // Same size, different mtime: a rebuild that produced a same-length file.
    currentIdentity: '1000:1700000009999',
    totalBytes: 1000,
  })
  check('it does NOT resume', plan.resume === false, JSON.stringify(plan))
  check('and restarts from zero', plan.offset === 0, JSON.stringify(plan))
  check('the reason names the change', /changed/u.test(plan.reason), plan.reason)
}

// ---------------------------------------------------------------------------
// 6. A staged file LARGER than the source
// ---------------------------------------------------------------------------
console.log('[6] a staged file bigger than the source is not a prefix')
{
  const plan = planResume({
    partialBytes: 2000,
    recordedIdentity: '1000:1700000000000',
    currentIdentity: '1000:1700000000000',
    totalBytes: 1000,
  })
  // A naive `offset = partialSize` would seek past the end here and publish a
  // file whose head belongs to a different, larger source.
  check('it does NOT resume', plan.resume === false, JSON.stringify(plan))
  check('and restarts from zero', plan.offset === 0, JSON.stringify(plan))
  check('the reason says why', /larger than the source/u.test(plan.reason), plan.reason)
}

// ---------------------------------------------------------------------------
// 7. A staged file already at full size
// ---------------------------------------------------------------------------
console.log('[7] a fully-staged file only needs publishing')
{
  const plan = planResume({
    partialBytes: 1000,
    recordedIdentity: '1000:1700000000000',
    currentIdentity: '1000:1700000000000',
    totalBytes: 1000,
  })
  // This is the crash-between-last-write-and-rename case. Re-uploading a
  // gigabyte to redo a rename is the behaviour this exists to avoid.
  check('it resumes', plan.resume === true, JSON.stringify(plan))
  check('with nothing left to send', plan.offset === 1000, JSON.stringify(plan))
  check('and says publishing is all that remains', /publishing/u.test(plan.reason), plan.reason)
}

// ---------------------------------------------------------------------------
// 8. No sidecar, or a sidecar about something else
// ---------------------------------------------------------------------------
console.log('[8] an unrecorded partial file is discarded')
{
  const noRecord = planResume({ partialBytes: 400, currentIdentity: 'x', totalBytes: 1000 })
  check('a missing sidecar does not resume', noRecord.resume === false, JSON.stringify(noRecord))
  check('and says so', /no record/u.test(noRecord.reason), noRecord.reason)

  const empty = planResume({ partialBytes: 400, recordedIdentity: '', currentIdentity: 'x', totalBytes: 1000 })
  check('an empty identity does not resume', empty.resume === false, JSON.stringify(empty))
}

// ---------------------------------------------------------------------------
// 9. The sidecar's own format
// ---------------------------------------------------------------------------
console.log('[9] the sidecar')
{
  const record = resumeRecord({ identity: 'a:b', totalBytes: 10, source: '/tmp/x' })
  check('it has a version', record.version === 1, JSON.stringify(record))
  check('it records the identity', record.identity === 'a:b', JSON.stringify(record))
  check('it records the total', record.totalBytes === 10, JSON.stringify(record))

  const parsed = parseResumeRecord(JSON.stringify(record))
  check('it round-trips', parsed?.identity === 'a:b' && parsed?.totalBytes === 10, JSON.stringify(parsed))

  // Refusals: every one of these must be "absent", not "partially trusted".
  check('broken JSON is absent', parseResumeRecord('{oops') === undefined)
  check('an empty string is absent', parseResumeRecord('') === undefined)
  check('null is absent', parseResumeRecord(null) === undefined)
  check('a future version is absent', parseResumeRecord(JSON.stringify({ version: 2, identity: 'a:b' })) === undefined,
    JSON.stringify(parseResumeRecord(JSON.stringify({ version: 2, identity: 'a:b' }))))
  check('a record with no identity is absent', parseResumeRecord(JSON.stringify({ version: 1 })) === undefined)
  check('an empty identity is absent',
    parseResumeRecord(JSON.stringify({ version: 1, identity: '' })) === undefined)
  check('a JSON array is absent', parseResumeRecord('[]') === undefined)
  check('a JSON string is absent', parseResumeRecord('"hello"') === undefined)
}

// ---------------------------------------------------------------------------
// 10. Every refusal is fail-closed
// ---------------------------------------------------------------------------
console.log('[10] every refusal restarts, none of them appends')
{
  const refusals = [
    { partialBytes: 0 },
    { partialBytes: 2000, recordedIdentity: 'a', currentIdentity: 'a', totalBytes: 1000 },
    { partialBytes: 400, recordedIdentity: 'a', currentIdentity: 'b', totalBytes: 1000 },
    { partialBytes: 400, currentIdentity: 'a', totalBytes: 1000 },
  ]
  for (const input of refusals) {
    const plan = planResume(input)
    check(`refusal at ${JSON.stringify(input)} starts at 0`, plan.resume === false && plan.offset === 0,
      JSON.stringify(plan))
  }
}


  totalPassed += passed
  totalFailures += failures
})()

// ---------------------------------------------------------------------------
// verify-smoke.mjs
// ---------------------------------------------------------------------------
await (async () => {
/**
 * Transfer verification: digests, the three tools' output shapes, and the
 * comparison whose whole point is refusing to call two missing values a match.
 *
 * Run: node tests/verify-smoke.mjs
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const { REMOTE_HASHERS, digestOfHasherOutput, hashLocalFile, compareDigests, findRemoteHasher, hashRemoteFile } =
  await import(pathToFileURL(path.join(pluginRoot, 'lib', 'transfer', 'transfer-rules.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const cleanups = []
function scratch () {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-verify-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

console.log('\n=== verify smoke ===\n')

// ---------------------------------------------------------------------------
// 1. The three hashers' output shapes
// ---------------------------------------------------------------------------
console.log('[1] reading a digest out of each tool\'s output')
{
  const digest = 'a'.repeat(64)
  // sha256sum / shasum -a 256
  check('sha256sum shape', digestOfHasherOutput(`${digest}  /path/to/file\n`) === digest,
    digestOfHasherOutput(`${digest}  /path/to/file\n`))
  // openssl dgst -sha256 -r
  check('openssl -r shape', digestOfHasherOutput(`${digest} */path/to/file\n`) === digest,
    digestOfHasherOutput(`${digest} */path/to/file\n`))
  // Uppercase input is normalised down: OpenSSL and macOS spell it either way.
  check('uppercase is lowercased', digestOfHasherOutput(`${digest.toUpperCase()}  f`) === digest,
    digestOfHasherOutput(`${digest.toUpperCase()}  f`))
}

// ---------------------------------------------------------------------------
// 2. Junk is NOT a digest
// ---------------------------------------------------------------------------
console.log('[2] an unreadable output is undefined, not a wrong hash')
{
  check('empty output', digestOfHasherOutput('') === undefined)
  check('an error message', digestOfHasherOutput('sha256sum: no such file') === undefined,
    digestOfHasherOutput('sha256sum: no such file'))
  // A SHORT hex token must not be accepted: it would let a tool's error text be
  // compared as a checksum and "match".
  check('a truncated digest is rejected', digestOfHasherOutput('abc123  file') === undefined,
    digestOfHasherOutput('abc123  file'))
  check('a hash of the wrong algorithm is rejected',
    digestOfHasherOutput('a'.repeat(40) + '  file') === undefined,
    digestOfHasherOutput('a'.repeat(40) + '  file'))
}

// ---------------------------------------------------------------------------
// 3. Local hashing
// ---------------------------------------------------------------------------
console.log('[3] hashing a local file')
{
  const dir = scratch()
  const file = path.join(dir, 'x')
  writeFileSync(file, 'hello')
  // Known value: SHA-256("hello")
  const expected = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
  check('the digest is the known SHA-256', (await hashLocalFile(file)) === expected,
    await hashLocalFile(file))

  const empty = path.join(dir, 'empty')
  writeFileSync(empty, '')
  check('an empty file hashes to the empty-string digest',
    (await hashLocalFile(empty)) === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    await hashLocalFile(empty))

  let aborted
  const controller = new AbortController()
  controller.abort()
  try { await hashLocalFile(file, controller.signal) } catch { aborted = true }
  check('an aborted hash rejects', aborted === true)
}

// ---------------------------------------------------------------------------
// 4. compareDigests — the case that matters
// ---------------------------------------------------------------------------
console.log('[4] comparing digests')
{
  const a = 'a'.repeat(64)
  const b = 'b'.repeat(64)
  check('equal digests match', compareDigests(a, a).ok === true)
  check('different digests do not', compareDigests(a, b).ok === false)
  check('and the reason quotes both', /mismatch/u.test(compareDigests(a, b).reason ?? ''),
    compareDigests(a, b).reason)

  // THE case: in JavaScript `undefined === undefined` is true, so a comparison
  // written naively reports success exactly when both sides failed to hash.
  check('two missing digests do NOT match', compareDigests(undefined, undefined).ok === false,
    JSON.stringify(compareDigests(undefined, undefined)))
  check('a missing source is refused', compareDigests(undefined, a).ok === false)
  check('a missing destination is refused', compareDigests(a, undefined).ok === false)
  check('an empty string is missing, not a digest', compareDigests('', '').ok === false)
  // Case-insensitive: the tools spell it either way.
  check('case does not matter', compareDigests(a.toUpperCase(), a).ok === true)
}

// ---------------------------------------------------------------------------
// 5. Finding a hasher on the host
// ---------------------------------------------------------------------------
console.log('[5] finding a remote hasher')
{
  /** An engine double that answers the probe with a chosen set of tools. */
  const engineSaying = (present) => ({
    async exec (alias, command) {
      // Echo back exactly the tools the probe asked about and that "exist".
      const lines = REMOTE_HASHERS
        .filter(entry => present.includes(entry.name))
        .map(entry => `dsh-hash:${entry.name}`)
      return { success: true, exitCode: 0, stdout: lines.join('\n') + (lines.length > 0 ? '\n' : ''), stderr: '', timedOut: false, truncated: false, durationMs: 1 }
    },
  })

  check('sha256sum is preferred',
    (await findRemoteHasher(engineSaying(['sha256sum', 'shasum', 'openssl']), 'h'))?.name === 'sha256sum')
  check('shasum when that is all there is',
    (await findRemoteHasher(engineSaying(['shasum']), 'h'))?.name === 'shasum')
  check('openssl as a last resort',
    (await findRemoteHasher(engineSaying(['openssl']), 'h'))?.name === 'openssl')
  check('none at all is undefined, not a throw',
    (await findRemoteHasher(engineSaying([]), 'h')) === undefined)

  // A failing probe (host down) is also "no hasher", not an exception.
  const broken = { async exec () { return { success: false, exitCode: 1, stdout: '', stderr: 'denied', timedOut: false, truncated: false, durationMs: 1 } } }
  check('a failed probe is undefined', (await findRemoteHasher(broken, 'h')) === undefined)
}

// ---------------------------------------------------------------------------
// 6. Hashing on the host
// ---------------------------------------------------------------------------
console.log('[6] hashing a remote file')
{
  const digest = 'c'.repeat(64)
  const engine = {
    async exec (alias, command) {
      // The path must be quoted: a filename with a space or a quote would
      // otherwise split the command.
      if (!command.includes("'/srv/my file.txt'")) {
        return { success: true, exitCode: 0, stdout: '', stderr: '', timedOut: false, truncated: false, durationMs: 1 }
      }
      return { success: true, exitCode: 0, stdout: `${digest}  /srv/my file.txt\n`, stderr: '', timedOut: false, truncated: false, durationMs: 1 }
    },
  }
  const hasher = REMOTE_HASHERS[0]
  check('the digest is read', (await hashRemoteFile(engine, 'h', '/srv/my file.txt', hasher)) === digest,
    await hashRemoteFile(engine, 'h', '/srv/my file.txt', hasher))
  check('the path is shell-quoted, including the space',
    (await hashRemoteFile(engine, 'h', "/srv/it's.txt", hasher)) === undefined,
    'the quoting case did not reach the guard')
}

// ---------------------------------------------------------------------------
// 7. The hasher list is ordered and named
// ---------------------------------------------------------------------------
console.log('[7] the hasher list')
{
  check('three hashers', REMOTE_HASHERS.length === 3, String(REMOTE_HASHERS.length))
  check('each has a name and a command',
    REMOTE_HASHERS.every(entry => typeof entry.name === 'string' && typeof entry.command === 'string'))
  check('the order is the preference order',
    REMOTE_HASHERS.map(entry => entry.name).join(',') === 'sha256sum,shasum,openssl',
    REMOTE_HASHERS.map(entry => entry.name).join(','))
}

for (const cleanup of cleanups.reverse()) {
  try { cleanup() } catch { /* best effort */ }
}


  totalPassed += passed
  totalFailures += failures
})()

// ---------------------------------------------------------------------------
// conflict-policy-smoke.mjs
// ---------------------------------------------------------------------------
await (async () => {
/**
 * Conflict policy: what a transfer does when the destination already exists.
 *
 * The interesting cases are the non-defaults, and "skip" in particular: it must
 * be a REPORTED outcome rather than an error, because a tree upload over a
 * mostly-identical tree is the normal case and failing on the first existing
 * file is why people stop using tree upload.
 *
 * Run: node tests/conflict-policy-smoke.mjs
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const { CONFLICT_POLICIES, DEFAULT_CONFLICT_POLICY, normalizeConflictPolicy, decideConflict, freeName } =
  await import(pathToFileURL(path.join(pluginRoot, 'lib', 'transfer', 'transfer-rules.js')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('\n=== conflict policy smoke ===\n')

// ---------------------------------------------------------------------------
// 1. Vocabulary and default
// ---------------------------------------------------------------------------
console.log('[1] four policies, one default')
{
  check('four policies', CONFLICT_POLICIES.length === 4, JSON.stringify(CONFLICT_POLICIES))
  check('the default is overwrite', DEFAULT_CONFLICT_POLICY === 'overwrite', DEFAULT_CONFLICT_POLICY)
  check('an absent policy is the default', normalizeConflictPolicy(undefined) === 'overwrite')
  check('a typo falls back to the default', normalizeConflictPolicy('overwrit') === 'overwrite')
  check('case and whitespace do not matter', normalizeConflictPolicy('  SKIP ') === 'skip')
  check('an unknown policy never becomes rename',
    normalizeConflictPolicy('rename-ish') !== 'rename', normalizeConflictPolicy('rename-ish'))
}

// ---------------------------------------------------------------------------
// 2. A free destination is always "proceed"
// ---------------------------------------------------------------------------
console.log('[2] nothing there means no decision')
{
  for (const policy of CONFLICT_POLICIES) {
    const decision = await decideConflict({ policy, exists: false })
    check(`${policy}: proceeds`, decision.action === 'proceed', JSON.stringify(decision))
  }
}

// ---------------------------------------------------------------------------
// 3. overwrite
// ---------------------------------------------------------------------------
console.log('[3] overwrite replaces')
{
  const decision = await decideConflict({ policy: 'overwrite', exists: true, destination: '/a/b' })
  check('it proceeds', decision.action === 'proceed', JSON.stringify(decision))
  check('at the original path', decision.path === undefined, JSON.stringify(decision))
  check('with no note', decision.note === undefined, JSON.stringify(decision))
}

// ---------------------------------------------------------------------------
// 4. skip — an OUTCOME, not an error
// ---------------------------------------------------------------------------
console.log('[4] skip is reported, not thrown')
{
  const decision = await decideConflict({ policy: 'skip', exists: true, destination: '/a/b' })
  check('the action is skip, not refuse', decision.action === 'skip', JSON.stringify(decision))
  check('and the note explains it', /already exists/u.test(decision.note ?? ''), decision.note)
  check('and names the destination', /\/a\/b/u.test(decision.note ?? ''), decision.note)
}

// ---------------------------------------------------------------------------
// 5. refuse
// ---------------------------------------------------------------------------
console.log('[5] refuse stops before writing')
{
  const decision = await decideConflict({ policy: 'refuse', exists: true, destination: '/a/b' })
  check('the action is refuse', decision.action === 'refuse', JSON.stringify(decision))
  check('and the note says which policy', /refuse/u.test(decision.note ?? ''), decision.note)
}

// ---------------------------------------------------------------------------
// 6. rename finds a free name
// ---------------------------------------------------------------------------
console.log('[6] rename writes beside the existing file')
{
  const taken = new Set(['/a/b.txt', '/a/b.1.txt'])
  const existsAt = async (candidate) => taken.has(candidate)
  const decision = await decideConflict({ policy: 'rename', exists: true, destination: '/a/b.txt', existsAt })
  check('it proceeds', decision.action === 'proceed', JSON.stringify(decision))
  check('to a NEW path', decision.path !== '/a/b.txt', decision.path)
  check('which is the first free number', decision.path === '/a/b.2.txt', decision.path)
  check('and the note says where it went', /b\.2\.txt/u.test(decision.note ?? ''), decision.note)

  // Without a probe it still has to produce something distinct.
  const blind = await decideConflict({ policy: 'rename', exists: true, destination: '/a/b.txt' })
  check('with no probe it still picks a different name', blind.path !== '/a/b.txt', blind.path)
}

// ---------------------------------------------------------------------------
// 7. freeName's own contract
// ---------------------------------------------------------------------------
console.log('[7] freeName')
{
  const existsAt = async (candidate) => candidate === '/x/y.1.log'
  check('the number goes BEFORE the extension', (await freeName('/x/y.log', existsAt)) === '/x/y.2.log',
    await freeName('/x/y.log', existsAt))
  // A dotfile's leading dot is not an extension.
  check('a dotfile keeps its name', (await freeName('/x/.env', async () => false)) === '/x/.env.1',
    await freeName('/x/.env', async () => false))
  check('a name with no extension gets one appended',
    (await freeName('/x/README', async () => false)) === '/x/README.1',
    await freeName('/x/README', async () => false))
  // A probe that always says "taken" must terminate, not loop.
  let calls = 0
  const alwaysTaken = async () => { calls += 1; return true }
  const fallback = await freeName('/x/z', alwaysTaken)
  check('an always-taken probe terminates', typeof fallback === 'string' && fallback !== '/x/z', fallback)
  check('after a bounded number of probes', calls <= 1001, String(calls))
}


  totalPassed += passed
  totalFailures += failures
})()

console.log(`\n=== ${totalPassed} passed, ${totalFailures} failed ===`)
if (totalFailures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}