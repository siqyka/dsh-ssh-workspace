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

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const {
  sourceIdentity, resumableStagingName, resumeSidecarName, planResume,
  resumeRecord, parseResumeRecord,
} = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'resume.js')).href)

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

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
if (failures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}
