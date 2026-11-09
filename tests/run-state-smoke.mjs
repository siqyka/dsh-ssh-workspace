/**
 * The runner's fourth state: a suite that ran some assertions and skipped
 * one environment-dependent section (`partial`) must not be folded into either
 * pass or skip.
 *
 * Run: node tests/run-state-smoke.mjs
 */

import { classifySuite } from './support/run-state.mjs'

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

console.log('\n[1] a non-zero exit or a failed summary is a failure')
{
  const exited = classifySuite({
    status: 1,
    output: '  PASS  one assertion\n\n=== 1 passed, 0 failed ===\n',
  })
  check('a non-zero exit fails even when the summary looks green',
    exited.state === 'fail', JSON.stringify(exited))

  const red = classifySuite({
    status: 0,
    output: '  FAIL  one assertion\n\n=== 4 passed, 1 failed ===\n',
  })
  check('a failed count in the summary fails',
    red.state === 'fail' && red.failed === 1, JSON.stringify(red))
}

console.log('\n[2] a missing summary cannot prove that anything ran')
{
  const silent = classifySuite({ status: 0, output: '  PASS  one assertion\n' })
  check('exit 0 without a summary is a failure',
    silent.state === 'fail' && silent.passed === 0, JSON.stringify(silent))
}

console.log('\n[3] passing assertions without a skip are a pass')
{
  const green = classifySuite({
    status: 0,
    output: '  PASS  first\n  PASS  second\n\n=== 2 passed, 0 failed ===\n',
  })
  check('two passing assertions and no SKIP line is pass',
    green.state === 'pass' && green.passed === 2 && green.failed === 0,
    JSON.stringify(green))

  // "skip" in prose is not the skip line. The old detector used the word, but
  // the runner has always required it at the start of a line; keep that
  // distinction under test so a verbose suite is not silently downgraded.
  const prose = classifySuite({
    status: 0,
    output: '  PASS  first\n  note: this section does not skip without a host\n\n=== 1 passed, 0 failed ===\n',
  })
  check('the word "skip" inside prose does not make the suite partial',
    prose.state === 'pass', JSON.stringify(prose))
}

console.log('\n[4] pass plus a SKIP line is partial, not pass and not skip')
{
  const partial = classifySuite({
    status: 0,
    output: [
      '  PASS  first',
      '  PASS  second',
      '  SKIP  remote-host checks (set DSH_WS_TEST_ALIAS to enable)',
      '',
      '=== 2 passed, 0 failed ===',
      '',
    ].join('\n'),
  })
  check('passing assertions plus a SKIP line is partial',
    partial.state === 'partial' && partial.passed === 2 && partial.skipLines.length === 1,
    JSON.stringify(partial))
}

console.log('\n[5] zero passing assertions distinguishes skip from failure')
{
  const skip = classifySuite({
    status: 0,
    output: '  SKIP  DSH_CORE_ROOT is not set\n\n=== 0 passed, 0 failed, 1 suite skipped ===\n',
  })
  check('zero passing assertions plus a SKIP line is skip',
    skip.state === 'skip' && skip.passed === 0 && skip.skipLines.length === 1,
    JSON.stringify(skip))

  const empty = classifySuite({ status: 0, output: '=== 0 passed, 0 failed ===\n' })
  check('zero passing assertions and no SKIP line is failure',
    empty.state === 'fail' && empty.passed === 0, JSON.stringify(empty))
}

console.log('\n[6] the parser follows the real summary shapes')
{
  const named = classifySuite({
    status: 0,
    output: '=== zip smoke: 237 passed, 0 failed ===\n',
  })
  check('a named summary prefix is still parsed',
    named.state === 'pass' && named.passed === 237, JSON.stringify(named))

  const last = classifySuite({
    status: 0,
    output: '=== 1 passed, 0 failed ===\n  PASS  a later section\n=== 2 passed, 0 failed ===\n',
  })
  check('the last summary is the one classified',
    last.state === 'pass' && last.passed === 2, JSON.stringify(last))
}

console.log(`\n=== ${passed} passed, ${failures} failed ===\n`)
if (failures > 0) process.exit(1)
