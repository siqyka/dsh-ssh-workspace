/**
 * The repository's own test infrastructure, checked as behavior.
 *
 * These suites do not exercise the plugin; they exercise the things every
 * other suite trusts:
 *   - run-state — the runner's fourth outcome (`partial`) is not folded into
 *     pass or skip;
 *   - scratch-safety — a remote cleanup proves its path is a scratch directory
 *     before deleting anything;
 *   - source-scanners — a file that is not there is an error, never an empty
 *     answer;
 *   - render — the DOM harness itself, against a real shipped component;
 *   - plugin-host — the shared ctx double refuses what Cordis refuses.
 *
 * They are grouped because a regression here is invisible until it makes some
 * OTHER suite pass for the wrong reason.
 *
 * Run: node tests/repo-checks-smoke.mjs
 */

import { classifySuite } from './support/run-state.mjs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { componentSource, compile, createReactStub, render, findAll, byType, textOf } from './support/render.mjs'
import { clientSource } from './support/client-source.mjs'
import { createHost, LocalBackend } from './support/plugin-host.mjs'

let totalPassed = 0
let totalFailures = 0

// ---------------------------------------------------------------------------
// run-state-smoke.mjs
// ---------------------------------------------------------------------------
await (async () => {
/**
 * The runner's fourth state: a suite that ran some assertions and skipped
 * one environment-dependent section (`partial`) must not be folded into either
 * pass or skip.
 *
 * Run: node tests/run-state-smoke.mjs
 */
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


  totalPassed += passed
  totalFailures += failures
})()

// ---------------------------------------------------------------------------
// scratch-safety-smoke.mjs
// ---------------------------------------------------------------------------
await (async () => {
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
 */const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
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


  totalPassed += passed
  totalFailures += failures
})()

