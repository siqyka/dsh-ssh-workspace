/**
 * Scratch-directory safety: the guard around the suites' remote cleanup.
 *
 * The live suites delete a directory on a real host, and the path comes from
 * `DSH_WS_TEST_DIR`. The failure this pins down is not "the suite forgot to
 * clean up" — it is "the suite cleaned up the wrong thing":
 *
 *   DSH_WS_TEST_DIR=""        → `rm -rf ${sandbox}` becomes a bare `rm -rf`
 *   DSH_WS_TEST_DIR=/a b/c    → unquoted, it becomes two arguments
 *   DSH_WS_TEST_DIR=/etc      → a value the suite never created, deleted anyway
 *
 * So the rule is: prove the path is a scratch directory BEFORE anything is
 * created, and refuse rather than guess. These assertions are the proof, and
 * they run without a host because the decision is pure.
 *
 * Run: node tests/scratch-safety-smoke.mjs
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { checkScratchPath, resolveScratchDir, removeScratch } = await import(
  pathToFileURL(path.join(pluginRoot, 'tests/scratch.mjs')).href
)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

// ---------------------------------------------------------------------------
// 1. Values that must be refused
// ---------------------------------------------------------------------------
console.log('\n[1] a path that is not provably scratch is refused')
{
  const refused = [
    ['', 'the empty string (the `rm -rf` with no operand case)'],
    ['   ', 'whitespace only'],
    ['/tmp', 'the temp root itself'],
    ['/', 'the filesystem root'],
    ['/etc', 'a directory outside /tmp'],
    ['/tmp/not-a-scratch-name', 'a /tmp path without the expected prefix'],
    ['/home/user/project', 'a path outside /tmp'],
    ['relative/path', 'a relative path'],
    ['/tmp/dsh-ssh-workspace-test\n', 'a path with a trailing newline'],
  ]
  for (const [value, why] of refused) {
    const verdict = checkScratchPath(value)
    check(`refuses ${JSON.stringify(value)} (${why})`, verdict.ok === false, JSON.stringify(verdict))
    check(`the refusal explains itself for ${JSON.stringify(value)}`,
      typeof verdict.reason === 'string' && verdict.reason.length > 10, verdict.reason)
  }
}

// ---------------------------------------------------------------------------
// 2. Values that must be accepted
// ---------------------------------------------------------------------------
console.log('\n[2] a genuine scratch directory is accepted')
{
  for (const value of [
    '/tmp/dsh-ssh-workspace',
    '/tmp/dsh-ssh-workspace-test',
    '/tmp/dsh-ssh-workspace-acceptance',
    '/tmp/dsh-ssh-workspace-test/',
    '/tmp/dsh-ssh-workspace-nested/deeper',
    '/tmp/dsh-ssh-workspace-a b',
  ]) {
    const verdict = checkScratchPath(value)
    check(`accepts ${JSON.stringify(value)}`, verdict.ok === true, JSON.stringify(verdict))
  }
}

// ---------------------------------------------------------------------------
// 3. The environment resolution refuses a bad value before anything runs
// ---------------------------------------------------------------------------
console.log('\n[3] the suite refuses to start on a bad DSH_WS_TEST_DIR')
{
  const cases = [
    [{}, '/tmp/dsh-ssh-workspace-test', 'an unset variable falls back to the default'],
    [{ DSH_WS_TEST_DIR: '/tmp/dsh-ssh-workspace-custom' }, '/tmp/dsh-ssh-workspace-custom', 'an explicit good value is honoured'],
    [{ DSH_WS_TEST_DIR: '' }, '/tmp/dsh-ssh-workspace-test', 'an empty variable falls back rather than deleting /tmp'],
    [{ DSH_WS_TEST_DIR: '   ' }, '/tmp/dsh-ssh-workspace-test', 'a blank variable falls back too'],
  ]
  for (const [env, expected, why] of cases) {
    const resolved = resolveScratchDir(env, '/tmp/dsh-ssh-workspace-test')
    check(`${why}: ${JSON.stringify(expected)}`, resolved.ok === true && resolved.path === expected, JSON.stringify(resolved))
  }

  for (const bad of ['/etc', '/tmp/other-name', 'relative', '/']) {
    const resolved = resolveScratchDir({ DSH_WS_TEST_DIR: bad }, '/tmp/dsh-ssh-workspace-test')
    check(`an explicit ${JSON.stringify(bad)} is REFUSED, not silently replaced`,
      resolved.ok === false, JSON.stringify(resolved))
  }
}

// ---------------------------------------------------------------------------
// 4. removeScratch never issues a deletion for a refused path
// ---------------------------------------------------------------------------
console.log('\n[4] removeScratch refuses without touching the host')
{
  const calls = []
  const engine = {
    async exec (alias, command) { calls.push({ alias, command }) },
  }

  for (const bad of ['', '/etc', '/tmp', '/tmp/not-scratch', '/']) {
    const outcome = await removeScratch(engine, 'h', bad)
    check(`removeScratch(${JSON.stringify(bad)}) refuses`, outcome.ok === false, JSON.stringify(outcome))
  }
  check('no remote command was issued for any refused path', calls.length === 0, `${calls.length} calls: ${JSON.stringify(calls)}`)

  const outcome = await removeScratch(engine, 'h', '/tmp/dsh-ssh-workspace-test')
  check('removeScratch accepts a real scratch directory', outcome.ok === true, JSON.stringify(outcome))
  check('the accepted deletion quotes the path', calls.length === 1 && /rm -rf -- '\/tmp\/dsh-ssh-workspace-test'/u.test(calls[0].command), JSON.stringify(calls))
}

// ---------------------------------------------------------------------------
// 5. A path with a space is quoted into ONE argument
// ---------------------------------------------------------------------------
console.log('\n[5] a path with a space stays one operand')
{
  const calls = []
  const engine = { async exec (alias, command) { calls.push(command) } }
  await removeScratch(engine, 'h', '/tmp/dsh-ssh-workspace-a b')
  check('the space-containing path is single-quoted',
    calls.length === 1 && calls[0] === `rm -rf -- '/tmp/dsh-ssh-workspace-a b'`, JSON.stringify(calls))
}

console.log(`\n=== ${passed} passed, ${failures} failed ===`)
if (failures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}