// ---------------------------------------------------------------------------
// source-scanners-smoke.mjs
// ---------------------------------------------------------------------------
await (async () => {
/**
 * Source scanners: a file that is not there is an error, never an empty answer.
 *
 * Every scanner in this repository answers a question about the tree — "which
 * modules are under `lib/`", "which client chunks exist", "what does the route
 * family say". They all used to answer `[]` or `''` when they could not read the
 * directory, and that empty answer travels: it becomes a count of zero written
 * into a document, or a universal claim (`every patch has a contract`,
 * `expandPrefix is defined once`) that is satisfied by nothing at all.
 *
 * The distinction this suite pins is not "throwing is nicer". It is that the two
 * failures are different and must not be reported as one:
 *
 *  - "the tree is intact and the answer is empty" — a fact worth asserting;
 *  - "I could not look" — a defect in the check itself, which an empty answer
 *    disguises as the first one.
 *
 * A scanner that returns `[]` for a missing directory is therefore not a
 * convenience; it is a check that cannot fail, wearing the shape of one that can.
 *
 * Run: node tests/source-scanners-smoke.mjs
 */
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const libModules = await import(pathToFileURL(path.join(pluginRoot, 'tests', 'support', 'lib-modules.mjs')).href)
const clientSource = await import(pathToFileURL(path.join(pluginRoot, 'tests', 'support', 'client-source.mjs')).href)
const routeSource = await import(pathToFileURL(path.join(pluginRoot, 'tests', 'support', 'route-source.mjs')).href)

let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`) } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/**
 * Run `body`, returning the error it threw (or undefined when it returned).
 *
 * The point is to distinguish "threw" from "answered", which a try/catch around
 * an assignment cannot express without a sentinel that a valid answer could
 * also be.
 *
 * @param {() => unknown} body - the call to attempt.
 * @returns {Error|undefined} the error, when one was thrown.
 */
function thrownBy (body) {
  try {
    body()
    return undefined
  } catch (error) {
    return error
  }
}

console.log('\n=== source scanners smoke ===')

console.log('\n[1] every scanner refuses to answer for a directory it cannot list')
{
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'scanners-'))
  try {
    const gone = path.join(sandbox, 'not-here')

    const walks = [
      ['modulePaths', () => libModules.modulePaths(gone)],
      ['topLevelModulePaths', () => libModules.topLevelModulePaths(gone)],
      ['clientChunkNames', () => clientSource.clientChunkNames(gone)],
      ['clientKernelBlock', () => clientSource.clientKernelBlock(gone)],
      ['routeSource', () => routeSource.routeSource(gone)]
    ]
    for (const [name, call] of walks) {
      const error = thrownBy(call)
      check(`${name} throws instead of answering empty`, error !== undefined,
        error === undefined ? 'it returned' : undefined)
      // An error that does not name what it could not read sends the reader to
      // the caller's assertion instead of to the missing file.
      check(`${name} names the path it could not read`,
        error !== undefined && error.message.includes('not-here'), String(error?.message))
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

console.log('\n[2] a readable tree still answers, so the throw is not unconditional')
{
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'scanners-'))
  try {
    mkdirSync(path.join(sandbox, 'nested'))
    writeFileSync(path.join(sandbox, 'top.js'), 'export const a = 1\n')
    writeFileSync(path.join(sandbox, 'nested', 'deep.js'), 'export const b = 2\n')

    const walked = libModules.modulePaths(sandbox)
    check('a walk over a real tree returns its modules', walked.includes('nested/deep.js'), JSON.stringify(walked))
    check('the top-level listing is the top level only',
      JSON.stringify(libModules.topLevelModulePaths(sandbox)) === JSON.stringify(['top.js']),
      JSON.stringify(libModules.topLevelModulePaths(sandbox)))
    // An EMPTY directory is a legitimate answer — the distinction being drawn is
    // "nothing is there" versus "I could not look", not "empty is always wrong".
    mkdirSync(path.join(sandbox, 'empty'))
    check('an empty directory answers with an empty list, not an error',
      Array.isArray(libModules.modulePaths(path.join(sandbox, 'empty'))),
      'threw')
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

console.log('\n[3] no reader is left that turns a missing file into an empty string')
{
  // The generator lost its `readOrEmpty` on purpose: it read the document it
  // splices into, and a missing document then travelled as `''` until a second
  // check reported "does not exist" — the same conclusion, reached by way of a
  // value that reads as "the document is empty".
  const generator = readFileSync(path.join(pluginRoot, 'scripts', 'doc-numbers.mjs'), 'utf8')
  // Declared, not merely mentioned: the file's comment explains what was removed
  // and why, and a prose mention is not a reader that can answer ''.
  const declared = /(?:function\s+readOrEmpty|const\s+readOrEmpty\b)/u.exec(generator)
  check('the generator declares no readOrEmpty', declared === null, String(declared?.[0]))
  check('nothing in the generator calls readOrEmpty', !/\breadOrEmpty\s*\(/u.test(generator),
    (/\breadOrEmpty\s*\([^\n]*/u.exec(generator) ?? [])[0])
  check('the generator reads its document with a named error',
    /cannot read \$\{path\.relative\(root, TARGET\)\}/u.test(generator),
    'the document read does not name the file it wanted')

  // `lint` walks three roots; a published tarball has `lib/` only. Skipping an
  // absent root is correct, but it has to be SAID — "all N modules parse" over a
  // tree with no `tests/` is a different claim from the same line over a
  // complete one.
  const lint = readFileSync(path.join(pluginRoot, 'scripts', 'lint.mjs'), 'utf8')
  check('lint reports the roots it skipped', /skipped \$\{absent\.length\} directory root/u.test(lint),
    'lint still skips absent roots silently')
  check('lint refuses a root that exists but cannot be read',
    /cannot list \$\{directory\}/u.test(lint), 'lint has no unreadable-root error')
}

console.log('\n[4] a package.json entry that is missing is a failure, not a skip')
{
  // `client-shape` parses every JavaScript entry `package.json` names. It used to
  // `continue` past an absent one, which made the claim "the shipped files parse"
  // a claim about whichever subset happened to be on disk — and the entry most
  // likely to be absent is the one that moved, whose syntax error nobody sees.
  const suite = readFileSync(path.join(pluginRoot, 'tests', 'client-shape-smoke.mjs'), 'utf8')
  check('client-shape asserts every named entry exists',
    /check\(`\$\{target\} exists`, false/u.test(suite),
    'a missing entry is still skipped silently')
  check('client-shape asserts there is at least one entry',
    /names at least one JavaScript entry/u.test(suite), 'no assertion on the entry list')
}


  totalPassed += passed
  totalFailures += failures
})()

// ---------------------------------------------------------------------------
// render-smoke.mjs
// ---------------------------------------------------------------------------
await (async () => {
/**
 * `tests/support/render.mjs` itself, exercised against a real component.
 *
 * ## What this suite is for
 *
 * A harness that only gets used by tests it was written for proves nothing:
 * both halves can be wrong together. So this suite renders a component that
 * already ships -- `SelfCheckList` in `lib/client/client.js`, which turns a capability
 * probe into the panel's advisory rows -- and asserts on the ELEMENT TREE the
 * real function produced. No grep of the source is involved in the behavioural
 * checks.
 *
 * ## The negative control
 *
 * The last group re-renders from a MUTATED copy of the bundle (the `present`
 * filter flipped) and requires the tree to change. Without that, a harness that
 * silently returned `null` for every component would pass every assertion above
 * it -- the classic way a render suite goes green while rendering nothing.
 *
 * ## What it deliberately does not do
 *
 * No DOM, no reconciliation, no second render: `render()` calls the component
 * once. `CappedList` is therefore NOT covered -- it needs `React.Children`,
 * `ResizeObserver` and `getBoundingClientRect`, and faking those would be
 * testing the fake. Its behaviour is covered by `client-shape-smoke`.
 *
 * Run: node tests/render-smoke.mjs
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const source = clientSource(pluginRoot)

let passed = 0
const failures = []
function check (name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const t = key => `T:${key}`

console.log('\n=== render harness smoke ===\n')

// ---- the slice is a real declaration, not a guess ---------------------------

const slice = componentSource(source, 'SelfCheckList')
check('the harness finds a component that ships',
  slice.startsWith('function SelfCheckList ('),
  'componentSource did not return the declaration')
check('...and the slice ends on the component, not mid-body',
  slice.endsWith('\n    }') || slice.endsWith('}'),
  `the slice ends with ${JSON.stringify(slice.slice(-20))}`)
check('a component that does not exist is refused by name',
  (() => {
    try {
      componentSource(source, 'NoSuchComponentAnywhere')
      return false
    } catch (error) {
      return /no `function NoSuchComponentAnywhere`/.test(error.message)
    }
  })(),
  'a missing component must throw, not return an empty string')
check('an injected name the harness owns is refused',
  (() => {
    try {
      compile(source, 'SelfCheckList', { inject: { React: {} } })
      return false
    } catch (error) {
      return /supplied by the harness/.test(error.message)
    }
  })(),
  'injecting `React` would shadow the stub')

// ---- the real component, rendered -----------------------------------------

const EMPTY = render(source, 'SelfCheckList', { rows: [], t })
check('no rows renders nothing at all',
  EMPTY.element === null,
  'an empty capability list must not draw an empty box')
check('a missing rows prop renders nothing',
  render(source, 'SelfCheckList', { rows: undefined, t }).element === null,
  'rows must be validated, not assumed')
check('a non-array rows prop renders nothing',
  render(source, 'SelfCheckList', { rows: 'nope', t }).element === null,
  'a string has a length and would render as rows')

const rows = [
  { tool: 'git', state: 'present' },
  { tool: 'rg', state: 'absent', detail: 'no ripgrep', install: 'apt install ripgrep' },
  { tool: 'inotifywait', state: 'unknown' },
]
const full = render(source, 'SelfCheckList', { rows, t })
check('the header counts what is present out of what was probed',
  textOf(full.element).includes(`1/3 ${t('check.present')}`),
  `header read ${JSON.stringify(textOf(full.element).slice(0, 40))}`)
check('only the non-present rows are listed',
  findAll(full.element, el => el.props?.className === 'sshwsp-check-row sshwsp-check-present').length === 0,
  'a present tool must not take a row: the list is advisory')
check('...one row per advisory tool',
  findAll(full.element, el => typeof el.props?.className === 'string' && el.props.className.startsWith('sshwsp-check-row')).length === 2,
  'two of the three rows are advisory')
check('an absent tool is warned about, not hidden',
  findAll(full.element, el => el.props?.className === 'sshwsp-check-row sshwsp-check-absent').length === 1,
  'the absent row lost its state class')
check('an undetermined tool is neither present nor absent',
  findAll(full.element, el => el.props?.className === 'sshwsp-check-row sshwsp-check-unknown').length === 1,
  'a probe that could not answer must still be listed as unknown')
check('the status word follows the state',
  textOf(full.element).includes(t('check.absent')) && textOf(full.element).includes(t('check.unknown')),
  'the state words did not reach the tree')
check('an absent tool keeps the warning colour',
  findAll(full.element, el => el.props?.className === 'sshwsp-status sshwsp-status-warn').length === 1,
  'absent must be warn, not the neutral colour')
check('the detail line is rendered verbatim',
  textOf(full.element).includes('no ripgrep'),
  'the probe detail was dropped')
check('the install hint only appears where one exists',
  findAll(full.element, el => el.props?.children === `${t('check.install')}apt install ripgrep`).length === 1,
  'the install line is not gated on the field')
check('a row without a detail renders an empty string, not "undefined"',
  !textOf(full.element).includes('undefined'),
  'a missing detail leaked into the UI')
check('every tool name reaches the tree',
  ['rg', 'inotifywait'].every(tool => textOf(full.element).includes(tool)) && !textOf(full.element).includes('git'),
  'the listed tool names do not match the advisory set')

// ---- the tree helpers -----------------------------------------------------

const elements = findAll(full.element, () => true)
// root div + header div + 2 row divs + 4 spans in the absent row (tool,
// status, detail, install) + 3 in the unknown row = 11.
check('walk visits elements and skips leaves',
  elements.length === 11,
  `expected 11 elements, saw ${elements.length}`)
check('byType narrows to one element type',
  byType(full.element, 'span').length === 7,
  `expected 7 spans, saw ${byType(full.element, 'span').length}`)
check('textOf concatenates nested children in order',
  textOf({ type: 'div', props: { children: ['a', { type: 'b', props: { children: 'c' } }, 3] } }) === 'ac3',
  'text extraction lost a leaf or reordered it')

// ---- effects are recorded, not run ---------------------------------------

const recorded = createReactStub()
let ran = false
recorded.react.useEffect(() => { ran = true })
check('an effect body does not run unless asked',
  ran === false && recorded.calls.effects.length === 1,
  'the default must not claim to know when React runs effects')
const executed = createReactStub({ runEffects: true })
let cleaned = false
executed.react.useEffect(() => () => { cleaned = true })
executed.cleanup()
check('an effect runs, and its cleanup is collectable, when asked',
  cleaned === true && executed.calls.cleanups.length === 0,
  'cleanup must run once and be consumed')

// ---- negative control: a mutated bundle must change the tree --------------

const mutated = source.replace(
  'const rest = rows.filter(row => row.state !== \'present\')',
  'const rest = rows.filter(() => true)',
)
check('the mutation actually landed in the copy',
  mutated !== source,
  'the negative control no longer matches the shipped line -- update it')
const broken = render(mutated, 'SelfCheckList', { rows, t })
check('...and the present row appears once the filter is broken',
  textOf(broken.element).includes('git'),
  'the assertions above cannot see this defect, so they prove nothing')
check('...while the header is unchanged by that defect',
  textOf(broken.element).includes(`1/3 ${t('check.present')}`),
  'the header count must not depend on the row filter')


  totalPassed += passed
  totalFailures += failures.length
})()

// ---------------------------------------------------------------------------
// plugin-host-smoke.mjs
// ---------------------------------------------------------------------------
await (async () => {
/**
 * The shared host double: it must be smaller than Cordis, never looser.
 *
 * Every assertion here is a REFUSAL. A double that quietly answers `undefined`
 * for a missing service, or keeps accepting registrations after disposal, makes
 * a suite pass for the wrong reason — and that is the exact failure mode the
 * fourteen hand-written ctx literals had drifted into. So the suite drives the
 * refusals first, then the two behaviours that are supposed to work (deferred
 * injection, staged local writes).
 *
 * Run: node tests/plugin-host-smoke.mjs
 */
let passed = 0
let failures = 0
function check (label, ok, detail) {
  if (ok) { passed += 1; console.log('  PASS  ' + label) } else {
    failures += 1
    console.log('  FAIL  ' + label + (detail === undefined ? '' : ' — ' + detail))
  }
}

console.log('\n=== plugin host smoke ===\n')

/** Run `body`, returning the thrown message (or null when nothing threw). */
function thrown (body) {
  try {
    body()
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

console.log('[refusals]')
{
  const host = createHost()
  host.ctx.provide('alpha', 1)
  const duplicate = thrown(() => host.ctx.provide('alpha', 2))
  check('a second provide for one name throws', duplicate !== null && /already provided/u.test(duplicate), String(duplicate))
  check('...and the first value survives', host.ctx.get('alpha') === 1, String(host.ctx.get('alpha')))
  check('an unknown service reads as undefined, not a throw', host.ctx.get('nope') === undefined)
  const replace = thrown(() => host.ctx.set('alpha', 3))
  check('only the providing fiber may replace a service', replace !== null && /providing fiber/u.test(replace), String(replace))
  check('providing the same value twice is not a replacement', thrown(() => host.ctx.set('alpha', 1)) === null)

  host.ctx.tools.register({ name: 'probe', execute: async () => ({ ok: true }) })
  const dupeTool = thrown(() => host.ctx.tools.register({ name: 'probe', execute: async () => ({ ok: true }) }))
  check('a duplicate tool name is refused', dupeTool !== null && /already registered/u.test(dupeTool), String(dupeTool))
  const noExecute = thrown(() => host.ctx.tools.register({ name: 'broken' }))
  check('a tool without execute() is refused', noExecute !== null && /needs execute/u.test(noExecute), String(noExecute))
  const noName = thrown(() => host.ctx.tools.register({ execute: async () => ({}) }))
  check('a tool without a name is refused', noName !== null && /non-empty name/u.test(noName), String(noName))

  host.dispose()
  const afterDispose = thrown(() => host.ctx.get('alpha'))
  check('a disposed fiber refuses get()', afterDispose !== null && /disposed/u.test(afterDispose), String(afterDispose))
  const provideAfter = thrown(() => host.ctx.provide('beta', 1))
  check('a disposed fiber refuses provide()', provideAfter !== null && /disposed/u.test(provideAfter), String(provideAfter))
  const registerAfter = thrown(() => host.ctx.tools.register({ name: 'late', execute: async () => ({}) }))
  check('a disposed fiber refuses tools.register()', registerAfter !== null && /disposed/u.test(registerAfter), String(registerAfter))
  check('disposing twice is not an error', thrown(() => host.dispose()) === null)
}

console.log('\n[injection]')
{
  const host = createHost()
  const order = []
  host.ctx.inject(['fs'], () => { order.push('fs') })
  check('a body waiting on a missing service does not run', order.length === 0, JSON.stringify(order))
  host.ctx.provide('fs', {})
  check('...and runs the moment it is provided', JSON.stringify(order) === '["fs"]', JSON.stringify(order))

  const eager = []
  host.ctx.provide('shell', {})
  host.ctx.inject(['shell'], () => { eager.push('shell') })
  check('a body whose service is already there runs immediately', JSON.stringify(eager) === '["shell"]', JSON.stringify(eager))

  const pairHost = createHost()
  const both = []
  pairHost.ctx.inject(['left', 'right'], () => { both.push('pair') })
  pairHost.ctx.provide('left', {})
  check('a two-service body waits for both', both.length === 0, JSON.stringify(both))
  pairHost.ctx.provide('right', {})
  check('...and runs once when the second arrives', JSON.stringify(both) === '["pair"]', JSON.stringify(both))
  pairHost.dispose()
  host.dispose()
}

console.log('\n[effects]')
{
  const host = createHost()
  const closed = []
  host.ctx.effect(() => () => { closed.push('first') }, 'first')
  host.ctx.effect(() => () => { closed.push('second') }, 'second')
  check('no effect body has run yet', closed.length === 0, JSON.stringify(closed))
  host.dispose()
  check('disposal runs effects in reverse order', JSON.stringify(closed) === '["second","first"]', JSON.stringify(closed))

  const manual = createHost()
  const seen = []
  const stop = manual.ctx.effect(() => () => { seen.push('stop') }, 'manual')
  stop()
  check('an effect can be disposed on its own', JSON.stringify(seen) === '["stop"]', JSON.stringify(seen))
  stop()
  check('...and disposing it twice runs the disposer once', seen.length === 1, JSON.stringify(seen))
  manual.dispose()
  check('...and disposal does not run it again', seen.length === 1, JSON.stringify(seen))
}

console.log('\n[the local backend]')
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-host-'))
  const file = path.join(root, 'note.txt')
  fs.writeFileSync(file, 'hello', 'utf8')
  const backend = new LocalBackend({ cwd: root })

  const resolved = backend.resolve('note.txt')
  check('a relative path resolves against the cwd', resolved.targetKey === file, String(resolved.targetKey))
  check('a resolved target is an absolute spelling', path.isAbsolute(resolved.displayPath), String(resolved.displayPath))
  check('stat reports the size and a version', backend.stat(resolved).size === 5 && typeof backend.stat(resolved).version === 'string')
  check('readText returns the bytes', backend.readText(resolved) === 'hello')
  check('readByteRange slices', backend.readByteRange(resolved, { start: 1, end: 3 }).toString() === 'el')
  check('readBytes honours the cap', backend.readBytes(resolved, undefined, 2).toString() === 'he')
  check('contains accepts a child and rejects a sibling',
    backend.contains({ targetKey: root }, resolved) === true && backend.contains({ targetKey: root }, { targetKey: path.join(root, '..', 'elsewhere') }) === false)
  check('fileUrl is a file: URL', backend.fileUrl(resolved).startsWith('file:'), backend.fileUrl(resolved))
  const list = backend.listDir({ targetKey: root })
  check('listDir reports one file', list.length === 1 && list[0].name === 'note.txt' && list[0].type === 'file', JSON.stringify(list))

  const before = backend.stat(resolved).version
  const write = backend.writeText(resolved, 'goodbye', { kind: 'replaceIfVersion', version: before })
  check('a versioned write lands', fs.readFileSync(file, 'utf8') === 'goodbye')
  check('...and reports before/after versions', write.operation === 'update' && write.before === before && write.after !== before, JSON.stringify(write))
  check('...without leaving a staging file behind', fs.readdirSync(root).length === 1, JSON.stringify(fs.readdirSync(root)))

  const stale = thrown(() => backend.writeText(resolved, 'clobber', { kind: 'replaceIfVersion', version: before }))
  check('a stale version is refused with FS_STALE_VERSION', /changed since it was read/u.test(String(stale)), String(stale))
  check('...and the file keeps its current bytes', fs.readFileSync(file, 'utf8') === 'goodbye')

  const created = backend.writeText({ targetKey: path.join(root, 'new.txt') }, 'x', { kind: 'createIfAbsent' })
  check('createIfAbsent creates', created.operation === 'create' && fs.existsSync(path.join(root, 'new.txt')))
  const exists = thrown(() => backend.writeText({ targetKey: path.join(root, 'new.txt') }, 'y', { kind: 'createIfAbsent' }))
  check('createIfAbsent refuses an existing file', /already exists/u.test(String(exists)), String(exists))

  const edit = backend.editText(resolved, { oldText: 'good', newText: 'great' })
  check('an edit lands', fs.readFileSync(file, 'utf8') === 'greatbye', fs.readFileSync(file, 'utf8'))
  check('...and reports the update', edit.operation === 'update')
  const missing = thrown(() => backend.editText(resolved, { oldText: 'absent', newText: 'x' }))
  check('an edit whose target is absent is refused', /was not found/u.test(String(missing)), String(missing))
  const ambiguous = thrown(() => backend.editText({ targetKey: path.join(root, 'twice.txt') }, { oldText: 'a', newText: 'b' }))
  fs.writeFileSync(path.join(root, 'twice.txt'), 'aa', 'utf8')
  const ambiguous2 = thrown(() => backend.editText({ targetKey: path.join(root, 'twice.txt') }, { oldText: 'a', newText: 'b' }))
  check('an ambiguous edit is refused unless replaceAll is set', /more than once/u.test(String(ambiguous2)), String(ambiguous2 ?? ambiguous))
  check('...and replaceAll accepts it', backend.editText({ targetKey: path.join(root, 'twice.txt') }, { oldText: 'a', newText: 'b', replaceAll: true }).operation === 'update')

  const watch = thrown(() => backend.watch())
  check('watch is refused by name, not silently undefined', watch !== null && /does not implement watch/u.test(watch), String(watch))

  fs.rmSync(root, { recursive: true, force: true })
}


  totalPassed += passed
  totalFailures += failures
})()

console.log(`\n=== ${totalPassed} passed, ${totalFailures} failed ===`)
if (totalFailures > 0) {
  console.log('\nfailures:')
  process.exit(1)
}